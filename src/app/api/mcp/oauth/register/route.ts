import { mcpEnabled } from '@/lib/mcp/auth'
import {
  corsJson,
  corsPreflight,
  isAllowedRedirect,
  MAX_REDIRECT_URIS,
  nowSeconds,
  oauthConfigured,
  randomToken,
} from '@/lib/mcp/oauth'
import { saveOAuthClient } from '@/lib/mcp/db'

export const runtime = 'nodejs'

// RFC 7591 Dynamic Client Registration. Public clients (PKCE, no secret).
export function OPTIONS(): Response {
  return corsPreflight()
}

export async function POST(req: Request): Promise<Response> {
  if (!mcpEnabled() || !oauthConfigured()) return corsJson(404, { error: 'not_found' })

  let body: Record<string, unknown>
  try {
    body = (await req.json()) as Record<string, unknown>
  } catch {
    return corsJson(400, { error: 'invalid_request', error_description: 'invalid JSON body' })
  }

  const redirectUris = Array.isArray(body.redirect_uris)
    ? (body.redirect_uris.filter((u) => typeof u === 'string') as string[])
    : []
  if (redirectUris.length === 0) {
    return corsJson(400, { error: 'invalid_redirect_uri', error_description: 'redirect_uris is required' })
  }
  if (redirectUris.length > MAX_REDIRECT_URIS) {
    return corsJson(400, { error: 'invalid_redirect_uri', error_description: `at most ${MAX_REDIRECT_URIS} redirect_uris` })
  }
  for (const u of redirectUris) {
    if (!isAllowedRedirect(u)) {
      return corsJson(400, { error: 'invalid_redirect_uri', error_description: `disallowed redirect_uri: ${u}` })
    }
  }

  const clientId = `mcpc_${randomToken(16)}`
  const clientName = typeof body.client_name === 'string' ? body.client_name.slice(0, 120) : 'mcp-client'
  await saveOAuthClient({ client_id: clientId, client_name: clientName, redirect_uris: redirectUris })

  return corsJson(201, {
    client_id: clientId,
    client_id_issued_at: nowSeconds(),
    client_name: clientName,
    redirect_uris: redirectUris,
    token_endpoint_auth_method: 'none',
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
  })
}
