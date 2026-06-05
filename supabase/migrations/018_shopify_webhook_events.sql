-- ============================================================
-- Shopify webhook delivery log
--
-- Records every inbound POST to /api/shopify/webhook and where it ended up,
-- so webhook delivery is observable IN-APP (Shopify settings page) without
-- digging through Vercel function logs.
--
-- status values:
--   invalid_hmac        — signature check failed (delivery reached us, secret mismatch)
--   ignored_unknown_shop— HMAC ok but no shopify_config matches the shop domain
--   config_error        — the shop→user lookup itself errored (e.g. bad service key)
--   processed           — handled + saved
--   ignored_topic       — a topic we don't handle
--   error               — handler threw while saving
--
-- user_id is nullable: invalid-HMAC / unknown-shop rows have no resolved user.
-- ============================================================

CREATE TABLE IF NOT EXISTS shopify_webhook_events (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID        REFERENCES auth.users(id) ON DELETE CASCADE,
  shop        TEXT,
  topic       TEXT,
  hmac_valid  BOOLEAN,
  status      TEXT,
  detail      TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE shopify_webhook_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can read own webhook events" ON shopify_webhook_events;
CREATE POLICY "Users can read own webhook events"
  ON shopify_webhook_events FOR SELECT
  USING (auth.uid() = user_id);

CREATE INDEX IF NOT EXISTS idx_shopify_webhook_events_shop
  ON shopify_webhook_events (shop, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_shopify_webhook_events_user
  ON shopify_webhook_events (user_id, created_at DESC);
