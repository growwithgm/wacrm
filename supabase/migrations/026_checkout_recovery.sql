-- ============================================================
-- 026_checkout_recovery.sql
-- Abandoned-checkout recovery via WhatsApp (3 reminders + guards).
--
-- Run BEFORE deploying the recovery engine code. Idempotent.
--
-- Pieces:
--   1. shopify_checkouts.customer_locale — checkout language, drives
--      Spanish vs English template selection.
--   2. shopify_config.recovery_* — per-tenant config: master toggle,
--      the three reminder delays (minutes, editable without a code
--      change), anti-spam cooldown, and the two template slots.
--   3. checkout_recoveries — one tracking row per checkout sequence
--      (the dedupe anchor: UNIQUE (user_id, shopify_checkout_id)).
-- ============================================================

-- ── 1. Checkout language (from Shopify's customer_locale) ───────────
ALTER TABLE shopify_checkouts
  ADD COLUMN IF NOT EXISTS customer_locale TEXT;

-- ── 2. Per-tenant recovery config on shopify_config ─────────────────
-- recovery_enabled defaults FALSE: nothing fires until the merchant
-- sets template names and flips it on.
ALTER TABLE shopify_config
  ADD COLUMN IF NOT EXISTS recovery_enabled           BOOLEAN  NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS recovery_delay1_minutes    INTEGER  NOT NULL DEFAULT 45,
  ADD COLUMN IF NOT EXISTS recovery_delay2_minutes    INTEGER  NOT NULL DEFAULT 1440,  -- 24 h
  ADD COLUMN IF NOT EXISTS recovery_delay3_minutes    INTEGER  NOT NULL DEFAULT 2880,  -- 48 h
  ADD COLUMN IF NOT EXISTS recovery_cooldown_days     INTEGER  NOT NULL DEFAULT 7,
  ADD COLUMN IF NOT EXISTS recovery_template_name_es  TEXT,
  ADD COLUMN IF NOT EXISTS recovery_template_lang_es  TEXT     NOT NULL DEFAULT 'es',
  ADD COLUMN IF NOT EXISTS recovery_template_name_en  TEXT,
  ADD COLUMN IF NOT EXISTS recovery_template_lang_en  TEXT     NOT NULL DEFAULT 'en_US';

-- ── 3. Recovery tracking — one sequence per checkout ────────────────
CREATE TABLE IF NOT EXISTS checkout_recoveries (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             UUID        NOT NULL REFERENCES auth.users(id)        ON DELETE CASCADE,
  checkout_id         UUID        NOT NULL REFERENCES shopify_checkouts(id) ON DELETE CASCADE,
  shopify_checkout_id TEXT        NOT NULL,
  contact_id          UUID        REFERENCES contacts(id)      ON DELETE SET NULL,
  conversation_id     UUID        REFERENCES conversations(id) ON DELETE SET NULL,

  -- E.164-ish phone captured from the checkout; NULL → skipped_no_phone.
  phone               TEXT,

  -- Sequence state:
  --   active              → reminders still scheduled
  --   done                → all 3 reminders sent, sequence finished
  --   completed_order     → checkout converted; sequence stopped
  --   skipped_no_phone    → no usable phone on the checkout
  --   suppressed_cooldown → same customer already got a recovery recently
  status              TEXT        NOT NULL DEFAULT 'active'
                                  CHECK (status IN (
                                    'active', 'done', 'completed_order',
                                    'skipped_no_phone', 'suppressed_cooldown'
                                  )),

  -- Idempotency: each reminder fires at most once, cron-rerun safe.
  reminders_sent      SMALLINT    NOT NULL DEFAULT 0,
  reminder1_sent_at   TIMESTAMPTZ,
  reminder2_sent_at   TIMESTAMPTZ,
  reminder3_sent_at   TIMESTAMPTZ,
  last_error          TEXT,

  -- Timer anchor: reminder delays are measured from created_at
  -- (back-date this column to test, same as cod_confirmations).
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (user_id, shopify_checkout_id)
);

ALTER TABLE checkout_recoveries ENABLE ROW LEVEL SECURITY;

-- Browser reads only; all writes go through the service role
-- (webhook + cron), which bypasses RLS.
DROP POLICY IF EXISTS "Users can read own checkout recoveries" ON checkout_recoveries;
CREATE POLICY "Users can read own checkout recoveries"
  ON checkout_recoveries FOR SELECT
  USING (auth.uid() = user_id);

DROP TRIGGER IF EXISTS set_updated_at ON checkout_recoveries;
CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON checkout_recoveries
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Sweep scans active rows oldest-first; cooldown checks scan a user's
-- recent rows.
CREATE INDEX IF NOT EXISTS idx_checkout_recoveries_sweep
  ON checkout_recoveries (status, created_at);
CREATE INDEX IF NOT EXISTS idx_checkout_recoveries_user_recent
  ON checkout_recoveries (user_id, created_at DESC);
