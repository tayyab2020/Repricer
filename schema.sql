-- ═══════════════════════════════════════════════════════════
-- OnBuy Re-Pricer — Database Schema
-- Run this once on your PostgreSQL database to set up tables
-- ═══════════════════════════════════════════════════════════

-- Product mappings: links OnBuy listing ↔ Amazon ASIN
CREATE TABLE IF NOT EXISTS product_mappings (
  id                SERIAL PRIMARY KEY,
  product_name      VARCHAR(500),
  onbuy_listing_id  VARCHAR(100) NOT NULL,
  onbuy_sku         VARCHAR(100),
  primary_asin      VARCHAR(20) NOT NULL,        -- your main supplier ASIN
  markup_type       VARCHAR(10) DEFAULT 'percent' CHECK (markup_type IN ('percent', 'fixed')),
  markup_value      DECIMAL(10, 2) DEFAULT 20,   -- e.g. 20 = 20% or £20 fixed
  min_price         DECIMAL(10, 2),              -- price floor (never sell below this)
  last_amazon_price DECIMAL(10, 2),
  last_onbuy_price  DECIMAL(10, 2),
  last_synced_at    TIMESTAMP,
  last_checked_at   TIMESTAMP,
  is_active         BOOLEAN DEFAULT true,
  notes             TEXT,
  created_at        TIMESTAMP DEFAULT NOW(),
  updated_at        TIMESTAMP DEFAULT NOW()
);

-- Alternative/competitor supplier ASINs for comparison feature
CREATE TABLE IF NOT EXISTS supplier_asins (
  id                  SERIAL PRIMARY KEY,
  product_mapping_id  INT REFERENCES product_mappings(id) ON DELETE CASCADE,
  asin                VARCHAR(20) NOT NULL,
  supplier_name       VARCHAR(255),
  amazon_url          TEXT,
  last_price          DECIMAL(10, 2),
  last_checked_at     TIMESTAMP,
  in_stock            BOOLEAN,
  seller_rating       VARCHAR(50),
  is_prime            BOOLEAN DEFAULT false,
  notes               TEXT,
  created_at          TIMESTAMP DEFAULT NOW()
);

-- Price history for charts and analytics
CREATE TABLE IF NOT EXISTS price_history (
  id                  SERIAL PRIMARY KEY,
  product_mapping_id  INT REFERENCES product_mappings(id) ON DELETE CASCADE,
  amazon_price        DECIMAL(10, 2),
  onbuy_price         DECIMAL(10, 2),
  recorded_at         TIMESTAMP DEFAULT NOW()
);

-- Sync logs for debugging and monitoring
CREATE TABLE IF NOT EXISTS sync_logs (
  id                  SERIAL PRIMARY KEY,
  product_mapping_id  INT REFERENCES product_mappings(id) ON DELETE CASCADE,
  status              VARCHAR(20) CHECK (status IN ('success', 'failed', 'skipped')),
  message             TEXT,
  amazon_price        DECIMAL(10, 2),
  onbuy_price         DECIMAL(10, 2),
  created_at          TIMESTAMP DEFAULT NOW()
);

-- Useful indexes for query performance
CREATE INDEX IF NOT EXISTS idx_mappings_active ON product_mappings(is_active);
CREATE INDEX IF NOT EXISTS idx_mappings_synced ON product_mappings(last_synced_at);
CREATE INDEX IF NOT EXISTS idx_history_mapping  ON price_history(product_mapping_id);
CREATE INDEX IF NOT EXISTS idx_history_date     ON price_history(recorded_at);
CREATE INDEX IF NOT EXISTS idx_logs_mapping     ON sync_logs(product_mapping_id);
CREATE INDEX IF NOT EXISTS idx_supplier_mapping ON supplier_asins(product_mapping_id);

-- OnBuy seller accounts (supports multiple accounts)
CREATE TABLE IF NOT EXISTS onbuy_accounts (
  id              SERIAL PRIMARY KEY,
  account_name    VARCHAR(255) NOT NULL,
  consumer_key    TEXT NOT NULL,
  secret_key      TEXT NOT NULL,
  site_id         VARCHAR(20) DEFAULT '2000',
  is_active       BOOLEAN DEFAULT true,
  last_tested_at  TIMESTAMP,
  last_test_ok    BOOLEAN,
  created_at      TIMESTAMP DEFAULT NOW(),
  updated_at      TIMESTAMP DEFAULT NOW()
);

-- Link each product mapping to a specific OnBuy account
ALTER TABLE product_mappings
  ADD COLUMN IF NOT EXISTS onbuy_account_id INT REFERENCES onbuy_accounts(id) ON DELETE SET NULL;

-- ─────────────────────────────────────────────
-- SAMPLE DATA (remove in production)
-- ─────────────────────────────────────────────

INSERT INTO product_mappings (
  product_name, onbuy_listing_id, onbuy_sku, primary_asin,
  markup_type, markup_value, min_price, is_active
) VALUES
  ('Wireless Bluetooth Headphones', 'OB-LIST-001', 'SKU-WBH-001', 'B08HVZV3XN', 'percent', 25, 15.00, true),
  ('USB-C Charging Cable 2m',       'OB-LIST-002', 'SKU-USB-002', 'B07THBXVHM', 'fixed',   5,  8.00, true),
  ('Phone Stand Adjustable',        'OB-LIST-003', 'SKU-PSA-003', 'B082W3MH5L', 'percent', 30, 5.00,  true);

INSERT INTO supplier_asins (product_mapping_id, asin, supplier_name, amazon_url) VALUES
  (1, 'B08HVZV3XN', 'TechAccessories Ltd',  'https://www.amazon.co.uk/dp/B08HVZV3XN'),
  (1, 'B07XJ8C8F5', 'ElectroHub UK',         'https://www.amazon.co.uk/dp/B07XJ8C8F5'),
  (1, 'B09BF4H231', 'SoundGear Direct',      'https://www.amazon.co.uk/dp/B09BF4H231'),
  (2, 'B07THBXVHM', 'CableMaster',           'https://www.amazon.co.uk/dp/B07THBXVHM'),
  (2, 'B08N5WRWNW', 'QuickCharge Supplies',  'https://www.amazon.co.uk/dp/B08N5WRWNW');
