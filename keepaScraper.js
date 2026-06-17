/**
 * keepaScraper.js
 * ─────────────────────────────────────────────────────────────
 * Keepa Product Viewer automation via Puppeteer.
 *
 * Logs in to keepa.com, loads batches of up to 1 000 ASINs
 * via the Product Viewer page, exports a CSV, and returns a
 * price map for every ASIN.
 *
 * Keepa Pro (€29/mo) allows ≈36 000 products/day through the
 * Product Viewer — no API subscription required.
 *
 * Usage (single call):
 *   import { getKeepaPrice } from './keepaScraper.js';
 *   const prices = await getKeepaPrice(asinArray, { email, password, log });
 *
 * Usage (session — reuses browser across sub-batches, no re-login):
 *   import { createKeepaSession } from './keepaScraper.js';
 *   const session = await createKeepaSession(email, password, log);
 *   try {
 *     for (const chunk of chunks) {
 *       const prices = await session.scrape(chunk);
 *       // flush prices, decrement counter, etc.
 *     }
 *   } finally {
 *     await session.close();
 *   }
 */

import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import fs from 'fs';
import path from 'path';
import os from 'os';

puppeteer.use(StealthPlugin());

const KEEPA_HOME   = 'https://keepa.com/#!';
const KEEPA_VIEWER = 'https://keepa.com/#!viewer';
const BATCH_SIZE   = 1700;

const _sleep = ms => new Promise(r => setTimeout(r, ms));

// ─────────────────────────────────────────────────────────────
// PUBLIC — session-based API
//
// Launches the browser and logs in exactly once, then returns a
// session object whose scrape() method reuses the same page.
// Saves ~15 s per sub-batch compared to relaunching the browser.
// ─────────────────────────────────────────────────────────────
export async function createKeepaSession(email, password, log = console.log) {
  if (!email || !password) throw new Error('[Keepa] email and password are required');

  const browser = await puppeteer.launch({
    headless: true,
    protocolTimeout: 300_000,
    args: [
      '--no-sandbox', '--disable-setuid-sandbox',
      '--disable-dev-shm-usage', '--window-size=1440,900',
    ],
    ...(process.env.PUPPETEER_EXECUTABLE_PATH
      ? { executablePath: process.env.PUPPETEER_EXECUTABLE_PATH }
      : {}),
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900 });
    const cdp = await page.target().createCDPSession();

    // Login and navigate to viewer exactly once
    await _login(page, email, password, log);
    log('[Keepa] Navigating to Product Viewer…');
    await page.goto(KEEPA_VIEWER, { waitUntil: 'networkidle2', timeout: 60_000 });
    await _sleep(2000);

    let firstBatch = true;
    return {
      async checkQuota() {
        return _readQuotaPercent(page, log);
      },
      async scrape(asins) {
        if (!asins?.length) return {};
        // After the first batch Keepa hides the ASIN input panel (the results grid
        // takes over). Reloading the viewer page resets to the clean input state
        // without triggering a new login — the session cookie is still valid.
        if (!firstBatch) {
          log('[Keepa] Reloading viewer to reset input panel…');
          await page.goto(KEEPA_VIEWER, { waitUntil: 'networkidle2', timeout: 60_000 });
          await _sleep(1500);
        }
        firstBatch = false;
        // Fresh temp dir per call so concurrent downloads never collide
        const dlDir = fs.mkdtempSync(path.join(os.tmpdir(), 'keepa-'));
        try {
          await cdp.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: dlDir });
          return await _scrapeOnPage(page, dlDir, asins, log);
        } finally {
          try { fs.rmSync(dlDir, { recursive: true, force: true }); } catch {}
        }
      },
      async close() {
        await browser.close().catch(() => {});
      },
    };
  } catch (err) {
    await browser.close().catch(() => {});
    throw err;
  }
}

// ─────────────────────────────────────────────────────────────
// PUBLIC — convenience wrapper (opens a session, runs all
// batches, closes the session).
// Returns { [asin]: { price, source, inStock } }
// ─────────────────────────────────────────────────────────────
export async function getKeepaPrice(asins, { email, password, log = console.log } = {}) {
  if (!email || !password) throw new Error('[Keepa] email and password are required');
  if (!asins?.length)      return {};

  const batches = [];
  for (let i = 0; i < asins.length; i += BATCH_SIZE)
    batches.push(asins.slice(i, i + BATCH_SIZE));

  log(`[Keepa] ${asins.length} ASINs → ${batches.length} batch(es) of ≤${BATCH_SIZE}`);

  const session = await createKeepaSession(email, password, log);
  const results = {};
  try {
    // Check quota before any scraping.
    // At exactly 5% quota = 1,800 tokens = one full batch → allow it through.
    // Below 5% = not enough for a full batch → defer and wait for the hourly refill.
    const quotaPct = await session.checkQuota();
    if (quotaPct !== null && quotaPct < 5) {
      const err = new Error('KEEPA_QUOTA_EXHAUSTED');
      err.quota = quotaPct;
      throw err;
    }

    for (let bi = 0; bi < batches.length; bi++) {
      log(`[Keepa] Batch ${bi + 1}/${batches.length} — ${batches[bi].length} ASINs`);
      try {
        const batchResult = await session.scrape(batches[bi]);
        Object.assign(results, batchResult);
        const found = Object.values(batchResult).filter(r => r.price !== null).length;
        log(`[Keepa] Batch ${bi + 1} done — ${found}/${batches[bi].length} prices found`);
      } catch (err) {
        if (err.message === 'KEEPA_QUOTA_EXHAUSTED') throw err;
        if (err.message === 'KEEPA_BATCH_TIMEOUT')   throw err;
        log(`[Keepa] Batch ${bi + 1} error: ${err.message}`);
      }
      if (bi < batches.length - 1) await _sleep(5000);
    }
  } finally {
    await session.close();
  }

  const total = Object.values(results).filter(r => r.price !== null).length;
  log(`[Keepa] Complete — ${total}/${asins.length} prices retrieved`);
  return results;
}

// ─────────────────────────────────────────────────────────────
// Read the quota % from the Keepa nav widget.
// The widget loads asynchronously on the SPA, so we wait for it
// and fall back to a full-page text scan if the ID selector fails.
// Returns the numeric percentage or null if unreadable.
// ─────────────────────────────────────────────────────────────
async function _readQuotaPercent(page, log) {
  // Wait up to 8 s for the quota widget to render
  try {
    await page.waitForSelector('#widget_bucket_quota', { timeout: 8_000 });
  } catch { /* widget may not exist on all account types */ }

  // Primary selector: #widget_bucket_quota .bucket-quota__caption → "Quota: 78%"
  try {
    const text = await page.$eval(
      '#widget_bucket_quota .bucket-quota__caption',
      el => el.textContent.trim()
    );
    const m = text.match(/(\d+(?:\.\d+)?)\s*%/);
    if (m) {
      const pct = parseFloat(m[1]);
      log(`[Keepa] Quota: ${pct}%`);
      return pct;
    }
  } catch { /* selector not matched — try fallback */ }

  // Fallback: scan all text nodes for "Quota: N%"
  try {
    const pct = await page.evaluate(() => {
      for (const el of document.querySelectorAll('span, div, p')) {
        const t = el.childNodes.length === 1 && el.childNodes[0].nodeType === 3
          ? el.textContent.trim()
          : '';
        if (!t.startsWith('Quota:')) continue;
        const m = t.match(/(\d+(?:\.\d+)?)\s*%/);
        if (m) return parseFloat(m[1]);
      }
      return null;
    });
    if (pct !== null) {
      log(`[Keepa] Quota (fallback scan): ${pct}%`);
      return pct;
    }
  } catch { /* ignore */ }

  log('[Keepa] Quota widget not found — proceeding without quota check');
  return null;
}

// ─────────────────────────────────────────────────────────────
// Dismiss any modal left open after the previous export so the
// viewer input is accessible for the next sub-batch injection.
// ─────────────────────────────────────────────────────────────
async function _dismissExportDialog(page) {
  await page.evaluate(() => {
    for (const sel of [
      '#exportModal .closeButton', '#exportModal .close',
      '#exportModal [data-dismiss]', '.modal.in .close',
      '.modal.in .closeButton',     '.modal-header .close',
      '[aria-label="Close"]',
    ]) {
      const el = document.querySelector(sel);
      if (el) { el.click(); return; }
    }
  }).catch(() => {});
  await page.keyboard.press('Escape').catch(() => {});
  await _sleep(300);
}

// ─────────────────────────────────────────────────────────────
// Core per-batch page work: dismiss dialog → inject ASINs →
// LOAD LIST → wait for grid → export CSV → parse.
// Called once per session.scrape() invocation on the same page.
// ─────────────────────────────────────────────────────────────
async function _scrapeOnPage(page, dlDir, asins, log) {
  // ── 1. Inject ASINs into the input field ─────────────────────────────────
  log(`[Keepa] Injecting ${asins.length} ASINs into Product Viewer…`);
  await page.waitForSelector('#importInputAsin', { timeout: 15_000 });

  // Native value-setter so any JS binding on the field fires correctly
  await page.evaluate((asinText) => {
    const el = document.querySelector('#importInputAsin');
    if (!el) return;
    const proto = el.tagName === 'TEXTAREA'
      ? window.HTMLTextAreaElement.prototype
      : window.HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (setter) setter.call(el, asinText); else el.value = asinText;
    el.dispatchEvent(new Event('input',  { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }, asins.join(' '));
  await _sleep(400);

  // File upload fallback if direct injection leaves the field empty
  const fieldAfterInject = await page.$eval('#importInputAsin', el => el.value.trim().slice(0, 20)).catch(() => '');
  if (!fieldAfterInject) {
    log('[Keepa] Direct inject did not populate field — trying file upload fallback…');
    const asinFile = path.join(dlDir, 'asins.txt');
    fs.writeFileSync(asinFile, asins.join(' '));
    const fileInput = await page.$('#fileInputWrap input[type="file"]');
    if (fileInput) {
      await fileInput.uploadFile(asinFile);
      await page.waitForFunction(
        () => (document.querySelector('#importInputAsin')?.value?.trim().length ?? 0) > 0,
        { timeout: 8_000 }
      ).catch(() => log('[Keepa] File upload did not populate field either — proceeding anyway'));
    }
  }

  const { registeredPreview, registeredCount } = await page.$eval('#importInputAsin', el => {
    const val = el.value.trim();
    return {
      registeredPreview: val.slice(0, 120),
      registeredCount:   val.split(/\s+/).filter(a => a.length === 10).length,
    };
  }).catch(() => ({ registeredPreview: '', registeredCount: 0 }));
  log(`[Keepa] Field value after input (${registeredCount} ASINs): "${registeredPreview || '(empty)'}${registeredCount > 10 ? '…' : ''}"`);

  // ── 2. Click LOAD LIST ────────────────────────────────────────────────────
  log('[Keepa] Clicking LOAD LIST…');
  await page.waitForSelector('#importSubmit', { timeout: 10_000 });
  await page.click('#importSubmit');
  log('[Keepa] LOAD LIST clicked — waiting for table…');

  // ── 3. Wait for product table to be ready ────────────────────────────────
  // Phase 1 — grid resets to 0 rows before re-populating
  log('[Keepa] Waiting for grid to reset…');
  await page.waitForFunction(() => {
    const c = document.querySelector('.ag-center-cols-container');
    return !c || c.querySelectorAll('.ag-row[role="row"]').length === 0;
  }, { timeout: 15_000, polling: 500 }).catch(() => {});

  // Phase 2 — wait for Keepa to populate the AG Grid
  log('[Keepa] Waiting for product rows to appear…');
  const readySignal = await page.waitForFunction(() => {
    const c = document.querySelector('.ag-center-cols-container');
    if (!c) return false;
    const rows = c.querySelectorAll('.ag-row[role="row"]');
    return rows.length > 0 ? `ag-rows:${rows.length}` : false;
  }, { timeout: 300_000, polling: 3000 }).catch(() => null);

  if (readySignal) {
    const signal = await readySignal.jsonValue().catch(() => '?');
    log(`[Keepa] Table ready (signal: ${signal})`);
    await _sleep(2000);
  } else {
    log('[Keepa] Timeout — no data rows appeared after 5 min; retrying via caller');
    throw Object.assign(new Error('KEEPA_BATCH_TIMEOUT'), { isTimeout: true });
  }

  // ── 4. Open the Export dialog ─────────────────────────────────────────────
  log('[Keepa] Opening export dialog...');
  const exportTriggerSel = await page.evaluate(() => {
    const tryInScope = (root) => {
      for (const sel of ['.tool__export .trigger', '.tool_export .trigger',
                         '.tool__export span',    '.tool_export span']) {
        const el = root.querySelector(sel);
        if (el) { el.click(); return sel; }
      }
      const all = [...root.querySelectorAll('span, a, button')];
      const btn = all.find(e => /^\s*Export\s*$/i.test(e.textContent.trim()) && e.offsetParent);
      if (btn) { btn.click(); return 'text:' + btn.className; }
      const expContainer = root.querySelector('[class*="export"]');
      if (expContainer) { expContainer.click(); return 'container:' + expContainer.className; }
      return null;
    };

    const toolbar = document.querySelector('#grid-tools-viewer');
    if (toolbar) {
      const found = tryInScope(toolbar);
      if (found) return found;
    }

    const all = [...document.querySelectorAll('span, button, a, div')];
    const btn = all.find(e =>
      /^\s*(Export|CSV)\s*$/i.test(e.textContent?.trim()) && e.offsetParent !== null
    );
    if (btn) { btn.click(); return 'global:' + (btn.id || btn.className).slice(0, 40); }

    return null;
  });
  if (!exportTriggerSel) throw new Error('Export toolbar button not found anywhere on page');
  log('[Keepa] Export trigger: ' + exportTriggerSel);

  await page.waitForFunction(
    () => !!document.querySelector('#exportSubmit'),
    { timeout: 15_000 }
  );
  await _sleep(500);

  // ── 5. Select "All active columns", set CSV format, uncheck currency symbols ─
  await page.evaluate(() => {
    // Ensure "All active columns" is selected (not "Only ASINs")
    const allCols = document.querySelector('#allCh-radio');
    if (allCols && !allCols.checked) allCols.click();
    const csv = document.querySelector('#csv-radio');
    if (csv && !csv.checked) csv.click();
    const sym = document.querySelector('#exportSymbols-checkbox');
    if (sym && sym.checked) sym.click();
  });
  await _sleep(300);

  // ── 6. Click EXPORT ───────────────────────────────────────────────────────
  log('[Keepa] Exporting CSV...');
  await page.click('#exportSubmit');

  // ── 7. Wait for the file to land ──────────────────────────────────────────
  log('[Keepa] Waiting for CSV download…');
  const csvPath = await _waitForFile(dlDir, '.csv', 90_000);
  log(`[Keepa] Downloaded: ${path.basename(csvPath)}`);

  return _parseCSV(csvPath, log);
}

// ─────────────────────────────────────────────────────────────
// Login  (skips if the session is already active)
//
// Keepa DOM (confirmed from page snapshot):
//   Trigger : #panelUserRegisterLogin  (span, always visible in nav)
//   Overlay : #loginOverlay            (div, display:none until trigger clicked)
//   Username: #username                (type="text", name="username")
//   Password: #password                (type="password", name="password")
//   Submit  : #submitLogin             (type="submit")
//   Logged-in indicator: #panelUserMenu visible / #panelUserRegisterLogin hidden
// ─────────────────────────────────────────────────────────────
async function _login(page, email, password, log) {
  log('[Keepa] Checking login status…');

  await page.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
  );

  await page.goto(KEEPA_HOME, { waitUntil: 'networkidle2', timeout: 30_000 });
  await _sleep(4000);

  if (await _isLoggedIn(page)) { log('[Keepa] Already logged in'); return; }

  // ── Open the login overlay ────────────────────────────────────────────────
  log('[Keepa] Clicking login trigger (#panelUserRegisterLogin)…');
  await page.waitForSelector('#panelUserRegisterLogin', { timeout: 10_000 });

  await page.click('#panelUserRegisterLogin');
  await page.evaluate(() => {
    document.querySelector('#panelUserRegisterLogin')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
  await _sleep(1500);

  let overlayVisible = await page.evaluate(() => {
    const ov = document.querySelector('#loginOverlay');
    return ov ? ov.offsetParent !== null : false;
  });

  if (!overlayVisible) {
    log('[Keepa] Overlay not visible yet — force-showing…');
    await page.evaluate(() => {
      const ov = document.querySelector('#loginOverlay');
      if (ov) { ov.classList.remove('hidden'); ov.style.display = 'block'; }
    });
    await _sleep(500);
    overlayVisible = await page.evaluate(() => {
      const ov = document.querySelector('#loginOverlay');
      return ov ? ov.offsetParent !== null : false;
    });
  }

  if (!overlayVisible) throw new Error('Login overlay (#loginOverlay) could not be shown');
  log('[Keepa] Login overlay open');

  // ── Fill credentials ──────────────────────────────────────────────────────
  await page.evaluate((em, pw) => {
    const fill = (el, val) => {
      if (!el) return;
      el.focus();
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
      if (setter) setter.call(el, val); else el.value = val;
      ['input', 'change'].forEach(ev => el.dispatchEvent(new Event(ev, { bubbles: true })));
    };
    fill(document.querySelector('#username'), em);
    fill(document.querySelector('#password'), pw);
  }, email, password);
  await _sleep(400);

  // ── Submit ────────────────────────────────────────────────────────────────
  log('[Keepa] Submitting login form…');
  await page.click('#submitLogin');

  await page.waitForFunction(
    () => {
      const trigger = document.querySelector('#panelUserRegisterLogin');
      const menu    = document.querySelector('#panelUserMenu');
      if (trigger && trigger.style.display === 'none') return true;
      if (menu    && menu.style.display    !== 'none') return true;
      const t = (document.body?.textContent || '').toLowerCase();
      return t.includes('log out') || t.includes('logout');
    },
    { timeout: 25_000 }
  ).catch(() => log('[Keepa] Login confirmation not detected — proceeding anyway'));

  const ok = await _isLoggedIn(page);
  if (!ok) {
    const errMsg = await page.evaluate(
      () => document.querySelector('#loginError')?.textContent?.trim() || null
    );
    if (errMsg) log(`[Keepa] Login error: "${errMsg}"`);
    log('[Keepa] Warning: login may have failed — check credentials in Settings');
  } else {
    log('[Keepa] Login successful ✓');
  }
}

async function _isLoggedIn(page) {
  return page.evaluate(() => {
    const trigger = document.querySelector('#panelUserRegisterLogin');
    const menu    = document.querySelector('#panelUserMenu');
    if (trigger && trigger.style.display === 'none') return true;
    if (menu    && menu.style.display    !== 'none') return true;
    const t = (document.body?.textContent || '').toLowerCase();
    return t.includes('log out') || t.includes('logout');
  });
}

// ─────────────────────────────────────────────────────────────
// Poll the temp dir until a complete .csv file appears
// ─────────────────────────────────────────────────────────────
async function _waitForFile(dir, ext, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const files = fs.readdirSync(dir).filter(
      f => f.endsWith(ext) && !f.endsWith('.crdownload') && !f.endsWith('.tmp')
    );
    if (files.length) {
      await _sleep(500);
      return path.join(dir, files[0]);
    }
    await _sleep(1000);
  }
  throw new Error(`No ${ext} file downloaded within ${timeoutMs / 1000}s`);
}

// ─────────────────────────────────────────────────────────────
// Parse Keepa CSV  →  { [asin]: { price, source, inStock } }
//
// Price column priority:
//   "Buy Box: Current"  – what customers currently pay
//   "Amazon: Current"   – Amazon's own price
//   "New: Current"      – cheapest new 3P listing
// ─────────────────────────────────────────────────────────────
function _parseCSV(filePath, log) {
  const raw   = fs.readFileSync(filePath, 'utf-8').replace(/^﻿/, ''); // strip BOM
  const lines = raw.split('\n').map(l => l.trimEnd()).filter(Boolean);
  if (lines.length < 2) { log('[Keepa] CSV appears empty'); return {}; }

  const headers = _csvLine(lines[0]);
  const idx = h => headers.findIndex(c => c.trim() === h);
  const asinIdx  = idx('ASIN');
  const bbIdx    = idx('Buy Box: Current');
  const amzIdx   = idx('Amazon: Current');
  const newIdx   = idx('New: Current');
  const titleIdx = idx('Title');

  if (asinIdx === -1) { log('[Keepa] CSV missing ASIN column — cannot parse'); return {}; }

  const results = {};
  for (let i = 1; i < lines.length; i++) {
    const cols = _csvLine(lines[i]);
    const asin = cols[asinIdx]?.trim();
    if (!asin || asin.length !== 10) continue;

    const bb  = bbIdx  >= 0 ? _parsePrice(cols[bbIdx])  : null;
    const amz = amzIdx >= 0 ? _parsePrice(cols[amzIdx]) : null;
    const nw  = newIdx >= 0 ? _parsePrice(cols[newIdx]) : null;

    const price  = bb ?? amz ?? nw ?? null;
    const source = bb  ? 'keepa_buybox'
                 : amz ? 'keepa_amazon'
                 : nw  ? 'keepa_new'
                 : null;
    const title  = titleIdx >= 0 ? (cols[titleIdx]?.trim() || null) : null;

    results[asin] = { price, source, inStock: price !== null, title };
  }

  const withPrice = Object.values(results).filter(r => r.price !== null).length;
  log(`[Keepa] Parsed ${Object.keys(results).length} records — ${withPrice} with price`);
  return results;
}

// Strips currency symbols; returns a positive number or null
function _parsePrice(raw) {
  if (!raw || raw.trim() === '' || raw.trim() === '-') return null;
  const v = parseFloat(raw.replace(/[^\d.]/g, ''));
  return Number.isFinite(v) && v > 0 ? v : null;
}

// RFC-4180 CSV line parser — handles quoted fields and embedded commas/quotes
function _csvLine(line) {
  const fields = [];
  let field = '', inQ = false, i = 0;
  while (i < line.length) {
    const c = line[i];
    if (c === '"') {
      if (inQ && line[i + 1] === '"') { field += '"'; i += 2; continue; }
      inQ = !inQ;
    } else if (c === ',' && !inQ) {
      fields.push(field); field = '';
    } else {
      field += c;
    }
    i++;
  }
  fields.push(field);
  return fields;
}
