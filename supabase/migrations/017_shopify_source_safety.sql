-- ============================================================
-- Shopify Phase A — source-based automation safety
--
-- Every order / checkout records HOW it arrived:
--   'webhook'  — arrived live via a Shopify webhook (eligible for automation)
--   'backfill' — came from a manual or scheduled historical sync
--                (DISPLAY ONLY — must NEVER trigger a WhatsApp message)
--
-- Adding the column as NOT NULL DEFAULT 'backfill' tags every EXISTING row
-- (the 675 orders + 1000+ checkouts already synced) as 'backfill', so none
-- of them can ever become automation-eligible. Only rows written by the
-- webhook receiver going forward are 'webhook'.
--
-- shopify_config.abandoned_window_hours makes the abandoned-cart recency
-- cutoff configurable (default 24h) — a second, independent guard so even a
-- webhook-sourced-but-old cart can't be messaged.
--
-- Safe to run multiple times.
-- ============================================================

ALTER TABLE shopify_orders
  ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'backfill'
    CHECK (source IN ('webhook', 'backfill'));

ALTER TABLE shopify_checkouts
  ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'backfill'
    CHECK (source IN ('webhook', 'backfill'));

ALTER TABLE shopify_config
  ADD COLUMN IF NOT EXISTS abandoned_window_hours INTEGER NOT NULL DEFAULT 24;

-- Indexes for "automation-eligible" lookups (webhook-sourced, recent).
CREATE INDEX IF NOT EXISTS idx_shopify_orders_source
  ON shopify_orders (user_id, source);

CREATE INDEX IF NOT EXISTS idx_shopify_checkouts_source
  ON shopify_checkouts (user_id, source, abandoned_at DESC);
