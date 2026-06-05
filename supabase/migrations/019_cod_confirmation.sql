-- ============================================================
-- COD (cash-on-delivery) confirmation flow
--
-- State machine for confirming COD orders over WhatsApp:
--   pending → (reply SÍ) confirmed
--           → (reply NO) cancel_requested
--           → (72h silence) no_reply
--
-- Trigger fires ONLY from the live orders/create webhook (webhook-sourced
-- orders) — never from a backfill/cron sync.
--
-- Configurable per store via shopify_config columns (template, language,
-- reminder timings, tag names). Safe to run multiple times.
-- ============================================================

-- ── COD settings (per connected store) ──────────────────────────────────────
ALTER TABLE shopify_config
  ADD COLUMN IF NOT EXISTS cod_enabled          BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS cod_template_name    TEXT    NOT NULL DEFAULT 'cod_confermation_1',
  ADD COLUMN IF NOT EXISTS cod_template_language TEXT   NOT NULL DEFAULT 'es',
  ADD COLUMN IF NOT EXISTS cod_reminder1_hours  INTEGER NOT NULL DEFAULT 24,
  ADD COLUMN IF NOT EXISTS cod_reminder2_hours  INTEGER NOT NULL DEFAULT 48,
  ADD COLUMN IF NOT EXISTS cod_noreply_hours    INTEGER NOT NULL DEFAULT 72,
  ADD COLUMN IF NOT EXISTS cod_tag_pending      TEXT    NOT NULL DEFAULT 'COD Pending Confirmation',
  ADD COLUMN IF NOT EXISTS cod_tag_confirmed    TEXT    NOT NULL DEFAULT 'COD Confirmed',
  ADD COLUMN IF NOT EXISTS cod_tag_cancel       TEXT    NOT NULL DEFAULT 'COD Cancel Requested',
  ADD COLUMN IF NOT EXISTS cod_tag_noreply      TEXT    NOT NULL DEFAULT 'COD No Reply';

-- ── COD status surfaced on the order ────────────────────────────────────────
ALTER TABLE shopify_orders
  ADD COLUMN IF NOT EXISTS cod_status TEXT
    CHECK (cod_status IN ('pending', 'confirmed', 'cancel_requested', 'no_reply'));

-- ── COD confirmation state machine ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS cod_confirmations (
  id                 UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  order_id           UUID        REFERENCES shopify_orders(id) ON DELETE CASCADE,
  shopify_order_id   TEXT        NOT NULL,
  store_domain       TEXT,

  contact_id         UUID        REFERENCES contacts(id) ON DELETE SET NULL,
  conversation_id    UUID        REFERENCES conversations(id) ON DELETE SET NULL,
  phone              TEXT,
  order_number       TEXT,
  total              TEXT,        -- formatted "139.90" used as template {{2}}
  currency           TEXT,

  status             TEXT        NOT NULL DEFAULT 'pending'
                                 CHECK (status IN ('pending', 'confirmed', 'cancel_requested', 'no_reply')),

  messages_sent      INTEGER     NOT NULL DEFAULT 0,  -- 1=initial, 2=reminder1, 3=reminder2
  last_message_at    TIMESTAMPTZ,
  reminder1_sent_at  TIMESTAMPTZ,
  reminder2_sent_at  TIMESTAMPTZ,
  no_reply_at        TIMESTAMPTZ,

  reply_text         TEXT,
  replied_at         TIMESTAMPTZ,

  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (user_id, shopify_order_id)   -- one confirmation per order (idempotent trigger)
);

ALTER TABLE cod_confirmations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can read own cod confirmations" ON cod_confirmations;
CREATE POLICY "Users can read own cod confirmations"
  ON cod_confirmations FOR SELECT
  USING (auth.uid() = user_id);

DROP TRIGGER IF EXISTS set_updated_at ON cod_confirmations;
CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON cod_confirmations
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Cron sweep: pending rows ordered by age.
CREATE INDEX IF NOT EXISTS idx_cod_confirmations_pending
  ON cod_confirmations (status, created_at);
-- Reply matching: active confirmation for a contact.
CREATE INDEX IF NOT EXISTS idx_cod_confirmations_contact
  ON cod_confirmations (user_id, contact_id, status);
