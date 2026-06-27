/**
 * server.js
 * ─────────────────────────────────────────────────────────────
 * Express REST API backend for the Re-Pricer dashboard
 * ─────────────────────────────────────────────────────────────
 * Install deps:
 *   npm install express pg cors dotenv
 */

import express from 'express';
import cors from 'cors';
import pg from 'pg';
import dotenv from 'dotenv';
import { spawn } from 'child_process';
import { getProductDetails, getAllSellers, scraperLogs, setProxyApiUrl, getProxyStatus } from './amazonScraper.js';
import https from 'https';
import { runRepricerJob, fastQueue, slowQueue, keepaQueue, queuePollerQueue, bulkImportQueue, deleteBrandsQueue, redis, getTokenForAccount } from './jobProducer.js';
import IORedis from 'ioredis';
import { appendFile, appendFileSync, createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, statSync, watch as fsWatch } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import multer from 'multer';
import XLSX from 'xlsx';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { getLwaAccessToken, fetchAsinCatalog, parseCatalogItem, MARKETPLACES } from './spApiHelper.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
try { mkdirSync(join(__dirname, 'logs'), { recursive: true }); } catch {}

// Clean up stale Puppeteer temp profiles left by prior crashes/restarts (Linux only)
if (process.platform === 'linux') {
  try {
    spawn('sh', ['-c', 'find /tmp -maxdepth 1 -name "puppeteer_dev_profile-*" -mmin +30 -exec rm -rf {} + 2>/dev/null; find /tmp -maxdepth 1 -name "com.google.Chrome.*" -mmin +30 -exec rm -rf {} + 2>/dev/null'], { detached: true, stdio: 'ignore' }).unref();
  } catch {}
}

dotenv.config();

const app = express();
const { Pool } = pg;

const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

// Redis publisher — notifies the worker process when settings change
const redisPub = new IORedis(process.env.REDIS_URL || 'redis://127.0.0.1:6379', {
  maxRetriesPerRequest: null,
  lazyConnect: true,
});
redisPub.connect().catch(() => {}); // best-effort; log streaming still works without it

app.use(cors());
app.use(express.json({ limit: '50mb' }));

// Runtime-mutable defaults loaded from DB settings at startup
const _globalSettings = { feeRate: 0.15, defaultRoi: 20 };

// ─────────────────────────────────────────────
// AUTH MIDDLEWARE
// ─────────────────────────────────────────────

const JWT_SECRET = process.env.JWT_SECRET || 'repricer-jwt-secret-change-in-production';
const JWT_EXPIRY  = '7d';

function requireAuth(req, res, next) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return res.status(401).json({ error: 'Login required' });
  try {
    const payload        = jwt.verify(header.slice(7), JWT_SECRET);
    req.user             = payload;
    req.effectiveUserId  = payload.impersonatedUserId ?? payload.userId;
    req.isImpersonating  = payload.impersonatedUserId != null;
    next();
  } catch {
    res.status(401).json({ error: 'Session expired — please log in again' });
  }
}

function requireAdmin(req, res, next) {
  if (req.user?.role !== 'super_admin') return res.status(403).json({ error: 'Admin access required' });
  next();
}

// ─────────────────────────────────────────────
// AUTH ROUTES (public — no requireAuth)
// ─────────────────────────────────────────────

// POST /api/admin/login — super admin only entry point (separate URL as requested)
app.post('/api/admin/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
  try {
    const { rows } = await db.query(
      `SELECT * FROM users WHERE username = $1 AND role = 'super_admin' AND is_active = true`, [username]
    );
    if (!rows[0] || !await bcrypt.compare(password, rows[0].password_hash))
      return res.status(401).json({ error: 'Invalid credentials' });
    const u = rows[0];
    const token = jwt.sign({ userId: u.id, username: u.username, role: u.role }, JWT_SECRET, { expiresIn: JWT_EXPIRY });
    res.json({ token, user: { id: u.id, username: u.username, role: u.role } });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/auth/login — all users
app.post('/api/auth/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
  try {
    const { rows } = await db.query(
      `SELECT * FROM users WHERE username = $1 AND is_active = true`, [username]
    );
    if (!rows[0] || !await bcrypt.compare(password, rows[0].password_hash))
      return res.status(401).json({ error: 'Invalid credentials' });
    const u = rows[0];
    const token = jwt.sign({ userId: u.id, username: u.username, role: u.role }, JWT_SECRET, { expiresIn: JWT_EXPIRY });
    res.json({ token, user: { id: u.id, username: u.username, role: u.role } });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/auth/verify-password — confirm the logged-in user's password (used before destructive actions)
app.post('/api/auth/verify-password', requireAuth, async (req, res) => {
  const { password } = req.body;
  if (!password) return res.status(400).json({ error: 'Password required' });
  try {
    const { rows } = await db.query(
      `SELECT password_hash FROM users WHERE id = $1`, [req.user.userId]
    );
    if (!rows[0] || !await bcrypt.compare(password, rows[0].password_hash))
      return res.status(401).json({ error: 'Incorrect password' });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/auth/me — validate token + return current user info
app.get('/api/auth/me', requireAuth, (req, res) => {
  res.json({
    userId: req.user.userId, username: req.user.username, role: req.user.role,
    impersonatedUserId:   req.user.impersonatedUserId   ?? null,
    impersonatedUsername: req.user.impersonatedUsername ?? null,
  });
});

// ─────────────────────────────────────────────
// ADMIN — USER MANAGEMENT
// ─────────────────────────────────────────────

app.get('/api/admin/users', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT u.id, u.username, u.email, u.role, u.is_active, u.created_at,
             (SELECT COUNT(*) FROM product_mappings WHERE user_id = u.id)::int AS mapping_count,
             (SELECT COUNT(*) FROM onbuy_accounts   WHERE user_id = u.id)::int AS account_count
      FROM users u ORDER BY u.created_at DESC
    `);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/users', requireAuth, requireAdmin, async (req, res) => {
  const { username, email, password, role = 'user' } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
  try {
    const hash = await bcrypt.hash(password, 10);
    const { rows } = await db.query(
      `INSERT INTO users (username, email, password_hash, role)
       VALUES ($1, $2, $3, $4) RETURNING id, username, email, role, is_active, created_at`,
      [username, email || null, hash, role === 'super_admin' ? 'super_admin' : 'user']
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Username already exists' });
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/admin/users/:id', requireAuth, requireAdmin, async (req, res) => {
  const { username, email, password, is_active, role } = req.body;
  try {
    const hash = password ? await bcrypt.hash(password, 10) : null;
    const { rows } = await db.query(
      `UPDATE users SET
         username      = COALESCE($1, username),
         email         = COALESCE($2, email),
         password_hash = COALESCE($3, password_hash),
         is_active     = COALESCE($4, is_active),
         role          = COALESCE($5, role),
         updated_at    = NOW()
       WHERE id = $6 RETURNING id, username, email, role, is_active`,
      [username || null, email || null, hash, is_active ?? null, role || null, req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'User not found' });
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/admin/users/:id', requireAuth, requireAdmin, async (req, res) => {
  if (parseInt(req.params.id) === req.user.userId)
    return res.status(400).json({ error: 'Cannot delete your own account' });
  try {
    await db.query('DELETE FROM users WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/users/:id/impersonate', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT id, username, role, is_active FROM users WHERE id = $1`, [req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'User not found' });
    if (!rows[0].is_active) return res.status(400).json({ error: 'Cannot impersonate inactive user' });
    const t = rows[0];
    const token = jwt.sign({
      userId: req.user.userId, username: req.user.username, role: req.user.role,
      impersonatedUserId: t.id, impersonatedUsername: t.username,
    }, JWT_SECRET, { expiresIn: JWT_EXPIRY });
    res.json({ token, impersonatedUser: { id: t.id, username: t.username } });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─────────────────────────────────────────────
// DASHBOARD STATS
// ─────────────────────────────────────────────

// GET /api/stats — overview numbers for dashboard cards
app.get('/api/stats', requireAuth, async (req, res) => {
  const uid = req.effectiveUserId;
  try {
    const [mappings, syncStats, stockStats] = await Promise.all([
      db.query('SELECT COUNT(*) FROM product_mappings WHERE is_active = true AND user_id = $1', [uid]),
      db.query(
        `SELECT COALESCE(SUM(synced_count), 0) AS synced, COALESCE(SUM(price_changes), 0) AS changed
         FROM daily_sync_stats WHERE user_id = $1 AND date = CURRENT_DATE`,
        [uid]
      ),
      db.query(
        `SELECT
           COUNT(*) FILTER (WHERE amazon_in_stock IS DISTINCT FROM false) AS in_stock,
           COUNT(*) FILTER (WHERE amazon_in_stock = false) AS out_of_stock
         FROM product_mappings
         WHERE user_id = $1 AND last_synced_at >= NOW() - INTERVAL '24 hours'`,
        [uid]
      ),
    ]);
    res.json({
      activeListings:      parseInt(mappings.rows[0].count),
      syncedLast24h:       parseInt(syncStats.rows[0].synced),
      priceChangesLast24h: parseInt(syncStats.rows[0].changed),
      stockInLast24h:      parseInt(stockStats.rows[0].in_stock),
      stockOutLast24h:     parseInt(stockStats.rows[0].out_of_stock),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────
// PRODUCT MAPPINGS CRUD
// ─────────────────────────────────────────────

// GET /api/mappings — paginated product mappings
// Query params: page (default 1), limit (default 100, max 1000), search
app.get('/api/mappings', requireAuth, async (req, res) => {
  const uid = req.effectiveUserId;
  try {
    const limit  = Math.min(1000, Math.max(1, parseInt(req.query.limit)  || 100));
    const page   = Math.max(1,                parseInt(req.query.page)   || 1);
    const search = (req.query.search || '').trim();
    const offset = (page - 1) * limit;

    const listWhere  = search
      ? `WHERE pm.user_id = $3 AND (pm.product_name ILIKE $4 OR pm.primary_asin ILIKE $4 OR pm.onbuy_sku ILIKE $4 OR pm.onbuy_listing_id ILIKE $4)`
      : `WHERE pm.user_id = $3`;
    const countWhere = search
      ? `WHERE user_id = $1 AND (product_name ILIKE $2 OR primary_asin ILIKE $2 OR onbuy_sku ILIKE $2 OR onbuy_listing_id ILIKE $2)`
      : `WHERE user_id = $1`;
    const listParams  = search ? [limit, offset, uid, `%${search}%`] : [limit, offset, uid];
    const countParams = search ? [uid, `%${search}%`] : [uid];

    const [{ rows }, countResult] = await Promise.all([
      db.query(`
        SELECT
          pm.*,
          (SELECT COUNT(*) FROM supplier_asins sa WHERE sa.product_mapping_id = pm.id) AS supplier_count,
          (SELECT status FROM sync_logs sl WHERE sl.product_mapping_id = pm.id ORDER BY created_at DESC LIMIT 1) AS last_sync_status
        FROM product_mappings pm
        ${listWhere}
        ORDER BY pm.created_at DESC
        LIMIT $1 OFFSET $2
      `, listParams),
      db.query(`SELECT COUNT(*) FROM product_mappings ${countWhere}`, countParams),
    ]);

    res.json({ rows, total: parseInt(countResult.rows[0].count), page, limit });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/mappings/export — download all mappings as XLSX
app.get('/api/mappings/export', requireAuth, async (req, res) => {
  const uid = req.effectiveUserId;
  try {
    const { rows } = await db.query(
      `SELECT product_name, primary_asin, markup_type, markup_value,
              last_amazon_price, last_onbuy_price, last_synced_at
       FROM product_mappings
       WHERE user_id = $1
       ORDER BY created_at DESC`,
      [uid]
    );

    const sheetData = [
      ['Product Title', 'ASIN', 'Markup', 'Amazon £', 'OnBuy £', 'Last Sync'],
      ...rows.map(r => {
        const val = parseFloat(r.markup_value) || 0;
        const markup = r.markup_type === 'roi'     ? `+${val.toFixed(2)}% ROI`
                     : r.markup_type === 'percent' ? `+${val.toFixed(2)}%`
                     : r.markup_type === 'fixed'   ? `+£${val.toFixed(2)}`
                     : r.markup_value ?? '';
        return [
          r.product_name     ?? '',
          r.primary_asin     ?? '',
          markup,
          r.last_amazon_price != null ? parseFloat(r.last_amazon_price) : '',
          r.last_onbuy_price  != null ? parseFloat(r.last_onbuy_price)  : '',
          r.last_synced_at    ? new Date(r.last_synced_at).toLocaleString('en-GB') : 'Never',
        ];
      }),
    ];

    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet(sheetData);
    ws['!cols'] = [{ wch: 60 }, { wch: 14 }, { wch: 14 }, { wch: 12 }, { wch: 12 }, { wch: 22 }];
    XLSX.utils.book_append_sheet(wb, ws, 'Mappings');

    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Disposition', 'attachment; filename="mappings.xlsx"');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buf);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/mappings/:id — single mapping detail
app.get('/api/mappings/:id', requireAuth, async (req, res) => {
  try {
    const { rows } = await db.query(
      'SELECT * FROM product_mappings WHERE id = $1 AND user_id = $2',
      [req.params.id, req.effectiveUserId]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/mappings — create new mapping
app.post('/api/mappings', requireAuth, async (req, res) => {
  const {
    product_name, onbuy_listing_id, onbuy_sku,
    primary_asin, markup_type, markup_value, min_price, notes
  } = req.body;

  try {
    const { rows } = await db.query(
      `INSERT INTO product_mappings
        (product_name, onbuy_listing_id, onbuy_sku, primary_asin, markup_type, markup_value, min_price, notes, user_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [product_name, onbuy_listing_id, onbuy_sku, primary_asin, markup_type, markup_value, min_price, notes, req.effectiveUserId]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/mappings/:id — update mapping
app.put('/api/mappings/:id', requireAuth, async (req, res) => {
  const {
    product_name, onbuy_listing_id, onbuy_sku,
    primary_asin, markup_type, markup_value, min_price, is_active, notes
  } = req.body;

  try {
    const { rows } = await db.query(
      `UPDATE product_mappings
       SET product_name=$1, onbuy_listing_id=$2, onbuy_sku=$3, primary_asin=$4,
           markup_type=$5, markup_value=$6, min_price=$7, is_active=$8, notes=$9, updated_at=NOW()
       WHERE id=$10 AND user_id=$11 RETURNING *`,
      [product_name, onbuy_listing_id, onbuy_sku, primary_asin, markup_type, markup_value, min_price, is_active, notes, req.params.id, req.effectiveUserId]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/mappings/:id
app.delete('/api/mappings/:id', requireAuth, async (req, res) => {
  try {
    await db.query('DELETE FROM product_mappings WHERE id = $1 AND user_id = $2', [req.params.id, req.effectiveUserId]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/mappings — clear all of this user's mappings
app.delete('/api/mappings', requireAuth, async (req, res) => {
  try {
    await db.query('DELETE FROM product_mappings WHERE user_id = $1', [req.effectiveUserId]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/mappings/sync-opcs — bulk-fetch OPCs from OnBuy for mappings that are missing them.
// Uses GET /v2/listings with a JSON body of SKUs (OnBuy accepts GET with body for this endpoint).
// Accepts optional { ids: [...] } body — when provided, only those mapping IDs are processed
// (used by the Mappings page for the current page and by import confirm for just-imported rows).
app.post('/api/mappings/sync-opcs', requireAuth, async (req, res) => {
  const uid = req.effectiveUserId;
  const { ids } = req.body || {};
  try {
    const { rows: accounts } = await db.query(
      `SELECT * FROM onbuy_accounts WHERE user_id = $1 AND is_active = true ORDER BY id ASC`,
      [uid]
    );
    if (!accounts.length) return res.json({ updated: 0 });

    const { rows: mappings } = ids?.length
      ? await db.query(
          `SELECT id, onbuy_sku, primary_asin
           FROM product_mappings
           WHERE user_id = $1 AND id = ANY($2)
             AND onbuy_opc IS NULL
             AND (onbuy_sku IS NOT NULL OR primary_asin IS NOT NULL)`,
          [uid, ids]
        )
      : await db.query(
          `SELECT id, onbuy_sku, primary_asin
           FROM product_mappings
           WHERE user_id = $1 AND is_active = true
             AND onbuy_opc IS NULL
             AND (onbuy_sku IS NOT NULL OR primary_asin IS NOT NULL)`,
          [uid]
        );
    if (!mappings.length) return res.json({ updated: 0 });

    // SKU → [mapping id] map
    const skuToIds = {};
    for (const m of mappings) {
      const sku = (m.onbuy_sku || m.primary_asin || '').trim();
      if (!sku) continue;
      if (!skuToIds[sku]) skuToIds[sku] = [];
      skuToIds[sku].push(m.id);
    }
    if (!Object.keys(skuToIds).length) return res.json({ updated: 0 });

    let totalUpdated = 0;
    const CHUNK = 1000;

    for (const account of accounts) {
      const remaining = Object.keys(skuToIds);
      if (!remaining.length) break; // all resolved

      const token = await getTokenForAccount(account);
      if (!token) continue;
      const siteId = parseInt(account.site_id) || 2000;

      for (let i = 0; i < remaining.length; i += CHUNK) {
        const skuChunk = remaining.slice(i, i + CHUNK);
        const listings = await fetchOnBuyListingsBySkus(token, siteId, skuChunk);
        if (!listings?.length) continue;

        for (const listing of listings) {
          const sku   = listing.sku;
          const opc   = listing.opc || listing.product_encoded_id;
          const title = listing.name || listing.product_name || listing.title || null;
          if (!sku || !opc) continue;
          const ids = skuToIds[sku];
          if (!ids) continue;
          for (const id of ids) {
            await db.query(
              `UPDATE product_mappings
               SET onbuy_opc = $1${title ? ', product_name = COALESCE(NULLIF(product_name,\'\'), $3)' : ''}
               WHERE id = $2`,
              title ? [opc, id, title] : [opc, id]
            );
            totalUpdated++;
          }
          delete skuToIds[sku]; // resolved — skip on subsequent accounts
        }
      }
    }

    res.json({ updated: totalUpdated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────
// MANUAL SYNC TRIGGER
// ─────────────────────────────────────────────

// POST /api/sync — trigger a sync for the requesting user's own mappings.
// Always scoped to req.effectiveUserId so super_admin only syncs their own listings,
// not every user's listings in the system.
app.post('/api/sync', requireAuth, async (req, res) => {
  try {
    const uid = req.effectiveUserId;
    const onlyUnsynced = req.body?.onlyUnsynced === true;
    console.log(`[DEBUG /api/sync] ${new Date().toISOString()} — user=${uid} onlyUnsynced=${onlyUnsynced}`);
    redisPub.publish('repricer:manual-sync', JSON.stringify({ userId: uid, onlyUnsynced })).catch(() => {});
    res.json({ message: 'Sync job started successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/queue-status — job counts scoped to the effective user.
// All users (including superadmin) see only their own running job count via a Redis key
// written by jobProducer when their jobs are enqueued. Superadmin impersonating a user
// sees that user's count via effectiveUserId.
app.get('/api/queue-status', requireAuth, async (req, res) => {
  try {
    const uid = String(req.effectiveUserId);
    const pending = parseInt(await redis.get(`repricer:running:${uid}`) || '0');

    // Always check the Keepa queue — the counter alone can be 0 while a job is waiting
    // (e.g. a refill job's DECRBY brings it to 0 before the next queued job starts).
    const [kWaiting, kActive, kDelayed] = await Promise.all([
      keepaQueue.getWaiting(),
      keepaQueue.getActive(),
      keepaQueue.getDelayed(),
    ]);
    const hasActiveKeepa  = kActive.some(j => String(j.data?.userId) === uid);
    const userQueuedJobs  = hasActiveKeepa ? [] :
      [...kWaiting, ...kDelayed].filter(j => String(j.data?.userId) === uid);
    const hasQueuedKeepa  = userQueuedJobs.length > 0;

    // state: 'active'  → job is running now (counter > 0 OR active Keepa job)
    //        'queued'  → job is waiting in queue (not yet running)
    //        'idle'    → no job
    const state = (pending > 0 || hasActiveKeepa) ? 'active'
                : hasQueuedKeepa                   ? 'queued'
                : 'idle';

    // For 'queued' state, sum the ASIN counts from the waiting job payloads —
    // mirrors the display logic in keepaWorker.on('active') and the Redis counter
    // that the active state uses, so the number is consistent.
    const total = state === 'queued'
      ? userQueuedJobs.reduce((sum, j) =>
          sum + (j.data?.pendingAsins?.length ?? j.data?.asins?.length ?? 0), 0)
      : pending;

    res.json({ total, busy: state !== 'idle', state });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/job/cancel — stop all running/queued repricer jobs for the effective user
app.post('/api/job/cancel', requireAuth, async (req, res) => {
  try {
    const userId = req.effectiveUserId;

    // Get all onbuy account IDs for this user
    const { rows: accounts } = await db.query(
      `SELECT id FROM onbuy_accounts WHERE user_id = $1 AND is_active = true`, [userId]
    );
    const accountIds = new Set(accounts.map(a => String(a.id)));

    // Remove delayed + waiting keepa jobs belonging to this user's accounts
    const [delayed, waiting, active] = await Promise.all([
      keepaQueue.getDelayed(),
      keepaQueue.getWaiting(),
      keepaQueue.getActive(),
    ]);

    let removed = 0;
    for (const job of [...delayed, ...waiting]) {
      const byId   = accountIds.has(String(job.data?.accountId));
      const byName = [...accountIds].some(aid => String(job.id).includes(`-${aid}-`) || String(job.id) === `keepa-${aid}`);
      if (byId || byName) {
        await job.remove().catch(() => {});
        removed++;
      }
    }
    for (const job of active) {
      if (accountIds.has(String(job.data?.accountId))) {
        await job.moveToFailed({ message: 'Cancelled by user' }, 'user-cancel', true).catch(() => {});
        removed++;
      }
    }

    // Also drain fast/slow queue jobs for this user
    const [fw, fa, sw, sa] = await Promise.all([
      fastQueue.getWaiting(), fastQueue.getActive(),
      slowQueue.getWaiting(), slowQueue.getActive(),
    ]);
    for (const job of [...fw, ...fa, ...sw, ...sa]) {
      if (String(job.data?.userId) === String(userId)) {
        await job.remove().catch(() => {});
        removed++;
      }
    }

    // Clear Redis flags and signal any active Keepa worker to stop
    await redis.del(`keepa:refill-pending:${userId}`);
    await redis.del(`repricer:running:${userId}`);
    await redis.set(`keepa:cancelled:${userId}`, Date.now().toString(), 'EX', 7200); // timestamp; worker stops only if cancel is newer than its start time

    console.log(`[CancelJob] User ${userId} cancelled ${removed} job(s)`);
    res.json({ ok: true, removed });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/scraper-logs — last 200 scraper log entries (in-memory)
app.get('/api/scraper-logs', requireAuth, (req, res) => {
  res.json(scraperLogs);
});

// GET /api/pm2-logs?process=worker|api|all — SSE stream of live log output
// "worker" target: streams logs/user-{id}.log (per-user, written by repricerJob.js)
// "api"/"all" targets (production): streams PM2 log files via tail -f
app.get('/api/pm2-logs', (req, res, next) => {
  // EventSource cannot send headers — accept token as query param for this SSE route
  if (req.query.token && !req.headers.authorization) {
    req.headers.authorization = `Bearer ${req.query.token}`;
  }
  next();
}, requireAuth, (req, res) => {
  res.setHeader('Content-Type',        'text/event-stream');
  res.setHeader('Cache-Control',       'no-cache');
  res.setHeader('Connection',          'keep-alive');
  res.setHeader('X-Accel-Buffering',   'no');  // disable nginx proxy buffering for SSE
  res.flushHeaders();

  const send = (line, source) => {
    const match = line.match(/\[(\d{4}-\d{2}-\d{2}T[\d:.]+Z)\]/);
    const ts = match ? match[1] : new Date().toISOString();
    res.write(`data: ${JSON.stringify({ ts, line, source })}\n\n`);
    if (typeof res.flush === 'function') res.flush();
  };

  const target = req.query.process || 'worker';

  // ── Worker tab: stream per-user log file (dev + production) ──
  if (target === 'worker' || process.platform === 'win32') {
    const userId  = req.effectiveUserId;
    const logsDir = join(__dirname, 'logs');
    const logPath = join(logsDir, `user-${userId}.log`);

    if (!existsSync(logPath)) {
      send(`No log file yet for your account — logs will appear here once the repricer runs`, 'worker');
    } else {
      const content = readFileSync(logPath, 'utf8');
      content.split('\n').filter(Boolean).slice(-80).forEach(line => send(line, 'worker'));
    }

    let lastSize = existsSync(logPath) ? statSync(logPath).size : 0;
    let watcher  = null;

    try {
      // Watch the logs directory so we detect both file creation and appends
      watcher = fsWatch(logsDir, { persistent: false }, (event, filename) => {
        if (filename && filename !== `user-${userId}.log`) return;
        if (!existsSync(logPath)) return;
        try {
          const newSize = statSync(logPath).size;
          if (newSize <= lastSize) return;
          const stream = createReadStream(logPath, { start: lastSize, encoding: 'utf8' });
          let buf = '';
          stream.on('data', chunk => { buf += chunk; });
          stream.on('end', () => {
            lastSize = newSize;
            buf.split('\n').filter(Boolean).forEach(line => send(line, 'worker'));
          });
        } catch {}
      });
    } catch (err) {
      send(`Watch error: ${err.message}`, 'worker');
    }

    const hb = setInterval(() => res.write(': heartbeat\n\n'), 20000);
    req.on('close', () => { clearInterval(hb); if (watcher) watcher.close(); });
    return;
  }

  // ── API / All tabs: stream PM2 log files via tail -f (production Linux only) ──
  const pm2Dir = `${process.env.HOME || '/root'}/.pm2/logs`;

  let allPm2Logs = [];
  try {
    allPm2Logs = readdirSync(pm2Dir)
      .filter(f => f.endsWith('.log'))
      .map(f => join(pm2Dir, f));
  } catch {
    send(`PM2 logs directory not found: ${pm2Dir}`, 'worker');
  }

  const workerFiles = allPm2Logs.filter(f => /worker/i.test(f));
  const apiFiles    = allPm2Logs.filter(f => /\bapi\b/i.test(f) && !/worker/i.test(f));

  const fileMap = {
    api: apiFiles.length ? apiFiles : allPm2Logs,
    all: allPm2Logs,
  };

  if (allPm2Logs.length === 0) {
    send('No PM2 log files found — make sure PM2 processes are running', 'worker');
  }

  const files = fileMap[target] || allPm2Logs;

  const procs = files.flatMap(file => {
    const source = file.includes('worker') ? (file.includes('error') ? 'worker-err' : 'worker') :
                   file.includes('error') ? 'api-err' : 'api';
    if (!existsSync(file)) { send(`Log file not found: ${file}`, source); return []; }
    const tail = spawn('tail', ['-n', '80', '-f', file], { stdio: ['ignore', 'pipe', 'ignore'] });
    tail.stdout.setEncoding('utf8');
    tail.stdout.on('data', chunk => {
      chunk.split('\n').filter(Boolean).forEach(line => send(line, source));
    });
    tail.on('error', err => send(`tail error: ${err.message}`, source));
    return [tail];
  });

  const hb = setInterval(() => res.write(': heartbeat\n\n'), 20000);
  req.on('close', () => { clearInterval(hb); procs.forEach(p => p.kill()); });
});

// GET /api/scraper-logs/file — download the full scraper.log file
app.get('/api/scraper-logs/file', requireAuth, (req, res) => {
  const logPath = join(__dirname, 'scraper.log');
  if (!existsSync(logPath)) return res.status(404).json({ error: 'No log file yet' });
  res.setHeader('Content-Type', 'text/plain');
  res.setHeader('Content-Disposition', 'attachment; filename="scraper.log"');
  createReadStream(logPath).pipe(res);
});

// POST /api/price-check — fetch real-time price for any ASIN
app.post('/api/price-check', requireAuth, async (req, res) => {
  const { asin } = req.body;
  if (!asin || typeof asin !== 'string' || !/^[A-Z0-9]{10}$/i.test(asin.trim())) {
    return res.status(400).json({ error: 'A valid 10-character ASIN is required' });
  }
  try {
    const result = await getProductDetails(asin.trim().toUpperCase());
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/sync/:id — sync a single product manually
app.post('/api/sync/:id', requireAuth, async (req, res) => {
  try {
    const { rows } = await db.query(
      'SELECT * FROM product_mappings WHERE id = $1 AND user_id = $2',
      [req.params.id, req.effectiveUserId]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Mapping not found' });

    const scraped = await getProductDetails(rows[0].primary_asin);
    res.json({ mapping: rows[0], scraped });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────
// SUPPLIER COMPARISON
// ─────────────────────────────────────────────

// GET /api/compare/:mappingId — get all supplier ASINs + scrape prices
app.get('/api/compare/:mappingId', requireAuth, async (req, res) => {
  try {
    const { rows: suppliers } = await db.query(
      'SELECT sa.* FROM supplier_asins sa JOIN product_mappings pm ON pm.id = sa.product_mapping_id WHERE sa.product_mapping_id = $1 AND pm.user_id = $2',
      [req.params.mappingId, req.effectiveUserId]
    );

    // Return cached data immediately
    res.json({ suppliers, note: 'Cached data. Use /api/compare/:id/refresh to get live prices.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/compare/:mappingId/refresh — live scrape all sellers for a product
app.post('/api/compare/:mappingId/refresh', requireAuth, async (req, res) => {
  try {
    const { rows: mapping } = await db.query(
      'SELECT * FROM product_mappings WHERE id = $1 AND user_id = $2',
      [req.params.mappingId, req.effectiveUserId]
    );

    if (mapping.length === 0) return res.status(404).json({ error: 'Mapping not found' });

    // Scrape all sellers from Amazon offers page
    const sellersData = await getAllSellers(mapping[0].primary_asin);

    // Update cached prices in DB
    for (const seller of sellersData.sellers) {
      await db.query(
        `INSERT INTO supplier_asins (product_mapping_id, asin, supplier_name, amazon_url, last_price, in_stock, is_prime, last_checked_at)
         VALUES ($1, $2, $3, $4, $5, true, $6, NOW())
         ON CONFLICT (asin) DO UPDATE
         SET last_price = $5, is_prime = $6, last_checked_at = NOW()`,
        [req.params.mappingId, mapping[0].primary_asin, seller.sellerName, seller.listingUrl, seller.price, seller.isPrime]
      ).catch(() => {}); // ignore duplicate conflicts
    }

    res.json(sellersData);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/suppliers — add a competitor ASIN
app.post('/api/suppliers', requireAuth, async (req, res) => {
  const { product_mapping_id, asin, supplier_name, notes } = req.body;
  try {
    const { rows } = await db.query(
      `INSERT INTO supplier_asins (product_mapping_id, asin, supplier_name, amazon_url, notes)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [product_mapping_id, asin, supplier_name, `https://www.amazon.co.uk/dp/${asin}`, notes]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────
// PRICE HISTORY
// ─────────────────────────────────────────────

// GET /api/history/:mappingId — price history for charts
app.get('/api/history/:mappingId', requireAuth, async (req, res) => {
  const days = parseInt(req.query.days) || 30;
  try {
    const { rows } = await db.query(
      `SELECT ph.* FROM price_history ph
       JOIN product_mappings pm ON pm.id = ph.product_mapping_id
       WHERE ph.product_mapping_id = $1 AND pm.user_id = $2
       AND ph.recorded_at > NOW() - INTERVAL '${days} days'
       ORDER BY ph.recorded_at ASC`,
      [req.params.mappingId, req.effectiveUserId]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────
// SYNC LOGS
// ─────────────────────────────────────────────

// GET /api/logs — paginated sync logs
// Query params: page (default 1), limit (default 50, max 500), status (success|failed|skipped)
app.get('/api/logs', requireAuth, async (req, res) => {
  const uid = req.effectiveUserId;
  try {
    const limit  = Math.min(500, Math.max(1, parseInt(req.query.limit) || 50));
    const page   = Math.max(1, parseInt(req.query.page) || 1);
    const status = req.query.status || '';
    const offset = (page - 1) * limit;

    const where  = status
      ? `WHERE pm.user_id = $3 AND sl.status = $4`
      : `WHERE pm.user_id = $3`;
    const listParams  = status ? [limit, offset, uid, status] : [limit, offset, uid];
    const countParams = status ? [uid, status] : [uid];
    const countWhere  = status ? `WHERE pm.user_id = $1 AND sl.status = $2` : `WHERE pm.user_id = $1`;

    const [{ rows }, countResult] = await Promise.all([
      db.query(
        `SELECT sl.*, pm.product_name, pm.primary_asin
         FROM sync_logs sl
         JOIN product_mappings pm ON pm.id = sl.product_mapping_id
         ${where}
         ORDER BY sl.created_at DESC
         LIMIT $1 OFFSET $2`,
        listParams
      ),
      db.query(
        `SELECT COUNT(*) FROM sync_logs sl JOIN product_mappings pm ON pm.id = sl.product_mapping_id ${countWhere}`,
        countParams
      ),
    ]);

    res.json({ rows, total: parseInt(countResult.rows[0].count), page, limit });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────
// START SERVER
// ─────────────────────────────────────────────

// ─────────────────────────────────────────────
// FILE UPLOAD (multer in-memory)
// ─────────────────────────────────────────────
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

// ─────────────────────────────────────────────
// ONBUY ACCOUNTS
// ─────────────────────────────────────────────

// GET /api/accounts — list all accounts (secrets redacted)
app.get('/api/accounts', requireAuth, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT id, account_name, site_id, is_active, last_tested_at, last_test_ok, created_at,
              LEFT(consumer_key, 6) || '••••••' AS consumer_key_hint,
              keepa_email,
              CASE WHEN keepa_password IS NOT NULL AND keepa_password != '' THEN true ELSE false END AS has_keepa_password,
              enable_puppeteer, enable_twister, enable_cheerio,
              google_sheet_id,
              CASE WHEN google_service_account IS NOT NULL THEN true ELSE false END AS has_google_sheet
       FROM onbuy_accounts WHERE user_id = $1 ORDER BY created_at DESC`,
      [req.effectiveUserId]
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/accounts/:id — fetch full credentials for edit form
app.get('/api/accounts/:id', requireAuth, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT id, account_name, consumer_key, secret_key, site_id, is_active,
              keepa_email, keepa_password, enable_puppeteer, enable_twister, enable_cheerio,
              google_sheet_id, google_service_account
       FROM onbuy_accounts WHERE id = $1 AND user_id = $2`,
      [req.params.id, req.effectiveUserId]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Account not found' });
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/accounts — create account
app.post('/api/accounts', requireAuth, async (req, res) => {
  const { account_name, consumer_key, secret_key, site_id = '2000', keepa_email, keepa_password,
          enable_puppeteer, enable_twister, enable_cheerio,
          google_sheet_id, google_service_account } = req.body;
  if (!account_name || !consumer_key || !secret_key)
    return res.status(400).json({ error: 'account_name, consumer_key and secret_key are required' });
  try {
    let sheetCreds = null;
    if (google_service_account) {
      sheetCreds = typeof google_service_account === 'string'
        ? JSON.parse(google_service_account) : google_service_account;
    }
    const { rows } = await db.query(
      `INSERT INTO onbuy_accounts (account_name, consumer_key, secret_key, site_id, user_id, keepa_email, keepa_password,
                                   enable_puppeteer, enable_twister, enable_cheerio,
                                   google_sheet_id, google_service_account)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       RETURNING id, account_name, site_id, is_active, created_at, keepa_email,
                 enable_puppeteer, enable_twister, enable_cheerio, google_sheet_id,
                 CASE WHEN google_service_account IS NOT NULL THEN true ELSE false END AS has_google_sheet`,
      [account_name, consumer_key, secret_key, site_id, req.effectiveUserId,
       keepa_email || null, keepa_password || null,
       enable_puppeteer === true, enable_twister === true, enable_cheerio === true,
       google_sheet_id || null, sheetCreds ? JSON.stringify(sheetCreds) : null]
    );
    res.status(201).json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PUT /api/accounts/:id — update account
app.put('/api/accounts/:id', requireAuth, async (req, res) => {
  const { account_name, consumer_key, secret_key, site_id, is_active, keepa_email, keepa_password,
          enable_puppeteer, enable_twister, enable_cheerio,
          google_sheet_id, google_service_account } = req.body;
  try {
    let sheetCreds = undefined; // undefined = don't change; null = clear
    if (google_service_account !== undefined) {
      if (!google_service_account || google_service_account === '') {
        sheetCreds = null;
      } else {
        sheetCreds = typeof google_service_account === 'string'
          ? JSON.parse(google_service_account) : google_service_account;
        sheetCreds = JSON.stringify(sheetCreds);
      }
    }
    const { rows } = await db.query(
      `UPDATE onbuy_accounts SET
         account_name           = COALESCE($1, account_name),
         consumer_key           = COALESCE(NULLIF($2,''), consumer_key),
         secret_key             = COALESCE(NULLIF($3,''), secret_key),
         site_id                = COALESCE($4, site_id),
         is_active              = COALESCE($5, is_active),
         keepa_email            = COALESCE(NULLIF($6,''), keepa_email),
         keepa_password         = COALESCE(NULLIF($7,''), keepa_password),
         enable_puppeteer       = COALESCE($8, enable_puppeteer),
         enable_twister         = COALESCE($9, enable_twister),
         enable_cheerio         = COALESCE($10, enable_cheerio),
         google_sheet_id        = CASE WHEN $13::text IS NOT NULL THEN NULLIF($13,'') ELSE google_sheet_id END,
         google_service_account = CASE WHEN $14::text IS NOT NULL THEN $14::jsonb ELSE google_service_account END,
         updated_at             = NOW()
       WHERE id = $11 AND user_id = $12
       RETURNING id, account_name, site_id, is_active, keepa_email,
                 enable_puppeteer, enable_twister, enable_cheerio, google_sheet_id,
                 CASE WHEN google_service_account IS NOT NULL THEN true ELSE false END AS has_google_sheet`,
      [account_name || null, consumer_key || null, secret_key || null, site_id || null,
       is_active ?? null, keepa_email ?? null, keepa_password ?? null,
       enable_puppeteer ?? null, enable_twister ?? null, enable_cheerio ?? null,
       req.params.id, req.effectiveUserId,
       google_sheet_id !== undefined ? (google_sheet_id || '') : null,
       sheetCreds !== undefined ? (sheetCreds ?? null) : null]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// DELETE /api/accounts/:id
app.delete('/api/accounts/:id', requireAuth, async (req, res) => {
  try {
    await db.query('DELETE FROM onbuy_accounts WHERE id = $1 AND user_id = $2', [req.params.id, req.effectiveUserId]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/accounts/:id/test — test OnBuy credentials
app.post('/api/accounts/:id/test', requireAuth, async (req, res) => {
  try {
    const { rows } = await db.query('SELECT * FROM onbuy_accounts WHERE id = $1 AND user_id = $2', [req.params.id, req.effectiveUserId]);
    if (rows.length === 0) return res.status(404).json({ error: 'Account not found' });

    const { consumer_key, secret_key } = rows[0];
    const r = await fetch('https://api.onbuy.com/v2/auth/request-token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ consumer_key, secret_key }),
    });

    const rawText = await r.text();
    let data = {};
    try { data = JSON.parse(rawText); } catch {}

    console.log(`[OnBuy Test] HTTP ${r.status} — ${rawText.slice(0, 300)}`);

    const token = data?.access_token || data?.Result?.token || data?.result?.token || data?.token;
    const ok = !!(token);

    await db.query(
      'UPDATE onbuy_accounts SET last_tested_at = NOW(), last_test_ok = $1 WHERE id = $2',
      [ok, req.params.id]
    );

    // Return detailed message so UI shows exactly what OnBuy said
    const detail = data?.message || data?.error || data?.Error || rawText.slice(0, 200);
    res.json({ ok, message: ok ? 'Connection successful' : detail, httpStatus: r.status });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/accounts/fetch-label — resolve trading_name from OnBuy credentials + site_id
app.post('/api/accounts/fetch-label', requireAuth, async (req, res) => {
  try {
    const { consumer_key, secret_key, site_id } = req.body;
    if (!consumer_key || !secret_key) return res.status(400).json({ error: 'consumer_key and secret_key are required' });

    // Obtain access token
    const authRes = await fetch('https://api.onbuy.com/v2/auth/request-token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ consumer_key, secret_key }),
    });
    const authData = await authRes.json().catch(() => ({}));
    const token = authData?.access_token || authData?.Result?.token || authData?.result?.token || authData?.token;
    if (!token) {
      const msg = authData?.message || authData?.error || authData?.Error || `HTTP ${authRes.status}`;
      return res.status(401).json({ error: `OnBuy auth failed: ${msg}` });
    }

    // Fetch seller entities
    const entRes = await fetch('https://api.onbuy.com/v2/sellers/entities', {
      headers: { Authorization: token },
    });
    if (!entRes.ok) return res.status(502).json({ error: `Sellers entities API ${entRes.status}` });
    const entData = await entRes.json().catch(() => ({}));
    const entities = entData?.results ?? entData?.data ?? [];

    // Match by site_id if provided, otherwise return first
    const siteIdNum = site_id ? parseInt(site_id) : null;
    const match = siteIdNum
      ? entities.find(e => parseInt(e.site_id) === siteIdNum)
      : entities[0];

    if (!match) return res.status(404).json({ error: `No entity found for site_id ${site_id}` });
    res.json({ trading_name: match.trading_name });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─────────────────────────────────────────────
// EXCEL IMPORT
// ─────────────────────────────────────────────


function extractAsin(input) {
  if (!input) return null;
  const s = String(input).trim();
  if (/^[A-Z0-9]{10}$/i.test(s)) return s.toUpperCase();
  const m = s.match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})/i);
  return m ? m[1].toUpperCase() : null;
}

// Flexible column header matching — handles varied spreadsheet formats
const COL_ALIASES = {
  // OPC = OnBuy product/listing identifier (numeric → create listing, alphanumeric → listing UID)
  onbuy_opc: [
    'opc',              // new template: dedicated OPC column
    'opc/uid', 'opc_uid', 'onbuy_opc', 'onbuy opc',
    'onbuy product code', 'onbuy_product_code', 'product_code', 'product code',
    'listing uid', 'listing_uid',
  ],
  onbuy_listing_id: [
    'onbuy link', 'onbuy_link',
    'onbuy_listing_id','listing_id','onbuy_id','listingid',
    'onbuy listing id','onbuy id','onbuy_uid',
    'product id','productid','onbuy product id',
    'product link','product_link','onbuy url','onbuy product url',
  ],
  onbuy_sku: [
    'seller_sku','seller sku','sellersku',  // new template: dedicated Seller SKU column
    'onbuy_sku','product_sku','onbuy sku',
    'order number','order_number','ordernumber',
  ],
  product_name: [
    'product_name','product name','product_title','product title',
    'title','name','item name','description','listing title',
  ],
  primary_asin: [
    'sourcing link','sourcing_link','sourcing  link',  // new template: Sourcing Link column
    'amazon_url_or_asin','amazon_url','amazon_link','asin','primary_asin','amazon_asin',
    'source_url','source_link','source','amazon','sourcing','amazon url or asin',
    'amazon url','amazon link','source url','source link','source asin',
    'amazon_source','amazon source','supplier url','supplier_url',
    'buy url','buyurl','amazon_product_url',
    'amazon source url','amazon source link','source product link','source product url',
    'sku',
  ],
  unit_price: [
    'unit_price', 'unit price', 'selling_price', 'selling price',
    'initial_price', 'initial price', 'list_price', 'list price',
  ],
  markup_type: [
    'markup_type','pricing_type','markup type','price type','pricetype',
  ],
  markup_value: [
    'roi_%', 'roi%', 'roi', 'roi_percent', 'roi percent',  // new template: ROI % column
    'markup_value','markup','markup_percent','markup_amount','markup value',
    'markup %','margin','margin %','margin_percent','margin_value',
  ],
  onbuy_fee: [
    'onbuy_fee', 'onbuy fee', 'fee', 'platform_fee', 'platform fee',
    'listing fee', 'listing_fee', 'marketplace fee', 'marketplace_fee',
  ],
  min_price: [
    'min_price','floor_price','minimum_price','price_floor','min price',
    'minimum price','price floor','min_sell_price',
  ],
  notes: ['notes','note','comments','comment','remarks'],
};

function normalizeKey(k) {
  return k.toLowerCase().trim()
    .replace(/\s+/g, '_')     // spaces → underscores
    .replace(/[*#!?]+/g, '')  // strip * # ! ? characters
    .replace(/_+/g, '_')      // collapse multiple underscores
    .replace(/^_|_$/g, '');   // trim leading/trailing underscores
}

function mapRow(rawRow) {
  const normalized = {};
  for (const [k, v] of Object.entries(rawRow)) {
    normalized[normalizeKey(k)] = v;
  }
  const out = {};
  for (const [field, aliases] of Object.entries(COL_ALIASES)) {
    for (const alias of aliases) {
      const key = normalizeKey(alias);
      if (normalized[key] !== undefined && normalized[key] !== '') {
        out[field] = normalized[key];
        break;
      }
    }
  }
  return out;
}

// ── OnBuy OPC helpers ──────────────────────────────────────────

// Extract numeric OPC from an OnBuy product URL (e.g. ~p87787400) or bare number
function extractOnBuyOpc(input) {
  if (!input) return null;
  const s = String(input).trim();
  if (/^\d{5,12}$/.test(s)) return s;                        // bare numeric OPC
  const m = s.match(/~p(\d+)\/?$/i) || s.match(/[/~]p(\d+)/i);
  return m ? m[1] : null;
}

// A listing UID is a short alphanumeric token — NOT a URL
function isListingUid(s) {
  if (!s) return false;
  return !/^https?:/i.test(s) && !/onbuy\.com/i.test(s);
}

// GET /v2/listings with a JSON body of SKUs — OnBuy accepts GET with body for this endpoint.
// Returns the listings array or null on error.
async function fetchOnBuyListingsBySkus(token, siteId, skus) {
  const bodyBuf = Buffer.from(JSON.stringify({ site_id: parseInt(siteId) || 2000, skus }));
  return new Promise((resolve) => {
    const opts = {
      hostname: 'api.onbuy.com',
      path:     `/v2/listings?site_id=${siteId}&limit=1000`,
      method:   'GET',
      headers:  { Authorization: token, 'Content-Type': 'application/json', 'Content-Length': bodyBuf.length },
    };
    const req2 = https.request(opts, (r2) => {
      let raw = '';
      r2.on('data', c => raw += c);
      r2.on('end', () => {
        try {
          const data = JSON.parse(raw);
          const list = Array.isArray(data) ? data : (data.payload ?? data.results ?? data.listings ?? []);
          resolve(list);
        } catch { resolve(null); }
      });
    });
    req2.on('error', () => resolve(null));
    req2.write(bodyBuf);
    req2.end();
  });
}

// Fetch account row from DB
async function getImportAccount(accountId) {
  if (!accountId) return null;
  try {
    const { rows } = await db.query(
      'SELECT * FROM onbuy_accounts WHERE id = $1 AND is_active = true', [accountId]
    );
    return rows[0] || null;
  } catch { return null; }
}

// Get a fresh OnBuy OAuth token for an account
async function getOnBuyTokenForAccount(account) {
  const r = await fetch('https://api.onbuy.com/v2/auth/request-token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ consumer_key: account.consumer_key, secret_key: account.secret_key }),
  });
  const data = await r.json();
  return data?.access_token || data?.Result?.token || null;
}

// Create a new seller listing on OnBuy using an OPC
async function createOnBuyListing(opc, price, sku, token, siteId) {
  const body = {
    listings: [{
      opc,
      condition: 'new',
      price: parseFloat(price || 9.99).toFixed(2),
      stock: 1,
      ...(sku ? { sku } : {}),
    }],
  };
  console.log(`[OnBuy Create] POST /v2/listings  OPC=${opc}  body=${JSON.stringify(body)}`);

  const r = await fetch(`https://api.onbuy.com/v2/listings?site_id=${siteId}`, {
    method: 'POST',
    headers: { Authorization: token, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  const rawText = await r.text();
  console.log(`[OnBuy Create] HTTP ${r.status} → ${rawText.slice(0, 600)}`);

  let data;
  try { data = JSON.parse(rawText); } catch { data = { _raw: rawText }; }

  if (!r.ok) {
    const msg = data?.message || data?.error || data?.errors?.[0]?.message || rawText.slice(0, 300);
    throw new Error(`OnBuy API ${r.status}: ${msg}`);
  }

  // OnBuy wraps per-item outcomes in data.results[]
  // Each item has its own success flag and message
  const item = Array.isArray(data?.results)  ? data.results[0]
             : Array.isArray(data?.payload)  ? data.payload[0]
             : Array.isArray(data?.listings) ? data.listings[0]
             : Array.isArray(data)           ? data[0]
             : data;

  // Per-item failure (HTTP 200 but success:false inside)
  if (item?.success === false) {
    const msg = item.message || `OPC ${opc} was rejected by OnBuy`;
    throw new Error(msg);
  }

  const uid = item?.uid || item?.listing_uid || item?.id || null;

  if (!uid) {
    throw new Error(
      `OnBuy accepted the request but returned no listing UID. Raw: ${rawText.slice(0, 300)}`
    );
  }

  return { uid, opc, raw: data };
}

// GET /api/import/template — download the import template
app.get('/api/import/template', requireAuth, (req, res) => {
  // Columns: No# | Product Name | Seller SKU
  //
  // Seller SKU = Amazon ASIN and OnBuy seller SKU (used to scrape Amazon price and update the listing)

  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet([
    ['No#', 'Product Name', 'Seller SKU'],
    [1, 'TP-Link Tapo 3K 5MP Pan/Tilt Security Camera', 'B0F5K2H4NQ'],
    [2, 'Foam Exercise Floor Mats', 'B0CPM1JG1B'],
  ]);

  ws['!cols'] = [5, 50, 18].map(w => ({ wch: w }));
  XLSX.utils.book_append_sheet(wb, ws, 'Import Template');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="import-template.xlsx"');
  res.send(buf);
});

// POST /api/import/preview — parse uploaded Excel, return rows for user review
// Auto-detects 1-row header (new template) or 2-row header (old template with section headings)
app.post('/api/import/preview', requireAuth, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  // Read the user's actual default ROI% from DB (falls back to 20 if not set)
  let userDefaultRoi = _globalSettings.defaultRoi;
  try {
    const { rows: srRows } = await db.query(
      `SELECT value FROM settings WHERE user_id = $1 AND key = 'default_roi_percent' LIMIT 1`,
      [req.effectiveUserId]
    );
    if (srRows[0]?.value) userDefaultRoi = parseFloat(srRows[0].value);
  } catch {}
  try {
    const wb = XLSX.read(req.file.buffer, { type: 'buffer' });
    const ws = wb.Sheets[wb.SheetNames[0]];

    const allRows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
    if (allRows.length < 1) return res.json({ total: 0, valid: 0, rows: [], detectedColumns: [] });

    // Auto-detect header row: new format has headers on row 0; old format had section headings on row 0
    const knownCols = new Set(Object.values(COL_ALIASES).flat().map(a => normalizeKey(a)));
    const row0Matches = (allRows[0] || []).filter(h => h && knownCols.has(normalizeKey(String(h)))).length;
    const headerRowIndex = row0Matches >= 2 ? 0 : 1;

    if (allRows.length <= headerRowIndex) return res.json({ total: 0, valid: 0, rows: [], detectedColumns: [] });

    const headerRow = allRows[headerRowIndex];
    const detectedColumns = headerRow.map(h => String(h || '').trim()).filter(h => h !== '');
    console.log(`[Import] Header row ${headerRowIndex + 1} (${detectedColumns.length} cols):`, detectedColumns);

    const raw = allRows.slice(headerRowIndex + 1).map(row => {
      const obj = {};
      headerRow.forEach((h, i) => {
        const key = String(h || '').trim();
        if (key) obj[key] = row[i] !== undefined ? row[i] : '';
      });
      return obj;
    });

    if (raw.length === 0) return res.json({ total: 0, valid: 0, rows: [], detectedColumns });

    const rows = raw.map((r, i) => {
      const vals = Object.values(r).map(v => String(v).trim()).filter(Boolean);
      if (vals.length === 0) return null;

      const mapped = mapRow(r);

      // ASIN: from Sourcing Link if present, otherwise Seller SKU = ASIN (new template format)
      let asin = extractAsin(mapped.primary_asin);
      const sellerSku = String(mapped.onbuy_sku || '').trim();
      if (!asin && sellerSku) asin = extractAsin(sellerSku);
      // OPC/UID: from "OPC" column → numeric = product code (create), alphanumeric = listing UID (update)
      const rawOpcField  = String(mapped.onbuy_opc || '').trim();
      // Onbuy Link: OnBuy product URL — extract numeric OPC as fallback
      const rawListingId = String(mapped.onbuy_listing_id || '').trim();

      let uid = null;
      let opc = null;

      // Process OPC column
      if (rawOpcField) {
        if (/^\d{5,12}$/.test(rawOpcField)) {
          opc = rawOpcField;                      // numeric → OnBuy product code (create listing)
        } else if (isListingUid(rawOpcField)) {
          uid = rawOpcField;                      // alphanumeric → listing UID (update)
        } else {
          opc = extractOnBuyOpc(rawOpcField);
        }
      }

      // Fallback: extract numeric OPC from Onbuy Link URL (e.g. ~p250186652)
      if (!uid && !opc) {
        if (rawListingId && isListingUid(rawListingId)) {
          uid = rawListingId;
        } else {
          const opcFromUrl = extractOnBuyOpc(rawListingId);
          if (opcFromUrl) opc = opcFromUrl;
        }
      }

      // action: 'update' = has Seller SKU or UID; 'create' = numeric OPC only
      const action = (sellerSku || uid) ? 'update' : opc ? 'create' : null;

      const sellingPrice = parseFloat(mapped.unit_price) || null;

      // ROI%: use sheet value if present; otherwise always use settings default ROI.
      const sheetRoi    = parseFloat(mapped.markup_value);
      const hasRoiCol   = !isNaN(sheetRoi) && String(mapped.markup_value || '').trim() !== '';
      const markupType  = (hasRoiCol || sellingPrice) ? 'roi'
                        : String(mapped.markup_type || 'roi').toLowerCase().trim();
      const markupValue = hasRoiCol ? sheetRoi : userDefaultRoi;

      // OnBuy Fee: use sheet value if present, otherwise auto-calculate as fee% of selling price
      const sheetFee    = parseFloat(mapped.onbuy_fee);
      const onbuyFee    = (!isNaN(sheetFee) && sheetFee > 0)
        ? sheetFee
        : sellingPrice ? parseFloat((sellingPrice * _globalSettings.feeRate).toFixed(2)) : 0;

      const productName = String(mapped.product_name || '').trim();

      return {
        _row: i + headerRowIndex + 2,
        action,
        product_name:     productName,
        needs_title_fetch: !productName && !!asin,  // flag: fetch from Amazon in confirm step
        onbuy_listing_id: uid || rawListingId,
        onbuy_opc:        opc || null,
        onbuy_sku:        sellerSku,
        unit_price:       sellingPrice,
        target_price:     sellingPrice,
        primary_asin:     asin,
        raw_source:       String(mapped.primary_asin || sellerSku || '').trim(),
        markup_type:      markupType,
        markup_value:     markupValue,
        markup_is_explicit: hasRoiCol,
        onbuy_fee:        onbuyFee,
        min_price:        parseFloat(mapped.min_price) || null,
        notes:            String(mapped.notes || '').trim(),
        valid:            !!(action && asin),
        errors:           [
          !action && 'Missing identifier — add a Seller SKU or OPC in the template',
          !asin   && 'Invalid or missing ASIN — Seller SKU must be a valid Amazon ASIN',
        ].filter(Boolean),
      };
    }).filter(Boolean);

    res.json({
      total: rows.length,
      valid: rows.filter(r => r.valid).length,
      rows,
      detectedColumns,
    });
  } catch (err) {
    console.error('[Import] Parse error:', err);
    res.status(400).json({ error: `Failed to parse file: ${err.message}` });
  }
});

// POST /api/import/confirm — bulk upsert product_mappings from validated rows.
// Uses PostgreSQL unnest for batch operations — handles 40k+ rows without timeout.
app.post('/api/import/confirm', requireAuth, async (req, res) => {
  const { rows, onbuy_account_id, filename } = req.body;
  if (!Array.isArray(rows) || rows.length === 0)
    return res.status(400).json({ error: 'No rows provided' });

  const toImport = rows.filter(r => r.valid);
  const results  = { created: 0, updated: 0, skipped: 0, onbuy_created: 0, errors: [] };

  // ── 1. Handle 'create' rows individually (each needs an OnBuy API call) ──
  const createRows = toImport.filter(r => r.action === 'create' && r.onbuy_opc);
  const bulkRows   = toImport.filter(r => !(r.action === 'create' && r.onbuy_opc));

  // Eagerly fetch the account and token — needed for both listing-creation rows
  // and the title/OPC fetch in Step 2 (which runs even on pure-update re-imports).
  let account = null, onbuyToken = null;
  if (onbuy_account_id) {
    account = await getImportAccount(onbuy_account_id);
    if (account) onbuyToken = await getOnBuyTokenForAccount(account);
  }

  for (const row of createRows) {
    try {
      if (!onbuyToken) throw new Error('No OnBuy account linked or token failed');
      const created = await createOnBuyListing(row.onbuy_opc, row.unit_price, row.onbuy_sku || null, onbuyToken, account.site_id);
      row.onbuy_listing_id = created.uid;
      results.onbuy_created++;
      bulkRows.push(row); // now has a UID — process via bulk path
    } catch (err) {
      results.errors.push({ row: row._row, product: row.product_name || '?', error: err.message });
      results.skipped++;
    }
  }

  // ── 2. Auto-fetch missing titles + OPCs via OnBuy listings API ──
  // GET /v2/listings returns both product name and OPC in one batch request — no Amazon scraping needed.
  const titleRows = bulkRows.filter(r => r.needs_title_fetch && r.primary_asin);
  if (titleRows.length > 0) {
    if (!account) account = await getImportAccount(onbuy_account_id);
    if (account && !onbuyToken) onbuyToken = await getOnBuyTokenForAccount(account);
    if (onbuyToken && account) {
      const siteId   = parseInt(account.site_id) || 2000;
      const skuMap   = new Map(titleRows.map(r => [r.onbuy_sku || r.primary_asin, r]));
      const allSkus2 = [...skuMap.keys()];
      console.log(`[Import] Fetching ${allSkus2.length} title(s)/OPC(s) from OnBuy listings API…`);
      for (let i = 0; i < allSkus2.length; i += 1000) {
        const chunk    = allSkus2.slice(i, i + 1000);
        const listings = await fetchOnBuyListingsBySkus(onbuyToken, siteId, chunk);
        if (!listings) continue;
        for (const listing of listings) {
          const row       = skuMap.get(listing.sku);
          if (!row) continue;
          const title     = listing.name || listing.product_name || listing.title || null;
          const opc       = listing.opc || listing.product_encoded_id || null;
          const listingId = listing.uid || listing.listing_uid || listing.id || listing.product_listing_id || null;
          if (title     && !row.product_name)     row.product_name     = title;
          if (opc       && !row.onbuy_opc)        row.onbuy_opc        = opc;
          if (listingId && !row.onbuy_listing_id) row.onbuy_listing_id = String(listingId);
        }
      }
    }
  }

  // ── 3. One query to find ALL existing records by sku or listing_id ──
  const allSkus = [...new Set(bulkRows.map(r => r.onbuy_sku).filter(Boolean))];
  const allUids = [...new Set(bulkRows.map(r => r.onbuy_listing_id).filter(Boolean))];

  const { rows: existing } = await db.query(
    `SELECT id, onbuy_sku, onbuy_listing_id
     FROM product_mappings
     WHERE user_id = $3
       AND (onbuy_sku = ANY($1::text[]) OR onbuy_listing_id = ANY($2::text[]))`,
    [allSkus.length ? allSkus : ['__none__'], allUids.length ? allUids : ['__none__'], req.effectiveUserId]
  );
  const bySkuMap = new Map(existing.filter(r => r.onbuy_sku).map(r => [r.onbuy_sku, r.id]));
  const byUidMap = new Map(existing.filter(r => r.onbuy_listing_id).map(r => [r.onbuy_listing_id, r.id]));

  const toUpdate = [];
  const toInsert = [];
  for (const row of bulkRows) {
    const existId = (row.onbuy_sku && bySkuMap.get(row.onbuy_sku))
                 || (row.onbuy_listing_id && byUidMap.get(row.onbuy_listing_id));
    if (existId) toUpdate.push({ ...row, _id: existId });
    else         toInsert.push(row);
  }

  // ── 4. Batch UPDATE via unnest — one query per 5000 rows ──
  const CHUNK = 5000;
  for (let i = 0; i < toUpdate.length; i += CHUNK) {
    const c = toUpdate.slice(i, i + CHUNK);
    await db.query(`
      UPDATE product_mappings pm SET
        product_name       = COALESCE(NULLIF(v.product_name,''),  pm.product_name),
        onbuy_listing_id   = COALESCE(NULLIF(v.listing_id,''),    pm.onbuy_listing_id),
        onbuy_opc          = COALESCE(NULLIF(v.opc,''),           pm.onbuy_opc),
        onbuy_sku          = COALESCE(NULLIF(v.sku,''),           pm.onbuy_sku),
        markup_type        = v.markup_type,
        markup_value       = v.markup_value::decimal,
        markup_is_explicit = v.markup_is_explicit::boolean,
        onbuy_fee          = v.onbuy_fee::decimal,
        target_price       = COALESCE(NULLIF(v.target_price,'')::decimal, pm.target_price),
        min_price          = COALESCE(NULLIF(v.min_price,'')::decimal,    pm.min_price),
        notes              = COALESCE(NULLIF(v.notes,''),         pm.notes),
        updated_at         = NOW()
      FROM (SELECT * FROM unnest(
        $1::int[], $2::text[], $3::text[], $4::text[], $5::text[],
        $6::text[], $7::text[], $8::text[], $9::text[], $10::text[], $11::text[], $12::text[]
      ) AS v(id, product_name, listing_id, opc, sku,
             markup_type, markup_value, markup_is_explicit, onbuy_fee, target_price, min_price, notes)) v
      WHERE pm.id = v.id AND pm.user_id = ${req.effectiveUserId}`,
    [
      c.map(r => r._id),
      c.map(r => r.product_name     || ''),
      c.map(r => r.onbuy_listing_id || ''),
      c.map(r => r.onbuy_opc        || ''),
      c.map(r => r.onbuy_sku        || ''),
      c.map(r => r.markup_type      || 'roi'),
      c.map(r => String(r.markup_value ?? 0)),
      c.map(r => String(r.markup_is_explicit === true ? 'true' : 'false')),
      c.map(r => String(r.onbuy_fee  ?? 0)),
      c.map(r => r.target_price != null ? String(r.target_price) : ''),
      c.map(r => r.min_price    != null ? String(r.min_price)    : ''),
      c.map(r => r.notes        || ''),
    ]);
    results.updated += c.length;
  }

  // ── 5. Batch INSERT via unnest — one query per 5000 rows ──
  for (let i = 0; i < toInsert.length; i += CHUNK) {
    const c = toInsert.slice(i, i + CHUNK);
    await db.query(`
      INSERT INTO product_mappings
        (product_name, onbuy_listing_id, onbuy_opc, onbuy_sku, primary_asin,
         markup_type, markup_value, markup_is_explicit, onbuy_fee, target_price, min_price, notes,
         onbuy_account_id, user_id, is_active)
      SELECT
        NULLIF(v.product_name,''),
        NULLIF(v.listing_id,''),
        NULLIF(v.opc,''),
        NULLIF(v.sku,''),
        v.asin,
        v.markup_type,
        v.markup_value::decimal,
        v.markup_is_explicit::boolean,
        v.onbuy_fee::decimal,
        NULLIF(v.target_price,'')::decimal,
        NULLIF(v.min_price,'')::decimal,
        NULLIF(v.notes,''),
        NULLIF(v.account_id,'')::int,
        v.user_id::int,
        true
      FROM unnest(
        $1::text[], $2::text[], $3::text[], $4::text[], $5::text[],
        $6::text[], $7::text[], $8::text[], $9::text[], $10::text[], $11::text[], $12::text[], $13::text[], $14::text[]
      ) AS v(product_name, listing_id, opc, sku, asin,
             markup_type, markup_value, markup_is_explicit, onbuy_fee, target_price, min_price, notes, account_id, user_id)`,
    [
      c.map(r => r.product_name     || ''),
      c.map(r => r.onbuy_listing_id || ''),
      c.map(r => r.onbuy_opc        || ''),
      c.map(r => r.onbuy_sku        || ''),
      c.map(r => r.primary_asin),
      c.map(r => r.markup_type      || 'roi'),
      c.map(r => String(r.markup_value ?? 0)),
      c.map(r => String(r.markup_is_explicit === true ? 'true' : 'false')),
      c.map(r => String(r.onbuy_fee  ?? 0)),
      c.map(r => r.target_price != null ? String(r.target_price) : ''),
      c.map(r => r.min_price    != null ? String(r.min_price)    : ''),
      c.map(r => r.notes        || ''),
      c.map(() => onbuy_account_id != null ? String(onbuy_account_id) : ''),
      c.map(() => String(req.effectiveUserId)),
    ]);
    results.created += c.length;
  }

  // ── 6. Post-import OPC sync — fetch OPCs for just-imported rows still missing them ──
  if (onbuyToken && account) {
    const missingOpcSkus = [...new Set(
      bulkRows
        .filter(r => !r.onbuy_opc)
        .map(r => (r.onbuy_sku || r.primary_asin || '').trim())
        .filter(Boolean)
    )];
    if (missingOpcSkus.length > 0) {
      const siteId = parseInt(account.site_id) || 2000;
      console.log(`[Import] Post-import OPC sync for ${missingOpcSkus.length} SKU(s)…`);
      for (let i = 0; i < missingOpcSkus.length; i += 1000) {
        const chunk    = missingOpcSkus.slice(i, i + 1000);
        const listings = await fetchOnBuyListingsBySkus(onbuyToken, siteId, chunk).catch(() => null);
        if (!listings?.length) continue;
        for (const listing of listings) {
          const opc       = listing.opc || listing.product_encoded_id;
          const title     = listing.name || listing.product_name || listing.title || null;
          const listingId = listing.uid || listing.listing_uid || listing.id || listing.product_listing_id || null;
          if (!listing.sku || !opc) continue;
          db.query(
            `UPDATE product_mappings
             SET onbuy_opc        = $1,
                 onbuy_listing_id = COALESCE(NULLIF(onbuy_listing_id,''), $3),
                 product_name     = COALESCE(NULLIF(product_name,''), $4)
             WHERE user_id = $2 AND (onbuy_sku = $5 OR primary_asin = $5) AND onbuy_opc IS NULL`,
            [opc, req.effectiveUserId, listingId ? String(listingId) : null, title, listing.sku]
          ).catch(() => {});
        }
      }
    }
  }

  // Audit log (best-effort)
  db.query(
    `INSERT INTO import_logs (filename, total_rows, imported, skipped, row_errors, user_id)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [filename || 'unknown', toImport.length, results.created + results.updated,
     results.skipped, JSON.stringify(results.errors), req.effectiveUserId]
  ).catch(() => {});

  res.json(results);
});

// ─────────────────────────────────────────────
// DB MIGRATIONS — run once on startup
// ─────────────────────────────────────────────

async function runMigrations() {
  const steps = [
    // onbuy_listing_id was VARCHAR(100) — OnBuy product URLs exceed that
    `ALTER TABLE product_mappings ALTER COLUMN onbuy_listing_id TYPE TEXT`,
    // SKU-only imports don't supply a listing UID — make the column nullable
    `ALTER TABLE product_mappings ALTER COLUMN onbuy_listing_id DROP NOT NULL`,
    // store OPC alongside UID so we can always re-link or re-create if needed
    `ALTER TABLE product_mappings ADD COLUMN IF NOT EXISTS onbuy_opc TEXT`,
    // onbuy_fee: fixed platform fee added on top of ROI-based price calculation
    `ALTER TABLE product_mappings ADD COLUMN IF NOT EXISTS onbuy_fee DECIMAL(10,2) DEFAULT 0`,
    // allow 'roi' markup_type (source_price + source_price×ROI% + onbuy_fee)
    `ALTER TABLE product_mappings DROP CONSTRAINT IF EXISTS product_mappings_markup_type_check`,
    `ALTER TABLE product_mappings ADD CONSTRAINT product_mappings_markup_type_check CHECK (markup_type IN ('percent', 'fixed', 'roi'))`,
    // track whether Amazon listing is in stock (false = OOS, OnBuy stock set to 0)
    `ALTER TABLE product_mappings ADD COLUMN IF NOT EXISTS amazon_in_stock BOOLEAN DEFAULT true`,
    // target_price: the desired OnBuy selling price imported from the Excel sheet
    // Used to derive ROI% on the first repricer run when no explicit ROI% was provided
    `ALTER TABLE product_mappings ADD COLUMN IF NOT EXISTS target_price DECIMAL(10,2) DEFAULT NULL`,
    // settings: generic key-value store for user-configurable options
    `CREATE TABLE IF NOT EXISTS settings (
       key        TEXT,
       value      TEXT,
       updated_at TIMESTAMP DEFAULT NOW()
     )`,
    // per-user settings: drop old single-key PK, add user_id FK
    `ALTER TABLE settings DROP CONSTRAINT IF EXISTS settings_pkey`,
    `ALTER TABLE settings ADD COLUMN IF NOT EXISTS user_id INT REFERENCES users(id) ON DELETE CASCADE`,
    // import audit log
    `CREATE TABLE IF NOT EXISTS import_logs (
       id           SERIAL PRIMARY KEY,
       filename     TEXT,
       total_rows   INT DEFAULT 0,
       imported     INT DEFAULT 0,
       skipped      INT DEFAULT 0,
       row_errors   JSONB DEFAULT '[]'::jsonb,
       created_at   TIMESTAMP DEFAULT NOW()
     )`,
    // Fix listings imported with markup_value=0 — use default_roi_percent from settings (or 20 as fallback)
    `UPDATE product_mappings
     SET markup_value = COALESCE(
       (SELECT value::decimal FROM settings WHERE key = 'default_roi_percent'),
       20
     )
     WHERE markup_type = 'roi' AND markup_value = 0`,
    // ── Auth / multi-user ──────────────────────────────────────
    `CREATE TABLE IF NOT EXISTS users (
       id            SERIAL PRIMARY KEY,
       username      TEXT NOT NULL UNIQUE,
       email         TEXT,
       password_hash TEXT NOT NULL,
       role          TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'super_admin')),
       is_active     BOOLEAN NOT NULL DEFAULT true,
       created_at    TIMESTAMP DEFAULT NOW(),
       updated_at    TIMESTAMP DEFAULT NOW()
     )`,
    `ALTER TABLE onbuy_accounts   ADD COLUMN IF NOT EXISTS user_id INT REFERENCES users(id) ON DELETE CASCADE`,
    `ALTER TABLE product_mappings ADD COLUMN IF NOT EXISTS user_id INT REFERENCES users(id) ON DELETE CASCADE`,
    `ALTER TABLE import_logs      ADD COLUMN IF NOT EXISTS user_id INT REFERENCES users(id) ON DELETE SET NULL`,
    // Per-account Keepa credentials (replaces global keepa_email/keepa_password in settings)
    `ALTER TABLE onbuy_accounts ADD COLUMN IF NOT EXISTS keepa_email TEXT`,
    `ALTER TABLE onbuy_accounts ADD COLUMN IF NOT EXISTS keepa_password TEXT`,
    // Per-account puppeteer toggle: false = skip slow-queue browser escalation
    `ALTER TABLE onbuy_accounts ADD COLUMN IF NOT EXISTS enable_puppeteer BOOLEAN NOT NULL DEFAULT false`,
    // Per-account Twister/Cheerio toggles — default off, rely on Keepa by default
    `ALTER TABLE onbuy_accounts ADD COLUMN IF NOT EXISTS enable_twister BOOLEAN NOT NULL DEFAULT false`,
    `ALTER TABLE onbuy_accounts ADD COLUMN IF NOT EXISTS enable_cheerio BOOLEAN NOT NULL DEFAULT false`,
    // Index for the repricer job query: ORDER BY last_synced_at per active user avoids a full table scan
    `CREATE INDEX IF NOT EXISTS idx_pm_active_synced ON product_mappings (user_id, last_synced_at ASC NULLS FIRST) WHERE is_active = true`,
    // OnBuy bulk import history tables
    `CREATE TABLE IF NOT EXISTS onbuy_bulk_import_sessions (
      id               SERIAL PRIMARY KEY,
      user_id          INTEGER NOT NULL,
      account_id       INTEGER,
      account_name     TEXT,
      total_rows       INTEGER DEFAULT 0,
      products_created INTEGER DEFAULT 0,
      listings_created INTEGER DEFAULT 0,
      skipped          INTEGER DEFAULT 0,
      errors_count     INTEGER DEFAULT 0,
      status           TEXT    DEFAULT 'processing',
      created_at       TIMESTAMP DEFAULT NOW(),
      completed_at     TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS onbuy_bulk_import_items (
      id            SERIAL PRIMARY KEY,
      session_id    INTEGER REFERENCES onbuy_bulk_import_sessions(id) ON DELETE CASCADE,
      user_id       INTEGER NOT NULL,
      row_number    INTEGER,
      product_name  TEXT,
      sku           TEXT,
      ean           TEXT,
      category      TEXT,
      brand         TEXT,
      source_price  NUMERIC,
      selling_price NUMERIC,
      stock         INTEGER,
      condition     TEXT,
      opc           TEXT,
      status        TEXT,
      error_message TEXT,
      created_at    TIMESTAMP DEFAULT NOW()
    )`,
    `ALTER TABLE onbuy_bulk_import_sessions ADD COLUMN IF NOT EXISTS listings_updated INTEGER DEFAULT 0`,
    `ALTER TABLE onbuy_bulk_import_sessions ADD COLUMN IF NOT EXISTS pending_queues INTEGER DEFAULT 0`,
    `ALTER TABLE onbuy_bulk_import_sessions ADD COLUMN IF NOT EXISTS rows_data JSONB`,
    `ALTER TABLE onbuy_bulk_import_sessions ADD COLUMN IF NOT EXISTS rate_limit_until TIMESTAMPTZ`,
    `CREATE TABLE IF NOT EXISTS onbuy_categories (
       category_id  INTEGER      NOT NULL PRIMARY KEY,
       name         TEXT         NOT NULL,
       tree         TEXT,
       level        INTEGER,
       synced_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW()
     )`,
    // Migrate existing installs: drop account/site columns and rebuild PK as global
    `DO $$ BEGIN
       IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='onbuy_categories' AND column_name='account_id') THEN
         TRUNCATE TABLE onbuy_categories;
         ALTER TABLE onbuy_categories DROP CONSTRAINT IF EXISTS onbuy_categories_pkey;
         ALTER TABLE onbuy_categories DROP COLUMN IF EXISTS account_id;
         ALTER TABLE onbuy_categories DROP COLUMN IF EXISTS site_id;
         ALTER TABLE onbuy_categories ADD PRIMARY KEY (category_id);
       END IF;
     END $$`,
    `CREATE INDEX IF NOT EXISTS idx_onbuy_cats_name ON onbuy_categories(lower(name))`,
    `CREATE TABLE IF NOT EXISTS onbuy_bulk_pending_queues (
       id           SERIAL PRIMARY KEY,
       session_id   INTEGER,
       user_id      INTEGER NOT NULL,
       account_id   INTEGER NOT NULL,
       site_id      INTEGER NOT NULL DEFAULT 2000,
       queue_id     TEXT    NOT NULL UNIQUE,
       uid          TEXT,
       row_meta     JSONB   NOT NULL,
       status       TEXT    NOT NULL DEFAULT 'pending',
       opc          TEXT,
       attempts     INTEGER NOT NULL DEFAULT 0,
       created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
       last_polled_at TIMESTAMPTZ,
       error_message TEXT
     )`,
    `CREATE INDEX IF NOT EXISTS idx_bpq_user_status    ON onbuy_bulk_pending_queues(user_id, status)`,
    `CREATE INDEX IF NOT EXISTS idx_bpq_account_status ON onbuy_bulk_pending_queues(account_id, status)`,
    `CREATE INDEX IF NOT EXISTS idx_bpq_session        ON onbuy_bulk_pending_queues(session_id)`,
    `CREATE TABLE IF NOT EXISTS daily_sync_stats (
       user_id          INT  NOT NULL,
       onbuy_account_id INT  NOT NULL DEFAULT 0,
       date             DATE NOT NULL DEFAULT CURRENT_DATE,
       synced_count     INT  NOT NULL DEFAULT 0,
       price_changes    INT  NOT NULL DEFAULT 0,
       PRIMARY KEY (user_id, onbuy_account_id, date)
     )`,
    `ALTER TABLE daily_sync_stats ADD COLUMN IF NOT EXISTS last_repriced_at TIMESTAMPTZ`,
    // Google Sheets integration per OnBuy account
    `ALTER TABLE onbuy_accounts ADD COLUMN IF NOT EXISTS google_sheet_id TEXT`,
    `ALTER TABLE onbuy_accounts ADD COLUMN IF NOT EXISTS google_service_account JSONB`,
    // Orders sync table
    `CREATE TABLE IF NOT EXISTS onbuy_orders (
       id                 SERIAL PRIMARY KEY,
       account_id         INTEGER NOT NULL REFERENCES onbuy_accounts(id) ON DELETE CASCADE,
       user_id            INTEGER NOT NULL,
       order_id           TEXT NOT NULL,
       onbuy_internal_ref TEXT,
       order_date         TIMESTAMPTZ,
       updated_at_onbuy   TIMESTAMPTZ,
       status             TEXT,
       site_id            TEXT,
       buyer_name         TEXT,
       buyer_email        TEXT,
       buyer_phone        TEXT,
       delivery_address   JSONB,
       billing_address    JSONB,
       price_subtotal     NUMERIC(10,2),
       price_total        NUMERIC(10,2),
       price_delivery     NUMERIC(10,2),
       sales_fee_ex_vat   NUMERIC(10,2),
       sales_fee_inc_vat  NUMERIC(10,2),
       vat_rate           NUMERIC(5,2),
       currency_code      TEXT,
       fee                JSONB,
       products           JSONB,
       raw_data           JSONB,
       synced_at          TIMESTAMPTZ DEFAULT NOW(),
       UNIQUE(account_id, order_id)
     )`,
    `CREATE INDEX IF NOT EXISTS idx_onbuy_orders_account ON onbuy_orders(account_id)`,
    `CREATE INDEX IF NOT EXISTS idx_onbuy_orders_date    ON onbuy_orders(order_date DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_onbuy_orders_status  ON onbuy_orders(status)`,
    `CREATE INDEX IF NOT EXISTS idx_onbuy_orders_user    ON onbuy_orders(user_id)`,
    // Per-line-item enrichment table (product URL, ASIN, source price, financials)
    `CREATE TABLE IF NOT EXISTS onbuy_order_items (
       id            SERIAL PRIMARY KEY,
       order_id      TEXT    NOT NULL,
       account_id    INTEGER NOT NULL,
       user_id       INTEGER NOT NULL,
       sku           TEXT    NOT NULL DEFAULT '',
       product_name  TEXT,
       quantity      INTEGER,
       unit_price    NUMERIC(10,2),
       total_price   NUMERIC(10,2),
       onbuy_fee     NUMERIC(10,2),
       vat           NUMERIC(10,2),
       total_fee     NUMERIC(10,2),
       product_url   TEXT,
       amazon_asin   TEXT,
       source_url    TEXT,
       source_price  NUMERIC(10,2),
       total_cost    NUMERIC(10,2),
       total_profit  NUMERIC(10,2),
       enriched_at   TIMESTAMPTZ DEFAULT NOW(),
       UNIQUE(account_id, order_id, sku)
     )`,
    `CREATE INDEX IF NOT EXISTS idx_ooi_order  ON onbuy_order_items(order_id)`,
    `CREATE INDEX IF NOT EXISTS idx_ooi_account ON onbuy_order_items(account_id)`,
    `CREATE TABLE IF NOT EXISTS restricted_brands (
   user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
   brand_name TEXT    NOT NULL,
   uploaded_at TIMESTAMPTZ DEFAULT NOW(),
   PRIMARY KEY (user_id, brand_name)
)`,
    `CREATE TABLE IF NOT EXISTS onbuy_delete_brand_jobs (
       id               SERIAL PRIMARY KEY,
       user_id          INTEGER NOT NULL,
       status           TEXT NOT NULL DEFAULT 'running',
       brands_count     INTEGER DEFAULT 0,
       opcs_found       INTEGER DEFAULT 0,
       listings_scanned INTEGER DEFAULT 0,
       listings_deleted INTEGER DEFAULT 0,
       created_at       TIMESTAMP DEFAULT NOW(),
       completed_at     TIMESTAMP
     )`,
    `CREATE TABLE IF NOT EXISTS onbuy_delete_brand_job_logs (
       id         SERIAL PRIMARY KEY,
       job_id     INTEGER REFERENCES onbuy_delete_brand_jobs(id) ON DELETE CASCADE,
       user_id    INTEGER NOT NULL,
       message    TEXT NOT NULL,
       level      TEXT NOT NULL DEFAULT 'info',
       created_at TIMESTAMP DEFAULT NOW()
     )`,
    `CREATE INDEX IF NOT EXISTS idx_dbj_user   ON onbuy_delete_brand_jobs(user_id, created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_dbjl_job   ON onbuy_delete_brand_job_logs(job_id, created_at ASC)`,
    // markup_is_explicit: true = ROI was set explicitly in the import sheet; false = defaulted from global setting.
    // Rows default to false so the repricer always uses the user's current default ROI for pre-existing products.
    `ALTER TABLE product_mappings ADD COLUMN IF NOT EXISTS markup_is_explicit BOOLEAN NOT NULL DEFAULT FALSE`,
    // Back-fill: for every non-explicit ROI mapping, store the user's actual current default_roi_percent.
    // This corrects historical rows that were stored with the hardcoded 20% fallback.
    // Safe to run on every restart — only touches non-explicit rows, never overrides user-set values.
    `UPDATE product_mappings pm
     SET markup_value = COALESCE(
       (SELECT value::decimal FROM settings WHERE user_id = pm.user_id AND key = 'default_roi_percent'),
       pm.markup_value
     )
     WHERE pm.markup_type = 'roi' AND pm.markup_is_explicit = false`,
    // Widen varchar columns that may have been created with length caps — OnBuy SKUs can exceed 20 chars
    `ALTER TABLE product_mappings ALTER COLUMN primary_asin TYPE TEXT`,
    `ALTER TABLE product_mappings ALTER COLUMN onbuy_sku    TYPE TEXT`,
  ];
  for (const sql of steps) {
    try {
      await db.query(sql);
    } catch (e) {
      // "already done" errors are fine — log anything unexpected
      if (!e.message.includes('already exists') && !e.message.includes('cannot be cast')) {
        console.warn('[Migration] Warning:', e.message.split('\n')[0]);
      }
    }
  }

  // Create super admin + assign orphaned rows (runs after DDL loop so users table exists)
  try {
    const { rows: admins } = await db.query(
      `SELECT id FROM users WHERE role = 'super_admin' LIMIT 1`
    );
    let adminId;
    if (admins.length === 0) {
      const hash = await bcrypt.hash('Admin@Repricer#2026', 10);
      const { rows: [admin] } = await db.query(
        `INSERT INTO users (username, email, password_hash, role)
         VALUES ('superadmin', 'admin@repricer.local', $1, 'super_admin')
         RETURNING id`,
        [hash]
      );
      adminId = admin.id;
      console.log('[Migration] ✅ Super admin created — username: superadmin  password: Admin@Repricer#2026');
    } else {
      adminId = admins[0].id;
    }
    await db.query(`UPDATE onbuy_accounts   SET user_id = $1 WHERE user_id IS NULL`, [adminId]);
    await db.query(`UPDATE product_mappings SET user_id = $1 WHERE user_id IS NULL`, [adminId]);
    await db.query(`UPDATE settings         SET user_id = $1 WHERE user_id IS NULL`, [adminId]);
    await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS settings_user_key_idx ON settings (key, user_id)`);
  } catch (e) {
    console.warn('[Migration] Super admin setup:', e.message);
  }

  console.log('[Migration] ✅ Schema up to date');
}

// ─────────────────────────────────────────────
// SETTINGS
// ─────────────────────────────────────────────

async function loadSettingsFromDb() {
  try {
    // Load super admin's proxy URL so the server process can show proxy status
    const { rows } = await db.query(`
      SELECT s.key, s.value FROM settings s
      JOIN users u ON u.id = s.user_id AND u.role = 'super_admin'
      WHERE s.key = 'webshare_proxy_api'
      LIMIT 1
    `);
    const proxyUrl = rows[0]?.value;
    if (proxyUrl) setProxyApiUrl(proxyUrl);
    console.log(`[Settings] Proxy: ${proxyUrl ? 'set' : 'not set'}`);
  } catch (e) {
    console.warn('[Settings] Could not load from DB:', e.message);
  }
}

app.get('/api/settings', requireAuth, async (req, res) => {
  try {
    const [{ rows: userRows }, { rows: themeRows }] = await Promise.all([
      db.query('SELECT key, value FROM settings WHERE user_id = $1', [req.effectiveUserId]),
      db.query(`SELECT s.value FROM settings s JOIN users u ON u.id = s.user_id WHERE u.role = 'super_admin' AND s.key = 'app_theme' LIMIT 1`),
    ]);
    const s = Object.fromEntries(userRows.map(r => [r.key, r.value]));
    // app_theme is global — always serve the super admin's value to all users
    if (themeRows[0]) s.app_theme = themeRows[0].value;
    if (s.webshare_proxy_api) setProxyApiUrl(s.webshare_proxy_api);
    res.json({ ...s, _proxy_status: getProxyStatus() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/settings', requireAuth, async (req, res) => {
  const allowed = ['webshare_proxy_api', 'onbuy_fee_percent', 'default_roi_percent', 'min_roi_percent', 'job_interval_minutes', 'job_start_time', 'app_theme'];
  const uid = req.effectiveUserId;
  try {
    // Read current pricing values before saving so we can detect actual changes
    const pricingKeys = ['onbuy_fee_percent', 'default_roi_percent', 'min_roi_percent'];
    const changingPricingKeys = pricingKeys.filter(k => k in req.body);
    let oldPricingValues = {};
    if (changingPricingKeys.length) {
      const { rows: oldRows } = await db.query(
        `SELECT key, value FROM settings WHERE user_id = $1 AND key = ANY($2)`,
        [uid, changingPricingKeys]
      );
      oldPricingValues = Object.fromEntries(oldRows.map(r => [r.key, r.value]));
    }

    for (const key of allowed) {
      if (!(key in req.body)) continue;
      const value = req.body[key] != null && req.body[key] !== '' ? String(req.body[key]) : null;
      if (value) {
        await db.query(
          `INSERT INTO settings (key, value, user_id, updated_at) VALUES ($1, $2, $3, NOW())
           ON CONFLICT (key, user_id) DO UPDATE SET value = $2, updated_at = NOW()`,
          [key, value, uid]
        );
      } else {
        await db.query('DELETE FROM settings WHERE key = $1 AND user_id = $2', [key, uid]);
      }
      if (key === 'webshare_proxy_api') setProxyApiUrl(value);
    }

    // If any pricing-critical setting actually changed value, stamp pricing_settings_updated_at.
    // This timestamp is later compared against daily_sync_stats.last_repriced_at so the next
    // repricer run knows to force-reprice all listings instead of skipping unchanged prices.
    const pricingActuallyChanged = changingPricingKeys.some(k => {
      const newVal = req.body[k] != null && req.body[k] !== '' ? String(req.body[k]) : null;
      return newVal !== (oldPricingValues[k] ?? null);
    });
    if (pricingActuallyChanged) {
      await db.query(
        `INSERT INTO settings (key, value, user_id, updated_at) VALUES ('pricing_settings_updated_at', $1, $2, NOW())
         ON CONFLICT (key, user_id) DO UPDATE SET value = $1, updated_at = NOW()`,
        [new Date().toISOString(), uid]
      );
    }

    const { rows } = await db.query('SELECT key, value FROM settings WHERE user_id = $1', [uid]);
    const s = Object.fromEntries(rows.map(r => [r.key, r.value]));
    // Notify worker process to reload schedules/settings immediately
    redisPub.publish('repricer:settings-updated', '1').catch(() => {});
    res.json({ ...s, _proxy_status: getProxyStatus() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─────────────────────────────────────────────
// ONBUY BULK PRODUCT IMPORT
// ─────────────────────────────────────────────

// Flexible column aliases for the OnBuy bulk template
const BULK_COL_ALIASES = {
  name:            ['product name', 'product_name', 'title', 'name', 'product title'],
  category:        ['category name', 'category', 'cat'],
  brand:           ['brand', 'brand name', 'manufacturer'],
  ean:             ['ean', 'barcode', 'ean/barcode', 'ean / barcode', 'ean / upc', 'gtin'],
  mpn:             ['mpn', 'manufacturer part number', 'part number', 'model number'],
  condition:       ['condition'],
  description:     ['description', 'product description', 'desc'],
  image1:          ['image url 1', 'image url', 'default image', 'default_image', 'image 1', 'image', 'main image'],
  image2:          ['image url 2', 'image 2', 'additional image 1', 'additional images one', 'additional_images_one'],
  image3:          ['image url 3', 'image 3', 'additional image 2', 'additional images two', 'additional_images_two'],
  image4:          ['image url 4', 'image 4', 'additional image 3', 'additional images three', 'additional_images_three'],
  image5:          ['image url 5', 'image 5', 'additional image 4', 'additional images four', 'additional_images_four'],
  image6:          ['image url 6', 'image 6', 'additional image 5', 'additional images five', 'additional_images_five'],
  sku:             ['sku', 'seller sku', 'your sku', 'listing sku'],
  price:           ['price (£)', 'price', 'selling price', 'sale price'],
  stock:           ['stock', 'quantity', 'qty', 'inventory'],
  delivery_weight: ['delivery weight (kg)', 'delivery weight', 'weight (kg)', 'weight'],
  handling_time:   ['handling time', 'handling_time', 'handling time (days)', 'dispatch time', 'dispatch days'],
  colour:          ['colour', 'color', 'colour / variation', 'color / variation', 'variant'],
  summary1:        ['summary_point_one', 'summary point one', 'summary point 1', 'bullet point 1', 'bullet 1', 'feature 1'],
  summary2:        ['summary_point_two', 'summary point two', 'summary point 2', 'bullet point 2', 'bullet 2', 'feature 2'],
  summary3:        ['summary_point_three', 'summary point three', 'summary point 3', 'bullet point 3', 'bullet 3', 'feature 3'],
  summary4:        ['summary_point_four', 'summary point four', 'summary point 4', 'bullet point 4', 'bullet 4', 'feature 4'],
  summary5:        ['summary_point_five', 'summary point five', 'summary point 5', 'bullet point 5', 'bullet 5', 'feature 5'],
};

function findBulkColIdx(headers, aliases) {
  const norm = s => s.toLowerCase().replace(/[^a-z0-9]/g, ' ').replace(/\s+/g, ' ').trim();
  return headers.findIndex(h => aliases.some(a => norm(h) === norm(a) || norm(h).includes(norm(a))));
}

// GET /api/onbuy-bulk/template — download blank import template (columns match zaykan111 export format)
app.get('/api/onbuy-bulk/template', requireAuth, (req, res) => {
  const headers = [
    'SKU', 'Product_Name', 'Description', 'Default_Image', 'Brand', 'Category',
    'Condition', 'EAN / UPC', 'Price', 'Stock', 'Handling_Time', 'Colour',
    'Summary_Point_One', 'Summary_Point_Two', 'Summary_Point_Three',
    'Summary_Point_Four', 'Summary_Point_Five',
    'Additional_images_One', 'Additional_images_Two', 'Additional_images_Three',
    'Additional_images_Four', 'Additional_images_Five',
  ];
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet([
    headers,
    [
      'TPLINK-C320WS-001', 'TP-Link Tapo C320WS Security Camera',
      '5MP pan/tilt Smart Security Camera with Colour Night Vision',
      'https://example.com/tp-link-main.jpg',
      'TP-Link', 'IP Cameras', 'new', '6935364099213',
      '49.99', '5', '2', '',
      'Pan & tilt 360° coverage', '5MP full-colour night vision', 'IP66 weatherproof', '', '',
      'https://example.com/tp-link-2.jpg', 'https://example.com/tp-link-3.jpg', '', '', '',
    ],
    [
      'FOAM-MAT-6PK-001', 'Foam Exercise Floor Mats 6-Pack',
      'Interlocking foam floor mats, pack of 6, ideal for gym or play room',
      'https://example.com/foam-mats.jpg',
      'Generic', 'Exercise Mats', 'new', '',
      '19.99', '10', '3', '',
      'Pack of 6 interlocking tiles', 'Soft EVA foam', 'Easy to clean', '', '',
      '', '', '', '', '',
    ],
  ]);
  ws['!cols'] = [
    { wch: 22 }, // SKU
    { wch: 45 }, // Product_Name
    { wch: 60 }, // Description
    { wch: 50 }, // Default_Image
    { wch: 18 }, // Brand
    { wch: 25 }, // Category
    { wch: 10 }, // Condition
    { wch: 18 }, // EAN / UPC
    { wch: 10 }, // Price
    { wch:  8 }, // Stock
    { wch: 14 }, // Handling_Time
    { wch: 14 }, // Colour
    { wch: 40 }, // Summary_Point_One
    { wch: 40 }, // Summary_Point_Two
    { wch: 40 }, // Summary_Point_Three
    { wch: 40 }, // Summary_Point_Four
    { wch: 40 }, // Summary_Point_Five
    { wch: 50 }, // Additional_images_One
    { wch: 50 }, // Additional_images_Two
    { wch: 50 }, // Additional_images_Three
    { wch: 50 }, // Additional_images_Four
    { wch: 50 }, // Additional_images_Five
  ];
  XLSX.utils.book_append_sheet(wb, ws, 'OnBuy Products');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="onbuy-bulk-template.xlsx"');
  res.send(buf);
});

// GET /api/onbuy-bulk/categories/export — download categories sheet (populated by admin upload)
app.get('/api/onbuy-bulk/categories/export', requireAuth, async (req, res) => {
  try {
    const { rows: cats } = await db.query(
      `SELECT category_id, name, tree FROM onbuy_categories ORDER BY tree ASC, name ASC`
    );
    if (!cats.length) {
      return res.status(400).json({ error: 'No categories found. Please ask the admin to upload the OnBuy categories file in Settings.' });
    }
    const wsData = [['ID', 'Category']];
    for (const c of cats) {
      const fullPath = c.tree ? `${c.tree} > ${c.name}` : c.name;
      wsData.push([c.category_id, fullPath]);
    }
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet(wsData);
    ws['!cols'] = [{ wch: 10 }, { wch: 100 }];
    XLSX.utils.book_append_sheet(wb, ws, 'OnBuy Categories');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="onbuy-categories.xlsx"');
    res.send(buf);
  } catch (e) {
    console.error('[Categories export]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/settings/categories/count — return total categories in DB
app.get('/api/settings/categories/count', requireAuth, async (req, res) => {
  try {
    const { rows: [{ count }] } = await db.query(`SELECT COUNT(*) AS count FROM onbuy_categories`);
    res.json({ count: parseInt(count) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/settings/categories/upload — super-admin uploads OnBuy categories CSV/XLSX
app.post('/api/settings/categories/upload', requireAuth, requireAdmin, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  try {
    const wb   = XLSX.read(req.file.buffer, { type: 'buffer' });
    const ws   = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });

    // Find header row (contains "ID" and "Category")
    let headerIdx = 0;
    for (let i = 0; i < Math.min(rows.length, 5); i++) {
      const r = rows[i].map(c => String(c).toLowerCase().trim());
      if (r.some(c => c === 'id') && r.some(c => c.includes('category'))) { headerIdx = i; break; }
    }
    const header   = rows[headerIdx].map(c => String(c).toLowerCase().trim());
    const idCol    = header.findIndex(h => h === 'id');
    const catCol   = header.findIndex(h => h.includes('category'));
    if (idCol === -1 || catCol === -1) return res.status(400).json({ error: 'File must have "ID" and "Category" columns' });

    const dataRows = rows.slice(headerIdx + 1).filter(r => r[idCol] !== '' && r[catCol] !== '');

    const vals = [], params = [];
    let p = 1;
    for (const row of dataRows) {
      const catId    = parseInt(row[idCol]);
      const fullPath = String(row[catCol]).trim();
      if (!catId || !fullPath) continue;
      const parts = fullPath.split('>').map(s => s.trim());
      const name  = parts[parts.length - 1];
      const tree  = parts.length > 1 ? parts.slice(0, -1).join(' > ') : '';
      const level = parts.length;
      vals.push(`($${p++},$${p++},$${p++},$${p++},NOW())`);
      params.push(catId, name, tree, level);
    }

    if (!vals.length) return res.status(400).json({ error: 'No valid category rows found in file' });

    await db.query(`TRUNCATE TABLE onbuy_categories`);
    await db.query(
      `INSERT INTO onbuy_categories (category_id, name, tree, level, synced_at)
       VALUES ${vals.join(',')}
       ON CONFLICT (category_id) DO UPDATE SET name=EXCLUDED.name, tree=EXCLUDED.tree, level=EXCLUDED.level, synced_at=NOW()`,
      params
    );

    console.log(`[Categories] Admin uploaded ${vals.length} categories`);
    res.json({ count: vals.length });
  } catch (e) {
    console.error('[Categories upload]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/onbuy-bulk/preview — parse uploaded Excel, validate and return rows
app.post('/api/onbuy-bulk/preview', requireAuth, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  try {
    const wb = XLSX.read(req.file.buffer, { type: 'buffer' });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const allRows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
    if (allRows.length < 2) return res.json({ total: 0, valid: 0, rows: [], headers: [] });

    const headers = allRows[0].map(h => String(h || '').trim());
    const dataRows = allRows.slice(1);

    const IMPORT_LIMIT = 15_000;
    const nonBlankCount = dataRows.filter(row => row.some(v => String(v).trim())).length;
    if (nonBlankCount > IMPORT_LIMIT)
      return res.status(400).json({ error: `File contains ${nonBlankCount.toLocaleString()} rows. Maximum allowed per import is ${IMPORT_LIMIT.toLocaleString()}. Please split the file into smaller batches.` });

    const idx = {};
    for (const [key, aliases] of Object.entries(BULK_COL_ALIASES)) {
      idx[key] = findBulkColIdx(headers, aliases);
    }

    // Load restricted brands for this user (async, but preview is already async-capable via db)
    let restrictedBrands = new Set();
    try {
      const { rows: rb } = await db.query(
        'SELECT brand_name FROM restricted_brands WHERE user_id = $1',
        [req.effectiveUserId]
      );
      restrictedBrands = new Set(rb.map(r => r.brand_name.toLowerCase()));
    } catch {}

    const getCell = (row, key) => {
      const i = idx[key];
      return (i >= 0 && row[i] !== undefined) ? String(row[i]).trim() : '';
    };

    const rows = dataRows.map((row, i) => {
      if (!row.filter(v => String(v).trim()).length) return null;

      const name      = getCell(row, 'name');
      const category  = getCell(row, 'category');
      const brand     = getCell(row, 'brand');
      const ean       = getCell(row, 'ean');
      const mpn       = getCell(row, 'mpn');
      const condition = normalizeCondition(getCell(row, 'condition'));
      const desc      = getCell(row, 'description');
      const img1      = getCell(row, 'image1');
      const img2      = getCell(row, 'image2');
      const img3      = getCell(row, 'image3');
      const img4      = getCell(row, 'image4');
      const img5      = getCell(row, 'image5');
      const img6      = getCell(row, 'image6');
      const sku       = getCell(row, 'sku');
      const price     = parseFloat(getCell(row, 'price').replace(/[£,]/g, '')) || null;
      const stock     = parseInt(getCell(row, 'stock')) || 0;
      const delivery_weight = parseFloat(getCell(row, 'delivery_weight')) || null;
      const handling_time   = getCell(row, 'handling_time');
      const colour          = getCell(row, 'colour');
      const summary1        = getCell(row, 'summary1');
      const summary2        = getCell(row, 'summary2');
      const summary3        = getCell(row, 'summary3');
      const summary4        = getCell(row, 'summary4');
      const summary5        = getCell(row, 'summary5');

      const errors = [];
      if (!name)     errors.push('Product Name required');
      if (!category) errors.push('Category Name required');
      if (!price)    errors.push('Price (£) required');
      if (!sku)      errors.push('SKU required');
      if (!stock)    errors.push('Stock must be > 0');
      if (brand && restrictedBrands.has(brand.toLowerCase())) errors.push(`Brand "${brand}" is restricted`);

      // images stored positionally (no filter) so export slots stay aligned
      const images = [img1, img2, img3, img4, img5, img6];
      return {
        _row: i + 2, valid: errors.length === 0, errors,
        name, category, brand, ean, mpn, condition, description: desc,
        images,
        sku, price, stock, delivery_weight,
        handling_time, colour, summary1, summary2, summary3, summary4, summary5,
      };
    }).filter(Boolean);

    res.json({ total: rows.length, valid: rows.filter(r => r.valid).length, rows, headers });
  } catch (err) {
    console.error('[OnBuy Bulk] Parse error:', err);
    res.status(400).json({ error: `Failed to parse file: ${err.message}` });
  }
});

const ONBUY_CONDITIONS = new Set(['new', 'used', 'good', 'fair', 'poor', 'refurbished', 'atypical']);
function normalizeCondition(val) {
  const s = String(val ?? '').toLowerCase().trim();
  return ONBUY_CONDITIONS.has(s) ? s : 'new';
}

// OnBuy enforces a 150-byte UTF-8 limit on product names.
// JS string.slice(0,150) counts chars, not bytes — multi-byte chars (e.g. –, ©, é)
// cause overflow. This truncates by byte count, never splitting a multi-byte sequence.
function truncateToBytes(str, maxBytes) {
  if (Buffer.byteLength(str, 'utf8') <= maxBytes) return str;
  let bytes = 0, i = 0;
  while (i < str.length) {
    const charBytes = Buffer.byteLength(str[i], 'utf8');
    if (bytes + charBytes > maxBytes) break;
    bytes += charBytes;
    i++;
  }
  return str.slice(0, i);
}

// POST /api/onbuy-bulk/import — enqueue bulk import job, respond immediately
app.post('/api/onbuy-bulk/import', requireAuth, async (req, res) => {
  const { rows, account_id } = req.body;
  if (!Array.isArray(rows) || rows.length === 0)
    return res.status(400).json({ error: 'No rows provided' });
  if (!account_id)
    return res.status(400).json({ error: 'OnBuy account required' });

  // Guard: categories must be uploaded before imports can run
  const { rows: [{ cat_count }] } = await db.query(`SELECT COUNT(*) AS cat_count FROM onbuy_categories`);
  if (parseInt(cat_count) === 0)
    return res.status(400).json({ error: 'OnBuy categories not found. Please ask the admin to upload the categories file in Settings before importing.' });

  // Guard: block import if a delete-brands job is running for this user
  const { rows: runningDeleteJobs } = await db.query(
    `SELECT id FROM onbuy_delete_brand_jobs WHERE user_id = $1 AND status = 'running' LIMIT 1`,
    [req.effectiveUserId]
  );
  if (runningDeleteJobs.length) {
    return res.status(409).json({ error: 'A Delete Restricted Brands job is currently running. Please wait for it to complete before starting a new import.' });
  }

  const account = await getImportAccount(account_id);
  if (!account) return res.status(400).json({ error: 'Account not found or inactive' });

  // Quick token check to catch bad credentials before queuing
  const token = await getOnBuyTokenForAccount(account);
  if (!token) return res.status(400).json({ error: 'Failed to get OnBuy token — check API credentials' });

  const validRows = rows.filter(r => r.valid);

  // Save rows to session so the worker can read them without a large Redis payload
  const { rows: [session] } = await db.query(
    `INSERT INTO onbuy_bulk_import_sessions (user_id, account_id, account_name, total_rows, status, rows_data)
     VALUES ($1, $2, $3, $4, 'processing', $5) RETURNING id`,
    [req.effectiveUserId, account_id, account.account_name, validRows.length, JSON.stringify(validRows)]
  );
  const sessionId = session.id;

  // Enqueue — the bulk-import worker in repricerJob.js runs all phases
  await bulkImportQueue.add('import', { sessionId, accountId: account_id, userId: req.effectiveUserId }, {
    jobId:            `bulk-import-${sessionId}`,
    removeOnComplete: true,
    removeOnFail:     true,
    attempts:         1,
  });

  res.json({ sessionId, status: 'processing', total_rows: validRows.length });
  // All import phases run in the bulk-import BullMQ worker (repricerJob.js)
});

// POST /api/onbuy-bulk/sessions/:sessionId/cancel — cancel pending queues for a session
app.post('/api/onbuy-bulk/sessions/:sessionId/cancel', requireAuth, async (req, res) => {
  try {
    const sid = parseInt(req.params.sessionId);
    const uid = req.effectiveUserId;

    // Verify session belongs to this user
    const { rows: [sess] } = await db.query(
      `SELECT id FROM onbuy_bulk_import_sessions WHERE id=$1 AND user_id=$2`,
      [sid, uid]
    );
    if (!sess) return res.status(404).json({ error: 'Session not found' });

    // Delete pending queues — queue poller will simply not find them on next run
    const { rowCount } = await db.query(
      `DELETE FROM onbuy_bulk_pending_queues WHERE session_id=$1 AND user_id=$2 AND status='pending'`,
      [sid, uid]
    );

    // Mark session cancelled
    await db.query(
      `UPDATE onbuy_bulk_import_sessions SET status='cancelled', pending_queues=0, completed_at=NOW() WHERE id=$1`,
      [sid]
    );

    res.json({ cancelled: rowCount });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/onbuy-bulk/cancel-all-pending — cancel all pending queues across all sessions for the user
app.post('/api/onbuy-bulk/cancel-all-pending', requireAuth, async (req, res) => {
  try {
    const uid = req.effectiveUserId;

    const { rowCount } = await db.query(
      `DELETE FROM onbuy_bulk_pending_queues WHERE user_id=$1 AND status='pending'`,
      [uid]
    );

    // Mark every non-completed session that still has pending_queues as cancelled
    await db.query(
      `UPDATE onbuy_bulk_import_sessions
          SET status='cancelled', pending_queues=0, completed_at=NOW()
        WHERE user_id=$1 AND status NOT IN ('completed','failed','cancelled') OR
              (user_id=$1 AND pending_queues > 0 AND status='completed')`,
      [uid]
    );

    res.json({ cancelled: rowCount });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/onbuy-bulk/sessions/:sessionId — live status for a background import
app.get('/api/onbuy-bulk/sessions/:sessionId', requireAuth, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT s.id, s.account_name, s.total_rows, s.status, s.created_at, s.completed_at, s.rate_limit_until,
              COALESCE(ic.products_created, 0)  AS products_created,
              COALESCE(ic.listings_created, 0)  AS listings_created,
              COALESCE(ic.listings_updated, 0)  AS listings_updated,
              COALESCE(ic.errors_count, 0)       AS errors_count,
              COALESCE(ic.errors_count, 0)       AS skipped,
              COALESCE(pq.pending_count, 0)      AS pending_queues
       FROM onbuy_bulk_import_sessions s
       LEFT JOIN (
         SELECT session_id,
           COUNT(*) FILTER (WHERE status = 'product_created')  AS products_created,
           COUNT(*) FILTER (WHERE status = 'listing_created')  AS listings_created,
           COUNT(*) FILTER (WHERE status = 'listing_updated')  AS listings_updated,
           COUNT(*) FILTER (WHERE status = 'error')            AS errors_count
         FROM onbuy_bulk_import_items
         WHERE session_id = $1
         GROUP BY session_id
       ) ic ON ic.session_id = s.id
       LEFT JOIN (
         SELECT session_id, COUNT(*) AS pending_count
         FROM onbuy_bulk_pending_queues
         WHERE status = 'pending'
         GROUP BY session_id
       ) pq ON pq.session_id = s.id
       WHERE s.id = $1 AND s.user_id = $2`,
      [req.params.sessionId, req.effectiveUserId]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Session not found' });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/onbuy-bulk/active-session — most recent processing session for this user (used to restore UI on reload)
app.get('/api/onbuy-bulk/active-session', requireAuth, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT s.id, s.account_name, s.total_rows, s.status, s.created_at,
              COALESCE(ic.products_created, 0)  AS products_created,
              COALESCE(ic.listings_created, 0)  AS listings_created,
              COALESCE(ic.listings_updated, 0)  AS listings_updated,
              COALESCE(ic.errors_count, 0)       AS errors_count,
              COALESCE(ic.errors_count, 0)       AS skipped,
              COALESCE(pq.pending_count, 0)      AS pending_queues
       FROM onbuy_bulk_import_sessions s
       LEFT JOIN (
         SELECT session_id,
           COUNT(*) FILTER (WHERE status = 'product_created')  AS products_created,
           COUNT(*) FILTER (WHERE status = 'listing_created')  AS listings_created,
           COUNT(*) FILTER (WHERE status = 'listing_updated')  AS listings_updated,
           COUNT(*) FILTER (WHERE status = 'error')            AS errors_count
         FROM onbuy_bulk_import_items
         WHERE session_id IN (
           SELECT id FROM onbuy_bulk_import_sessions
           WHERE user_id = $1 AND status = 'processing'
           ORDER BY created_at DESC LIMIT 1
         )
         GROUP BY session_id
       ) ic ON ic.session_id = s.id
       LEFT JOIN (
         SELECT session_id, COUNT(*) AS pending_count
         FROM onbuy_bulk_pending_queues
         WHERE status = 'pending'
         GROUP BY session_id
       ) pq ON pq.session_id = s.id
       WHERE s.user_id = $1 AND s.status = 'processing'
       ORDER BY s.created_at DESC
       LIMIT 1`,
      [req.effectiveUserId]
    );
    res.json(rows[0] || null);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/onbuy-bulk/history — import sessions for the current user
app.get('/api/onbuy-bulk/history', requireAuth, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT s.id, s.account_name, s.total_rows, s.status, s.created_at, s.completed_at,
              COALESCE(ic.products_created, 0)  AS products_created,
              COALESCE(ic.listings_created, 0)  AS listings_created,
              COALESCE(ic.listings_updated, 0)  AS listings_updated,
              COALESCE(ic.errors_count, 0)       AS errors_count,
              COALESCE(ic.errors_count, 0)       AS skipped,
              COALESCE(pq.pending_count, 0)      AS pending_queues
       FROM onbuy_bulk_import_sessions s
       LEFT JOIN (
         SELECT session_id,
           COUNT(*) FILTER (WHERE status = 'product_created')  AS products_created,
           COUNT(*) FILTER (WHERE status = 'listing_created')  AS listings_created,
           COUNT(*) FILTER (WHERE status = 'listing_updated')  AS listings_updated,
           COUNT(*) FILTER (WHERE status = 'error')            AS errors_count
         FROM onbuy_bulk_import_items
         WHERE user_id = $1
         GROUP BY session_id
       ) ic ON ic.session_id = s.id
       LEFT JOIN (
         SELECT session_id, COUNT(*) AS pending_count
         FROM onbuy_bulk_pending_queues
         WHERE user_id = $1 AND status = 'pending'
         GROUP BY session_id
       ) pq ON pq.session_id = s.id
       WHERE s.user_id = $1
       ORDER BY s.created_at DESC
       LIMIT 50`,
      [req.effectiveUserId]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/onbuy-bulk/history/:sessionId/export — download session items as XLSX (zaykan111 format)
app.get('/api/onbuy-bulk/history/:sessionId/export', requireAuth, async (req, res) => {
  try {
    const type = req.query.type || 'all'; // 'all' | 'success' | 'failed'
    const sid  = req.params.sessionId;
    const uid  = req.effectiveUserId;

    let whereStatus = '';
    if (type === 'success') whereStatus = `AND status IN ('listing_created','listing_updated','product_created')`;
    if (type === 'failed')  whereStatus = `AND status = 'error'`;

    // Load items + session rows_data (original import data) in parallel
    const [itemsResult, sessResult] = await Promise.all([
      db.query(
        `SELECT row_number, product_name, sku, ean, brand, category,
                selling_price, stock, condition, opc, status, error_message
         FROM onbuy_bulk_import_items
         WHERE session_id = $1 AND user_id = $2 ${whereStatus}
         ORDER BY row_number ASC`,
        [sid, uid]
      ),
      db.query(
        `SELECT rows_data FROM onbuy_bulk_import_sessions WHERE id=$1 AND user_id=$2`,
        [sid, uid]
      ),
    ]);

    const items    = itemsResult.rows;
    const rowsData = sessResult.rows[0]?.rows_data ?? [];

    // Build lookup: _row number → original row object
    const rowMap = new Map();
    for (const r of rowsData) rowMap.set(r._row, r);

    // Column headers matching zaykan111 import template exactly
    const headers = [
      'SKU', 'Product_Name', 'Description', 'Default_Image', 'Brand', 'Category',
      'Condition', 'EAN / UPC', 'Price', 'Stock', 'Handling_Time', 'Colour',
      'Summary_Point_One', 'Summary_Point_Two', 'Summary_Point_Three',
      'Summary_Point_Four', 'Summary_Point_Five',
      'Additional_images_One', 'Additional_images_Two', 'Additional_images_Three',
      'Additional_images_Four', 'Additional_images_Five',
      // Diagnostic columns
      'OPC', 'Status', 'Error',
    ];

    const sheetData = [
      headers,
      ...items.map(item => {
        const orig = rowMap.get(item.row_number) || {};
        const imgs = Array.isArray(orig.images) ? orig.images : [];
        return [
          item.sku          || orig.sku          || '',   // SKU
          item.product_name || orig.name         || '',   // Product_Name
          orig.description  || '',                        // Description
          imgs[0]           || '',                        // Default_Image
          item.brand        || orig.brand        || '',   // Brand
          item.category     || orig.category     || '',   // Category
          item.condition    || orig.condition    || '',   // Condition
          item.ean          || orig.ean          || '',   // EAN / UPC
          orig.price        != null ? parseFloat(orig.price)        : (item.selling_price != null ? parseFloat(item.selling_price) : ''), // Price
          orig.stock        != null ? parseInt(orig.stock)          : (item.stock         != null ? parseInt(item.stock)           : ''), // Stock
          orig.handling_time || '',                       // Handling_Time
          orig.colour        || '',                       // Colour
          orig.summary1      || '',                       // Summary_Point_One
          orig.summary2      || '',                       // Summary_Point_Two
          orig.summary3      || '',                       // Summary_Point_Three
          orig.summary4      || '',                       // Summary_Point_Four
          orig.summary5      || '',                       // Summary_Point_Five
          imgs[1]            || '',                       // Additional_images_One
          imgs[2]            || '',                       // Additional_images_Two
          imgs[3]            || '',                       // Additional_images_Three
          imgs[4]            || '',                       // Additional_images_Four
          imgs[5]            || '',                       // Additional_images_Five
          item.opc           || '',                       // OPC
          item.status        || '',                       // Status
          item.error_message || '',                       // Error
        ];
      }),
    ];

    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet(sheetData);
    ws['!cols'] = [
      { wch: 22 }, // SKU
      { wch: 40 }, // Product_Name
      { wch: 55 }, // Description
      { wch: 45 }, // Default_Image
      { wch: 16 }, // Brand
      { wch: 30 }, // Category
      { wch: 10 }, // Condition
      { wch: 18 }, // EAN / UPC
      { wch: 10 }, // Price
      { wch:  8 }, // Stock
      { wch: 14 }, // Handling_Time
      { wch: 14 }, // Colour
      { wch: 40 }, // Summary_Point_One
      { wch: 40 }, // Summary_Point_Two
      { wch: 40 }, // Summary_Point_Three
      { wch: 40 }, // Summary_Point_Four
      { wch: 40 }, // Summary_Point_Five
      { wch: 45 }, // Additional_images_One
      { wch: 45 }, // Additional_images_Two
      { wch: 45 }, // Additional_images_Three
      { wch: 45 }, // Additional_images_Four
      { wch: 45 }, // Additional_images_Five
      { wch: 14 }, // OPC
      { wch: 16 }, // Status
      { wch: 45 }, // Error
    ];

    XLSX.utils.book_append_sheet(wb, ws, 'OnBuy Products');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

    const filename = `bulk-export-${sid}-${type}.xlsx`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(buf);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/onbuy-bulk/history/:sessionId/items — rows for a specific import session (paginated)
app.get('/api/onbuy-bulk/history/:sessionId/items', requireAuth, async (req, res) => {
  try {
    const PAGE_SIZE = 100;
    const page   = Math.max(1, parseInt(req.query.page)  || 1);
    const search = (req.query.search || '').trim();

    const params = [req.params.sessionId, req.effectiveUserId];
    let whereExtra = '';
    if (search) {
      params.push(`%${search}%`);
      const n = params.length;
      whereExtra = ` AND (product_name ILIKE $${n} OR sku ILIKE $${n} OR ean ILIKE $${n}
                       OR brand ILIKE $${n} OR category ILIKE $${n} OR opc ILIKE $${n}
                       OR status ILIKE $${n} OR error_message ILIKE $${n})`;
    }

    const { rows: [{ count }] } = await db.query(
      `SELECT COUNT(*) FROM onbuy_bulk_import_items WHERE session_id=$1 AND user_id=$2${whereExtra}`,
      params
    );
    const total = parseInt(count);
    const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    const safePage = Math.min(page, totalPages);

    const { rows } = await db.query(
      `SELECT row_number, product_name, sku, ean, brand, category,
              source_price, selling_price, stock, condition, opc, status, error_message, created_at
       FROM onbuy_bulk_import_items
       WHERE session_id = $1 AND user_id = $2${whereExtra}
       ORDER BY row_number ASC
       LIMIT ${PAGE_SIZE} OFFSET ${(safePage - 1) * PAGE_SIZE}`,
      params
    );
    res.json({ items: rows, total, page: safePage, totalPages });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/onbuy-bulk/pending-queue-status — global pending queue counts for the user
app.get('/api/onbuy-bulk/pending-queue-status', requireAuth, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT
         COUNT(*) FILTER (WHERE status = 'pending')         AS pending,
         COUNT(*) FILTER (WHERE status = 'success')         AS success,
         COUNT(*) FILTER (WHERE status = 'listing_created') AS listing_created,
         COUNT(*) FILTER (WHERE status = 'failed')          AS failed,
         COUNT(*)                                           AS total
       FROM onbuy_bulk_pending_queues
       WHERE user_id = $1`,
      [req.effectiveUserId]
    );
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/onbuy-bulk/pending-queue-status/:sessionId — pending queue counts for one session
app.get('/api/onbuy-bulk/pending-queue-status/:sessionId', requireAuth, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT
         COUNT(*) FILTER (WHERE status = 'pending')         AS pending,
         COUNT(*) FILTER (WHERE status = 'success')         AS success,
         COUNT(*) FILTER (WHERE status = 'listing_created') AS listing_created,
         COUNT(*) FILTER (WHERE status = 'failed')          AS failed,
         COUNT(*)                                           AS total
       FROM onbuy_bulk_pending_queues
       WHERE user_id = $1 AND session_id = $2`,
      [req.effectiveUserId, req.params.sessionId]
    );
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─────────────────────────────────────────────
// SKU CHANGE
// ─────────────────────────────────────────────

// GET /api/sku-change/template
app.get('/api/sku-change/template', requireAuth, (req, res) => {
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet([
    ['Seller SKU', 'New SKU'],
    ['OLD-SKU-001', 'NEW-SKU-001'],
    ['OLD-SKU-002', 'NEW-SKU-002'],
  ]);
  ws['!cols'] = [{ wch: 30 }, { wch: 30 }];
  XLSX.utils.book_append_sheet(wb, ws, 'SKU Change');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="sku-change-template.xlsx"');
  res.send(buf);
});

// POST /api/sku-change/preview — parse uploaded Excel, return rows for review
app.post('/api/sku-change/preview', requireAuth, upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  try {
    const wb = XLSX.read(req.file.buffer, { type: 'buffer' });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const allRows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
    if (allRows.length < 2) return res.json({ total: 0, rows: [], errors: [] });

    const headerRow = allRows[0].map(h => normalizeKey(String(h || '')));

    const sellerSkuAliases = ['seller_sku', 'sellersku', 'current_sku', 'old_sku', 'sku'];
    const newSkuAliases    = ['new_sku', 'newsku', 'updated_sku'];

    const sellerSkuIdx = headerRow.findIndex(h => sellerSkuAliases.includes(h));
    const newSkuIdx    = headerRow.findIndex(h => newSkuAliases.includes(h));

    if (sellerSkuIdx === -1) return res.status(400).json({ error: 'Could not find "Seller SKU" column' });
    if (newSkuIdx === -1)    return res.status(400).json({ error: 'Could not find "New SKU" column' });

    const rows = [];
    const errors = [];
    allRows.slice(1).forEach((row, i) => {
      const sellerSku = String(row[sellerSkuIdx] || '').trim();
      const newSku    = String(row[newSkuIdx]    || '').trim();
      if (!sellerSku && !newSku) return;
      if (!sellerSku) { errors.push({ row: i + 2, error: 'Missing Seller SKU' }); return; }
      if (!newSku)    { errors.push({ row: i + 2, error: 'Missing New SKU' }); return; }
      if (sellerSku === newSku) { errors.push({ row: i + 2, sellerSku, newSku, error: 'New SKU is same as current' }); return; }
      rows.push({ sellerSku, newSku });
    });

    res.json({ total: rows.length, rows, errors });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/sku-change/apply — update OnBuy SKUs in batches of 1000
app.post('/api/sku-change/apply', requireAuth, async (req, res) => {
  const { rows, onbuy_account_id } = req.body;
  console.log(`[SKU Change] apply called — rows:${rows?.length} account:${onbuy_account_id}`);
  if (!Array.isArray(rows) || rows.length === 0) return res.status(400).json({ error: 'No rows provided' });

  const userId  = req.effectiveUserId;
  const results = { updated: 0, skipped: 0, errors: [] };

  try {
    const account = await getImportAccount(onbuy_account_id);
    if (!account) return res.status(400).json({ error: 'OnBuy account not found or inactive' });

    const token = await getOnBuyTokenForAccount(account);
    if (!token)  return res.status(400).json({ error: 'Failed to get OnBuy auth token' });
    const siteId = account.site_id || 2000;

    // Step 1: Fetch listing UIDs from OnBuy in batches of 1000 by current SKU
    const allSkus  = [...new Set(rows.map(r => r.sellerSku))];
    const uidBySku = new Map();
    const BATCH    = 1000;

    for (let i = 0; i < allSkus.length; i += BATCH) {
      const batch    = allSkus.slice(i, i + BATCH);
      const listings = await fetchOnBuyListingsBySkus(token, siteId, batch);
      console.log(`[SKU Change] GET /v2/listings returned ${Array.isArray(listings) ? listings.length : 'null'} listings`);
      if (Array.isArray(listings) && listings.length > 0) {
        console.log('[SKU Change] First listing sample:', JSON.stringify(listings[0]).slice(0, 300));
      }
      if (Array.isArray(listings)) {
        for (const listing of listings) {
          const listingUid = listing.uid || listing.listing_uid || listing.id || listing.product_listing_id;
          const listingSku = listing.sku || listing.seller_sku;
          if (listingUid && listingSku) uidBySku.set(String(listingSku), String(listingUid));
        }
      }
    }
    console.log(`[SKU Change] UID map size: ${uidBySku.size}`);

    // Step 2: Batch PUT /v2/listings by UID to change the SKU
    for (let i = 0; i < rows.length; i += BATCH) {
      const chunk = rows.slice(i, i + BATCH);

      // Separate rows with a resolved UID from those without
      const withUid    = [];
      const withoutUid = [];
      for (const r of chunk) {
        const uid = uidBySku.get(r.sellerSku);
        if (uid) withUid.push({ uid, sellerSku: r.sellerSku, newSku: r.newSku });
        else     withoutUid.push(r);
      }

      for (const r of withoutUid) {
        results.skipped++;
        results.errors.push({ sellerSku: r.sellerSku, error: 'Listing not found on OnBuy' });
      }

      if (withUid.length === 0) continue;

      let data;
      try {
        const resp = await fetch(`https://api.onbuy.com/v2/listings?site_id=${siteId}`, {
          method:  'PUT',
          headers: { Authorization: token, 'Content-Type': 'application/json' },
          body:    JSON.stringify({ listings: withUid.map(r => ({ uid: r.uid, sku: r.newSku })) }),
        });
        const raw = await resp.text();
        console.log(`[SKU Change] PUT /v2/listings status:${resp.status} body:${raw.slice(0, 500)}`);
        try { data = JSON.parse(raw); } catch { data = null; }

        if (!resp.ok) {
          const rawMsg = data?.message || data?.error || raw.slice(0, 200);
          const msg = typeof rawMsg === 'string' ? rawMsg : JSON.stringify(rawMsg);
          withUid.forEach(r => results.errors.push({ sellerSku: r.sellerSku, error: msg }));
          results.skipped += withUid.length;
          continue;
        }
      } catch (err) {
        withUid.forEach(r => results.errors.push({ sellerSku: r.sellerSku, error: String(err.message) }));
        results.skipped += withUid.length;
        continue;
      }

      // Check per-item success flags
      const resultItems = Array.isArray(data?.results) ? data.results
                        : Array.isArray(data?.payload)  ? data.payload
                        : Array.isArray(data)            ? data
                        : null;

      const failedUids = new Set();
      if (resultItems) {
        resultItems.forEach((item, idx) => {
          if (item?.success === false) {
            failedUids.add(withUid[idx]?.uid);
            const rawErr = item.message || 'Rejected by OnBuy';
            results.errors.push({ sellerSku: withUid[idx]?.sellerSku, error: typeof rawErr === 'string' ? rawErr : JSON.stringify(rawErr) });
            results.skipped++;
          }
        });
      }

      // Update DB for successful rows
      const successful = withUid.filter(r => !failedUids.has(r.uid));
      if (successful.length > 0) {
        await db.query(
          `UPDATE product_mappings SET onbuy_sku = v.new_sku, updated_at = NOW()
           FROM unnest($1::text[], $2::text[]) AS v(old_sku, new_sku)
           WHERE product_mappings.onbuy_sku = v.old_sku AND product_mappings.user_id = $3`,
          [successful.map(r => r.sellerSku), successful.map(r => r.newSku), userId]
        );
        results.updated += successful.length;
      }
    }

    res.json(results);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/import/logs — import history (scoped to current user; super admin sees all)
app.get('/api/import/logs', requireAuth, async (req, res) => {
  try {
    const isSuperAdmin = req.user.role === 'super_admin' && !req.isImpersonating;
    const { rows } = isSuperAdmin
      ? await db.query(`SELECT * FROM import_logs ORDER BY created_at DESC LIMIT 50`)
      : await db.query(`SELECT * FROM import_logs WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50`, [req.effectiveUserId]);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─────────────────────────────────────────────
// DELETE LISTINGS
// ─────────────────────────────────────────────

// GET /api/delete-listings/template — blank template with Seller SKU column
app.get('/api/delete-listings/template', requireAuth, (req, res) => {
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet([
    ['Seller SKU'],
    ['ABC-123'],
    ['XYZ-456'],
  ]);
  ws['!cols'] = [{ wch: 30 }];
  XLSX.utils.book_append_sheet(wb, ws, 'Delete Listings');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="delete-listings-template.xlsx"');
  res.send(buf);
});

// POST /api/delete-listings/preview — parse uploaded Excel, return SKUs from "Seller SKU" column
app.post('/api/delete-listings/preview', requireAuth, upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  try {
    const wb      = XLSX.read(req.file.buffer, { type: 'buffer' });
    const ws      = wb.Sheets[wb.SheetNames[0]];
    const allRows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
    if (allRows.length < 2) return res.json({ total: 0, rows: [] });

    const headerRow = allRows[0].map(h => String(h || '').trim().toLowerCase());
    const skuColIdx = headerRow.findIndex(h =>
      ['seller sku', 'seller_sku', 'sellersku', 'sku'].includes(h)
    );
    if (skuColIdx === -1) return res.status(400).json({ error: 'Could not find a "Seller SKU" column in the file' });

    const rows = allRows.slice(1)
      .map((row, i) => ({
        _row: i + 2,
        sku:  String(row[skuColIdx] || '').trim(),
        name: String(row[1] || '').trim(),
      }))
      .filter(r => r.sku);

    res.json({ total: rows.length, rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/delete-listings/delete — delete listings in batches of 1000
app.post('/api/delete-listings/delete', requireAuth, async (req, res) => {
  const { skus, onbuy_account_id } = req.body;
  if (!skus?.length)      return res.status(400).json({ error: 'No SKUs provided' });
  if (!onbuy_account_id) return res.status(400).json({ error: 'No account selected' });

  try {
    const { rows: acctRows } = await db.query(
      `SELECT * FROM onbuy_accounts WHERE id = $1 LIMIT 1`,
      [onbuy_account_id]
    );
    if (!acctRows[0]) return res.status(404).json({ error: 'Account not found' });

    const account = acctRows[0];
    const token   = await getTokenForAccount(account);
    if (!token) return res.status(500).json({ error: 'Could not obtain auth token for account' });

    const siteId = parseInt(account.site_id) || 2000;
    const BATCH  = 1000;
    const perSku = {};
    let deleted = 0, notFound = 0, failed = 0;

    for (let i = 0; i < skus.length; i += BATCH) {
      const batch = skus.slice(i, i + BATCH);
      const r     = await fetch('https://api.onbuy.com/v2/listings/by-sku', {
        method:  'DELETE',
        headers: { Authorization: token, 'Content-Type': 'application/json' },
        body:    JSON.stringify({ site_id: siteId, skus: batch }),
      });
      const data        = await r.json();
      const batchResult = data?.results ?? {};
      for (const [sku, outcome] of Object.entries(batchResult)) {
        perSku[sku] = outcome;
        if (outcome.status === 'ok')                deleted++;
        else if (outcome.error === 'SKU not found') notFound++;
        else                                        failed++;
      }
    }

    res.json({ total: skus.length, deleted, notFound, failed, results: perSku });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/delete-listings/oos — set stock=0 for given SKUs in batches of 1000
app.post('/api/delete-listings/oos', requireAuth, async (req, res) => {
  const { skus, onbuy_account_id } = req.body;
  if (!skus?.length)     return res.status(400).json({ error: 'No SKUs provided' });
  if (!onbuy_account_id) return res.status(400).json({ error: 'No account selected' });

  try {
    const { rows: acctRows } = await db.query(
      `SELECT * FROM onbuy_accounts WHERE id = $1 LIMIT 1`,
      [onbuy_account_id]
    );
    if (!acctRows[0]) return res.status(404).json({ error: 'Account not found' });
    const token  = await getTokenForAccount(acctRows[0]);
    if (!token)  return res.status(500).json({ error: 'Could not obtain auth token for account' });
    const siteId = parseInt(acctRows[0].site_id) || 2000;

    let updated = 0, failed = 0;
    for (let i = 0; i < skus.length; i += 1000) {
      const batch    = skus.slice(i, i + 1000);
      const r        = await fetch(`https://api.onbuy.com/v2/listings/by-sku?site_id=${siteId}`, {
        method:  'PUT',
        headers: { Authorization: token, 'Content-Type': 'application/json' },
        body:    JSON.stringify({ listings: batch.map(sku => ({ sku, stock: 0 })) }),
      });
      const data     = await r.json().catch(() => ({}));
      const batchRes = Array.isArray(data.results) ? data.results : [];
      const failCnt  = batchRes.filter(item => item.success === false).length;
      failed  += failCnt;
      updated += batch.length - failCnt;
      if (!batchRes.length) updated += batch.length;
    }
    res.json({ total: skus.length, updated, failed });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/delete-listings/restock — set stock=5 for given SKUs in batches of 1000
app.post('/api/delete-listings/restock', requireAuth, async (req, res) => {
  const { skus, onbuy_account_id } = req.body;
  if (!skus?.length)     return res.status(400).json({ error: 'No SKUs provided' });
  if (!onbuy_account_id) return res.status(400).json({ error: 'No account selected' });

  try {
    const { rows: acctRows } = await db.query(
      `SELECT * FROM onbuy_accounts WHERE id = $1 LIMIT 1`,
      [onbuy_account_id]
    );
    if (!acctRows[0]) return res.status(404).json({ error: 'Account not found' });
    const token  = await getTokenForAccount(acctRows[0]);
    if (!token)  return res.status(500).json({ error: 'Could not obtain auth token for account' });
    const siteId = parseInt(acctRows[0].site_id) || 2000;

    let updated = 0, failed = 0;
    for (let i = 0; i < skus.length; i += 1000) {
      const batch    = skus.slice(i, i + 1000);
      const r        = await fetch(`https://api.onbuy.com/v2/listings/by-sku?site_id=${siteId}`, {
        method:  'PUT',
        headers: { Authorization: token, 'Content-Type': 'application/json' },
        body:    JSON.stringify({ listings: batch.map(sku => ({ sku, stock: 5 })) }),
      });
      const data     = await r.json().catch(() => ({}));
      const batchRes = Array.isArray(data.results) ? data.results : [];
      const failCnt  = batchRes.filter(item => item.success === false).length;
      failed  += failCnt;
      updated += batch.length - failCnt;
      if (!batchRes.length) updated += batch.length;
    }
    res.json({ total: skus.length, updated, failed });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Shared helper: paginate all listing SKUs for an account ──────────────────
async function fetchAllListingSkus(token, siteId, onProgress) {
  const skus = [];
  let offset = 0, totalRows = Infinity;
  while (offset < totalRows) {
    const r = await fetch(
      `https://api.onbuy.com/v2/listings?site_id=${siteId}&limit=1000&offset=${offset}`,
      { headers: { Authorization: token } },
    );
    if (!r.ok) throw new Error(`Listings API HTTP ${r.status}`);
    const data    = await r.json();
    const results = data.results ?? [];
    if (!results.length) break;
    totalRows = data.metadata?.total_rows ?? totalRows;
    for (const l of results) if (l.sku) skus.push(l.sku);
    offset += 1000;
    onProgress(skus.length, totalRows);
  }
  return skus;
}

// POST /api/listings/oos-all — mark every listing OOS (stock=0); streams progress via SSE
app.post('/api/listings/oos-all', requireAuth, async (req, res) => {
  const { onbuy_account_id } = req.body;
  if (!onbuy_account_id) return res.status(400).json({ error: 'No account selected' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  const send = d => res.write(`data: ${JSON.stringify(d)}\n\n`);

  try {
    const { rows } = await db.query(`SELECT * FROM onbuy_accounts WHERE id = $1 LIMIT 1`, [onbuy_account_id]);
    if (!rows[0]) { send({ error: 'Account not found' }); return res.end(); }
    const token  = await getTokenForAccount(rows[0]);
    if (!token)  { send({ error: 'Could not obtain auth token' }); return res.end(); }
    const siteId = parseInt(rows[0].site_id) || 2000;

    send({ phase: 'fetching', fetched: 0, total: null });
    const allSkus = await fetchAllListingSkus(token, siteId, (fetched, total) => {
      send({ phase: 'fetching', fetched, total });
    });

    let updated = 0, failed = 0;
    for (let i = 0; i < allSkus.length; i += 1000) {
      const batch    = allSkus.slice(i, i + 1000);
      const r        = await fetch(`https://api.onbuy.com/v2/listings/by-sku?site_id=${siteId}`, {
        method:  'PUT',
        headers: { Authorization: token, 'Content-Type': 'application/json' },
        body:    JSON.stringify({ listings: batch.map(sku => ({ sku, stock: 0 })) }),
      });
      const data     = await r.json().catch(() => ({}));
      const batchRes = Array.isArray(data.results) ? data.results : [];
      const failCnt  = batchRes.filter(item => item.success === false).length;
      failed  += failCnt;
      updated += batch.length - failCnt;
      if (!batchRes.length) updated += batch.length;
      send({ phase: 'updating', updated, failed, total: allSkus.length });
    }

    send({ phase: 'done', total: allSkus.length, updated, failed });
  } catch (e) {
    send({ error: e.message });
  }
  res.end();
});

// POST /api/listings/restock-all — set stock=5 for every listing; streams progress via SSE
app.post('/api/listings/restock-all', requireAuth, async (req, res) => {
  const { onbuy_account_id } = req.body;
  if (!onbuy_account_id) return res.status(400).json({ error: 'No account selected' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  const send = d => res.write(`data: ${JSON.stringify(d)}\n\n`);

  try {
    const { rows } = await db.query(`SELECT * FROM onbuy_accounts WHERE id = $1 LIMIT 1`, [onbuy_account_id]);
    if (!rows[0]) { send({ error: 'Account not found' }); return res.end(); }
    const token  = await getTokenForAccount(rows[0]);
    if (!token)  { send({ error: 'Could not obtain auth token' }); return res.end(); }
    const siteId = parseInt(rows[0].site_id) || 2000;

    send({ phase: 'fetching', fetched: 0, total: null });
    const allSkus = await fetchAllListingSkus(token, siteId, (fetched, total) => {
      send({ phase: 'fetching', fetched, total });
    });

    let updated = 0, failed = 0;
    for (let i = 0; i < allSkus.length; i += 1000) {
      const batch    = allSkus.slice(i, i + 1000);
      const r        = await fetch(`https://api.onbuy.com/v2/listings/by-sku?site_id=${siteId}`, {
        method:  'PUT',
        headers: { Authorization: token, 'Content-Type': 'application/json' },
        body:    JSON.stringify({ listings: batch.map(sku => ({ sku, stock: 5 })) }),
      });
      const data     = await r.json().catch(() => ({}));
      const batchRes = Array.isArray(data.results) ? data.results : [];
      const failCnt  = batchRes.filter(item => item.success === false).length;
      failed  += failCnt;
      updated += batch.length - failCnt;
      if (!batchRes.length) updated += batch.length;
      send({ phase: 'restocking', updated, failed, total: allSkus.length });
    }

    send({ phase: 'done', total: allSkus.length, updated, failed });
  } catch (e) {
    send({ error: e.message });
  }
  res.end();
});

// POST /api/listings/delete-all — delete every listing; streams progress via SSE
app.post('/api/listings/delete-all', requireAuth, async (req, res) => {
  const { onbuy_account_id } = req.body;
  if (!onbuy_account_id) return res.status(400).json({ error: 'No account selected' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  const send = d => res.write(`data: ${JSON.stringify(d)}\n\n`);

  try {
    const { rows } = await db.query(`SELECT * FROM onbuy_accounts WHERE id = $1 LIMIT 1`, [onbuy_account_id]);
    if (!rows[0]) { send({ error: 'Account not found' }); return res.end(); }
    const token  = await getTokenForAccount(rows[0]);
    if (!token)  { send({ error: 'Could not obtain auth token' }); return res.end(); }
    const siteId = parseInt(rows[0].site_id) || 2000;

    send({ phase: 'fetching', fetched: 0, total: null });
    const allSkus = await fetchAllListingSkus(token, siteId, (fetched, total) => {
      send({ phase: 'fetching', fetched, total });
    });

    let deleted = 0, notFound = 0, failed = 0;
    for (let i = 0; i < allSkus.length; i += 1000) {
      const batch = allSkus.slice(i, i + 1000);
      const r     = await fetch('https://api.onbuy.com/v2/listings/by-sku', {
        method:  'DELETE',
        headers: { Authorization: token, 'Content-Type': 'application/json' },
        body:    JSON.stringify({ site_id: siteId, skus: batch }),
      });
      const data     = await r.json().catch(() => ({}));
      const batchRes = data.results ?? {};
      for (const [, v] of Object.entries(batchRes)) {
        if (v.status === 'ok')                deleted++;
        else if (v.error === 'SKU not found') notFound++;
        else                                  failed++;
      }
      if (!Object.keys(batchRes).length) deleted += batch.length;
      send({ phase: 'deleting', deleted, notFound, failed, total: allSkus.length });
    }

    send({ phase: 'done', total: allSkus.length, deleted, notFound, failed });
  } catch (e) {
    send({ error: e.message });
  }
  res.end();
});

// ── Restricted Brands ────────────────────────────────────────────────────────

// GET /api/restricted-brands/template — download template Excel
app.get('/api/restricted-brands/template', requireAuth, (req, res) => {
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet([['Restricted brands'], ['Example Brand']]);
  XLSX.utils.book_append_sheet(wb, ws, 'Restricted Brands');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="restricted-brands-template.xlsx"');
  res.send(buf);
});

// POST /api/restricted-brands/upload — parse CSV/Excel and store brands
app.post('/api/restricted-brands/upload', requireAuth, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  try {
    const wb = XLSX.read(req.file.buffer, { type: 'buffer' });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
    // Skip header row, collect non-empty brand names
    const brands = rows.slice(1)
      .map(r => String(r[0] || '').trim())
      .filter(Boolean);
    if (!brands.length) return res.status(400).json({ error: 'No brands found in file' });
    const uid = req.effectiveUserId;
    // Replace all brands for this user
    await db.query('DELETE FROM restricted_brands WHERE user_id = $1', [uid]);
    if (brands.length > 0) {
      await db.query(
        `INSERT INTO restricted_brands (user_id, brand_name)
         SELECT $1, unnest($2::text[])
         ON CONFLICT DO NOTHING`,
        [uid, brands]
      );
    }
    res.json({ count: brands.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/restricted-brands — get current user's restricted brands
app.get('/api/restricted-brands', requireAuth, async (req, res) => {
  try {
    const { rows } = await db.query(
      'SELECT brand_name FROM restricted_brands WHERE user_id = $1 ORDER BY brand_name',
      [req.effectiveUserId]
    );
    res.json({ brands: rows.map(r => r.brand_name), count: rows.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/restricted-brands/delete-job — enqueue a background delete-brands job
app.post('/api/restricted-brands/delete-job', requireAuth, async (req, res) => {
  const uid = req.effectiveUserId;

  const { rows: runningImports } = await db.query(
    `SELECT id FROM onbuy_bulk_import_sessions WHERE user_id = $1 AND status = 'processing' LIMIT 1`, [uid]
  );
  if (runningImports.length) return res.status(409).json({ error: 'A bulk import job is currently running. Please wait for it to complete.' });

  const { rows: existingJobs } = await db.query(
    `SELECT id FROM onbuy_delete_brand_jobs WHERE user_id = $1 AND status = 'running' LIMIT 1`, [uid]
  );
  if (existingJobs.length) return res.status(409).json({ error: 'A Delete Restricted Brands job is already running.' });

  const { rows: [{ cnt }] } = await db.query(`SELECT COUNT(*) AS cnt FROM restricted_brands WHERE user_id = $1`, [uid]);
  if (parseInt(cnt) === 0) return res.status(400).json({ error: 'No restricted brands uploaded for your account.' });

  const { rows: [jobRow] } = await db.query(
    `INSERT INTO onbuy_delete_brand_jobs (user_id, status) VALUES ($1, 'running') RETURNING id`, [uid]
  );
  await deleteBrandsQueue.add('delete', { jobId: jobRow.id, userId: uid }, {
    jobId: `delete-brands-${jobRow.id}`, removeOnComplete: true, removeOnFail: true, attempts: 1,
  });
  res.json({ jobId: jobRow.id, status: 'running' });
});

// GET /api/delete-brands/active — most recent job + its logs
app.get('/api/delete-brands/active', requireAuth, async (req, res) => {
  const uid = req.effectiveUserId;
  const { rows: [job] } = await db.query(
    `SELECT * FROM onbuy_delete_brand_jobs WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1`, [uid]
  );
  if (!job) return res.json({ job: null, logs: [] });
  const { rows: logs } = await db.query(
    `SELECT message, level, created_at FROM onbuy_delete_brand_job_logs WHERE job_id = $1 ORDER BY created_at ASC`, [job.id]
  );
  res.json({ job, logs });
});

// POST /api/delete-brands/:jobId/cancel
app.post('/api/delete-brands/:jobId/cancel', requireAuth, async (req, res) => {
  await db.query(
    `UPDATE onbuy_delete_brand_jobs SET status='cancelled', completed_at=NOW() WHERE id=$1 AND user_id=$2`,
    [req.params.jobId, req.effectiveUserId]
  );
  res.json({ ok: true });
});

// ── OnBuy Orders ──────────────────────────────────────────────────────────────

// GET /api/orders — list orders for current user (paginated)
app.get('/api/orders', requireAuth, async (req, res) => {
  const uid    = req.effectiveUserId;
  const limit  = Math.min(parseInt(req.query.limit  ?? 50), 200);
  const offset = parseInt(req.query.offset ?? 0);
  const accountId = req.query.account_id || null;
  const status    = req.query.status     || null;
  const search    = req.query.search     || null;

  try {
    const conditions = ['o.user_id = $1'];
    const params     = [uid];
    let   p          = 2;

    if (accountId) { conditions.push(`o.account_id = $${p++}`); params.push(accountId); }
    if (status)    { conditions.push(`REPLACE(LOWER(o.status), ' ', '_') = $${p++}`); params.push(status.toLowerCase()); }
    if (search)    {
      conditions.push(`(o.order_id ILIKE $${p} OR o.buyer_name ILIKE $${p})`);
      params.push(`%${search}%`); p++;
    }

    const where = conditions.join(' AND ');
    const { rows } = await db.query(
      `SELECT o.id, o.order_id, o.order_date, o.status, o.buyer_name, o.buyer_phone,
              o.price_total, o.currency_code, o.products, o.synced_at,
              a.account_name
       FROM onbuy_orders o
       JOIN onbuy_accounts a ON a.id = o.account_id
       WHERE ${where}
       ORDER BY o.order_date DESC NULLS LAST
       LIMIT $${p++} OFFSET $${p++}`,
      [...params, limit, offset]
    );

    const { rows: [{ total }] } = await db.query(
      `SELECT COUNT(*)::int AS total FROM onbuy_orders o WHERE ${where}`, params
    );

    res.json({ orders: rows, total, limit, offset });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/orders/chart — last-7-day order counts grouped by day and status
app.get('/api/orders/chart', requireAuth, async (req, res) => {
  const uid = req.effectiveUserId;
  try {
    const { rows } = await db.query(
      `SELECT to_char(order_date, 'YYYY-MM-DD') AS day, status, COUNT(*)::int AS count
       FROM onbuy_orders
       WHERE user_id = $1 AND order_date >= NOW() - INTERVAL '7 days'
       GROUP BY day, status
       ORDER BY day`,
      [uid]
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/orders/:id — single order detail
app.get('/api/orders/:id', requireAuth, async (req, res) => {
  const uid = req.effectiveUserId;
  try {
    const { rows } = await db.query(
      `SELECT o.*, a.account_name
       FROM onbuy_orders o
       JOIN onbuy_accounts a ON a.id = o.account_id
       WHERE o.id = $1 AND o.user_id = $2`,
      [req.params.id, uid]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Order not found' });
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/orders/sync — manual trigger (publishes to Redis; orders job process handles it)
app.post('/api/orders/sync', requireAuth, async (req, res) => {
  const uid = req.effectiveUserId;
  try {
    const { rows: accounts } = await db.query(
      `SELECT id FROM onbuy_accounts WHERE user_id = $1 AND is_active = true`, [uid]
    );
    if (!accounts.length) return res.json({ message: 'No active OnBuy accounts found' });
    await redisPub.publish('orders:sync', String(uid));
    res.json({ message: `Sync started for ${accounts.length} account(s)` });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Amazon SP-API ─────────────────────────────────────────────────────────────

// GET /api/sp-api/marketplaces — return supported marketplace list
app.get('/api/sp-api/marketplaces', requireAuth, (req, res) => {
  res.json(Object.entries(MARKETPLACES).map(([code, m]) => ({ code, id: m.id, name: m.name })));
});

// POST /api/sp-api/lookup — fetch catalog data for a list of ASINs
// Body: { clientId, clientSecret, refreshToken, marketplaceCode, asins: [] }
app.post('/api/sp-api/lookup', requireAuth, async (req, res) => {
  const { clientId, clientSecret, refreshToken, marketplaceCode, asins } = req.body;

  if (!clientId || !clientSecret || !refreshToken) return res.status(400).json({ error: 'LWA credentials required (clientId, clientSecret, refreshToken)' });
  if (!asins?.length)                              return res.status(400).json({ error: 'At least one ASIN required' });

  const marketplace = MARKETPLACES[marketplaceCode?.toUpperCase()] ?? MARKETPLACES.UK;

  try {
    const accessToken = await getLwaAccessToken({ clientId, clientSecret, refreshToken });

    const results = await Promise.allSettled(
      asins.map(asin => fetchAsinCatalog(asin.trim().toUpperCase(), accessToken, marketplace))
    );

    const items = results.map((r, i) => {
      const asin = asins[i].trim().toUpperCase();
      if (r.status === 'fulfilled') {
        return { asin, ok: true, data: parseCatalogItem(r.value, marketplace.id) };
      }
      return { asin, ok: false, error: r.reason?.message ?? String(r.reason) };
    });

    res.json({ marketplace: { code: marketplaceCode, ...marketplace }, items });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────
// START SERVER
// ─────────────────────────────────────────────

const PORT = process.env.PORT || 4000;
app.listen(PORT, async () => {
  console.log(`[Server] ✅ API running on http://localhost:${PORT}`);
  await runMigrations();
  await loadSettingsFromDb();
});
