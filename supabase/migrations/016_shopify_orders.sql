-- ============================================================
-- Shopify Phase A: commerce data foundation
--
-- Adds the tables every downstream commerce feature (COD confirmation,
-- abandoned-cart recovery, tracking updates, commerce dashboard) needs:
--
--   shopify_orders        — one row per Shopify order
--   shopify_checkouts     — one row per abandoned checkout
--   shopify_fulfillments  — one row per fulfillment (tracking lives here;
--                           the latest is also denormalized onto the order)
--
-- Plus webhook-registration bookkeeping columns on shopify_config.
--
-- All three tables are user-scoped (RLS) and link back to `contacts`
-- via contact_id (nullable, SET NULL on contact delete — same policy as
-- the rest of the schema). Writes happen through the service-role client
-- in the sync + webhook routes, which bypasses RLS; the SELECT policy is
-- what lets the dashboard / Orders page read a user's own rows.
--
-- Safe to run multiple times (IF NOT EXISTS guards throughout).
-- ============================================================

-- ============================================================
-- SHOPIFY_CONFIG — webhook registration bookkeeping
-- ============================================================
ALTER TABLE shopify_config
  ADD COLUMN IF NOT EXISTS webhooks_registered_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS webhook_topics         TEXT[];

-- ============================================================
-- SHOPIFY_ORDERS
-- ============================================================
CREATE TABLE IF NOT EXISTS shopify_orders (
  id                 UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  -- Resolved by phone/email at sync time. SET NULL so deleting a contact
  -- never orphans (or deletes) the historical order record.
  contact_id         UUID        REFERENCES contacts(id) ON DELETE SET NULL,
  store_domain       TEXT,

  shopify_order_id   TEXT        NOT NULL,   -- numeric order id, stored as text
  order_number       TEXT,                   -- e.g. "1001"
  name               TEXT,                   -- e.g. "#1001"

  customer_name      TEXT,
  customer_phone     TEXT,                   -- E.164 where resolvable
  customer_email     TEXT,
  shipping_address   JSONB,
  shipping_method    TEXT,

  currency           TEXT,
  total_price        NUMERIC(12,2),
  subtotal_price     NUMERIC(12,2),
  total_shipping     NUMERIC(12,2),

  financial_status   TEXT,                   -- paid | pending | refunded | partially_refunded | voided ...
  fulfillment_status TEXT,                   -- fulfilled | partial | restocked | NULL (= unfulfilled)
  payment_gateway    TEXT,                   -- e.g. "Cash on Delivery (COD)" — used later by the COD flow

  line_items         JSONB,                  -- [{ title, quantity, price, variant_title, sku }]
  tags               TEXT[],

  -- Latest-fulfillment tracking, denormalized for quick display + the
  -- future tracking-message flow. Source of truth is shopify_fulfillments.
  tracking_number    TEXT,
  tracking_url       TEXT,
  tracking_company   TEXT,
  shipment_status    TEXT,                   -- label_printed | in_transit | out_for_delivery | delivered | failure ...
  fulfilled_at       TIMESTAMPTZ,

  order_created_at   TIMESTAMPTZ,            -- Shopify created_at
  cancelled_at       TIMESTAMPTZ,

  raw                JSONB,                  -- full payload, for fields we don't model yet
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (user_id, shopify_order_id)
);

ALTER TABLE shopify_orders ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can read own shopify orders" ON shopify_orders;
CREATE POLICY "Users can read own shopify orders"
  ON shopify_orders FOR SELECT
  USING (auth.uid() = user_id);

DROP TRIGGER IF EXISTS set_updated_at ON shopify_orders;
CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON shopify_orders
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE INDEX IF NOT EXISTS idx_shopify_orders_user            ON shopify_orders (user_id, order_created_at DESC);
CREATE INDEX IF NOT EXISTS idx_shopify_orders_contact         ON shopify_orders (contact_id) WHERE contact_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_shopify_orders_financial       ON shopify_orders (user_id, financial_status);
CREATE INDEX IF NOT EXISTS idx_shopify_orders_fulfillment     ON shopify_orders (user_id, fulfillment_status);

-- ============================================================
-- SHOPIFY_CHECKOUTS (abandoned)
-- ============================================================
CREATE TABLE IF NOT EXISTS shopify_checkouts (
  id                     UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  contact_id             UUID        REFERENCES contacts(id) ON DELETE SET NULL,
  store_domain           TEXT,

  shopify_checkout_id    TEXT        NOT NULL,   -- numeric checkout id, stored as text
  token                  TEXT,

  customer_name          TEXT,
  customer_phone         TEXT,
  customer_email         TEXT,

  line_items             JSONB,                  -- [{ title, quantity, price, variant_title, sku }]
  abandoned_checkout_url TEXT,                   -- one-tap recovery link sent later via WhatsApp
  currency               TEXT,
  total_price            NUMERIC(12,2),

  shopify_created_at     TIMESTAMPTZ,            -- Shopify created_at
  abandoned_at           TIMESTAMPTZ,            -- when it became eligible for recovery
  completed_at           TIMESTAMPTZ,            -- set when the checkout converts to an order
  recovered              BOOLEAN     NOT NULL DEFAULT FALSE,
  recovered_order_id     TEXT,

  raw                    JSONB,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (user_id, shopify_checkout_id)
);

ALTER TABLE shopify_checkouts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can read own shopify checkouts" ON shopify_checkouts;
CREATE POLICY "Users can read own shopify checkouts"
  ON shopify_checkouts FOR SELECT
  USING (auth.uid() = user_id);

DROP TRIGGER IF EXISTS set_updated_at ON shopify_checkouts;
CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON shopify_checkouts
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE INDEX IF NOT EXISTS idx_shopify_checkouts_user      ON shopify_checkouts (user_id, abandoned_at DESC);
CREATE INDEX IF NOT EXISTS idx_shopify_checkouts_contact   ON shopify_checkouts (contact_id) WHERE contact_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_shopify_checkouts_open      ON shopify_checkouts (user_id, recovered);

-- ============================================================
-- SHOPIFY_FULFILLMENTS
-- ============================================================
CREATE TABLE IF NOT EXISTS shopify_fulfillments (
  id                       UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                  UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  -- Resolved to the local order row when present. CASCADE: a fulfillment
  -- can't outlive its order.
  order_id                 UUID        REFERENCES shopify_orders(id) ON DELETE CASCADE,
  shopify_order_id         TEXT,                  -- Shopify order id, for linking when the order row lands later

  shopify_fulfillment_id   TEXT        NOT NULL,
  status                   TEXT,                  -- pending | open | success | cancelled | error | failure
  shipment_status          TEXT,                  -- in_transit | out_for_delivery | delivered | failure ...
  tracking_number          TEXT,
  tracking_url             TEXT,
  tracking_company         TEXT,

  shopify_created_at       TIMESTAMPTZ,
  shopify_updated_at       TIMESTAMPTZ,

  raw                      JSONB,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (user_id, shopify_fulfillment_id)
);

ALTER TABLE shopify_fulfillments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can read own shopify fulfillments" ON shopify_fulfillments;
CREATE POLICY "Users can read own shopify fulfillments"
  ON shopify_fulfillments FOR SELECT
  USING (auth.uid() = user_id);

DROP TRIGGER IF EXISTS set_updated_at ON shopify_fulfillments;
CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON shopify_fulfillments
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE INDEX IF NOT EXISTS idx_shopify_fulfillments_order      ON shopify_fulfillments (order_id) WHERE order_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_shopify_fulfillments_shop_order ON shopify_fulfillments (user_id, shopify_order_id);
