-- ============================================================
-- 027_recovery_optout.sql
-- Abandoned-checkout recovery — customer STOP / opt-out.
--
-- Run BEFORE deploying the opt-out code. Idempotent.
--
--   1. shopify_config.recovery_stop_keywords — merchant-editable list
--      of opt-out keywords (case-insensitive). Default list provided;
--      the Recovery settings UI edits it.
--   2. checkout_recoveries.status gains 'opted_out' — set when the
--      customer replies to a recovery message with a stop keyword. It
--      stops ONLY the current sequence; a future checkout still starts
--      a fresh sequence normally (no permanent/global block).
-- ============================================================

-- ── 1. Configurable STOP keywords (per tenant) ──────────────────────
-- TEXT[] so the UI can edit the list freely. Existing rows inherit the
-- default. Matching is normalized (lowercase, accent-insensitive,
-- whole-word) in the engine, so store keywords in any case.
ALTER TABLE shopify_config
  ADD COLUMN IF NOT EXISTS recovery_stop_keywords TEXT[]
    NOT NULL DEFAULT ARRAY['stop', 'baja', 'parar', 'unsubscribe'];

-- ── 2. Widen the recovery status enum with 'opted_out' ──────────────
-- The constraint was created inline in 026 with the default name
-- checkout_recoveries_status_check. Drop + re-add to extend it; the new
-- value sits alongside the existing terminal states.
ALTER TABLE checkout_recoveries
  DROP CONSTRAINT IF EXISTS checkout_recoveries_status_check;
ALTER TABLE checkout_recoveries
  ADD CONSTRAINT checkout_recoveries_status_check
  CHECK (status IN (
    'active', 'done', 'completed_order',
    'skipped_no_phone', 'suppressed_cooldown', 'opted_out'
  ));
