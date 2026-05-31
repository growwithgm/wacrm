-- ============================================================
-- Shopify Phase 1: OAuth connection + customer data sync
--
-- Creates:
--   shopify_config — one row per user, stores the OAuth token
--                    (encrypted) and connection metadata.
--
-- Adds columns to contacts:
--   shopify_customer_id, shopify_store_domain, shopify_total_orders,
--   shopify_total_spent, shopify_currency, shopify_last_order_at,
--   shopify_tags
--
-- Column names here EXACTLY match every .from('contacts').insert/update
-- call in src/app/api/shopify/sync/route.ts.
--
-- Safe to run multiple times (IF NOT EXISTS / ADD COLUMN IF NOT EXISTS).
-- ============================================================

-- ============================================================
-- SHOPIFY_CONFIG
-- ============================================================
CREATE TABLE IF NOT EXISTS shopify_config (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  -- Normalised store domain, e.g. "mystore.myshopify.com"
  store_domain      TEXT        NOT NULL,

  -- AES-256-GCM encrypted access token (same scheme as whatsapp_config)
  access_token      TEXT        NOT NULL,

  -- Encrypted refresh token — present only for expiring offline tokens
  -- (mandatory for all new Shopify public apps as of April 1 2026)
  refresh_token     TEXT,

  -- UTC timestamp at which the access_token expires; NULL for legacy
  -- non-expiring tokens installed before the enforcement date
  token_expires_at  TIMESTAMPTZ,

  -- Comma-separated OAuth scopes granted by the merchant
  scopes            TEXT,

  -- Display name of the Shopify store (populated after first validation)
  shop_name         TEXT,

  -- Shopify's internal store GID (gid://shopify/Shop/...)
  shop_id           TEXT,

  connection_status TEXT        NOT NULL DEFAULT 'disconnected'
                                CHECK (connection_status IN ('connected', 'disconnected', 'error')),

  -- Updated by /api/shopify/sync on completion of each full sync
  last_synced_at    TIMESTAMPTZ,

  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (user_id)
);

ALTER TABLE shopify_config ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can manage own shopify config" ON shopify_config;
CREATE POLICY "Users can manage own shopify config"
  ON shopify_config FOR ALL
  USING (auth.uid() = user_id);

DROP TRIGGER IF EXISTS set_updated_at ON shopify_config;
CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON shopify_config
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ============================================================
-- CONTACTS — Shopify enrichment columns
-- ============================================================

-- Unique per (user, shopify customer) — prevents duplicate imports while
-- allowing different users to have the same Shopify customer ID from their
-- own stores. Partial so rows with no Shopify linkage aren't indexed.
ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS shopify_customer_id   TEXT,
  ADD COLUMN IF NOT EXISTS shopify_store_domain  TEXT,
  ADD COLUMN IF NOT EXISTS shopify_total_orders  INTEGER,
  ADD COLUMN IF NOT EXISTS shopify_total_spent   NUMERIC(12,2),
  ADD COLUMN IF NOT EXISTS shopify_currency      TEXT,
  ADD COLUMN IF NOT EXISTS shopify_last_order_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS shopify_tags          TEXT[];

CREATE UNIQUE INDEX IF NOT EXISTS idx_contacts_shopify_customer_id
  ON contacts (user_id, shopify_customer_id)
  WHERE shopify_customer_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_contacts_shopify_store
  ON contacts (user_id, shopify_store_domain)
  WHERE shopify_store_domain IS NOT NULL;
