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
import { runRepricerJob, fastQueue, slowQueue } from './jobProducer.js';
import IORedis from 'ioredis';
import { createReadStream, existsSync, readFileSync, readdirSync, statSync, watch as fsWatch } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import multer from 'multer';
import XLSX from 'xlsx';

const __dirname = dirname(fileURLToPath(import.meta.url));

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
app.use(express.json());

// Runtime-mutable defaults loaded from DB settings at startup
const _globalSettings = { feeRate: 0.15, defaultRoi: 20 };

// ─────────────────────────────────────────────
// DASHBOARD STATS
// ─────────────────────────────────────────────

// GET /api/stats — overview numbers for dashboard cards
app.get('/api/stats', async (req, res) => {
  try {
    const [mappings, recentLogs, priceChanges] = await Promise.all([
      db.query('SELECT COUNT(*) FROM product_mappings WHERE is_active = true'),
      db.query(`SELECT COUNT(*) FROM sync_logs WHERE created_at > NOW() - INTERVAL '24 hours'`),
      db.query(`
        SELECT COUNT(*) FROM sync_logs
        WHERE status = 'success'
        AND created_at > NOW() - INTERVAL '24 hours'
      `),
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

// GET /api/mappings — list all product mappings
app.get('/api/mappings', async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT
        pm.*,
        (SELECT COUNT(*) FROM supplier_asins sa WHERE sa.product_mapping_id = pm.id) AS supplier_count,
        (SELECT status FROM sync_logs sl WHERE sl.product_mapping_id = pm.id ORDER BY created_at DESC LIMIT 1) AS last_sync_status
      FROM product_mappings pm
      ORDER BY pm.created_at DESC
    `);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/mappings/:id — single mapping detail
app.get('/api/mappings/:id', async (req, res) => {
  try {
    const { rows } = await db.query(
      'SELECT * FROM product_mappings WHERE id = $1',
      [req.params.id]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/mappings — create new mapping
app.post('/api/mappings', async (req, res) => {
  const {
    product_name, onbuy_listing_id, onbuy_sku,
    primary_asin, markup_type, markup_value, min_price, notes
  } = req.body;

  try {
    const { rows } = await db.query(
      `INSERT INTO product_mappings
        (product_name, onbuy_listing_id, onbuy_sku, primary_asin, markup_type, markup_value, min_price, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [product_name, onbuy_listing_id, onbuy_sku, primary_asin, markup_type, markup_value, min_price, notes]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/mappings/:id — update mapping
app.put('/api/mappings/:id', async (req, res) => {
  const {
    product_name, onbuy_listing_id, onbuy_sku,
    primary_asin, markup_type, markup_value, min_price, is_active, notes
  } = req.body;

  try {
    const { rows } = await db.query(
      `UPDATE product_mappings
       SET product_name=$1, onbuy_listing_id=$2, onbuy_sku=$3, primary_asin=$4,
           markup_type=$5, markup_value=$6, min_price=$7, is_active=$8, notes=$9, updated_at=NOW()
       WHERE id=$10 RETURNING *`,
      [product_name, onbuy_listing_id, onbuy_sku, primary_asin, markup_type, markup_value, min_price, is_active, notes, req.params.id]
    );
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/mappings/:id
app.delete('/api/mappings/:id', async (req, res) => {
  try {
    await db.query('DELETE FROM product_mappings WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────
// MANUAL SYNC TRIGGER
// ─────────────────────────────────────────────

// POST /api/sync — trigger full sync manually
app.post('/api/sync', async (req, res) => {
  try {
    // Run async — don't wait for it to finish
    runRepricerJob().catch(console.error);
    res.json({ message: 'Sync job started successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/queue-status — live job counts across both queues
app.get('/api/queue-status', async (req, res) => {
  try {
    const [fast, slow] = await Promise.all([
      fastQueue.getJobCounts('waiting', 'active', 'delayed'),
      slowQueue.getJobCounts('waiting', 'active', 'delayed'),
    ]);
    const total = (fast.waiting + fast.active + fast.delayed) +
                  (slow.waiting  + slow.active  + slow.delayed);
    res.json({ fast, slow, total, busy: total > 0 });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/scraper-logs — last 200 scraper log entries (in-memory)
app.get('/api/scraper-logs', (req, res) => {
  res.json(scraperLogs);
});

// GET /api/pm2-logs?process=worker|api|all — SSE stream of live log output
// Dev:  tails scraper.log via Node.js fsWatch (Windows-compatible, no PM2 needed)
// Prod: tails PM2 log files via `tail -f`
app.get('/api/pm2-logs', (req, res) => {
  res.setHeader('Content-Type',  'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection',    'keep-alive');
  res.flushHeaders();

  const send = (line, source) => {
    // Use timestamp embedded in log line (e.g. [2026-05-24T12:54:10.037Z]) so the
    // UI shows when the event actually happened, not when it was streamed.
    const match = line.match(/\[(\d{4}-\d{2}-\d{2}T[\d:.]+Z)\]/);
    const ts = match ? match[1] : new Date().toISOString();
    res.write(`data: ${JSON.stringify({ ts, line, source })}\n\n`);
  };

  // Windows = local dev (no PM2/tail); Linux = production VPS
  const isProduction = process.platform !== 'win32';

  if (!isProduction) {
    // ── Local dev: stream scraper.log using Node.js fs (Windows-compatible) ──
    const logPath = join(__dirname, 'scraper.log');

    if (!existsSync(logPath)) {
      send('scraper.log not found — run `npm run job` to generate logs', 'worker');
    } else {
      const content = readFileSync(logPath, 'utf8');
      content.split('\n').filter(Boolean).slice(-80).forEach(line => send(line, 'worker'));
    }

    let lastSize = existsSync(logPath) ? statSync(logPath).size : 0;
    let watcher  = null;

    try {
      // Watch the directory so we also detect file creation
      watcher = fsWatch(__dirname, { persistent: false }, (event, filename) => {
        if (filename && filename !== 'scraper.log') return;
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

    req.on('close', () => {
      clearInterval(hb);
      if (watcher) watcher.close();
    });

    return;
  }

  // ── Production: stream PM2 log files via tail -f ──
  const target = req.query.process || 'all';
  const pm2Dir = `${process.env.HOME || '/root'}/.pm2/logs`;

  // Discover log files dynamically — handles any PM2 process names
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
    worker: workerFiles.length ? workerFiles : allPm2Logs,
    api:    apiFiles.length    ? apiFiles    : allPm2Logs,
    all:    allPm2Logs,
  };

  if (allPm2Logs.length === 0) {
    send('No PM2 log files found — make sure PM2 processes are running', 'worker');
  }

  const files = fileMap[target] || allPm2Logs;

  const procs = files.flatMap(file => {
    const source = file.includes('worker') ? (file.includes('error') ? 'worker-err' : 'worker') :
                   file.includes('error') ? 'api-err' : 'api';
    if (!existsSync(file)) {
      send(`Log file not found: ${file}`, source);
      return [];
    }
    const tail = spawn('tail', ['-n', '80', '-f', file], { stdio: ['ignore', 'pipe', 'ignore'] });
    tail.stdout.setEncoding('utf8');
    tail.stdout.on('data', chunk => {
      chunk.split('\n').filter(Boolean).forEach(line => send(line, source));
    });
    tail.on('error', err => send(`tail error: ${err.message}`, source));
    return [tail];
  });

  const hb = setInterval(() => res.write(': heartbeat\n\n'), 20000);

  req.on('close', () => {
    clearInterval(hb);
    procs.forEach(p => p.kill());
  });
});

// GET /api/scraper-logs/file — download the full scraper.log file
app.get('/api/scraper-logs/file', (req, res) => {
  const logPath = join(__dirname, 'scraper.log');
  if (!existsSync(logPath)) return res.status(404).json({ error: 'No log file yet' });
  res.setHeader('Content-Type', 'text/plain');
  res.setHeader('Content-Disposition', 'attachment; filename="scraper.log"');
  createReadStream(logPath).pipe(res);
});

// POST /api/price-check — fetch real-time price for any ASIN
app.post('/api/price-check', async (req, res) => {
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
app.post('/api/sync/:id', async (req, res) => {
  try {
    const { rows } = await db.query(
      'SELECT * FROM product_mappings WHERE id = $1',
      [req.params.id]
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
app.get('/api/compare/:mappingId', async (req, res) => {
  try {
    const { rows: suppliers } = await db.query(
      'SELECT * FROM supplier_asins WHERE product_mapping_id = $1',
      [req.params.mappingId]
    );

    // Return cached data immediately
    res.json({ suppliers, note: 'Cached data. Use /api/compare/:id/refresh to get live prices.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/compare/:mappingId/refresh — live scrape all sellers for a product
app.post('/api/compare/:mappingId/refresh', async (req, res) => {
  try {
    const { rows: mapping } = await db.query(
      'SELECT * FROM product_mappings WHERE id = $1',
      [req.params.mappingId]
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
app.post('/api/suppliers', async (req, res) => {
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
app.get('/api/history/:mappingId', async (req, res) => {
  const days = parseInt(req.query.days) || 30;
  try {
    const { rows } = await db.query(
      `SELECT * FROM price_history
       WHERE product_mapping_id = $1
       AND recorded_at > NOW() - INTERVAL '${days} days'
       ORDER BY recorded_at ASC`,
      [req.params.mappingId]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────
// SYNC LOGS
// ─────────────────────────────────────────────

// GET /api/logs — recent sync logs
app.get('/api/logs', async (req, res) => {
  const limit = parseInt(req.query.limit) || 50;
  try {
    const { rows } = await db.query(
      `SELECT sl.*, pm.product_name, pm.primary_asin
       FROM sync_logs sl
       LEFT JOIN product_mappings pm ON pm.id = sl.product_mapping_id
       ORDER BY sl.created_at DESC
       LIMIT $1`,
      [limit]
    );
    res.json(rows);
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
app.get('/api/accounts', async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT id, account_name, site_id, is_active, last_tested_at, last_test_ok, created_at,
              LEFT(consumer_key, 6) || '••••••' AS consumer_key_hint
       FROM onbuy_accounts ORDER BY created_at DESC`
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/accounts — create account
app.post('/api/accounts', async (req, res) => {
  const { account_name, consumer_key, secret_key, site_id = '2000' } = req.body;
  if (!account_name || !consumer_key || !secret_key)
    return res.status(400).json({ error: 'account_name, consumer_key and secret_key are required' });
  try {
    const { rows } = await db.query(
      `INSERT INTO onbuy_accounts (account_name, consumer_key, secret_key, site_id)
       VALUES ($1, $2, $3, $4) RETURNING id, account_name, site_id, is_active, created_at`,
      [account_name, consumer_key, secret_key, site_id]
    );
    res.status(201).json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PUT /api/accounts/:id — update account
app.put('/api/accounts/:id', async (req, res) => {
  const { account_name, consumer_key, secret_key, site_id, is_active } = req.body;
  try {
    const { rows } = await db.query(
      `UPDATE onbuy_accounts SET
         account_name = COALESCE($1, account_name),
         consumer_key = COALESCE(NULLIF($2,''), consumer_key),
         secret_key   = COALESCE(NULLIF($3,''), secret_key),
         site_id      = COALESCE($4, site_id),
         is_active    = COALESCE($5, is_active),
         updated_at   = NOW()
       WHERE id = $6 RETURNING id, account_name, site_id, is_active`,
      [account_name, consumer_key, secret_key, site_id, is_active, req.params.id]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// DELETE /api/accounts/:id
app.delete('/api/accounts/:id', async (req, res) => {
  try {
    await db.query('DELETE FROM onbuy_accounts WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/accounts/:id/test — test OnBuy credentials
app.post('/api/accounts/:id/test', async (req, res) => {
  try {
    const { rows } = await db.query('SELECT * FROM onbuy_accounts WHERE id = $1', [req.params.id]);
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
app.get('/api/import/template', (req, res) => {
  // Columns: No# | Product Name | Sourcing Link | Onbuy Link | Source Price | Selling Price |
  //          Onbuy Fee | Total Cost | Net Profit | ROI % | Seller SKU | OPC
  //
  // Selling Price = Source Price + (Source Price × ROI%) + Onbuy Fee
  // Total Cost    = Source Price + Onbuy Fee
  // Net Profit    = Selling Price − Total Cost
  // Seller SKU    = SKU you assigned when listing on OnBuy (used by repricer to update price)
  // OPC           = OnBuy listing identifier (numeric = product code, alphanumeric = listing UID)

  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet([
    // Row 1: Column headers
    ['No#', 'Product Name', 'Selling Price', 'Onbuy Fee', 'Total Cost', 'Net Profit', 'ROI %', 'Seller SKU', 'OPC'],
    // Row 2: Sample 1 (all fields filled)
    [1, 'TP-Link Tapo 3K 5MP Pan/Tilt Security Camera', 106, 15.9, 85.9, 20.1, 28.71, 'B0F5K2H4NQ', 'PV5JMNM'],
    // Row 3: Sample 2 (minimal — Product Name + financial cols auto-filled on import)
    [2, '', 20.5, '', '', '', '', 'B0CW9BC1XF', 'PF2XQP8'],
  ]);

  ws['!cols'] = [5, 40, 13, 10, 10, 10, 8, 16, 14].map(w => ({ wch: w }));
  XLSX.utils.book_append_sheet(wb, ws, 'Import Template');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="import-template.xlsx"');
  res.send(buf);
});

// POST /api/import/preview — parse uploaded Excel, return rows for user review
// Auto-detects 1-row header (new template) or 2-row header (old template with section headings)
app.post('/api/import/preview', upload.single('file'), (req, res) => {
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

      // ROI%: use sheet value if present; when blank but Selling Price exists, set to 0 —
      // repricer will calibrate it on the first run using target_price and Amazon price
      const sheetRoi    = parseFloat(mapped.markup_value);
      const hasRoiCol   = !isNaN(sheetRoi) && String(mapped.markup_value || '').trim() !== '';
      const markupType  = (hasRoiCol || sellingPrice) ? 'roi'
                        : String(mapped.markup_type || 'percent').toLowerCase().trim();
      const markupValue = hasRoiCol ? sheetRoi : (sellingPrice ? 0 : _globalSettings.defaultRoi);

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

// POST /api/import/confirm — create product_mappings from validated rows
// For rows with action='create', calls OnBuy API to create the seller listing first.
app.post('/api/import/confirm', async (req, res) => {
  const { rows, onbuy_account_id, filename } = req.body;
  if (!Array.isArray(rows) || rows.length === 0)
    return res.status(400).json({ error: 'No rows provided' });

  const toImport = rows.filter(r => r.valid);
  const results = { created: 0, updated: 0, skipped: 0, onbuy_created: 0, errors: [] };

  // Pre-fetch OnBuy token once if any rows need listing creation
  const needsCreate = toImport.some(r => r.action === 'create');
  let account = null, onbuyToken = null;
  if (needsCreate) {
    account = await getImportAccount(onbuy_account_id);
    if (account) {
      onbuyToken = await getOnBuyTokenForAccount(account);
      if (!onbuyToken) {
        console.warn('[Import] Could not get OnBuy token — listing creation will be skipped');
      }
    }
  }

  // Auto-fetch missing product titles from Amazon (parallel, best-effort)
  const titleFetchRows = toImport.filter(r => r.needs_title_fetch && r.primary_asin);
  if (titleFetchRows.length > 0) {
    console.log(`[Import] Fetching ${titleFetchRows.length} product title(s) from Amazon...`);
    await Promise.all(titleFetchRows.map(async row => {
      const title = await fetchAmazonTitle(row.primary_asin);
      if (title) {
        row.product_name = title;
        console.log(`[Import] Title fetched for ${row.primary_asin}: "${title.slice(0, 60)}..."`);
      }
    }));
  }

  for (const row of toImport) {
    try {
      let listingId = row.onbuy_listing_id || null;

      // ── Create listing on OnBuy if only OPC is available ──
      if (row.action === 'create' && row.onbuy_opc) {
        if (!onbuyToken) {
          throw new Error(
            'No OnBuy account linked (or token failed) — link an account to auto-create listings'
          );
        }
        console.log(`[Import] Creating OnBuy listing for OPC ${row.onbuy_opc} (row ${row._row})`);
        const created = await createOnBuyListing(
          row.onbuy_opc,
          row.unit_price,
          row.onbuy_sku || null,
          onbuyToken,
          account.site_id
        );
        listingId = created.uid;
        results.onbuy_created++;
        console.log(`[Import] ✅ OnBuy listing created: UID=${listingId}`);
      }

      // ── Deduplicate: find existing record by onbuy_sku, or (primary_asin + OPC/listing_id) ──
      let existing = null;
      if (row.onbuy_sku) {
        const r = await db.query(
          'SELECT id FROM product_mappings WHERE onbuy_sku = $1 LIMIT 1',
          [row.onbuy_sku]
        );
        if (r.rows.length) existing = r.rows[0];
      }
      if (!existing && row.primary_asin) {
        const identifier = row.onbuy_opc || listingId;
        if (identifier) {
          const r = await db.query(
            `SELECT id FROM product_mappings
             WHERE primary_asin = $1 AND (onbuy_opc = $2 OR onbuy_listing_id = $2) LIMIT 1`,
            [row.primary_asin, identifier]
          );
          if (r.rows.length) existing = r.rows[0];
        }
      }

      if (existing) {
        await db.query(
          `UPDATE product_mappings SET
            product_name     = COALESCE($1, product_name),
            onbuy_listing_id = COALESCE($2, onbuy_listing_id),
            onbuy_opc        = COALESCE($3, onbuy_opc),
            onbuy_sku        = COALESCE($4, onbuy_sku),
            markup_type      = $5,
            markup_value     = $6,
            onbuy_fee        = $7,
            target_price     = COALESCE($8, target_price),
            min_price        = COALESCE($9, min_price),
            notes            = COALESCE($10, notes),
            updated_at       = NOW()
           WHERE id = $11`,
          [
            row.product_name  || null,
            listingId,
            row.onbuy_opc     || null,
            row.onbuy_sku     || null,
            row.markup_type,
            row.markup_value,
            row.onbuy_fee     || 0,
            row.target_price  || null,
            row.min_price     || null,
            row.notes         || null,
            existing.id,
          ]
        );
        results.updated++;
      } else {
        await db.query(
          `INSERT INTO product_mappings
            (product_name, onbuy_listing_id, onbuy_opc, onbuy_sku, primary_asin,
             markup_type, markup_value, onbuy_fee, target_price, min_price, notes, onbuy_account_id, is_active)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,true)`,
          [
            row.product_name     || null,
            listingId,
            row.onbuy_opc        || null,
            row.onbuy_sku        || null,
            row.primary_asin,
            row.markup_type,
            row.markup_value,
            row.onbuy_fee        || 0,
            row.target_price     || null,
            row.min_price        || null,
            row.notes            || null,
            onbuy_account_id     || null,
          ]
        );
        results.created++;
      }
    } catch (err) {
      console.error(`[Import] Row ${row._row} failed:`, err.message);
      results.errors.push({
        row:     row._row,
        product: row.product_name || row.onbuy_listing_id || row.onbuy_opc || '?',
        error:   err.message,
      });
      results.skipped++;
    }
  }

  // Audit log (best-effort)
  db.query(
    `INSERT INTO import_logs (filename, total_rows, imported, skipped, row_errors)
     VALUES ($1, $2, $3, $4, $5)`,
    [filename || 'unknown', toImport.length, results.created + results.updated, results.skipped,
     JSON.stringify(results.errors)]
  ).catch(e => console.warn('[Import] Could not write import_log:', e.message));

  res.json(results);
});

// ─────────────────────────────────────────────
// DB MIGRATIONS — run once on startup
// ─────────────────────────────────────────────

async function runMigrations() {
  const steps = [
    // onbuy_listing_id was VARCHAR(100) — OnBuy product URLs exceed that
    `ALTER TABLE product_mappings ALTER COLUMN onbuy_listing_id TYPE TEXT`,
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
       key        TEXT PRIMARY KEY,
       value      TEXT,
       updated_at TIMESTAMP DEFAULT NOW()
     )`,
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
  console.log('[Migration] ✅ Schema up to date');
}

// ─────────────────────────────────────────────
// SETTINGS
// ─────────────────────────────────────────────

async function loadSettingsFromDb() {
  try {
    const { rows } = await db.query('SELECT key, value FROM settings');
    const s = Object.fromEntries(rows.map(r => [r.key, r.value]));
    if (s.webshare_proxy_api)   setProxyApiUrl(s.webshare_proxy_api);
    if (s.onbuy_fee_percent)    _globalSettings.feeRate    = parseFloat(s.onbuy_fee_percent) / 100;
    if (s.default_roi_percent)  _globalSettings.defaultRoi = parseFloat(s.default_roi_percent);
    console.log(`[Settings] Fee: ${(_globalSettings.feeRate * 100).toFixed(1)}%  ROI: ${_globalSettings.defaultRoi}%`);
  } catch (e) {
    console.warn('[Settings] Could not load from DB:', e.message);
  }
}

app.get('/api/settings', async (req, res) => {
  try {
    const { rows } = await db.query('SELECT key, value FROM settings');
    const s = Object.fromEntries(rows.map(r => [r.key, r.value]));
    res.json({ ...s, _proxy_status: getProxyStatus() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/settings', async (req, res) => {
  const allowed = ['webshare_proxy_api', 'onbuy_fee_percent', 'default_roi_percent', 'job_interval_minutes', 'job_start_time'];
  try {
    for (const key of allowed) {
      if (!(key in req.body)) continue;
      const value = req.body[key] != null && req.body[key] !== '' ? String(req.body[key]) : null;
      if (value) {
        await db.query(
          `INSERT INTO settings (key, value, updated_at) VALUES ($1, $2, NOW())
           ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
          [key, value]
        );
      } else {
        await db.query('DELETE FROM settings WHERE key = $1', [key]);
      }
      if (key === 'webshare_proxy_api') {
        setProxyApiUrl(value);
      } else if (key === 'onbuy_fee_percent') {
        _globalSettings.feeRate = (value ? parseFloat(value) : 15) / 100;
      } else if (key === 'default_roi_percent') {
        _globalSettings.defaultRoi = value ? parseFloat(value) : 20;
      }
      // job_interval_minutes and job_start_time are saved to DB;
      // the worker process (repricerJob.js) reads them on its next startup.
    }
    const { rows } = await db.query('SELECT key, value FROM settings');
    const s = Object.fromEntries(rows.map(r => [r.key, r.value]));
    // Notify worker process to reload settings immediately (no PM2 restart needed)
    redisPub.publish('repricer:settings-updated', '1').catch(() => {});
    res.json({ ...s, _proxy_status: getProxyStatus() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/import/logs — import history
app.get('/api/import/logs', async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT * FROM import_logs ORDER BY created_at DESC LIMIT 50`
    );
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
