/**
 * productHunterScraper.js
 * ─────────────────────────────────────────────────────────────
 * Keepa Product Best Sellers → OnBuy Bulk Import pipeline.
 *
 * Flow:
 *   1. Log in to keepa.com
 *   2. Navigate to the Product Best Sellers page
 *   3. Select the user-chosen category from the tree
 *   4. Wait for the product table to load
 *   5. Set rows per page to 5 000
 *   6. Configure columns: hide all, then enable 8 specific columns
 *   7. Export → All active columns → CSV → download
 *   8. Parse CSV and map columns to OnBuy bulk-import row format
 *   9. Return mapped rows (caller uploads them via /api/onbuy-bulk/import)
 */

import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import fs from 'fs';
import path from 'path';
import os from 'os';
puppeteer.use(StealthPlugin());

const KEEPA_HOME        = 'https://keepa.com/#!';
const KEEPA_BESTSELLERS = 'https://keepa.com/#!bestseller';  // note: #!bestseller (no 's')
const _sleep = ms => new Promise(r => setTimeout(r, ms));

// OnBuy site_id → Keepa #language_domains span[setting] value
// Only sites that have a matching Amazon locale on Keepa
const SITE_TO_KEEPA_SETTING = {
  2000: '2',  // UK    → .uk
  2001: '4',  // France → .fr
  2002: '3',  // Germany → .de
  2007: '3',  // Austria → .de (Amazon.de serves Austria)
  2013: '9',  // Spain  → .es
  2020: '8',  // Italy  → .it
};

// ─────────────────────────────────────────────────────────────
// Column names to enable (exact Keepa column headers)
// ─────────────────────────────────────────────────────────────
const TARGET_COLUMNS = [
  'ASIN',
  'Title',
  'Description',
  'Image',
  'Brand',
  'Categories: Tree',
  'New: Current',
  'Color',
  'Description & Features: Feature 1',
  'Description & Features: Feature 2',
  'Description & Features: Feature 3',
  'Description & Features: Feature 4',
  'Description & Features: Feature 5',
  'Product Codes: EAN',
];

// ─────────────────────────────────────────────────────────────
// PUBLIC API
// ─────────────────────────────────────────────────────────────
/**
 * Run the full product hunting pipeline.
 *
 * @param {object} opts
 *   account      – OnBuy account row (must have keepa_email, keepa_password)
 *   category     – { label: string, path: string[] }  path = tree breadcrumb
 *   maxListings  – maximum rows to return (default 100)
 *   signal       – { cancelled: bool } object checked between async steps
 * @param {function} log   – logger callback (string) => void
 * @returns {object[]}  array of OnBuy bulk-import row objects
 */
export async function runProductHunting(
  { account, category, maxListings = 100, signal = {}, siteId = 2000 },
  log = console.log,
) {
  if (!account?.keepa_email || !account?.keepa_password) {
    throw new Error('Keepa credentials (email + password) are missing on this OnBuy account.');
  }

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

  const dlDir = fs.mkdtempSync(path.join(os.tmpdir(), 'keepa-hunt-'));

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900 });
    const cdp = await page.target().createCDPSession();
    await cdp.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: dlDir });

    _checkCancelled(signal);

    // ── 1. Login ────────────────────────────────────────────────────────
    await _login(page, account.keepa_email, account.keepa_password, log);

    _checkCancelled(signal);

    // ── 1b. Switch Keepa marketplace if needed ──────────────────────────
    await _selectKeepaMarketplace(page, siteId, log);

    _checkCancelled(signal);

    // ── 2. Navigate to Bestsellers ──────────────────────────────────────
    log('[Hunt] Navigating to Product Best Sellers…');
    await page.goto(KEEPA_BESTSELLERS, { waitUntil: 'networkidle2', timeout: 60_000 });
    await _sleep(3000);

    _checkCancelled(signal);

    // ── 3. Select category ──────────────────────────────────────────────
    log(`[Hunt] Selecting category: ${category.label}…`);
    await _selectCategory(page, category, log);

    _checkCancelled(signal);

    // ── 4. Wait for product rows ────────────────────────────────────────
    log('[Hunt] Waiting for product rows to appear…');
    await _waitForRows(page, log);

    _checkCancelled(signal);

    // ── 5. Set rows per page — Keepa re-fetches then renders all rows ──
    log(`[Hunt] Setting rows per page to ${maxListings}…`);
    await _setRowsPerPage(page, maxListings, log);

    // After the dropdown change Keepa makes an API call then renders the data
    // client-side. The full cycle takes ~40-60s for 10 000 rows.
    const KEEPA_ROW_OPTIONS = [5, 20, 100, 500, 1000, 2000, 5000, 10000];
    const targetRows = KEEPA_ROW_OPTIONS.find(v => v >= maxListings) ?? 10000;
    const waitSecs = targetRows >= 10000 ? 95
                   : targetRows >= 5000  ? 65
                   : targetRows >= 2000  ? 35
                   : targetRows >= 1000  ? 15
                   : 6;
    log(`[Hunt] Waiting ${waitSecs}s for Keepa to fetch and render ${targetRows} rows…`);
    await _sleep(waitSecs * 1000);

    _checkCancelled(signal);

    // ── 6. Wait for rows to finish rendering ──────────────────────────
    log('[Hunt] Waiting for table to render…');
    await _waitForRows(page, log);

    _checkCancelled(signal);

    // ── 7. Configure columns ────────────────────────────────────────────
    log('[Hunt] Configuring columns (hide all → select target columns)…');
    await _configureColumns(page, log);
    await _sleep(1500);

    _checkCancelled(signal);

    // ── 8. Export CSV ───────────────────────────────────────────────────
    log('[Hunt] Exporting CSV…');
    const csvPath = await _exportCSV(page, dlDir, log);

    _checkCancelled(signal);

    // ── 9. Map CSV → OnBuy format ───────────────────────────────────────
    log('[Hunt] Parsing and mapping CSV data…');
    const rows = _mapKeepaToOnBuy(csvPath, maxListings, log);
    log(`[Hunt] Mapped ${rows.length} product row(s) ✓`);


    return rows;

  } finally {
    await browser.close().catch(() => {});
    try { fs.rmSync(dlDir, { recursive: true, force: true }); } catch {}
  }
}

// ─────────────────────────────────────────────────────────────
// Throw a cancellation error so the outer loop stops gracefully
// ─────────────────────────────────────────────────────────────
function _checkCancelled(signal) {
  if (signal.cancelled) throw Object.assign(new Error('CANCELLED'), { isCancelled: true });
}

// ─────────────────────────────────────────────────────────────
// Switch Keepa to the correct Amazon marketplace for the given
// OnBuy site_id.  Keepa shows the current Amazon locale in
// #currentLanguage → clicks it to open #languageOverlay →
// then clicks the matching span[rel="domain"][setting="X"] in
// #language_domains.
// ─────────────────────────────────────────────────────────────
async function _selectKeepaMarketplace(page, siteId, log) {
  const setting = SITE_TO_KEEPA_SETTING[parseInt(siteId)] ?? '2'; // default .uk

  // Check the currently active domain setting
  const currentSetting = await page.evaluate(() => {
    // The overlay may be hidden; we can still read the active span if visible,
    // or fall back to the text shown in #currentLanguage
    const active = document.querySelector('#language_domains span[rel="domain"].active');
    if (active) return active.getAttribute('setting');
    // Not visible — open overlay briefly to read it, then read from current display
    const cur = document.querySelector('#currentLanguage span.languageMenuImg[rel="domain"]');
    if (cur) {
      const txt = cur.textContent.trim().replace(/^\./, ''); // ".uk" → "uk" / ".de" → "de"
      const map = { uk: '2', fr: '4', de: '3', it: '8', es: '9',
                    com: '1', ca: '5', mx: '6', br: '7', jp: '10', 'in': '11', 'co.uk': '2' };
      return map[txt] ?? null;
    }
    return null;
  });

  if (currentSetting === setting) {
    log(`[Hunt] Keepa marketplace already correct (setting=${setting})`);
    return;
  }

  log(`[Hunt] Switching Keepa marketplace to setting=${setting} (site_id=${siteId})…`);

  // 1. Open language overlay by clicking #currentLanguage
  await page.evaluate(() => {
    const el = document.querySelector('#currentLanguage') ??
               document.querySelector('#panelLanguage');
    if (el) el.click();
  });
  await _sleep(1500);

  // 2. Wait for #language_domains to be visible
  await page.waitForFunction(
    () => {
      const ov = document.querySelector('#languageOverlay');
      return ov && (ov.style.display !== 'none') && ov.offsetParent !== null;
    },
    { timeout: 8000 },
  ).catch(() => log('[Hunt] Warning: language overlay did not open'));

  // 3. Click the matching domain span
  const clicked = await page.evaluate((s) => {
    const span = document.querySelector(`#language_domains span[rel="domain"][setting="${s}"]`);
    if (span) { span.click(); return true; }
    return false;
  }, setting);

  if (clicked) {
    log(`[Hunt] Keepa marketplace switched ✓ — waiting for page to reload…`);
    await _sleep(3000);
  } else {
    log(`[Hunt] Warning: domain setting="${setting}" not found in Keepa overlay — proceeding with current locale`);
    // Close overlay
    await page.keyboard.press('Escape');
    await _sleep(500);
  }
}

// ─────────────────────────────────────────────────────────────
// Login  (identical flow to keepaScraper.js – kept local so
// that file stays independent)
// ─────────────────────────────────────────────────────────────
async function _login(page, email, password, log) {
  log('[Hunt] Checking Keepa login status…');
  await page.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  );
  await page.goto(KEEPA_HOME, { waitUntil: 'networkidle2', timeout: 30_000 });
  await _sleep(4000);

  if (await _isLoggedIn(page)) { log('[Hunt] Already logged in ✓'); return; }

  log('[Hunt] Opening login form…');
  await page.waitForSelector('#panelUserRegisterLogin', { timeout: 10_000 });
  await page.click('#panelUserRegisterLogin');
  await page.evaluate(() =>
    document.querySelector('#panelUserRegisterLogin')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })),
  );
  await _sleep(1500);

  let overlayVisible = await page.evaluate(() => {
    const ov = document.querySelector('#loginOverlay');
    return ov ? ov.offsetParent !== null : false;
  });

  if (!overlayVisible) {
    await page.evaluate(() => {
      const ov = document.querySelector('#loginOverlay');
      if (ov) { ov.classList.remove('hidden'); ov.style.display = 'block'; }
    });
    await _sleep(500);
    overlayVisible = await page.evaluate(
      () => (document.querySelector('#loginOverlay')?.offsetParent) !== null,
    );
  }

  if (!overlayVisible) throw new Error('[Hunt] Login overlay could not be shown');

  await page.evaluate((em, pw) => {
    const fill = (el, val) => {
      if (!el) return;
      el.focus();
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype, 'value',
      )?.set;
      if (setter) setter.call(el, val); else el.value = val;
      ['input', 'change'].forEach(ev => el.dispatchEvent(new Event(ev, { bubbles: true })));
    };
    fill(document.querySelector('#username'), em);
    fill(document.querySelector('#password'), pw);
  }, email, password);
  await _sleep(400);

  log('[Hunt] Submitting login…');
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
    { timeout: 25_000 },
  ).catch(() => log('[Hunt] Login confirmation not detected — proceeding'));

  const ok = await _isLoggedIn(page);
  if (ok) { log('[Hunt] Login successful ✓'); }
  else    { log('[Hunt] Warning: login may have failed — check Keepa credentials in account settings'); }
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
// Select a category in Keepa's bestsellers nav.
//
// Keepa renders categories as flat <a href="#bestseller/2-NODEID">
// links inside #besteller-category-container .category-wrapper.
// Clicking a parent category reloads the nav with its subcategories,
// so we iterate category.path and click one level at a time.
// ─────────────────────────────────────────────────────────────
async function _selectCategory(page, category, log) {
  const catPath = category.path ?? [category.label];

  for (let depth = 0; depth < catPath.length; depth++) {
    const label  = catPath[depth];
    const isLast = depth === catPath.length - 1;

    log(`[Hunt] Looking for category "${label}"…`);

    // Wait for category nav links to appear (they load after the page SPA renders)
    await page.waitForFunction(
      () => document.querySelectorAll('#besteller-category-container a, a[href*="bestseller/"]').length > 0,
      { timeout: 15_000 },
    ).catch(() => log('[Hunt] Timeout waiting for category links — trying anyway'));

    const found = await page.evaluate((text) => {
      // Keepa category links: <a href="https://keepa.com/#bestseller/2-NODEID">Label</a>
      // Container: #besteller-category-container  (Keepa's own typo — missing 's')
      const links = [
        ...document.querySelectorAll('#besteller-category-container a'),
        ...document.querySelectorAll('#bestseller-category-container a'),
        ...document.querySelectorAll('a[href*="bestseller/"]'),
      ];

      const textLower = text.trim().toLowerCase();

      // 1. Exact text match
      const exact = links.find(el =>
        el.textContent.trim() === text.trim() && el.offsetParent !== null,
      );
      if (exact) { exact.click(); return { found: true, method: 'exact', href: exact.href }; }

      // 2. Case-insensitive exact match
      const ci = links.find(el =>
        el.textContent.trim().toLowerCase() === textLower && el.offsetParent !== null,
      );
      if (ci) { ci.click(); return { found: true, method: 'ci', href: ci.href }; }

      // 3. Partial / starts-with match
      const partial = links.find(el =>
        el.textContent.trim().toLowerCase().startsWith(textLower) && el.offsetParent !== null,
      );
      if (partial) {
        partial.click();
        return { found: true, method: 'partial', matched: partial.textContent.trim(), href: partial.href };
      }

      // 4. Contains match (last resort)
      const contains = links.find(el =>
        el.textContent.trim().toLowerCase().includes(textLower) && el.offsetParent !== null,
      );
      if (contains) {
        contains.click();
        return { found: true, method: 'contains', matched: contains.textContent.trim(), href: contains.href };
      }

      return { found: false, available: links.map(l => l.textContent.trim()).filter(Boolean) };
    }, label);

    if (found.found) {
      const extra = found.matched ? ` → "${found.matched}"` : '';
      log(`[Hunt] Clicked "${label}" (${found.method}${extra})`);
    } else {
      const avail = (found.available ?? []).slice(0, 10).join(', ');
      log(`[Hunt] Warning: category "${label}" not found. Available: ${avail || '(none)'}`);
    }

    // Wait for nav/table to reload after clicking a parent, longer for the final leaf
    await _sleep(isLast ? 2500 : 2000);
  }
}

// ─────────────────────────────────────────────────────────────
// Wait for the AG Grid product rows to appear
// ─────────────────────────────────────────────────────────────
async function _waitForRows(page, log) {
  const sig = await page.waitForFunction(
    () => {
      const c = document.querySelector(
        '.ag-center-cols-container, .ag-body-container, [class*="ag-center"]',
      );
      if (!c) return false;
      const rows = c.querySelectorAll('.ag-row[role="row"], .ag-row');
      return rows.length > 0 ? `rows:${rows.length}` : false;
    },
    { timeout: 120_000, polling: 2000 },
  ).catch(() => null);

  if (sig) {
    const val = await sig.jsonValue().catch(() => '?');
    log(`[Hunt] Table ready (${val})`);
  } else {
    log('[Hunt] Warning: table rows not detected within 2 min — proceeding anyway');
  }

  await _sleep(1000);
}

// ─────────────────────────────────────────────────────────────
// Set rows per page using Keepa's bestseller toolbar.
//
// DOM (confirmed from DevTools):
//   #grid-tools-bestseller .tool__row.mdc-menu-anchor
//     .trigger          ← click to open dropdown
//     #tool-row-menu ul.mdc-menu__items
//       li[data-value="5"]   role="menuitem"
//       li[data-value="20"]
//       li[data-value="100"]
//       li[data-value="500"]
//       li[data-value="1000"]
//       li[data-value="2000"]
//       li[data-value="5000"]
//       li[data-value="10000"]
// ─────────────────────────────────────────────────────────────
async function _setRowsPerPage(page, maxListings, log) {
  const KEEPA_ROW_OPTIONS = [5, 20, 100, 500, 1000, 2000, 5000, 10000];
  // Pick the smallest available option that is ≥ requested count
  const target = KEEPA_ROW_OPTIONS.find(v => v >= maxListings) ?? KEEPA_ROW_OPTIONS[KEEPA_ROW_OPTIONS.length - 1];

  log(`[Hunt] Setting rows to ${target} (requested ${maxListings})…`);

  // 1. Open the rows dropdown by clicking .trigger inside .tool__row
  const opened = await page.evaluate(() => {
    const trigger = document.querySelector(
      '#grid-tools-bestseller .tool__row .trigger, ' +
      '.tool__row.mdc-menu-anchor .trigger, ' +
      '.tool_row .trigger',
    );
    if (trigger) { trigger.click(); return true; }
    return false;
  });

  if (!opened) {
    log('[Hunt] Warning: rows-per-page trigger not found — skipping row count change');
    return;
  }

  await _sleep(400);

  // 2. Click the matching li[data-value] option
  const selected = await page.evaluate((val) => {
    const item = document.querySelector(
      `#tool-row-menu li[data-value="${val}"], ` +
      `ul.mdc-menu__items li[data-value="${val}"]`,
    );
    if (item) { item.click(); return true; }
    // Fallback: find by text content
    const all = [...document.querySelectorAll('#tool-row-menu li, ul.mdc-menu__items li')];
    const byText = all.find(li => li.textContent.trim() === String(val));
    if (byText) { byText.click(); return true; }
    return false;
  }, String(target));

  if (selected) {
    log(`[Hunt] Rows set to ${target} ✓`);
  } else {
    log(`[Hunt] Row option ${target} not found — retrying…`);
    await _sleep(1000);
    // Retry: open dropdown again and click
    await page.evaluate(() => {
      const trigger = document.querySelector(
        '#grid-tools-bestseller .tool__row .trigger, ' +
        '.tool__row.mdc-menu-anchor .trigger, ' +
        '.tool_row .trigger',
      );
      if (trigger) trigger.click();
    });
    await _sleep(500);
    const retried = await page.evaluate((val) => {
      const item = document.querySelector(
        `#tool-row-menu li[data-value="${val}"], ` +
        `ul.mdc-menu__items li[data-value="${val}"]`,
      );
      if (item) { item.click(); return true; }
      const all = [...document.querySelectorAll('#tool-row-menu li, ul.mdc-menu__items li')];
      const byText = all.find(li => li.textContent.trim() === String(val));
      if (byText) { byText.click(); return true; }
      return false;
    }, String(target));
    log(retried ? `[Hunt] Rows set to ${target} ✓ (retry)` : `[Hunt] Warning: could not set rows to ${target} — Keepa may default to 1000`);
  }
}

// ─────────────────────────────────────────────────────────────
// Open "Configure Columns" → Hide All → enable target columns
//
// DOM (confirmed from DevTools):
//   #grid-tools-bestseller > span[text="Configure Columns"]  ← click to open
//   div.content-column.mdc-elevation--z10                    ← panel
//     span.hide-all                                          ← "Hide all"
//     div.scroll
//       p[data-search="<full col name>"]                     ← each column row
//         input[type="checkbox"]
//         label
// ─────────────────────────────────────────────────────────────
async function _configureColumns(page, log) {
  // ── 1. Open the column-configuration panel ────────────────────────────
  const openSel = await page.evaluate(() => {
    // Class-based selector (if Keepa adds one)
    const byClass = document.querySelector(
      '#grid-tools-bestseller .tool__columns .trigger, ' +
      '.tool__columns .trigger, ' +
      '#grid-tools-bestseller .tool__col .trigger',
    );
    if (byClass) { byClass.click(); return 'class:' + byClass.className.slice(0, 20); }

    // Exact own-text match within #grid-tools-bestseller (most reliable)
    const inToolbar = [...document.querySelectorAll('#grid-tools-bestseller *')];
    const exact = inToolbar.find(el => {
      const own = [...el.childNodes]
        .filter(n => n.nodeType === Node.TEXT_NODE)
        .map(n => n.textContent.trim())
        .join('');
      return /configure\s*columns?/i.test(own) && el.offsetParent !== null;
    });
    if (exact) { exact.click(); return 'exact:Configure Columns'; }

    // Broad fallback: any span/button with exact text "Configure Columns"
    const all = [...document.querySelectorAll('span, button, a')];
    const btn = all.find(el =>
      el.textContent.trim() === 'Configure Columns' && el.offsetParent !== null,
    );
    if (btn) { btn.click(); return 'global-exact:Configure Columns'; }

    return null;
  });

  if (!openSel) { log('[Hunt] Warning: "Configure Columns" button not found — skipping'); return; }
  log(`[Hunt] Opened column config (${openSel})`);
  await _sleep(1200);

  // ── 2. Click "Hide All" to clear all columns ──────────────────────────
  const hideAll = await page.evaluate(() => {
    // Direct class selector confirmed from DevTools: <span class="hide-all">Hide all</span>
    const byClass = document.querySelector('.hide-all, span.hide-all');
    if (byClass) { byClass.click(); return true; }
    // Fallback: text search
    const all = [...document.querySelectorAll('span, a, button')];
    const btn = all.find(el =>
      /hide\s*all/i.test(el.textContent.trim()) && el.offsetParent !== null,
    );
    if (btn) { btn.click(); return true; }
    return false;
  });
  if (hideAll) { log('[Hunt] Clicked "Hide All" ✓'); }
  else         { log('[Hunt] Warning: "Hide All" not found — enabling from current state'); }
  await _sleep(800);

  // ── 3. Enable each target column ──────────────────────────────────────
  for (const colName of TARGET_COLUMNS) {
    const enabled = await page.evaluate((name) => {
      // Strategy 1: p[data-search="${name}"] — handles nested columns like "New: Current",
      //             "Categories: Tree", "Buy Box: Current" whose label text is just the
      //             leaf word ("Current", "Tree") not the full qualified name.
      const bySearch = [...document.querySelectorAll('p[data-search]')]
        .find(p => p.getAttribute('data-search') === name);
      if (bySearch) {
        const cb = bySearch.querySelector('input[type="checkbox"]');
        if (cb) { if (!cb.checked) cb.click(); return true; }
      }

      // Strategy 2: label whose text exactly matches the column name
      const labels = [...document.querySelectorAll('label')];
      for (const lbl of labels) {
        if (lbl.textContent.trim().toLowerCase() === name.toLowerCase()) {
          const inp = document.getElementById(lbl.htmlFor) ??
                      lbl.previousElementSibling ??
                      lbl.parentElement?.querySelector('input[type="checkbox"]');
          if (inp?.type === 'checkbox') { if (!inp.checked) inp.click(); return true; }
        }
      }

      // Strategy 3: checkbox whose associated label contains the column name
      const allCBs = [...document.querySelectorAll('input[type="checkbox"]')];
      for (const cb of allCBs) {
        const lbl = document.querySelector(`label[for="${cb.id}"]`);
        const labelText = lbl?.textContent?.trim() ?? '';
        if (labelText.toLowerCase().includes(name.toLowerCase())) {
          if (!cb.checked) cb.click();
          return true;
        }
      }

      return false;
    }, colName);

    log(`[Hunt] Column "${colName}": ${enabled ? 'enabled ✓' : 'not found'}`);
    await _sleep(250);
  }

  // ── 4. Close panel by clicking in the table area ─────────────────────
  await page.mouse.click(720, 650);
  await _sleep(800);
}

// ─────────────────────────────────────────────────────────────
// Click Export → All active columns → CSV → download
// ─────────────────────────────────────────────────────────────
async function _exportCSV(page, dlDir, log) {
  // Dismiss any overlays/modals that might block the export dialog
  await page.keyboard.press('Escape');
  await _sleep(300);
  // Ensure the column-config panel is closed before clicking Export
  await page.mouse.click(720, 650);
  await _sleep(800);

  // Open export dialog — scope to bestseller toolbar first
  const exportSel = await page.evaluate(() => {
    const tryInScope = (root) => {
      if (!root) return null;
      for (const sel of [
        '.tool__export .trigger', '.tool_export .trigger',
        '.tool__export',         '.tool_export',
      ]) {
        const el = root.querySelector(sel);
        if (el && el.offsetParent !== null) { el.click(); return 'scope:' + sel; }
      }
      const btn = [...root.querySelectorAll('span, a, button')].find(e =>
        /^\s*export\s*$/i.test(e.textContent.trim()) && e.offsetParent !== null,
      );
      if (btn) { btn.click(); return 'text:' + btn.className.slice(0, 30); }
      return null;
    };

    // Prefer bestseller toolbar, fall back to whole page
    return tryInScope(document.querySelector('#grid-tools-bestseller')) ??
           tryInScope(document.body);
  });

  if (!exportSel) throw new Error('[Hunt] Export button not found on page');
  log(`[Hunt] Export trigger: ${exportSel}`);
  await _sleep(800);

  // Wait for export dialog — try up to 60s; take screenshot on failure to help debug
  await page.waitForFunction(
    () => !!(document.querySelector('#exportSubmit') ||
             document.querySelector('button[type="submit"][id*="export" i]') ||
             document.querySelector('.exportSubmit')),
    { timeout: 60_000 },
  ).catch(async (err) => {
    try {
      const debugDir = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1')), 'logs');
      fs.mkdirSync(debugDir, { recursive: true });
      const ss = path.join(debugDir, `export-dialog-debug-${Date.now()}.png`);
      await page.screenshot({ path: ss, fullPage: false });
      log(`[Hunt] Export dialog screenshot saved: ${ss}`);
    } catch (_) {}
    throw err;
  });
  await _sleep(500);

  // Select "All active columns" + CSV
  await page.evaluate(() => {
    const allCols = document.querySelector('#allCh-radio');
    if (allCols && !allCols.checked) allCols.click();
    const csv = document.querySelector('#csv-radio');
    if (csv && !csv.checked) csv.click();
    const sym = document.querySelector('#exportSymbols-checkbox');
    if (sym && sym.checked) sym.click();
  });
  await _sleep(300);

  log('[Hunt] Clicking export submit…');
  const submitClicked = await page.evaluate(() => {
    const btn = document.querySelector('#exportSubmit') ||
                document.querySelector('.exportSubmit') ||
                document.querySelector('button[type="submit"][id*="export" i]');
    if (btn) { btn.click(); return true; }
    return false;
  });
  if (!submitClicked) throw new Error('[Hunt] Export submit button not found');


  log('[Hunt] Waiting for CSV download…');
  const csvPath = await _waitForFile(dlDir, '.csv', 90_000);
  log(`[Hunt] Downloaded: ${path.basename(csvPath)} ✓`);
  return csvPath;
}

// ─────────────────────────────────────────────────────────────
// Poll temp dir until a .csv file appears
// ─────────────────────────────────────────────────────────────
async function _waitForFile(dir, ext, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const files = fs.readdirSync(dir).filter(
      f => f.endsWith(ext) && !f.endsWith('.crdownload') && !f.endsWith('.tmp'),
    );
    if (files.length) { await _sleep(500); return path.join(dir, files[0]); }
    await _sleep(1000);
  }
  throw new Error(`No ${ext} file downloaded within ${timeoutMs / 1000}s`);
}

// ─────────────────────────────────────────────────────────────
// Parse Keepa bestsellers CSV and map to OnBuy bulk-import rows
//
// Keepa CSV columns we care about:
//   Image                                   – ";"-separated URLs
//   Title
//   Description                             – main description (may contain \n)
//   Description & Features: Feature 1-5    – summary points
//   New: Current                            – listing price
//   Categories: Tree                        – full category path
//   ASIN
//   Brand
//   Color
// ─────────────────────────────────────────────────────────────
function _mapKeepaToOnBuy(csvPath, maxListings, log) {
  const raw     = fs.readFileSync(csvPath, 'utf-8').replace(/^﻿/, ''); // strip BOM
  const records = _parseCsvFull(raw);
  if (records.length < 2) { log('[Hunt] CSV is empty'); return []; }

  const headers = records[0];
  const col = (name) => headers.findIndex(h => h.trim().toLowerCase() === name.toLowerCase());

  // Column indices
  const iImage    = col('Image');
  const iTitle    = col('Title');
  const iDesc     = _findCol(headers, ['Description & Features: Description', 'Description']);
  const iFeature1 = _findCol(headers, ['Description & Features: Feature 1', 'Feature 1']);
  const iFeature2 = _findCol(headers, ['Description & Features: Feature 2', 'Feature 2']);
  const iFeature3 = _findCol(headers, ['Description & Features: Feature 3', 'Feature 3']);
  const iFeature4 = _findCol(headers, ['Description & Features: Feature 4', 'Feature 4']);
  const iFeature5 = _findCol(headers, ['Description & Features: Feature 5', 'Feature 5']);
  const iNewCur   = _findCol(headers, ['New: Current', 'Amazon: Current']);
  const iCatTree  = _findCol(headers, ['Categories: Tree', 'Category Tree', 'Categories Tree']);
  const iASIN     = col('ASIN');
  const iBrand    = col('Brand');
  const iColor    = _findCol(headers, ['Color', 'Colour']);
  const iEan      = _findCol(headers, ['EAN', 'Product Codes: EAN', 'Ean', 'GTIN', 'Barcode', 'UPC']);

  log(`[Hunt] CSV columns (${headers.length}): ${headers.slice(0, 16).join(' | ')}`);

  const rows = [];

  for (let i = 1; i < records.length && rows.length < maxListings; i++) {
    const cols = records[i];
    if (!cols.some(c => c.trim())) continue;

    const asin  = iASIN  >= 0 ? (cols[iASIN]  ?? '').trim() : '';
    const rawTitle = iTitle >= 0 ? (cols[iTitle] ?? '').trim() : '';
    const title    = rawTitle.length > 80 ? rawTitle.slice(0, 80).trimEnd() : rawTitle;
    if (!asin && !title) continue;

    // Images: split by ";" — multi-image Keepa field
    const rawImages = iImage >= 0 ? (cols[iImage] ?? '') : '';
    const images = rawImages.split(';').map(u => u.trim()).filter(Boolean);

    // Description: full multi-line text now preserved correctly by the parser
    const descBase = iDesc >= 0 ? (cols[iDesc] ?? '').trim() : '';
    const f1 = iFeature1 >= 0 ? (cols[iFeature1] ?? '').trim() : '';
    const f2 = iFeature2 >= 0 ? (cols[iFeature2] ?? '').trim() : '';
    const f3 = iFeature3 >= 0 ? (cols[iFeature3] ?? '').trim() : '';
    const f4 = iFeature4 >= 0 ? (cols[iFeature4] ?? '').trim() : '';
    const f5 = iFeature5 >= 0 ? (cols[iFeature5] ?? '').trim() : '';
    const description = [descBase, f1, f2, f3, f4, f5].filter(Boolean).join('\n');

    const rawPrice = iNewCur >= 0 ? (cols[iNewCur] ?? '').trim() : '';
    const price    = parseFloat(rawPrice.replace(/[^0-9.]/g, '')) || null;

    // Category: keep the full tree path so the OnBuy category matcher has maximum context
    const catTree = iCatTree >= 0 ? (cols[iCatTree] ?? '').trim() : '';

    const brand   = iBrand >= 0 ? (cols[iBrand] ?? '').trim() : '';
    const color   = iColor >= 0 ? (cols[iColor] ?? '').trim() : '';
    // EAN field may contain multiple comma-separated codes — use first, keep rest for retry
    const eanList = (iEan >= 0 ? (cols[iEan] ?? '') : '')
      .split(',').map(e => e.trim()).filter(Boolean);
    const ean = eanList[0] || '';

    rows.push({
      _row:     i + 1,
      valid:    !!(title && price && ean),
      errors:   [
        ...(!title ? ['Product Name required'] : []),
        ...(!price ? ['Price required'] : []),
        ...(!ean   ? ['EAN required — product skipped (no fake EANs)'] : []),
      ],
      name:      title,
      sku:       asin || `HUNT-${Date.now()}-${i}`,
      description,
      images,
      brand,
      category:  catTree,
      condition: 'new',
      price,
      stock:     5,
      handling_time: '3',
      colour:    color,
      summary1:  f1,
      summary2:  f2,
      summary3:  f3,
      summary4:  f4,
      summary5:  f5,
      ean,
      ean_list:  eanList,
      mpn:       '',
      delivery_weight: null,
    });
  }

  const valid = rows.filter(r => r.valid).length;
  log(`[Hunt] CSV mapped: ${rows.length} rows total, ${valid} valid`);
  return rows;
}

// Find the first matching column index from a list of candidate names
function _findCol(headers, candidates) {
  for (const name of candidates) {
    const i = headers.findIndex(h => h.trim().toLowerCase() === name.toLowerCase());
    if (i >= 0) return i;
  }
  return -1;
}

// ─────────────────────────────────────────────────────────────
// Full RFC-4180 CSV parser — handles quoted fields that span
// multiple lines (e.g. Keepa description cells with \n inside).
// Replaces the old split-by-\n + per-line approach.
// ─────────────────────────────────────────────────────────────
function _parseCsvFull(raw) {
  const records = [];
  let fields = [], field = '', inQ = false;

  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (inQ) {
      if (ch === '"' && raw[i + 1] === '"') { field += '"'; i++; } // escaped ""
      else if (ch === '"')                   { inQ = false; }        // closing "
      else                                   { field += ch; }        // any char incl. \n
    } else {
      if      (ch === '"')  { inQ = true; }
      else if (ch === ',')  { fields.push(field); field = ''; }
      else if (ch === '\n') {
        fields.push(field); field = '';
        if (fields.some(f => f.trim())) records.push(fields);
        fields = [];
      } else if (ch === '\r') { /* skip CR */ }
      else { field += ch; }
    }
  }
  // Flush last record
  fields.push(field);
  if (fields.some(f => f.trim())) records.push(fields);
  return records;
}
