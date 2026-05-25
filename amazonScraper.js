/**
 * amazonScraper.js
 * ─────────────────────────────────────────────────────────────
 * Full Amazon UK scraper with:
 *  - Stealth Puppeteer (evades bot detection)
 *  - UK proxy priority (critical for amazon.co.uk)
 *  - Cookie/session warm-up + UK location setter
 *  - CAPTCHA detection + smart retry
 *  - Self-healing smartExtractPrice (5 parallel methods)
 *  - Product details scraping
 *  - All-sellers / multi-supplier scraping
 *  - In-memory + file logging with ring buffer
 * ─────────────────────────────────────────────────────────────
 * Install deps:
 *   npm install puppeteer puppeteer-extra puppeteer-extra-plugin-stealth
 *               cheerio node-fetch user-agents https-proxy-agent
 */

import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import * as cheerio from 'cheerio';
import fetch from 'node-fetch';
import UserAgent from 'user-agents';
import fs from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { smartExtractPrice } from './priceExtractor.js';

puppeteer.use(StealthPlugin());

const __dirname = dirname(fileURLToPath(import.meta.url));
const LOG_FILE = join(__dirname, 'scraper.log');

// ─────────────────────────────────────────────
// LOGGING — in-memory ring buffer (last 200)
// Exported for /api/scraper-logs endpoint
// ─────────────────────────────────────────────
export const scraperLogs = [];

function log(level, message, meta = {}) {
  const entry = { ts: new Date().toISOString(), level, message, ...meta };
  scraperLogs.unshift(entry);
  if (scraperLogs.length > 200) scraperLogs.pop();
  const metaStr = Object.keys(meta).length ? ' ' + JSON.stringify(meta) : '';
  const line = `[${entry.ts}] [${level.toUpperCase()}] ${message}${metaStr}`;
  console.log(line);
  try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch {}
}

// ─────────────────────────────────────────────
// PROXY CONFIGURATION
// Proxies are fetched dynamically from Webshare API and cached for 1 hour.
// Set WEBSHARE_PROXY_API in .env to the download URL from your Webshare proxy list page.
// Format: https://proxy.webshare.io/api/v2/proxy/list/download/<token>/
// ─────────────────────────────────────────────
let _proxyCache = [];         // all proxies as 'http://user:pass@host:port' strings
let _proxyCacheTime = 0;
const PROXY_CACHE_TTL = 60 * 60 * 1000; // 1 hour

let _webshareApiUrl = process.env.WEBSHARE_PROXY_API || null;

export function setProxyApiUrl(url) {
  _webshareApiUrl = url || null;
  _proxyCache = [];
  _proxyCacheTime = 0;
}

export function getProxyStatus() {
  return {
    count:       _proxyCache.length,
    lastRefresh: _proxyCacheTime ? new Date(_proxyCacheTime).toISOString() : null,
    configured:  !!_webshareApiUrl,
  };
}

async function loadProxies() {
  const apiUrl = _webshareApiUrl;
  if (!apiUrl) {
    log('warn', 'Webshare proxy API URL not configured — running without proxies');
    return [];
  }
  try {
    const res = await fetch(apiUrl, { timeout: 10000 });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    // Webshare list format: ip:port:username:password (one per line)
    const proxies = text.trim().split('\n')
      .map(line => line.trim())
      .filter(line => line && line.includes(':'))
      .map(line => {
        const parts = line.split(':');
        if (parts.length === 4) {
          const [host, port, user, pass] = parts;
          return `http://${user}:${pass}@${host}:${port}`;
        }
        return null;
      })
      .filter(Boolean);
    log('info', `Loaded ${proxies.length} proxies from Webshare`);
    return proxies;
  } catch (err) {
    log('warn', `Failed to load proxies from Webshare: ${err.message}`);
    return _proxyCache; // keep using stale cache on failure
  }
}

async function getProxies() {
  const now = Date.now();
  if (now - _proxyCacheTime > PROXY_CACHE_TTL || _proxyCache.length === 0) {
    _proxyCache = await loadProxies();
    _proxyCacheTime = now;
  }
  return _proxyCache;
}

const USE_PROXIES = true; // determined at call-time by whether proxy pool is non-empty

// ─────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────

// Splits a proxy URL into { server, username, password }
// Required for Puppeteer's page.authenticate()
function parseProxy(raw) {
  const u = new URL(raw);
  return {
    server:   `${u.protocol}//${u.hostname}:${u.port}`,
    username: u.username,
    password: u.password,
  };
}

// All proxies are UK residential — pick one at random from the cache
async function getUKProxy() {
  const pool = await getProxies();
  if (!pool.length) return null;
  return parseProxy(pool[Math.floor(Math.random() * pool.length)]);
}

async function getRandomProxy() {
  return getUKProxy();
}

// Used in getAllSellers — kept for compatibility
function getRandomUserAgent() {
  return new UserAgent({ deviceCategory: 'desktop' }).toString();
}

// Desktop UK Chrome user agents only
function getUKUserAgent() {
  const UA_LIST = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4_1) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4.1 Safari/605.1.15',
  ];
  return UA_LIST[Math.floor(Math.random() * UA_LIST.length)];
}

// Full UK browser headers — looks like real traffic
function getUKHeaders(ua) {
  return {
    'User-Agent':                ua,
    'Accept':                    'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
    'Accept-Language':           'en-GB,en;q=0.9',
    'Accept-Encoding':           'gzip, deflate, br',
    'Connection':                'keep-alive',
    'Upgrade-Insecure-Requests': '1',
    'Sec-Fetch-Dest':            'document',
    'Sec-Fetch-Mode':            'navigate',
    'Sec-Fetch-Site':            'none',
    'Sec-Fetch-User':            '?1',
    'Cache-Control':             'max-age=0',
    'DNT':                       '1',
  };
}

function randomDelay(minMs = 2000, maxMs = 6000) {
  const ms = Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
  return new Promise(r => setTimeout(r, ms));
}

// Local parsePrice — used for non-extraction contexts (sellers list etc.)
function parsePrice(raw) {
  if (!raw) return null;
  const cleaned = raw.replace(/[^0-9.]/g, '');
  const val = parseFloat(cleaned);
  return isNaN(val) ? null : val;
}

function isCaptchaPage(html) {
  return (
    html.includes('Type the characters you see in this image') ||
    html.includes('Enter the characters you see below') ||
    html.includes('Sorry, we just need to make sure you') ||
    html.includes('api-services-support@amazon.com') ||
    html.includes('captcha') ||
    html.includes('press and hold') ||
    html.includes('unusual traffic')
  );
}

function isBlockedPage(html) {
  return (
    html.includes('Request blocked') ||
    html.includes('503 Service Unavailable') ||
    html.includes('To discuss automated access') ||
    html.includes('not a robot') ||
    html.length < 8000
  );
}

// ─────────────────────────────────────────────
// CSS SELECTOR EXTRACTION
// Your updated selectors preserved exactly —
// includes aok-offscreen, priceToPay, and
// whole+fraction splitting you added.
// Used as primary fast path; smartExtractPrice
// runs in parallel as validation/fallback.
// ─────────────────────────────────────────────
function extractPrice($) {
  // Priority 0: Amazon's hidden twister price input — machine-readable, no layout ambiguity
  const twisterHidden = $('input#twister-plus-price-data-price').attr('value');
  if (twisterHidden && parseFloat(twisterHidden) > 0) return twisterHidden;

  // Whole + fraction split — most precise, avoids hidden span ambiguity
  const whole = $('#corePriceDisplay_desktop_feature_div .a-price-whole').first().text().replace(/[^0-9]/g, '');
  const frac  = $('#corePriceDisplay_desktop_feature_div .a-price-fraction').first().text().replace(/[^0-9]/g, '');
  if (whole) return `${whole}.${frac || '00'}`;

  const selectors = [
    // New Amazon UK layout — aok-offscreen buy box
    '#corePriceDisplay_desktop_feature_div .aok-offscreen',
    '#corePriceDisplay_desktop_feature_div .a-offscreen',
    '#corePrice_feature_div .aok-offscreen',
    '#corePrice_feature_div .a-offscreen',
    '#apex_offerDisplay_desktop .aok-offscreen',
    '#apex_offerDisplay_desktop .a-offscreen',
    '.priceToPay .aok-offscreen',
    '.priceToPay .a-offscreen',
    // Legacy price blocks
    '#priceblock_ourprice',
    '#priceblock_dealprice',
    '#priceblock_saleprice',
    // Alternate containers
    '.a-price[data-a-color="price"] .aok-offscreen',
    '.a-price[data-a-color="price"] .a-offscreen',
    '#buyNewSection .a-color-price',
    '#newBuyBoxPrice',
    '#sns-base-price',
    '#tp_price_block_total_price_ww .a-offscreen',
    '#booksHeaderSection .a-color-price',
    '[data-feature-name="apex_desktop"] .a-offscreen',
    '.reinventPricePolicyMessage .a-offscreen',
    '#digitalPriceBlockId_feature_div .a-offscreen',
  ];

  for (const sel of selectors) {
    const val = $(sel).first().text().trim();
    if (val && /\d/.test(val)) return val;
  }
  return null;
}

// ─────────────────────────────────────────────
// PRICE MERGE HELPER
// Used by both cheerioScrape and puppeteerScrape.
// Compares CSS/DOM result with smartExtractPrice
// result and picks the most reliable one.
// ─────────────────────────────────────────────
function mergePrice({ cssPrice, smartResult, context, url }) {
  const cssParsed   = parsePrice(cssPrice);
  const smartParsed = smartResult.price;

  let finalPrice  = null;
  let priceSource = null;

  if (cssParsed && smartParsed) {
    // Both found a price — check agreement (within 1p tolerance for rounding)
    const agree = Math.abs(cssParsed - smartParsed) < 0.02;
    finalPrice  = cssParsed; // CSS/DOM result is more precisely formatted
    priceSource = agree ? `${context}+smart_agreed` : `${context}_preferred`;
    if (!agree) {
      log('warn', `Price disagreement: ${context.toUpperCase()}=£${cssParsed} Smart=£${smartParsed} — using ${context}`, { url });
    }
  } else if (smartParsed) {
    // CSS/DOM missed it — smart extraction saved us
    finalPrice  = smartParsed;
    priceSource = `smart_only:${smartResult.topMethod}`;
    log('warn', `${context.toUpperCase()} selectors missed price — smart extraction used (${smartResult.topMethod}). Consider updating extractPrice() selectors.`, { url });
  } else if (cssParsed) {
    finalPrice  = cssParsed;
    priceSource = `${context}_only`;
  }

  log('debug', `[${context}] CSS: £${cssParsed ?? 'null'} | Smart: £${smartParsed ?? 'null'} | Final: £${finalPrice ?? 'null'} | Source: ${priceSource}`);

  return { finalPrice, priceSource };
}

// ─────────────────────────────────────────────
// APPROACH 0: Amazon Twister AJAX endpoint
// Amazon's own internal price API — returns the
// current buy-box price as plain JSON with zero
// HTML parsing. Fastest and most reliable.
// Endpoint: /gp/product/ajax/twisterDimensionSlotsDefault
// ─────────────────────────────────────────────

async function fetchTwisterPrice(asin) {
  // currency=GBP forces sterling regardless of IP geolocation
  const apiUrl = `https://www.amazon.co.uk/gp/product/ajax/twisterDimensionSlotsDefault` +
    `?isDimensionSlotsAjax=1&asinList=${asin}&vs=1&asin=${asin}&currency=GBP`;

  const ua = getUKUserAgent();
  const baseHeaders = {
    'User-Agent':      ua,
    'Accept':          '*/*',
    'Accept-Language': 'en-GB,en;q=0.9',
    'X-Requested-With': 'XMLHttpRequest',
    'Referer':         `https://www.amazon.co.uk/dp/${asin}?currency=GBP`,
    'Cookie':          'i18n-prefs=GBP; lc-acbuk=en_GB',
  };

  // Build attempt list: try up to 3 different proxy IPs, then direct fallback.
  // Different IPs have different Amazon bot-detection scores, so rotating helps.
  const attempts = [];
  const pool = await getProxies();
  if (pool.length > 0) {
    try {
      const { HttpsProxyAgent } = await import('https-proxy-agent');
      // Pick up to 3 random proxies without repeating
      const indices = [...Array(pool.length).keys()];
      for (let i = indices.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [indices[i], indices[j]] = [indices[j], indices[i]];
      }
      for (const idx of indices.slice(0, 3)) {
        const p = parseProxy(pool[idx]);
        // Format: http://user:pass@host:port  (Webshare standard)
        const proxyUrl = `http://${p.username}:${p.password}@${new URL(p.server).hostname}:${new URL(p.server).port}`;
        attempts.push({ agent: new HttpsProxyAgent(proxyUrl), label: `proxy(${new URL(p.server).hostname})` });
      }
    } catch (e) {
      log('debug', `Twister: could not build proxy agents — ${e.message}`);
    }
  }
  attempts.push({ agent: undefined, label: 'direct' });

  let res;
  for (const { agent, label } of attempts) {
    try {
      res = await fetch(apiUrl, { headers: baseHeaders, timeout: 12000, ...(agent ? { agent } : {}) });
      if (res.ok) {
        log('debug', `Twister OK via ${label}`, { asin });
        break;
      }
      log('debug', `Twister endpoint HTTP ${res.status} (${label})`, { asin });
      res = null;
    } catch (err) {
      log('debug', `Twister fetch error (${label}): ${err.message}`, { asin });
      res = null;
    }
  }

  try {
    if (!res?.ok) return null;

    const data = await res.json();

    // Endpoint returns either a plain object {ASIN,Value} or an array [{ASIN,Value},...]
    const item    = Array.isArray(data) ? data[0] : data;
    const content = item?.Value?.content;

    if (!content) {
      // Log a sample of the raw shape so we can diagnose structure changes
      log('debug', `Twister: unexpected response shape — keys: ${Object.keys(item ?? {}).join(',')}`, { asin });
      return null; // treat as technical failure, not OOS
    }

    const slotHtml = content?.twisterSlotDiv || '';

    // ── Primary: price directly as a number or string in twisterSlotJson ──
    const slot = content?.twisterSlotJson;
    const rawPrice = slot?.price;
    const jsonPrice = (rawPrice !== null && rawPrice !== undefined)
      ? parseFloat(String(rawPrice))
      : NaN;
    if (jsonPrice > 0) {
      log('info', `Twister JSON price: £${jsonPrice}`, { asin });
      return { price: jsonPrice, inStock: true };
    }

    // ── Fallback: parse price from the embedded HTML snippet ──
    if (slotHtml) {
      const $s = cheerio.load(slotHtml);
      const candidates = [
        $s('.apex-pricetopay-accessibility-label').first().text(),
        $s('[aria-hidden="true"]').first().text(),
        $s('.olpWrapper').first().text(),
        $s('#_price').text(),
        $s('span').text(),
      ];
      for (const raw of candidates) {
        const p = parsePrice(raw.trim());
        if (p) {
          log('info', `Twister HTML price: £${p}`, { asin });
          return { price: p, inStock: true };
        }
      }
    }

    // Twister responded and was parsed correctly but contained no extractable price.
    // Log the raw price field so we can see what Amazon actually returned.
    log('debug', `Twister: no usable price — raw slot.price=${JSON.stringify(rawPrice)}`, { asin });
    return { responded: true, price: null };
  } catch (err) {
    log('debug', `fetchTwisterPrice error: ${err.message}`, { asin });
    return null;
  }
}

// ─────────────────────────────────────────────
// APPROACH 1: CHEERIO via UK proxy (fast)
// 1. Fetches raw HTML via UK proxy
// 2. Runs CSS extractPrice() (your selectors)
// 3. Runs smartExtractPrice() in parallel (5 methods)
// 4. mergePrice() picks the best result
// ─────────────────────────────────────────────

async function cheerioScrape(url) {
  const ua = getUKUserAgent();
  const headers = getUKHeaders(ua);

  let fetchOptions = { headers, timeout: 20000 };

  if (USE_PROXIES) {
    const proxy = await getUKProxy();
    try {
      const { HttpsProxyAgent } = await import('https-proxy-agent');
      const proxyUrl = proxy ? proxy.server.replace('://', `://${proxy.username}:${proxy.password}@`) : null;
      if (!proxyUrl) throw new Error('no proxies available');
      fetchOptions.agent = new HttpsProxyAgent(proxyUrl);
    } catch {
      log('debug', 'https-proxy-agent not available, proceeding without proxy agent');
    }
  }

  const res = await fetch(url, fetchOptions);

  if (res.status === 503 || res.status === 403 || res.status === 429) {
    return { blocked: true, reason: `HTTP ${res.status}` };
  }

  const html = await res.text();

  if (isCaptchaPage(html) || isBlockedPage(html)) {
    return { blocked: true, reason: 'captcha_or_block' };
  }

  const $ = cheerio.load(html);

  // OOS detection — check availability text before anything else
  const availText = $('#availability span').first().text().trim() || $('#availability').first().text().trim();
  const isOos = (
    /currently unavailable/i.test(availText) ||
    /temporarily out of stock/i.test(availText) ||
    /out of stock/i.test(availText) ||
    /don't know when or if/i.test(availText) ||
    /this item is currently unavailable/i.test(availText)
  );
  if (isOos) {
    log('info', `Cheerio: product OOS — "${availText}"`, { url });
    return { blocked: false, price: null, inStock: false, availability: availText, title: $('#productTitle').text().trim() };
  }

  // "No featured offers" — buy-box is absent, AOD navigation requires a real browser
  if ($('#unqualifiedBuyBox').length > 0 || /No featured offers available/i.test(html)) {
    const title = $('#productTitle').text().trim();
    log('info', 'No featured offers detected — deferring to Puppeteer for AOD', { url });
    return { blocked: false, needsBrowser: true, title };
  }

  // Strip alternative-item sections before extraction so their prices are never matched
  $('#above-dp-container').remove();
  $('#similarities_feature_div').remove();
  $('[data-feature-name="similarities_feature_div"]').remove();
  $('iframe').remove();

  // Run both extraction methods
  const cssPrice   = extractPrice($);
  const smartResult = smartExtractPrice($, html);

  const { finalPrice, priceSource } = mergePrice({ cssPrice, smartResult, context: 'css', url });

  const title        = $('#productTitle').text().trim();
  const rating       = $('.a-icon-alt').first().text().trim();
  const reviewCount  = $('#acrCustomerReviewText').first().text().trim();
  const availability = $('#availability span').first().text().trim();
  const image        = $('#landingImage').attr('src') || $('#imgBlkFront').attr('src');
  const brand        = $('#bylineInfo').text().trim();
  const seller       = $('#sellerProfileTriggerId').text().trim() || 'Amazon';

  // Page loaded but no price — needs JS rendering
  if (title && !finalPrice) {
    return { blocked: false, needsBrowser: true, title };
  }

  return {
    blocked:         false,
    needsBrowser:    false,
    price:           finalPrice,
    priceSource,
    priceConfidence: smartResult.confidence,
    title,
    rating,
    reviewCount,
    availability,
    image,
    brand,
    sellerName: seller,
  };
}

// ─────────────────────────────────────────────
// AOD: navigate to offer-listing page to get
// 3rd-party "New" price when buy-box shows
// "No featured offers available"
// ─────────────────────────────────────────────

async function extractAODPrice(page, url) {
  try {
    const m = url.match(/\/dp\/([A-Z0-9]{10})/);
    if (!m) return null;
    const asin = m[1];
    const offerUrl = `https://www.amazon.co.uk/gp/offer-listing/${asin}?condition=new`;
    log('info', `AOD fallback: navigating to ${offerUrl}`);
    await page.goto(offerUrl, { waitUntil: 'domcontentloaded', timeout: 25000 });
    await page.waitForSelector('#aod-offer, #aod-price-1, .olpOfferPrice', { timeout: 10000 }).catch(() => {});
    const aodPrice = await page.evaluate(() => {
      const direct = document.querySelector('#aod-price-1 .aok-offscreen, #aod-price-1 .a-offscreen');
      if (direct && /\d/.test(direct.textContent)) return direct.textContent.trim();
      for (const offer of document.querySelectorAll('#aod-offer')) {
        const heading = offer.querySelector('#aod-offer-heading');
        if (!heading || /new/i.test(heading.textContent)) {
          const p = offer.querySelector('.a-price .aok-offscreen, .a-price .a-offscreen');
          if (p && /\d/.test(p.textContent)) return p.textContent.trim();
        }
      }
      const olp = document.querySelector('.olpOfferPrice');
      return olp ? olp.textContent.trim() : null;
    });
    if (aodPrice) log('info', `AOD offer-listing price: "${aodPrice}"`);
    return aodPrice || null;
  } catch (err) {
    log('warn', `extractAODPrice error: ${err.message}`);
    return null;
  }
}

// ─────────────────────────────────────────────
// APPROACH 2: PUPPETEER STEALTH with UK proxy
//  - parseProxy() + page.authenticate()
//  - Homepage warmup + GBP cookies
//  - UK postcode setter (EC1A 1BB)
//  - CSA scroll trigger, waitForFunction
//  - OOS detection, AOD fallback
// ─────────────────────────────────────────────

// proxy param: pre-resolved { server, username, password } object, or null for direct.
// forceProxy is kept for callers that want random proxy selection (getProductDetails).
async function puppeteerScrape(url, { forceProxy = true, proxy: explicitProxy = undefined } = {}) {
  const ua = getUKUserAgent();
  // explicitProxy=undefined means "caller didn't specify" → use forceProxy logic
  // explicitProxy=null means "caller explicitly wants no proxy"
  const proxy = explicitProxy !== undefined
    ? explicitProxy
    : (forceProxy && USE_PROXIES ? await getUKProxy() : null);

  const launchArgs = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-blink-features=AutomationControlled',
    '--disable-infobars',
    '--disable-dev-shm-usage',
    '--window-size=1440,900',
    '--lang=en-GB',
    '--disable-notifications',
    '--no-first-run',
    '--no-default-browser-check',
    '--password-store=basic',
    '--use-mock-keychain',
  ];

  if (proxy) {
    launchArgs.push(`--proxy-server=${proxy.server}`);
    log('debug', `Using proxy: ${proxy.server}`);
  } else {
    log('debug', 'Using direct connection (no proxy)');
  }

  const browser = await puppeteer.launch({
    headless: true,
    args: launchArgs,
    ...(process.env.PUPPETEER_EXECUTABLE_PATH
      ? { executablePath: process.env.PUPPETEER_EXECUTABLE_PATH }
      : {}),
  });

  try {
    const page = await browser.newPage();

    if (proxy) {
      await page.authenticate({ username: proxy.username, password: proxy.password });
    }

    // Block images, fonts, media — reduces fingerprint surface and speeds up page load
    await page.setRequestInterception(true);
    page.on('request', req => {
      if (['image', 'stylesheet', 'font', 'media'].includes(req.resourceType())) {
        req.abort();
      } else {
        req.continue();
      }
    });

    await page.setUserAgent(ua);
    await page.setViewport({ width: 1440, height: 900 });
    await page.setExtraHTTPHeaders({
      'Accept-Language': 'en-GB,en;q=0.9',
      'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    });

    // Comprehensive automation signal masking
    await page.evaluateOnNewDocument(() => {
      // webdriver: undefined (not false) — real Chrome doesn't define this at all
      Object.defineProperty(navigator, 'webdriver',           { get: () => undefined });
      Object.defineProperty(navigator, 'plugins',             { get: () => [1, 2, 3, 4, 5] });
      Object.defineProperty(navigator, 'languages',           { get: () => ['en-GB', 'en'] });
      Object.defineProperty(navigator, 'platform',            { get: () => 'Win32' });
      Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8 });
      Object.defineProperty(navigator, 'deviceMemory',        { get: () => 8 });
      Object.defineProperty(navigator, 'maxTouchPoints',      { get: () => 0 });
      // Real Chrome chrome object (not just { runtime: {} })
      window.chrome = { runtime: {}, loadTimes: () => {}, csi: () => {}, app: {} };
      // Permissions API — headless Chrome returns 'denied'; spoof to 'default'
      const origQuery = window.navigator.permissions?.query?.bind(window.navigator.permissions);
      if (origQuery) {
        window.navigator.permissions.query = (params) =>
          params.name === 'notifications'
            ? Promise.resolve({ state: 'default' })
            : origQuery(params);
      }
    });

    // ── Session warm-up ──────────────────────────
    log('info', 'Warming up session on amazon.co.uk...');
    await page.goto('https://www.amazon.co.uk', {
      waitUntil: 'domcontentloaded',
      timeout:   20000,
    }).catch(() => {});

    // Set GBP + en_GB locale cookies
    await page.setCookie(
      { name: 'i18n-prefs', value: 'GBP',   domain: '.amazon.co.uk' },
      { name: 'lc-acbuk',   value: 'en_GB', domain: '.amazon.co.uk' },
    );

    // ── UK postcode setter ───────────────────────
    // Sets delivery location to London EC1A 1BB so
    // Amazon shows correct UK prices even with non-UK proxy
    try {
      await page.waitForSelector('#nav-global-location-popover-link', { timeout: 5000 });
      await page.click('#nav-global-location-popover-link');
      await page.waitForSelector('#GLUXZipUpdateInput', { timeout: 5000 });
      await page.type('#GLUXZipUpdateInput', 'EC1A 1BB');
      await page.click('[data-action="GLUXPostalUpdateAction"]');
      await randomDelay(1500, 2500);
      log('info', 'Delivery location set to UK (EC1A 1BB)');
    } catch {
      log('info', 'Could not set delivery location via popover — continuing anyway');
    }

    await randomDelay(1000, 2000);

    // ── Navigate to product page ─────────────────
    log('info', 'Navigating to product page...');
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    } catch (navErr) {
      const reason = navErr.message.split('\n')[0];
      log('warn', `Navigation failed: ${reason}`, { url });
      return { blocked: true, reason };
    }
    await randomDelay(2000, 4000);

    let html;
    try {
      html = await page.content();
    } catch (contentErr) {
      return { blocked: true, reason: contentErr.message.split('\n')[0] };
    }

    if (isCaptchaPage(html)) {
      log('warn', 'CAPTCHA detected');
      return { blocked: true, reason: 'captcha' };
    }
    if (isBlockedPage(html)) {
      log('warn', 'Block page detected');
      return { blocked: true, reason: 'blocked' };
    }

    // Scroll to activate Amazon's CSA lazy-rendered price widgets
    // (data-csa-c-is-in-initial-active-row="false" defers rendering until viewport scroll)
    await page.evaluate(() => window.scrollBy(0, Math.round(window.innerHeight * 0.3)));
    await new Promise(r => setTimeout(r, 800));

    // Wait for buy-box price digit OR confirmed "No featured offers" state (20s)
    await page.waitForFunction(() => {
      const BUYBOX_SELS = [
        '#corePriceDisplay_desktop_feature_div .a-price-whole',
        '#corePriceDisplay_desktop_feature_div .a-offscreen',
        '#corePriceDisplay_desktop_feature_div .aok-offscreen',
        '#corePrice_feature_div .a-offscreen',
        '#corePrice_feature_div .aok-offscreen',
        '.priceToPay .a-offscreen',
        '.priceToPay .aok-offscreen',
        '.apex-pricetopay-value .a-offscreen',
        '.apex-pricetopay-value .aok-offscreen',
        '#priceblock_ourprice',
        '#priceblock_dealprice',
      ];
      for (const sel of BUYBOX_SELS) {
        const el = document.querySelector(sel);
        // Skip elements inside the AOD panel (apex_dp_aod CSA slot)
        if (el && !el.closest('[data-csa-c-slot-id="apex_dp_aod"]') && /\d/.test(el.textContent)) return true;
      }
      const hasUnqualified = !!document.querySelector('#unqualifiedBuyBox');
      const hasQualified   = !!(
        document.querySelector('#desktop_qualifiedBuyBox') ||
        document.querySelector('#corePriceDisplay_desktop_feature_div') ||
        document.querySelector('#apex_offerDisplay_desktop')
      );
      if (hasUnqualified && !hasQualified) return true;
      return false;
    }, { timeout: 20000 }).catch(() => {
      log('warn', 'Buy-box price not populated after 20s — proceeding anyway');
    });

    // Re-capture HTML after scroll + CSA render
    html = await page.content().catch(() => html);

    // ── DOM extraction ───────────────────────────
    const domData = await page.evaluate(() => {
      const getText = (...sels) => {
        for (const sel of sels) {
          const el = document.querySelector(sel);
          if (el) {
            const t = el.innerText?.trim() || el.textContent?.trim();
            if (t) return t;
          }
        }
        return '';
      };

      // Priority 0: hidden twister price input — machine-readable, no layout ambiguity
      let price = '';
      const twisterInput = document.querySelector('input#twister-plus-price-data-price');
      if (twisterInput && parseFloat(twisterInput.value) > 0) price = twisterInput.value;

      // Whole + fraction from buy-box (skip AOD panel)
      if (!price) {
      for (const sel of [
        '#corePriceDisplay_desktop_feature_div .a-price-whole',
        '.apex-pricetopay-value .a-price-whole',
        '.priceToPay .a-price-whole',
      ]) {
        const whole = document.querySelector(sel);
        if (whole && !whole.closest('[data-csa-c-slot-id="apex_dp_aod"]')) {
          const w = whole.textContent.replace(/[^0-9]/g, '');
          const frac = whole.closest('.a-price')?.querySelector('.a-price-fraction');
          const f = frac ? frac.textContent.replace(/[^0-9]/g, '') : '00';
          if (w) { price = `${w}.${f}`; break; }
        }
      }
      } // end !price (twister short-circuit)

      // Offscreen span fallback (buy-box only)
      if (!price) {
        for (const sel of [
          '#corePriceDisplay_desktop_feature_div .aok-offscreen',
          '#corePriceDisplay_desktop_feature_div .a-offscreen',
          '#corePrice_feature_div .aok-offscreen',
          '#corePrice_feature_div .a-offscreen',
          '.priceToPay .aok-offscreen',
          '.priceToPay .a-offscreen',
          '#priceblock_ourprice',
          '#priceblock_dealprice',
        ]) {
          const el = document.querySelector(sel);
          if (el && !el.closest('[data-csa-c-slot-id="apex_dp_aod"]')) {
            const t = el.innerText?.trim() || el.textContent?.trim();
            if (t && /\d/.test(t)) { price = t; break; }
          }
        }
      }

      // Deal layout: .apex-pricetopay-value outside AOD
      if (!price) {
        for (const el of document.querySelectorAll('.apex-pricetopay-value .aok-offscreen, .apex-pricetopay-value .a-offscreen')) {
          if (!el.closest('[data-csa-c-slot-id="apex_dp_aod"]')) {
            const t = el.innerText?.trim() || el.textContent?.trim();
            if (t && /\d/.test(t)) { price = t; break; }
          }
        }
      }

      // Availability & OOS
      const availText = getText('#availability span', '#availability');
      const isDeliveryRestriction = (
        /cannot be dispatched/i.test(availText) ||
        /not available.*delivery/i.test(availText) ||
        /not available.*location/i.test(availText)
      );
      const outOfStock = !isDeliveryRestriction && (
        /currently unavailable/i.test(availText) ||
        /temporarily out of stock/i.test(availText) ||
        /out of stock/i.test(availText) ||
        /don't know when or if/i.test(availText) ||
        /this item is currently unavailable/i.test(availText)
      );

      // "No featured offers" state — unqualified box, no standard buy-box container
      const isNoFeaturedOffers = (
        !!document.querySelector('#unqualifiedBuyBox') &&
        !document.querySelector('#desktop_qualifiedBuyBox, #corePriceDisplay_desktop_feature_div, #apex_offerDisplay_desktop')
      );

      // Try AOD panel already embedded on this page (#aod-price-1 via apex_dp_aod widget)
      let aodPriceOnPage = '';
      if (!price && isNoFeaturedOffers) {
        const aodWhole = document.querySelector('#aod-price-1 .a-price-whole');
        if (aodWhole) {
          const w = aodWhole.textContent.replace(/[^0-9]/g, '');
          const frac = aodWhole.closest('.a-price')?.querySelector('.a-price-fraction');
          const f = frac ? frac.textContent.replace(/[^0-9]/g, '') : '00';
          if (w) aodPriceOnPage = `${w}.${f}`;
        }
        if (!aodPriceOnPage) {
          const aodEl = document.querySelector(
            '#aod-price-1 .aok-offscreen, #aod-price-1 .a-offscreen, ' +
            '#aod-price-1 .apex-pricetopay-accessibility-label'
          );
          if (aodEl) {
            const t = aodEl.innerText?.trim() || aodEl.textContent?.trim();
            if (t && /\d/.test(t)) aodPriceOnPage = t;
          }
        }
      }

      return {
        price,
        aodPriceOnPage,
        isNoFeaturedOffers,
        outOfStock,
        title:        getText('#productTitle'),
        rating:       getText('.a-icon-alt'),
        reviewCount:  getText('#acrCustomerReviewText'),
        availability: availText,
        image:        document.querySelector('#landingImage')?.src || document.querySelector('#imgBlkFront')?.src || '',
        brand:        getText('#bylineInfo'),
        sellerName:   getText('#sellerProfileTriggerId') || 'Amazon',
      };
    });

    // ── Out-of-stock short-circuit ───────────────
    if (domData.outOfStock) {
      log('info', 'Product is out of stock on Amazon', { url });
      return {
        blocked:      false,
        price:        null,
        inStock:      false,
        title:        domData.title,
        availability: domData.availability,
        image:        domData.image,
        brand:        domData.brand,
        sellerName:   domData.sellerName,
      };
    }

    // ── AOD price already on page (apex_dp_aod widget) ──
    if (domData.aodPriceOnPage) {
      const aodFinal = parsePrice(domData.aodPriceOnPage);
      if (aodFinal) {
        log('info', `AOD price found on product page: £${aodFinal}`, { url });
        return {
          blocked:      false,
          price:        aodFinal,
          priceSource:  'aod_on_page',
          inStock:      true,
          title:        domData.title,
          availability: domData.availability,
          image:        domData.image,
          brand:        domData.brand,
          sellerName:   domData.sellerName,
        };
      }
    }

    // ── Smart extraction on rendered HTML ─────────
    const $ = cheerio.load(html);
    const smartResult = smartExtractPrice($, html);

    // ── AOD offer-listing fallback ────────────────
    if (!domData.price && domData.isNoFeaturedOffers) {
      const rawAod = await extractAODPrice(page, url);
      if (rawAod) {
        const aodFinal = parsePrice(rawAod);
        if (aodFinal) {
          log('info', `AOD offer-listing price: £${aodFinal}`, { url });
          return {
            blocked:      false,
            price:        aodFinal,
            priceSource:  'aod_offer_listing',
            inStock:      true,
            title:        domData.title,
            availability: domData.availability,
            image:        domData.image,
            brand:        domData.brand,
            sellerName:   domData.sellerName,
          };
        }
      }
    }

    const { finalPrice, priceSource } = mergePrice({
      cssPrice:    domData.price,
      smartResult,
      context:     'dom',
      url,
    });

    if (!finalPrice && !domData.title) {
      return { blocked: true, reason: 'no_data_extracted' };
    }

    return {
      blocked:         false,
      price:           finalPrice,
      priceSource,
      priceConfidence: smartResult.confidence,
      inStock:         true,
      title:           domData.title,
      rating:          domData.rating,
      reviewCount:     domData.reviewCount,
      availability:    domData.availability,
      image:           domData.image,
      brand:           domData.brand,
      sellerName:      domData.sellerName,
    };

  } finally {
    await browser.close();
  }
}

// ─────────────────────────────────────────────
// CORE: getProductDetails
// Strategy:
//   1. Cheerio + UK proxy (fast, no browser)
//   2. Puppeteer + UK proxy + session warmup
//   3. Puppeteer direct (no proxy)
//   Progressive backoff between retries.
// URL uses th=1&currency=GBP (your addition).
// ─────────────────────────────────────────────

export async function getProductDetails(asin, { maxRetries = 3 } = {}) {
  // th=1 forces base product (not variant), currency=GBP ensures GBP pricing
  const url = `https://www.amazon.co.uk/dp/${asin}?th=1&currency=GBP`;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    log('info', `ASIN ${asin} attempt ${attempt}/${maxRetries}`, { asin });

    try {
      // ── Step 0: Twister AJAX (fastest — Amazon's own price API) ──
      log('info', 'Step 0: Twister AJAX price endpoint', { asin });
      const twisterResult = await fetchTwisterPrice(asin);
      if (twisterResult) {
        if (twisterResult.price) {
          log('info', `Twister success: £${twisterResult.price}`, { asin, price: twisterResult.price });
          return { asin, url, price: twisterResult.price, priceSource: 'twister_ajax', inStock: true, method: 'twister_ajax' };
        }
      }
      log('info', 'Twister returned no data — trying HTML scrape', { asin });

      // ── Step 1: Cheerio (fast) ────────────────
      log('info', 'Step 1: Cheerio scrape', { asin });
      const cheerioResult = await cheerioScrape(url);

      if (!cheerioResult.blocked && !cheerioResult.needsBrowser && cheerioResult.price) {
        log('info', `Cheerio success: £${cheerioResult.price} (source: ${cheerioResult.priceSource})`, { asin, price: cheerioResult.price });
        return { asin, url, ...cheerioResult, method: 'cheerio' };
      }

      const reason = cheerioResult.blocked
        ? `blocked (${cheerioResult.reason})`
        : cheerioResult.needsBrowser
          ? 'price needs JS rendering'
          : 'no price found';
      log('warn', `Cheerio failed: ${reason} → trying Puppeteer with UK proxy`, { asin });
      await randomDelay(2000, 4000);

      // ── Step 2: Puppeteer + UK proxy ──────────
      log('info', 'Step 2: Puppeteer + UK proxy + session warmup', { asin });
      const puppeteerResult = await puppeteerScrape(url, { forceProxy: true });

      if (!puppeteerResult.blocked && puppeteerResult.price) {
        log('info', `Puppeteer (proxy) success: £${puppeteerResult.price} (source: ${puppeteerResult.priceSource})`, { asin, price: puppeteerResult.price });
        return { asin, url, ...puppeteerResult, method: 'puppeteer_proxy' };
      }

      log('warn', `Puppeteer (proxy) failed: ${puppeteerResult.reason} → trying direct`, { asin });
      await randomDelay(3000, 6000);

      // ── Step 3: Puppeteer direct ──────────────
      log('info', 'Step 3: Puppeteer direct connection (no proxy)', { asin });
      const directResult = await puppeteerScrape(url, { forceProxy: false });

      if (!directResult.blocked && directResult.price) {
        log('info', `Puppeteer (direct) success: £${directResult.price} (source: ${directResult.priceSource})`, { asin, price: directResult.price });
        return { asin, url, ...directResult, method: 'puppeteer_direct' };
      }

      log('warn', `All methods blocked on attempt ${attempt}`, { asin });

      if (attempt < maxRetries) {
        const wait = attempt * 20000; // 20s, 40s progressive backoff
        log('info', `Waiting ${wait / 1000}s before retry ${attempt + 1}`, { asin });
        await new Promise(r => setTimeout(r, wait));
      }

    } catch (err) {
      log('error', `Error on attempt ${attempt}: ${err.message}`, { asin });
      if (attempt < maxRetries) {
        await randomDelay(10000, 20000);
      }
    }
  }

  log('error', `Max retries exceeded for ASIN ${asin}`, { asin });
  return { asin, url, price: null, error: 'max_retries_exceeded' };
}

// ─────────────────────────────────────────────
// WORKER HELPERS
// Split scraping into two tiers for the BullMQ
// worker pool:
//   scrapeProductFast  — Twister + Cheerio only
//   scrapeProductSlow  — Puppeteer only
// ─────────────────────────────────────────────

export async function scrapeProductFast(asin) {
  const url = `https://www.amazon.co.uk/dp/${asin}?th=1&currency=GBP`;

  // Step 0: Twister AJAX
  const twisterResult = await fetchTwisterPrice(asin);

  if (twisterResult?.price)
    return { asin, url, price: twisterResult.price, priceSource: 'twister_ajax', inStock: true, method: 'twister_ajax' };

  if (twisterResult?.responded) {
    // Twister reached Amazon and got a valid response but found no price.
    // Treat as OOS — no point launching an expensive browser session.
    return { asin, url, price: null, inStock: false, method: 'twister_no_price' };
  }

  // twisterResult === null: Twister failed entirely (all proxies returned HTTP errors /
  // network errors). Fall through to Cheerio, then escalate only if Cheerio also fails.

  // Step 1: Cheerio HTML
  const cheerioResult = await cheerioScrape(url);
  if (!cheerioResult.blocked && !cheerioResult.needsBrowser && cheerioResult.price)
    return { asin, url, ...cheerioResult, method: 'cheerio' };
  if (cheerioResult.inStock === false)
    return { asin, url, price: null, inStock: false, method: 'cheerio' };

  // Both Twister and Cheerio failed — signal worker to escalate to slow queue (Puppeteer)
  return { asin, url, needsBrowser: true };
}

export async function scrapeProductSlow(asin) {
  const url = `https://www.amazon.co.uk/dp/${asin}?th=1&currency=GBP`;

  // Rotate through up to 3 random proxies on CAPTCHA instead of giving up immediately.
  // Each attempt uses a fresh browser + different IP, giving Amazon a new session to evaluate.
  const pool = await getProxies();
  const proxiesToTry = pool.length > 0
    ? [...pool].sort(() => Math.random() - 0.5).slice(0, 3).map(parseProxy)
    : [];

  for (let i = 0; i < proxiesToTry.length; i++) {
    const result = await puppeteerScrape(url, { proxy: proxiesToTry[i] });
    if (!result.blocked && result.price)
      return { asin, url, ...result, method: 'puppeteer_proxy' };
    if (result.inStock === false)
      return { asin, url, price: null, inStock: false, method: 'puppeteer_proxy' };
    // Only retry with a different proxy if the failure was CAPTCHA/block.
    // Navigation errors or missing prices don't benefit from an IP swap.
    if (result.reason !== 'captcha' && result.reason !== 'blocked') break;
    log('warn', `Puppeteer CAPTCHA on proxy ${i + 1}/3 — rotating to next proxy`, { asin });
  }

  // Final fallback: VPS direct IP (no proxy)
  await new Promise(r => setTimeout(r, 3000));
  const directResult = await puppeteerScrape(url, { proxy: null });
  if (!directResult.blocked && directResult.price)
    return { asin, url, ...directResult, method: 'puppeteer_direct' };
  if (directResult.inStock === false)
    return { asin, url, price: null, inStock: false, method: 'puppeteer_direct' };

  return { asin, url, price: null, error: 'all_methods_failed' };
}

// ─────────────────────────────────────────────
// CORE: getAllSellers
// Scrapes Amazon's offer listing page for ALL
// third-party sellers — sorted cheapest first.
// parseProxy() + page.authenticate() preserved.
// ─────────────────────────────────────────────

export async function getAllSellers(asin, { maxRetries = 3 } = {}) {
  const url = `https://www.amazon.co.uk/gp/offer-listing/${asin}?condition=new`;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      log('info', `getAllSellers: ASIN ${asin} attempt ${attempt}/${maxRetries}`, { asin });

      const ua    = getRandomUserAgent();
      const proxy = USE_PROXIES ? await getRandomProxy() : null;

      const launchArgs = [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-blink-features=AutomationControlled',
      ];

      if (proxy) {
        launchArgs.push(`--proxy-server=${proxy.server}`);
      }

      const browser = await puppeteer.launch({
    headless: true,
    args: launchArgs,
    ...(process.env.PUPPETEER_EXECUTABLE_PATH
      ? { executablePath: process.env.PUPPETEER_EXECUTABLE_PATH }
      : {}),
  });

      try {
        const page = await browser.newPage();

        // Proper proxy auth (your fix preserved)
        if (proxy) {
          await page.authenticate({ username: proxy.username, password: proxy.password });
        }

        await page.setUserAgent(ua);
        await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-GB,en;q=0.9' });
        await page.evaluateOnNewDocument(() => {
          Object.defineProperty(navigator, 'webdriver', { get: () => false });
        });

        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await randomDelay(2000, 4000);

        const html = await page.content();
        if (isCaptchaPage(html)) {
          log('warn', `getAllSellers: CAPTCHA on attempt ${attempt}`, { asin });
          await browser.close();
          await new Promise(r => setTimeout(r, attempt * 15000));
          continue;
        }

        await page.waitForSelector('.a-row.olpOffer, #aod-offer', { timeout: 8000 }).catch(() => {});

        const sellers = await page.evaluate(() => {
          const offerRows = document.querySelectorAll('.a-row.olpOffer, #aod-offer');

          return Array.from(offerRows).map(row => {
            const priceEl =
              row.querySelector('.olpOfferPrice') ||
              row.querySelector('#aod-price-1') ||
              row.querySelector('.a-price .aok-offscreen') ||  // new layout
              row.querySelector('.a-price .a-offscreen');

            const sellerEl =
              row.querySelector('.olpSellerName a') ||
              row.querySelector('#aod-offer-soldBy a') ||
              row.querySelector('.a-col-right .a-link-normal');

            const ratingEl   = row.querySelector('.a-icon-alt');
            const shippingEl =
              row.querySelector('.olpShippingInfo') ||
              row.querySelector('#mir-layout-DELIVERY_BLOCK');

            const isPrime = !!row.querySelector('.a-icon-prime');

            return {
              sellerName: sellerEl?.innerText?.trim() || 'Amazon',
              sellerUrl:  sellerEl?.href || null,
              price:      priceEl?.innerText?.trim() || null,
              shipping:   shippingEl?.innerText?.trim() || 'See listing',
              rating:     ratingEl?.innerText?.trim() || null,
              isPrime,
              condition:  row.querySelector('.olpCondition')?.innerText?.trim() || 'New',
            };
          });
        });

        await browser.close();

        const parsed = sellers
          .map((s, i) => ({
            rank:       i + 1,
            sellerName: s.sellerName,
            sellerUrl:  s.sellerUrl,
            price:      parsePrice(s.price),
            rawPrice:   s.price,
            shipping:   s.shipping,
            rating:     s.rating,
            isPrime:    s.isPrime,
            condition:  s.condition,
            listingUrl: `https://www.amazon.co.uk/dp/${asin}`,
            offersUrl:  url,
          }))
          .filter(s => s.price !== null)
          .sort((a, b) => a.price - b.price)
          .map((s, i) => ({ ...s, rank: i + 1 }));

        log('info', `getAllSellers: Found ${parsed.length} sellers for ${asin}`, { asin, count: parsed.length });
        return { asin, sellers: parsed, scrapedAt: new Date().toISOString() };

      } catch (innerErr) {
        await browser.close();
        throw innerErr;
      }

    } catch (err) {
      log('error', `getAllSellers: Attempt ${attempt} failed: ${err.message}`, { asin });
      if (attempt < maxRetries) {
        await randomDelay(10000, 20000);
      }
    }
  }

  return { asin, sellers: [], error: 'max_retries_exceeded' };
}

// ─────────────────────────────────────────────
// BATCH: scrape multiple ASINs with staggered
// delays to avoid Amazon rate limiting
// ─────────────────────────────────────────────

export async function batchGetProductDetails(asins, { delayBetween = [8000, 15000] } = {}) {
  const results = [];

  for (let i = 0; i < asins.length; i++) {
    const asin = asins[i];
    log('info', `Batch processing ${i + 1}/${asins.length}: ${asin}`, { asin });

    const result = await getProductDetails(asin);
    results.push(result);

    if (i < asins.length - 1) {
      const wait = Math.floor(Math.random() * (delayBetween[1] - delayBetween[0])) + delayBetween[0];
      log('info', `Batch: waiting ${(wait / 1000).toFixed(1)}s before next ASIN`);
      await new Promise(r => setTimeout(r, wait));
    }
  }

  return results;
}