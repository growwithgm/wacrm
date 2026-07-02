import { mcpEnabled } from '@/lib/mcp/auth'
import { canonicalOrigin, corsJson, corsPreflight, oauthConfigured, protectedResourceMetadata } from '@/lib/mcp/oauth'

export const runtime = 'nodejs'

// Served at /.well-known/oauth-protected-resource via a next.config rewrite.
export function OPTIONS(): Response {
  return corsPreflight()
}

export function GET(req: Request): Response {
  if (!mcpEnabled() || !oauthConfigured()) return corsJson(404, { error: 'not_found' })
  return corsJson(200, protectedResourceMetadata(canonicalOrigin(req)))
}
