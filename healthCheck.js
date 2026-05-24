/**
 * healthCheck.js
 * ─────────────────────────────────────────────────────────────
 * Runs daily at 8 AM to test the scraper against known ASINs.
 * Alerts you if:
 *   - CSS selectors are broken (Amazon updated their HTML)
 *   - Price extraction confidence is low
 *   - No price returned at all
 *
 * Add this to your server.js startup:
 *   import './scraper/healthCheck.js';
 * ─────────────────────────────────────────────────────────────
 */

import cron from 'node-cron';
import { runHealthCheck } from './priceExtractor.js';
import { getProductDetails } from './amazonScraper.js';

// ─────────────────────────────────────────────
// NOTIFICATION OPTIONS
// Uncomment and configure whichever you prefer
// ─────────────────────────────────────────────

async function sendAlert(report) {
  const issues = report.results.flatMap(r => r.issues);
  const message = `
🚨 OnBuy Re-Pricer — Scraper Health Alert
Status: ${report.overallStatus.toUpperCase()}
Time: ${report.timestamp}

Issues detected:
${issues.map(i => `  • ${i}`).join('\n')}

Results:
${report.results.map(r => `  ${r.passed ? '✅' : '⚠️'} ${r.name}: £${r.price ?? 'N/A'}`).join('\n')}

Action needed: Check priceExtractor.js and update CSS selectors or regex patterns.
  `.trim();

  // ── OPTION A: Log to console (always active) ──
  console.error('\n' + '!'.repeat(60));
  console.error(message);
  console.error('!'.repeat(60) + '\n');

  // ── OPTION B: Email via nodemailer (uncomment to enable) ──
  // npm install nodemailer
  /*
  import nodemailer from 'nodemailer';
  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: process.env.ALERT_EMAIL, pass: process.env.ALERT_EMAIL_PASS }
  });
  await transporter.sendMail({
    from: process.env.ALERT_EMAIL,
    to: process.env.ALERT_EMAIL,
    subject: `🚨 Re-Pricer Scraper Alert — ${report.overallStatus.toUpperCase()}`,
    text: message,
  });
  */

  // ── OPTION C: Slack webhook (uncomment to enable) ──
  /*
  await fetch(process.env.SLACK_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: message }),
  });
  */
}

// ─────────────────────────────────────────────
// SCRAPE WRAPPER
// Passes getProductDetails to the health checker
// and returns in the format it expects
// ─────────────────────────────────────────────
async function scrapeFn(asin) {
  const result = await getProductDetails(asin, { maxRetries: 2 });
  return {
    price:         result.price,
    confidence:    result.priceConfidence,
    agreedMethods: result.priceAgreedMethods,
    methodSummary: result.methodSummary || {},
  };
}

// ─────────────────────────────────────────────
// SCHEDULE
// Runs every day at 8:00 AM
// Change '0 8 * * *' to adjust:
//   '0 8 * * *'    → 8 AM daily
//   '0 8 * * 1'    → 8 AM every Monday
//   '0 */12 * * *' → every 12 hours
// ─────────────────────────────────────────────
cron.schedule('0 8 * * *', async () => {
  await runHealthCheck({ scrapeFn, notifyFn: sendAlert });
});

// Also run once on startup (with a 30s delay to let server initialise)
setTimeout(async () => {
  console.log('[HealthCheck] Running startup health check...');
  await runHealthCheck({ scrapeFn, notifyFn: sendAlert });
}, 30000);

console.log('[HealthCheck] ✅ Daily health check scheduled at 8:00 AM');
