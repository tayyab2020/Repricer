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
import { appendFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { scrapeProductFast, scrapeProductSlow, setProxyApiUrl, jobContext } from './amazonScraper.js';
import { runRepricerJob, fastQueue, slowQueue, getTokenForAccount } from './jobProducer.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);
export const LOGS_DIR = join(__dirname, 'logs');
try { mkdirSync(LOGS_DIR, { recursive: true }); } catch {}

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

// Timestamped console.log — keeps live-logs timestamps accurate for lines
// that don't come from amazonScraper.js (which adds its own timestamps).
const wlog = (...args) => console.log(`[${new Date().toISOString()}]`, ...args);

// Write a timestamped line to the per-user log file so each user's Live Logs
// page only shows their own jobs.  Silently swallowed on I/O error.
function logToUser(userId, ...args) {
  if (!userId) return;
  const msg  = args.map(a => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ');
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  try { appendFileSync(join(LOGS_DIR, `user-${userId}.log`), line, 'utf8'); } catch {}
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
    this._maxBatch   = maxBatch;
    this._maxPerHour = maxPerHour;
    this._batches    = new Map(); // key → [{ token, siteId, identifier, isSku, price, resolve, reject }]
    this._timers     = new Map(); // key → timer id
    this._rrTs       = [];        // timestamps of sent requests (sliding 1-hour window)
    this._mutex      = Promise.resolve(); // serialises all batch flushes
    this._creds      = new Map(); // token → { consumerKey, secretKey } for refresh on 401
    this._tokenMap   = new Map(); // oldToken → newToken (redirect after 401 refresh)
  }

  // Follow the redirect chain so stale tokens from job.data are silently
  // upgraded to the current token without hitting a 401 on every batch.
  _resolveToken(token) {
    let t = token;
    const seen = new Set();
    while (this._tokenMap.has(t) && !seen.has(t)) { seen.add(t); t = this._tokenMap.get(t); }
    return t;
  }

  enqueue(rawToken, siteId, identifier, isSku, price, { consumerKey, secretKey, amazonPrice = null, mappingId = null, minPrice = null, feeRate = null, minRoiPercent = null, userId = null } = {}) {
    return new Promise((resolve, reject) => {
      const token = this._resolveToken(rawToken);
      const key   = `${token}||${siteId}||${isSku ? '1' : '0'}`;
      if (!this._batches.has(key)) this._batches.set(key, []);
      const batch = this._batches.get(key);
      batch.push({ token, siteId, identifier, isSku, price, amazonPrice, mappingId, minPrice, feeRate, minRoiPercent, userId, resolve, reject });
      // Store credentials under the resolved token (and under rawToken as fallback)
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

          // Undercut lead price when not winning and our price is above the lead
          if (winning === false && item.price > leadPrice) {
            newPrice = parseFloat((leadPrice - 0.50).toFixed(2));
          }

          // Always enforce the min-ROI floor — even when winning or when our
          // price is already at/below the lead.  A stored price can be below the
          // floor if markup_value was overwritten by a previous run or the user
          // raised the min-ROI setting after the last sync.
          if (item.amazonPrice && effMinRoi > 0) {
            const roiAtPrice  = (newPrice / (item.amazonPrice * (1 + effFeeRate)) - 1) * 100;
            if (roiAtPrice < effMinRoi) {
              const minRoiPrice = parseFloat((item.amazonPrice * (1 + effMinRoi / 100) * (1 + effFeeRate)).toFixed(2));
              ulog(item.userId, `[CheckWinning] ${item.identifier}: ROI at £${newPrice} = ${roiAtPrice.toFixed(1)}% < min ${effMinRoi}% → floor £${minRoiPrice}`);
              newPrice = minRoiPrice;
            }
          }

          // Per-listing min_price floor
          if (item.minPrice && newPrice < item.minPrice) newPrice = item.minPrice;

          // Skip if nothing changed
          if (newPrice === item.price) continue;

          ulog(item.userId, `[CheckWinning] ${item.identifier}: £${item.price} → £${newPrice} (lead: £${leadPrice}, winning: ${winning})`);
          item.price = newPrice;
          adjusted++;

          // Recalculate ROI% and onbuy_fee in DB based on the adjusted price
          if (item.amazonPrice && item.mappingId) {
            const newRoi = (newPrice / (item.amazonPrice * (1 + effFeeRate)) - 1) * 100;
            const newFee = newPrice * effFeeRate / (1 + effFeeRate);
            db.query(
              `UPDATE product_mappings SET markup_value = $1, onbuy_fee = $2 WHERE id = $3`,
              [parseFloat(newRoi.toFixed(4)), parseFloat(newFee.toFixed(2)), item.mappingId]
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
    const listings   = items.map(it => ({ [listingKey]: it.identifier, price: it.price.toFixed(2) }));

    const doRequest = (authToken) => fetch(endpoint, {
      method: 'PUT',
      headers: { Authorization: authToken, 'Content-Type': 'application/json' },
      body: JSON.stringify({ listings }),
    });

    ulog(batchUserId, `[OnBuyUpdater] Batch ${listingKey.toUpperCase()} ×${items.length} payload:`, JSON.stringify({ listings }));

    try {
      let res = await doRequest(token);
      let raw = await res.text();
      ulog(batchUserId, `[OnBuyUpdater] Batch ${listingKey.toUpperCase()} ×${items.length} → HTTP ${res.status} response:`, raw.slice(0, 2000));

      // Token expired mid-run — refresh once and retry the batch
      if (res.status === 401) {
        const creds = this._creds.get(token) || this._creds.get(items[0].token);
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
        }
      }

      if (!res.ok) {
        const err = new Error(`OnBuy ${res.status}: ${raw.slice(0, 200)}`);
        items.forEach(it => it.reject(err));
        return;
      }

      const data    = JSON.parse(raw);
      const results = Array.isArray(data?.results) ? data.results
                    : Array.isArray(data?.payload)  ? data.payload
                    : [];
      items.forEach((it, i) => {
        const r = results[i];
        if (r?.success === false) it.reject(new Error(r.message || 'OnBuy rejected update'));
        else it.resolve({ ...data, _finalPrice: it.price }); // pass adjusted price back to caller
      });
    } catch (err) {
      items.forEach(it => it.reject(err));
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
    // P = amazon × (1 + roi/100) × (1 + fee%)
    // e.g. amazon=70, roi=20%, fee=15%: 70 × 1.20 × 1.15 = 96.60
    price = amazonPrice * (1 + markupValue / 100) * (1 + feeRate);
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
    user_id: userId,
  } = mapping;

  const effFeeRate  = userSettings.feeRate      ?? _onbuyFeeRate;
  const effMinRoi   = userSettings.minRoiPercent ?? _minRoiPercent;
  const markup_value = parseFloat(mapping.markup_value) || (userSettings.defaultRoi ?? _defaultRoi);

  const label = `${product_name || primary_asin} (#${id})`;

  // ── OOS: set OnBuy stock=0 ──
  if (scraped.inStock === false) {
    const wasAlreadyOos = amazon_in_stock === false;
    const identifier    = onbuy_sku || mapping.onbuy_listing_id || rawListingId;
    if (!wasAlreadyOos) {
      ulog(userId, `[Worker] ⚠️  ${label} — OOS, setting stock=0`);
      await setOnBuyStock(identifier, 0, token, siteId, !!onbuy_sku);
    } else {
      ulog(userId, `[Worker] ⏭  ${label} — still OOS, no change`);
    }
    await db.query(
      `UPDATE product_mappings SET amazon_in_stock = false, last_checked_at = NOW() WHERE id = $1`, [id]
    );
    await db.query(
      `INSERT INTO sync_logs (product_mapping_id, status, message, created_at)
       VALUES ($1, 'skipped', 'Amazon OOS — OnBuy stock set to 0', NOW())`, [id]
    );
    return { success: true, skipped: true, outOfStock: true };
  }

  // ── Back in stock: restore stock=2 — only when we have a confirmed price ──
  // A missing price with no explicit inStock=false means the scrape failed (blocked/timeout),
  // not that the item is back in stock. Never restore from a failed scrape.
  if (amazon_in_stock === false && scraped.price) {
    const identifier = onbuy_sku || mapping.onbuy_listing_id || rawListingId;
    ulog(userId, `[Worker] ✅ ${label} — back in stock, restoring stock=2`);
    await setOnBuyStock(identifier, 2, token, siteId, !!onbuy_sku);
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
    ? parseFloat((amazonPrice * (1 + effMinRoi / 100) * (1 + effFeeRate)).toFixed(2))
    : null;
  const storedBelowFloor = minRoiFloor != null && last_onbuy_price
    ? parseFloat(last_onbuy_price) < minRoiFloor
    : false;
  const alreadyCorrect = !storedBelowFloor && last_onbuy_price && parseFloat(last_onbuy_price) === newOnBuyPrice;
  if (!hasPriceChangedSignificantly(last_amazon_price, amazonPrice) && alreadyCorrect) {
    ulog(userId, `[Worker] ⏭  ${label} — price unchanged (Amazon £${amazonPrice}, OnBuy £${newOnBuyPrice}), skipping`);
    await db.query(`UPDATE product_mappings SET last_checked_at = NOW() WHERE id = $1`, [id]);
    return { success: true, skipped: true };
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

  const identifier = onbuy_sku || mapping.onbuy_listing_id || rawListingId;
  onbuyUpdater.enqueue(token, siteId, identifier, !!onbuy_sku, newOnBuyPrice, {
    consumerKey, secretKey,
    amazonPrice,
    mappingId:    id,
    minPrice:     min_price ? parseFloat(min_price) : null,
    feeRate:      effFeeRate !== _onbuyFeeRate  ? effFeeRate  : null,
    minRoiPercent: effMinRoi !== _minRoiPercent ? effMinRoi   : null,
    userId,
  })
    .then(async (result) => {
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

  // Resolve listing UID from OPC if we only have a raw URL/OPC
  if (!mapping.onbuy_sku && !isValidListingUid(mapping.onbuy_listing_id)) {
    const opc = mapping.onbuy_opc || extractOpcFromValue(mapping.onbuy_listing_id);
    if (!opc) {
      const msg = 'No SKU or valid UID — re-import with Seller SKU filled in';
      ulog(userId, `[FastWorker] mapping #${mapping.id}: ${msg}`);
      await db.query(
        `INSERT INTO sync_logs (product_mapping_id, status, message, created_at)
         VALUES ($1, 'failed', $2, NOW())`, [mapping.id, msg]
      );
      return { success: false, error: 'no_identifier' };
    }
    const uid = await resolveUidFromOpc(opc, token, siteId);
    if (!uid) {
      const msg = `Could not resolve UID from OPC ${opc}`;
      await db.query(
        `INSERT INTO sync_logs (product_mapping_id, status, message, created_at)
         VALUES ($1, 'failed', $2, NOW())`, [mapping.id, msg]
      );
      return { success: false, error: 'opc_resolve_failed' };
    }
    await db.query(
      `UPDATE product_mappings SET onbuy_listing_id = $1, onbuy_opc = $2 WHERE id = $3`,
      [uid, opc, mapping.id]
    );
    mapping = { ...mapping, onbuy_listing_id: uid, onbuy_opc: opc };
  }

  const scraped = await scrapeProductFast(mapping.primary_asin);

  // Escalate to slow queue if Twister + Cheerio both failed.
  // Delay is computed so all remaining fast-queue (Twister/Cheerio) jobs finish
  // before any Puppeteer session starts — prevents mixing the two phases.
  if (scraped.needsBrowser) {
    const fastCounts = await fastQueue.getJobCounts('waiting', 'active');
    const queuedFast = fastCounts.waiting;
    const batches    = Math.ceil(queuedFast / FAST_CONCURRENCY);
    // 12 s per batch (conservative avg fast-job time) + 10 s buffer
    const drainMs    = batches * 12000 + 10000;
    const delay      = Math.max(5000, Math.min(drainMs, 300000)); // 5 s – 5 min cap

    ulog(userId, `[FastWorker] ${mapping.primary_asin} → escalating to slow queue (delay: ${Math.round(delay / 1000)}s, fast remaining: ${queuedFast})`);
    await slowQueue.add('scrape', { mapping, token, siteId, userSettings }, {
      jobId:             `slow-${mapping.id}`,
      delay,
      removeOnComplete:  true,
      removeOnFail:      { count: 100 },
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
    const scraped = await scrapeProductSlow(mapping.primary_asin);
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
let _fastActive = 0, _slowActive = 0;
// Tracks which users had jobs in the current run so system-level "all done"
// messages can be written to each of their log files.
const _runUserIds = new Set();

async function _checkAllDone() {
  // Cheap early-exit: workers are still processing
  if (_fastActive > 0 || _slowActive > 0) return;

  const [fc, sc] = await Promise.all([
    fastQueue.getJobCounts('waiting', 'delayed', 'active'),
    slowQueue.getJobCounts('waiting', 'delayed', 'active'),
  ]);

  if (fc.waiting + fc.delayed + fc.active === 0 &&
      sc.waiting + sc.delayed + sc.active === 0) {
    wlog('[Workers] All jobs done — flushing pending OnBuy batches immediately');
    for (const uid of _runUserIds) logToUser(uid, '[Workers] All jobs done — flushing pending OnBuy batches immediately');
    onbuyUpdater.flushAll(_runUserIds);
    _runUserIds.clear();
  }
}

fastWorker.on('active',    (job) => { _fastActive++; if (job?.data?.mapping?.user_id) _runUserIds.add(job.data.mapping.user_id); });
fastWorker.on('drained',   ()    => { _checkAllDone(); });
fastWorker.on('completed', ()    => { _fastActive = Math.max(0, _fastActive - 1); _checkAllDone(); });
fastWorker.on('failed',    ()    => { _fastActive = Math.max(0, _fastActive - 1); _checkAllDone(); });

slowWorker.on('active',    (job) => { _slowActive++; if (job?.data?.mapping?.user_id) _runUserIds.add(job.data.mapping.user_id); });
slowWorker.on('drained',   ()    => { _checkAllDone(); });
slowWorker.on('completed', ()    => { _slowActive = Math.max(0, _slowActive - 1); _checkAllDone(); });
slowWorker.on('failed',    ()    => { _slowActive = Math.max(0, _slowActive - 1); _checkAllDone(); });

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

// Start the per-user scheduler.
startScheduler();

// Subscribe to settings-change events published by the API server.
// Refreshes per-user crons immediately when any user saves settings.
redisSub.subscribe('repricer:settings-updated', (err) => {
  if (err) wlog('[RepricerJob] Could not subscribe to settings channel:', err.message);
  else     wlog('[RepricerJob] Subscribed to repricer:settings-updated');
});
redisSub.on('message', (channel) => {
  if (channel === 'repricer:settings-updated') {
    wlog('[RepricerJob] Settings change detected — refreshing schedules');
    refreshSchedules();
  }
});

// 5-minute fallback poll in case a pub/sub message is missed.
setInterval(refreshSchedules, 5 * 60_000);
