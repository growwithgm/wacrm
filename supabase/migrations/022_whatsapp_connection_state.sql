-- ============================================================
-- 022_whatsapp_connection_state.sql
-- Honest 3-state WhatsApp connection status, persisted so the settings
-- banner/pill and the sidebar "API status" all read one source of truth.
--
--   connected      — token valid AND has whatsapp_business_messaging for the WABA
--   cannot_send    — token valid but missing messaging permission (sends #200)
--   not_connected  — token invalid / revoked / expired
--
-- The legacy `status` column (connected|disconnected) is kept for back-compat;
-- this adds the finer state. Idempotent.
-- ============================================================

ALTER TABLE whatsapp_config
  ADD COLUMN IF NOT EXISTS connection_state TEXT
    CHECK (connection_state IN ('connected', 'cannot_send', 'not_connected'));
