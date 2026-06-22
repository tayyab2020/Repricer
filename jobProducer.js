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
  keepAlive: true,                  // TCP keepalives prevent the server from silently dropping idle connections
  connectionTimeoutMillis: 30_000,  // fail fast if the DB is unreachable rather than hanging forever
});

export const redis = new IORedis(process.env.REDIS_URL || 'redis://127.0.0.1:6379', {
  maxRetriesPerRequest: null,
});

export const fastQueue        = new Queue('repricer-fast',  { connection: redis });
export const slowQueue        = new Queue('repricer-slow',  { connection: redis });
export const keepaQueue       = new Queue('keepa-scrape',   { connection: redis });
export const queuePollerQueue = new Queue('queue-poller',   { connection: redis });
export const bulkImportQueue    = new Queue('bulk-import',    { connection: redis });
export const deleteBrandsQueue  = new Queue('delete-brands',  { connection: redis });

export async function getTokenForAccount(account, { retries = 2, log = null } = {}) {
  const label = account.account_name || `id=${account.id}`;
  const emit  = log ?? console.error;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res  = await fetch('https://api.onbuy.com/v2/auth/request-token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ consumer_key: account.consumer_key, secret_key: account.secret_key }),
      });
      const text = await res.text();
      let data;
      try { data = JSON.parse(text); } catch { data = {}; }
      const token = data.access_token || data.Result?.token || null;
      if (token) return token;
      const reason = `HTTP ${res.status} — ${text.slice(0, 200)}`;
      if (attempt < retries) {
        emit(`[Token] "${label}" — no token (attempt ${attempt + 1}/${retries + 1}): ${reason} — retrying in ${(attempt + 1) * 2}s…`);
        await new Promise(r => setTimeout(r, (attempt + 1) * 2000));
      } else {
        emit(`[Token] "${label}" — no token after ${retries + 1} attempt(s): ${reason}`);
      }
    } catch (err) {
      if (attempt < retries) {
        emit(`[Token] "${label}" — fetch error (attempt ${attempt + 1}/${retries + 1}): ${err.message} — retrying in ${(attempt + 1) * 2}s…`);
        await new Promise(r => setTimeout(r, (attempt + 1) * 2000));
      } else {
        emit(`[Token] "${label}" — fetch error after ${retries + 1} attempt(s): ${err.message}`);
      }
    }
  }
  return null;
}

// ─────────────────────────────────────────────
// LISTING SYNC
// Fetch all seller listings from OnBuy (paginated by 1000) and upsert them
// into product_mappings so the repricer always works on current store state.
// ─────────────────────────────────────────────

async function fetchAllListingsForAccount(token, siteId, log) {
  const allListings = [];
  let offset = 0;
  const limit = 1000;

  while (true) {
    try {
      const url = `https://api.onbuy.com/v2/listings?site_id=${siteId}&limit=${limit}&offset=${offset}`;
      const r = await fetch(url, { headers: { Authorization: token } });
      if (!r.ok) {
        log(`[ListingSync] OnBuy listings API error: HTTP ${r.status}`);
        break;
      }
      const data = await r.json().catch(() => ({}));
      const results = Array.isArray(data) ? data : (data.results ?? data.payload ?? data.listings ?? []);
      if (!results.length) break;

      allListings.push(...results);
      log(`[ListingSync] Fetched page offset=${offset}: ${results.length} listings (total so far: ${allListings.length})`);

      if (results.length < limit) break;
      const total = data.total ?? data.count ?? null;
      if (total !== null && allListings.length >= total) break;

      offset += limit;
      await new Promise(r => setTimeout(r, 300));
    } catch (err) {
      log(`[ListingSync] Fetch error at offset=${offset}: ${err.message}`);
      break;
    }
  }

  return allListings;
}

async function syncAccountListings(account, db, log) {
  const label     = account.account_name || `id=${account.id}`;
  const userId    = account.user_id;
  const accountId = account.id;
  const siteId    = account.site_id || '2000';

  const token = await getTokenForAccount(account, { log });
  if (!token) {
    log(`[ListingSync] ⚠️  No token for "${label}" — skipping`);
    return;
  }

  let defaultRoi = 20;
  try {
    const { rows: sRows } = await db.query(
      `SELECT value FROM settings WHERE user_id = $1 AND key = 'default_roi_percent' LIMIT 1`,
      [userId]
    );
    if (sRows[0]?.value) defaultRoi = parseFloat(sRows[0].value);
  } catch {}

  const listings = await fetchAllListingsForAccount(token, siteId, log);
  if (!listings.length) {
    log(`[ListingSync] "${label}" — no listings returned`);
    return;
  }
  log(`[ListingSync] "${label}" — ${listings.length} listing(s) to sync`);

  const skus = [...new Set(listings.map(l => l.sku).filter(Boolean))];
  const { rows: existing } = await db.query(
    `SELECT id, onbuy_sku FROM product_mappings
     WHERE onbuy_account_id = $1 AND user_id = $2 AND onbuy_sku = ANY($3)`,
    [accountId, userId, skus]
  );
  const existingSkuMap = new Map(existing.map(r => [r.onbuy_sku, r.id]));

  const toUpdate = [];
  const toInsert = [];

  for (const listing of listings) {
    const sku = listing.sku;
    if (!sku) continue;

    const uid   = String(listing.uid || listing.listing_uid || listing.id || listing.product_listing_id || '').trim();
    const opc   = String(listing.opc || listing.product_encoded_id || '').trim();
    const name  = String(listing.name || listing.product_name || listing.title || '').trim();
    const price = listing.price != null ? parseFloat(listing.price) : null;

    if (existingSkuMap.has(sku)) {
      toUpdate.push({ id: existingSkuMap.get(sku), uid, opc, name, price });
    } else {
      toInsert.push({ sku, uid, opc, name, price });
    }
  }

  const CHUNK = 1000;

  for (let i = 0; i < toUpdate.length; i += CHUNK) {
    const c = toUpdate.slice(i, i + CHUNK);
    await db.query(`
      UPDATE product_mappings pm SET
        onbuy_listing_id = CASE WHEN v.uid  <> '' THEN v.uid  ELSE pm.onbuy_listing_id END,
        onbuy_opc        = CASE WHEN v.opc  <> '' THEN v.opc  ELSE pm.onbuy_opc        END,
        product_name     = CASE WHEN v.name <> '' THEN v.name ELSE pm.product_name      END,
        last_onbuy_price = CASE WHEN v.price <> '' THEN v.price::decimal ELSE pm.last_onbuy_price END
      FROM (
        SELECT unnest($1::int[])  AS id,
               unnest($2::text[]) AS uid,
               unnest($3::text[]) AS opc,
               unnest($4::text[]) AS name,
               unnest($5::text[]) AS price
      ) v
      WHERE pm.id = v.id
    `, [
      c.map(r => r.id),
      c.map(r => r.uid),
      c.map(r => r.opc),
      c.map(r => r.name),
      c.map(r => r.price != null ? String(r.price) : ''),
    ]);
  }

  for (let i = 0; i < toInsert.length; i += CHUNK) {
    const c = toInsert.slice(i, i + CHUNK);
    await db.query(`
      INSERT INTO product_mappings
        (user_id, onbuy_account_id, onbuy_sku, primary_asin,
         onbuy_listing_id, onbuy_opc, product_name, last_onbuy_price,
         markup_type, markup_value, markup_is_explicit, is_active)
      SELECT
        $6::int,
        $7::int,
        v.sku,
        v.sku,
        NULLIF(v.uid, ''),
        NULLIF(v.opc, ''),
        NULLIF(v.name, ''),
        NULLIF(v.price, '')::decimal,
        'roi',
        $8::decimal,
        false,
        true
      FROM (
        SELECT unnest($1::text[]) AS sku,
               unnest($2::text[]) AS uid,
               unnest($3::text[]) AS opc,
               unnest($4::text[]) AS name,
               unnest($5::text[]) AS price
      ) v
    `, [
      c.map(r => r.sku),
      c.map(r => r.uid),
      c.map(r => r.opc),
      c.map(r => r.name),
      c.map(r => r.price != null ? String(r.price) : ''),
      userId,
      accountId,
      defaultRoi,
    ]);
  }

  log(`[ListingSync] "${label}" — updated ${toUpdate.length}, inserted ${toInsert.length}`);
}

export async function runRepricerJob({ userId = null, accountId = null, mappingIds = null, log = null, skipKeepa = false, skipCounter = false, fromKeepaFlush = false, onlyUnsynced = false } = {}) {
  const jlog = log ?? ((...a) => console.log(`[${new Date().toISOString()}]`, ...a));
  jlog('\n' + '═'.repeat(60));
  jlog(`[Job] 🚀 Producer started at ${new Date().toISOString()}${userId ? ` (user ${userId})` : ''}${accountId ? ` (account ${accountId})` : ''}${mappingIds?.length ? ` — retrying ${mappingIds.length} mapping(s)` : ''}${onlyUnsynced ? ' — unsynced-only' : ''}`);
  jlog('═'.repeat(60));

  try {
    // ── Step 0: Sync listings from OnBuy ─────────────────────────────────────
    // Skip for targeted retries (mappingIds) and Keepa-flush calls — those work
    // on an already-known set of mappings and don't need a fresh store sync.
    if (!mappingIds?.length && !fromKeepaFlush) {
      jlog('[ListingSync] Fetching all listings from OnBuy store(s)…');
      try {
        const acctWhere  = userId    ? 'WHERE is_active = true AND user_id = $1'
                         : accountId ? 'WHERE is_active = true AND id = $1'
                         :             'WHERE is_active = true';
        const acctParams = (userId || accountId) ? [userId ?? accountId] : [];
        const { rows: syncAccounts } = await db.query(
          `SELECT * FROM onbuy_accounts ${acctWhere} ORDER BY id`, acctParams
        );
        for (const acct of syncAccounts) {
          await syncAccountListings(acct, db, jlog);
        }
      } catch (syncErr) {
        jlog(`[ListingSync] ⚠️  Sync error (continuing to reprice): ${syncErr.message}`);
      }
    }

    const conditions  = ['pm.is_active = true'];
    const queryParams = [];
    if (userId) {
      queryParams.push(userId);
      conditions.push(`pm.user_id = $${queryParams.length}`);
    }
    if (accountId) {
      queryParams.push(accountId);
      conditions.push(`pm.onbuy_account_id = $${queryParams.length}`);
    }
    if (mappingIds?.length) {
      queryParams.push(mappingIds);
      conditions.push(`pm.id = ANY($${queryParams.length})`);
    }
    if (onlyUnsynced) {
      conditions.push('pm.last_synced_at IS NULL');
    }

    const { rows: mappings } = await db.query(`
      SELECT pm.id,
             pm.user_id,
             pm.onbuy_account_id,
             pm.primary_asin,
             pm.onbuy_sku,
             pm.onbuy_listing_id,
             pm.onbuy_opc,
             pm.markup_type,
             pm.markup_value,
             pm.markup_is_explicit,
             pm.min_price,
             pm.last_amazon_price,
             pm.last_onbuy_price,
             pm.amazon_in_stock,
             pm.product_name,
             pm.is_active,
             pm.last_synced_at,
             oa.consumer_key     AS acct_consumer_key,
             oa.secret_key       AS acct_secret_key,
             oa.site_id          AS acct_site_id,
             oa.account_name     AS acct_name,
             oa.keepa_email      AS acct_keepa_email,
             oa.keepa_password   AS acct_keepa_password,
             oa.enable_puppeteer AS acct_enable_puppeteer,
             oa.enable_twister   AS acct_enable_twister,
             oa.enable_cheerio   AS acct_enable_cheerio
      FROM product_mappings pm
      LEFT JOIN onbuy_accounts oa
             ON pm.onbuy_account_id = oa.id AND oa.is_active = true
      WHERE ${conditions.join(' AND ')}
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

    // Query the most recent repricer completion per (user, account) so we can detect whether
    // pricing settings changed after the last run and force-reprice all listings if so.
    const lastRepricedMap = {};
    if (userIds.length) {
      const { rows: lrRows } = await db.query(
        `SELECT user_id, onbuy_account_id, MAX(last_repriced_at) AS last_repriced_at
         FROM daily_sync_stats WHERE user_id = ANY($1)
         GROUP BY user_id, onbuy_account_id`,
        [userIds]
      );
      for (const r of lrRows) {
        lastRepricedMap[`${r.user_id}:${r.onbuy_account_id}`] = r.last_repriced_at;
      }
    }

    // ── Keepa pre-fetch phase ─────────────────────────────────────────────────
    // Enqueue one keepa-scrape job per OnBuy account that has Keepa credentials.
    // Each job runs sequentially (concurrency: 1), fetches prices for that account's
    // ASINs, stores them in Redis (keepa:prices:{accountId}), then calls
    // runRepricerJob({ accountId, skipKeepa: true }) so pricing starts for that
    // account immediately — while the next account's Keepa job is still pending.
    // Accounts without Keepa credentials proceed directly to pricing below.
    let pricingMappings = mappings;
    if (!skipKeepa && !mappingIds) {
      const keepaAccountIds = new Set();
      const accountKeepaMap = new Map(); // accountId → [mappings]

      for (const m of mappings) {
        if (m.onbuy_account_id && m.acct_keepa_email && m.acct_keepa_password) {
          if (!accountKeepaMap.has(m.onbuy_account_id)) accountKeepaMap.set(m.onbuy_account_id, []);
          accountKeepaMap.get(m.onbuy_account_id).push(m);
          keepaAccountIds.add(m.onbuy_account_id);
        }
      }

      jlog(`[Job][DEBUG] skipKeepa=${skipKeepa} accountsWithKeepa=${accountKeepaMap.size} mappingIds=${mappingIds?.length ?? 'null'}`);

      for (const [aid, acctMappings] of accountKeepaMap) {
        const acct      = acctMappings[0];
        const jobUserId = userId ?? acct.user_id;
        const uniqueAsins = [...new Set(acctMappings.map(m => m.primary_asin).filter(Boolean))];

        // Build ASIN → [mappingId] map so the Keepa worker can flush pricing per-batch
        const asinToMappingIds = {};
        for (const m of acctMappings) {
          if (!m.primary_asin) continue;
          if (!asinToMappingIds[m.primary_asin]) asinToMappingIds[m.primary_asin] = [];
          asinToMappingIds[m.primary_asin].push(m.id);
        }

        jlog(`[Job] Keepa job for "${acct.acct_name}" (account ${aid}) — ${uniqueAsins.length} ASINs`);

        // Skip if a quota-refill job is already pending for this user — the KeepaWorker
        // sets this key (with TTL) when quota runs out and clears it when fully done.
        const refillPending = await redis.get(`keepa:refill-pending:${jobUserId}`);
        if (refillPending) {
          jlog(`[Job] Skipping Keepa job for account ${aid} — quota refill in progress, next run already scheduled`);
          continue;
        }

        const beforeCounts = await keepaQueue.getJobCounts('waiting', 'active', 'delayed', 'completed', 'failed');
        jlog(`[Job][DEBUG] keepa queue BEFORE add (account ${aid}): ${JSON.stringify(beforeCounts)}`);

        const addedJob = await keepaQueue.add('prefetch', {
          userId: jobUserId,
          accountId: aid,
          asins: uniqueAsins,
          asinToMappingIds,
          keepaEmail:    acct.acct_keepa_email,
          keepaPassword: acct.acct_keepa_password,
        }, {
          jobId:            `keepa-${aid}`,  // one active job per account — deduplicates concurrent runs
          removeOnComplete: true,
          removeOnFail:     true,
          attempts:         1,
        });

        const afterCounts = await keepaQueue.getJobCounts('waiting', 'active', 'delayed', 'completed', 'failed');
        const jobState = await addedJob.getState().catch(() => 'unknown');
        jlog(`[Job][DEBUG] keepa queue AFTER add (account ${aid}): ${JSON.stringify(afterCounts)}`);
        jlog(`[Job][DEBUG] addedJob.id=${addedJob.id} state=${jobState}`);

        // Set sidebar counter immediately so the UI shows "Jobs Running..." even while this
        // job is queued/waiting (keepaWorker.on('active') only fires when the job actually starts).
        // NX: don't overwrite if a counter is already set by an active job for this user.
        const queueTtl = (Math.ceil(uniqueAsins.length / 1800) + 6) * 3600;
        redis.set(`repricer:running:${jobUserId}`, uniqueAsins.length, 'EX', queueTtl, 'NX').catch(() => {});
      }

      if (keepaAccountIds.size > 0) {
        // Exclude keepa-managed mappings — their pricing is triggered by the keepa worker
        const nonKeepaMappings = mappings.filter(m => !keepaAccountIds.has(m.onbuy_account_id));
        if (nonKeepaMappings.length === 0) {
          jlog(`[Job] All ${mappings.length} mappings handled by ${accountKeepaMap.size} Keepa job(s) — pricing will follow per account`);
          return;
        }
        jlog(`[Job] ${accountKeepaMap.size} Keepa job(s) queued. Enqueuing ${nonKeepaMappings.length} non-Keepa mapping(s) directly.`);
        pricingMappings = nonKeepaMappings;
      }
    }
    jlog(`[Job][DEBUG] Proceeding to pricing job enqueue for ${pricingMappings.length} mapping(s)`);

    const tokenCache = {}, siteCache = {}, credCache = {};
    for (const m of pricingMappings) {
      const aid = m.onbuy_account_id;
      if (aid && !(aid in tokenCache)) {
        if (!m.acct_consumer_key || !m.acct_secret_key) {
          jlog(`[Job] ⚠️  Account id=${aid} not found or inactive — skipping its mappings`);
          tokenCache[aid] = null;  // mark as checked so we don't log again
          continue;
        }
        jlog(`[Job] Fetching token for "${m.acct_name}" (id=${aid})…`);
        credCache[aid]  = { consumerKey: m.acct_consumer_key, secretKey: m.acct_secret_key };
        tokenCache[aid] = await getTokenForAccount({
          account_name: m.acct_name,
          consumer_key: m.acct_consumer_key,
          secret_key:   m.acct_secret_key,
        }, { log: jlog });
        siteCache[aid] = m.acct_site_id || '2000';
        jlog(`[Job] Token for "${m.acct_name}" (id=${aid}): ${tokenCache[aid] ? '✅' : '❌'}`);
      }
    }

    let fallbackToken = null, fallbackSiteId = '2000', fallbackCreds = null;
    if (pricingMappings.some(m => !m.onbuy_account_id)) {
      const { rows } = await db.query(
        `SELECT * FROM onbuy_accounts WHERE is_active = true ORDER BY id ASC LIMIT 1`
      );
      if (rows[0]) {
        fallbackCreds  = { consumerKey: rows[0].consumer_key, secretKey: rows[0].secret_key };
        fallbackToken  = await getTokenForAccount(rows[0], { log: jlog });
        fallbackSiteId = rows[0].site_id || '2000';
        jlog(`[Job] Fallback token: ${fallbackToken ? '✅' : '❌'}`);
      }
    }

    // Guard: skip repricing for any user who has a delete-brands job running
    const pricingUserIds = [...new Set(pricingMappings.map(m => m.user_id).filter(Boolean))];
    if (pricingUserIds.length) {
      const { rows: deletingUsers } = await db.query(
        `SELECT DISTINCT user_id FROM onbuy_delete_brand_jobs WHERE user_id = ANY($1) AND status = 'running'`,
        [pricingUserIds]
      );
      if (deletingUsers.length) {
        const blocked = new Set(deletingUsers.map(r => r.user_id));
        const before  = pricingMappings.length;
        pricingMappings = pricingMappings.filter(m => !blocked.has(m.user_id));
        jlog(`[Job] ⚠️  Skipped repricing for ${before - pricingMappings.length} mapping(s) — Delete Restricted Brands job running for user(s): ${[...blocked].join(', ')}`);
      }
    }

    const jobs = [];
    let skippedNoToken = 0;

    for (const mapping of pricingMappings) {
      const aid    = mapping.onbuy_account_id;
      const token  = aid ? tokenCache[aid] : fallbackToken;
      const siteId = aid ? siteCache[aid]  : fallbackSiteId;
      const creds  = aid ? credCache[aid]  : fallbackCreds;

      if (!token) { skippedNoToken++; continue; }

      const us = userSettingsMap[mapping.user_id] || {};
      const pricingUpdatedAt = us.pricing_settings_updated_at || null;
      const lastRepriced     = lastRepricedMap[`${mapping.user_id}:${mapping.onbuy_account_id ?? 0}`] ?? null;
      const forceReprice     = !!(pricingUpdatedAt && (!lastRepriced || new Date(pricingUpdatedAt) > new Date(lastRepriced)));
      const userSettings = {
        feeRate:          us.onbuy_fee_percent   ? parseFloat(us.onbuy_fee_percent)   / 100 : null,
        defaultRoi:       us.default_roi_percent ? parseFloat(us.default_roi_percent)        : null,
        minRoiPercent:    us.min_roi_percent     ? parseFloat(us.min_roi_percent)            : null,
        proxyApiUrl:      us.webshare_proxy_api  || null,
        enablePuppeteer:  mapping.acct_enable_puppeteer === true,
        enableTwister:    mapping.acct_enable_twister   === true,
        enableCheerio:    mapping.acct_enable_cheerio   === true,
        forceReprice,
      };

      jobs.push({
        name: 'scrape',
        data: { mapping, token, siteId, consumerKey: creds?.consumerKey, secretKey: creds?.secretKey, userSettings, fromKeepaFlush },
        opts: {
          jobId:            `fast-${mapping.id}`,
          removeOnComplete: true,
          removeOnFail:     true,
          attempts:         2,
          backoff:          { type: 'fixed', delay: 15000 },
        },
      });
    }

    // Per-user or per-account sync: remove only relevant jobs so others keep running.
    // Full sync (userId=null, accountId=null): drain all waiting/delayed jobs from both queues.
    // Active jobs are unaffected by remove/drain and will finish normally.
    if (userId || accountId) {
      await Promise.all(jobs.map(j => fastQueue.remove(j.opts.jobId).catch(() => {})));
    } else {
      // Global sync: drain all three queues so stale keepa/refill/pricing jobs are cleared
      await Promise.all([
        fastQueue.drain(),
        slowQueue.drain(),
        keepaQueue.drain(),
        keepaQueue.clean(0, 1000, 'delayed').catch(() => {}),  // also clear delayed refill jobs
      ]);
    }
    jlog('[Job] Queues drained — adding fresh jobs');

    const CHUNK = 500;
    for (let i = 0; i < jobs.length; i += CHUNK) {
      await fastQueue.addBulk(jobs.slice(i, i + CHUNK));
    }

    // Stamp last_repriced_at for each (user, account) pair that had jobs enqueued.
    // This is read on the next run to decide whether pricing settings changed since
    // the last run and a force-reprice is needed. Must be written AFTER forceReprice
    // was already computed above, so the current run's flag is unaffected.
    const enqueuedAccounts = new Set();
    for (const j of jobs) {
      const uid = j.data.mapping.user_id;
      const aid = j.data.mapping.onbuy_account_id ?? 0;
      if (uid) enqueuedAccounts.add(`${uid}:${aid}`);
    }
    for (const key of enqueuedAccounts) {
      const [eUid, eAid] = key.split(':').map(Number);
      db.query(
        `INSERT INTO daily_sync_stats (user_id, onbuy_account_id, date, last_repriced_at)
         VALUES ($1, $2, CURRENT_DATE, NOW())
         ON CONFLICT (user_id, onbuy_account_id, date) DO UPDATE SET last_repriced_at = NOW()`,
        [eUid, eAid]
      ).catch(() => {});
    }

    // Write per-user running counts — skipped for Keepa-flush calls because the
    // Keepa worker manages the counter via DECRBY and setting it here would overwrite it.
    if (!skipCounter) {
      const userCounts = {};
      for (const j of jobs) {
        const uid = j.data.mapping.user_id;
        if (uid) userCounts[uid] = (userCounts[uid] || 0) + 1;
      }
      for (const [uid, count] of Object.entries(userCounts)) {
        redis.set(`repricer:running:${uid}`, count, 'EX', 14400).catch(() => {});
      }
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
