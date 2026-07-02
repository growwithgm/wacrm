import { mcpEnabled } from '@/lib/mcp/auth'
import { authorizationServerMetadata, canonicalOrigin, corsJson, corsPreflight, oauthConfigured } from '@/lib/mcp/oauth'

export const runtime = 'nodejs'

// Served at /.well-known/oauth-authorization-server via a next.config rewrite.
export function OPTIONS(): Response {
  return corsPreflight()
}

export function GET(req: Request): Response {
  if (!mcpEnabled() || !oauthConfigured()) return corsJson(404, { error: 'not_found' })
  return corsJson(200, authorizationServerMetadata(canonicalOrigin(req)))
}
