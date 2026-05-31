-- Add WABA account name and last-checked timestamp to whatsapp_config.
-- waba_name: populated from Meta Graph API /{waba_id}?fields=id,name
-- last_checked_at: updated every time the health-check API route runs

ALTER TABLE whatsapp_config
  ADD COLUMN IF NOT EXISTS waba_name TEXT,
  ADD COLUMN IF NOT EXISTS last_checked_at TIMESTAMPTZ;
