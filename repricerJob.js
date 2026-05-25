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
import { scrapeProductFast, scrapeProductSlow, setProxyApiUrl } from './amazonScraper.js';
import { runRepricerJob, fastQueue, slowQueue } from './jobProducer.js';

dotenv.config();

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
    this._timers     = new Map(); // key → timer id (200 ms batching window)
    this._rrTs       = [];        // timestamps of sent requests (sliding 1-hour window)
    this._mutex      = Promise.resolve(); // serialises all batch flushes
  }

  enqueue(token, siteId, identifier, isSku, price) {
    return new Promise((resolve, reject) => {
      const key = `${token}||${siteId}||${isSku ? '1' : '0'}`;
      if (!this._batches.has(key)) this._batches.set(key, []);
      const batch = this._batches.get(key);
      batch.push({ token, siteId, identifier, isSku, price, resolve, reject });

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

    // ── Batch PUT ──
    const { token, siteId, isSku } = items[0];
    const endpoint   = isSku
      ? `https://api.onbuy.com/v2/listings/by-sku?site_id=${siteId}`
      : `https://api.onbuy.com/v2/listings?site_id=${siteId}`;
    const listingKey = isSku ? 'sku' : 'uid';
    const listings   = items.map(it => ({ [listingKey]: it.identifier, price: it.price.toFixed(2) }));

    try {
      const res = await fetch(endpoint, {
        method: 'PUT',
        headers: { Authorization: token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ listings }),
      });
      const raw = await res.text();
      wlog(`[OnBuyUpdater] Batch ${listingKey.toUpperCase()} ×${items.length} → HTTP ${res.status}`);

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
        else it.resolve(data);
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
    console.warn(`[Resolve] OPC ${opc} failed:`, err.message);
    return null;
  }
}

// ─────────────────────────────────────────────
// PRICE CALCULATION
// ─────────────────────────────────────────────

let _onbuyFeeRate = 0.15;
let _defaultRoi   = 20;

export function setRepricerDefaults({ feeRate, defaultRoi } = {}) {
  if (feeRate   != null) _onbuyFeeRate = Math.min(Math.max(parseFloat(feeRate)   / 100, 0), 0.99);
  if (defaultRoi != null) _defaultRoi  = parseFloat(defaultRoi);
}

function computeOnBuyPrice(amazonPrice, markupType, markupValue, minPrice = null) {
  let price;
  if (markupType === 'roi') {
    // OnBuy fee is % of the final price (circular dependency solved algebraically):
    // P = amazon × (1 + roi/100) + fee% × P  →  P = amazon × (1 + roi/100) / (1 - fee%)
    price = (amazonPrice * (1 + markupValue / 100)) / (1 - _onbuyFeeRate);
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

async function applyResult(scraped, mapping, token, siteId) {
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
    target_price,
  } = mapping;

  // Calibrate ROI% from target_price on first run (markup_value stored as 0 when no ROI in sheet)
  let markup_value = parseFloat(mapping.markup_value);
  if (markup_type === 'roi' && markup_value === 0 && target_price && scraped.price) {
    markup_value = ((parseFloat(target_price) * (1 - _onbuyFeeRate) / scraped.price) - 1) * 100;
    markup_value = parseFloat(markup_value.toFixed(4));
    await db.query(
      `UPDATE product_mappings SET markup_value = $1 WHERE id = $2`,
      [markup_value, id]
    );
    wlog(`[Worker] Calibrated ROI for #${id}: ${markup_value.toFixed(2)}% (target £${target_price})`);
  }

  const label = `${product_name || primary_asin} (#${id})`;

  // ── OOS: set OnBuy stock=0 ──
  if (scraped.inStock === false) {
    const wasAlreadyOos = amazon_in_stock === false;
    const identifier    = onbuy_sku || mapping.onbuy_listing_id || rawListingId;
    if (!wasAlreadyOos) {
      wlog(`[Worker] ⚠️  ${label} — OOS, setting stock=0`);
      await setOnBuyStock(identifier, 0, token, siteId, !!onbuy_sku);
    } else {
      wlog(`[Worker] ⏭  ${label} — still OOS, no change`);
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
    wlog(`[Worker] ✅ ${label} — back in stock, restoring stock=2`);
    await setOnBuyStock(identifier, 2, token, siteId, !!onbuy_sku);
    await db.query(`UPDATE product_mappings SET amazon_in_stock = true WHERE id = $1`, [id]);
  }

  // ── No price ──
  if (!scraped.price) {
    console.warn(`[Worker] ⚠️  ${label} — no price (${scraped.error || 'unknown'})`);
    await db.query(
      `INSERT INTO sync_logs (product_mapping_id, status, message, created_at)
       VALUES ($1, 'failed', $2, NOW())`,
      [id, `Scrape failed: ${scraped.error || 'no price returned'}`]
    );
    return { success: false, error: scraped.error };
  }

  const amazonPrice   = scraped.price;
  const newOnBuyPrice = computeOnBuyPrice(amazonPrice, markup_type, markup_value, min_price);
  wlog(`[Worker] ${label} — Amazon £${amazonPrice} → OnBuy £${newOnBuyPrice} (${scraped.method})`);

  // ── Skip if unchanged ──
  const alreadyCorrect = last_onbuy_price && parseFloat(last_onbuy_price) === newOnBuyPrice;
  if (!hasPriceChangedSignificantly(last_amazon_price, amazonPrice) && alreadyCorrect) {
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
  onbuyUpdater.enqueue(token, siteId, identifier, !!onbuy_sku, newOnBuyPrice)
    .then(async () => {
      try {
        await db.query(
          `UPDATE product_mappings SET last_onbuy_price = $1, last_synced_at = NOW() WHERE id = $2`,
          [newOnBuyPrice, id]
        );
        await Promise.all([
          db.query(
            `INSERT INTO price_history (product_mapping_id, amazon_price, onbuy_price, recorded_at)
             VALUES ($1, $2, $3, NOW())`,
            [id, amazonPrice, newOnBuyPrice]
          ),
          db.query(
            `INSERT INTO sync_logs (product_mapping_id, status, message, amazon_price, onbuy_price, created_at)
             VALUES ($1, 'success', 'Price synced', $2, $3, NOW())`,
            [id, amazonPrice, newOnBuyPrice]
          ),
        ]);
      } catch (dbErr) {
        console.error(`[Worker] DB post-sync update failed for #${id}:`, dbErr.message);
      }
    })
    .catch(err => {
      console.error(`[Worker] ❌ ${label} — OnBuy update failed:`, err.message);
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
  let { mapping, token, siteId } = job.data;

  // Resolve listing UID from OPC if we only have a raw URL/OPC
  if (!mapping.onbuy_sku && !isValidListingUid(mapping.onbuy_listing_id)) {
    const opc = mapping.onbuy_opc || extractOpcFromValue(mapping.onbuy_listing_id);
    if (!opc) {
      const msg = 'No SKU or valid UID — re-import with Seller SKU filled in';
      console.warn(`[FastWorker] mapping #${mapping.id}: ${msg}`);
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

    wlog(`[FastWorker] ${mapping.primary_asin} → escalating to slow queue (delay: ${Math.round(delay / 1000)}s, fast remaining: ${queuedFast})`);
    await slowQueue.add('scrape', { mapping, token, siteId }, {
      jobId:             `slow-${mapping.id}`,
      delay,
      removeOnComplete:  true,
      removeOnFail:      { count: 100 },
      attempts:          2,
      backoff:           { type: 'fixed', delay: 15000 },
    });
    return { escalated: true };
  }

  return applyResult(scraped, mapping, token, siteId);
}

// ─────────────────────────────────────────────
// SLOW WORKER PROCESSOR
// Puppeteer (proxy → direct). Receives escalated
// jobs from the fast worker.
// ─────────────────────────────────────────────

async function processSlowJob(job) {
  const { mapping, token, siteId } = job.data;
  const scraped = await scrapeProductSlow(mapping.primary_asin);
  return applyResult(scraped, mapping, token, siteId);
}

// ─────────────────────────────────────────────
// SCHEDULER STATE  (declared before bootstrap so setSchedule() can be called
// inside the top-level await block without a TDZ error)
// ─────────────────────────────────────────────

let _intervalMinutes = 30;
let _startTime       = '00:00';
let _activeCron      = null;

// ─────────────────────────────────────────────
// BOOTSTRAP SETTINGS  (top-level await — runs before workers are created)
// Loads proxy URL, fee rate, and schedule from DB so that any BullMQ jobs
// already sitting in Redis are processed with the correct configuration.
// ─────────────────────────────────────────────

try {
  const { rows } = await db.query('SELECT key, value FROM settings');
  const s = Object.fromEntries(rows.map(r => [r.key, r.value]));
  if (s.webshare_proxy_api)    setProxyApiUrl(s.webshare_proxy_api);
  if (s.onbuy_fee_percent)     setRepricerDefaults({ feeRate:    parseFloat(s.onbuy_fee_percent) });
  if (s.default_roi_percent)   setRepricerDefaults({ defaultRoi: parseFloat(s.default_roi_percent) });
  if (s.job_interval_minutes || s.job_start_time) {
    setSchedule({
      intervalMinutes: s.job_interval_minutes ? parseInt(s.job_interval_minutes) : undefined,
      startTime:       s.job_start_time       || undefined,
    });
  }
  wlog(`[RepricerJob] Settings pre-loaded — proxy: ${s.webshare_proxy_api ? 'set' : 'not set'}  fee: ${s.onbuy_fee_percent || 15}%  interval: ${s.job_interval_minutes || 30}min  start: ${s.job_start_time || '00:00'}`);
} catch (e) {
  console.warn('[RepricerJob] Could not pre-load settings from DB:', e.message);
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
  console.error(`[FastWorker] ❌ job ${job?.id} failed: ${err.message}`)
);
slowWorker.on('failed', (job, err) =>
  console.error(`[SlowWorker] ❌ job ${job?.id} failed: ${err.message}`)
);

wlog(`[Workers] ✅ Fast workers: ${FAST_CONCURRENCY}  |  Slow workers: ${SLOW_CONCURRENCY}`);

// ─────────────────────────────────────────────
// SCHEDULER
// Dynamic interval + start-time gate
// ─────────────────────────────────────────────

export function setSchedule({ intervalMinutes, startTime } = {}) {
  if (intervalMinutes != null) _intervalMinutes = Math.max(1, parseInt(intervalMinutes) || 30);
  if (startTime       != null && /^\d{1,2}:\d{2}$/.test(startTime)) _startTime = startTime;
  _applySchedule();
}

function _isAfterStartTime() {
  const [h, m] = _startTime.split(':').map(Number);
  const now = new Date();
  return now.getHours() * 60 + now.getMinutes() >= h * 60 + m;
}

function _cronPattern(minutes) {
  if (minutes < 60) return `*/${minutes} * * * *`;          // e.g. 30 → */30 * * * *
  return `0 */${Math.round(minutes / 60)} * * *`;            // e.g. 120 → 0 */2 * * *
}

// Re-read all settings from DB and apply them in this worker process.
// Called before every run so changes made via the Settings UI take effect
// without requiring a worker restart.
async function reloadSettings({ log = false } = {}) {
  try {
    const { rows } = await db.query('SELECT key, value FROM settings');
    const s = Object.fromEntries(rows.map(r => [r.key, r.value]));
    setProxyApiUrl(s.webshare_proxy_api || null);
    if (s.onbuy_fee_percent)   setRepricerDefaults({ feeRate:    parseFloat(s.onbuy_fee_percent) });
    if (s.default_roi_percent) setRepricerDefaults({ defaultRoi: parseFloat(s.default_roi_percent) });
    if (log) wlog(`[RepricerJob] Settings reloaded — proxy: ${s.webshare_proxy_api ? 'set' : 'not set'}`);
  } catch (e) {
    console.warn('[RepricerJob] Could not reload settings:', e.message);
  }
}

function _applySchedule() {
  if (_activeCron) { _activeCron.stop(); _activeCron = null; }
  const pattern = _cronPattern(_intervalMinutes);
  _activeCron = cron.schedule(pattern, async () => {
    if (!_isAfterStartTime()) {
      wlog(`[Scheduler] Before start time ${_startTime} — skipping tick`);
      return;
    }
    await reloadSettings({ log: true });
    runRepricerJob();
  });
  wlog(`[Scheduler] ✅ Pattern: "${pattern}"  Start time: ${_startTime}  Interval: ${_intervalMinutes}min`);
}

// Called by server.js after settings are loaded from DB, so proxy URL / fee rate
// are already configured before the first repricer run fires.
export function startScheduler() {
  if (_isAfterStartTime()) reloadSettings().then(() => runRepricerJob());
  _applySchedule();
}

export { fastWorker, slowWorker };

// Start the scheduler now that workers and settings are ready.
startScheduler();

// Subscribe to settings-change events published by the API server.
// Changes from the Settings UI take effect immediately without a PM2 restart.
redisSub.subscribe('repricer:settings-updated', (err) => {
  if (err) console.warn('[RepricerJob] Could not subscribe to settings channel:', err.message);
  else     wlog('[RepricerJob] Subscribed to repricer:settings-updated');
});
redisSub.on('message', (channel) => {
  if (channel === 'repricer:settings-updated') {
    wlog('[RepricerJob] Settings change detected — reloading from DB');
    reloadSettings({ log: true });
  }
});

// 60-second poll as fallback in case a pub/sub message is missed.
setInterval(reloadSettings, 60_000);
