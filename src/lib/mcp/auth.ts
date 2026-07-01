import crypto from 'crypto'
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js'

// ---------------------------------------------------------------------------
// MCP server auth + kill-switch helpers (Phase 1).
//
// The MCP endpoint is authenticated by a SINGLE dedicated bearer secret
// (MCP_BEARER_TOKEN) — deliberately distinct from WACRM_API_TOKEN, the
// Supabase service-role key, and the cron secret. Compared in constant time.
//
// Fail-closed everywhere:
//   - MCP_ENABLED must be exactly 'true' or the whole surface is 503 (see the
//     route handler + middleware). Default (unset) = disabled.
//   - MCP_BEARER_TOKEN must be set or the endpoint 503s (never open).
//   - Every future tool is pinned to MCP_OWNER_USER_ID (DonCabello's account).
// ---------------------------------------------------------------------------

/** Kill-switch. Disabled unless MCP_ENABLED === 'true'. */
export function mcpEnabled(): boolean {
  return process.env.MCP_ENABLED === 'true'
}

/** True only when a non-empty bearer secret is configured. */
export function mcpBearerConfigured(): boolean {
  const t = process.env.MCP_BEARER_TOKEN
  return typeof t === 'string' && t.length > 0
}

/** Constant-time string comparison (length-checked). */
function timingSafeEqualStr(provided: string, expected: string): boolean {
  const a = Buffer.from(provided)
  const b = Buffer.from(expected)
  if (a.length !== b.length) return false
  return crypto.timingSafeEqual(a, b)
}

/**
 * withMcpAuth verifyToken callback. Receives the already-parsed bearer token.
 * Returns an AuthInfo on success, or undefined → withMcpAuth responds 401.
 * The route handler separately 503s when MCP_ENABLED/MCP_BEARER_TOKEN are unset.
 */
export async function verifyMcpBearer(
  _req: Request,
  bearerToken?: string,
): Promise<AuthInfo | undefined> {
  const expected = process.env.MCP_BEARER_TOKEN
  if (!expected) return undefined
  if (!bearerToken) return undefined
  if (!timingSafeEqualStr(bearerToken, expected)) return undefined
  return { token: bearerToken, clientId: 'wasify-mcp-owner', scopes: [] }
}

/**
 * The single owner account every MCP query/tool is pinned to (DonCabello).
 * Throws if unset so a misconfiguration fails closed rather than acting on
 * the wrong / no account. Not used by Stage 1 (no tools yet) but lives here
 * so tool code has one source of truth.
 */
export function ownerUserId(): string {
  const id = process.env.MCP_OWNER_USER_ID
  if (!id) throw new Error('MCP_OWNER_USER_ID is not set')
  return id
}
