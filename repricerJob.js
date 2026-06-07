/**
 * repricerJob.js
 * ─────────────────────────────────────────────────────────────
 * BullMQ worker-pool re-pricer.
 *
 * Architecture:
 *   ┌──────────────────────────────────────────────────────┐
 *   │                   Redis Job Queues                   │
 *   │  repricer-fast  Twister API + Cheerio  (no browser)  │
 *   │  repricer-slow  Puppeteer fallback     (browser)     │
 *   └──────────────────────┬───────────────────────────────┘
 *                          │
 *          ┌───────────────┴────────────────┐
 *          │ Fast workers  ×FAST_WORKERS     │  high concurrency, I/O bound
 *          │ Slow workers  ×SLOW_WORKERS     │  lower concurrency, CPU/RAM heavy
 *          └────────────────────────────────┘
 *
 * Env vars:
 *   REDIS_URL      Redis connection string  (default: redis://127.0.0.1:6379)
 *   FAST_WORKERS   Fast-queue concurrency   (default: 20)
 *   SLOW_WORKERS   Slow-queue concurrency   (default: 5)
 *
 * Install deps:
 *   npm install bullmq ioredis node-cron pg dotenv
 */

import cron from 'node-cron';
import pg from 'pg';
import dotenv from 'dotenv';
import { Worker } from 'bullmq';
import IORedis from 'ioredis';
import https from 'https';
import { appendFileSync, mkdirSync, existsSync, statSync, renameSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { scrapeProductFast, scrapeProductSlow, setProxyApiUrl, jobContext } from './amazonScraper.js';
import { runRepricerJob, fastQueue, slowQueue, keepaQueue, queuePollerQueue, bulkImportQueue, getTokenForAccount } from './jobProducer.js';
import { getKeepaPrice, createKeepaSession } from './keepaScraper.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);
export const LOGS_DIR = join(__dirname, 'logs');
try { mkdirSync(LOGS_DIR, { recursive: true }); } catch {}

// Rotating log writer — keeps only today's log + one previous-day log per file.
// On first write of a new day: current → previous (overwriting older previous), then write fresh.
function rotatingAppend(filePath, line) {
  try {
    if (existsSync(filePath)) {
      const mtime = statSync(filePath).mtime;
      const fileDay = `${mtime.getFullYear()}-${mtime.getMonth()}-${mtime.getDate()}`;
      const now     = new Date();
      const today   = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}`;
      if (fileDay !== today) {
        const prev = filePath.replace(/\.log$/, '-previous.log');
        try { renameSync(filePath, prev); } catch {}
      }
    }
    appendFileSync(filePath, line, 'utf8');
  } catch {}
}

// Prevent unhandled errors from crashing the worker process.
// BullMQ and IORedis can throw outside of any try-catch (e.g. network events).
process.on('uncaughtException',   (err) => console.error(`[Worker] uncaughtException: ${err.stack || err}`));
process.on('unhandledRejection',  (err) => console.error(`[Worker] unhandledRejection: ${err?.stack || err}`));

const { Pool } = pg;

// ─────────────────────────────────────────────
// DATABASE
// ─────────────────────────────────────────────

const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

// ─────────────────────────────────────────────
// REDIS  (BullMQ requires maxRetriesPerRequest: null)
// ─────────────────────────────────────────────

const redis = new IORedis(process.env.REDIS_URL || 'redis://127.0.0.1:6379', {
  maxRetriesPerRequest: null,
});

// Separate connection for pub/sub (Redis requires a dedicated connection for subscriptions)
const redisSub = new IORedis(process.env.REDIS_URL || 'redis://127.0.0.1:6379', {
  maxRetriesPerRequest: null,
});

const FAST_CONCURRENCY = parseInt(process.env.FAST_WORKERS ?? '20');
const SLOW_CONCURRENCY = parseInt(process.env.SLOW_WORKERS ?? '5');

// Keepa Pro quota: 100% = 36 000 products, refills at 5%/hr = 1 800 products/hr
const KEEPA_QUOTA_FULL  = 36_000;
const KEEPA_HOURLY_FILL =  1_800;

// Timestamped console.log — keeps live-logs timestamps accurate for lines
// that don't come from amazonScraper.js (which adds its own timestamps).
const wlog = (...args) => console.log(`[${new Date().toISOString()}]`, ...args);

// Write a timestamped line to the per-user log file so each user's Live Logs
// page only shows their own jobs.  Silently swallowed on I/O error.
function logToUser(userId, ...args) {
  if (!userId) return;
  const msg  = args.map(a => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ');
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  rotatingAppend(join(LOGS_DIR, `user-${userId}.log`), line);
}

// Log to stdout AND the user file at once.
function ulog(userId, ...args) {
  wlog(...args);
  logToUser(userId, ...args);
}

// ─────────────────────────────────────────────
// ONBUY RATE-LIMITED BATCH UPDATER
// OnBuy allows max 240 PUT requests/hour.
// This class batches up to 50 listings per PUT
// and enforces a 200/hr ceiling (20-request buffer).
// All flushes serialize through a promise mutex so
// the sliding-window rate limiter is never raced.
// ─────────────────────────────────────────────

class OnBuyUpdater {
  constructor({ maxBatch = 1000, maxPerHour = 200 } = {}) {
    this._maxBatch     = maxBatch;
    this._maxPerHour   = maxPerHour;
    this._batches      = new Map(); // key → [{ token, siteId, identifier, isSku, price, resolve, reject }]
    this._timers       = new Map(); // key → timer id
    this._stockBatches = new Map(); // key → [{ token, siteId, identifier, isSku, stock, resolve, reject }]
    this._stockTimers  = new Map(); // key → timer id (30-second window)
    this._rrTs         = [];        // timestamps of sent requests (sliding 1-hour window)
    this._mutex        = Promise.resolve(); // serialises all batch flushes
    this._creds        = new Map(); // token → { consumerKey, secretKey } for refresh on 401
    this._tokenMap     = new Map(); // oldToken → newToken (redirect after 401 refresh)
  }

  // Follow the redirect chain so stale tokens from job.data are silently
  // upgraded to the current token without hitting a 401 on every batch.
  _resolveToken(token) {
    let t = token;
    const seen = new Set();
    while (this._tokenMap.has(t) && !seen.has(t)) { seen.add(t); t = this._tokenMap.get(t); }
    return t;
  }

  enqueue(rawToken, siteId, identifier, isSku, price, { consumerKey, secretKey, amazonPrice = null, mappingId = null, minPrice = null, feeRate = null, minRoiPercent = null, userId = null, noChangeEnqueue = false } = {}) {
    return new Promise((resolve, reject) => {
      const token = this._resolveToken(rawToken);
      const key   = `${token}||${siteId}||${isSku ? '1' : '0'}`;
      if (!this._batches.has(key)) this._batches.set(key, []);
      const batch = this._batches.get(key);
      // Store consumerKey/secretKey directly in the item so they survive even if
      // _creds is empty (e.g. after a worker restart clears in-memory state).
      batch.push({ token, siteId, identifier, isSku, price, amazonPrice, mappingId, minPrice, feeRate, minRoiPercent, userId, consumerKey: consumerKey || null, secretKey: secretKey || null, noChangeEnqueue, resolve, reject });
      if (consumerKey && secretKey) {
        if (!this._creds.has(token))    this._creds.set(token,    { consumerKey, secretKey });
        if (!this._creds.has(rawToken)) this._creds.set(rawToken, { consumerKey, secretKey });
      }

      if (batch.length >= this._maxBatch) {
        // Batch is full — flush immediately without waiting for the timer
        if (this._timers.has(key)) { clearTimeout(this._timers.get(key)); this._timers.delete(key); }
        this._enqueueFlush(key);
      } else if (!this._timers.has(key)) {
        // Wait up to 5 minutes for more items to arrive so the batch fills to ~1000.
        // At ~4 items/sec (20 workers × 5 s/job) this window collects ~1200 items —
        // enough for a full 1000-item flush with a small tail batch.
        const t = setTimeout(() => { this._timers.delete(key); this._enqueueFlush(key); }, 5 * 60_000);
        this._timers.set(key, t);
      }
    });
  }

  _enqueueFlush(key) {
    this._mutex = this._mutex
      .then(() => this._flushBatch(key))
      .catch(err => wlog(`[OnBuyUpdater] Unhandled flush error:`, err.message));
  }

  // Enqueue a stock-only update (e.g. stock=0 for OOS, stock=2 for back-in-stock).
  // Uses a 30-second collection window (shorter than price's 5 min because OOS changes are urgent)
  // and routes through the same _rrTs rate limiter so stock + price PUTs share the 200/hr ceiling.
  enqueueStock(rawToken, siteId, identifier, isSku, stock, { consumerKey, secretKey, userId = null } = {}) {
    return new Promise((resolve, reject) => {
      const token = this._resolveToken(rawToken);
      const key   = `stock||${token}||${siteId}||${isSku ? '1' : '0'}`;
      if (!this._stockBatches.has(key)) this._stockBatches.set(key, []);
      const batch = this._stockBatches.get(key);
      batch.push({ token, siteId, identifier, isSku, stock, userId, consumerKey: consumerKey || null, secretKey: secretKey || null, resolve, reject });
      if (consumerKey && secretKey && !this._creds.has(token)) this._creds.set(token, { consumerKey, secretKey });

      if (batch.length >= this._maxBatch) {
        if (this._stockTimers.has(key)) { clearTimeout(this._stockTimers.get(key)); this._stockTimers.delete(key); }
        this._enqueueStockFlush(key);
      } else if (!this._stockTimers.has(key)) {
        const t = setTimeout(() => { this._stockTimers.delete(key); this._enqueueStockFlush(key); }, 30_000);
        this._stockTimers.set(key, t);
      }
    });
  }

  _enqueueStockFlush(key) {
    this._mutex = this._mutex
      .then(() => this._flushStockBatch(key))
      .catch(err => wlog(`[OnBuyUpdater] Unhandled stock flush error:`, err.message));
  }

  async _flushStockBatch(key) {
    const batch = this._stockBatches.get(key);
    if (!batch || batch.length === 0) return;
    const items = batch.splice(0, this._maxBatch);

    const now = Date.now();
    this._rrTs = this._rrTs.filter(t => now - t < 3_600_000);
    if (this._rrTs.length >= this._maxPerHour) {
      const waitMs = 3_600_000 - (now - this._rrTs[0]) + 1000;
      wlog(`[OnBuyUpdater] Rate limit reached (${this._rrTs.length}/${this._maxPerHour}/hr) — pausing ${Math.round(waitMs / 1000)}s`);
      await new Promise(r => setTimeout(r, waitMs));
      this._rrTs = this._rrTs.filter(t => Date.now() - t < 3_600_000);
    }
    this._rrTs.push(Date.now());

    const { token, siteId, isSku } = items[0];
    const batchUserId = items[0].userId ?? null;
    const endpoint    = isSku
      ? `https://api.onbuy.com/v2/listings/by-sku?site_id=${siteId}`
      : `https://api.onbuy.com/v2/listings?site_id=${siteId}`;
    const listingKey  = isSku ? 'sku' : 'uid';
    const listings    = items.map(it => ({ [listingKey]: it.identifier, stock: it.stock }));

    ulog(batchUserId, `[OnBuyUpdater] Stock batch ${listingKey.toUpperCase()} ×${items.length}`, JSON.stringify({ listings }));

    try {
      const res = await fetch(endpoint, {
        method:  'PUT',
        headers: { Authorization: token, 'Content-Type': 'application/json' },
        body:    JSON.stringify({ listings }),
      });
      const raw = await res.text();
      ulog(batchUserId, `[OnBuyUpdater] Stock batch → HTTP ${res.status} ${raw.slice(0, 200)}`);

      if (!res.ok) {
        const err = new Error(`OnBuy stock ${res.status}: ${raw.slice(0, 200)}`);
        items.forEach(it => it.reject(err));
        return;
      }
      items.forEach(it => it.resolve());
    } catch (err) {
      items.forEach(it => it.reject(err));
    }

    if ((this._stockBatches.get(key) || []).length > 0) this._enqueueStockFlush(key);
  }

  // Called when all queue jobs are done — flushes every pending batch immediately
  // rather than waiting for the 5-minute collection window to expire.
  flushAll(runUserIds = new Set()) {
    let pending = 0;
    for (const [key, batch] of this._batches) {
      if (batch.length === 0) continue;
      pending += batch.length;
      if (this._timers.has(key)) { clearTimeout(this._timers.get(key)); this._timers.delete(key); }
      this._enqueueFlush(key);
    }
    for (const [key, batch] of this._stockBatches) {
      if (batch.length === 0) continue;
      pending += batch.length;
      if (this._stockTimers.has(key)) { clearTimeout(this._stockTimers.get(key)); this._stockTimers.delete(key); }
      this._enqueueStockFlush(key);
    }
    const msg = pending === 0
      ? '[OnBuyUpdater] flushAll: no pending updates (all prices unchanged or skipped)'
      : `[OnBuyUpdater] flushAll: ${pending} item(s) queued for immediate dispatch`;
    wlog(msg);
    for (const uid of runUserIds) logToUser(uid, msg);
  }

  // GET /v2/listings/check-winning — returns lead price + winning status per SKU
  // Uses https.request() (Node built-in) because fetch / node-fetch / undici.fetch
  // all follow the WHATWG spec and throw for GET requests that carry a body.
  _checkWinning(token, siteId, skus) {
    return new Promise((resolve) => {
      const bodyBuf = Buffer.from(JSON.stringify({ site_id: parseInt(siteId), skus }), 'utf8');
      const req = https.request(
        {
          hostname: 'api.onbuy.com',
          path: '/v2/listings/check-winning',
          method: 'GET',
          headers: {
            Authorization: token,
            'Content-Type': 'application/json',
            'Content-Length': bodyBuf.length,
          },
        },
        (res) => {
          const chunks = [];
          res.on('data', c => chunks.push(c));
          res.on('end', () => {
            try {
              if (res.statusCode !== 200) {
                wlog(`[CheckWinning] HTTP ${res.statusCode} — skipping price adjustment`);
                return resolve(null);
              }
              const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
              resolve(data.success && Array.isArray(data.results) ? data.results : null);
            } catch (e) {
              wlog(`[CheckWinning] Parse error:`, e.message);
              resolve(null);
            }
          });
        }
      );
      req.on('error', (e) => { wlog(`[CheckWinning] Error:`, e.message); resolve(null); });
      req.write(bodyBuf);
      req.end();
    });
  }

  async _flushBatch(key) {
    const batch = this._batches.get(key);
    if (!batch || batch.length === 0) return;
    const items = batch.splice(0, this._maxBatch);

    // ── Sliding-window rate limit ──
    const now = Date.now();
    this._rrTs = this._rrTs.filter(t => now - t < 3_600_000);
    if (this._rrTs.length >= this._maxPerHour) {
      const waitMs = 3_600_000 - (now - this._rrTs[0]) + 1000;
      wlog(`[OnBuyUpdater] Rate limit reached (${this._rrTs.length}/${this._maxPerHour}/hr) — pausing ${Math.round(waitMs / 1000)}s`);
      await new Promise(r => setTimeout(r, waitMs));
      this._rrTs = this._rrTs.filter(t => Date.now() - t < 3_600_000);
    }
    this._rrTs.push(Date.now());

    const { token, siteId, isSku } = items[0];
    // All items in a batch share the same account/token, so one userId covers the batch.
    const batchUserId = items[0].userId ?? null;

    // ── Check-winning: adjust prices for non-winning SKU listings ──
    if (isSku) {
      const skus         = items.map(it => it.identifier);
      const winResults   = await this._checkWinning(token, siteId, skus);
      if (winResults) {
        const winMap = new Map(
          winResults
            .filter(r => r.lead_price != null)
            .map(r => [r.sku, { leadPrice: parseFloat(r.lead_price), winning: r.winning }])
        );
        let adjusted = 0;
        for (const item of items) {
          const winInfo = winMap.get(item.identifier);
          if (!winInfo) continue;
          const { leadPrice, winning } = winInfo;

          const effFeeRate = item.feeRate      ?? _onbuyFeeRate;
          const effMinRoi  = item.minRoiPercent ?? _minRoiPercent;

          let newPrice = item.price;

          // Undercut lead price when not winning and our price is above the lead.
          // Three outcomes:
          //   1. undercutPrice ≥ minRoiFloor  → undercut (we can compete profitably)
          //   2. undercutPrice < minRoiFloor  → post floor price (lead is cheaper than our cost floor)
          //   3. no minRoiFloor configured    → undercut unconditionally
          if (winning === false && item.price > leadPrice) {
            const undercutPrice = parseFloat((leadPrice - 0.50).toFixed(2));
            const minRoiFloor   = (item.amazonPrice && effMinRoi > 0)
              ? parseFloat(((item.amazonPrice * (1 + effMinRoi / 100)) / (1 - effFeeRate)).toFixed(2))
              : 0;
            if (minRoiFloor > 0 && undercutPrice < minRoiFloor) {
              newPrice = minRoiFloor; // can't compete — post at minimum viable margin
            } else {
              newPrice = undercutPrice; // profitable undercut
            }
          }

          // Enforce the min-ROI floor on whatever price we landed on.
          // Covers: (a) corrupted markup_value not yet auto-corrected, (b) user raised
          // minRoi after the last sync, (c) a profitable undercut that still sits below
          // the floor due to rounding.
          if (item.amazonPrice && effMinRoi > 0) {
            const roiAtPrice  = ((newPrice * (1 - effFeeRate)) / item.amazonPrice - 1) * 100;
            if (roiAtPrice < effMinRoi) {
              const minRoiPrice = parseFloat(((item.amazonPrice * (1 + effMinRoi / 100)) / (1 - effFeeRate)).toFixed(2));
              ulog(item.userId, `[CheckWinning] ${item.identifier}: ROI at £${newPrice} = ${roiAtPrice.toFixed(1)}% < min ${effMinRoi}% → floor £${minRoiPrice}`);
              newPrice = minRoiPrice;
            }
          }

          // Per-listing min_price floor
          if (item.minPrice && newPrice < item.minPrice) newPrice = item.minPrice;

          // No check-winning adjustment needed
          if (newPrice === item.price) {
            // noChangeEnqueue items were only enqueued to run check-winning, not to force a PUT.
            // If check-winning also makes no change, mark them to be skipped from the batch PUT.
            if (item.noChangeEnqueue) item._skipPut = true;
            continue;
          }

          ulog(item.userId, `[CheckWinning] ${item.identifier}: £${item.price} → £${newPrice} (lead: £${leadPrice}, winning: ${winning})`);
          item.price = newPrice;
          adjusted++;

          // Update onbuy_fee to reflect the adjusted price (display only).
          // markup_value is intentionally NOT updated — it represents the user's
          // intended ROI policy and must not be overwritten by a transient
          // check-winning adjustment, which would corrupt future price calculations.
          if (item.amazonPrice && item.mappingId) {
            const newFee = newPrice * (item.feeRate ?? _onbuyFeeRate);
            db.query(
              `UPDATE product_mappings SET onbuy_fee = $1 WHERE id = $2`,
              [parseFloat(newFee.toFixed(2)), item.mappingId]
            ).catch(() => {});
          }
        }
        if (adjusted > 0) ulog(batchUserId, `[CheckWinning] Adjusted ${adjusted}/${items.length} prices in this batch`);
      }
    }

    // ── Batch PUT ──
    const endpoint   = isSku
      ? `https://api.onbuy.com/v2/listings/by-sku?site_id=${siteId}`
      : `https://api.onbuy.com/v2/listings?site_id=${siteId}`;
    const listingKey = isSku ? 'sku' : 'uid';

    // Resolve items that were enqueued only for check-winning and needed no adjustment.
    const skipItems = items.filter(it => it._skipPut);
    const sendItems = items.filter(it => !it._skipPut);
    if (skipItems.length > 0) {
      ulog(batchUserId, `[CheckWinning] ${skipItems.length} item(s) already winning — no PUT needed`);
      skipItems.forEach(it => it.resolve({ _noChange: true, _finalPrice: it.price }));
    }
    if (sendItems.length === 0) {
      if ((this._batches.get(key) || []).length > 0) this._enqueueFlush(key);
      return;
    }

    const listings   = sendItems.map(it => ({ [listingKey]: it.identifier, price: it.price.toFixed(2) }));

    const doRequest = (authToken) => fetch(endpoint, {
      method: 'PUT',
      headers: { Authorization: authToken, 'Content-Type': 'application/json' },
      body: JSON.stringify({ listings }),
    });

    ulog(batchUserId, `[OnBuyUpdater] Batch ${listingKey.toUpperCase()} ×${sendItems.length} payload:`, JSON.stringify({ listings }));

    try {
      let res = await doRequest(token);
      let raw = await res.text();
      ulog(batchUserId, `[OnBuyUpdater] Batch ${listingKey.toUpperCase()} ×${sendItems.length} → HTTP ${res.status} response:`, raw.slice(0, 2000));

      // Token expired mid-run — refresh once and retry the batch
      if (res.status === 401) {
        // Tier 1: in-memory _creds map (populated on first enqueue with valid creds)
        // Tier 2: creds embedded directly in the batch item (set since the creds-in-data fix)
        // Tier 3: DB lookup via mappingId — covers jobs created before the fix and slow-queue
        //         escalations that historically omitted consumerKey/secretKey from their payload.
        let creds = this._creds.get(token)
                 || this._creds.get(sendItems[0].token)
                 || (sendItems[0].consumerKey ? { consumerKey: sendItems[0].consumerKey, secretKey: sendItems[0].secretKey } : null);

        if (!creds) {
          const mappingId = sendItems.find(it => it.mappingId)?.mappingId;
          if (mappingId) {
            try {
              const { rows } = await db.query(`
                SELECT oa.consumer_key, oa.secret_key
                FROM product_mappings pm
                JOIN onbuy_accounts oa ON oa.id = pm.onbuy_account_id AND oa.is_active = true
                WHERE pm.id = $1
              `, [mappingId]);
              if (rows[0]) {
                creds = { consumerKey: rows[0].consumer_key, secretKey: rows[0].secret_key };
                this._creds.set(token, creds); // cache so subsequent batches skip the DB hit
                ulog(batchUserId, `[OnBuyUpdater] Loaded credentials from DB for mapping #${mappingId}`);
              }
            } catch (dbErr) {
              ulog(batchUserId, `[OnBuyUpdater] DB credential lookup failed:`, dbErr.message);
            }
          }
        }

        if (creds) {
          ulog(batchUserId, `[OnBuyUpdater] Token expired (401) — refreshing for ${creds.consumerKey?.slice(0, 8)}…`);
          try {
            const newToken = await getTokenForAccount({ consumer_key: creds.consumerKey, secret_key: creds.secretKey });
            if (newToken) {
              this._creds.set(newToken, creds);
              // Record redirect so future enqueue(oldToken) calls use newToken directly
              this._tokenMap.set(token, newToken);
              // Move any items waiting in the old-key bucket into the new-key bucket
              const newKey     = `${newToken}||${siteId}||${isSku ? '1' : '0'}`;
              const waiting    = this._batches.get(key) || [];
              if (!this._batches.has(newKey)) this._batches.set(newKey, []);
              waiting.forEach(it => { it.token = newToken; this._batches.get(newKey).push(it); });
              this._batches.set(key, []);
              // Transfer timer from old key to new key if present
              if (this._timers.has(key)) {
                clearTimeout(this._timers.get(key));
                this._timers.delete(key);
                if (this._batches.get(newKey).length > 0 && !this._timers.has(newKey)) {
                  const t = setTimeout(() => { this._timers.delete(newKey); this._enqueueFlush(newKey); }, 5 * 60_000);
                  this._timers.set(newKey, t);
                }
              }
              res = await doRequest(newToken);
              raw = await res.text();
              ulog(batchUserId, `[OnBuyUpdater] Retry with refreshed token → HTTP ${res.status} response:`, raw.slice(0, 2000));
            }
          } catch (refreshErr) {
            ulog(batchUserId, `[OnBuyUpdater] Token refresh failed:`, refreshErr.message);
          }
        } else {
          ulog(batchUserId, `[OnBuyUpdater] Token expired (401) but no credentials available to refresh — check OnBuy account setup`);
        }
      }

      if (!res.ok) {
        const err = new Error(`OnBuy ${res.status}: ${raw.slice(0, 200)}`);
        sendItems.forEach(it => it.reject(err));
        return;
      }

      const data    = JSON.parse(raw);
      const results = Array.isArray(data?.results) ? data.results
                    : Array.isArray(data?.payload)  ? data.payload
                    : [];
      sendItems.forEach((it, i) => {
        const r = results[i];
        if (r?.success === false) it.reject(new Error(r.message || 'OnBuy rejected update'));
        else it.resolve({ ...data, _finalPrice: it.price }); // pass adjusted price back to caller
      });
    } catch (err) {
      sendItems.forEach(it => it.reject(err));
    }

    // Flush any remaining items that arrived while this batch was in flight
    if ((this._batches.get(key) || []).length > 0) this._enqueueFlush(key);
  }
}

const onbuyUpdater = new OnBuyUpdater();

// ─────────────────────────────────────────────
// ONBUY API
// ─────────────────────────────────────────────

async function updateOnBuyPrice(listingId, newPrice, token, siteId) {
  const res = await fetch(`https://api.onbuy.com/v2/listings?site_id=${siteId}`, {
    method: 'PUT',
    headers: { Authorization: token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ listings: [{ uid: listingId, price: newPrice.toFixed(2) }] }),
  });
  const raw = await res.text();
  wlog(`[OnBuy Price] uid=${listingId} HTTP ${res.status} → ${raw.slice(0, 200)}`);
  if (!res.ok) throw new Error(`OnBuy ${res.status}: ${raw.slice(0, 200)}`);
  const data = JSON.parse(raw);
  const item = Array.isArray(data?.results) ? data.results[0]
             : Array.isArray(data?.payload)  ? data.payload[0]
             : Array.isArray(data)           ? data[0] : data;
  if (item?.success === false) throw new Error(item.message || 'OnBuy rejected update');
  return data;
}

async function updateOnBuyPriceBySku(sku, newPrice, token, siteId) {
  const res = await fetch(`https://api.onbuy.com/v2/listings/by-sku?site_id=${siteId}`, {
    method: 'PUT',
    headers: { Authorization: token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ listings: [{ sku, price: newPrice.toFixed(2) }] }),
  });
  const raw = await res.text();
  wlog(`[OnBuy Price] sku=${sku} HTTP ${res.status} → ${raw.slice(0, 200)}`);
  if (!res.ok) throw new Error(`OnBuy ${res.status}: ${raw.slice(0, 200)}`);
  const data = JSON.parse(raw);
  const item = Array.isArray(data?.results) ? data.results[0]
             : Array.isArray(data?.payload)  ? data.payload[0]
             : Array.isArray(data)           ? data[0] : data;
  if (item?.success === false) throw new Error(item.message || 'OnBuy rejected update');
  return data;
}

async function setOnBuyStock(identifier, quantity, token, siteId, isSku) {
  const endpoint = isSku
    ? `https://api.onbuy.com/v2/listings/by-sku?site_id=${siteId}`
    : `https://api.onbuy.com/v2/listings?site_id=${siteId}`;
  const listingField = isSku ? { sku: identifier } : { uid: identifier };
  const body = JSON.stringify({ listings: [{ ...listingField, stock: quantity }] });
  wlog(`[OnBuy Stock] ${isSku ? 'sku' : 'uid'}=${identifier} → stock=${quantity}`);
  const res = await fetch(endpoint, {
    method: 'PUT',
    headers: { Authorization: token, 'Content-Type': 'application/json' },
    body,
  });
  const raw = await res.text();
  wlog(`[OnBuy Stock] HTTP ${res.status} → ${raw.slice(0, 200)}`);
  return raw;
}

async function resolveUidFromOpc(opc, token, siteId) {
  try {
    const url = `https://api.onbuy.com/v2/listings?site_id=${siteId}&filter[opc]=${encodeURIComponent(opc)}&limit=5`;
    const res = await fetch(url, { headers: { Authorization: token } });
    const data = await res.json();
    return (Array.isArray(data?.results) ? data.results[0] : null)?.uid || null;
  } catch (err) {
    wlog(`[Resolve] OPC ${opc} failed:`, err.message);
    return null;
  }
}

// ─────────────────────────────────────────────
// PRICE CALCULATION
// ─────────────────────────────────────────────

let _onbuyFeeRate  = 0.15;
let _defaultRoi    = 20;
let _minRoiPercent = 0;   // 0 = no minimum

export function setRepricerDefaults({ feeRate, defaultRoi, minRoiPercent } = {}) {
  if (feeRate      != null) _onbuyFeeRate  = Math.min(Math.max(parseFloat(feeRate) / 100, 0), 0.99);
  if (defaultRoi   != null) _defaultRoi    = parseFloat(defaultRoi);
  if (minRoiPercent != null) _minRoiPercent = Math.max(0, parseFloat(minRoiPercent));
}

function computeOnBuyPrice(amazonPrice, markupType, markupValue, minPrice = null, feeRate = _onbuyFeeRate) {
  let price;
  if (markupType === 'roi') {
    // P = (amazon × (1 + roi/100)) / (1 - fee%)
    // e.g. amazon=5.99, roi=20%, fee=15%: (5.99 × 1.20) / 0.85 = 8.46
    price = (amazonPrice * (1 + markupValue / 100)) / (1 - feeRate);
  } else if (markupType === 'percent') {
    price = amazonPrice * (1 + markupValue / 100);
  } else if (markupType === 'fixed') {
    price = amazonPrice + markupValue;
  } else {
    price = amazonPrice;
  }
  if (minPrice && price < minPrice) price = minPrice;
  return parseFloat(price.toFixed(2));
}

function hasPriceChangedSignificantly(oldPrice, newPrice, threshold = 0.5) {
  if (!oldPrice) return true;
  return Math.abs(newPrice - oldPrice) / oldPrice * 100 >= threshold;
}

function isValidListingUid(val) {
  if (!val || typeof val !== 'string' || !val.trim()) return false;
  if (/^https?:\/\//i.test(val) || /onbuy\.com/i.test(val)) return false;
  if (/^\d{5,12}$/.test(val.trim())) return false;
  return true;
}

function extractOpcFromValue(val) {
  if (!val) return null;
  const s = String(val).trim();
  if (/^\d{5,12}$/.test(s)) return s;
  const m = s.match(/~p(\d+)\/?$/i) || s.match(/[/~]p(\d+)/i);
  return m ? m[1] : null;
}

// Atomically increment today's per-user/account counters.
// accountId=null maps to 0 (used when onbuy_account_id is not set on the mapping).
function _incrDailyStats(userId, accountId, priceChanged = false) {
  db.query(
    `INSERT INTO daily_sync_stats (user_id, onbuy_account_id, date, synced_count, price_changes)
     VALUES ($1, $2, CURRENT_DATE, 1, $3)
     ON CONFLICT (user_id, onbuy_account_id, date)
     DO UPDATE SET
       synced_count  = daily_sync_stats.synced_count  + 1,
       price_changes = daily_sync_stats.price_changes + EXCLUDED.price_changes`,
    [userId, accountId ?? 0, priceChanged ? 1 : 0]
  ).catch(() => {});
}

// ─────────────────────────────────────────────
// SHARED RESULT HANDLER
// Called by both workers after scraping completes
// ─────────────────────────────────────────────

async function applyResult(scraped, mapping, token, siteId, { consumerKey, secretKey, userSettings = {} } = {}) {
  const {
    id,
    onbuy_sku,
    onbuy_listing_id: rawListingId,
    markup_type,
    min_price,
    last_amazon_price,
    last_onbuy_price,
    amazon_in_stock,
    primary_asin,
    product_name,
    user_id:          userId,
    onbuy_account_id: accountId,
  } = mapping;

  const effFeeRate  = userSettings.feeRate      ?? _onbuyFeeRate;
  const effMinRoi   = userSettings.minRoiPercent ?? _minRoiPercent;
  let markup_value = parseFloat(mapping.markup_value) || (userSettings.defaultRoi ?? _defaultRoi);

  // Auto-correct markup_value that was corrupted by a previous CheckWinning run.
  // A stored ROI below the user's own minimum threshold is always wrong — a user
  // who configured min_roi=10% would never intentionally set markup_value to 4%.
  // Reset to defaultRoi and persist the correction so future runs start clean.
  if (markup_type === 'roi' && effMinRoi > 0 && markup_value < effMinRoi) {
    const corrected = userSettings.defaultRoi ?? _defaultRoi;
    ulog(userId, `[Worker] 🔧 ${product_name || primary_asin} (#${id}) — markup_value ${markup_value.toFixed(2)}% < minRoi ${effMinRoi}% (corrupted) → reset to ${corrected}%`);
    markup_value = corrected;
    db.query(`UPDATE product_mappings SET markup_value = $1 WHERE id = $2`, [corrected, id]).catch(() => {});
  }

  const label = `${product_name || primary_asin} (#${id})`;

  // Use explicit onbuy_sku first, then fall back to primary_asin (sellers commonly use
  // the ASIN as their OnBuy seller SKU), then fall back to the listing UID.
  // effectiveSku drives both the identifier sent to OnBuy and the isSku flag that
  // enables check-winning (which only works for SKU-keyed listings).
  const effectiveSku = onbuy_sku || primary_asin || null;

  // ── OOS: set OnBuy stock=0 ──
  if (scraped.inStock === false) {
    const wasAlreadyOos = amazon_in_stock === false;
    if (!wasAlreadyOos) {
      ulog(userId, `[Worker] ⚠️  ${label} — OOS, setting stock=0`);
      if (effectiveSku) {
        onbuyUpdater.enqueueStock(token, siteId, effectiveSku, true, 0, { consumerKey, secretKey, userId })
          .catch(err => ulog(userId, `[Worker] ❌ ${label} — stock=0 failed: ${err.message}`));
      }
    } else {
      ulog(userId, `[Worker] ⏭  ${label} — still OOS, no change`);
    }
    await db.query(
      `UPDATE product_mappings SET amazon_in_stock = false, last_checked_at = NOW(), last_synced_at = NOW() WHERE id = $1`, [id]
    );
    await db.query(
      `INSERT INTO sync_logs (product_mapping_id, status, message, created_at)
       VALUES ($1, 'skipped', 'Amazon OOS — OnBuy stock set to 0', NOW())`, [id]
    );
    _incrDailyStats(userId, accountId);
    return { success: true, skipped: true, outOfStock: true };
  }

  // ── Back in stock: restore stock=5 — only when we have a confirmed price ──
  // A missing price with no explicit inStock=false means the scrape failed (blocked/timeout),
  // not that the item is back in stock. Never restore from a failed scrape.
  if (amazon_in_stock === false && scraped.price) {
    ulog(userId, `[Worker] ✅ ${label} — back in stock, restoring stock=5`);
    if (effectiveSku) {
      onbuyUpdater.enqueueStock(token, siteId, effectiveSku, true, 5, { consumerKey, secretKey, userId })
        .catch(err => ulog(userId, `[Worker] ❌ ${label} — stock=5 failed: ${err.message}`));
    }
    await db.query(`UPDATE product_mappings SET amazon_in_stock = true WHERE id = $1`, [id]);
  }

  // ── No price ──
  if (!scraped.price) {
    ulog(userId, `[Worker] ⚠️  ${label} — no price (${scraped.error || 'unknown'})`);
    await db.query(
      `INSERT INTO sync_logs (product_mapping_id, status, message, created_at)
       VALUES ($1, 'failed', $2, NOW())`,
      [id, `Scrape failed: ${scraped.error || 'no price returned'}`]
    );
    _incrDailyStats(userId, accountId);
    return { success: false, error: scraped.error };
  }

  const amazonPrice   = scraped.price;
  const newOnBuyPrice = computeOnBuyPrice(amazonPrice, markup_type, markup_value, min_price, effFeeRate);
  ulog(userId, `[Worker] ${label} — Amazon £${amazonPrice} → OnBuy £${newOnBuyPrice} (${scraped.method})`);

  // ── Skip if unchanged ──
  // Don't skip when the stored price violates the current min-ROI floor — the
  // floor may have been raised since the last run, and the stored price could
  // have been written by a previous check-winning adjustment (e.g. markup_value
  // was overwritten to a negative ROI).
  const minRoiFloor = effMinRoi > 0
    ? parseFloat(((amazonPrice * (1 + effMinRoi / 100)) / (1 - effFeeRate)).toFixed(2))
    : null;
  const storedBelowFloor = minRoiFloor != null && last_onbuy_price
    ? parseFloat(last_onbuy_price) < minRoiFloor
    : false;
  const alreadyCorrect  = !storedBelowFloor && last_onbuy_price && parseFloat(last_onbuy_price) === newOnBuyPrice;
  const priceUnchanged  = !hasPriceChangedSignificantly(last_amazon_price, amazonPrice) && alreadyCorrect;
  // Always enqueue — check-winning adjusts the price even when Amazon hasn't moved.
  // noChangeEnqueue=true tells the batch to skip the PUT if check-winning also makes
  // no adjustment, so unchanged-and-already-winning listings cost zero API calls.
  if (priceUnchanged) {
    ulog(userId, `[Worker] ↩  ${label} — Amazon £${amazonPrice} / OnBuy £${newOnBuyPrice} unchanged — check-winning will adjust if not winning`);
  }

  // ── Push to OnBuy (batched + rate-limited, fire-and-forget) ──
  // last_amazon_price is recorded immediately so hasPriceChangedSignificantly
  // returns false on the next run even if the OnBuy call is still queued.
  // last_onbuy_price + price_history + sync_log are written after API confirms.
  await db.query(
    `UPDATE product_mappings
     SET last_amazon_price = $1, last_checked_at = NOW(), amazon_in_stock = true
     WHERE id = $2`,
    [amazonPrice, id]
  );

  if (!effectiveSku) {
    ulog(userId, `[Worker] ⚠️  ${label} — no SKU (onbuy_sku and primary_asin both empty), skipping price update`);
    return { success: false, error: 'no_sku' };
  }
  onbuyUpdater.enqueue(token, siteId, effectiveSku, true, newOnBuyPrice, {
    consumerKey, secretKey,
    amazonPrice,
    mappingId:      id,
    minPrice:       min_price ? parseFloat(min_price) : null,
    feeRate:        effFeeRate !== _onbuyFeeRate  ? effFeeRate  : null,
    minRoiPercent:  effMinRoi !== _minRoiPercent ? effMinRoi   : null,
    userId,
    noChangeEnqueue: priceUnchanged,  // skip the PUT if check-winning also makes no adjustment
  })
    .then(async (result) => {
      if (result?._noChange) {
        _incrDailyStats(userId, accountId);
        return;
      }
      const finalPrice = result?._finalPrice ?? newOnBuyPrice;
      try {
        await db.query(
          `UPDATE product_mappings SET last_onbuy_price = $1, last_synced_at = NOW() WHERE id = $2`,
          [finalPrice, id]
        );
        await Promise.all([
          db.query(
            `INSERT INTO price_history (product_mapping_id, amazon_price, onbuy_price, recorded_at)
             VALUES ($1, $2, $3, NOW())`,
            [id, amazonPrice, finalPrice]
          ),
          db.query(
            `INSERT INTO sync_logs (product_mapping_id, status, message, amazon_price, onbuy_price, created_at)
             VALUES ($1, 'success', $2, $3, $4, NOW())`,
            [id, finalPrice !== newOnBuyPrice ? `Price synced (winning adjustment: £${newOnBuyPrice} → £${finalPrice})` : 'Price synced', amazonPrice, finalPrice]
          ),
        ]);
        _incrDailyStats(userId, accountId, true);
      } catch (dbErr) {
        ulog(userId, `[Worker] DB post-sync update failed for #${id}:`, dbErr.message);
      }
    })
    .catch(err => {
      ulog(userId, `[Worker] ❌ ${label} — OnBuy update failed:`, err.message);
      db.query(
        `INSERT INTO sync_logs (product_mapping_id, status, message, created_at)
         VALUES ($1, 'failed', $2, NOW())`,
        [id, `OnBuy API error: ${err.message}`]
      ).catch(() => {});
      _incrDailyStats(userId, accountId);
    });

  return { success: true, amazonPrice, newOnBuyPrice };
}

// ─────────────────────────────────────────────
// FAST WORKER PROCESSOR
// Twister API + Cheerio. Escalates to slow queue
// if both fast methods return needsBrowser: true.
// ─────────────────────────────────────────────

async function processFastJob(job) {
  let { mapping, token, siteId, consumerKey, secretKey, userSettings = {} } = job.data;
  const userId = mapping.user_id;
  return jobContext.run({ userId }, () => _processFastJob(job, mapping, token, siteId, consumerKey, secretKey, userSettings, userId));
}

async function _processFastJob(job, mapping, token, siteId, consumerKey, secretKey, userSettings, userId) {

  // Resolve listing UID from OPC if we have neither a SKU nor a valid UID.
  // primary_asin is treated as the OnBuy seller SKU when onbuy_sku is not explicitly set
  // (sellers commonly use the ASIN as their OnBuy SKU), so skip OPC resolution in that case.
  if (!mapping.onbuy_sku && !mapping.primary_asin && !isValidListingUid(mapping.onbuy_listing_id)) {
    const opc = mapping.onbuy_opc || extractOpcFromValue(mapping.onbuy_listing_id);
    if (!opc) {
      const msg = 'No SKU or valid UID — re-import with Seller SKU filled in';
      ulog(userId, `[FastWorker] mapping #${mapping.id}: ${msg}`);
      await db.query(
        `INSERT INTO sync_logs (product_mapping_id, status, message, created_at)
         VALUES ($1, 'failed', $2, NOW())`, [mapping.id, msg]
      );
      _incrDailyStats(mapping.user_id, mapping.onbuy_account_id);
      return { success: false, error: 'no_identifier' };
    }
    const uid = await resolveUidFromOpc(opc, token, siteId);
    if (!uid) {
      const msg = `Could not resolve UID from OPC ${opc}`;
      await db.query(
        `INSERT INTO sync_logs (product_mapping_id, status, message, created_at)
         VALUES ($1, 'failed', $2, NOW())`, [mapping.id, msg]
      );
      _incrDailyStats(mapping.user_id, mapping.onbuy_account_id);
      return { success: false, error: 'opc_resolve_failed' };
    }
    await db.query(
      `UPDATE product_mappings SET onbuy_listing_id = $1, onbuy_opc = $2 WHERE id = $3`,
      [uid, opc, mapping.id]
    );
    mapping = { ...mapping, onbuy_listing_id: uid, onbuy_opc: opc };
  }

  // ── Keepa price cache check ───────────────────────────────────────────────
  // Prices are cached per OnBuy account in keepa:prices:{accountId}.
  // Use the cached price directly and skip all Amazon scraping.
  // Only act on a cached price when it's a positive number — a null entry means
  // Keepa had no current price (possible OOS), so fall back to live scraping.
  const keepaCacheKey = mapping.onbuy_account_id
    ? `keepa:prices:${mapping.onbuy_account_id}`
    : null;
  if (keepaCacheKey) {
    try {
      const cachedRaw = await redis.hget(keepaCacheKey, mapping.primary_asin);
      if (cachedRaw) {
        const cached = JSON.parse(cachedRaw);
        if (cached.price !== null && cached.price > 0) {
          ulog(userId, `[FastWorker] ${mapping.primary_asin} — Keepa cache (account ${mapping.onbuy_account_id}): £${cached.price} (${cached.source})`);
          return applyResult(
            { price: cached.price, inStock: true, method: cached.source || 'keepa_viewer', priceSource: cached.source },
            mapping, token, siteId, { consumerKey, secretKey, userSettings }
          );
        }
        // Keepa had no price in any column → item is out of stock on Amazon.
        // Trust Keepa's OOS signal; do not fall back to live scraping.
        if (cached.inStock === false) {
          ulog(userId, `[FastWorker] ${mapping.primary_asin} — Keepa: no current price → out of stock`);
          return applyResult(
            { price: null, inStock: false, method: 'keepa_viewer', priceSource: 'keepa_oos' },
            mapping, token, siteId, { consumerKey, secretKey, userSettings }
          );
        }
        ulog(userId, `[FastWorker] ${mapping.primary_asin} — Keepa cache: no price data, falling back to scraper`);
      }
    } catch (cacheErr) {
      ulog(userId, `[FastWorker] Keepa cache read error: ${cacheErr.message} — continuing with scraper`);
    }
  }

  const { enableTwister = false, enableCheerio = false, enablePuppeteer = false } = userSettings;

  // If all three scraping methods are disabled, skip scraping entirely.
  // The Keepa cache above is the sole price source for this account.
  if (!enableTwister && !enableCheerio && !enablePuppeteer) {
    ulog(userId, `[FastWorker] ${mapping.primary_asin} — all scraping methods disabled, no Keepa price — skipping`);
    return { success: false, error: 'no_scraping_methods' };
  }

  const scraped = await scrapeProductFast(mapping.primary_asin, { enableTwister, enableCheerio });

  // Escalate to slow queue if Twister + Cheerio both failed (or were skipped).
  // Skip escalation when puppeteer is disabled for this account — mark as failed instead.
  // Delay is computed so all remaining fast-queue jobs finish before Puppeteer starts.
  if (scraped.needsBrowser) {
    if (!enablePuppeteer) {
      ulog(userId, `[FastWorker] ${mapping.primary_asin} → needs browser but puppeteer disabled for this account — marking failed`);
      await db.query(
        `INSERT INTO sync_logs (product_mapping_id, status, message, created_at)
         VALUES ($1, 'failed', 'Scrape requires browser (puppeteer disabled for this OnBuy account)', NOW())`,
        [mapping.id]
      );
      _incrDailyStats(mapping.user_id, mapping.onbuy_account_id);
      return { success: false, error: 'puppeteer_disabled' };
    }

    const fastCounts = await fastQueue.getJobCounts('waiting', 'active');
    const queuedFast = fastCounts.waiting;
    const batches    = Math.ceil(queuedFast / FAST_CONCURRENCY);
    // 12 s per batch (conservative avg fast-job time) + 10 s buffer
    const drainMs    = batches * 12000 + 10000;
    const delay      = Math.max(5000, Math.min(drainMs, 300000)); // 5 s – 5 min cap

    ulog(userId, `[FastWorker] ${mapping.primary_asin} → escalating to slow queue (delay: ${Math.round(delay / 1000)}s, fast remaining: ${queuedFast})`);
    await slowQueue.add('scrape', { mapping, token, siteId, consumerKey, secretKey, userSettings }, {
      jobId:             `slow-${mapping.id}`,
      delay,
      removeOnComplete:  true,
      removeOnFail:      true,
      attempts:          2,
      backoff:           { type: 'fixed', delay: 15000 },
    });
    return { escalated: true };
  }

  return applyResult(scraped, mapping, token, siteId, { consumerKey, secretKey, userSettings });
}

// ─────────────────────────────────────────────
// SLOW WORKER PROCESSOR
// Puppeteer (proxy → direct). Receives escalated
// jobs from the fast worker.
// ─────────────────────────────────────────────

async function processSlowJob(job) {
  const { mapping, token, siteId, consumerKey, secretKey, userSettings = {} } = job.data;
  const userId = mapping.user_id;
  return jobContext.run({ userId }, async () => {
    let scraped = await scrapeProductSlow(mapping.primary_asin);

    if (scraped.error === 'all_methods_failed') {
      ulog(userId, `[SlowWorker] all_methods_failed for ${mapping.primary_asin} — waiting 10s then retrying full pipeline once`);
      await new Promise(r => setTimeout(r, 10_000));
      const fastRetry = await scrapeProductFast(mapping.primary_asin);
      if (fastRetry.price || fastRetry.inStock === false) {
        scraped = fastRetry;
      } else {
        // Fast still failing — one final Puppeteer attempt
        scraped = await scrapeProductSlow(mapping.primary_asin);
      }
    }

    return applyResult(scraped, mapping, token, siteId, { consumerKey, secretKey, userSettings });
  });
}

// ─────────────────────────────────────────────
// BOOTSTRAP  (top-level await — runs before workers start)
// Pre-loads super-admin proxy URL so any jobs already in Redis use the
// correct scraper config.  Per-user pricing settings travel with each
// job in job.data.userSettings; global fallbacks remain as defaults.
// ─────────────────────────────────────────────

try {
  const { rows } = await db.query(`
    SELECT s.key, s.value FROM settings s
    JOIN users u ON u.id = s.user_id AND u.role = 'super_admin'
  `);
  const s = Object.fromEntries(rows.map(r => [r.key, r.value]));
  if (s.webshare_proxy_api) setProxyApiUrl(s.webshare_proxy_api);
  wlog(`[RepricerJob] Bootstrap — proxy: ${s.webshare_proxy_api ? 'set' : 'not set'}`);
} catch (e) {
  wlog('[RepricerJob] Could not bootstrap settings:', e.message);
}

// ─────────────────────────────────────────────
// KEEPA WORKER
// Runs one job at a time (concurrency = 1).
// Job payload: { userId, asins[], keepaEmail, keepaPassword }
// On completion: stores prices in Redis then kicks off the
// normal pricing phase via runRepricerJob({ skipKeepa: true }).
// ─────────────────────────────────────────────

async function processKeepaJob(job) {
  const {
    userId, accountId, asins,
    pendingAsins    = null,  // set on quota-refill runs; null on the initial run
    runNumber       = 1,     // which quota cycle this is (1 = initial, 2+ = hourly refill)
    asinToMappingIds = {},   // ASIN → [mappingId, ...] built by jobProducer for incremental flush
  } = job.data;
  const log = (...args) => ulog(userId, ...args);

  // Always fetch keepa credentials fresh from DB so changing credentials mid-run takes effect
  let keepaEmail    = job.data.keepaEmail;
  let keepaPassword = job.data.keepaPassword;
  if (accountId) {
    const { rows: acctRows } = await db.query(
      `SELECT keepa_email, keepa_password FROM onbuy_accounts WHERE id = $1 LIMIT 1`,
      [accountId]
    ).catch(() => ({ rows: [] }));
    if (acctRows[0]?.keepa_email) {
      keepaEmail    = acctRows[0].keepa_email;
      keepaPassword = acctRows[0].keepa_password;
      log(`[Keepa] Using credentials from DB for account ${accountId}: ${keepaEmail}`);
    }
  }

  const toFetch   = pendingAsins ?? asins;
  const quota     = runNumber === 1 ? KEEPA_QUOTA_FULL : KEEPA_HOURLY_FILL;
  const thisBatch = toFetch.slice(0, quota);
  let   leftover  = toFetch.slice(quota);

  log(`[KeepaWorker] Run #${runNumber} — account ${accountId}: fetching ${thisBatch.length} ASINs${leftover.length ? `, ${leftover.length} deferred (quota refill)` : ''}`);

  const cacheKey           = `keepa:prices:${accountId}`;
  const SUB_BATCH          = 1000;          // one Keepa browser session per sub-batch
  const FLUSH_PRICE_COUNT  = 1000;          // trigger OnBuy update after this many prices accumulated
  const FLUSH_INTERVAL_MS  = 5 * 60 * 1000; // …or after 5 minutes, whichever comes first

  let totalPriceCount  = 0;
  let pendingMappingIds = [];   // mapping IDs waiting for the next OnBuy pricing flush
  let lastFlushTime    = Date.now();
  const hasAsinMap     = Object.keys(asinToMappingIds).length > 0;

  // Flush accumulated mapping IDs to the OnBuy pricing phase.
  // skipCounter=true prevents overwriting the DECRBY-managed counter.
  // fromKeepaFlush=true prevents the fast worker from double-decrementing per job.
  const flushToOnBuy = async (ids) => {
    if (!ids.length) return;
    log(`[KeepaWorker] Flushing ${ids.length} mapping(s) to OnBuy pricing phase`);
    try {
      await runRepricerJob({
        userId, accountId, mappingIds: ids,
        skipKeepa: true, skipCounter: true, fromKeepaFlush: true, log,
      });
    } catch (err) {
      log(`[KeepaWorker] OnBuy flush error: ${err.message}`);
    }
  };

  // ── Process thisBatch one 1 000-ASIN sub-batch at a time ──────────────────
  // Each sub-batch opens a fresh browser session (login + navigate + scrape + close).
  // After the first export Keepa hides the ASIN input panel and reloading the viewer
  // proved unreliable in production — a fresh session is the only reliable approach.
  let quotaExhaustedIdx = -1;  // index in thisBatch where quota was detected ≤5%

  for (let i = 0; i < thisBatch.length; i += SUB_BATCH) {
    const chunk    = thisBatch.slice(i, i + SUB_BATCH);
    const chunkNum = Math.floor(i / SUB_BATCH) + 1;
    const totalChunks = Math.ceil(thisBatch.length / SUB_BATCH);

    log(`[KeepaWorker] Sub-batch ${chunkNum}/${totalChunks} — ${chunk.length} ASINs (fresh session)`);

    let chunkPrices = {};
    try {
      chunkPrices = await getKeepaPrice(chunk, { email: keepaEmail, password: keepaPassword, log });
    } catch (err) {
      if (err.message === 'KEEPA_QUOTA_EXHAUSTED') {
        log(`[KeepaWorker] ⏸ Quota ${err.quota ?? 0}% ≤5% at sub-batch ${chunkNum}/${totalChunks} — deferring ${thisBatch.length - i} ASINs for 1 h`);
        quotaExhaustedIdx = i;
        break;
      }
      if (err.message === 'KEEPA_BATCH_TIMEOUT') {
        log(`[KeepaWorker] Sub-batch ${chunkNum} timed out — retrying once (fresh session)…`);
        try {
          chunkPrices = await getKeepaPrice(chunk, { email: keepaEmail, password: keepaPassword, log });
        } catch (retryErr) {
          if (retryErr.message === 'KEEPA_QUOTA_EXHAUSTED') {
            log(`[KeepaWorker] ⏸ Quota ${retryErr.quota ?? 0}% ≤5% at sub-batch ${chunkNum} retry — deferring ${thisBatch.length - i} ASINs for 1 h`);
            quotaExhaustedIdx = i;
            break;
          }
          log(`[KeepaWorker] Sub-batch ${chunkNum} retry failed: ${retryErr.message}`);
        }
      } else {
        log(`[KeepaWorker] Sub-batch ${chunkNum} failed: ${err.message}`);
      }
    }

    // Persist prices to Redis hash
    const entries = Object.entries(chunkPrices);
    if (entries.length > 0) {
      const pipeline = redis.pipeline();
      for (const [asin, data] of entries) pipeline.hset(cacheKey, asin, JSON.stringify(data));
      await pipeline.exec();
      await redis.expire(cacheKey, 12 * 3600);
    }

    const chunkPriceCount = Object.values(chunkPrices).filter(r => r.price !== null).length;
    totalPriceCount += chunkPriceCount;
    log(`[KeepaWorker] Sub-batch ${chunkNum}: ${chunkPriceCount}/${chunk.length} prices found`);

    // Decrement UI counter by the full chunk size — counter reflects ASINs processed,
    // not just ones with a price.
    const afterDecr = await redis.decrby(`repricer:running:${userId}`, chunk.length).catch(() => null);
    if (afterDecr !== null && afterDecr < 0)
      redis.set(`repricer:running:${userId}`, 0, 'KEEPTTL').catch(() => {});

    // Accumulate mapping IDs for all ASINs that received a definitive result
    if (hasAsinMap) {
      for (const asin of chunk) {
        if (!chunkPrices[asin]) continue;  // no result from Keepa for this ASIN
        for (const id of (asinToMappingIds[asin] || [])) pendingMappingIds.push(id);
      }

      // Flush when ≥ FLUSH_PRICE_COUNT prices have accumulated, or 5 min have passed
      const byCount = pendingMappingIds.length >= FLUSH_PRICE_COUNT;
      const byTime  = (Date.now() - lastFlushTime) >= FLUSH_INTERVAL_MS;

      if (byCount || byTime) {
        // Time-based: flush everything; count-based: flush first FLUSH_PRICE_COUNT, keep remainder
        const toFlush = byTime
          ? pendingMappingIds.splice(0)
          : pendingMappingIds.splice(0, FLUSH_PRICE_COUNT);
        await flushToOnBuy(toFlush);
        lastFlushTime = Date.now();
      }
    }
  }

  // When quota ran out mid-run, fold unprocessed ASINs into leftover so the
  // existing 1-hour refill scheduler picks them up automatically.
  if (quotaExhaustedIdx >= 0) {
    const unprocessed = thisBatch.slice(quotaExhaustedIdx);
    leftover = [...unprocessed, ...leftover];
    log(`[KeepaWorker] ${unprocessed.length} unprocessed ASINs added to refill queue (total deferred: ${leftover.length})`);
  }

  // Final flush for any prices accumulated after the last threshold trigger
  if (hasAsinMap && pendingMappingIds.length > 0) {
    log(`[KeepaWorker] Final flush — ${pendingMappingIds.length} remaining mapping(s)`);
    await flushToOnBuy(pendingMappingIds);
  }

  // For accounts without asinToMappingIds (old job format), fall back to full account handoff
  if (!hasAsinMap) {
    _retryPendingFor.clear();
    log('[KeepaWorker] No asinToMappingIds — falling back to full account handoff');
    try {
      await runRepricerJob({ userId, accountId, skipKeepa: true, log });
    } catch (err) {
      log(`[KeepaWorker] Handoff error: ${err.message}`);
    }
  }

  _retryPendingFor.clear();

  // ── Schedule next run for remaining ASINs ──
  if (leftover.length > 0) {
    const nextRun       = runNumber + 1;
    const realExhausted = quotaExhaustedIdx >= 0;
    const delayMs       = realExhausted ? 60 * 60 * 1000 : 30_000; // 1 h if quota ran out, 30 s otherwise
    const delayLabel    = realExhausted ? '1 h (quota exhausted)' : '30 s (continuing)';
    const ttlSecs       = realExhausted
      ? (Math.ceil(leftover.length / KEEPA_HOURLY_FILL) + 2) * 3600
      : (Math.ceil(leftover.length / KEEPA_HOURLY_FILL) + 2) * 3600;
    const fetched = thisBatch.length - (realExhausted ? thisBatch.length - quotaExhaustedIdx : 0);
    log(`[KeepaWorker] ${realExhausted ? 'Quota exhausted' : 'Batch complete'} (${fetched} fetched this run). Scheduling run #${nextRun} in ${delayLabel} for ${leftover.length} remaining ASINs.`);
    if (realExhausted) {
      redis.set(`repricer:running:${userId}`,     leftover.length, 'EX', ttlSecs).catch(() => {});
      redis.set(`keepa:refill-pending:${userId}`, '1',             'EX', ttlSecs).catch(() => {});
    }
    await keepaQueue.add('prefetch', {
      userId, accountId, asins, asinToMappingIds,
      pendingAsins: leftover, runNumber: nextRun,
    }, {
      jobId:            `keepa-${accountId}-r${nextRun}`,
      delay:            delayMs,
      removeOnComplete: true, removeOnFail: true, attempts: 1,
    });
    log(`[KeepaWorker] ✅ Next job #${nextRun} scheduled — ${leftover.length} ASINs in ${delayLabel}`);
  } else {
    redis.del(`keepa:refill-pending:${userId}`).catch(() => {});
    if (runNumber > 1) log(`[KeepaWorker] All ASINs processed across ${runNumber} quota cycles`);
  }

  return { priceCount: totalPriceCount, asinCount: thisBatch.length, remaining: leftover.length };
}

const keepaWorker = new Worker('keepa-scrape', processKeepaJob, {
  connection:  redis,
  concurrency: parseInt(process.env.KEEPA_CONCURRENCY) || 3,
});

keepaWorker.on('active', (job) => {
  _keepaActive++;
  if (!_runStartTime) _runStartTime = new Date();
  const { userId, accountId, asins, pendingAsins } = job.data || {};
  // For refill runs use pendingAsins length; for first run use full asins length
  const displayCount = pendingAsins?.length ?? asins?.length ?? 1;
  wlog(`[DEBUG KeepaWorker active] job=${job?.id} userId=${userId} accountId=${accountId} asins=${displayCount} _keepaActive=${_keepaActive} _runUserIds=${_runUserIds.size}`);
  if (userId) {
    _runUserIds.add(userId);
    // TTL covers the full remaining work: one hour per 1800-ASIN refill cycle plus 2 h buffer.
    // Using EX 1800 (30 min) caused the key to expire when pm2 restarted mid-run, making
    // the UI fall back to the BullMQ queue count instead of the Keepa-managed counter.
    const activeTtl = (Math.ceil(displayCount / KEEPA_HOURLY_FILL) + 2) * 3600;
    redis.set(`repricer:running:${userId}`, displayCount, 'EX', activeTtl).catch(() => {});
  }
});
keepaWorker.on('completed', (job, result) => {
  _keepaActive = Math.max(0, _keepaActive - 1);
  wlog(`[KeepaWorker] ✅ job ${job?.id} done — ${result?.priceCount}/${result?.asinCount} prices fetched`);
  wlog(`[DEBUG KeepaWorker completed] _keepaActive=${_keepaActive} _runUserIds=${_runUserIds.size} _retryPendingFor=${_retryPendingFor.size}`);
  _checkAllDone();
});
keepaWorker.on('failed', (job, err) => {
  _keepaActive = Math.max(0, _keepaActive - 1);
  wlog(`[KeepaWorker] ❌ job ${job?.id} failed: ${err.message}`);
  wlog(`[DEBUG KeepaWorker failed] _keepaActive=${_keepaActive} _runUserIds=${_runUserIds.size}`);
  _checkAllDone();
});

// ─────────────────────────────────────────────
// QUEUE POLLER WORKER
// Polls OnBuy product creation queues that were
// still pending after the initial 15 s check.
// Runs every 15 min until all queues resolve.
// ─────────────────────────────────────────────

function _normalizeCondition(c) {
  if (!c) return 'new';
  const v = String(c).trim().toLowerCase().replace(/[\s-]+/g, '_');
  return ['new','used','refurbished','like_new'].includes(v) ? v : 'new';
}

const queuePollerWorker = new Worker('queue-poller', async (job) => {
  const plog = (...a) => {
    const line = `[${new Date().toISOString()}] ${a.join(' ')}\n`;
    console.log(line.trimEnd());
    rotatingAppend(join(LOGS_DIR, 'queue-poller.log'), line);
  };
  plog('[QueuePoller] Starting poll run');

  const { rows: pending } = await db.query(
    `SELECT pq.*, oa.consumer_key, oa.secret_key,
            COALESCE(oa.site_id, '2000')::int AS acct_site_id
     FROM   onbuy_bulk_pending_queues pq
     JOIN   onbuy_accounts oa ON oa.id = pq.account_id
     WHERE  pq.status = 'pending' AND pq.attempts < 96
     ORDER  BY pq.created_at ASC`
  ).catch(e => { plog(`[QueuePoller] DB query error: ${e.message}`); return { rows: [] }; });

  if (!pending.length) { plog('[QueuePoller] No pending queues — done'); return; }
  plog(`[QueuePoller] ${pending.length} pending queue(s) across ${new Set(pending.map(r => r.account_id)).size} account(s)`);

  // Group by account
  const byAccount = new Map();
  for (const q of pending) {
    if (!byAccount.has(q.account_id)) byAccount.set(q.account_id, []);
    byAccount.get(q.account_id).push(q);
  }

  let stillPending = 0;

  for (const [accountId, queues] of byAccount) {
    const sample  = queues[0];
    const token   = await getTokenForAccount({ consumer_key: sample.consumer_key, secret_key: sample.secret_key });
    const siteId  = sample.acct_site_id;

    if (!token) { plog(`[QueuePoller] No token for account ${accountId} — skipping`); continue; }

    for (let i = 0; i < queues.length; i += 1000) {
      const batch   = queues.slice(i, i + 1000);
      // Poll in sub-batches of 100 to stay under URL length limits
      // (1000 IDs × 27 encoded chars ≈ 27 KB URL — gateways reject above ~8 KB)
      const pollMap = new Map();
      for (let j = 0; j < batch.length; j += 100) {
        const subBatch = batch.slice(j, j + 100);
        const ids      = subBatch.map(q => q.queue_id).join(',');
        try {
          const pr   = await fetch(
            `https://api.onbuy.com/v2/queues?site_id=${siteId}&filter[queue_ids]=${encodeURIComponent(ids)}`,
            { headers: { Authorization: token } }
          );
          const text = await pr.text();
          let pd;
          try { pd = JSON.parse(text); } catch {
            plog(`[QueuePoller] Sub-batch poll error: not valid JSON (HTTP ${pr.status}) — skipping`);
            continue;
          }
          const list = pd?.results ?? [];
          for (const q of list) pollMap.set(q.queue_id, q);
        } catch (e) { plog(`[QueuePoller] Sub-batch poll error: ${e.message}`); }
      }

      plog(`[QueuePoller] Account ${accountId} batch: ${batch.length} polled → ${pollMap.size} results`);

      const successItems = [];

      for (const q of batch) {
        const userId    = q.user_id;
        const sessionId = q.session_id;
        const ilog = (msg) => {
          const line = `[${new Date().toISOString()}] [QueuePoller][session=${sessionId}] ${msg}\n`;
          rotatingAppend(join(LOGS_DIR, `user-${userId}-import.log`), line);
        };

        const qr     = pollMap.get(q.queue_id) ?? {};
        const status = qr.status ?? 'pending';
        const opc    = qr.opc   ?? null;

        const sku = q.row_meta?.row?.sku ?? q.uid ?? '?';
        ilog(`Queue ${q.queue_id} [${sku}]: status=${status}${opc ? ' opc='+opc : ''} (attempt ${q.attempts + 1})`);

        if (status === 'success' && opc) {
          await db.query(
            `UPDATE onbuy_bulk_pending_queues SET status='success', opc=$1, last_polled_at=NOW() WHERE queue_id=$2`,
            [opc, q.queue_id]
          ).catch(() => {});
          successItems.push({ ...q, opc, ilog });
        } else if (status === 'failed' || status === 'error') {
          const msg = typeof qr.error_message === 'string' ? qr.error_message : JSON.stringify(qr.error_message || 'Queue failed');
          ilog(`Queue ${q.queue_id}: failed — ${msg}`);
          await db.query(
            `UPDATE onbuy_bulk_pending_queues SET status='failed', error_message=$1, last_polled_at=NOW(), attempts=attempts+1 WHERE queue_id=$2`,
            [msg, q.queue_id]
          ).catch(() => {});
          const rm = q.row_meta;
          db.query(
            `INSERT INTO onbuy_bulk_import_items
              (session_id,user_id,row_number,product_name,sku,ean,category,brand,
               source_price,selling_price,stock,condition,status,error_message)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'error',$13)`,
            [q.session_id, q.user_id, rm?.row?._row, rm?.row?.name, rm?.row?.sku, rm?.row?.ean,
             rm?.row?.category, rm?.row?.brand, rm?.sourcePrice, rm?.sellingPrice,
             parseInt(rm?.row?.stock)||0, _normalizeCondition(rm?.row?.condition), msg]
          ).catch(() => {});
          db.query(
            `UPDATE onbuy_bulk_import_sessions SET errors_count = errors_count + 1, pending_queues = GREATEST(pending_queues - 1, 0) WHERE id = $1`,
            [q.session_id]
          ).catch(() => {});
        } else {
          stillPending++;
          await db.query(
            `UPDATE onbuy_bulk_pending_queues SET attempts=attempts+1, last_polled_at=NOW() WHERE queue_id=$1`,
            [q.queue_id]
          ).catch(() => {});
        }
      }

      // Create listings for resolved queues
      if (successItems.length > 0) {
        const ilog = successItems[0].ilog;
        ilog(`Creating listings for ${successItems.length} resolved queue(s)`);

        for (let li = 0; li < successItems.length; li += 100) {
          const lchunk   = successItems.slice(li, li + 100);
          const listings = lchunk.map(q => {
            const m = q.row_meta;
            return {
              opc:       q.opc,
              condition: _normalizeCondition(m.row?.condition),
              price:     m.sellingPrice,
              stock:     parseInt(m.row?.stock) || 0,
              ...(m.row?.sku             ? { sku: m.row.sku }                             : {}),
              ...(m.row?.delivery_weight ? { delivery_weight: parseFloat(m.row.delivery_weight) } : {}),
            };
          });

          try {
            const lr  = await fetch(`https://api.onbuy.com/v2/listings?site_id=${siteId}`, {
              method:  'POST',
              headers: { Authorization: token, 'Content-Type': 'application/json' },
              body:    JSON.stringify({ site_id: siteId, listings }),
            });
            const ld  = await lr.json();
            ilog(`Listing POST ${lr.status}: ${JSON.stringify(ld).slice(0, 300)}`);

            const lrs = ld?.results ?? ld?.payload ?? [];
            for (let j = 0; j < lchunk.length; j++) {
              const q   = lchunk[j];
              const res = Array.isArray(lrs) ? lrs[j] : null;
              const ok  = !res || res.success !== false;
              const m   = q.row_meta;

              await db.query(
                `UPDATE onbuy_bulk_pending_queues SET status=$1, last_polled_at=NOW() WHERE queue_id=$2`,
                [ok ? 'listing_created' : 'failed', q.queue_id]
              ).catch(() => {});

              if (ok) {
                q.ilog(`Listing created — OPC=${q.opc} SKU=${m.row?.sku}`);
                db.query(
                  `INSERT INTO onbuy_bulk_import_items
                    (session_id,user_id,row_number,product_name,sku,ean,category,brand,
                     source_price,selling_price,stock,condition,opc,status)
                   VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'listing_created')`,
                  [q.session_id, q.user_id, m.row?._row, m.row?.name, m.row?.sku, m.row?.ean,
                   m.row?.category, m.row?.brand, m.sourcePrice, m.sellingPrice,
                   parseInt(m.row?.stock)||0, _normalizeCondition(m.row?.condition), q.opc]
                ).catch(() => {});
                db.query(
                  `UPDATE onbuy_bulk_import_sessions SET listings_created = listings_created + 1, pending_queues = GREATEST(pending_queues - 1, 0) WHERE id = $1`,
                  [q.session_id]
                ).catch(() => {});
              } else {
                const errMsg = res?.message || 'Listing rejected';
                const isSuspended = typeof errMsg === 'string' && errMsg.toLowerCase().includes('suspended');
                const itemStatus  = isSuspended ? 'suspended' : 'error';
                q.ilog(`Listing ${isSuspended ? 'suspended' : 'failed'} — OPC=${q.opc}: ${errMsg}`);
                await db.query(
                  `UPDATE onbuy_bulk_pending_queues SET status=$1, error_message=$2 WHERE queue_id=$3`,
                  [itemStatus, typeof errMsg === 'string' ? errMsg : JSON.stringify(errMsg), q.queue_id]
                ).catch(() => {});
                db.query(
                  `INSERT INTO onbuy_bulk_import_items
                    (session_id,user_id,row_number,product_name,sku,ean,category,brand,
                     source_price,selling_price,stock,condition,opc,status,error_message)
                   VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
                  [q.session_id, q.user_id, m.row?._row, m.row?.name, m.row?.sku, m.row?.ean,
                   m.row?.category, m.row?.brand, m.sourcePrice, m.sellingPrice,
                   parseInt(m.row?.stock)||0, _normalizeCondition(m.row?.condition), q.opc,
                   itemStatus, typeof errMsg === 'string' ? errMsg : JSON.stringify(errMsg)]
                ).catch(() => {});
                db.query(
                  `UPDATE onbuy_bulk_import_sessions SET errors_count = errors_count + 1, pending_queues = GREATEST(pending_queues - 1, 0) WHERE id = $1`,
                  [q.session_id]
                ).catch(() => {});
              }
            }
          } catch (e) {
            ilog(`Listing creation error: ${e.message}`);
          }
        }
      }
    }
  }

  if (stillPending > 0) {
    plog(`[QueuePoller] ${stillPending} queue(s) still pending — next poll in 15 min`);
    await queuePollerQueue.add('poll', {}, {
      jobId:            `queue-poller-${Date.now()}`,
      delay:            15 * 60 * 1000,
      removeOnComplete: true,
      removeOnFail:     true,
      attempts:         1,
    }).catch(() => {});
  } else {
    plog('[QueuePoller] All queues resolved');
    // Mark any sessions that are still 'processing' but have no more pending queues as completed
    db.query(
      `UPDATE onbuy_bulk_import_sessions
       SET status='completed', completed_at=NOW()
       WHERE status='processing'
         AND (pending_queues IS NULL OR pending_queues = 0)
         AND id NOT IN (
           SELECT DISTINCT session_id FROM onbuy_bulk_pending_queues WHERE status='pending'
         )`
    ).catch(e => plog(`[QueuePoller] Session cleanup error: ${e.message}`));
  }
}, { connection: redis, concurrency: 1 });

queuePollerWorker.on('failed', (job, err) =>
  console.error(`[QueuePoller] ❌ job ${job?.id} failed: ${err.message}`)
);

// ─────────────────────────────────────────────
// BULK IMPORT WORKER
// ─────────────────────────────────────────────

function _bulkTruncateToBytes(str, maxBytes) {
  if (Buffer.byteLength(str, 'utf8') <= maxBytes) return str;
  let bytes = 0, i = 0;
  while (i < str.length) {
    const cb = Buffer.byteLength(str[i], 'utf8');
    if (bytes + cb > maxBytes) break;
    bytes += cb; i++;
  }
  return str.slice(0, i);
}
const BULK_CONDITIONS = new Set(['new','used','good','fair','poor','refurbished','atypical']);
function _bulkNormCond(val) {
  const s = String(val ?? '').toLowerCase().trim();
  return BULK_CONDITIONS.has(s) ? s : 'new';
}

async function processBulkImportJob(job) {
  const { sessionId, accountId, userId } = job.data;

  function blog(...args) {
    const msg  = args.join(' ');
    const line = `[${new Date().toISOString()}] [BulkImport][session=${sessionId}] ${msg}\n`;
    const logFile = join(LOGS_DIR, `user-${userId}-import.log`);
    rotatingAppend(logFile, line);
    console.log(`[BulkImport][s=${sessionId}]`, msg);
  }

  try {
  // Read rows from session record (stored as JSONB to avoid large Redis payloads)
  const { rows: [sess] } = await db.query(
    `SELECT rows_data FROM onbuy_bulk_import_sessions WHERE id=$1`,
    [sessionId]
  );
  if (!sess?.rows_data) throw new Error(`Session ${sessionId} has no rows_data`);
  const validRows = sess.rows_data;

  // rows_data is kept for export — cleared when user cancels or after 30 days

  // Get fresh account + token
  const { rows: [account] } = await db.query(
    `SELECT * FROM onbuy_accounts WHERE id=$1 AND is_active=true`, [accountId]
  );
  if (!account) throw new Error(`Account ${accountId} not found`);
  const token = await getTokenForAccount(account);
  if (!token) throw new Error(`Failed to get OnBuy token for account ${accountId}`);
  const siteId = account.site_id || '2000';

  const results = { product_created: 0, listing_created: 0, listing_updated: 0, skipped: 0, errors: [] };
  const categoryCache = {};
  const CHUNK        = 1000; // listing creation (Phase 4) — small payload per item
  const CREATE_CHUNK = 100;  // product creation (Phase 2/3.5) — large payload (desc + images)
  let currentToken = token; // mutable so we can refresh mid-job

  async function refreshToken() {
    const newTok = await getTokenForAccount(account);
    if (newTok) { currentToken = newTok; blog('Token refreshed mid-job'); }
    else blog('Token refresh failed — continuing with old token');
    return !!newTok;
  }

  async function syncCategoriesIfNeeded() {
    const { rows: [{ cnt }] } = await db.query(`SELECT COUNT(*) AS cnt FROM onbuy_categories`);
    if (parseInt(cnt) === 0) throw new Error('No OnBuy categories found. Ask the admin to upload the categories file in Settings.');
    blog(`Categories ready — ${cnt} categories in DB`);
  }

  // Splits a string like "A › B > C | D" into clean segments regardless of separator used
  function parseCategoryPath(str) {
    return String(str || '')
      .replace(/[›»]/g, '>') // normalize Unicode arrow separators to >
      .split('>')
      .map(s => s.trim())
      .filter(Boolean);
  }

  // Score how many words from `needleWords` appear in `haystack` (case-insensitive)
  function wordOverlapScore(needleWords, haystack) {
    const h = haystack.toLowerCase();
    return needleWords.filter(w => h.includes(w)).length;
  }

  // Extract meaningful words from a string (min 3 chars, skip stop words)
  const STOP_WORDS = new Set([
    'and','the','for','with','from','this','that','into','only','plus',
    'size','colour','color','black','white','pack','set','box','new','all',
  ]);
  function keywords(str, minLen = 3) {
    return String(str || '')
      .split(/[\s\-_,.()/&›>]+/)
      .map(w => w.replace(/[^a-zA-Z0-9]/g, '').toLowerCase())
      .filter(w => w.length >= minLen && !STOP_WORDS.has(w));
  }

  // Pick best match from a candidate row list by word-overlap score.
  // Returns the category_id if any candidate scores above the threshold.
  function bestWordMatch(candidates, needleWords, field = 'name', threshold = 0.5) {
    let best = null, bestScore = 0;
    for (const row of candidates) {
      const score = wordOverlapScore(needleWords, row[field]);
      if (score > bestScore) { bestScore = score; best = row; }
    }
    // require at least `threshold` fraction of needle words to match
    if (best && bestScore >= Math.max(1, Math.ceil(needleWords.length * threshold))) {
      return best.category_id;
    }
    return null;
  }

  async function lookupCategoryId(catValue, productName = null) {
    const trimmed = String(catValue || '').trim();

    // Numeric ID — use directly without any lookup
    if (/^\d+$/.test(trimmed)) return parseInt(trimmed, 10);

    // Cache hit (only positive results are cached; nulls are NOT cached so the
    // product-name fallback can still fire on the per-row call)
    if (categoryCache[trimmed] !== undefined) return categoryCache[trimmed];

    // Normalize separators and split into segments
    const segments = parseCategoryPath(trimmed);
    const leafName = segments[segments.length - 1] ?? trimmed;
    const mainCat  = segments[0] ?? trimmed;
    const leafWords = keywords(leafName);

    // ── Tier 1: exact full-path match ──
    if (segments.length > 1) {
      const fullPath = segments.join(' > ');
      const { rows: t1 } = await db.query(
        `SELECT category_id FROM onbuy_categories
         WHERE lower(COALESCE(tree,'') || ' > ' || name) = lower($1)
         LIMIT 1`,
        [fullPath]
      );
      if (t1[0]) {
        categoryCache[trimmed] = t1[0].category_id;
        blog(`Category → id=${t1[0].category_id} (full path exact)`);
        return categoryCache[trimmed];
      }
    }

    // ── Tier 2: leaf name exact ──
    const { rows: t2 } = await db.query(
      `SELECT category_id FROM onbuy_categories WHERE lower(name)=lower($1) LIMIT 1`,
      [leafName]
    );
    if (t2[0]) {
      categoryCache[trimmed] = t2[0].category_id;
      blog(`Category "${leafName}" → id=${t2[0].category_id} (leaf exact)`);
      return categoryCache[trimmed];
    }

    // ── Tier 3: leaf word-intersection — fetch all categories whose name contains
    //    at least one word from the leaf, then pick the best-scoring one.
    //    Handles: "Baby Nappies" → "Baby Disposable Nappies" ──
    if (leafWords.length) {
      const conditions = leafWords.map((_, i) => `lower(name) LIKE lower($${i + 1})`).join(' OR ');
      const params     = leafWords.map(w => `%${w}%`);
      const { rows: t3candidates } = await db.query(
        `SELECT category_id, name FROM onbuy_categories WHERE ${conditions}`,
        params
      );
      const t3id = bestWordMatch(t3candidates, leafWords, 'name', 0.5);
      if (t3id) {
        categoryCache[trimmed] = t3id;
        blog(`Category "${leafName}" → id=${t3id} (leaf word-overlap)`);
        return categoryCache[trimmed];
      }
    }

    // ── Tier 4: main category word-intersection against tree column ──
    //    Handles: "Baby Products" → "Baby & Toddler > …" ──
    if (segments.length > 1) {
      const mainWords = keywords(mainCat);
      if (mainWords.length) {
        const conditions = mainWords.map((_, i) => `lower(tree) LIKE lower($${i + 1})`).join(' OR ');
        const params     = mainWords.map(w => `%${w}%`);
        const { rows: t4candidates } = await db.query(
          `SELECT category_id, tree FROM onbuy_categories WHERE ${conditions} ORDER BY level DESC`,
          params
        );
        const t4id = bestWordMatch(t4candidates, mainWords, 'tree', 0.4);
        if (t4id) {
          categoryCache[trimmed] = t4id;
          blog(`Category "${mainCat}…" → id=${t4id} (main cat word-overlap)`);
          return categoryCache[trimmed];
        }
      }
    }

    // ── Tier 5: product name keyword fallback (per-row only, not cached) ──
    if (productName) {
      const prodWords = keywords(productName, 4).slice(0, 6);
      for (const kw of prodWords) {
        const { rows: t5 } = await db.query(
          `SELECT category_id FROM onbuy_categories
           WHERE lower(name) LIKE lower($1) OR lower(tree) LIKE lower($1)
           ORDER BY (lower(name) LIKE lower($1))::int DESC
           LIMIT 1`,
          [`%${kw}%`]
        );
        if (t5[0]) {
          blog(`Category fallback via product keyword "${kw}" → id=${t5[0].category_id}`);
          return t5[0].category_id; // not cached — product-specific
        }
      }
    }

    blog(`Category "${trimmed}" not resolved`);
    return null; // not cached — allows retry on next per-row call
  }

  async function batchPollQueues(queueIds) {
    const resultMap = new Map();
    for (let i = 0; i < queueIds.length; i += 100) {
      const chunk = queueIds.slice(i, i + 100);
      try {
        const r    = await fetch(
          `https://api.onbuy.com/v2/queues?site_id=${siteId}&filter[queue_ids]=${encodeURIComponent(chunk.join(','))}`,
          { headers: { Authorization: currentToken } }
        );
        const text = await r.text();
        let data; try { data = JSON.parse(text); } catch {
          blog(`Batch poll sub-batch error: not valid JSON (HTTP ${r.status})`); continue;
        }
        for (const q of data?.results ?? []) resultMap.set(q.queue_id, q);
      } catch (e) { blog(`Batch poll sub-batch error: ${e.message}`); }
    }
    return resultMap;
  }

  // ── Phase 1a: EAN search (3 concurrent batches of 50) ──
  const rowsWithEan = validRows.filter(r => r.ean);
  const eanOpcMap   = new Map();
  blog(`Phase 1a: EAN search — ${rowsWithEan.length} rows with EAN`);
  const eanBatches = [];
  for (let i = 0; i < rowsWithEan.length; i += 50)
    eanBatches.push({ chunk: rowsWithEan.slice(i, i + 50), batchNum: Math.floor(i / 50) + 1 });
  for (let i = 0; i < eanBatches.length; i += 3) {
    await Promise.all(eanBatches.slice(i, i + 3).map(async ({ chunk, batchNum }) => {
      const eans = chunk.map(r => r.ean).join(',');
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          const r = await fetch(
            `https://api.onbuy.com/v2/products?site_id=${siteId}&filter[field]=product_code&filter[query]=${encodeURIComponent(eans)}`,
            { headers: { Authorization: currentToken } }
          );
          if (r.status === 429) { blog(`EAN batch ${batchNum} rate-limited — waiting ${attempt} min`); await new Promise(res => setTimeout(res, attempt * 60_000)); continue; }
          const data = await r.json();
          for (const p of data?.results ?? data?.payload ?? []) {
            const opc = p.opc ?? p.product_code ?? null;
            for (const code of (Array.isArray(p.product_codes) ? p.product_codes : [])) eanOpcMap.set(String(code).trim(), opc);
          }
          blog(`EAN batch ${batchNum}: ${chunk.length} → ${eanOpcMap.size} total matches`);
          break;
        } catch (e) { blog(`EAN batch ${batchNum} error: ${e.message}`); break; }
      }
    }));
  }

  // ── Phase 1b: Sync category DB then warm in-memory cache ──
  await syncCategoriesIfNeeded();
  const uniqueCats = [...new Set(validRows.map(r => r.category).filter(Boolean))];
  blog(`Phase 1b: resolving ${uniqueCats.length} unique categories from DB`);
  for (const cat of uniqueCats) await lookupCategoryId(cat); // pure DB lookups — no delay needed

  const existingMeta = [], newMeta = [];
  for (const row of validRows) {
    const sourcePrice  = parseFloat(row.price) || 0;
    const sellingPrice = parseFloat((sourcePrice * 1.20 / 0.85).toFixed(2));
    const categoryId   = await lookupCategoryId(row.category, row.name);
    if (!categoryId) {
      const errMsg = `Category "${row.category}" not found on OnBuy`;
      results.errors.push({ row: row._row, product: row.name, error: errMsg }); results.skipped++;
      db.query(`INSERT INTO onbuy_bulk_import_items (session_id,user_id,row_number,product_name,sku,ean,category,brand,source_price,selling_price,stock,condition,status,error_message) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'error',$13)`,
        [sessionId,userId,row._row,row.name,row.sku,row.ean,row.category,row.brand,sourcePrice,sellingPrice,parseInt(row.stock)||0,_bulkNormCond(row.condition),errMsg]).catch(() => {});
      continue;
    }
    const opc  = row.ean ? (eanOpcMap.get(String(row.ean).trim()) ?? null) : null;
    const meta = { row, sourcePrice, sellingPrice, categoryId, opc };
    if (opc) existingMeta.push(meta); else newMeta.push(meta);
  }
  blog(`Phase 1 complete: ${existingMeta.length} existing, ${newMeta.length} new`);

  // ── Phase 2: Create new products ──
  const queueItems = [];
  for (const m of newMeta) {
    if (!m.row.images?.[0]) {
      const errMsg = 'Default image required to create product';
      results.errors.push({ row: m.row._row, product: m.row.name, error: errMsg }); results.skipped++;
      db.query(`INSERT INTO onbuy_bulk_import_items (session_id,user_id,row_number,product_name,sku,ean,category,brand,source_price,selling_price,stock,condition,status,error_message) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'error',$13)`,
        [sessionId,userId,m.row._row,m.row.name,m.row.sku,m.row.ean,m.row.category,m.row.brand,m.sourcePrice,m.sellingPrice,parseInt(m.row.stock)||0,_bulkNormCond(m.row.condition),errMsg]).catch(() => {});
    }
  }
  let toCreate = newMeta.filter(m => m.row.images?.[0]);
  const candidateSkus = toCreate.map(m => m.row.sku).filter(Boolean);
  if (candidateSkus.length > 0) {
    const { rows: alreadyPending } = await db.query(
      `SELECT uid FROM onbuy_bulk_pending_queues WHERE uid=ANY($1) AND status='pending' AND user_id=$2`,
      [candidateSkus, userId]
    ).catch(() => ({ rows: [] }));
    if (alreadyPending.length > 0) {
      const pendingSkus = new Set(alreadyPending.map(r => r.uid));
      blog(`Phase 2: ${pendingSkus.size} SKU(s) already pending — skipping`);
      toCreate = toCreate.filter(m => !pendingSkus.has(m.row.sku));
    }
  }
  // POST a chunk to OnBuy. On HTTP 500 non-JSON: retry with short delays, then split in half
  // and recurse until each sub-chunk succeeds or shrinks to 1 product (logged as a row error).
  async function sendChunk(products, chunkMeta) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      if (attempt > 1) {
        const wait = attempt === 2 ? 5_000 : 10_000;
        blog(`sendChunk(${chunkMeta.length}) HTTP 500 — retry ${attempt}/3 in ${wait / 1000}s…`);
        await new Promise(r => setTimeout(r, wait));
      }
      let fetchRes = await fetch('https://api.onbuy.com/v2/products', {
        method: 'POST', headers: { Authorization: currentToken, 'Content-Type': 'application/json' },
        body: JSON.stringify({ site_id: parseInt(siteId)||2000, products }),
      });
      if (fetchRes.status === 401) {
        await refreshToken();
        fetchRes = await fetch('https://api.onbuy.com/v2/products', {
          method: 'POST', headers: { Authorization: currentToken, 'Content-Type': 'application/json' },
          body: JSON.stringify({ site_id: parseInt(siteId)||2000, products }),
        });
      }
      // Read body as text first — avoids "body already consumed" bug when .json() throws
      const txt = await fetchRes.text().catch(() => '');
      let data;
      try { data = JSON.parse(txt); } catch { /* non-JSON */ }
      if (data) return data.results ?? [];

      // Non-JSON response (HTTP 500 / empty body)
      blog(`sendChunk(${chunkMeta.length}) HTTP ${fetchRes.status} non-JSON (attempt ${attempt}/3): ${txt.slice(0, 200)}`);
      if (attempt < 3) continue;

      // 3 attempts exhausted — single product: log as individual row error and continue job
      if (chunkMeta.length <= 1) {
        blog(`sendChunk: single product failed after 3 attempts — logged as row error`);
        return [{ queue_id: null, message: `HTTP ${fetchRes.status} — server error after 3 attempts` }];
      }

      // Multi-product chunk: split in half and retry each half recursively
      const mid = Math.ceil(products.length / 2);
      blog(`sendChunk(${chunkMeta.length}) splitting → ${mid} + ${products.length - mid} after 3× HTTP ${fetchRes.status}`);
      await new Promise(r => setTimeout(r, 3_000)); // brief pause before split retries
      const r1 = await sendChunk(products.slice(0, mid), chunkMeta.slice(0, mid));
      const r2 = await sendChunk(products.slice(mid), chunkMeta.slice(mid));
      return [...r1, ...r2];
    }
    return chunkMeta.map(() => ({ queue_id: null, message: 'No response received' }));
  }

  for (let i = 0; i < toCreate.length; i += CREATE_CHUNK) {
    const chunk    = toCreate.slice(i, i + CREATE_CHUNK);
    const products = chunk.map(({ row, sellingPrice, categoryId }) => {
      const brandVal = row.brand?.trim();
      const addImgs  = (row.images || []).slice(1).filter(Boolean);
      return {
        uid:          row.sku || `bulk-${row._row ?? Date.now()}`,
        published:    '1',
        category_id:  categoryId,
        product_name: _bulkTruncateToBytes(row.name, 150),
        ...(brandVal ? { brand_name: brandVal } : { brand_id: 1 }),
        default_image: row.images[0],
        ...(addImgs.length      ? { additional_images: addImgs }     : {}),
        ...(row.description     ? { description: String(row.description).replace(/[<>]/g, '') } : {}),
        ...(row.ean             ? { product_codes: [row.ean] }       : {}),
        ...(row.mpn             ? { mpn: row.mpn }                   : {}),
        ...(row.delivery_weight ? { delivery_weight: parseFloat(row.delivery_weight) } : {}),
      };
    });
    blog(`Phase 2: batch creating ${chunk.length} product(s) (chunk ${Math.floor(i/CREATE_CHUNK)+1} of ${Math.ceil(toCreate.length/CREATE_CHUNK)})`);
    const batchResults = await sendChunk(products, chunk);
    blog(`Phase 2 chunk ${Math.floor(i/CREATE_CHUNK)+1}: ${batchResults.length} results received`);
    for (let j = 0; j < chunk.length; j++) {
      const m  = chunk[j];
      const br = batchResults[j];
      if (!br?.queue_id) {
        const baseMsg   = br?.message || 'No queue_id returned';
        const fieldErrs = br?.messages && typeof br.messages === 'object'
          ? Object.entries(br.messages).map(([f, v]) => `${f}: ${Array.isArray(v) ? v.join(', ') : v}`).join('; ')
          : null;
        const msg = fieldErrs ? `${baseMsg} — ${fieldErrs}` : baseMsg;
        results.errors.push({ row: m.row._row, product: m.row.name, error: msg }); results.skipped++;
        db.query(`INSERT INTO onbuy_bulk_import_items (session_id,user_id,row_number,product_name,sku,ean,category,brand,source_price,selling_price,stock,condition,status,error_message) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'error',$13)`,
          [sessionId,userId,m.row._row,m.row.name,m.row.sku,m.row.ean,m.row.category,m.row.brand,m.sourcePrice,m.sellingPrice,parseInt(m.row.stock)||0,_bulkNormCond(m.row.condition),msg]).catch(() => {});
      } else {
        queueItems.push({ meta: m, queueId: br.queue_id });
      }
    }
  }

  // ── Phase 3: Poll queues 15 s after product creation ──
  // Newly created products go into newlyCreatedMeta (not existingMeta) so Phase 3.5
  // skips updating them — the Phase 2 POST already sent all required fields.
  const newlyCreatedMeta = [];
  if (queueItems.length > 0) {
    blog(`Phase 3: waiting 15 s before polling ${queueItems.length} queue(s)…`);
    await new Promise(res => setTimeout(res, 15_000));
    const pendingToSave = [];
    for (let i = 0; i < queueItems.length; i += 1000) {
      const batch   = queueItems.slice(i, i + 1000);
      const pollMap = await batchPollQueues(batch.map(q => q.queueId));
      blog(`Phase 3 batch ${Math.floor(i/1000)+1}: polled ${batch.length} → ${pollMap.size} results`);
      for (const { meta, queueId } of batch) {
        const qr     = pollMap.get(queueId) ?? {};
        const status = qr.status ?? 'pending';
        const opc    = qr.opc   ?? null;
        if (status === 'success' && opc) {
          results.product_created++;
          newlyCreatedMeta.push({ ...meta, opc });
          db.query(`INSERT INTO onbuy_bulk_import_items (session_id,user_id,row_number,product_name,sku,ean,category,brand,source_price,selling_price,stock,condition,opc,status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'product_created')`,
            [sessionId,userId,meta.row._row,meta.row.name,meta.row.sku,meta.row.ean,meta.row.category,meta.row.brand,meta.sourcePrice,meta.sellingPrice,parseInt(meta.row.stock)||0,_bulkNormCond(meta.row.condition),opc]).catch(() => {});
        } else if (status === 'failed' || status === 'error') {
          const error = qr.error_message || 'Product queue failed';
          const dupEan = (error.match(/Duplicate entry '(\d+)'/) || [])[1];
          if (dupEan) {
            try {
              const sr = await fetch(`https://api.onbuy.com/v2/products?site_id=${siteId}&filter[field]=product_code&filter[query]=${encodeURIComponent(dupEan)}`, { headers: { Authorization: currentToken } });
              const sd = await sr.json();
              const existingOpc = (sd?.results ?? sd?.payload ?? [])[0]?.opc ?? null;
              if (existingOpc) { existingMeta.push({ ...meta, opc: existingOpc }); }
              else throw new Error(`EAN ${dupEan} found but no OPC`);
            } catch (searchErr) {
              results.errors.push({ row: meta.row._row, product: meta.row.name, error: searchErr.message }); results.skipped++;
              db.query(`INSERT INTO onbuy_bulk_import_items (session_id,user_id,row_number,product_name,sku,ean,category,brand,source_price,selling_price,stock,condition,status,error_message) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'error',$13)`,
                [sessionId,userId,meta.row._row,meta.row.name,meta.row.sku,meta.row.ean,meta.row.category,meta.row.brand,meta.sourcePrice,meta.sellingPrice,parseInt(meta.row.stock)||0,_bulkNormCond(meta.row.condition),searchErr.message]).catch(() => {});
            }
          } else {
            results.errors.push({ row: meta.row._row, product: meta.row.name, error }); results.skipped++;
            db.query(`INSERT INTO onbuy_bulk_import_items (session_id,user_id,row_number,product_name,sku,ean,category,brand,source_price,selling_price,stock,condition,status,error_message) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'error',$13)`,
              [sessionId,userId,meta.row._row,meta.row.name,meta.row.sku,meta.row.ean,meta.row.category,meta.row.brand,meta.sourcePrice,meta.sellingPrice,parseInt(meta.row.stock)||0,_bulkNormCond(meta.row.condition),error]).catch(() => {});
          }
        } else {
          pendingToSave.push({ queueId, meta, uid: qr.uid ?? meta.row.uid ?? null });
        }
      }
    }
    if (pendingToSave.length > 0) {
      blog(`Phase 3: ${pendingToSave.length} queue(s) still pending → background poller`);
      for (const { queueId, meta, uid } of pendingToSave) {
        await db.query(
          `INSERT INTO onbuy_bulk_pending_queues (session_id,user_id,account_id,site_id,queue_id,uid,row_meta) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (queue_id) DO NOTHING`,
          [sessionId,userId,accountId,siteId,queueId,uid,JSON.stringify({ row: meta.row, sourcePrice: meta.sourcePrice, sellingPrice: meta.sellingPrice })]
        ).catch(e => blog(`Failed to save pending queue ${queueId}: ${e.message}`));
      }
      results.pending_queues = pendingToSave.length;
      db.query(`UPDATE onbuy_bulk_import_sessions SET pending_queues=$1 WHERE id=$2`, [pendingToSave.length, sessionId]).catch(() => {});
      await queuePollerQueue.add('poll', {}, { jobId: `queue-poller-${Date.now()}`, delay: 15*60*1000, removeOnComplete: true, removeOnFail: true, attempts: 1 }).catch(() => {});
    }
  }
  // Update counters after Phase 3 so the UI shows live progress while processing
  db.query(
    `UPDATE onbuy_bulk_import_sessions SET products_created=$1, skipped=$2, errors_count=$3 WHERE id=$4`,
    [results.product_created, results.skipped, results.errors.length, sessionId]
  ).catch(() => {});

  // ── Phase 3.5: Update pre-existing products only ──
  // Newly created products (newlyCreatedMeta) are skipped — Phase 2 already sent all fields.
  const toUpdate = existingMeta.filter(m => m.opc);
  if (toUpdate.length > 0) {
    blog(`Phase 3.5: updating ${toUpdate.length} pre-existing product(s)`);
    for (let i = 0; i < toUpdate.length; i += CREATE_CHUNK) {
      const chunk    = toUpdate.slice(i, i + CREATE_CHUNK);
      const products = chunk.map(({ row, categoryId, opc }) => {
        const brandVal = row.brand?.trim();
        const addImgs  = (row.images || []).slice(1).filter(Boolean);
        return {
          opc,
          product_name: _bulkTruncateToBytes(row.name, 150),
          category_id:  categoryId,
          ...(brandVal ? { brand_name: brandVal } : {}),
          ...(row.images?.[0]   ? { default_image: row.images[0] }   : {}),
          ...(addImgs.length    ? { additional_images: addImgs }      : {}),
          ...(row.description   ? { description: String(row.description).replace(/[<>]/g, '') } : {}),
          ...(row.mpn           ? { mpn: row.mpn }                    : {}),
          ...(row.delivery_weight ? { delivery_weight: parseFloat(row.delivery_weight) } : {}),
        };
      });
      let p35Res = await fetch('https://api.onbuy.com/v2/products', {
        method: 'PUT', headers: { Authorization: currentToken, 'Content-Type': 'application/json' },
        body: JSON.stringify({ site_id: parseInt(siteId)||2000, products }),
      });
      if (p35Res.status === 401) {
        await refreshToken();
        p35Res = await fetch('https://api.onbuy.com/v2/products', {
          method: 'PUT', headers: { Authorization: currentToken, 'Content-Type': 'application/json' },
          body: JSON.stringify({ site_id: parseInt(siteId)||2000, products }),
        });
      }
      blog(`Phase 3.5 HTTP ${p35Res.status}: chunk ${Math.floor(i/CREATE_CHUNK)+1}`);
    }
  }

  // ── Phase 4: Create listings ──
  // Covers both pre-existing products (existingMeta) and newly created ones (newlyCreatedMeta).
  const allListingMeta = [...existingMeta, ...newlyCreatedMeta];
  if (allListingMeta.length > 0) {
    blog(`Phase 4: creating ${allListingMeta.length} listing(s) (${existingMeta.length} pre-existing + ${newlyCreatedMeta.length} newly created)`);
    for (let i = 0; i < allListingMeta.length; i += CHUNK) {
      const chunk    = allListingMeta.slice(i, i + CHUNK);
      const listings = chunk.map(({ row, sellingPrice, opc }) => ({
        opc, condition: _bulkNormCond(row.condition), price: sellingPrice, stock: parseInt(row.stock)||0,
        ...(row.sku             ? { sku: row.sku }                                    : {}),
        ...(row.delivery_weight ? { delivery_weight: parseFloat(row.delivery_weight) } : {}),
      }));
      let listingRes, listingData;
      for (let attempt = 1; attempt <= 3; attempt++) {
        listingRes  = await fetch(`https://api.onbuy.com/v2/listings?site_id=${siteId}`, {
          method: 'POST', headers: { Authorization: currentToken, 'Content-Type': 'application/json' },
          body: JSON.stringify({ site_id: parseInt(siteId)||2000, listings }),
        });
        if (listingRes.status === 401) { await refreshToken(); continue; }
        listingData = await listingRes.json();
        if (!/does not yet exist for the site/i.test(JSON.stringify(listingData))) break;
        if (attempt < 3) { blog(`OPC not propagated — waiting 15 s`); await new Promise(res => setTimeout(res, 15_000)); }
      }
      if (!listingData) listingData = {};
      if (!listingRes.ok && !listingData?.results) {
        blog(`Phase 4 listing chunk HTTP ${listingRes.status}: ${JSON.stringify(listingData).slice(0, 300)}`);
      }
      const listingResults = listingData?.results ?? listingData?.payload ?? [];
      const updateNeeded   = [];
      for (let j = 0; j < chunk.length; j++) {
        const m   = chunk[j];
        const lr  = Array.isArray(listingResults) ? listingResults[j] : null;
        const cnd = _bulkNormCond(m.row.condition);
        if (!listingRes.ok || lr?.success === false) {
          const baseMsg    = lr?.message || listingData?.message || listingData?.error?.message || `Listing rejected by OnBuy (HTTP ${listingRes.status})`;
          const fieldErrs  = Array.isArray(lr?.errors) ? lr.errors.map(e => `${e.field}: ${e.message}`).join('; ') : null;
          const msg        = fieldErrs ? `${baseMsg} — ${fieldErrs}` : baseMsg;
          if (/already have a listing|listing already exist|duplicate listing/i.test(msg) && m.row.sku) {
            updateNeeded.push(m);
          } else {
            results.errors.push({ row: m.row._row, product: m.row.name, error: msg }); results.skipped++;
            db.query(`INSERT INTO onbuy_bulk_import_items (session_id,user_id,row_number,product_name,sku,ean,category,brand,source_price,selling_price,stock,condition,opc,status,error_message) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'error',$14)`,
              [sessionId,userId,m.row._row,m.row.name,m.row.sku,m.row.ean,m.row.category,m.row.brand,m.sourcePrice,m.sellingPrice,parseInt(m.row.stock)||0,cnd,m.opc,msg]).catch(() => {});
          }
        } else {
          results.listing_created++;
          if (m.opc && m.row.sku) db.query(`UPDATE product_mappings SET onbuy_opc=$1 WHERE user_id=$2 AND (onbuy_sku=$3 OR primary_asin=$3)`, [m.opc,userId,m.row.sku]).catch(() => {});
          db.query(`INSERT INTO onbuy_bulk_import_items (session_id,user_id,row_number,product_name,sku,ean,category,brand,source_price,selling_price,stock,condition,opc,status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'listing_created')`,
            [sessionId,userId,m.row._row,m.row.name,m.row.sku,m.row.ean,m.row.category,m.row.brand,m.sourcePrice,m.sellingPrice,parseInt(m.row.stock)||0,cnd,m.opc]).catch(() => {});
        }
      }
      if (updateNeeded.length > 0) {
        const upd     = updateNeeded.map(({ row, sellingPrice }) => ({ sku: row.sku, price: sellingPrice, stock: parseInt(row.stock)||0, ...(row.delivery_weight ? { delivery_weight: parseFloat(row.delivery_weight) } : {}) }));
        let updRes  = await fetch(`https://api.onbuy.com/v2/listings?site_id=${siteId}`, { method: 'PUT', headers: { Authorization: currentToken, 'Content-Type': 'application/json' }, body: JSON.stringify({ site_id: parseInt(siteId)||2000, listings: upd }) });
        if (updRes.status === 401) {
          await refreshToken();
          updRes = await fetch(`https://api.onbuy.com/v2/listings?site_id=${siteId}`, { method: 'PUT', headers: { Authorization: currentToken, 'Content-Type': 'application/json' }, body: JSON.stringify({ site_id: parseInt(siteId)||2000, listings: upd }) });
        }
        const updData = await updRes.json();
        const updResults = updData?.results ?? updData?.payload ?? [];
        for (let j = 0; j < updateNeeded.length; j++) {
          const m   = updateNeeded[j];
          const ur  = Array.isArray(updResults) ? updResults[j] : null;
          const cnd = _bulkNormCond(m.row.condition);
          if (!updRes.ok || ur?.success === false) {
            const msg = ur?.message || updData?.message || updData?.error?.message || 'Listing update rejected';
            results.errors.push({ row: m.row._row, product: m.row.name, error: msg }); results.skipped++;
            db.query(`INSERT INTO onbuy_bulk_import_items (session_id,user_id,row_number,product_name,sku,ean,category,brand,source_price,selling_price,stock,condition,opc,status,error_message) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'error',$14)`,
              [sessionId,userId,m.row._row,m.row.name,m.row.sku,m.row.ean,m.row.category,m.row.brand,m.sourcePrice,m.sellingPrice,parseInt(m.row.stock)||0,cnd,m.opc,msg]).catch(() => {});
          } else {
            results.listing_updated++;
            if (m.opc && m.row.sku) db.query(`UPDATE product_mappings SET onbuy_opc=$1 WHERE user_id=$2 AND (onbuy_sku=$3 OR primary_asin=$3)`, [m.opc,userId,m.row.sku]).catch(() => {});
            db.query(`INSERT INTO onbuy_bulk_import_items (session_id,user_id,row_number,product_name,sku,ean,category,brand,source_price,selling_price,stock,condition,opc,status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'listing_updated')`,
              [sessionId,userId,m.row._row,m.row.name,m.row.sku,m.row.ean,m.row.category,m.row.brand,m.sourcePrice,m.sellingPrice,parseInt(m.row.stock)||0,cnd,m.opc]).catch(() => {});
          }
        }
      }
      // Update counters after each Phase 4 chunk so the UI reflects live progress
      db.query(
        `UPDATE onbuy_bulk_import_sessions SET products_created=$1, listings_created=$2, listings_updated=$3, skipped=$4, errors_count=$5 WHERE id=$6`,
        [results.product_created, results.listing_created, results.listing_updated, results.skipped, results.errors.length, sessionId]
      ).catch(() => {});
    }
  }

  // Finalize session
  await db.query(
    `UPDATE onbuy_bulk_import_sessions SET products_created=$1, listings_created=$2, listings_updated=$3, skipped=$4, errors_count=$5, status='completed', completed_at=NOW() WHERE id=$6`,
    [results.product_created, results.listing_created, results.listing_updated, results.skipped, results.errors.length, sessionId]
  );
  blog(`Import complete — products:${results.product_created} listings:${results.listing_created} skipped:${results.skipped} errors:${results.errors.length}`);
  } catch (err) {
    blog(`Fatal error: ${err.message}`);
    console.error(`[BulkImport][session=${sessionId}] Fatal error:`, err.message);
    try {
      await db.query(
        `UPDATE onbuy_bulk_import_sessions SET status='failed', completed_at=NOW() WHERE id=$1 AND status='processing'`,
        [sessionId]
      );
    } catch {}
    throw err; // re-throw so BullMQ marks the job as failed
  }
}

const bulkImportWorker = new Worker('bulk-import', processBulkImportJob, {
  connection:  redis,
  concurrency: 2,
});
bulkImportWorker.on('failed', (job, err) =>
  console.error(`[BulkImport] ❌ job ${job?.id} failed: ${err.message}`)
);

// ─────────────────────────────────────────────
// START WORKERS
// Workers boot with the process and idle until
// jobs arrive. Concurrency tuned via env vars.
// ─────────────────────────────────────────────

const fastWorker = new Worker('repricer-fast', processFastJob, {
  connection:  redis,
  concurrency: FAST_CONCURRENCY,
});

const slowWorker = new Worker('repricer-slow', processSlowJob, {
  connection:  redis,
  concurrency: SLOW_CONCURRENCY,
});

fastWorker.on('failed', (job, err) =>
  wlog(`[FastWorker] ❌ job ${job?.id} failed: ${err.message}`)
);
slowWorker.on('failed', (job, err) =>
  wlog(`[SlowWorker] ❌ job ${job?.id} failed: ${err.message}`)
);

// ── Flush pending batches immediately when all jobs finish ──
// Uses live queue counts (waiting + delayed + active) rather than the
// `drained` event, because `drained` fires when there are no *waiting*
// jobs but ignores *delayed* ones — escalated Puppeteer jobs land in the
// slow queue with a delay, so the slow queue looks empty too early.
let _fastActive = 0, _slowActive = 0, _keepaActive = 0;
// Tracks which users had jobs in the current run so system-level "all done"
// messages can be written to each of their log files.
// Cleared synchronously when the main-run completion path fires — this acts as the
// guard that prevents double-firing: subsequent _checkAllDone calls see size===0 and
// return immediately. Re-populated when the next run's worker 'active' events fire.
const _runUserIds = new Set();
const _retryPendingFor = new Set(); // userIds with active retry jobs currently in queue
// Initialized to 24 h ago so a restart with an existing queue catches pre-restart failures.
// The cron callback resets this to null before each fresh scheduled run.
let _runStartTime = new Date(Date.now() - 24 * 60 * 60 * 1000);

async function _checkAllDone() {
  // Cheap early-exit: workers are still processing (including keepa browser phase)
  if (_fastActive > 0 || _slowActive > 0 || _keepaActive > 0) return;
  wlog(`[DEBUG _checkAllDone] entering — _runUserIds=${_runUserIds.size} _retryPendingFor=${_retryPendingFor.size} _runStartTime=${_runStartTime}`);

  const [fc, sc] = await Promise.all([
    fastQueue.getJobCounts('waiting', 'delayed', 'active'),
    slowQueue.getJobCounts('waiting', 'delayed', 'active'),
  ]);

  if (fc.waiting + fc.delayed + fc.active === 0 &&
      sc.waiting + sc.delayed + sc.active === 0) {

    if (_retryPendingFor.size > 0) {
      // Retry run just finished — flush its batches and mark the run fully done
      wlog('[Workers] Retry run completed — flushing remaining OnBuy batches');
      for (const uid of _runUserIds) {
        logToUser(uid, '[Workers] Retry run completed');
        // Don't clear the UI counter if a Keepa quota-refill job is still pending
        const hasRefill = await redis.exists(`keepa:refill-pending:${uid}`).catch(() => 0);
        if (!hasRefill) redis.del(`repricer:running:${uid}`).catch(() => {});
      }
      onbuyUpdater.flushAll(_runUserIds);
      _retryPendingFor.clear();
      _runStartTime = null;
      _runUserIds.clear();
      fastQueue.clean(0, 1000, 'failed').catch(() => {});
      slowQueue.clean(0, 1000, 'failed').catch(() => {});
      return;
    }

    // Guard: _runUserIds is cleared synchronously at the bottom of this path,
    // so any subsequent spurious call returns here until the next run starts.
    wlog(`[DEBUG _checkAllDone] queues empty — _retryPendingFor=${_retryPendingFor.size} _runUserIds=${_runUserIds.size}`);
    if (!_runUserIds.size) { wlog('[DEBUG _checkAllDone] _runUserIds empty — returning (no active run)'); return; }

    // Main run finished — flush batches, then schedule one automatic retry pass
    wlog('[Workers] All jobs done — flushing pending OnBuy batches immediately');
    for (const uid of _runUserIds) logToUser(uid, '[Workers] All jobs done — flushing pending OnBuy batches immediately');
    onbuyUpdater.flushAll(_runUserIds);

    const runUserIds = [..._runUserIds];
    const runStart   = _runStartTime;
    _runUserIds.clear(); // ← synchronous — guards against re-entry before async work below
    // Wait for all OnBuy batches to send + a brief window for sync_logs DB writes to land
    onbuyUpdater._mutex
      .then(() => new Promise(r => setTimeout(r, 5000)))
      .then(() => _scheduleRetry(runUserIds, runStart))
      .catch(err => wlog('[Retry] Scheduling error:', err.message));
  }
}

// Query sync_logs for failures since runStart and re-enqueue those mappings once.
// Covers both OnBuy 401 errors and Amazon scrape failures (all_methods_failed, etc.).
async function _scheduleRetry(userIds, runStart) {
  if (!runStart || !userIds.length) return;
  const retries = [];
  for (const userId of userIds) {
    try {
      const { rows } = await db.query(`
        SELECT DISTINCT sl.product_mapping_id
        FROM sync_logs sl
        JOIN product_mappings pm ON pm.id = sl.product_mapping_id
        WHERE sl.status = 'failed'
          AND sl.created_at >= $2
          AND pm.user_id = $1
          AND pm.is_active = true
          AND NOT EXISTS (
            SELECT 1 FROM sync_logs s2
            WHERE s2.product_mapping_id = sl.product_mapping_id
              AND s2.status = 'success'
              AND s2.created_at >= $2
          )
      `, [userId, runStart]);
      if (rows.length > 0) {
        retries.push({ userId, ids: rows.map(r => r.product_mapping_id) });
      } else {
        ulog(userId, '[Retry] No failed listings to retry');
      }
    } catch (err) {
      ulog(userId, '[Retry] Error querying failures:', err.message);
    }
  }

  if (retries.length === 0) {
    // Nothing to retry — clear counter unless a Keepa quota-refill job is still pending
    for (const uid of userIds) {
      const hasRefill = await redis.exists(`keepa:refill-pending:${uid}`).catch(() => 0);
      if (!hasRefill) redis.del(`repricer:running:${uid}`).catch(() => {});
    }
    _runStartTime = null;
    fastQueue.clean(0, 1000, 'failed').catch(() => {});
    slowQueue.clean(0, 1000, 'failed').catch(() => {});
    return;
  }

  // Populate _retryPendingFor BEFORE enqueuing so the _checkAllDone guard holds
  // even if workers pick up the first retry job before all runRepricerJob calls complete.
  for (const { userId } of retries) _retryPendingFor.add(userId);

  await Promise.all(retries.map(async ({ userId, ids }) => {
    ulog(userId, `[Retry] ${ids.length} failed listing(s) — retrying once`);
    try {
      await runRepricerJob({ userId, mappingIds: ids, log: (...args) => ulog(userId, ...args) });
    } catch (err) {
      ulog(userId, '[Retry] runRepricerJob error:', err.message);
      _retryPendingFor.delete(userId);
    }
  }));

  // If all enqueues failed or produced no jobs, trigger a completion check so
  // _retryPendingFor doesn't stay non-empty indefinitely.
  if (_retryPendingFor.size > 0) setTimeout(_checkAllDone, 2000);
}

// Decrement the per-user running counter by 1 as each ASIN is processed.
// Uses KEEPTTL so the decrement doesn't reset the expiry set at job start.
// Floors at 0 to prevent the key going negative after a counter reset.
// Skips jobs that originated from a Keepa flush — the Keepa worker already
// decremented by the full sub-batch size (DECRBY 1000), so individual job
// decrements would undercount and push the key negative.
async function _decrementCounter(job) {
  if (job?.data?.fromKeepaFlush) return;
  const uid = job?.data?.mapping?.user_id;
  if (!uid) return;
  const remaining = await redis.decr(`repricer:running:${uid}`).catch(() => null);
  if (remaining !== null && remaining < 0)
    redis.set(`repricer:running:${uid}`, 0, 'KEEPTTL').catch(() => {});
}

fastWorker.on('active',    (job) => {
  _fastActive++; if (!_runStartTime) _runStartTime = new Date(); if (job?.data?.mapping?.user_id) _runUserIds.add(job.data.mapping.user_id);
});
fastWorker.on('drained',   ()    => { _checkAllDone(); });
fastWorker.on('completed', (job, result) => {
  _fastActive = Math.max(0, _fastActive - 1);
  // Escalated jobs are re-queued on the slow queue — don't count them as done yet;
  // the slow worker's completed/failed event will decrement instead.
  if (result?.escalated !== true) _decrementCounter(job);
  _checkAllDone();
});
fastWorker.on('failed',    (job) => {
  _fastActive = Math.max(0, _fastActive - 1);
  _decrementCounter(job);
  _checkAllDone();
});

slowWorker.on('active',    (job) => {
  _slowActive++; if (!_runStartTime) _runStartTime = new Date(); if (job?.data?.mapping?.user_id) _runUserIds.add(job.data.mapping.user_id);
});
slowWorker.on('drained',   ()    => { _checkAllDone(); });
slowWorker.on('completed', (job) => {
  _slowActive = Math.max(0, _slowActive - 1);
  _decrementCounter(job);
  _checkAllDone();
});
slowWorker.on('failed',    (job) => {
  _slowActive = Math.max(0, _slowActive - 1);
  _decrementCounter(job);
  _checkAllDone();
});

wlog(`[Workers] ✅ Fast workers: ${FAST_CONCURRENCY}  |  Slow workers: ${SLOW_CONCURRENCY}`);

// ─────────────────────────────────────────────
// PER-USER SCHEDULER
// Each active user gets their own cron derived
// from their job_interval_minutes / job_start_time
// settings.  refreshSchedules() is called on
// startup and whenever settings change.
// ─────────────────────────────────────────────

const _userCrons = new Map(); // userId → { task, intervalMinutes, startTime }

function _cronPattern(minutes) {
  if (minutes < 60) return `*/${minutes} * * * *`;
  return `0 */${Math.round(minutes / 60)} * * *`;
}

async function refreshSchedules() {
  try {
    const { rows } = await db.query(`
      SELECT u.id,
             MAX(CASE WHEN s.key = 'job_interval_minutes' THEN s.value END) AS interval_minutes,
             MAX(CASE WHEN s.key = 'job_start_time'       THEN s.value END) AS start_time,
             MAX(CASE WHEN s.key = 'webshare_proxy_api'   THEN s.value END) AS proxy_url
      FROM users u
      LEFT JOIN settings s ON s.user_id = u.id
        AND s.key IN ('job_interval_minutes', 'job_start_time', 'webshare_proxy_api')
      WHERE u.is_active = true
      GROUP BY u.id
    `);

    const seen = new Set();
    for (const user of rows) {
      const intervalMinutes = Math.max(0, parseInt(user.interval_minutes || '30'));
      const startTime       = user.start_time || '00:00';
      seen.add(user.id);

      const existing = _userCrons.get(user.id);
      if (existing?.intervalMinutes === intervalMinutes && existing?.startTime === startTime) continue;
      if (existing) existing.task.stop();

      const [h, m] = startTime.split(':').map(Number);
      const pattern = intervalMinutes === 0
        ? `${m} ${h} * * *`
        : _cronPattern(intervalMinutes);

      const uid = user.id;
      const task = cron.schedule(pattern, () => {
        if (intervalMinutes > 0) {
          const now = new Date();
          if (now.getHours() * 60 + now.getMinutes() < h * 60 + m) {
            ulog(uid, `[Scheduler] User #${uid}: before start time ${startTime} — skipping`);
            return;
          }
        }
        _retryPendingFor.clear();
        _runStartTime = null;
        runRepricerJob({ userId: uid, log: (...args) => ulog(uid, ...args) });
      });

      _userCrons.set(uid, { task, intervalMinutes, startTime });
      const desc = intervalMinutes === 0
        ? `once daily at ${startTime}`
        : `every ${intervalMinutes}min from ${startTime}`;
      ulog(uid, `[Scheduler] User #${uid}: "${pattern}" — ${desc}`);
    }

    // Stop crons for users that have been deactivated or deleted
    for (const [uid, entry] of _userCrons) {
      if (!seen.has(uid)) { entry.task.stop(); _userCrons.delete(uid); }
    }
  } catch (e) {
    wlog('[Scheduler] Error refreshing schedules:', e.message);
  }
}

export async function startScheduler() {
  await refreshSchedules();
  // Immediately run any user whose start time has already passed today
  for (const [uid, { intervalMinutes, startTime }] of _userCrons) {
    if (intervalMinutes > 0) {
      const [h, m] = startTime.split(':').map(Number);
      const now = new Date();
      if (now.getHours() * 60 + now.getMinutes() >= h * 60 + m) {
        runRepricerJob({ userId: uid, log: (...args) => ulog(uid, ...args) });
      }
    }
  }
}

export { fastWorker, slowWorker };

// Daily cleanup at 03:00 — remove sync_logs older than 3 days and daily_sync_stats older than 90 days.
cron.schedule('0 3 * * *', () => {
  db.query(`DELETE FROM sync_logs WHERE created_at < NOW() - INTERVAL '3 days'`)
    .then(r => wlog(`[Cleanup] Removed ${r.rowCount} sync_logs older than 3 days`))
    .catch(err => wlog('[Cleanup] sync_logs cleanup error:', err.message));
  db.query(`DELETE FROM daily_sync_stats WHERE date < CURRENT_DATE - 90`)
    .then(r => wlog(`[Cleanup] Removed ${r.rowCount} daily_sync_stats rows older than 90 days`))
    .catch(err => wlog('[Cleanup] daily_sync_stats cleanup error:', err.message));
});

// Start the per-user scheduler.
startScheduler();

// Subscribe to settings-change events published by the API server.
// Refreshes per-user crons immediately when any user saves settings.
redisSub.subscribe('repricer:settings-updated', 'repricer:manual-sync', (err) => {
  if (err) wlog('[RepricerJob] Could not subscribe to channels:', err.message);
  else     wlog('[RepricerJob] Subscribed to repricer:settings-updated + repricer:manual-sync');
});
redisSub.on('message', (channel, message) => {
  if (channel === 'repricer:settings-updated') {
    wlog('[RepricerJob] Settings change detected — refreshing schedules');
    refreshSchedules();
  }
  if (channel === 'repricer:manual-sync') {
    wlog(`[DEBUG manual-sync] received — _runUserIds=${_runUserIds.size} _retryPendingFor=${_retryPendingFor.size} _fastActive=${_fastActive} _slowActive=${_slowActive} _keepaActive=${_keepaActive} _runStartTime=${_runStartTime}`);
    _retryPendingFor.clear();
    _runStartTime = null;
    // Parse message — new format is JSON {userId, onlyUnsynced}; old format was plain userId string
    let syncUserId = null, onlyUnsynced = false;
    try {
      const parsed = JSON.parse(message);
      syncUserId   = parsed.userId      ?? null;
      onlyUnsynced = parsed.onlyUnsynced ?? false;
    } catch {
      syncUserId = message === 'all' ? null : (parseInt(message) || null);
    }
    runRepricerJob({ userId: syncUserId, onlyUnsynced, log: (...args) => ulog(syncUserId, ...args) })
      .catch(err => wlog('[ManualSync] runRepricerJob error:', err.message));
  }
});

// 5-minute fallback poll in case a pub/sub message is missed.
setInterval(refreshSchedules, 5 * 60_000);
