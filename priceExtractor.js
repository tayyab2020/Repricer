/**
 * priceExtractor.js
 * ─────────────────────────────────────────────────────────────
 * Self-healing Amazon UK price extractor.
 *
 * Uses 5 completely independent extraction methods in parallel.
 * If Amazon changes their HTML, at least 2-3 methods still work.
 * Includes a confidence scoring system — highest confidence wins.
 * Includes a daily health check that alerts you before jobs break.
 *
 * Methods:
 *   1. CSS Selectors      — current known selectors (breaks first when Amazon updates)
 *   2. JSON-LD            — structured data Amazon embeds for Google (very stable)
 *   3. Raw HTML Regex     — finds price patterns directly in source (layout-agnostic)
 *   4. JS State Object    — extracts from Amazon's React/JS state dump in <script> tags
 *   5. Meta Tags          — og:price and schema.org markup (rarely changes)
 * ─────────────────────────────────────────────────────────────
 */

// ─────────────────────────────────────────────
// KNOWN CSS SELECTORS
// Grouped by how stable they are.
// Amazon changes these periodically — but we
// have 4 other methods as fallback.
// ─────────────────────────────────────────────
const PRICE_SELECTORS = [
  // Buy-box scoped — 2024-2025 layouts
  '#corePriceDisplay_desktop_feature_div .a-offscreen',
  '#corePriceDisplay_desktop_feature_div .aok-offscreen',
  '#corePrice_feature_div .a-offscreen',
  '#corePrice_feature_div .aok-offscreen',
  '#apex_offerDisplay_desktop .a-offscreen',
  '.priceToPay .a-offscreen',
  '.priceToPay .aok-offscreen',
  '.apex-pricetopay-value .a-offscreen',
  '.apex-pricetopay-value .aok-offscreen',
  '[data-feature-name="apex_desktop"] .a-offscreen',
  '#digitalPriceBlockId_feature_div .a-offscreen',

  // Legacy (pre-2023, still seen on some listings)
  '#priceblock_ourprice',
  '#priceblock_dealprice',
  '#priceblock_saleprice',

  // Other buy-box-anchored containers
  '.a-price[data-a-color="price"] .a-offscreen',
  '#buyNewSection .a-color-price',
  '#newBuyBoxPrice',
  '#sns-base-price',
  '#tp_price_block_total_price_ww .a-offscreen',
  '#booksHeaderSection .a-color-price',
  '.reinventPricePolicyMessage .a-offscreen',
];

// ─────────────────────────────────────────────
// HELPER: safely parse a price string to float
// ─────────────────────────────────────────────
export function parsePrice(raw) {
  if (!raw) return null;
  // Remove currency symbols, spaces, commas (handles £1,299.99 and £12.99)
  const cleaned = raw
    .replace(/[£$€\s,]/g, '')
    .replace(/[^0-9.]/g, '');
  const val = parseFloat(cleaned);
  if (isNaN(val) || val <= 0 || val > 99999) return null;
  return val;
}

// ─────────────────────────────────────────────
// METHOD 1: CSS Selector extraction
// Works on parsed cheerio $ object or DOM
// ─────────────────────────────────────────────
export function extractByCSSSelectors($) {
  const results = [];

  for (const selector of PRICE_SELECTORS) {
    try {
      const el = $(selector).first();
      if (el.length) {
        const text = el.text().trim();
        const price = parsePrice(text);
        if (price) {
          results.push({
            price,
            method: 'css_selector',
            selector,
            confidence: 85,
            raw: text,
          });
        }
      }
    } catch {
      // Selector threw — skip it
    }
  }

  return results;
}

// ─────────────────────────────────────────────
// METHOD 2: JSON-LD Structured Data
// Amazon embeds machine-readable product data
// for Google/SEO. Very stable — rarely changes.
// Looks for <script type="application/ld+json">
// ─────────────────────────────────────────────
export function extractByJSONLD($) {
  const results = [];

  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const raw = $(el).html();
      if (!raw) return;

      const json = JSON.parse(raw);
      const items = Array.isArray(json) ? json : [json];

      for (const item of items) {
        // Standard schema.org Product
        if (item?.offers?.price) {
          const price = parsePrice(String(item.offers.price));
          if (price) {
            results.push({
              price,
              method: 'json_ld',
              selector: 'schema.org/Product offers.price',
              confidence: 95, // Very high — structured data standard
              raw: String(item.offers.price),
            });
          }
        }

        // Nested offers array
        if (Array.isArray(item?.offers)) {
          for (const offer of item.offers) {
            if (offer?.price) {
              const price = parsePrice(String(offer.price));
              if (price) {
                results.push({
                  price,
                  method: 'json_ld',
                  selector: 'schema.org/Product offers[].price',
                  confidence: 95,
                  raw: String(offer.price),
                });
              }
            }
          }
        }

        // lowPrice / highPrice
        if (item?.lowPrice) {
          const price = parsePrice(String(item.lowPrice));
          if (price) {
            results.push({ price, method: 'json_ld', selector: 'lowPrice', confidence: 90, raw: String(item.lowPrice) });
          }
        }
      }
    } catch {
      // Invalid JSON — skip
    }
  });

  return results;
}

// ─────────────────────────────────────────────
// METHOD 3: Raw HTML Regex
// Scans the raw HTML source for price patterns.
// Completely layout-agnostic — doesn't care about
// CSS classes or HTML structure at all.
// ─────────────────────────────────────────────
export function extractByRegex(html) {
  const results = [];

  // These patterns match the way prices appear in Amazon UK HTML
  const patterns = [
    // "priceAmount":"12.99" — appears in JSON blobs embedded in page
    { re: /"priceAmount"\s*:\s*"?([\d.]+)"?/g,            confidence: 90, label: 'priceAmount_json' },
    // "price":"12.99" near "GBP" — product price in JS data
    { re: /"price"\s*:\s*"([\d.]+)"\s*,\s*"currency"\s*:\s*"GBP"/g, confidence: 92, label: 'price_currency_gbp' },
    // displayPrice":"£12.99"
    { re: /"displayPrice"\s*:\s*"£([\d.,]+)"/g,            confidence: 88, label: 'displayPrice' },
    // "buyingPrice":1299 (pence)
    { re: /"buyingPrice"\s*:\s*(\d{2,6})\b/g,              confidence: 80, label: 'buyingPrice_pence', isPence: true },
    // priceValue = "12.99"
    { re: /priceValue['":\s]+(['"£]?)([\d.]{3,8})/g,       confidence: 75, label: 'priceValue', groupIndex: 2 },
    // "wholePriceValue":12,"fractionalPriceValue":99
    { re: /"wholePriceValue"\s*:\s*(\d+),\s*"fractionalPriceValue"\s*:\s*(\d+)/g, confidence: 85, label: 'whole_frac', isSplit: true },
    // <span>£12.99</span> or £12.99 in any attribute
    { re: /£(\d{1,4}\.\d{2})\b/g,                          confidence: 70, label: 'pound_sign_direct' },
  ];

  for (const p of patterns) {
    let match;
    // Reset lastIndex for global regexes
    p.re.lastIndex = 0;

    while ((match = p.re.exec(html)) !== null) {
      try {
        let price = null;

        if (p.isSplit) {
          // Combine whole + fractional: "12" + "99" = 12.99
          price = parseFloat(`${match[1]}.${match[2].padStart(2, '0')}`);
        } else if (p.isPence) {
          // Convert pence to pounds: 1299 → 12.99
          const pence = parseInt(match[1]);
          if (pence > 0 && pence < 9999900) price = pence / 100;
        } else {
          const idx = p.groupIndex || 1;
          price = parsePrice(match[idx]);
        }

        if (price && price > 0.5 && price < 9999) {
          results.push({
            price,
            method: 'regex',
            selector: p.label,
            confidence: p.confidence,
            raw: match[0].substring(0, 60),
          });
        }
      } catch { /* skip bad match */ }
    }
  }

  return results;
}

// ─────────────────────────────────────────────
// METHOD 4: JS State / Script Tag Extraction
// Amazon renders prices into embedded <script>
// tags as JS objects (React hydration state).
// Very resilient to CSS class changes.
// ─────────────────────────────────────────────
export function extractByJSState($) {
  const results = [];

  $('script:not([src])').each((_, el) => {
    const text = $(el).html() || '';

    // Only process scripts that look like they contain price data
    if (!text.includes('price') && !text.includes('Price')) return;
    if (text.length > 500000) return; // skip huge scripts

    try {
      // Look for P.when / jQuery-style price data Amazon embeds
      const patterns = [
        // aodPrice: {amount: "12.99"}
        /aodPrice[^}]*amount['":\s]+([\d.]+)/i,
        // priceAmount: 12.99
        /priceAmount['":\s]+([\d.]+)/i,
        // "landingPrice":{"amount":12.99}
        /landingPrice[^}]*amount['":\s]+([\d.]+)/i,
        // "currentPrice":{"amount":12.99}
        /currentPrice[^}]*amount['":\s]+([\d.]+)/i,
        // featuredOfferPrice: { amount: "12.99", currency: "GBP" }
        /featuredOfferPrice[^}]*amount['":\s]+([\d.]+)/i,
        // buyboxPrice: "12.99"
        /buyboxPrice['":\s]+([\d.]+)/i,
      ];

      for (const re of patterns) {
        const match = text.match(re);
        if (match) {
          const price = parsePrice(match[1]);
          if (price) {
            results.push({
              price,
              method: 'js_state',
              selector: re.source.substring(0, 40),
              confidence: 88,
              raw: match[0].substring(0, 60),
            });
          }
        }
      }
    } catch { /* skip */ }
  });

  return results;
}

// ─────────────────────────────────────────────
// METHOD 5: Meta Tags
// schema.org and Open Graph price meta tags.
// Least likely to change — semantic web standard.
// ─────────────────────────────────────────────
export function extractByMetaTags($) {
  const results = [];

  const metaSelectors = [
    { sel: 'meta[property="product:price:amount"]',   attr: 'content', label: 'og_product_price',  confidence: 92 },
    { sel: 'meta[property="og:price:amount"]',         attr: 'content', label: 'og_price',          confidence: 90 },
    { sel: 'meta[name="twitter:data1"]',               attr: 'content', label: 'twitter_price',     confidence: 75 },
    { sel: 'meta[itemprop="price"]',                   attr: 'content', label: 'itemprop_price',    confidence: 88 },
    { sel: '[itemprop="price"]',                       attr: 'content', label: 'itemprop_price_el', confidence: 85 },
  ];

  for (const { sel, attr, label, confidence } of metaSelectors) {
    try {
      const val = $(sel).attr(attr);
      if (val) {
        const price = parsePrice(val);
        if (price) {
          results.push({ price, method: 'meta_tag', selector: label, confidence, raw: val });
        }
      }
    } catch { /* skip */ }
  }

  return results;
}

// ─────────────────────────────────────────────
// CONSENSUS ENGINE
// Runs all 5 methods, collects all candidate
// prices, then picks the winner by:
//   1. Confidence score
//   2. Price agreement across multiple methods
//      (if 3 methods return £12.99, that wins)
// ─────────────────────────────────────────────
export function consensusPick(allResults) {
  if (allResults.length === 0) return null;

  // Round prices to 2dp for grouping
  const grouped = {};
  for (const r of allResults) {
    const key = r.price.toFixed(2);
    if (!grouped[key]) grouped[key] = [];
    grouped[key].push(r);
  }

  // Score each candidate price:
  //   +10 per method that agrees (count unique methods)
  //   +max confidence among agreeing results
  let bestPrice = null;
  let bestScore = -1;

  for (const [priceStr, candidates] of Object.entries(grouped)) {
    const uniqueMethods = new Set(candidates.map(c => c.method)).size;
    const maxConf = Math.max(...candidates.map(c => c.confidence));
    const score = (uniqueMethods * 10) + maxConf;

    if (score > bestScore) {
      bestScore = score;
      bestPrice = {
        price: parseFloat(priceStr),
        score,
        agreedMethods: uniqueMethods,
        topMethod: candidates.sort((a, b) => b.confidence - a.confidence)[0],
        allCandidates: candidates,
      };
    }
  }

  return bestPrice;
}

// ─────────────────────────────────────────────
// MAIN EXPORT: smartExtractPrice
// Pass a cheerio $ object + raw HTML string.
// Returns the best price with full diagnostics.
// ─────────────────────────────────────────────
export function smartExtractPrice($, html) {
  // Strip sections that contain alternative/sponsored product prices
  // so regex and CSS methods cannot accidentally match them
  $('iframe').remove();
  $('#above-dp-container').remove();           // "Consider these alternative items"
  $('#similarities_feature_div').remove();     // "Similar items" carousel
  $('#purchaseButtonId').remove();             // future-proofing
  $('[data-feature-name="similarities_feature_div"]').remove();
  // Use post-removal HTML for regex/JS-state so stripped nodes are gone
  const cleanHtml = $.html();

  const allResults = [
    ...extractByCSSSelectors($),
    ...extractByJSONLD($),
    ...extractByRegex(cleanHtml),
    ...extractByJSState($),
    ...extractByMetaTags($),
  ];

  if (allResults.length === 0) {
    return { price: null, confidence: 0, methods: [], allResults: [] };
  }

  const winner = consensusPick(allResults);

  // Build summary of which methods found what
  const methodSummary = {};
  for (const r of allResults) {
    if (!methodSummary[r.method]) methodSummary[r.method] = [];
    methodSummary[r.method].push(r.price);
  }

  return {
    price:          winner?.price || null,
    confidence:     winner?.score || 0,
    agreedMethods:  winner?.agreedMethods || 0,
    topMethod:      winner?.topMethod?.method || null,
    methodSummary,
    allResults,
    warning:        winner?.agreedMethods === 1 ? 'only_one_method_found_price' : null,
  };
}

// ─────────────────────────────────────────────
// HEALTH CHECK
// Tests extraction against a known ASIN with a
// known approximate price range. Run this daily
// via cron to catch breakage before it hits
// your live re-pricer jobs.
//
// Usage: import and call runHealthCheck()
//        Set up a daily cron: '0 8 * * *'
// ─────────────────────────────────────────────

// Test ASINs with known rough price ranges (update these if products change)
const HEALTH_CHECK_ASINS = [
  { asin: 'B07PDHSPYD', minPrice: 5,   maxPrice: 50,  name: 'USB Cable (stable price)' },
  { asin: 'B08DFPV5CB', minPrice: 10,  maxPrice: 100, name: 'Echo Dot (known product)' },
];

export async function runHealthCheck({ scrapeFn, notifyFn } = {}) {
  console.log('\n[HealthCheck] 🔍 Running daily scraper health check...');
  const report = {
    timestamp: new Date().toISOString(),
    results: [],
    overallStatus: 'ok',
  };

  for (const test of HEALTH_CHECK_ASINS) {
    console.log(`[HealthCheck] Testing ASIN ${test.asin} (${test.name})...`);

    try {
      const result = await scrapeFn(test.asin);

      const status = {
        asin:       test.asin,
        name:       test.name,
        price:      result.price,
        confidence: result.confidence,
        methods:    result.methodSummary,
        passed:     false,
        issues:     [],
      };

      // Check 1: Did we get a price at all?
      if (!result.price) {
        status.issues.push('NO_PRICE_RETURNED');
        report.overallStatus = 'degraded';
      }

      // Check 2: Is price in expected range?
      if (result.price && (result.price < test.minPrice || result.price > test.maxPrice)) {
        status.issues.push(`PRICE_OUT_OF_RANGE: got £${result.price}, expected £${test.minPrice}-£${test.maxPrice}`);
        report.overallStatus = 'warning';
      }

      // Check 3: Is confidence low? (only 1 method found it)
      if (result.confidence && result.agreedMethods < 2) {
        status.issues.push('LOW_CONFIDENCE: only 1 method found price — may be fragile');
        if (report.overallStatus === 'ok') report.overallStatus = 'warning';
      }

      // Check 4: Are CSS selectors broken? (other methods work but CSS doesn't)
      const cssWorking = result.methodSummary?.css_selector?.length > 0;
      if (!cssWorking && result.price) {
        status.issues.push('CSS_SELECTORS_BROKEN: price found by fallbacks only — update selectors');
        if (report.overallStatus === 'ok') report.overallStatus = 'warning';
      }

      status.passed = status.issues.length === 0;
      report.results.push(status);

    } catch (err) {
      report.results.push({
        asin: test.asin, name: test.name,
        passed: false,
        issues: [`SCRAPE_ERROR: ${err.message}`],
      });
      report.overallStatus = 'degraded';
    }
  }

  // Print report
  console.log('\n[HealthCheck] ══ REPORT ══════════════════════════════');
  console.log(`[HealthCheck] Status: ${report.overallStatus.toUpperCase()}`);
  for (const r of report.results) {
    const icon = r.passed ? '✅' : '⚠️';
    console.log(`[HealthCheck] ${icon} ${r.name}: £${r.price ?? 'N/A'} (confidence: ${r.confidence ?? '?'})`);
    for (const issue of r.issues) {
      console.warn(`[HealthCheck]    ⚠ ${issue}`);
    }
  }
  console.log('[HealthCheck] ══════════════════════════════════════════\n');

  // Call notification function if provided and status is not ok
  if (report.overallStatus !== 'ok' && notifyFn) {
    await notifyFn(report);
  }

  return report;
}
