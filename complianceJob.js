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

// ── Logger ─────────────────────────────────────────────────────────────────

function makeLogger(accountName) {
  const logDir = path.join(__dirname, 'logs', 'compliance_logs');
  fs.mkdirSync(logDir, { recursive: true });
  const date     = new Date().toISOString().slice(0, 10);
  const safeName = (accountName || 'unknown').replace(/[^a-zA-Z0-9_-]/g, '_');
  const logFile  = path.join(logDir, `${safeName}_${date}.log`);
  return (msg) => {
    const line = `[${new Date().toISOString()}] ${msg}`;
    console.log(line);
    fs.appendFileSync(logFile, line + '\n');
  };
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

async function setStockZero(token, siteId, skus, log) {
  const CHUNK = 100;
  let removed = 0;
  for (let i = 0; i < skus.length; i += CHUNK) {
    const chunk = skus.slice(i, i + CHUNK);
    const payload = { listings: chunk.map(sku => ({ sku, stock: 0 })) };
    try {
      const r = await fetch(
        `https://api.onbuy.com/v2/listings/by-sku?site_id=${siteId}`,
        {
          method: 'PUT',
          headers: { Authorization: token, 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        }
      );
      if (r.ok) {
        removed += chunk.length;
        log(`[Remove] Set stock=0 for ${chunk.length} SKU(s) — OK`);
      } else {
        const txt = await r.text().catch(() => '');
        log(`[Remove] HTTP ${r.status} for SKU chunk — ${txt.slice(0, 200)}`);
      }
    } catch (err) {
      log(`[Remove] Error setting stock=0: ${err.message}`);
    }
    if (i + CHUNK < skus.length) await new Promise(r => setTimeout(r, 500));
  }
  return removed;
}

// ── Core patrol logic ──────────────────────────────────────────────────────

async function patrolAccount(db, account) {
  const log = makeLogger(account.account_name);
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
    const { violation, type, reason } = checkListing(listing);
    if (!violation) continue;

    const sku   = listing.sku || listing.seller_sku || listing.uid || null;
    const title = listing.name || listing.title || listing.product_name || '(unknown)';

    log(`[VIOLATION] ${type.toUpperCase()} | SKU: ${sku} | "${title}" | ${reason}`);
    violationLog.push({ sku, title, type, reason });

    if (sku) violationSkus.push(sku);
  }

  let removed = 0;
  if (violationSkus.length > 0) {
    log(`[Compliance] Found ${violationSkus.length} violation(s) — setting stock=0…`);
    removed = await setStockZero(token, siteId, violationSkus, log);

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
  log(`[Compliance] ══ Job started${userId ? ` for user ${userId}` : ' (all users)'} ══`);

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
    log(`[Compliance] DB query failed: ${err.message}`);
    return;
  }

  log(`[Compliance] ${accounts.length} account(s) to patrol`);
  let totalChecked = 0, totalViolations = 0, totalRemoved = 0;

  for (const account of accounts) {
    try {
      const result = await patrolAccount(db, account);
      totalChecked    += result.checked;
      totalViolations += result.violations;
      totalRemoved    += result.removed;
    } catch (err) {
      log(`[Compliance] Unhandled error for "${account.account_name}": ${err.message}`);
    }
  }

  log(`[Compliance] ══ Job complete — checked=${totalChecked} violations=${totalViolations} removed=${totalRemoved} ══`);
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
  db.query(`ALTER TABLE onbuy_accounts ADD COLUMN IF NOT EXISTS compliance_enabled BOOLEAN NOT NULL DEFAULT true`)
    .catch(() => {});

  db.query(`
    CREATE TABLE IF NOT EXISTS compliance_violations (
      id            SERIAL PRIMARY KEY,
      account_id    INTEGER NOT NULL,
      sku           TEXT,
      title         TEXT,
      violation_type TEXT,
      reason        TEXT,
      actioned_at   TIMESTAMP NOT NULL DEFAULT NOW(),
      UNIQUE (account_id, sku)
    )
  `).catch(() => {});

  // Redis pub/sub: manual trigger via publish('compliance:run', userId)
  const redisSub = new IORedis(process.env.REDIS_URL || 'redis://127.0.0.1:6379', {
    maxRetriesPerRequest: null,
  });
  redisSub.subscribe('compliance:run').catch(() => {});
  redisSub.on('message', (channel, message) => {
    if (channel !== 'compliance:run') return;
    const userId = parseInt(message) || null;
    console.log(`[Compliance] Manual run triggered${userId ? ` for user ${userId}` : ''}`);
    runComplianceJob(db, { userId }).catch(e =>
      console.error('[Compliance] Manual run error:', e)
    );
  });

  // Daily at 02:00 — runs across all active accounts
  console.log('[Compliance] Started — patrolling daily at 02:00');
  cron.schedule('0 2 * * *', () => {
    console.log('[Compliance] ⏰ Scheduled daily patrol starting…');
    runComplianceJob(db).catch(e => console.error('[Compliance] Scheduled run error:', e));
  });
}

// Allow direct execution
const _thisFile = resolve(fileURLToPath(import.meta.url));
const _mainFile = process.argv[1] ? resolve(process.argv[1]) : '';
if (_thisFile === _mainFile || process.env.pm_id !== undefined) startWorker();
