/**
 * complianceJob.js
 * ─────────────────────────────────────────────────────────────
 * Daily patrol job — scans every active OnBuy account's live listings,
 * flags any that violate OnBuy's Protected Brands or Prohibited Products
 * policies, and sets their stock to 0 (removes them from sale) to prevent
 * further account suspensions.
 *
 * Run as a standalone process via complianceWorker.js.
 * Triggered by: daily cron (2 AM) OR Redis publish on 'compliance:run'.
 */

import pg from 'pg';
import IORedis from 'ioredis';
import cron from 'node-cron';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { resolve } from 'path';
import { getTokenForAccount } from './jobProducer.js';
import { checkListing } from './complianceData.js';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Redis pub client for streaming logs to the API server (set in startWorker)
let redisPub = null;

// Per-user scheduled cron tasks
const _userComplianceCrons = new Map();

// Track which users currently have a running job
const _runningUsers = new Set();

// ── Logger ─────────────────────────────────────────────────────────────────

function makeLogger(accountName, userId = null) {
  const logDir = path.join(__dirname, 'logs', 'compliance_logs');
  fs.mkdirSync(logDir, { recursive: true });
  const date     = new Date().toISOString().slice(0, 10);
  const safeName = (accountName || 'unknown').replace(/[^a-zA-Z0-9_-]/g, '_');
  const logFile  = path.join(logDir, `${safeName}_${date}.log`);
  return (msg) => {
    const line = `[${new Date().toISOString()}] ${msg}`;
    console.log(line);
    fs.appendFileSync(logFile, line + '\n');
    if (redisPub && userId) {
      redisPub.publish(`compliance:log:${userId}`, JSON.stringify({ msg: line })).catch(() => {});
    }
  };
}

// ── Per-user schedule loader ───────────────────────────────────────────────

async function refreshComplianceSchedules(db) {
  try {
    const { rows } = await db.query(`
      SELECT u.id AS user_id,
             COALESCE(s.value, '02:00') AS schedule_time
        FROM users u
        LEFT JOIN settings s ON s.user_id = u.id AND s.key = 'compliance_schedule_time'
    `);

    for (const task of _userComplianceCrons.values()) task.stop();
    _userComplianceCrons.clear();

    for (const row of rows) {
      const [h = 2, m = 0] = (row.schedule_time || '02:00').split(':').map(Number);
      const expr = `${m} ${h} * * *`;
      const task = cron.schedule(expr, () => {
        console.log(`[Compliance] ⏰ Scheduled patrol for user ${row.user_id} at ${row.schedule_time}`);
        runComplianceJob(db, { userId: row.user_id }).catch(e =>
          console.error(`[Compliance] Scheduled error for user ${row.user_id}:`, e.message)
        );
      });
      _userComplianceCrons.set(row.user_id, task);
    }
    console.log(`[Compliance] Schedules refreshed for ${rows.length} user(s)`);
  } catch (err) {
    console.error('[Compliance] refreshComplianceSchedules error:', err.message);
  }
}

// ── OnBuy API helpers ──────────────────────────────────────────────────────

async function fetchAllListings(token, siteId, log) {
  const all = [];
  let offset = 0;
  const limit = 1000;

  while (true) {
    const url = `https://api.onbuy.com/v2/listings?site_id=${siteId}&limit=${limit}&offset=${offset}`;
    let data;
    try {
      const r = await fetch(url, { headers: { Authorization: token } });
      if (!r.ok) { log(`[Listings] HTTP ${r.status} at offset=${offset} — stopping`); break; }
      data = await r.json().catch(() => ({}));
    } catch (err) {
      log(`[Listings] Fetch error at offset=${offset}: ${err.message}`);
      break;
    }

    const results = Array.isArray(data)
      ? data
      : (data.results ?? data.payload ?? data.listings ?? []);

    if (!results.length) break;
    all.push(...results);

    const total = data.metadata?.total_rows ?? data.total ?? null;
    log(`[Listings] offset=${offset}: +${results.length} (${all.length}${total ? `/${total}` : ''} total)`);

    if (total !== null && all.length >= total) break;
    if (results.length < limit) break;
    offset += limit;
    await new Promise(r => setTimeout(r, 300));
  }

  return all;
}

async function deleteListings(token, siteId, skus, log) {
  const CHUNK = 100;
  let removed = 0;
  for (let i = 0; i < skus.length; i += CHUNK) {
    const chunk = skus.slice(i, i + CHUNK);
    try {
      const r = await fetch(
        `https://api.onbuy.com/v2/listings/by-sku?site_id=${siteId}`,
        {
          method: 'DELETE',
          headers: { Authorization: token, 'Content-Type': 'application/json' },
          body: JSON.stringify({ skus: chunk }),
        }
      );
      if (r.ok) {
        removed += chunk.length;
        log(`[Remove] Deleted ${chunk.length} listing(s) — OK`);
      } else {
        // Fallback: if DELETE is not supported, zero stock instead
        const txt = await r.text().catch(() => '');
        log(`[Remove] DELETE HTTP ${r.status} — falling back to stock=0. Response: ${txt.slice(0, 200)}`);
        const fallback = await fetch(
          `https://api.onbuy.com/v2/listings/by-sku?site_id=${siteId}`,
          {
            method: 'PUT',
            headers: { Authorization: token, 'Content-Type': 'application/json' },
            body: JSON.stringify({ listings: chunk.map(sku => ({ sku, stock: 0 })) }),
          }
        );
        if (fallback.ok) {
          removed += chunk.length;
          log(`[Remove] Fallback stock=0 for ${chunk.length} SKU(s) — OK`);
        } else {
          log(`[Remove] Fallback also failed: HTTP ${fallback.status}`);
        }
      }
    } catch (err) {
      log(`[Remove] Error deleting listings: ${err.message}`);
    }
    if (i + CHUNK < skus.length) await new Promise(r => setTimeout(r, 500));
  }
  return removed;
}

// ── Core patrol logic ──────────────────────────────────────────────────────

async function patrolAccount(db, account, userId = null, { dbBrands = [], dbProducts = [] } = {}) {
  const log = makeLogger(account.account_name, userId);
  log(`[Compliance] ── Starting patrol for "${account.account_name}" ──`);

  const token = await getTokenForAccount(account, { log });
  if (!token) {
    log(`[Compliance] Could not get token — skipping account`);
    return { checked: 0, violations: 0, removed: 0 };
  }

  const siteId   = account.site_id || '2000';
  const listings = await fetchAllListings(token, siteId, log);
  log(`[Compliance] ${listings.length} listing(s) to check`);

  const violationSkus  = [];
  const violationLog   = [];

  for (const listing of listings) {
    const sku        = listing.sku || listing.seller_sku || listing.uid || null;
    const titleRaw   = listing.name || listing.title || listing.product_name || '(unknown)';
    const titleLower = titleRaw.toLowerCase();

    let { violation, type, reason } = checkListing(listing);

    // Also check admin-uploaded restricted brands (substring match, same as Delete Restricted Brands job)
    if (!violation && dbBrands.length) {
      const hit = dbBrands.find(b => titleLower.includes(b));
      if (hit) {
        violation = true;
        type      = 'RESTRICTED_BRAND';
        reason    = `Restricted brand "${hit}" found in listing title`;
      }
    }

    // Also check admin-uploaded restricted product keywords (substring match, same as Delete Restricted Products job)
    if (!violation && dbProducts.length) {
      const hit = dbProducts.find(pt => titleLower.includes(pt));
      if (hit) {
        violation = true;
        type      = 'RESTRICTED_PRODUCT';
        reason    = `Restricted product keyword "${hit}" found in listing title`;
      }
    }

    if (!violation) continue;

    log(`[VIOLATION] ${type.toUpperCase()} | SKU: ${sku} | "${titleRaw}" | ${reason}`);
    violationLog.push({ sku, title: titleRaw, type, reason });

    if (sku) violationSkus.push(sku);
  }

  let removed = 0;
  if (violationSkus.length > 0) {
    log(`[Compliance] Found ${violationSkus.length} violation(s) — setting stock=0…`);
    removed = await deleteListings(token, siteId, violationSkus, log);

    // Persist violations to DB for dashboard visibility
    for (const v of violationLog) {
      await db.query(
        `INSERT INTO compliance_violations
           (account_id, sku, title, violation_type, reason, actioned_at)
         VALUES ($1, $2, $3, $4, $5, NOW())
         ON CONFLICT (account_id, sku) DO UPDATE
           SET title = EXCLUDED.title,
               violation_type = EXCLUDED.violation_type,
               reason = EXCLUDED.reason,
               actioned_at = NOW()`,
        [account.id, v.sku, v.title, v.type, v.reason]
      ).catch(e => log(`[DB] Insert violation failed: ${e.message}`));
    }
  } else {
    log(`[Compliance] No violations found — account is clean`);
  }

  log(`[Compliance] Done: checked=${listings.length} violations=${violationLog.length} removed=${removed}`);
  return { checked: listings.length, violations: violationLog.length, removed };
}

export async function runComplianceJob(db, { userId = null, log = console.log } = {}) {
  if (userId && _runningUsers.has(userId)) {
    log(`[Compliance] Job already running for user ${userId} — skipping`);
    return;
  }
  if (userId) _runningUsers.add(userId);

  // Notify server that job is running
  if (redisPub && userId) {
    redisPub.publish('compliance:status', JSON.stringify({ userId, running: true })).catch(() => {});
  }

  const rootLog = userId
    ? makeLogger('_global', userId)
    : console.log;

  rootLog(`[Compliance] ══ Job started${userId ? ` for user ${userId}` : ' (all users)'} ══`);

  // Load admin-uploaded restricted lists (shared across all accounts)
  let dbBrands = [], dbProducts = [];
  try {
    const { rows: [admin] } = await db.query(`SELECT id FROM users WHERE role = 'super_admin' LIMIT 1`);
    if (admin) {
      const { rows: rb } = await db.query(`SELECT brand_name FROM restricted_brands WHERE user_id=$1`, [admin.id]);
      dbBrands = rb.map(r => r.brand_name.toLowerCase());
    }
    const { rows: rp } = await db.query(`SELECT title FROM restricted_products`);
    dbProducts = rp.map(r => r.title.toLowerCase());
    rootLog(`[Compliance] DB lists loaded: ${dbBrands.length} restricted brand(s), ${dbProducts.length} restricted product keyword(s)`);
  } catch (err) {
    rootLog(`[Compliance] Warning: could not load DB restricted lists — ${err.message}`);
  }

  const where = userId
    ? 'WHERE a.is_active = true AND a.compliance_enabled = true AND a.user_id = $1'
    : 'WHERE a.is_active = true AND a.compliance_enabled = true';
  const params = userId ? [userId] : [];

  let accounts;
  try {
    const res = await db.query(
      `SELECT a.* FROM onbuy_accounts a ${where} ORDER BY a.id`,
      params
    );
    accounts = res.rows;
  } catch (err) {
    rootLog(`[Compliance] DB query failed: ${err.message}`);
    if (userId) {
      _runningUsers.delete(userId);
      if (redisPub) {
        redisPub.publish('compliance:status', JSON.stringify({ userId, running: false })).catch(() => {});
        redisPub.publish(`compliance:log:${userId}`, JSON.stringify({ done: true })).catch(() => {});
      }
    }
    return;
  }

  rootLog(`[Compliance] ${accounts.length} account(s) to patrol`);
  let totalChecked = 0, totalViolations = 0, totalRemoved = 0;

  for (const account of accounts) {
    const effectiveUserId = userId ?? account.user_id;
    try {
      const result = await patrolAccount(db, account, effectiveUserId, { dbBrands, dbProducts });
      totalChecked    += result.checked;
      totalViolations += result.violations;
      totalRemoved    += result.removed;
    } catch (err) {
      rootLog(`[Compliance] Unhandled error for "${account.account_name}": ${err.message}`);
    }
  }

  rootLog(`[Compliance] ══ Job complete — checked=${totalChecked} violations=${totalViolations} removed=${totalRemoved} ══`);

  if (userId) {
    _runningUsers.delete(userId);
    if (redisPub) {
      redisPub.publish('compliance:status', JSON.stringify({ userId, running: false })).catch(() => {});
      redisPub.publish(`compliance:log:${userId}`, JSON.stringify({ done: true })).catch(() => {});
    }
  }
}

// ── Worker bootstrap ───────────────────────────────────────────────────────

export function startWorker() {
  const db = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: (process.env.NODE_ENV === 'production' && process.env.DB_SSL !== 'false')
      ? { rejectUnauthorized: false }
      : false,
  });

  // Ensure required columns and table exist
  db.query(`ALTER TABLE onbuy_accounts ADD COLUMN IF NOT EXISTS compliance_enabled BOOLEAN NOT NULL DEFAULT false`)
    .catch(() => {});

  db.query(`
    CREATE TABLE IF NOT EXISTS compliance_violations (
      id             SERIAL PRIMARY KEY,
      account_id     INTEGER NOT NULL,
      sku            TEXT,
      title          TEXT,
      violation_type TEXT,
      reason         TEXT,
      actioned_at    TIMESTAMP NOT NULL DEFAULT NOW(),
      UNIQUE (account_id, sku)
    )
  `).catch(() => {});

  // Redis publisher — streams logs and status to API server
  redisPub = new IORedis(process.env.REDIS_URL || 'redis://127.0.0.1:6379', {
    maxRetriesPerRequest: null,
    lazyConnect: true,
  });
  redisPub.connect().catch(() => {});

  // Redis subscriber — manual trigger + settings-updated reload
  const redisSub = new IORedis(process.env.REDIS_URL || 'redis://127.0.0.1:6379', {
    maxRetriesPerRequest: null,
  });
  redisSub.subscribe('compliance:run', 'compliance:settings-updated').catch(() => {});
  redisSub.on('message', (channel, message) => {
    if (channel === 'compliance:run') {
      const userId = parseInt(message) || null;
      console.log(`[Compliance] Manual run triggered${userId ? ` for user ${userId}` : ''}`);
      runComplianceJob(db, { userId }).catch(e =>
        console.error('[Compliance] Manual run error:', e.message)
      );
    } else if (channel === 'compliance:settings-updated') {
      refreshComplianceSchedules(db).catch(() => {});
    }
  });

  // Load per-user schedules (replaces the old fixed 02:00 cron)
  console.log('[Compliance] Started — loading per-user schedules…');
  refreshComplianceSchedules(db).catch(() => {
    // Fallback: daily at 02:00 for all users if schedule load fails
    cron.schedule('0 2 * * *', () => {
      console.log('[Compliance] ⏰ Fallback daily patrol starting…');
      runComplianceJob(db).catch(e => console.error('[Compliance] Fallback error:', e.message));
    });
  });
}

// Allow direct execution
const _thisFile = resolve(fileURLToPath(import.meta.url));
const _mainFile = process.argv[1] ? resolve(process.argv[1]) : '';
if (_thisFile === _mainFile || process.env.pm_id !== undefined) startWorker();
