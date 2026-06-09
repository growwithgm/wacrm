-- ============================================================
-- 023_cod_flow_cancel_template.sql
-- COD state machine — Phase 1 (YES/NO immediate path).
--
-- Adds the NO-outcome (cancel) template slot, and widens the COD status enums
-- to the flow's outcome values: 'cancelled' (customer replied NO) and
-- 'no_reply_cancelled' (Phase 2, 72h auto-cancel). The legacy values
-- ('cancel_requested', 'no_reply') are KEPT so existing rows stay valid.
--
-- Idempotent; safe to run multiple times. Run before deploying the engine.
-- ============================================================

-- ── NO-outcome (cancel) template, parallel to the thank-you / no-reply slots ──
ALTER TABLE shopify_config
  ADD COLUMN IF NOT EXISTS cod_cancel_template_enabled  BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS cod_cancel_template_name     TEXT,
  ADD COLUMN IF NOT EXISTS cod_cancel_template_language TEXT,
  ADD COLUMN IF NOT EXISTS cod_cancel_var_map           JSONB NOT NULL DEFAULT '{}'::jsonb;

-- ── Widen the confirmation status enum (keep legacy values for back-compat) ───
ALTER TABLE cod_confirmations DROP CONSTRAINT IF EXISTS cod_confirmations_status_check;
ALTER TABLE cod_confirmations ADD CONSTRAINT cod_confirmations_status_check
  CHECK (status IN ('pending', 'confirmed', 'cancel_requested', 'cancelled', 'no_reply', 'no_reply_cancelled'));

-- ── Widen the order-level cod_status enum to match ────────────────────────────
ALTER TABLE shopify_orders DROP CONSTRAINT IF EXISTS shopify_orders_cod_status_check;
ALTER TABLE shopify_orders ADD CONSTRAINT shopify_orders_cod_status_check
  CHECK (cod_status IN ('pending', 'confirmed', 'cancel_requested', 'cancelled', 'no_reply', 'no_reply_cancelled'));
