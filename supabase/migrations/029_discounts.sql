-- ============================================================
-- 029_discounts.sql
-- Discounts — percentage-discount definitions + per-customer
-- generated single-use Shopify codes.
--
-- Run BEFORE deploying the discounts code. Idempotent.
--
--   1. discounts            — merchant-defined discount config
--                             (percentage, optional expiry / min order).
--   2. discount_codes       — every unique code generated on Shopify,
--                             with the contact + Shopify discount id, so
--                             we never regenerate blindly and can show
--                             history.
--
-- NOTE (scope): generating codes calls the Shopify Admin
-- discountCodeBasicCreate mutation, which needs the `write_discounts`
-- (and `read_discounts`) OAuth scope. The app does NOT currently request
-- it — the merchant must reconnect Shopify after the scope is added.
-- This migration only creates storage; it does not depend on the scope.
-- ============================================================

-- ── 1. Discount definitions ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS discounts (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  label             TEXT        NOT NULL,
  -- Percentage off, 0 < pct <= 100 (e.g. 10.00 = 10%).
  percentage        NUMERIC(5,2) NOT NULL CHECK (percentage > 0 AND percentage <= 100),
  -- Code is valid for N days after it is generated; NULL = no expiry.
  expiry_days       INTEGER     CHECK (expiry_days IS NULL OR expiry_days > 0),
  -- Minimum order subtotal required to use the code; NULL = no minimum.
  min_order_amount  NUMERIC(12,2) CHECK (min_order_amount IS NULL OR min_order_amount >= 0),

  enabled           BOOLEAN     NOT NULL DEFAULT TRUE,

  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE discounts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can manage own discounts" ON discounts;
CREATE POLICY "Users can manage own discounts"
  ON discounts FOR ALL
  USING (auth.uid() = user_id);

DROP TRIGGER IF EXISTS set_updated_at ON discounts;
CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON discounts
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE INDEX IF NOT EXISTS idx_discounts_user ON discounts (user_id, created_at DESC);

-- ── 2. Generated codes (one row per code created on Shopify) ────────
CREATE TABLE IF NOT EXISTS discount_codes (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  discount_id         UUID        NOT NULL REFERENCES discounts(id)  ON DELETE CASCADE,
  -- Nullable: a "generate test code" run isn't tied to a contact.
  contact_id          UUID        REFERENCES contacts(id) ON DELETE SET NULL,

  code                TEXT        NOT NULL,
  -- Shopify's gid://shopify/DiscountCodeNode/... for the created discount.
  shopify_discount_id TEXT,
  -- Snapshot of the percentage at generation time (definition may change later).
  percentage          NUMERIC(5,2),

  status              TEXT        NOT NULL DEFAULT 'active'
                                  CHECK (status IN ('active', 'used', 'expired')),
  expires_at          TIMESTAMPTZ,

  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Codes are unique per tenant (also enforced Shopify-side).
  UNIQUE (user_id, code)
);

ALTER TABLE discount_codes ENABLE ROW LEVEL SECURITY;

-- Browser reads only; codes are written by the service-role generate path.
DROP POLICY IF EXISTS "Users can read own discount codes" ON discount_codes;
CREATE POLICY "Users can read own discount codes"
  ON discount_codes FOR SELECT
  USING (auth.uid() = user_id);

CREATE INDEX IF NOT EXISTS idx_discount_codes_user      ON discount_codes (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_discount_codes_discount  ON discount_codes (discount_id);
-- Lets the generator reuse an existing active code for a contact instead of
-- regenerating blindly.
CREATE INDEX IF NOT EXISTS idx_discount_codes_contact
  ON discount_codes (user_id, discount_id, contact_id, status)
  WHERE contact_id IS NOT NULL;
