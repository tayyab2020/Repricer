# ⚡ OnBuy Re-Pricer Tool

A full-stack web application that automatically keeps your OnBuy listing prices
in sync with your Amazon suppliers — built with Node.js, React, and PostgreSQL.

---

## 🗂️ Project Structure

```
onbuy-repricer/
├── scraper/
│   ├── amazonScraper.js     ← Core scraper (Cheerio + Puppeteer stealth)
│   └── repricerJob.js       ← Background cron job (runs every 30 min)
├── database/
│   └── schema.sql           ← PostgreSQL table definitions
├── frontend/
│   └── src/
│       └── App.jsx          ← React dashboard
├── server.js                ← Express REST API
├── package.json
└── .env.example             ← Environment variable template
```

---

## 🚀 Setup Guide

### Step 1 — Clone & Install

```bash
# Backend
cd onbuy-repricer
npm install

# Frontend (create Vite app)
npm create vite@latest frontend -- --template react
cd frontend
npm install
npm install recharts
```

### Step 2 — Database

1. Create a free PostgreSQL database at **supabase.com**
2. Copy the connection string
3. Run the schema:

```bash
psql your_connection_string -f database/schema.sql
```

### Step 3 — Environment Variables

```bash
cp .env.example .env
# Edit .env with your real values
```

### Step 4 — Configure Proxies (Optional but Recommended)

1. Sign up at **webshare.io** (free tier = 10 proxies)
2. Go to: Proxy List → Copy proxy credentials
3. Add them to `scraper/amazonScraper.js`:

```js
const PROXIES = [
  'http://username:password@p.webshare.io:80',
  'http://username:password@p.webshare.io:81',
];
```

### Step 5 — OnBuy API Keys

1. Log in to **OnBuy Seller Centre**
2. Go to: Settings → Integrations → API Access
3. Generate Consumer Key + Secret Key
4. Add them to your `.env`

### Step 6 — Run

```bash
# Terminal 1: Start API server
npm start

# Terminal 2: Start re-pricer job
npm run job

# Terminal 3: Start frontend
cd frontend && npm run dev
```

Open **http://localhost:5173** in your browser.

---

## 🔧 How It Works

### Auto Re-Pricer Flow
```
Every 30 min
    ↓
Fetch active mappings from DB
    ↓
For each product:
    Try Cheerio scrape → if blocked → try Puppeteer stealth
    ↓
Compare new Amazon price vs last known price
    ↓
If changed: compute OnBuy price (Amazon price + markup)
    ↓
Update OnBuy listing via API
    ↓
Save to price_history + sync_logs
```

### Markup Rules
- **Percent**: `OnBuy price = Amazon price × (1 + markup%)`
  - Example: Amazon £10, markup 25% → OnBuy £12.50
- **Fixed**: `OnBuy price = Amazon price + £X`
  - Example: Amazon £10, markup £5 → OnBuy £15
- **Min Price Floor**: Never price below this, even if Amazon drops

### Multi-Supplier Comparison
Scrapes Amazon's offer listing page for all third-party sellers
of a product, returns them sorted by price with seller details.

---

## 📊 Dashboard Features

| Page | What it shows |
|------|--------------|
| Dashboard | Live stats + recent sync activity log |
| Mappings | All OnBuy ↔ Amazon product links with CRUD |
| Compare | Cheapest supplier ranking with live scraping |
| Chart | 14-day price history (Amazon vs OnBuy) |

---

## 💰 Running Cost

| Service | Cost |
|---------|------|
| Supabase PostgreSQL | Free |
| WebShare.io proxies | Free (10 proxies) |
| Railway/Render hosting | ~$5/month |
| Amazon scraping | $0 (self-hosted) |
| **Total** | **~$5/month** |

---

## ⚠️ Important Notes

- Scraping Amazon violates their ToS — use at your own risk
- Amazon blocks IPs without proxies — add WebShare proxies for reliability
- If selectors break (Amazon HTML changes), update `amazonScraper.js`
- The stealth plugin reduces detection but isn't foolproof at scale
- For 25+ products, increase the sync interval to every 1–2 hours

---

## 🔄 Changing Sync Frequency

In `scraper/repricerJob.js`, find:

```js
cron.schedule('*/30 * * * *', ...)  // every 30 min
```

Change to:
```js
'*/15 * * * *'   // every 15 min
'0 * * * *'      // every 1 hour
'0 */2 * * *'    // every 2 hours
```
