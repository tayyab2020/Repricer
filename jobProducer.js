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

export async function getTokenForAccount(account) {
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

export async function runRepricerJob({ userId = null, log = null } = {}) {
  const jlog = log ?? ((...a) => console.log(`[${new Date().toISOString()}]`, ...a));
  jlog('\n' + '═'.repeat(60));
  jlog(`[Job] 🚀 Producer started at ${new Date().toISOString()}${userId ? ` (user ${userId})` : ''}`);
  jlog('═'.repeat(60));

  try {
    const userClause  = userId ? `AND pm.user_id = $1` : '';
    const queryParams = userId ? [userId] : [];

    const { rows: mappings } = await db.query(`
      SELECT pm.*,
             oa.consumer_key  AS acct_consumer_key,
             oa.secret_key    AS acct_secret_key,
             oa.site_id       AS acct_site_id,
             oa.account_name  AS acct_name
      FROM product_mappings pm
      LEFT JOIN onbuy_accounts oa
             ON pm.onbuy_account_id = oa.id AND oa.is_active = true
      WHERE pm.is_active = true ${userClause}
      ORDER BY pm.last_synced_at ASC NULLS FIRST
    `, queryParams);

    if (!mappings.length) {
      jlog('[Job] No active mappings. Exiting.');
      return;
    }
    jlog(`[Job] ${mappings.length} active mapping(s) to enqueue`);

    // Load settings for each user so workers can apply the correct fee/ROI/proxy per job
    const userIds = [...new Set(mappings.map(m => m.user_id).filter(Boolean))];
    const userSettingsMap = {};
    if (userIds.length) {
      const { rows: sRows } = await db.query(
        `SELECT user_id, key, value FROM settings WHERE user_id = ANY($1)`,
        [userIds]
      );
      for (const r of sRows) {
        if (!userSettingsMap[r.user_id]) userSettingsMap[r.user_id] = {};
        userSettingsMap[r.user_id][r.key] = r.value;
      }
    }

    const tokenCache = {}, siteCache = {}, credCache = {};
    for (const m of mappings) {
      const aid = m.onbuy_account_id;
      if (aid && !(aid in tokenCache)) {
        jlog(`[Job] Fetching token for "${m.acct_name}" (id=${aid})…`);
        credCache[aid]  = { consumerKey: m.acct_consumer_key, secretKey: m.acct_secret_key };
        tokenCache[aid] = await getTokenForAccount({
          account_name: m.acct_name,
          consumer_key: m.acct_consumer_key,
          secret_key:   m.acct_secret_key,
        });
        siteCache[aid] = m.acct_site_id || '2000';
        jlog(`[Job] Token for "${m.acct_name}": ${tokenCache[aid] ? '✅' : '❌'}`);
      }
    }

    let fallbackToken = null, fallbackSiteId = '2000', fallbackCreds = null;
    if (mappings.some(m => !m.onbuy_account_id)) {
      const { rows } = await db.query(
        `SELECT * FROM onbuy_accounts WHERE is_active = true ORDER BY id ASC LIMIT 1`
      );
      if (rows[0]) {
        fallbackCreds  = { consumerKey: rows[0].consumer_key, secretKey: rows[0].secret_key };
        fallbackToken  = await getTokenForAccount(rows[0]);
        fallbackSiteId = rows[0].site_id || '2000';
        jlog(`[Job] Fallback token: ${fallbackToken ? '✅' : '❌'}`);
      }
    }

    const jobs = [];
    let skippedNoToken = 0;

    for (const mapping of mappings) {
      const aid    = mapping.onbuy_account_id;
      const token  = aid ? tokenCache[aid] : fallbackToken;
      const siteId = aid ? siteCache[aid]  : fallbackSiteId;
      const creds  = aid ? credCache[aid]  : fallbackCreds;

      if (!token) { skippedNoToken++; continue; }

      const us = userSettingsMap[mapping.user_id] || {};
      const userSettings = {
        feeRate:       us.onbuy_fee_percent   ? parseFloat(us.onbuy_fee_percent)   / 100 : null,
        defaultRoi:    us.default_roi_percent ? parseFloat(us.default_roi_percent)        : null,
        minRoiPercent: us.min_roi_percent     ? parseFloat(us.min_roi_percent)            : null,
        proxyApiUrl:   us.webshare_proxy_api  || null,
      };

      jobs.push({
        name: 'scrape',
        data: { mapping, token, siteId, consumerKey: creds?.consumerKey, secretKey: creds?.secretKey, userSettings },
        opts: {
          jobId:            `fast-${mapping.id}`,
          removeOnComplete: true,
          removeOnFail:     { count: 100 },
          attempts:         2,
          backoff:          { type: 'fixed', delay: 15000 },
        },
      });
    }

    // Per-user sync: remove only this user's jobs so other users' jobs keep running.
    // Full sync (userId=null): drain all waiting/delayed jobs from both queues.
    // Active jobs are unaffected by remove/drain and will finish normally.
    if (userId) {
      await Promise.all(jobs.map(j => fastQueue.remove(j.opts.jobId).catch(() => {})));
    } else {
      await Promise.all([fastQueue.drain(), slowQueue.drain()]);
    }
    jlog('[Job] Queues drained — adding fresh jobs');

    const CHUNK = 500;
    for (let i = 0; i < jobs.length; i += CHUNK) {
      await fastQueue.addBulk(jobs.slice(i, i + CHUNK));
    }

    const [fastCounts, slowCounts] = await Promise.all([
      fastQueue.getJobCounts('waiting', 'active', 'delayed'),
      slowQueue.getJobCounts('waiting', 'active', 'delayed'),
    ]);

    jlog(`[Job] ✅ ${jobs.length} jobs enqueued${skippedNoToken ? ` (${skippedNoToken} skipped — no token)` : ''}`);
    jlog(`[Queue] fast → waiting:${fastCounts.waiting} active:${fastCounts.active} | slow → waiting:${slowCounts.waiting} active:${slowCounts.active}`);

  } catch (err) {
    jlog('[Job] 💀 Fatal error:', String(err));
  }
}
