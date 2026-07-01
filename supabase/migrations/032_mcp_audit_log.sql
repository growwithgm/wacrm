-- ============================================================
-- MCP audit log (Phase 1).
--
-- Append-only record of every MCP tool invocation. Written ONLY by
-- the server via the service-role client — no user-facing policies,
-- mirroring automation_pending_executions / flow_run_events.
--
-- Stores NO customer PII and NO message bodies: only the tool name,
-- a coarse principal, a SHA-256 hash of the arguments, a redacted
-- target, the result, and a short detail. It also backs the DURABLE
-- daily send-cap for send_test_message (Stage 3) — the in-memory
-- rate limiter (src/lib/rate-limit.ts) resets on every serverless
-- redeploy and cannot enforce a real per-day ceiling.
--
-- Stage 1 creates the table only; nothing writes to it yet.
-- Safe to run multiple times.
-- ============================================================

CREATE TABLE IF NOT EXISTS mcp_audit_log (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Tool name, e.g. 'list_contacts', 'send_test_message'.
  tool        TEXT        NOT NULL,
  -- Coarse principal. Never the bearer token; just 'mcp' for now.
  actor       TEXT        NOT NULL DEFAULT 'mcp',
  -- SHA-256 of the JSON arguments. NEVER raw args (would leak PII).
  params_hash TEXT,
  -- Redacted target reference, e.g. 'conversation:<uuid>' — never a
  -- phone number or message text.
  target      TEXT,
  result      TEXT        NOT NULL
                          CHECK (result IN ('ok', 'error', 'dry_run', 'rate_limited', 'denied')),
  -- Short, redacted detail (e.g. an error class). NEVER message bodies.
  detail      TEXT
);

CREATE INDEX IF NOT EXISTS idx_mcp_audit_created
  ON mcp_audit_log (created_at DESC);

-- Backs the daily send-cap lookup: count today's rows for a tool.
CREATE INDEX IF NOT EXISTS idx_mcp_audit_tool_created
  ON mcp_audit_log (tool, created_at DESC);

-- RLS ON with NO policies: only the service-role key (which bypasses
-- RLS by design) can read/write. Authenticated browser clients get
-- nothing — same pattern as automation_pending_executions.
ALTER TABLE mcp_audit_log ENABLE ROW LEVEL SECURITY;
