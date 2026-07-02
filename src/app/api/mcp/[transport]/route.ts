import { createMcpHandler, withMcpAuth } from 'mcp-handler'
import { mcpBearerConfigured, mcpEnabled } from '@/lib/mcp/auth'
import { oauthConfigured, verifyMcpToken } from '@/lib/mcp/oauth'
import { registerReadTools } from '@/lib/mcp/tools/read'
import { registerSendTestTool } from '@/lib/mcp/tools/send-test'

// Node runtime (needs crypto + service-role Supabase); 60s ceiling.
export const runtime = 'nodejs'
export const maxDuration = 60

// ---------------------------------------------------------------------------
// Wasify MCP endpoint — Streamable HTTP at /api/mcp/mcp (SSE disabled).
//
// STAGE 4: two auth paths, both fail-closed, both resolving to the same
// owner-scoped tools (17 read + 1 guarded send). No new tools.
//   - Static bearer (Claude Code): Authorization: Bearer mcp_...  (MCP_BEARER_TOKEN)
//   - OAuth 2.1 access token (Claude web connector): HS256 JWT (MCP_OAUTH_*).
// verifyMcpToken tries OAuth first, then the static bearer. The OAuth path is
// independent of MCP_BEARER_TOKEN, so rotating the bearer never affects OAuth.
//
// Gates: MCP_ENABLED!=='true' -> 503; neither auth path configured -> 503;
// missing/invalid token -> 401 (withMcpAuth, with a WWW-Authenticate pointing
// at the protected-resource metadata so OAuth clients can discover the AS).
// ---------------------------------------------------------------------------

function jsonError(status: number, error: string): Response {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

const mcpHandler = createMcpHandler(
  (server) => {
    registerReadTools(server)
    registerSendTestTool(server)
  },
  { serverInfo: { name: 'wasify-mcp', version: '0.4.0' } },
  { basePath: '/api/mcp', disableSse: true, maxDuration: 60 },
)

const authedHandler = withMcpAuth(mcpHandler, verifyMcpToken, {
  required: true,
  resourceMetadataPath: '/.well-known/oauth-protected-resource',
})

async function handler(req: Request): Promise<Response> {
  if (!mcpEnabled()) return jsonError(503, 'mcp_disabled')
  // Fail closed unless at least one auth path is configured.
  if (!mcpBearerConfigured() && !oauthConfigured()) return jsonError(503, 'mcp_not_configured')
  return authedHandler(req)
}

export { handler as DELETE, handler as GET, handler as POST }
