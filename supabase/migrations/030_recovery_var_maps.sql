-- ============================================================
-- 030_recovery_var_maps.sql
-- Cart Recovery — per-reminder variable mapping.
--
-- Run BEFORE deploying the variable-selector code. Idempotent.
--
-- One JSONB map per reminder (1/2/3), language-agnostic: the es and en
-- template for the same reminder share placeholder semantics, so one map
-- covers both. Shape mirrors the COD var maps:
--   { "1": "<field key>", "2": "<field key>", "button": "<url source key>" }
-- Default '{}' → the engine falls back to the built-in defaults
-- ({{1}} = customer first name, {{2}} = cart total, button = recovery URL),
-- so existing setups behave exactly as before until the merchant changes
-- the mapping.
-- ============================================================

ALTER TABLE shopify_config
  ADD COLUMN IF NOT EXISTS recovery_template1_var_map JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS recovery_template2_var_map JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS recovery_template3_var_map JSONB NOT NULL DEFAULT '{}'::jsonb;
