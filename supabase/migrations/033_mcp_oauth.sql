-- ============================================================
-- MCP OAuth 2.1 server state (Phase 4).
--
-- Two tables backing the self-hosted Authorization Server used by the
-- Claude web custom connector. Written ONLY by the server via the
-- service-role client — RLS ON, NO user policies (same pattern as
-- mcp_audit_log). No customer PII: client ids, redirect URIs, and
-- hashed one-time auth codes only. Access/refresh tokens are NOT
-- stored (stateless HS256 JWTs, validated by signature + expiry).
--
-- Safe to run multiple times.
-- ============================================================

-- Dynamically-registered OAuth clients (RFC 7591). Public PKCE clients.
CREATE TABLE IF NOT EXISTS mcp_oauth_clients (
  client_id     TEXT        PRIMARY KEY,
  client_name   TEXT,
  redirect_uris TEXT[]      NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE mcp_oauth_clients ENABLE ROW LEVEL SECURITY;

-- One-time authorization codes. `code_hash` = sha256(code) so the raw
-- code is never stored. `used_at` gives one-time-use / replay protection.
CREATE TABLE IF NOT EXISTS mcp_oauth_codes (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  code_hash             TEXT        NOT NULL UNIQUE,
  client_id             TEXT        NOT NULL,
  redirect_uri          TEXT        NOT NULL,
  code_challenge        TEXT        NOT NULL,
  code_challenge_method TEXT        NOT NULL DEFAULT 'S256',
  scope                 TEXT,
  expires_at            TIMESTAMPTZ NOT NULL,
  used_at               TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_mcp_oauth_codes_hash ON mcp_oauth_codes (code_hash);
CREATE INDEX IF NOT EXISTS idx_mcp_oauth_codes_expiry ON mcp_oauth_codes (expires_at);

ALTER TABLE mcp_oauth_codes ENABLE ROW LEVEL SECURITY;
