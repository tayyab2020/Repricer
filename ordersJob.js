/**
 * ordersJob.js
 * ─────────────────────────────────────────────────────────────
 * OnBuy Orders Sync
 * • Fetches orders for all active OnBuy accounts every 15 min
 * • Upserts into onbuy_orders + onbuy_order_items DB tables
 * • Enriches each line item with:
 *     - product_url   (OnBuy listings API by SKU)
 *     - source_url    (Amazon UK URL from product_mappings ASIN)
 *     - source_price  (last_amazon_price from product_mappings / Keepa)
 *     - total_cost    = source_price + total_fee
 *     - total_profit  = total_price  - total_cost
 * • Syncs current-month orders to linked Google Sheet (if set)
 * • Logs per-account to /logs/order_logs/{account}_{date}.log
 * ─────────────────────────────────────────────────────────────
 */

import cron         from 'node-cron';
import pg            from 'pg';
import dotenv        from 'dotenv';
import IORedis       from 'ioredis';
import { appendFileSync, mkdirSync } from 'fs';
import { join, dirname }             from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { resolve }                      from 'path';
import fetch                         from 'node-fetch';
import { google }                    from 'googleapis';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);
const LOG_DIR    = join(__dirname, 'logs', 'order_logs');
mkdirSync(LOG_DIR, { recursive: true });

// ── Logging ──────────────────────────────────────────────────────────────────
function makeLogger(accountName) {
  const safe = accountName.replace(/[^a-zA-Z0-9_-]/g, '_');
  return function log(msg) {
    const ts   = new Date().toISOString();
    const date = ts.slice(0, 10);
    const line = `[${ts}] ${msg}\n`;
    try { appendFileSync(join(LOG_DIR, `${safe}_${date}.log`), line); } catch {}
    console.log(`[OrdersJob][${accountName}] ${msg}`);
  };
}

// ── OnBuy auth ────────────────────────────────────────────────────────────────
async function getOnBuyToken({ consumer_key, secret_key }) {
  const r = await fetch('https://api.onbuy.com/v2/auth/request-token', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ consumer_key, secret_key }),
  });
  if (!r.ok) throw new Error(`OnBuy auth failed (${r.status}): ${await r.text()}`);
  const data  = await r.json();
  const token = data?.access_token || data?.Result?.token;
  if (!token) throw new Error('No access_token in OnBuy auth response');
  return token;
}

// ── Fetch all orders (paginated) ──────────────────────────────────────────────
// lookbackMinutes: if set, fetch only orders modified in the last N minutes (cron runs).
// If null, fetch from the start of the current month (manual / first-run full sync).
async function fetchAllOrders(token, siteId, lookbackMinutes = null) {
  const LIMIT = 100;
  let offset  = 0;
  const all   = [];

  let modifiedSince;
  if (lookbackMinutes != null) {
    const since = new Date(Date.now() - lookbackMinutes * 60 * 1000);
    modifiedSince = encodeURIComponent(
      since.toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, '')
    );
  } else {
    // Full month fetch — OnBuy expects "YYYY-MM-DD HH:MM:SS" (URL-encoded)
    const now = new Date();
    modifiedSince = encodeURIComponent(
      `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01 00:00:00`
    );
  }

  while (true) {
    const url = `https://api.onbuy.com/v2/orders?site_id=${siteId}&filter[status]=all&filter[modified_since]=${modifiedSince}&limit=${LIMIT}&offset=${offset}`;
    const r   = await fetch(url, { headers: { Authorization: token } });
    if (!r.ok) throw new Error(`Orders API ${r.status}: ${await r.text()}`);
    const data    = await r.json();
    const results = data.results ?? [];
    all.push(...results);
    const total = parseInt(data.metadata?.total_rows ?? 0);
    offset += results.length;
    if (offset >= total || results.length === 0) break;
  }
  return all;
}

// ── Upsert orders into DB ─────────────────────────────────────────────────────
async function upsertOrders(db, account, orders) {
  let inserted = 0, updated = 0;
  for (const o of orders) {
    const { rows } = await db.query(
      `INSERT INTO onbuy_orders (
         account_id, user_id, order_id, onbuy_internal_ref, order_date,
         updated_at_onbuy, status, site_id,
         buyer_name, buyer_email, buyer_phone,
         delivery_address, billing_address,
         price_subtotal, price_total, price_delivery,
         sales_fee_ex_vat, sales_fee_inc_vat, vat_rate,
         currency_code, fee, products, raw_data
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)
       ON CONFLICT (account_id, order_id) DO UPDATE SET
         status           = EXCLUDED.status,
         updated_at_onbuy = EXCLUDED.updated_at_onbuy,
         products         = EXCLUDED.products,
         fee              = EXCLUDED.fee,
         raw_data         = EXCLUDED.raw_data,
         synced_at        = NOW()
       RETURNING (xmax = 0) AS inserted`,
      [
        account.id, account.user_id, o.order_id, o.onbuy_internal_reference,
        o.date, o.updated_at, o.status, o.site_id,
        o.buyer?.name, o.buyer?.email, o.buyer?.phone,
        JSON.stringify(o.delivery_address ?? null),
        JSON.stringify(o.billing_address  ?? null),
        parseFloat(o.price_subtotal)    || 0,
        parseFloat(o.price_total)       || 0,
        parseFloat(o.price_delivery)    || 0,
        parseFloat(o.sales_fee_ex_VAT)  || 0,
        parseFloat(o.sales_fee_inc_VAT) || 0,
        parseFloat(o.fee?.vat_rate)     || 0,
        o.currency_code,
        JSON.stringify(o.fee      ?? null),
        JSON.stringify(o.products ?? null),
        JSON.stringify(o),
      ]
    );
    if (rows[0]?.inserted) inserted++; else updated++;
  }
  return { inserted, updated };
}

// ── Fetch product_url from OnBuy listings API by SKU ─────────────────────────
async function fetchProductUrl(token, siteId, sku) {
  try {
    const url = `https://api.onbuy.com/v2/listings?site_id=${siteId}&filter[sku]=${encodeURIComponent(sku)}`;
    const r   = await fetch(url, { headers: { Authorization: token } });
    if (!r.ok) return null;
    const data = await r.json();
    return data.results?.[0]?.product_url ?? null;
  } catch {
    return null;
  }
}

// ── Enrich order line items (product URL, ASIN, price, financials) ────────────
async function enrichOrderItems(db, account, token, orders) {
  // Collect all unique SKUs present in this batch
  const allSkus = new Set();
  for (const o of orders) {
    for (const p of o.products ?? []) {
      if (p.sku) allSkus.add(p.sku);
    }
  }
  if (allSkus.size === 0) return {};

  // Load already-cached product URLs from DB so we skip re-fetching
  const { rows: cached } = await db.query(
    `SELECT DISTINCT ON (sku) sku, product_url
     FROM onbuy_order_items WHERE account_id = $1 AND product_url IS NOT NULL`,
    [account.id]
  );
  const urlCache = Object.fromEntries(cached.map(r => [r.sku, r.product_url]));

  // Fetch product URLs for SKUs not yet seen
  const newSkus = [...allSkus].filter(s => !(s in urlCache));
  for (const sku of newSkus) {
    urlCache[sku] = await fetchProductUrl(token, account.site_id || '2000', sku);
    if (newSkus.length > 1) await new Promise(r => setTimeout(r, 120)); // rate limit
  }

  // Build enrichment map and upsert per-item rows
  const enrichmentMap = {};

  for (const order of orders) {
    const vatRate  = parseFloat(order.fee?.vat_rate ?? 0);
    const products = Array.isArray(order.products) ? order.products : [];

    for (const product of products) {
      const sku        = product.sku ?? '';
      const productUrl = urlCache[sku] ?? null;
      const asin       = sku || null;
      const sourceUrl  = /^B[0-9A-Z]{9}$/i.test(sku) ? `https://www.amazon.co.uk/dp/${sku}` : null;

      const zeroed     = isCancelledOrRefunded(order.status);
      const fee        = zeroed ? 0 : parseFloat(product.fee?.total_sales_fee ?? 0);
      const vat        = parseFloat(product.fee?.fees_tax ?? 0);
      const totalFee   = +(fee + vat).toFixed(2);
      const totalPrice = zeroed ? 0 : parseFloat(product.total_price ?? 0);

      enrichmentMap[`${order.order_id}|${sku}`] = {
        product_url: productUrl,
        amazon_asin: asin,
        source_url:  sourceUrl,
      };

      try {
        await db.query(
          `INSERT INTO onbuy_order_items (
             order_id, account_id, user_id, sku, product_name, quantity,
             unit_price, total_price, onbuy_fee, vat, total_fee,
             product_url, amazon_asin, source_url
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
           ON CONFLICT (account_id, order_id, sku) DO UPDATE SET
             product_url = COALESCE(EXCLUDED.product_url, onbuy_order_items.product_url),
             amazon_asin = COALESCE(EXCLUDED.amazon_asin, onbuy_order_items.amazon_asin),
             source_url  = COALESCE(EXCLUDED.source_url, onbuy_order_items.source_url),
             onbuy_fee   = EXCLUDED.onbuy_fee,
             vat         = EXCLUDED.vat,
             total_fee   = EXCLUDED.total_fee,
             total_price = EXCLUDED.total_price,
             enriched_at = NOW()`,
          [
            order.order_id, account.id, account.user_id, sku, product.name,
            parseInt(product.quantity ?? 1),
            parseFloat(product.unit_price ?? 0), totalPrice,
            fee, vat, totalFee,
            productUrl, asin, sourceUrl,
          ]
        );
      } catch (e) {
        console.error(`[OrdersJob] Item upsert error ${order.order_id}/${sku}:`, e.message);
      }
    }
  }

  return enrichmentMap;
}

// ── Sheet helpers ─────────────────────────────────────────────────────────────
function monthTabName(date = new Date()) {
  const m = date.toLocaleString('en-US', { month: 'long', timeZone: 'Europe/London' });
  const y = date.toLocaleString('en-US', { year: 'numeric', timeZone: 'Europe/London' });
  return `${m}, ${y}`;
}

function tabForOrder(order) {
  const d = new Date(order.order_date ?? order.date);
  return isNaN(d.getTime()) ? monthTabName() : monthTabName(d);
}

// Convert a UTC date string to a Google Sheets serial number using Europe/London local date.
// Storing dates as serials lets Sheets sort them correctly as numbers.
// A "D MMMM YYYY" number format applied to the column renders "10 June 2026".
function toSheetsSerial(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return String(dateStr);
  // Get the calendar date in UK local time (BST/GMT) to avoid off-by-one on midnight-crossing orders
  const londonDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' }).format(d);
  const midnight = new Date(londonDate + 'T00:00:00.000Z');
  return Math.floor((midnight.getTime() - new Date('1899-12-30T00:00:00.000Z').getTime()) / 86400000);
}

function formatAddress(addr) {
  if (!addr) return '';
  const a = typeof addr === 'string' ? JSON.parse(addr) : addr;
  return [a.line_1, a.line_2, a.line_3, a.town, a.county, a.postcode, a.country]
    .filter(Boolean).join('\n');
}

// Row-3 column headers for newly-created tabs (A–W)
// J (index 9) and U (index 20) are yellow separator columns with heading "_"
const SHEET_HEADERS = [
  'Order Date', 'Order No', 'Customer Details', 'Source Order No.', 'Source Order Date',
  'Tracking', 'Courier Name', 'Sourcing Link', 'Onbuy Link',
  '',                                                               // J (9)  yellow separator
  'Qty', 'Unit Price', 'Source Price',                             // K-M (10-12)
  'Onbuy Fee', 'Boosted', 'VAT', 'Total Fee',                       // N-Q (13-16)
  'Total Cost', 'Delivery Fee', 'Selling Price', 'Net Profit',     // R-U (17-20)
  '',                                                               // V (21) yellow separator
  'ROI %', 'Status',                                               // W-X (22-23)
];

// Row-2 meta-headers written when creating a new tab (0-based column index → text)
const SHEET_ROW2_HEADERS = {
  0:  'Selling Details',
  10: 'Selling Details / Profit',
};

// Statuses where OnBuy fee and selling price should be treated as 0
const ZERO_FEE_STATUSES = new Set([
  'cancelled', 'cancelled_by_seller', 'cancelled_by_buyer', 'cancelled_by_customer', 'refunded', 'partially_refunded',
]);
function isCancelledOrRefunded(status) {
  const normalized = (status ?? '').toLowerCase().replace(/\s+/g, '_');
  return ZERO_FEE_STATUSES.has(normalized);
}

// Columns filled manually or computed by sheet formula — never overwritten during sync
const MANUAL_HEADERS = new Set([
  'Tracking', 'Courier Name', 'Source Order Date', 'Source Order No.',
  'Source Price', 'Total Fee', 'Total Cost', 'Net Profit',
]);

// Formulas written into new rows only (existing rows already have their own formulas)
// Each value is a function(colIdx, rowNum) → formula string
const FORMULA_COLUMNS = {
  'Total Fee':  (ci, r) => `=SUM(${colIdxToLetter(ci['Onbuy Fee'])}${r}:${colIdxToLetter(ci['VAT'])}${r})`,
  'Total Cost': (ci, r) => `=${colIdxToLetter(ci['Total Fee'])}${r}+${colIdxToLetter(ci['Source Price'])}${r}`,
  'Net Profit': (ci, r) => `=${colIdxToLetter(ci['Selling Price'])}${r}-${colIdxToLetter(ci['Total Cost'])}${r}`,
  'ROI %':      (ci, r) => `=IF(${colIdxToLetter(ci['Source Price'])}${r}=0,0,${colIdxToLetter(ci['Net Profit'])}${r}/${colIdxToLetter(ci['Source Price'])}${r}*100)`,
};

// Coerce a value to a JS number for sheet storage; returns '' for null/empty/NaN
function toNum(val) {
  if (val === '' || val == null) return '';
  const n = Number(val);
  return isNaN(n) ? '' : n;
}

// Returns row data as an object keyed by header title.
// Only non-manual, non-formula columns are included — sheet formulas handle the rest.
function buildSheetRow(order, product, vatRate, enriched = {}) {
  const zeroed      = isCancelledOrRefunded(order.status);
  const fee         = zeroed ? 0 : parseFloat(product.fee?.total_sales_fee ?? 0);
  const vat         = parseFloat(product.fee?.fees_tax ?? 0);
  const deliveryFee = zeroed ? 0 : toNum(product.price_delivery_total ?? 0);
  const spBase      = toNum(product.total_price);
  const sellingPrice = zeroed ? 0 : (spBase === '' ? '' : spBase + deliveryFee);
  const boosted     = parseFloat(product.commission_boost_marketing_percentage ?? 0) > 0 ? 'Yes' : '';
  const rawStatus = (order.status ?? '').replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  const status    = rawStatus === 'Cancelled By Customer' ? 'Cancelled By Buyer' : rawStatus;
  const rawData   = order.raw_data ?? {};
  const dispatches = Array.isArray(rawData.dispatches) ? rawData.dispatches : [];
  const apiTracking = dispatches[0]?.tracking_number ?? '';
  return {
    'Order Date':        toSheetsSerial(order.order_date ?? order.date),
    'Order No':          order.order_id,
    'Customer Details':  (() => {
      const raw = order.delivery_address;
      const a   = raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : null;
      const addr = a ? [a.line_1, a.line_2, a.line_3, a.town, a.county, a.postcode].filter(Boolean).join(' ') : '';
      return [order.buyer_name, addr].filter(Boolean).join(' | ');
    })(),
    'Sourcing Link':     enriched.source_url  || '',
    'Onbuy Link':        enriched.product_url || '',
    'Qty':               toNum(product.quantity),
    'Unit Price':        toNum(product.unit_price),
    'Selling Price':     sellingPrice,
    'Onbuy Fee':         toNum(fee),
    'Boosted':           boosted,
    'VAT':               toNum(vat),
    'Delivery Fee':      deliveryFee,
    'Status':            status,
    '_apiTracking':      apiTracking,
  };
}

// 0-based column index → A1 letter (e.g. 0→A, 25→Z, 26→AA)
function colIdxToLetter(idx) {
  let s = '';
  for (let n = idx + 1; n > 0; n = Math.floor((n - 1) / 26))
    s = String.fromCharCode(65 + (n - 1) % 26) + s;
  return s;
}

// Convert row object to ordered array using a headers array
function rowObjToArray(obj, headers) {
  return headers.map(h => obj[h] ?? '');
}

// ── Google Sheets sync ────────────────────────────────────────────────────────
async function syncToGoogleSheet(account, dbOrders, enrichmentMap, log, preComputedDispatchCount = null) {
  if (!account.google_sheet_id || !account.google_service_account) return;

  let creds;
  try {
    creds = typeof account.google_service_account === 'string'
      ? JSON.parse(account.google_service_account) : account.google_service_account;
  } catch {
    log('Invalid service account JSON — skipping sheet sync');
    return;
  }

  const auth   = new google.auth.GoogleAuth({ credentials: creds, scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
  const sheets = google.sheets({ version: 'v4', auth });
  const spreadsheetId = account.google_sheet_id;
  log(`Sheet ID: ${spreadsheetId} | Service account: ${creds.client_email}`);

  // Group by target tab
  const byTab = new Map();
  for (const order of dbOrders) {
    const tab      = tabForOrder(order);
    const products = Array.isArray(order.products)
      ? order.products : (typeof order.products === 'string' ? JSON.parse(order.products) : []);
    const vatRate  = parseFloat(order.vat_rate ?? 0);
    for (const product of products) {
      if (!byTab.has(tab)) byTab.set(tab, []);
      byTab.get(tab).push({ order, product, vatRate });
    }
  }

  const meta     = (await sheets.spreadsheets.get({ spreadsheetId })).data;
  const knownTabs = new Set((meta.sheets ?? []).map(s => s.properties?.title));
  const tabIdMap  = new Map((meta.sheets ?? []).map(s => [s.properties?.title, s.properties?.sheetId]));

  // ── One-time migration: move 'Delivery Fee' to new position for ALL tabs ──────
  // Runs every sync but is a no-op once migrated (condition never re-triggers).
  // Must run before the byTab loop so that loop reads updated column positions.
  if (tabIdMap.size > 0) {
    const allTabNames = [...tabIdMap.keys()];
    let hdrRanges = [];
    try {
      const batchHdr = await sheets.spreadsheets.values.batchGet({
        spreadsheetId,
        ranges: allTabNames.map(t => `'${t}'!A3:Z3`),
      });
      hdrRanges = batchHdr.data.valueRanges ?? [];
    } catch (e) {
      log(`[Migration] header read error: ${e.message}`);
    }

    const migMeta = [];

    for (let i = 0; i < hdrRanges.length; i++) {
      const headerRow = hdrRanges[i].values?.[0] ?? [];
      const ci = {};
      headerRow.forEach((h, idx) => { if (h) ci[String(h).trim()] = idx; });

      const tName    = allTabNames[i];
      const tSheetId = tabIdMap.get(tName);
      if (tSheetId == null)                      continue;
      if (ci['Delivery Fee'] == null)            continue;
      if (ci['Total Fee'] == null)               continue;
      if (ci['Selling Price'] == null)           continue;
      if (ci['Delivery Fee'] >= ci['Total Fee']) continue; // already in new position

      migMeta.push({ tName, ci, tSheetId });
    }

    if (migMeta.length > 0) {
      // Build a single batchUpdate: unmerge → moveDimension → re-merge for each tab.
      // The K2:U2 "Selling Details / Profit" merge spans the columns being moved, so
      // we must unmerge it first or the API returns a "crosses merged cell" error.
      const migrateRequests = [];

      // Phase 1: unmerge rows 1-2 for every tab being migrated
      for (const { tSheetId } of migMeta) {
        migrateRequests.push(
          { unmergeCells: { range: { sheetId: tSheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: 50 } } },
          { unmergeCells: { range: { sheetId: tSheetId, startRowIndex: 1, endRowIndex: 2, startColumnIndex: 0, endColumnIndex: 50 } } },
        );
      }
      // Phase 2: moveDimension for every tab
      for (const { ci, tSheetId } of migMeta) {
        migrateRequests.push({ moveDimension: {
          source: { sheetId: tSheetId, dimension: 'COLUMNS',
                    startIndex: ci['Delivery Fee'], endIndex: ci['Delivery Fee'] + 1 },
          destinationIndex: ci['Selling Price'],
        }});
      }
      // Phase 3: re-apply the standard row-1 and row-2 merges for every tab
      for (const { tSheetId } of migMeta) {
        migrateRequests.push(
          // A1:I1 — account name
          { mergeCells: { range: { sheetId: tSheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: 9 }, mergeType: 'MERGE_ALL' } },
          // W1:X1 — Total Dispatch counter
          { mergeCells: { range: { sheetId: tSheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 22, endColumnIndex: 24 }, mergeType: 'MERGE_ALL' } },
          // A2:I2 — "Selling Details"
          { mergeCells: { range: { sheetId: tSheetId, startRowIndex: 1, endRowIndex: 2, startColumnIndex: 0, endColumnIndex: 9 }, mergeType: 'MERGE_ALL' } },
          // K2:U2 — "Selling Details / Profit"
          { mergeCells: { range: { sheetId: tSheetId, startRowIndex: 1, endRowIndex: 2, startColumnIndex: 10, endColumnIndex: 21 }, mergeType: 'MERGE_ALL' } },
        );
      }

      try {
        await sheets.spreadsheets.batchUpdate({
          spreadsheetId,
          requestBody: { requests: migrateRequests },
        });
      } catch (e) {
        log(`[Migration] batchUpdate error: ${e.message}`);
        migMeta.length = 0; // skip formula fix if move failed
      }

      const formulaUpdates = [];
      for (const { tName, ci } of migMeta) {
        const oldDFIdx = ci['Delivery Fee'];
        const spIdx    = ci['Selling Price'];

        // Recompute column letters after the move
        const newCI = { ...ci };
        for (const key of Object.keys(newCI)) {
          if (newCI[key] > oldDFIdx && newCI[key] < spIdx) newCI[key]--;
        }
        newCI['Delivery Fee'] = spIdx - 1;

        const tfCol    = colIdxToLetter(newCI['Total Fee']);
        const onbuyCol = colIdxToLetter(newCI['Onbuy Fee']);
        const vatCol   = colIdxToLetter(newCI['VAT']);
        const dfCol    = colIdxToLetter(newCI['Delivery Fee']);
        const tcCol    = colIdxToLetter(newCI['Total Cost']);

        // Row 1 column-total SUM formulas for the three shifted columns
        formulaUpdates.push(
          { range: `'${tName}'!${tfCol}1`, values: [[`=SUM(${tfCol}4:${tfCol}1000)`]] },
          { range: `'${tName}'!${tcCol}1`, values: [[`=SUM(${tcCol}4:${tcCol}1000)`]] },
          { range: `'${tName}'!${dfCol}1`, values: [[`=SUM(${dfCol}4:${dfCol}1000)`]] },
        );
        // Rewrite Total Fee formulas for all data rows (4-1000).
        // Sheets auto-expands a SUM range to track the moved column, producing the
        // wrong =SUM(N:S) — we must overwrite with the correct =SUM(OnbuyFee:VAT).
        for (let r = 4; r <= 1000; r++) {
          formulaUpdates.push({
            range: `'${tName}'!${tfCol}${r}`,
            values: [[`=SUM(${onbuyCol}${r}:${vatCol}${r})`]],
          });
        }
        log(`[Migration] moved 'Delivery Fee' to col ${dfCol} in tab ${tName}`);
      }

      if (formulaUpdates.length > 0) {
        // Split into 1000-item batches to stay within API body limits
        for (let i = 0; i < formulaUpdates.length; i += 1000) {
          await sheets.spreadsheets.values.batchUpdate({
            spreadsheetId,
            requestBody: { valueInputOption: 'USER_ENTERED', data: formulaUpdates.slice(i, i + 1000) },
          }).catch(e => log(`[Migration] formula write error: ${e.message}`));
        }
      }
    }
  }

  // When there are no recently-synced orders (quiet period) but we have a pre-computed
  // dispatch count, still update V1 on the current month's tab so the counter is current.
  if (byTab.size === 0 && preComputedDispatchCount !== null) {
    const currentTabName = monthTabName();
    if (knownTabs.has(currentTabName)) {
      try {
        await sheets.spreadsheets.values.update({
          spreadsheetId,
          range: `'${currentTabName}'!W1`,
          valueInputOption: 'RAW',
          requestBody: { values: [[`Total Dispatch: ${preComputedDispatchCount}`]] },
        });
        log(`No recent orders — updated Total Dispatch: ${preComputedDispatchCount}`);
      } catch (e) {
        log(`Dispatch counter update error: ${e.message}`);
      }
    }
    return;
  }

  for (const [tabName, items] of byTab) {
    try {
      if (!knownTabs.has(tabName)) {
        const addRes = await sheets.spreadsheets.batchUpdate({
          spreadsheetId,
          requestBody: { requests: [{ addSheet: { properties: { title: tabName } } }] },
        });
        const newSheetId = addRes.data.replies?.[0]?.addSheet?.properties?.sheetId;
        if (newSheetId != null) tabIdMap.set(tabName, newSheetId);

        // Row 3: main column headers (A-S)
        await sheets.spreadsheets.values.update({
          spreadsheetId,
          range: `'${tabName}'!A3`,
          valueInputOption: 'RAW',
          requestBody: { values: [SHEET_HEADERS] },
        });
        // Row 2: meta-headers (Status, ROI %, etc.)
        const row2 = Array(25).fill('');
        Object.entries(SHEET_ROW2_HEADERS).forEach(([ci, h]) => { row2[Number(ci)] = h; });
        await sheets.spreadsheets.values.update({
          spreadsheetId,
          range: `'${tabName}'!A2`,
          valueInputOption: 'RAW',
          requestBody: { values: [row2] },
        });

        // Row 1: account name + yellow separator placeholders + Total Dispatch counter (W1:X1 merged)
        const row1Raw = [
          { range: `'${tabName}'!A1`, values: [[account.account_name || '']] },
          { range: `'${tabName}'!J1`, values: [['_']] },
          { range: `'${tabName}'!V1`, values: [['_']] },
          { range: `'${tabName}'!W1`, values: [['Total Dispatch: 0']] },
        ];
        await sheets.spreadsheets.values.batchUpdate({
          spreadsheetId,
          requestBody: { valueInputOption: 'RAW', data: row1Raw },
        });
        // SUM formulas for numeric columns in row 1 (Unit Price → Net Profit, cols L–U)
        const row1Formulas = [];
        for (let ci = 11; ci <= 20; ci++) {
          const col = colIdxToLetter(ci);
          row1Formulas.push({ range: `'${tabName}'!${col}1`, values: [[`=SUM(${col}4:${col}1000)`]] });
        }
        await sheets.spreadsheets.values.batchUpdate({
          spreadsheetId,
          requestBody: { valueInputOption: 'USER_ENTERED', data: row1Formulas },
        });

        knownTabs.add(tabName);
        log(`Created tab: ${tabName}`);
      }

      // Read all columns — scan first 3 rows to build column-index map
      // (row 2 has "Status", "ROI %" etc.; row 3 has main column headers)
      const existingVals = (await sheets.spreadsheets.values.get({
        spreadsheetId,
        range: `'${tabName}'!A:Z`,
      })).data.values ?? [];

      const colIdx = {};
      for (let r = 0; r < Math.min(3, existingVals.length); r++) {
        (existingVals[r] ?? []).forEach((h, i) => {
          const key = String(h).trim();
          if (key && !(key in colIdx)) colIdx[key] = i;
        });
      }

      // Auto-insert "Delivery Fee" column on existing tabs that pre-date this feature.
      // Inserts right after VAT so Total Fee = SUM(OnbuyFee:DeliveryFee) works correctly.
      if (colIdx['Delivery Fee'] == null && colIdx['VAT'] != null) {
        const insertAt = colIdx['VAT'] + 1;
        const sheetId  = tabIdMap.get(tabName);
        if (sheetId != null) {
          await sheets.spreadsheets.batchUpdate({
            spreadsheetId,
            requestBody: { requests: [{ insertDimension: {
              range: { sheetId, dimension: 'COLUMNS', startIndex: insertAt, endIndex: insertAt + 1 },
              inheritFromBefore: false,
            }}] },
          });
          const newColLetter = colIdxToLetter(insertAt);
          await sheets.spreadsheets.values.batchUpdate({
            spreadsheetId,
            requestBody: { valueInputOption: 'USER_ENTERED', data: [
              { range: `'${tabName}'!${newColLetter}3`, values: [['Delivery Fee']] },
              { range: `'${tabName}'!${newColLetter}1`, values: [[`=SUM(${newColLetter}4:${newColLetter}1000)`]] },
            ]},
          });
          // Shift all colIdx entries at or after the insert point, then register the new column
          for (const key of Object.keys(colIdx)) {
            if (colIdx[key] >= insertAt) colIdx[key]++;
          }
          colIdx['Delivery Fee'] = insertAt;
          log(`Auto-inserted 'Delivery Fee' column at ${newColLetter} in tab ${tabName}`);
        }
      }

      const orderNumCol = colIdx['Order No'] ?? 1; // col B

      // Data starts at row 4 (index 3); rows 1-3 are title/meta/column-headers
      // rowMap stores ALL row numbers per orderId (orders with multiple products have multiple rows)
      const rowMap = new Map(); // orderId → [rowNum, ...]
      for (let i = 3; i < existingVals.length; i++) {
        const oid = (existingVals[i]?.[orderNumCol] ?? '').toString().trim();
        if (oid) {
          if (!rowMap.has(oid)) rowMap.set(oid, []);
          rowMap.get(oid).push(i + 1);
        }
      }
      const rowCursor = new Map(); // orderId → how many items consumed so far

      // Count unique orders whose expected_dispatch_date is today → update V1 (merged V1:W1).
      // Use the caller-supplied count when available (computed from all DB orders, not just
      // the current sync batch). Fall back to computing from items for backward compatibility.
      let todayDispatchCount;
      if (preComputedDispatchCount !== null && tabName === monthTabName()) {
        todayDispatchCount = preComputedDispatchCount;
      } else {
        const todayStr = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' }).format(new Date());
        const seenDispatchIds = new Set();
        todayDispatchCount = 0;
        for (const { order } of items) {
          if (seenDispatchIds.has(order.order_id)) continue;
          seenDispatchIds.add(order.order_id);
          const rawData = typeof order.raw_data === 'string'
            ? JSON.parse(order.raw_data) : (order.raw_data ?? {});
          if (rawData.dispatched || order.is_dispatched) continue;
          if ((rawData.status ?? order.status ?? '') !== 'Awaiting Dispatch') continue;
          const products = Array.isArray(rawData.products) ? rawData.products : [];
          if (products.some(p => (p.expected_dispatch_date ?? '').toString().startsWith(todayStr))) {
            todayDispatchCount++;
          }
        }
      }
      await sheets.spreadsheets.values.update({
        spreadsheetId,
        range: `'${tabName}'!W1`,
        valueInputOption: 'RAW',
        requestBody: { values: [[`Total Dispatch: ${todayDispatchCount}`]] },
      });

      const batchData  = [];
      const formulaData = [];
      const newRowObjs = [];
      let   updatedRows = 0;

      // Ensure ROI % and Status are in row 3 (W3, X3) not row 2 — fixes existing tabs
      batchData.push(
        { range: `'${tabName}'!W2`, values: [['']] },
        { range: `'${tabName}'!X2`, values: [['']] },
        { range: `'${tabName}'!W3`, values: [['ROI %']] },
        { range: `'${tabName}'!X3`, values: [['Status']] },
      );

      for (const { order, product, vatRate } of items) {
        const enrichKey  = `${order.order_id}|${product.sku ?? ''}`;
        const enriched   = enrichmentMap[enrichKey] ?? {};
        const rowObj     = buildSheetRow(order, product, vatRate, enriched);
        const existingRows = rowMap.get(order.order_id) ?? [];
        const cursor     = rowCursor.get(order.order_id) ?? 0;
        rowCursor.set(order.order_id, cursor + 1);
        const rowNum     = existingRows[cursor];

        if (rowNum) {
          for (const [header, value] of Object.entries(rowObj)) {
            if (header.startsWith('_')) continue;
            if (MANUAL_HEADERS.has(header)) continue;
            const ci = colIdx[header];
            if (ci == null) continue;
            if (header === 'Sourcing Link') {
              const existing = (existingVals[rowNum - 1]?.[ci] ?? '').toString().trim();
              if (existing) continue;
            }
            batchData.push({ range: `'${tabName}'!${colIdxToLetter(ci)}${rowNum}`, values: [[value]] });
          }
          // Write tracking from API dispatches when available (won't overwrite if already present)
          if (rowObj._apiTracking) {
            const tci = colIdx['Tracking'];
            if (tci != null) batchData.push({ range: `'${tabName}'!${colIdxToLetter(tci)}${rowNum}`, values: [[rowObj._apiTracking]] });
          }
          // Re-apply formulas to existing rows so they stay up to date
          for (const [header, formulaFn] of Object.entries(FORMULA_COLUMNS)) {
            const ci = colIdx[header];
            if (ci == null) continue;
            formulaData.push({ range: `'${tabName}'!${colIdxToLetter(ci)}${rowNum}`, values: [[formulaFn(colIdx, rowNum)]] });
          }
          updatedRows++;
        } else {
          newRowObjs.push({ orderId: order.order_id, rowObj });
        }
      }

      // New rows: write cell-by-cell so Status (row-2 header column) is included
      let nextNewRow = existingVals.length + 1; // first row after last existing row
      for (const { rowObj } of newRowObjs) {
        const rowNum = nextNewRow++;
        for (const [header, value] of Object.entries(rowObj)) {
          if (header.startsWith('_')) continue;
          if (MANUAL_HEADERS.has(header)) continue;
          const ci = colIdx[header];
          if (ci == null) continue;
          batchData.push({ range: `'${tabName}'!${colIdxToLetter(ci)}${rowNum}`, values: [[value]] });
        }
        // Write tracking from API dispatches when available
        if (rowObj._apiTracking) {
          const tci = colIdx['Tracking'];
          if (tci != null) batchData.push({ range: `'${tabName}'!${colIdxToLetter(tci)}${rowNum}`, values: [[rowObj._apiTracking]] });
        }
        // Write formulas for computed columns (Total Fee, Total Cost, Net Profit)
        for (const [header, formulaFn] of Object.entries(FORMULA_COLUMNS)) {
          const ci = colIdx[header];
          if (ci == null) continue;
          formulaData.push({ range: `'${tabName}'!${colIdxToLetter(ci)}${rowNum}`, values: [[formulaFn(colIdx, rowNum)]] });
        }
      }

      if (batchData.length > 0) {
        await sheets.spreadsheets.values.batchUpdate({
          spreadsheetId,
          requestBody: { valueInputOption: 'RAW', data: batchData },
        });
        log(`${tabName}: updated ${updatedRows} row(s), appended ${newRowObjs.length} row(s)`);
      }
      if (formulaData.length > 0) {
        await sheets.spreadsheets.values.batchUpdate({
          spreadsheetId,
          requestBody: { valueInputOption: 'USER_ENTERED', data: formulaData },
        });
      }

      // Apply formatting, sort, conditional colours, and dropdown validation
      const sheetId   = tabIdMap.get(tabName);
      const totalRows = existingVals.length + newRowObjs.length;
      // Sort/format up to col X (covers Status at col V) — don't go past AO
      const numCols   = Math.max(SHEET_HEADERS.length, (colIdx['Status'] ?? 0) + 1);
      if (sheetId != null) {
        try {
          const formatRequests = [
            // Center align all cells in the entire sheet
            {
              repeatCell: {
                range: { sheetId, startRowIndex: 0, startColumnIndex: 0, endColumnIndex: numCols },
                cell: { userEnteredFormat: { horizontalAlignment: 'CENTER' } },
                fields: 'userEnteredFormat.horizontalAlignment',
              },
            },
            // Row 1: yellow background, bold, font size 13
            {
              repeatCell: {
                range: { sheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: numCols },
                cell: {
                  userEnteredFormat: {
                    backgroundColor: { red: 1, green: 1, blue: 0 },
                    textFormat: { bold: true, fontSize: 13 },
                  },
                },
                fields: 'userEnteredFormat.backgroundColor,userEnteredFormat.textFormat.bold,userEnteredFormat.textFormat.fontSize',
              },
            },
            // Unmerge rows 1 and 2 entirely before re-merging — prevents "must select all cells
            // in a merged range" errors caused by auto-inserted columns shifting existing merges.
            { unmergeCells: { range: { sheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: 50 } } },
            { unmergeCells: { range: { sheetId, startRowIndex: 1, endRowIndex: 2, startColumnIndex: 0, endColumnIndex: 50 } } },
            // Merge A1:I1 for account name
            { mergeCells: { range: { sheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: 9 }, mergeType: 'MERGE_ALL' } },
            // Merge W1:X1 for "Total Dispatch: N" counter (W=ROI%=22, X=Status=23, endIndex exclusive=24)
            { mergeCells: { range: { sheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 22, endColumnIndex: 24 }, mergeType: 'MERGE_ALL' } },
            // Merge A2:I2 for "Selling Details"
            { mergeCells: { range: { sheetId, startRowIndex: 1, endRowIndex: 2, startColumnIndex: 0, endColumnIndex: 9 }, mergeType: 'MERGE_ALL' } },
            // Merge K2:U2 for "Selling Details / Profit" (endColumnIndex 21 = exclusive, covers K–U)
            { mergeCells: { range: { sheetId, startRowIndex: 1, endRowIndex: 2, startColumnIndex: 10, endColumnIndex: 21 }, mergeType: 'MERGE_ALL' } },
            // Data rows (row 4+): white background, not bold
            {
              repeatCell: {
                range: { sheetId, startRowIndex: 3, startColumnIndex: 0, endColumnIndex: numCols },
                cell: {
                  userEnteredFormat: {
                    backgroundColor: { red: 1, green: 1, blue: 1 },
                    textFormat: { bold: false },
                  },
                },
                fields: 'userEnteredFormat.backgroundColor,userEnteredFormat.textFormat.bold',
              },
            },
            // Row 2 (Selling Details / Profit header): #B5D7A8 background, bold
            {
              repeatCell: {
                range: { sheetId, startRowIndex: 1, endRowIndex: 2, startColumnIndex: 0, endColumnIndex: numCols },
                cell: {
                  userEnteredFormat: {
                    backgroundColor: { red: 181 / 255, green: 215 / 255, blue: 168 / 255 },
                    textFormat: { bold: true },
                  },
                },
                fields: 'userEnteredFormat.backgroundColor,userEnteredFormat.textFormat.bold',
              },
            },
            // Row 3 (column header row): #B5D7A8 background, bold
            {
              repeatCell: {
                range: { sheetId, startRowIndex: 2, endRowIndex: 3, startColumnIndex: 0, endColumnIndex: numCols },
                cell: {
                  userEnteredFormat: {
                    backgroundColor: { red: 181 / 255, green: 215 / 255, blue: 168 / 255 },
                    textFormat: { bold: true },
                  },
                },
                fields: 'userEnteredFormat.backgroundColor,userEnteredFormat.textFormat.bold',
              },
            },
            // Yellow separator column J (index 9) — all rows
            {
              repeatCell: {
                range: { sheetId, startColumnIndex: 9, endColumnIndex: 10 },
                cell: { userEnteredFormat: { backgroundColor: { red: 1, green: 1, blue: 0 } } },
                fields: 'userEnteredFormat.backgroundColor',
              },
            },
            // Yellow separator column V (index 21) — all rows
            {
              repeatCell: {
                range: { sheetId, startColumnIndex: 21, endColumnIndex: 22 },
                cell: { userEnteredFormat: { backgroundColor: { red: 1, green: 1, blue: 0 } } },
                fields: 'userEnteredFormat.backgroundColor',
              },
            },
            // Column C (Customer Details, index 2): clip text wrap for data rows
            {
              repeatCell: {
                range: { sheetId, startRowIndex: 3, startColumnIndex: 2, endColumnIndex: 3 },
                cell: { userEnteredFormat: { wrapStrategy: 'CLIP' } },
                fields: 'userEnteredFormat.wrapStrategy',
              },
            },
            // Column I (Onbuy Link, index 8): clip text wrap for data rows
            {
              repeatCell: {
                range: { sheetId, startRowIndex: 3, startColumnIndex: 8, endColumnIndex: 9 },
                cell: { userEnteredFormat: { wrapStrategy: 'CLIP' } },
                fields: 'userEnteredFormat.wrapStrategy',
              },
            },
            // Column J (index 9): minimal width separator
            {
              updateDimensionProperties: {
                range: { sheetId, dimension: 'COLUMNS', startIndex: 9, endIndex: 10 },
                properties: { pixelSize: 20 },
                fields: 'pixelSize',
              },
            },
            // Column V (index 21): minimal width separator
            {
              updateDimensionProperties: {
                range: { sheetId, dimension: 'COLUMNS', startIndex: 21, endIndex: 22 },
                properties: { pixelSize: 20 },
                fields: 'pixelSize',
              },
            },
          ];

          // Column A (Order Date) data rows: display serial numbers as "10 June 2026"
          formatRequests.push({
            repeatCell: {
              range: { sheetId, startRowIndex: 3, startColumnIndex: 0, endColumnIndex: 1 },
              cell: { userEnteredFormat: { numberFormat: { type: 'DATE', pattern: 'D MMMM YYYY' } } },
              fields: 'userEnteredFormat.numberFormat',
            },
          });

          // Sort data rows (row 4+) by Order Date (col A) ascending
          if (totalRows > 3) {
            formatRequests.push({
              sortRange: {
                range: {
                  sheetId,
                  startRowIndex: 3,
                  endRowIndex: totalRows,
                  startColumnIndex: 0,
                  endColumnIndex: numCols,
                },
                sortSpecs: [{ dimensionIndex: 0, sortOrder: 'ASCENDING' }],
              },
            });
          }

          // Conditional colour rules for Status column — only add once
          const statusColIdx  = colIdx['Status'];
          const sheetMeta     = (meta.sheets ?? []).find(s => s.properties?.sheetId === sheetId);
          const hasStatusRules = statusColIdx != null && (sheetMeta?.conditionalFormats ?? []).some(cf =>
            cf.ranges?.some(r => r.startColumnIndex === statusColIdx)
          );
          if (!hasStatusRules && statusColIdx != null) {
            const STATUS_CF = [
              { text: 'Awaiting Dispatch',    bg: { red: 1,     green: 0.757, blue: 0.027 }, fg: { red: 0.15, green: 0.10, blue: 0    } },
              { text: 'Dispatched',           bg: { red: 0.204, green: 0.780, blue: 0.349 }, fg: { red: 1,    green: 1,    blue: 1    } },
              { text: 'Complete',             bg: { red: 0.133, green: 0.545, blue: 0.133 }, fg: { red: 1,    green: 1,    blue: 1    } },
              { text: 'Cancelled',            bg: { red: 0.957, green: 0.263, blue: 0.212 }, fg: { red: 1,    green: 1,    blue: 1    } },
              { text: 'Cancelled By Seller',  bg: { red: 0.957, green: 0.263, blue: 0.212 }, fg: { red: 1,    green: 1,    blue: 1    } },
              { text: 'Cancelled By Buyer',   bg: { red: 0.957, green: 0.263, blue: 0.212 }, fg: { red: 1,    green: 1,    blue: 1    } },
              { text: 'Partially Dispatched', bg: { red: 0.012, green: 0.663, blue: 0.957 }, fg: { red: 1,    green: 1,    blue: 1    } },
              { text: 'Partially Refunded',   bg: { red: 1,     green: 0.600, blue: 0      }, fg: { red: 0.15, green: 0.10, blue: 0    } },
              { text: 'Refunded',             bg: { red: 0.600, green: 0.400, blue: 0.800 }, fg: { red: 1,    green: 1,    blue: 1    } },
            ];
            for (const sc of STATUS_CF) {
              formatRequests.push({
                addConditionalFormatRule: {
                  rule: {
                    ranges: [{ sheetId, startRowIndex: 3, startColumnIndex: statusColIdx, endColumnIndex: statusColIdx + 1 }],
                    booleanRule: {
                      condition: { type: 'TEXT_EQ', values: [{ userEnteredValue: sc.text }] },
                      format: {
                        backgroundColor: sc.bg,
                        textFormat: { bold: true, foregroundColor: sc.fg },
                      },
                    },
                  },
                  index: 0,
                },
              });
            }
          }

          await sheets.spreadsheets.batchUpdate({
            spreadsheetId,
            requestBody: { requests: formatRequests },
          });

          // Dropdown validation for Courier Name and Status (rows 4+)
          const COURIER_OPTIONS = ['Royal Mail', 'Amazon', 'Evri', 'Swiship Uk', 'SG Air', 'yodel', 'China Post', 'GIS', 'DPD', 'Other'];
          const STATUS_OPTIONS  = ['Awaiting Dispatch', 'Dispatched', 'Partially Dispatched', 'Complete', 'Cancelled', 'Cancelled By Seller', 'Cancelled By Buyer', 'Partially Refunded', 'Refunded'];
          const dvRequests = [];
          const courierColIdx = colIdx['Courier Name'];
          if (courierColIdx != null) {
            dvRequests.push({
              setDataValidation: {
                range: { sheetId, startRowIndex: 3, endRowIndex: 1000, startColumnIndex: courierColIdx, endColumnIndex: courierColIdx + 1 },
                rule: { condition: { type: 'ONE_OF_LIST', values: COURIER_OPTIONS.map(v => ({ userEnteredValue: v })) }, showCustomUi: true, strict: false },
              },
            });
          }
          if (statusColIdx != null) {
            dvRequests.push({
              setDataValidation: {
                range: { sheetId, startRowIndex: 3, endRowIndex: 1000, startColumnIndex: statusColIdx, endColumnIndex: statusColIdx + 1 },
                rule: { condition: { type: 'ONE_OF_LIST', values: STATUS_OPTIONS.map(v => ({ userEnteredValue: v })) }, showCustomUi: true, strict: false },
              },
            });
          }
          if (dvRequests.length > 0) {
            await sheets.spreadsheets.batchUpdate({
              spreadsheetId,
              requestBody: { requests: dvRequests },
            });
          }
        } catch (e) {
          log(`Sheet format error: ${e.message}`);
        }
      }
    } catch (e) {
      log(`Sheet error on tab "${tabName}": ${e.message}`);
    }
  }
}

// ── Dispatch orders that have a tracking number in the Google Sheet ───────────
async function dispatchPendingOrders(db, account, token, log) {
  if (!account.google_sheet_id || !account.google_service_account) return;

  let creds;
  try {
    creds = typeof account.google_service_account === 'string'
      ? JSON.parse(account.google_service_account) : account.google_service_account;
  } catch { return; }

  const auth   = new google.auth.GoogleAuth({ credentials: creds, scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
  const sheets = google.sheets({ version: 'v4', auth });
  const spreadsheetId = account.google_sheet_id;

  // Only dispatch orders from the current month's tab
  const currentTab = monthTabName();
  let tabNames;
  try {
    const meta   = (await sheets.spreadsheets.get({ spreadsheetId })).data;
    const allTabs = (meta.sheets ?? []).map(s => s.properties.title);
    tabNames = allTabs.filter(t => t === currentTab);
  } catch (e) {
    log(`Dispatch: could not read sheet: ${e.message}`);
    return;
  }

  if (tabNames.length === 0) {
    log(`Dispatch: no tab found for ${currentTab}`);
    return;
  }

  // Scan current month tab — find rows where Tracking Number and Courier Name are filled
  const trackingMap = new Map();
  for (const tab of tabNames) {
    try {
      const { data } = await sheets.spreadsheets.values.get({
        spreadsheetId, range: `'${tab}'!A:Z`,
      });
      const rows = data.values ?? [];
      if (rows.length < 2) continue;

      // Build header→index map from first 3 rows (Status in row 2, col headers in row 3)
      const hIdx = {};
      for (let r = 0; r < Math.min(3, rows.length); r++) {
        (rows[r] ?? []).forEach((h, i) => {
          const key = String(h).trim();
          if (key && !(key in hIdx)) hIdx[key] = i;
        });
      }
      const oidCol  = hIdx['Order No'] ?? 1;
      const trkCol  = hIdx['Tracking'];
      const crcol   = hIdx['Courier Name'];
      const statCol = hIdx['Status'];
      if (trkCol == null || crcol == null) continue;

      // Data starts at row 4 (index 3)
      for (let i = 3; i < rows.length; i++) {
        const row       = rows[i];
        const orderId   = row[oidCol]?.trim()                              ?? '';
        const tracking  = row[trkCol]?.trim()                              ?? '';
        const courier   = row[crcol]?.trim()                               ?? '';
        const statusVal = statCol != null ? (row[statCol]?.trim() ?? '') : '';
        if (orderId && tracking && courier && statusVal === 'Awaiting Dispatch' && !trackingMap.has(orderId)) {
          trackingMap.set(orderId, { tracking, courier });
        }
      }
    } catch (e) {
      log(`Dispatch: error reading tab "${tab}": ${e.message}`);
    }
  }

  if (trackingMap.size === 0) return;

  // Skip orders already dispatched (by OnBuy status or by our previous dispatch call)
  const allIds = [...trackingMap.keys()];
  const { rows: done } = await db.query(
    `SELECT order_id FROM onbuy_orders
     WHERE account_id = $1 AND order_id = ANY($2)
       AND (is_dispatched = true OR status IN ('dispatched', 'complete', 'cancelled'))`,
    [account.id, allIds]
  );
  const dispatched = new Set(done.map(r => r.order_id));
  const pending    = allIds.filter(id => !dispatched.has(id));

  if (pending.length === 0) {
    log('Dispatch: all tracked orders already dispatched');
    return;
  }

  log(`Dispatch: ${pending.length} tracked+awaiting order(s) to dispatch`);

  // Build dispatch payload
  const orders = pending.map(orderId => {
    const { tracking, courier } = trackingMap.get(orderId);
    return {
      order_id: orderId,
      tracking: { supplier_name: courier, number: tracking },
    };
  });

  log(`Dispatching ${orders.length} order(s)…`);
  const r = await fetch('https://api.onbuy.com/v2/orders/dispatch', {
    method:  'PUT',
    headers: { Authorization: token, 'Content-Type': 'application/json' },
    body:    JSON.stringify({ site_id: parseInt(account.site_id || '2000'), orders }),
  });
  const raw = await r.text();

  if (!r.ok) {
    log(`Dispatch API error (${r.status}): ${raw.slice(0, 300)}`);
    return;
  }
  log(`Dispatch API → ${r.status}: ${raw.slice(0, 200)}`);

  // Mark as dispatched in DB
  for (const orderId of pending) {
    await db.query(
      `UPDATE onbuy_orders SET is_dispatched = true, status = 'dispatched'
       WHERE account_id = $1 AND order_id = $2`,
      [account.id, orderId]
    ).catch(() => {});
  }
  log(`Marked ${pending.length} order(s) as dispatched in DB`);

  // Update Status column in the sheet for dispatched orders (use header-title lookup)
  const dispatchedSet = new Set(pending);
  for (const tab of tabNames) {
    try {
      const { data: tabData } = await sheets.spreadsheets.values.get({
        spreadsheetId, range: `'${tab}'!A:Z`,
      });
      const tabRows = tabData.values ?? [];
      if (tabRows.length < 2) continue;

      // Scan first 3 rows for headers (Status is in row 2, Order No in row 3)
      const tHIdx = {};
      for (let r = 0; r < Math.min(3, tabRows.length); r++) {
        (tabRows[r] ?? []).forEach((h, i) => {
          const key = String(h).trim();
          if (key && !(key in tHIdx)) tHIdx[key] = i;
        });
      }
      const stOidCol  = tHIdx['Order No'] ?? 1;
      const stStatCol = tHIdx['Status'];
      if (stStatCol == null) continue;

      const statusColLetter = colIdxToLetter(stStatCol);
      const statusUpdates   = [];
      // Data starts at row 4 (index 3)
      for (let i = 3; i < tabRows.length; i++) {
        const orderId = tabRows[i][stOidCol]?.trim() ?? '';
        if (dispatchedSet.has(orderId)) {
          statusUpdates.push({ range: `'${tab}'!${statusColLetter}${i + 1}`, values: [['Dispatched']] });
        }
      }
      if (statusUpdates.length > 0) {
        await sheets.spreadsheets.values.batchUpdate({
          spreadsheetId,
          requestBody: { valueInputOption: 'RAW', data: statusUpdates },
        });
        log(`Updated Status to Dispatched for ${statusUpdates.length} row(s) in tab "${tab}"`);
      }
    } catch (e) {
      log(`Dispatch: error updating sheet status in tab "${tab}": ${e.message}`);
    }
  }
}

// ── Sync one account ──────────────────────────────────────────────────────────
// fullSync=true fetches the full current month (manual trigger / first run).
// fullSync=false (default) fetches only orders modified in the last 25 min (cron runs) to stay within API rate limits.
async function syncAccount(db, account, { fullSync = false } = {}) {
  const log = makeLogger(account.account_name);
  try {
    log(`Starting sync (${fullSync ? 'full month' : 'incremental 25 min'})`);
    const token  = await getOnBuyToken(account);
    const orders = await fetchAllOrders(token, account.site_id || '2000', fullSync ? null : 25);
    log(`API: ${orders.length} orders fetched`);

    const { inserted, updated } = await upsertOrders(db, account, orders);
    log(`DB: ${inserted} inserted, ${updated} updated`);

    log('Enriching line items (product URLs, ASINs, prices)...');
    const enrichmentMap = await enrichOrderItems(db, account, token, orders);
    log(`Enriched ${Object.keys(enrichmentMap).length} item(s)`);

    if (account.google_sheet_id && account.google_service_account) {
      log('Syncing to Google Sheets...');
      const currentTab = monthTabName();

      // ── Compute today's dispatch count from ALL relevant DB orders ────────────
      // We always query the DB (not the recently-fetched batch) so the counter is
      // accurate even when no orders were modified in the last 25 minutes.
      const todayStr = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' }).format(new Date());
      const [todayY, todayM, todayD] = todayStr.split('-').map(Number);

      // Start from the first day of the current month
      let dispatchFromDate = `${todayY}-${String(todayM).padStart(2, '0')}-01 00:00:00`;

      // If we're in the first 5 days, also look at the last 10 days of the previous month
      // (an order placed on e.g. 29 May could have an expected_dispatch_date of 3 June)
      if (todayD <= 5) {
        const lastDayOfPrev = new Date(todayY, todayM - 1, 0); // day 0 of current month = last day of prev
        const py  = lastDayOfPrev.getFullYear();
        const pm  = lastDayOfPrev.getMonth() + 1;
        const pd  = lastDayOfPrev.getDate();
        const sd  = Math.max(1, pd - 9); // 10 days back from end of prev month
        dispatchFromDate = `${py}-${String(pm).padStart(2, '0')}-${String(sd).padStart(2, '0')} 00:00:00`;
      }

      const { rows: allDispatchOrders } = await db.query(
        `SELECT order_id, status, is_dispatched, raw_data
         FROM onbuy_orders WHERE account_id = $1 AND order_date >= $2`,
        [account.id, dispatchFromDate]
      );

      const seenDispIds = new Set();
      const dispIds     = [];
      for (const order of allDispatchOrders) {
        if (seenDispIds.has(order.order_id)) continue;
        seenDispIds.add(order.order_id);
        const rawData = typeof order.raw_data === 'string' ? JSON.parse(order.raw_data) : (order.raw_data ?? {});
        if (rawData.dispatched || order.is_dispatched) continue;
        if ((rawData.status ?? order.status ?? '') !== 'Awaiting Dispatch') continue;
        const products = Array.isArray(rawData.products) ? rawData.products : [];
        if (products.some(p => (p.expected_dispatch_date ?? '').toString().startsWith(todayStr))) {
          dispIds.push(order.order_id);
        }
      }
      const todayDispatchCount = dispIds.length;
      log(`Today dispatch orders (${todayDispatchCount}): ${dispIds.join(', ') || 'none'}`);

      // ── Sheet row sync — only for recently-fetched orders ─────────────────────
      const monthIds = orders.filter(o => tabForOrder(o) === currentTab).map(o => o.order_id);
      let dbRows = [];
      if (monthIds.length > 0) {
        const { rows } = await db.query(
          `SELECT * FROM onbuy_orders WHERE account_id = $1 AND order_id = ANY($2)`,
          [account.id, monthIds]
        );
        dbRows = rows;
      } else {
        log(`No recent orders for current tab (${currentTab}) — only updating dispatch counter`);
      }

      // Always call syncToGoogleSheet so the dispatch counter in V1 is kept current
      // even on quiet periods when no orders have been modified recently.
      await syncToGoogleSheet(account, dbRows, enrichmentMap, log, todayDispatchCount);
      log('Google Sheets sync done');
      await dispatchPendingOrders(db, account, token, log);
    }
    log('Sync complete');
  } catch (e) {
    makeLogger(account.account_name)(`ERROR: ${e.message}`);
  }
}

// ── Sync all active accounts (scheduled cron run) ────────────────────────────
async function syncAllAccounts(db) {
  let accounts;
  try {
    const { rows } = await db.query(
      `SELECT * FROM onbuy_accounts WHERE is_active = true AND google_sheet_id IS NOT NULL AND google_sheet_id <> '' ORDER BY id`
    );
    accounts = rows;
  } catch (e) {
    console.error('[OrdersJob] DB error fetching accounts:', e.message);
    return;
  }
  console.log(`[OrdersJob] Running sync for ${accounts.length} account(s)`);
  for (const account of accounts) {
    await syncAccount(db, account);
  }
  console.log('[OrdersJob] Done');
}

// ── Exported: per-user manual trigger (called by server.js API endpoint) ──────
export async function syncAccountsForUser(db, userId) {
  let accounts;
  try {
    const { rows } = await db.query(
      `SELECT * FROM onbuy_accounts WHERE user_id = $1 AND is_active = true AND google_sheet_id IS NOT NULL AND google_sheet_id <> '' ORDER BY id`,
      [userId]
    );
    accounts = rows;
  } catch (e) {
    console.error('[OrdersJob] DB error fetching user accounts:', e.message);
    return;
  }
  console.log(`[OrdersJob] Manual sync for user ${userId}: ${accounts.length} account(s)`);
  for (const account of accounts) {
    await syncAccount(db, account, { fullSync: true });
  }
  console.log(`[OrdersJob] Manual sync done for user ${userId}`);
}

// ── Called by ordersWorker.js (PM2 entry point) and direct node execution ──────
export function startWorker() {
  const db = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  });

  db.query(`ALTER TABLE onbuy_orders ADD COLUMN IF NOT EXISTS is_dispatched BOOLEAN NOT NULL DEFAULT false`)
    .catch(() => {});

  const redisSub = new IORedis(process.env.REDIS_URL || 'redis://127.0.0.1:6379', {
    maxRetriesPerRequest: null,
  });
  redisSub.subscribe('orders:sync').catch(() => {});
  redisSub.on('message', (channel, message) => {
    if (channel !== 'orders:sync') return;
    const userId = parseInt(message);
    if (!userId) return;
    console.log(`[OrdersJob] Manual sync triggered for user ${userId}`);
    syncAccountsForUser(db, userId).catch(e => console.error('[OrdersJob] Manual sync error:', e));
  });

  console.log('[OrdersJob] Started — syncing every 15 minutes');
  cron.schedule('*/15 * * * *', () => {
    console.log('[OrdersJob] ⏰ Scheduled run');
    syncAllAccounts(db).catch(e => console.error('[OrdersJob] Run error:', e));
  });
}

// Allow direct execution: node ordersJob.js
const _thisFile = resolve(fileURLToPath(import.meta.url));
const _mainFile = process.argv[1] ? resolve(process.argv[1]) : '';
if (_thisFile === _mainFile) startWorker();
