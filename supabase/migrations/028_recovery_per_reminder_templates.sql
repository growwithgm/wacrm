-- ============================================================
-- 028_recovery_per_reminder_templates.sql
-- Cart Recovery — a separate template per reminder (1 / 2 / 3).
--
-- Run BEFORE deploying the per-reminder code. Idempotent.
--
-- Design: ADD three name columns per language family (es/en). The
-- previously-single recovery_template_name_es/_en is backfilled into
-- all three slots so current behavior (same template for all reminders)
-- is preserved until the merchant differentiates them. The old single
-- columns are KEPT (not dropped) — harmless, and a safe rollback target.
-- The shared language hints recovery_template_lang_es/_en stay as-is;
-- the engine still resolves the exact approved language by template name
-- at send time (resolveTemplate), so per-slot language isn't needed.
-- ============================================================

ALTER TABLE shopify_config
  ADD COLUMN IF NOT EXISTS recovery_template1_name_es TEXT,
  ADD COLUMN IF NOT EXISTS recovery_template2_name_es TEXT,
  ADD COLUMN IF NOT EXISTS recovery_template3_name_es TEXT,
  ADD COLUMN IF NOT EXISTS recovery_template1_name_en TEXT,
  ADD COLUMN IF NOT EXISTS recovery_template2_name_en TEXT,
  ADD COLUMN IF NOT EXISTS recovery_template3_name_en TEXT;

-- Seed the three slots from the old single template (COALESCE so a
-- re-run never clobbers values the merchant has since set per reminder).
UPDATE shopify_config SET
  recovery_template1_name_es = COALESCE(recovery_template1_name_es, recovery_template_name_es),
  recovery_template2_name_es = COALESCE(recovery_template2_name_es, recovery_template_name_es),
  recovery_template3_name_es = COALESCE(recovery_template3_name_es, recovery_template_name_es),
  recovery_template1_name_en = COALESCE(recovery_template1_name_en, recovery_template_name_en),
  recovery_template2_name_en = COALESCE(recovery_template2_name_en, recovery_template_name_en),
  recovery_template3_name_en = COALESCE(recovery_template3_name_en, recovery_template_name_en);
