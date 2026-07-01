import { createMcpHandler, withMcpAuth } from 'mcp-handler'
import { mcpBearerConfigured, mcpEnabled, verifyMcpBearer } from '@/lib/mcp/auth'

// Node runtime (needs crypto + service-role Supabase later); 60s ceiling.
export const runtime = 'nodejs'
export const maxDuration = 60

// ---------------------------------------------------------------------------
// Wasify MCP endpoint — Streamable HTTP at /api/mcp/mcp (SSE disabled).
//
// STAGE 1: ZERO tools are registered. This ships the transport + auth +
// kill-switch ONLY, so 503 (disabled) / 401 (bad token) / 200 (initialize)
// can be verified in production before any read/send tool exists.
//
// Order of gates on every request:
//   1. MCP_ENABLED !== 'true'          -> 503 (kill-switch, fail-closed)
//   2. MCP_BEARER_TOKEN unset          -> 503 (never run open)
//   3. missing / wrong bearer token    -> 401 (withMcpAuth, constant-time)
//   4. valid bearer                    -> 200 MCP handshake
// (Gates 1 and a coarse form of 3 are also enforced at the edge in middleware.)
// ---------------------------------------------------------------------------

function jsonError(status: number, error: string): Response {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

const mcpHandler = createMcpHandler(
  () => {
    // Stage 1: no tools registered yet.
  },
  { serverInfo: { name: 'wasify-mcp', version: '0.1.0' } },
  { basePath: '/api/mcp', disableSse: true, maxDuration: 60 },
)

const authedHandler = withMcpAuth(mcpHandler, verifyMcpBearer, { required: true })

async function handler(req: Request): Promise<Response> {
  if (!mcpEnabled()) return jsonError(503, 'mcp_disabled')
  if (!mcpBearerConfigured()) return jsonError(503, 'mcp_not_configured')
  return authedHandler(req)
}

export { handler as DELETE, handler as GET, handler as POST }
