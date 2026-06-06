-- ============================================================
-- 020_cod_panel_settings.sql
-- COD Confirmation control panel — config columns behind the new UI.
--
-- Builds on migration 019 (which added cod_enabled, cod_template_name,
-- cod_template_language, cod_reminder1_hours=24, cod_reminder2_hours=48,
-- cod_noreply_hours=72, and the cod_tag_* columns). These add a post-confirm
-- thank-you message and explicit reminder controls that the UI writes.
--
-- Idempotent; safe to run multiple times.
-- ============================================================

-- ── Step 3 — thank-you message (sent once after a COD order is confirmed) ────
ALTER TABLE shopify_config
  ADD COLUMN IF NOT EXISTS cod_thankyou_enabled           BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS cod_thankyou_template_name     TEXT,
  ADD COLUMN IF NOT EXISTS cod_thankyou_template_language TEXT;

-- ── Step 4 — reminder controls ──────────────────────────────────────────────
-- Delays already exist (cod_reminder1_hours=24, cod_reminder2_hours=48) and the
-- no-reply cutoff is cod_noreply_hours=72. These add an on/off master toggle
-- and a count so the merchant can send 0, 1, or 2 reminders.
ALTER TABLE shopify_config
  ADD COLUMN IF NOT EXISTS cod_reminders_enabled BOOLEAN  NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS cod_reminder_count    SMALLINT NOT NULL DEFAULT 2
    CHECK (cod_reminder_count BETWEEN 0 AND 2);

-- ── Thank-you idempotency + flow-complete marker on the confirmation row ─────
ALTER TABLE cod_confirmations
  ADD COLUMN IF NOT EXISTS cod_thankyou_sent_at TIMESTAMPTZ;
