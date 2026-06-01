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
import { runRepricerJob, fastQueue, slowQueue, keepaQueue, redis } from './jobProducer.js';
import IORedis from 'ioredis';
import { appendFile, appendFileSync, createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, statSync, watch as fsWatch } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import multer from 'multer';
import XLSX from 'xlsx';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';

const __dirname = dirname(fileURLToPath(import.meta.url));
try { mkdirSync(join(__dirname, 'logs'), { recursive: true }); } catch {}

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
    const [mappings, recentLogs, priceChanges] = await Promise.all([
      db.query('SELECT COUNT(*) FROM product_mappings WHERE is_active = true AND user_id = $1', [uid]),
      db.query(`SELECT COUNT(*) FROM sync_logs sl JOIN product_mappings pm ON pm.id = sl.product_mapping_id WHERE pm.user_id = $1 AND sl.created_at > NOW() - INTERVAL '24 hours'`, [uid]),
      db.query(`SELECT COUNT(*) FROM sync_logs sl JOIN product_mappings pm ON pm.id = sl.product_mapping_id WHERE pm.user_id = $1 AND sl.status = 'success' AND sl.created_at > NOW() - INTERVAL '24 hours'`, [uid]),
    ]);
    res.json({
      activeListings: parseInt(mappings.rows[0].count),
      syncedLast24h: parseInt(recentLogs.rows[0].count),
      priceChangesLast24h: parseInt(priceChanges.rows[0].count),
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

// GET /api/queue-status — job counts scoped to the requesting user.
// Super-admin (not impersonating) sees global counts across both queues.
// All other users see only their own running job count via a Redis key
// written by jobProducer when their jobs are enqueued.
app.get('/api/queue-status', requireAuth, async (req, res) => {
  try {
    const isSuperAdmin = req.user.role === 'super_admin' && !req.isImpersonating;
    if (isSuperAdmin) {
      const [fast, slow, keepa] = await Promise.all([
        fastQueue.getJobCounts('waiting', 'active', 'delayed'),
        slowQueue.getJobCounts('waiting', 'active', 'delayed'),
        keepaQueue.getJobCounts('waiting', 'active', 'delayed'),
      ]);
      const bullTotal = (fast.waiting + fast.active + fast.delayed) +
                        (slow.waiting  + slow.active  + slow.delayed) +
                        (keepa.waiting + keepa.active + keepa.delayed);

      // Display total = all users' jobs (for the info counter).
      // busy = only super-admin's OWN jobs — other users running should not block the button.
      const runningKeys = await redis.keys('repricer:running:*');
      let asinTotal = 0;
      if (runningKeys.length > 0) {
        const vals = await redis.mget(...runningKeys);
        asinTotal = vals.reduce((sum, v) => sum + (parseInt(v) || 0), 0);
      }
      const total = Math.max(bullTotal, asinTotal);
      const ownRunning = parseInt(await redis.get(`repricer:running:${req.user.id}`) || '0');
      return res.json({ fast, slow, keepa, total, busy: ownRunning > 0 });
    }
    const pending = parseInt(await redis.get(`repricer:running:${req.effectiveUserId}`) || '0');
    res.json({ total: pending, busy: pending > 0 });
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
              enable_puppeteer, enable_twister, enable_cheerio
       FROM onbuy_accounts WHERE user_id = $1 ORDER BY created_at DESC`,
      [req.effectiveUserId]
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/accounts — create account
app.post('/api/accounts', requireAuth, async (req, res) => {
  const { account_name, consumer_key, secret_key, site_id = '2000', keepa_email, keepa_password,
          enable_puppeteer, enable_twister, enable_cheerio } = req.body;
  if (!account_name || !consumer_key || !secret_key)
    return res.status(400).json({ error: 'account_name, consumer_key and secret_key are required' });
  try {
    const { rows } = await db.query(
      `INSERT INTO onbuy_accounts (account_name, consumer_key, secret_key, site_id, user_id, keepa_email, keepa_password,
                                   enable_puppeteer, enable_twister, enable_cheerio)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING id, account_name, site_id, is_active, created_at, keepa_email,
                 enable_puppeteer, enable_twister, enable_cheerio`,
      [account_name, consumer_key, secret_key, site_id, req.effectiveUserId,
       keepa_email || null, keepa_password || null,
       enable_puppeteer === true, enable_twister === true, enable_cheerio === true]
    );
    res.status(201).json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PUT /api/accounts/:id — update account
app.put('/api/accounts/:id', requireAuth, async (req, res) => {
  const { account_name, consumer_key, secret_key, site_id, is_active, keepa_email, keepa_password,
          enable_puppeteer, enable_twister, enable_cheerio } = req.body;
  try {
    const { rows } = await db.query(
      `UPDATE onbuy_accounts SET
         account_name     = COALESCE($1, account_name),
         consumer_key     = COALESCE(NULLIF($2,''), consumer_key),
         secret_key       = COALESCE(NULLIF($3,''), secret_key),
         site_id          = COALESCE($4, site_id),
         is_active        = COALESCE($5, is_active),
         keepa_email      = COALESCE(NULLIF($6,''), keepa_email),
         keepa_password   = COALESCE(NULLIF($7,''), keepa_password),
         enable_puppeteer = COALESCE($8, enable_puppeteer),
         enable_twister   = COALESCE($9, enable_twister),
         enable_cheerio   = COALESCE($10, enable_cheerio),
         updated_at       = NOW()
       WHERE id = $11 AND user_id = $12
       RETURNING id, account_name, site_id, is_active, keepa_email,
                 enable_puppeteer, enable_twister, enable_cheerio`,
      [account_name || null, consumer_key || null, secret_key || null, site_id || null,
       is_active ?? null, keepa_email ?? null, keepa_password ?? null,
       enable_puppeteer ?? null, enable_twister ?? null, enable_cheerio ?? null,
       req.params.id, req.effectiveUserId]
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

// ─────────────────────────────────────────────
// EXCEL IMPORT
// ─────────────────────────────────────────────

// Fetch product title from Amazon meta/title tag (no browser needed)
async function fetchAmazonTitle(asin) {
  try {
    const res = await fetch(`https://www.amazon.co.uk/dp/${asin}`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept-Language': 'en-GB,en;q=0.9',
        'Accept': 'text/html,application/xhtml+xml',
      },
    });
    if (!res.ok) return null;
    const html = await res.text();
    const meta = html.match(/<meta\s+name="title"\s+content="([^"]+)"/i);
    if (meta) return meta[1].replace(/\s*:?\s*Amazon\.co\.uk.*$/i, '').trim();
    const title = html.match(/<title>([^<]+)<\/title>/i);
    if (title) return title[1].replace(/\s*:?\s*Amazon\.co\.uk.*$/i, '').trim();
    return null;
  } catch {
    return null;
  }
}

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
app.post('/api/import/preview', requireAuth, upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
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
      const markupValue = hasRoiCol ? sheetRoi : _globalSettings.defaultRoi;

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

  let account = null, onbuyToken = null;
  if (createRows.length > 0) {
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

  // ── 2. Auto-fetch missing titles (parallel, best-effort) ──
  const titleRows = bulkRows.filter(r => r.needs_title_fetch && r.primary_asin);
  if (titleRows.length > 0) {
    console.log(`[Import] Fetching ${titleRows.length} title(s) from Amazon…`);
    await Promise.all(titleRows.map(async row => {
      const t = await fetchAmazonTitle(row.primary_asin);
      if (t) row.product_name = t;
    }));
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
        product_name     = COALESCE(NULLIF(v.product_name,''),  pm.product_name),
        onbuy_listing_id = COALESCE(NULLIF(v.listing_id,''),    pm.onbuy_listing_id),
        onbuy_opc        = COALESCE(NULLIF(v.opc,''),           pm.onbuy_opc),
        onbuy_sku        = COALESCE(NULLIF(v.sku,''),           pm.onbuy_sku),
        markup_type      = v.markup_type,
        markup_value     = v.markup_value::decimal,
        onbuy_fee        = v.onbuy_fee::decimal,
        target_price     = COALESCE(NULLIF(v.target_price,'')::decimal, pm.target_price),
        min_price        = COALESCE(NULLIF(v.min_price,'')::decimal,    pm.min_price),
        notes            = COALESCE(NULLIF(v.notes,''),         pm.notes),
        updated_at       = NOW()
      FROM (SELECT * FROM unnest(
        $1::int[], $2::text[], $3::text[], $4::text[], $5::text[],
        $6::text[], $7::text[], $8::text[], $9::text[], $10::text[], $11::text[]
      ) AS v(id, product_name, listing_id, opc, sku,
             markup_type, markup_value, onbuy_fee, target_price, min_price, notes)) v
      WHERE pm.id = v.id AND pm.user_id = ${req.effectiveUserId}`,
    [
      c.map(r => r._id),
      c.map(r => r.product_name     || ''),
      c.map(r => r.onbuy_listing_id || ''),
      c.map(r => r.onbuy_opc        || ''),
      c.map(r => r.onbuy_sku        || ''),
      c.map(r => r.markup_type      || 'roi'),
      c.map(r => String(r.markup_value ?? 0)),
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
         markup_type, markup_value, onbuy_fee, target_price, min_price, notes,
         onbuy_account_id, user_id, is_active)
      SELECT
        NULLIF(v.product_name,''),
        NULLIF(v.listing_id,''),
        NULLIF(v.opc,''),
        NULLIF(v.sku,''),
        v.asin,
        v.markup_type,
        v.markup_value::decimal,
        v.onbuy_fee::decimal,
        NULLIF(v.target_price,'')::decimal,
        NULLIF(v.min_price,'')::decimal,
        NULLIF(v.notes,''),
        NULLIF(v.account_id,'')::int,
        v.user_id::int,
        true
      FROM unnest(
        $1::text[], $2::text[], $3::text[], $4::text[], $5::text[],
        $6::text[], $7::text[], $8::text[], $9::text[], $10::text[], $11::text[], $12::text[], $13::text[]
      ) AS v(product_name, listing_id, opc, sku, asin,
             markup_type, markup_value, onbuy_fee, target_price, min_price, notes, account_id, user_id)`,
    [
      c.map(r => r.product_name     || ''),
      c.map(r => r.onbuy_listing_id || ''),
      c.map(r => r.onbuy_opc        || ''),
      c.map(r => r.onbuy_sku        || ''),
      c.map(r => r.primary_asin),
      c.map(r => r.markup_type      || 'roi'),
      c.map(r => String(r.markup_value ?? 0)),
      c.map(r => String(r.onbuy_fee  ?? 0)),
      c.map(r => r.target_price != null ? String(r.target_price) : ''),
      c.map(r => r.min_price    != null ? String(r.min_price)    : ''),
      c.map(r => r.notes        || ''),
      c.map(() => onbuy_account_id != null ? String(onbuy_account_id) : ''),
      c.map(() => String(req.effectiveUserId)),
    ]);
    results.created += c.length;
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
    const { rows } = await db.query(
      'SELECT key, value FROM settings WHERE user_id = $1',
      [req.effectiveUserId]
    );
    const s = Object.fromEntries(rows.map(r => [r.key, r.value]));
    // Load proxy for status display if this user has one configured
    if (s.webshare_proxy_api) setProxyApiUrl(s.webshare_proxy_api);
    res.json({ ...s, _proxy_status: getProxyStatus() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/settings', requireAuth, async (req, res) => {
  const allowed = ['webshare_proxy_api', 'onbuy_fee_percent', 'default_roi_percent', 'min_roi_percent', 'job_interval_minutes', 'job_start_time'];
  const uid = req.effectiveUserId;
  try {
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
  name:            ['product name', 'title', 'name', 'product title'],
  category:        ['category name', 'category', 'cat'],
  brand:           ['brand', 'brand name', 'manufacturer'],
  ean:             ['ean', 'barcode', 'ean/barcode', 'ean / barcode', 'gtin'],
  mpn:             ['mpn', 'manufacturer part number', 'part number', 'model number'],
  condition:       ['condition'],
  description:     ['description', 'product description', 'desc'],
  image1:          ['image url 1', 'image url', 'image 1', 'image', 'main image'],
  image2:          ['image url 2', 'image 2', 'additional image 1'],
  image3:          ['image url 3', 'image 3', 'additional image 2'],
  sku:             ['sku', 'seller sku', 'your sku', 'listing sku'],
  price:           ['price (£)', 'price', 'selling price', 'sale price'],
  stock:           ['stock', 'quantity', 'qty', 'inventory'],
  delivery_weight: ['delivery weight (kg)', 'delivery weight', 'weight (kg)', 'weight'],
};

function findBulkColIdx(headers, aliases) {
  const norm = s => s.toLowerCase().replace(/[^a-z0-9]/g, ' ').replace(/\s+/g, ' ').trim();
  return headers.findIndex(h => aliases.some(a => norm(h) === norm(a) || norm(h).includes(norm(a))));
}

// GET /api/onbuy-bulk/template — download blank import template
app.get('/api/onbuy-bulk/template', requireAuth, (req, res) => {
  const headers = [
    'Product Name', 'Category Name', 'Brand', 'EAN', 'MPN',
    'Condition', 'Description', 'Image URL 1', 'Image URL 2', 'Image URL 3',
    'SKU', 'Price (£)', 'Stock', 'Delivery Weight (kg)',
  ];
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet([
    headers,
    [
      'TP-Link Tapo C320WS Security Camera', 'IP Cameras', 'TP-Link',
      '6935364099213', 'C320WS', 'new',
      '5MP pan/tilt Smart Security Camera with Night Vision & Colour',
      'https://example.com/tp-link-main.jpg', '', '',
      'TPLINK-C320WS-001', '49.99', '5', '0.5',
    ],
    [
      'Foam Exercise Floor Mats (6-Pack)', 'Exercise Mats', 'Generic',
      '', '', 'new',
      'Interlocking foam floor mats — pack of 6, ideal for gym or play room',
      'https://example.com/foam-mats.jpg', '', '',
      'FOAM-MAT-6PK-001', '19.99', '10', '1.2',
    ],
  ]);
  ws['!cols'] = [40, 25, 18, 18, 15, 10, 55, 45, 45, 45, 22, 12, 8, 22].map(w => ({ wch: w }));
  XLSX.utils.book_append_sheet(wb, ws, 'OnBuy Products');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="onbuy-bulk-template.xlsx"');
  res.send(buf);
});

// POST /api/onbuy-bulk/preview — parse uploaded Excel, validate and return rows
app.post('/api/onbuy-bulk/preview', requireAuth, upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  try {
    const wb = XLSX.read(req.file.buffer, { type: 'buffer' });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const allRows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
    if (allRows.length < 2) return res.json({ total: 0, valid: 0, rows: [], headers: [] });

    const headers = allRows[0].map(h => String(h || '').trim());
    const dataRows = allRows.slice(1);

    const idx = {};
    for (const [key, aliases] of Object.entries(BULK_COL_ALIASES)) {
      idx[key] = findBulkColIdx(headers, aliases);
    }

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
      const sku       = getCell(row, 'sku');
      const price     = parseFloat(getCell(row, 'price').replace(/[£,]/g, '')) || null;
      const stock     = parseInt(getCell(row, 'stock')) || 0;
      const delivery_weight = parseFloat(getCell(row, 'delivery_weight')) || null;

      const errors = [];
      if (!name)     errors.push('Product Name required');
      if (!category) errors.push('Category Name required');
      if (!price)    errors.push('Price (£) required');
      if (!sku)      errors.push('SKU required');
      if (!stock)    errors.push('Stock must be > 0');

      return {
        _row: i + 2, valid: errors.length === 0, errors,
        name, category, brand, ean, mpn, condition, description: desc,
        images: [img1, img2, img3].filter(Boolean),
        sku, price, stock, delivery_weight,
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

// POST /api/onbuy-bulk/import — create OnBuy products and listings from validated rows
app.post('/api/onbuy-bulk/import', requireAuth, async (req, res) => {
  const { rows, account_id } = req.body;
  if (!Array.isArray(rows) || rows.length === 0)
    return res.status(400).json({ error: 'No rows provided' });
  if (!account_id)
    return res.status(400).json({ error: 'OnBuy account required' });

  const account = await getImportAccount(account_id);
  if (!account) return res.status(400).json({ error: 'Account not found or inactive' });

  const token = await getOnBuyTokenForAccount(account);
  if (!token) return res.status(400).json({ error: 'Failed to get OnBuy token — check API credentials' });

  const siteId    = account.site_id || '2000';
  const validRows = rows.filter(r => r.valid);
  const results   = { product_created: 0, listing_created: 0, listing_updated: 0, skipped: 0, errors: [] };

  // Create import session record
  const { rows: [session] } = await db.query(
    `INSERT INTO onbuy_bulk_import_sessions (user_id, account_id, account_name, total_rows, status)
     VALUES ($1, $2, $3, $4, 'processing') RETURNING id`,
    [req.user.userId, account_id, account.account_name, validRows.length]
  );
  const sessionId = session.id;

  // Per-session logger: writes to logs/bulk-import.log AND console
  const categoryCache = {};

  function blog(...args) {
    const msg      = args.join(' ');
    const line     = `[${new Date().toISOString()}] [Bulk][session=${sessionId}] ${msg}\n`;
    const logFile  = join(__dirname, 'logs', `user-${req.user.userId}-import.log`);
    try { appendFileSync(logFile, line, 'utf8'); } catch {}
    console.log(`[OnBuy Bulk][s=${sessionId}]`, msg);
  }

  async function lookupCategoryId(name) {
    if (categoryCache[name] !== undefined) return categoryCache[name];
    const leafName = name.includes('>') ? name.split('>').pop().trim() : name.trim();
    try {
      const r = await fetch(
        `https://api.onbuy.com/v2/categories?filter[name]=${encodeURIComponent(leafName)}&site_id=${siteId}`,
        { headers: { Authorization: token } }
      );
      const data = await r.json();
      const cats = data?.payload ?? data?.results ?? data ?? [];
      categoryCache[name] = Array.isArray(cats) ? (cats[0]?.category_id ?? cats[0]?.id ?? null) : null;
      blog(`Category "${leafName}" → id=${categoryCache[name]}`);
    } catch { categoryCache[name] = null; }
    return categoryCache[name];
  }

  async function pollProductQueue(queueId, maxWaitMs = 90000) {
    const start = Date.now();
    while (Date.now() - start < maxWaitMs) {
      await new Promise(r => setTimeout(r, 4000));
      let data;
      try {
        const r = await fetch(
          `https://api.onbuy.com/v2/queues/${queueId}?site_id=${siteId}`,
          { headers: { Authorization: token } }
        );
        data = await r.json();
      } catch (e) {
        blog(`Queue poll fetch error: ${e.message} — retrying`);
        continue;
      }
      blog(`Queue ${queueId}: ${JSON.stringify(data)}`);
      const status = data?.results?.status ?? '';
      const opc    = data?.results?.opc ?? null;
      if (status === 'success' && opc) return opc;
      if (status === 'failed' || status === 'error') {
        throw new Error(data?.results?.error_message || 'Product queue failed');
      }
    }
    blog(`Queue ${queueId} timed out after ${maxWaitMs / 1000}s`);
    return null;
  }

  // ── Phase 1a: Batch EAN search — up to 50 EANs per GET (600/hr GET limit) ──
  // Uses filter[field]=product_code to search by barcode specifically.
  const rowsWithEan = validRows.filter(r => r.ean);
  const eanOpcMap   = new Map(); // EAN string → opc

  blog(`Phase 1: batch EAN search — ${rowsWithEan.length} row(s) with EAN, ${validRows.length - rowsWithEan.length} without`);
  for (let i = 0; i < rowsWithEan.length; i += 50) {
    const chunk = rowsWithEan.slice(i, i + 50);
    const eans  = chunk.map(r => r.ean).join(',');
    try {
      const r = await fetch(
        `https://api.onbuy.com/v2/products?site_id=${siteId}&filter[field]=product_code&filter[query]=${encodeURIComponent(eans)}`,
        { headers: { Authorization: token } }
      );
      const data     = await r.json();
      const products = data?.results ?? data?.payload ?? [];
      for (const p of products) {
        const opc   = p.opc ?? p.product_code ?? null;
        const codes = Array.isArray(p.product_codes) ? p.product_codes : [];
        for (const code of codes) eanOpcMap.set(String(code).trim(), opc);
      }
      blog(`EAN batch ${Math.floor(i / 50) + 1}: searched ${chunk.length} EAN(s) → ${products.length} match(es)`);
    } catch (e) {
      blog(`EAN batch ${Math.floor(i / 50) + 1} error: ${e.message} — treating these rows as new products`);
    }
  }

  // ── Phase 1b: Category lookup + distribute into existingMeta / newMeta ──
  const existingMeta = []; // OPC known from EAN search — listing only
  const newMeta      = []; // no OPC — needs product creation

  for (const row of validRows) {
    const sourcePrice  = parseFloat(row.price) || 0;
    const sellingPrice = parseFloat((sourcePrice * 1.20 / 0.85).toFixed(2));

    const categoryId = await lookupCategoryId(row.category);
    if (!categoryId) {
      const errMsg = `Category "${row.category}" not found on OnBuy`;
      results.errors.push({ row: row._row, product: row.name, error: errMsg });
      results.skipped++;
      db.query(
        `INSERT INTO onbuy_bulk_import_items
          (session_id,user_id,row_number,product_name,sku,ean,category,brand,source_price,selling_price,stock,condition,status,error_message)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'error',$13)`,
        [sessionId, req.user.userId, row._row, row.name, row.sku, row.ean, row.category,
         row.brand, sourcePrice, sellingPrice, parseInt(row.stock)||0,
         normalizeCondition(row.condition), errMsg]
      ).catch(() => {});
      continue;
    }

    const opc  = row.ean ? (eanOpcMap.get(String(row.ean).trim()) ?? null) : null;
    const meta = { row, sourcePrice, sellingPrice, categoryId, opc };
    if (opc) existingMeta.push(meta);
    else      newMeta.push(meta);
  }
  blog(`Phase 1 complete: ${existingMeta.length} existing product(s), ${newMeta.length} new product(s)`);

  // ── Phase 2: Batch create new products ──
  // Products missing a default image are errored immediately; the rest are sent in chunks of 1000.
  const CHUNK      = 1000;
  const queueItems = []; // { meta, queueId } — fed into Phase 3

  for (const m of newMeta) {
    if (!m.row.images?.[0]) {
      const errMsg = 'Default image is required to create a new product — add Image URL 1 to this row';
      results.errors.push({ row: m.row._row, product: m.row.name, error: errMsg });
      results.skipped++;
      db.query(
        `INSERT INTO onbuy_bulk_import_items
          (session_id,user_id,row_number,product_name,sku,ean,category,brand,source_price,selling_price,stock,condition,status,error_message)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'error',$13)`,
        [sessionId, req.user.userId, m.row._row, m.row.name, m.row.sku, m.row.ean, m.row.category,
         m.row.brand, m.sourcePrice, m.sellingPrice, parseInt(m.row.stock)||0,
         normalizeCondition(m.row.condition), errMsg]
      ).catch(() => {});
    }
  }
  const toCreate = newMeta.filter(m => m.row.images?.[0]);

  for (let i = 0; i < toCreate.length; i += CHUNK) {
    const chunk    = toCreate.slice(i, i + CHUNK);
    const products = chunk.map(({ row, sellingPrice, categoryId }) => {
      const conditionVal   = normalizeCondition(row.condition);
      const brandVal       = row.brand?.trim();
      const brandFields    = brandVal ? { brand_name: brandVal } : { brand_id: 1 };
      const additionalImgs = (row.images || []).slice(1).filter(Boolean);
      return {
        uid:          row.sku || `bulk-${row._row ?? Date.now()}`,
        published:    '1',
        category_id:  categoryId,
        product_name: truncateToBytes(row.name, 150),
        ...brandFields,
        default_image: row.images[0],
        ...(additionalImgs.length  ? { additional_images: additionalImgs }  : {}),
        ...(row.description        ? { description: row.description }        : {}),
        ...(row.ean                ? { product_codes: [row.ean] }            : {}),
        ...(row.mpn                ? { mpn: row.mpn }                        : {}),
        listings: {
          [conditionVal]: {
            price: sellingPrice,
            stock: parseInt(row.stock) || 0,
            ...(row.sku             ? { sku: row.sku }                             : {}),
            ...(row.delivery_weight ? { delivery_weight: parseFloat(row.delivery_weight) } : {}),
          },
        },
      };
    });

    blog(`Phase 2: batch creating ${chunk.length} product(s) (chunk ${Math.floor(i / CHUNK) + 1} of ${Math.ceil(toCreate.length / CHUNK)})`);
    blog(`Phase 2 payload: ${JSON.stringify({ site_id: parseInt(siteId) || 2000, products })}`);
    const createRes  = await fetch('https://api.onbuy.com/v2/products', {
      method: 'POST',
      headers: { Authorization: token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ site_id: parseInt(siteId) || 2000, products }),
    });
    const createData = await createRes.json();
    blog(`Batch create HTTP ${createRes.status}: ${JSON.stringify(createData)}`);

    if (!createRes.ok) {
      const msg = createData?.message || createData?.error || 'Batch product create failed';
      for (const m of chunk) {
        results.errors.push({ row: m.row._row, product: m.row.name, error: msg });
        results.skipped++;
        db.query(
          `INSERT INTO onbuy_bulk_import_items
            (session_id,user_id,row_number,product_name,sku,ean,category,brand,source_price,selling_price,stock,condition,status,error_message)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'error',$13)`,
          [sessionId, req.user.userId, m.row._row, m.row.name, m.row.sku, m.row.ean, m.row.category,
           m.row.brand, m.sourcePrice, m.sellingPrice, parseInt(m.row.stock)||0,
           normalizeCondition(m.row.condition), msg]
        ).catch(() => {});
      }
      continue;
    }

    const batchResults = createData?.results ?? [];
    for (let j = 0; j < chunk.length; j++) {
      const m  = chunk[j];
      const br = batchResults[j];
      if (!br?.queue_id) {
        const msg = br?.message || `No queue_id returned for "${m.row.name}"`;
        results.errors.push({ row: m.row._row, product: m.row.name, error: msg });
        results.skipped++;
        db.query(
          `INSERT INTO onbuy_bulk_import_items
            (session_id,user_id,row_number,product_name,sku,ean,category,brand,source_price,selling_price,stock,condition,status,error_message)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'error',$13)`,
          [sessionId, req.user.userId, m.row._row, m.row.name, m.row.sku, m.row.ean, m.row.category,
           m.row.brand, m.sourcePrice, m.sellingPrice, parseInt(m.row.stock)||0,
           normalizeCondition(m.row.condition), msg]
        ).catch(() => {});
      } else {
        queueItems.push({ meta: m, queueId: br.queue_id });
      }
    }
  }

  // ── Phase 3: Poll all product queues concurrently ──
  if (queueItems.length > 0) {
    blog(`Phase 3: polling ${queueItems.length} product queue(s) concurrently`);
    const pollOutcomes = await Promise.all(queueItems.map(async ({ meta, queueId }) => {
      try   { return { meta, opc: await pollProductQueue(queueId), error: null }; }
      catch (err) { return { meta, opc: null, error: err.message }; }
    }));

    for (const { meta, opc, error } of pollOutcomes) {
      if (!error) {
        // Product created — push to existingMeta so Phase 4 sets price/stock via POST /v2/listings.
        // Embedded listings in POST /v2/products don't reliably apply price or stock.
        results.product_created++;
        existingMeta.push({ ...meta, opc });
        db.query(
          `INSERT INTO onbuy_bulk_import_items
            (session_id,user_id,row_number,product_name,sku,ean,category,brand,source_price,selling_price,stock,condition,opc,status)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'product_created')`,
          [sessionId, req.user.userId, meta.row._row, meta.row.name, meta.row.sku, meta.row.ean,
           meta.row.category, meta.row.brand, meta.sourcePrice, meta.sellingPrice,
           parseInt(meta.row.stock)||0, normalizeCondition(meta.row.condition), opc]
        ).catch(() => {});
      } else {
        const dupEan     = (error.match(/Duplicate entry '(\d+)'/) || [])[1];
        const brandOwned = /brand is owned by another seller/i.test(error);

        if (dupEan) {
          // Duplicate EAN: search for the existing product, add to listing batch
          blog(`Duplicate EAN "${dupEan}" — searching for existing product...`);
          try {
            const sr    = await fetch(
              `https://api.onbuy.com/v2/products?site_id=${siteId}&filter[field]=product_code&filter[query]=${encodeURIComponent(dupEan)}`,
              { headers: { Authorization: token } }
            );
            const sd    = await sr.json();
            const prods = sd?.results ?? sd?.payload ?? [];
            const existingOpc = Array.isArray(prods) && prods.length
              ? (prods[0]?.opc ?? prods[0]?.product_code ?? null) : null;
            if (existingOpc) {
              blog(`Found OPC=${existingOpc} for duplicate EAN "${dupEan}" — adding to listing batch`);
              existingMeta.push({ ...meta, opc: existingOpc });
            } else {
              throw new Error(`EAN "${dupEan}" already registered on OnBuy but matching product not found — list it manually`);
            }
          } catch (searchErr) {
            results.errors.push({ row: meta.row._row, product: meta.row.name, error: searchErr.message });
            results.skipped++;
            db.query(
              `INSERT INTO onbuy_bulk_import_items
                (session_id,user_id,row_number,product_name,sku,ean,category,brand,source_price,selling_price,stock,condition,status,error_message)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'error',$13)`,
              [sessionId, req.user.userId, meta.row._row, meta.row.name, meta.row.sku, meta.row.ean,
               meta.row.category, meta.row.brand, meta.sourcePrice, meta.sellingPrice,
               parseInt(meta.row.stock)||0, normalizeCondition(meta.row.condition), searchErr.message]
            ).catch(() => {});
          }
        } else if (brandOwned) {
          // Brand is protected on OnBuy — skip this product
          results.errors.push({ row: meta.row._row, product: meta.row.name, error: 'The supplied brand is owned by another seller — skipped' });
          results.skipped++;
          db.query(
            `INSERT INTO onbuy_bulk_import_items
              (session_id,user_id,row_number,product_name,sku,ean,category,brand,source_price,selling_price,stock,condition,status,error_message)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'error',$13)`,
            [sessionId, req.user.userId, meta.row._row, meta.row.name, meta.row.sku, meta.row.ean,
             meta.row.category, meta.row.brand, meta.sourcePrice, meta.sellingPrice,
             parseInt(meta.row.stock)||0, normalizeCondition(meta.row.condition),
             'The supplied brand is owned by another seller — skipped']
          ).catch(() => {});
        } else {
          results.errors.push({ row: meta.row._row, product: meta.row.name, error });
          results.skipped++;
          db.query(
            `INSERT INTO onbuy_bulk_import_items
              (session_id,user_id,row_number,product_name,sku,ean,category,brand,source_price,selling_price,stock,condition,status,error_message)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'error',$13)`,
            [sessionId, req.user.userId, meta.row._row, meta.row.name, meta.row.sku, meta.row.ean,
             meta.row.category, meta.row.brand, meta.sourcePrice, meta.sellingPrice,
             parseInt(meta.row.stock)||0, normalizeCondition(meta.row.condition), error]
          ).catch(() => {});
        }
      }
    }
  }

  // ── Phase 3.5: Batch update existing products with fresh data (images, descriptions, etc.) ──
  // Covers all items in existingMeta that have an OPC — Phase 1 EAN matches + Phase 3 newly created / recovered products.
  // Uses PUT /v2/products (batch, synchronous) so images and metadata are refreshed before listings go live.
  const toUpdate = existingMeta.filter(m => m.opc);
  if (toUpdate.length > 0) {
    blog(`Phase 3.5: updating ${toUpdate.length} product(s) with fresh data (images, descriptions, etc.)`);

    for (let i = 0; i < toUpdate.length; i += CHUNK) {
      const chunk    = toUpdate.slice(i, i + CHUNK);
      const products = chunk.map(({ row, categoryId, opc }) => {
        const brandVal       = row.brand?.trim();
        const brandFields    = brandVal ? { brand_name: brandVal } : {};
        const additionalImgs = (row.images || []).slice(1).filter(Boolean);
        return {
          opc,
          product_name: truncateToBytes(row.name, 150),
          category_id:  categoryId,
          ...brandFields,
          ...(row.images?.[0]       ? { default_image: row.images[0] }      : {}),
          ...(additionalImgs.length ? { additional_images: additionalImgs } : {}),
          ...(row.description       ? { description: row.description }      : {}),
          ...(row.mpn               ? { mpn: row.mpn }                      : {}),
        };
      });

      blog(`Phase 3.5: chunk ${Math.floor(i / CHUNK) + 1} of ${Math.ceil(toUpdate.length / CHUNK)} — ${chunk.length} product(s)`);
      const p35Res  = await fetch('https://api.onbuy.com/v2/products', {
        method:  'PUT',
        headers: { Authorization: token, 'Content-Type': 'application/json' },
        body:    JSON.stringify({ site_id: parseInt(siteId) || 2000, products }),
      });
      const p35Data = await p35Res.json();
      blog(`Phase 3.5 HTTP ${p35Res.status}: ${JSON.stringify(p35Data)}`);

      if (!p35Res.ok) {
        blog(`Phase 3.5: batch update failed — ${p35Data?.message || p35Data?.error || 'unknown error'}. Proceeding to Phase 4.`);
        continue;
      }

      const p35Results = p35Data?.products ?? p35Data?.results ?? [];
      let p35Ok = 0, p35Fail = 0;
      for (let j = 0; j < chunk.length; j++) {
        const ur = Array.isArray(p35Results) ? p35Results[j] : null;
        if (ur?.success === false) {
          blog(`Phase 3.5: failed OPC=${chunk[j].opc} — ${ur.message}`);
          p35Fail++;
        } else {
          p35Ok++;
        }
      }
      blog(`Phase 3.5: chunk done — ${p35Ok} updated, ${p35Fail} failed`);
    }
  }

  // ── Phase 4: Batch create listings ──
  // existingMeta includes: Phase 1 matches + Phase 3 dup-EAN recoveries + Phase 3 new products (OPC from queue)
  if (existingMeta.length > 0) {
    blog(`Phase 4: batch creating ${existingMeta.length} listing(s) for existing products`);

    for (let i = 0; i < existingMeta.length; i += CHUNK) {
      const chunk    = existingMeta.slice(i, i + CHUNK);
      const listings = chunk.map(({ row, sellingPrice, opc }) => ({
        opc,
        condition: normalizeCondition(row.condition),
        price: sellingPrice,
        stock: parseInt(row.stock) || 0,
        ...(row.sku             ? { sku: row.sku }                             : {}),
        ...(row.delivery_weight ? { delivery_weight: parseFloat(row.delivery_weight) } : {}),
      }));

      blog(`Listing batch ${Math.floor(i / CHUNK) + 1}: ${chunk.length} listing(s)`);
      const listingRes  = await fetch(`https://api.onbuy.com/v2/listings?site_id=${siteId}`, {
        method: 'POST',
        headers: { Authorization: token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ site_id: parseInt(siteId) || 2000, listings }),
      });
      const listingData = await listingRes.json();
      blog(`Batch listing HTTP ${listingRes.status}: ${JSON.stringify(listingData)}`);

      const listingResults = listingData?.results ?? listingData?.payload ?? [];
      const updateNeeded   = []; // items that already exist — retry with PUT

      for (let j = 0; j < chunk.length; j++) {
        const m            = chunk[j];
        const lr           = Array.isArray(listingResults) ? listingResults[j] : null;
        const conditionVal = normalizeCondition(m.row.condition);
        if (!listingRes.ok || lr?.success === false) {
          const msg          = lr?.message || listingData?.message || listingData?.error || 'Listing rejected by OnBuy';
          const alreadyExists = /already have a listing|listing already exist|duplicate listing/i.test(msg);
          if (alreadyExists && m.row.sku) {
            updateNeeded.push(m);
          } else {
            const finalMsg = alreadyExists
              ? `${msg} (no SKU provided — cannot update automatically)`
              : msg;
            results.errors.push({ row: m.row._row, product: m.row.name, error: finalMsg });
            results.skipped++;
            db.query(
              `INSERT INTO onbuy_bulk_import_items
                (session_id,user_id,row_number,product_name,sku,ean,category,brand,source_price,selling_price,stock,condition,opc,status,error_message)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'error',$14)`,
              [sessionId, req.user.userId, m.row._row, m.row.name, m.row.sku, m.row.ean, m.row.category,
               m.row.brand, m.sourcePrice, m.sellingPrice, parseInt(m.row.stock)||0, conditionVal, m.opc, finalMsg]
            ).catch(() => {});
          }
        } else {
          results.listing_created++;
          db.query(
            `INSERT INTO onbuy_bulk_import_items
              (session_id,user_id,row_number,product_name,sku,ean,category,brand,source_price,selling_price,stock,condition,opc,status)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'listing_created')`,
            [sessionId, req.user.userId, m.row._row, m.row.name, m.row.sku, m.row.ean, m.row.category,
             m.row.brand, m.sourcePrice, m.sellingPrice, parseInt(m.row.stock)||0, conditionVal, m.opc]
          ).catch(() => {});
        }
      }

      // ── PUT batch: update listings that already exist (identified by SKU) ──
      if (updateNeeded.length > 0) {
        blog(`Listing update batch: ${updateNeeded.length} already-existing listing(s) — updating via PUT`);
        const updatePayload = updateNeeded.map(({ row, sellingPrice }) => ({
          sku:   row.sku,
          price: sellingPrice,
          stock: parseInt(row.stock) || 0,
          ...(row.delivery_weight ? { delivery_weight: parseFloat(row.delivery_weight) } : {}),
        }));

        const updateRes  = await fetch(`https://api.onbuy.com/v2/listings?site_id=${siteId}`, {
          method:  'PUT',
          headers: { Authorization: token, 'Content-Type': 'application/json' },
          body:    JSON.stringify({ site_id: parseInt(siteId) || 2000, listings: updatePayload }),
        });
        const updateData = await updateRes.json();
        blog(`Listing PUT HTTP ${updateRes.status}: ${JSON.stringify(updateData)}`);

        const updateResults = updateData?.results ?? updateData?.payload ?? [];
        for (let j = 0; j < updateNeeded.length; j++) {
          const m            = updateNeeded[j];
          const ur           = Array.isArray(updateResults) ? updateResults[j] : null;
          const conditionVal = normalizeCondition(m.row.condition);
          if (!updateRes.ok || ur?.success === false) {
            const msg = ur?.message || updateData?.message || updateData?.error || 'Listing update rejected by OnBuy';
            results.errors.push({ row: m.row._row, product: m.row.name, error: msg });
            results.skipped++;
            db.query(
              `INSERT INTO onbuy_bulk_import_items
                (session_id,user_id,row_number,product_name,sku,ean,category,brand,source_price,selling_price,stock,condition,opc,status,error_message)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'error',$14)`,
              [sessionId, req.user.userId, m.row._row, m.row.name, m.row.sku, m.row.ean, m.row.category,
               m.row.brand, m.sourcePrice, m.sellingPrice, parseInt(m.row.stock)||0, conditionVal, m.opc, msg]
            ).catch(() => {});
          } else {
            results.listing_updated++;
            db.query(
              `INSERT INTO onbuy_bulk_import_items
                (session_id,user_id,row_number,product_name,sku,ean,category,brand,source_price,selling_price,stock,condition,opc,status)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'listing_updated')`,
              [sessionId, req.user.userId, m.row._row, m.row.name, m.row.sku, m.row.ean, m.row.category,
               m.row.brand, m.sourcePrice, m.sellingPrice, parseInt(m.row.stock)||0, conditionVal, m.opc]
            ).catch(() => {});
          }
        }
      }
    }
  }

  // Finalize session
  await db.query(
    `UPDATE onbuy_bulk_import_sessions SET
       products_created=$1, listings_created=$2, listings_updated=$3, skipped=$4, errors_count=$5,
       status='completed', completed_at=NOW()
     WHERE id=$6`,
    [results.product_created, results.listing_created, results.listing_updated, results.skipped, results.errors.length, sessionId]
  );

  res.json({ ...results, session_id: sessionId });
});

// GET /api/onbuy-bulk/history — import sessions for the current user
app.get('/api/onbuy-bulk/history', requireAuth, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT id, account_name, total_rows, products_created, listings_created,
              listings_updated, skipped, errors_count, status, created_at, completed_at
       FROM onbuy_bulk_import_sessions
       WHERE user_id = $1
       ORDER BY created_at DESC
       LIMIT 50`,
      [req.user.userId]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/onbuy-bulk/history/:sessionId/items — rows for a specific import session
app.get('/api/onbuy-bulk/history/:sessionId/items', requireAuth, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT row_number, product_name, sku, ean, brand, category,
              source_price, selling_price, stock, condition, opc, status, error_message, created_at
       FROM onbuy_bulk_import_items
       WHERE session_id = $1 AND user_id = $2
       ORDER BY row_number ASC`,
      [req.params.sessionId, req.user.userId]
    );
    res.json(rows);
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
// START SERVER
// ─────────────────────────────────────────────

const PORT = process.env.PORT || 4000;
app.listen(PORT, async () => {
  console.log(`[Server] ✅ API running on http://localhost:${PORT}`);
  await runMigrations();
  await loadSettingsFromDb();
});
