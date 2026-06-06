-- ============================================================
-- 021_cod_variable_mapping_responses.sql
-- Part A: per-template-slot {{n}} variable mapping.
-- Part B: configurable response per reply outcome.
-- Builds on 019/020. Idempotent; safe to run multiple times.
-- ============================================================

-- Part A — variable maps: placeholder-index → order-field key, per slot.
-- Default reproduces the prior hardcoded behavior ({{1}}=order number, {{2}}=total),
-- so existing confirmation/thank-you sends keep working with no reconfiguration.
ALTER TABLE shopify_config
  ADD COLUMN IF NOT EXISTS cod_confirm_var_map  JSONB NOT NULL DEFAULT '{"1":"order_number","2":"total"}'::jsonb,
  ADD COLUMN IF NOT EXISTS cod_thankyou_var_map JSONB NOT NULL DEFAULT '{"1":"order_number","2":"total"}'::jsonb,
  ADD COLUMN IF NOT EXISTS cod_noreply_var_map  JSONB NOT NULL DEFAULT '{"1":"order_number","2":"total"}'::jsonb;

-- Part B — free-text replies INSIDE the 24h window (plain text, not templates).
ALTER TABLE shopify_config
  ADD COLUMN IF NOT EXISTS cod_yes_message_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS cod_yes_message_text    TEXT,
  ADD COLUMN IF NOT EXISTS cod_no_message_enabled  BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS cod_no_message_text     TEXT;

-- Part B — no-reply outcome is OUTSIDE the window → approved template only.
ALTER TABLE shopify_config
  ADD COLUMN IF NOT EXISTS cod_noreply_template_enabled  BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS cod_noreply_template_name     TEXT,
  ADD COLUMN IF NOT EXISTS cod_noreply_template_language TEXT;

-- Order-field snapshot so reminders / thank-you / no-reply (sent later from the
-- cod_confirmations row, with no live order) can fill mapped variables.
-- order_number / total / currency already exist on this table (migration 019).
ALTER TABLE cod_confirmations
  ADD COLUMN IF NOT EXISTS customer_first_name TEXT,
  ADD COLUMN IF NOT EXISTS customer_full_name  TEXT,
  ADD COLUMN IF NOT EXISTS items_count         INTEGER,
  ADD COLUMN IF NOT EXISTS shipping_city       TEXT;
