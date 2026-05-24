/**
 * amazonScraper.js
 * ─────────────────────────────────────────────────────────────
 * Full Amazon UK scraper with:
 *  - Stealth Puppeteer (evades bot detection)
 *  - Proxy rotation
 *  - CAPTCHA detection + retry
 *  - Product details scraping
 *  - All-sellers / multi-supplier scraping
 *  - Cheerio fallback (lightweight HTTP attempt first)
 * ─────────────────────────────────────────────────────────────
 * Install deps:
 *   npm install puppeteer puppeteer-extra puppeteer-extra-plugin-stealth
 *               cheerio node-fetch user-agents
 */

import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import * as cheerio from 'cheerio';
import fetch from 'node-fetch';
import UserAgent from 'user-agents';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

puppeteer.use(StealthPlugin());

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOG_FILE = path.join(__dirname, 'scraper.log');

// ─────────────────────────────────────────────
// SCRAPER LOGGING
// ─────────────────────────────────────────────

export const scraperLogs = [];  // in-memory ring buffer (last 200 entries)

function log(level, message, meta = {}) {
  const entry = { ts: new Date().toISOString(), level, message, ...meta };
  scraperLogs.unshift(entry);
  if (scraperLogs.length > 200) scraperLogs.pop();
  const line = `[${entry.ts}] [${level.toUpperCase()}] ${message}${Object.keys(meta).length ? ' ' + JSON.stringify(meta) : ''}`;
  console.log(line);
  try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch {}
}

// ─────────────────────────────────────────────
// PROXY CONFIGURATION
// Format: 'http://username:password@host:port'
// ─────────────────────────────────────────────
const PROXIES = [
  'http://jfpjlckn:ct0juhzdncha@45.38.107.97:6014',
  'http://jfpjlckn:ct0juhzdncha@198.105.121.200:6462',
  'http://jfpjlckn:ct0juhzdncha@142.111.48.253:7030',
  'http://jfpjlckn:ct0juhzdncha@23.95.150.145:6114',
  'http://jfpjlckn:ct0juhzdncha@38.154.203.95:5863',
  'http://jfpjlckn:ct0juhzdncha@198.23.243.226:6361',
  'http://jfpjlckn:ct0juhzdncha@84.247.60.125:6095',
  'http://jfpjlckn:ct0juhzdncha@23.27.208.120:5830',
  'http://jfpjlckn:ct0juhzdncha@23.229.19.94:8689',
  'http://jfpjlckn:ct0juhzdncha@2.57.20.2:6983',
];

const USE_PROXIES = PROXIES.length > 0;

// ─────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────

function getRandomProxy() {
  const raw = PROXIES[Math.floor(Math.random() * PROXIES.length)];
  const url = new URL(raw);
  return {
    server: `${url.protocol}//${url.hostname}:${url.port}`,
    username: url.username,
    password: url.password,
  };
}

function getRandomUserAgent() {
  return new UserAgent({ deviceCategory: 'desktop' }).toString();
}

function randomDelay(minMs = 2000, maxMs = 6000) {
  const ms = Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
  return new Promise(r => setTimeout(r, ms));
}

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
    html.includes('robot')
  );
}

function isBlockedPage(html) {
  return (
    html.includes('Request blocked') ||
    html.includes('503 Service Unavailable') ||
    html.length < 5000   // suspiciously short = likely an error page
  );
}

// ─────────────────────────────────────────────
// APPROACH 1: CHEERIO (fast, lightweight)
// Tried first — saves time and resources.
// Falls back to Puppeteer if blocked.
// ─────────────────────────────────────────────

async function cheerioScrape(url) {
  const ua = getRandomUserAgent();

  const fetchOptions = {
    headers: {
      'User-Agent': ua,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
      'Accept-Language': 'en-GB,en;q=0.9',
      'Accept-Encoding': 'gzip, deflate, br',
      'Connection': 'keep-alive',
      'Upgrade-Insecure-Requests': '1',
      'Cache-Control': 'max-age=0',
    },
    timeout: 15000,
  };

  const res = await fetch(url, fetchOptions);
  const html = await res.text();

  if (isCaptchaPage(html) || isBlockedPage(html)) {
    return { blocked: true, html };
  }

  const $ = cheerio.load(html);

  // Amazon uses multiple price selectors depending on page type
  const price =
    $('.a-price .a-offscreen').first().text() ||
    $('#priceblock_ourprice').text() ||
    $('#priceblock_dealprice').text() ||
    $('#priceblock_saleprice').text() ||
    $('.a-price[data-a-color="price"] .a-offscreen').first().text() ||
    $('span.a-offscreen').first().text();

  const title = $('#productTitle').text().trim();
  const rating = $('.a-icon-alt').first().text().trim();
  const reviewCount = $('#acrCustomerReviewText').first().text().trim();
  const availability = $('#availability span').first().text().trim();
  const image = $('#landingImage').attr('src') || $('#imgBlkFront').attr('src');
  const brand = $('#bylineInfo').text().trim();
  const seller = $('#sellerProfileTriggerId').text().trim() || 'Amazon';

  return {
    blocked: false,
    price: parsePrice(price),
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
// APPROACH 2: PUPPETEER STEALTH (full browser)
// Used when Cheerio is blocked.
// ─────────────────────────────────────────────

async function puppeteerScrape(url, { useProxy = USE_PROXIES } = {}) {
  const ua = getRandomUserAgent();

  const launchArgs = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-blink-features=AutomationControlled',
    '--disable-infobars',
    '--window-size=1366,768',
  ];

  let proxyAuth = null;
  if (useProxy && USE_PROXIES) {
    const proxy = getRandomProxy();
    launchArgs.push(`--proxy-server=${proxy.server}`);
    proxyAuth = { username: proxy.username, password: proxy.password };
    log('debug', 'Using proxy', { server: proxy.server });
  } else {
    log('debug', 'Using direct connection (no proxy)');
  }

  const browser = await puppeteer.launch({
    headless: true,
    args: launchArgs,
  });

  try {
    const page = await browser.newPage();

    if (proxyAuth) await page.authenticate(proxyAuth);

    await page.setUserAgent(ua);
    await page.setViewport({ width: 1366, height: 768 });
    await page.setExtraHTTPHeaders({
      'Accept-Language': 'en-GB,en;q=0.9',
    });

    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
    });

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

    // Small human-like pause
    await randomDelay(1500, 3000);

    const html = await page.content();

    if (isCaptchaPage(html)) {
      return { blocked: true, reason: 'captcha' };
    }

    // Wait for price to render (JS-driven)
    await page.waitForSelector('.a-price', { timeout: 8000 }).catch(() => {});

    const data = await page.evaluate(() => {
      const getText = sel => document.querySelector(sel)?.innerText?.trim() || '';
      const getAttr = (sel, attr) => document.querySelector(sel)?.[attr] || '';

      return {
        price:
          getText('.a-price .a-offscreen') ||
          getText('#priceblock_ourprice') ||
          getText('#priceblock_dealprice'),
        title: getText('#productTitle'),
        rating: getText('.a-icon-alt'),
        reviewCount: getText('#acrCustomerReviewText'),
        availability: getText('#availability span'),
        image: getAttr('#landingImage', 'src'),
        brand: getText('#bylineInfo'),
        sellerName: getText('#sellerProfileTriggerId') || 'Amazon',
      };
    });

    return {
      blocked: false,
      price: parsePrice(data.price),
      title: data.title,
      rating: data.rating,
      reviewCount: data.reviewCount,
      availability: data.availability,
      image: data.image,
      brand: data.brand,
      sellerName: data.sellerName,
    };
  } finally {
    await browser.close();
  }
}

// ─────────────────────────────────────────────
// CORE: getProductDetails
// Tries Cheerio first → falls back to Puppeteer
// Retries up to maxRetries times on block/failure
// ─────────────────────────────────────────────

export async function getProductDetails(asin, { maxRetries = 3 } = {}) {
  const url = `https://www.amazon.co.uk/dp/${asin}`;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      // 1. Cheerio (fastest, no browser)
      log('info', 'Scrape attempt (Cheerio)', { asin, attempt, maxRetries });
      const cheerioResult = await cheerioScrape(url);
      if (!cheerioResult.blocked && cheerioResult.price) {
        log('info', 'Cheerio success', { asin, price: cheerioResult.price });
        return { asin, url, ...cheerioResult, method: 'cheerio' };
      }
      log('info', 'Cheerio blocked, trying Puppeteer (no proxy)', { asin });

      // 2. Puppeteer stealth WITHOUT proxy — direct IPs are less suspicious than datacenter proxies
      await randomDelay(2000, 4000);
      const directResult = await puppeteerScrape(url, { useProxy: false });
      if (!directResult.blocked && directResult.price) {
        log('info', 'Puppeteer (direct) success', { asin, price: directResult.price });
        return { asin, url, ...directResult, method: 'puppeteer-direct' };
      }
      log('info', 'Puppeteer direct blocked, trying with proxy', { asin });

      // 3. Puppeteer WITH proxy as last resort
      if (USE_PROXIES) {
        await randomDelay(2000, 4000);
        const proxyResult = await puppeteerScrape(url, { useProxy: true });
        if (!proxyResult.blocked && proxyResult.price) {
          log('info', 'Puppeteer (proxy) success', { asin, price: proxyResult.price });
          return { asin, url, ...proxyResult, method: 'puppeteer-proxy' };
        }
      }

      log('warn', 'All methods blocked', { asin, attempt });
      if (attempt < maxRetries) {
        const wait = attempt * 15000;
        log('info', 'Backoff before retry', { asin, waitSeconds: wait / 1000 });
        await new Promise(r => setTimeout(r, wait));
      }

    } catch (err) {
      log('error', 'Scrape attempt error', { asin, attempt, error: err.message });
      if (attempt < maxRetries) await randomDelay(5000, 10000);
    }
  }

  log('error', 'Max retries exceeded', { asin });
  return { asin, url, price: null, error: 'max_retries_exceeded' };
}

// ─────────────────────────────────────────────
// CORE: getAllSellers
// Scrapes Amazon's offer listing page for ALL
// third-party sellers of an ASIN — sorted by
// price ascending (cheapest first)
// ─────────────────────────────────────────────

export async function getAllSellers(asin, { maxRetries = 3 } = {}) {
  const productUrl = `https://www.amazon.co.uk/dp/${asin}`;
  const offersUrl = `https://www.amazon.co.uk/gp/offer-listing/${asin}?condition=new`;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      log('info', `Sellers scrape started`, { asin, attempt, maxRetries });

      const ua = getRandomUserAgent();
      const launchArgs = [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-blink-features=AutomationControlled',
      ];

      let proxyAuth = null;
      if (USE_PROXIES) {
        const proxy = getRandomProxy();
        launchArgs.push(`--proxy-server=${proxy.server}`);
        proxyAuth = { username: proxy.username, password: proxy.password };
        log('debug', 'Using proxy', { server: proxy.server });
      }

      const browser = await puppeteer.launch({ headless: true, args: launchArgs });

      try {
        const page = await browser.newPage();
        if (proxyAuth) await page.authenticate(proxyAuth);
        await page.setUserAgent(ua);
        await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-GB,en;q=0.9' });
        await page.evaluateOnNewDocument(() => {
          Object.defineProperty(navigator, 'webdriver', { get: () => false });
        });

        log('info', 'Navigating to product page', { asin, url: productUrl });
        await page.goto(productUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await randomDelay(1500, 3000);

        let html = await page.content();
        if (isCaptchaPage(html)) {
          log('warn', 'CAPTCHA detected on product page', { asin, attempt });
          await browser.close();
          await new Promise(r => setTimeout(r, attempt * 15000));
          continue;
        }

        const aodTriggered = await page.evaluate(() => {
          const link =
            document.querySelector('#aod-ingress-link') ||
            document.querySelector('a[href*="offer-listing"]') ||
            document.querySelector('#moreBuyingChoices_feature_div a') ||
            document.querySelector('.olp-link') ||
            document.querySelector('[data-action="show-all-offers-display"] a');
          if (link) { link.click(); return true; }
          return false;
        });

        if (aodTriggered) {
          log('info', 'AOD drawer triggered, waiting for offers', { asin });
          await page.waitForSelector('#aod-offer', { timeout: 10000 }).catch(() => {});
          await randomDelay(1000, 2000);
        } else {
          log('info', 'AOD trigger not found, falling back to offer-listing page', { asin });
          await page.goto(offersUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
          await randomDelay(2000, 4000);
          await page.waitForSelector('.a-row.olpOffer, #aod-offer', { timeout: 8000 }).catch(() => {});
        }

        html = await page.content();
        if (isCaptchaPage(html)) {
          log('warn', 'CAPTCHA detected after navigation', { asin, attempt });
          await browser.close();
          await new Promise(r => setTimeout(r, attempt * 15000));
          continue;
        }

        const sellers = await page.evaluate(() => {
          // AOD sidebar (modern layout)
          const aodOffers = document.querySelectorAll('#aod-offer');
          if (aodOffers.length > 0) {
            return Array.from(aodOffers).map(row => {
              const priceWhole = row.querySelector('.a-price-whole')?.innerText?.trim() || '';
              const priceFrac  = row.querySelector('.a-price-fraction')?.innerText?.trim() || '';
              const priceRaw   = priceWhole ? `£${priceWhole}.${priceFrac}` : (row.querySelector('.a-price .a-offscreen')?.innerText?.trim() || null);

              const sellerEl  = row.querySelector('#aod-offer-soldBy a') || row.querySelector('.a-col-right .a-link-normal');
              const shippingEl = row.querySelector('#mir-layout-DELIVERY_BLOCK') || row.querySelector('.a-color-secondary');
              const isPrime   = !!row.querySelector('.a-icon-prime');

              return {
                sellerName: sellerEl?.innerText?.trim() || 'Amazon',
                sellerUrl:  sellerEl?.href || null,
                price:      priceRaw,
                shipping:   shippingEl?.innerText?.trim() || 'See listing',
                rating:     null,
                isPrime,
                condition:  'New',
              };
            });
          }

          // Old offer-listing page layout fallback
          const olpOffers = document.querySelectorAll('.a-row.olpOffer');
          return Array.from(olpOffers).map(row => {
            const priceEl   = row.querySelector('.olpOfferPrice') || row.querySelector('.a-price .a-offscreen');
            const sellerEl  = row.querySelector('.olpSellerName a');
            const shippingEl = row.querySelector('.olpShippingInfo');
            const isPrime   = !!row.querySelector('.a-icon-prime');

            return {
              sellerName: sellerEl?.innerText?.trim() || 'Amazon',
              sellerUrl:  sellerEl?.href || null,
              price:      priceEl?.innerText?.trim() || null,
              shipping:   shippingEl?.innerText?.trim() || 'See listing',
              rating:     row.querySelector('.a-icon-alt')?.innerText?.trim() || null,
              isPrime,
              condition:  row.querySelector('.olpCondition')?.innerText?.trim() || 'New',
            };
          });
        });

        await browser.close();

        const parsed = sellers
          .map((s, i) => ({
            rank: i + 1,
            sellerName: s.sellerName,
            sellerUrl: s.sellerUrl,
            price: parsePrice(s.price),
            rawPrice: s.price,
            shipping: s.shipping,
            rating: s.rating,
            isPrime: s.isPrime,
            condition: s.condition,
            listingUrl: productUrl,
            offersUrl,
          }))
          .filter(s => s.price !== null)
          .sort((a, b) => a.price - b.price)
          .map((s, i) => ({ ...s, rank: i + 1 }));

        log('info', `Sellers found`, { asin, count: parsed.length });
        return { asin, sellers: parsed, scrapedAt: new Date().toISOString() };

      } catch (innerErr) {
        await browser.close();
        throw innerErr;
      }

    } catch (err) {
      log('error', `Sellers attempt failed`, { asin, attempt, error: err.message });
      if (attempt < maxRetries) {
        await randomDelay(10000, 20000);
      }
    }
  }

  log('error', 'Sellers max retries exceeded', { asin });
  return { asin, sellers: [], error: 'max_retries_exceeded' };
}

// ─────────────────────────────────────────────
// BATCH: scrape multiple ASINs with staggered delays
// ─────────────────────────────────────────────

export async function batchGetProductDetails(asins, { delayBetween = [8000, 15000] } = {}) {
  const results = [];

  for (let i = 0; i < asins.length; i++) {
    const asin = asins[i];
    log('info', `Batch processing`, { index: i + 1, total: asins.length, asin });

    const result = await getProductDetails(asin);
    results.push(result);

    if (i < asins.length - 1) {
      const wait = Math.floor(Math.random() * (delayBetween[1] - delayBetween[0])) + delayBetween[0];
      log('info', `Batch delay`, { seconds: (wait / 1000).toFixed(1) });
      await new Promise(r => setTimeout(r, wait));
    }
  }

  return results;
}
