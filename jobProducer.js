/**
 * jobProducer.js
 * ─────────────────────────────────────────────────────────────
 * Queue definitions + job producer only — NO workers, NO cron.
 * Imported by server.js (manual sync) and repricerJob.js (scheduled runs).
 */

import pg from 'pg';
import dotenv from 'dotenv';
import { Queue } from 'bullmq';
import IORedis from 'ioredis';

dotenv.config();

const { Pool } = pg;

const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

const redis = new IORedis(process.env.REDIS_URL || 'redis://127.0.0.1:6379', {
  maxRetriesPerRequest: null,
});

export const fastQueue = new Queue('repricer-fast', { connection: redis });
export const slowQueue  = new Queue('repricer-slow', { connection: redis });

async function getTokenForAccount(account) {
  try {
    const res = await fetch('https://api.onbuy.com/v2/auth/request-token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ consumer_key: account.consumer_key, secret_key: account.secret_key }),
    });
    const data = await res.json();
    const token = data.access_token || data.Result?.token || null;
    if (!token) console.error(`[Token] "${account.account_name}" — no token:`, JSON.stringify(data).slice(0, 200));
    return token;
  } catch (err) {
    console.error(`[Token] "${account.account_name}" fetch error:`, err.message);
    return null;
  }
}

export async function runRepricerJob() {
  console.log('\n' + '═'.repeat(60));
  console.log(`[Job] 🚀 Producer started at ${new Date().toISOString()}`);
  console.log('═'.repeat(60));

  try {
    const { rows: mappings } = await db.query(`
      SELECT pm.*,
             oa.consumer_key  AS acct_consumer_key,
             oa.secret_key    AS acct_secret_key,
             oa.site_id       AS acct_site_id,
             oa.account_name  AS acct_name
      FROM product_mappings pm
      LEFT JOIN onbuy_accounts oa
             ON pm.onbuy_account_id = oa.id AND oa.is_active = true
      WHERE pm.is_active = true
      ORDER BY pm.last_synced_at ASC NULLS FIRST
    `);

    if (!mappings.length) {
      console.log('[Job] No active mappings. Exiting.');
      return;
    }
    console.log(`[Job] ${mappings.length} active mapping(s) to enqueue`);

    const tokenCache = {}, siteCache = {};
    for (const m of mappings) {
      const aid = m.onbuy_account_id;
      if (aid && !(aid in tokenCache)) {
        console.log(`[Job] Fetching token for "${m.acct_name}" (id=${aid})…`);
        tokenCache[aid] = await getTokenForAccount({
          account_name: m.acct_name,
          consumer_key: m.acct_consumer_key,
          secret_key:   m.acct_secret_key,
        });
        siteCache[aid] = m.acct_site_id || '2000';
        console.log(`[Job] Token for "${m.acct_name}": ${tokenCache[aid] ? '✅' : '❌'}`);
      }
    }

    let fallbackToken = null, fallbackSiteId = '2000';
    if (mappings.some(m => !m.onbuy_account_id)) {
      const { rows } = await db.query(
        `SELECT * FROM onbuy_accounts WHERE is_active = true ORDER BY id ASC LIMIT 1`
      );
      if (rows[0]) {
        fallbackToken  = await getTokenForAccount(rows[0]);
        fallbackSiteId = rows[0].site_id || '2000';
        console.log(`[Job] Fallback token: ${fallbackToken ? '✅' : '❌'}`);
      }
    }

    const jobs = [];
    let skippedNoToken = 0;

    for (const mapping of mappings) {
      const aid    = mapping.onbuy_account_id;
      const token  = aid ? tokenCache[aid] : fallbackToken;
      const siteId = aid ? siteCache[aid]  : fallbackSiteId;

      if (!token) { skippedNoToken++; continue; }

      jobs.push({
        name: 'scrape',
        data: { mapping, token, siteId },
        opts: {
          jobId:            `fast-${mapping.id}`,
          removeOnComplete: true,
          removeOnFail:     { count: 100 },
          attempts:         2,
          backoff:          { type: 'fixed', delay: 15000 },
        },
      });
    }

    // Chunk into 500-job batches — a single addBulk with 43k items causes Redis
    // pipeline timeouts and silently drops most jobs past the first ~650.
    const CHUNK = 500;
    for (let i = 0; i < jobs.length; i += CHUNK) {
      await fastQueue.addBulk(jobs.slice(i, i + CHUNK));
    }

    const [fastCounts, slowCounts] = await Promise.all([
      fastQueue.getJobCounts('waiting', 'active', 'delayed'),
      slowQueue.getJobCounts('waiting', 'active', 'delayed'),
    ]);

    console.log(`[Job] ✅ ${jobs.length} jobs enqueued${skippedNoToken ? ` (${skippedNoToken} skipped — no token)` : ''}`);
    console.log(`[Queue] fast → waiting:${fastCounts.waiting} active:${fastCounts.active} | slow → waiting:${slowCounts.waiting} active:${slowCounts.active}`);

  } catch (err) {
    console.error('[Job] 💀 Fatal error:', err);
  }
}
