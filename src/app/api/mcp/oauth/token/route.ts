import { mcpEnabled } from '@/lib/mcp/auth'
import {
  ACCESS_TTL_SEC,
  canonicalOrigin,
  corsJson,
  corsPreflight,
  issueAccessToken,
  issueRefreshToken,
  oauthConfigured,
  sha256hex,
  verifyOAuthRefreshToken,
  verifyPkceS256,
} from '@/lib/mcp/oauth'
import { consumeOAuthCode } from '@/lib/mcp/db'

export const runtime = 'nodejs'

export function OPTIONS(): Response {
  return corsPreflight()
}

function tokenResponse(clientId: string, origin: string, includeRefresh: boolean) {
  return corsJson(200, {
    access_token: issueAccessToken(clientId, origin),
    token_type: 'Bearer',
    expires_in: ACCESS_TTL_SEC,
    scope: 'mcp',
    ...(includeRefresh ? { refresh_token: issueRefreshToken(clientId, origin) } : {}),
  })
}

export async function POST(req: Request): Promise<Response> {
  if (!mcpEnabled() || !oauthConfigured()) return corsJson(404, { error: 'not_found' })

  const form = await req.formData()
  const get = (k: string) => String(form.get(k) ?? '')
  const grant = get('grant_type')
  const origin = canonicalOrigin(req)

  if (grant === 'authorization_code') {
    const code = get('code')
    const verifier = get('code_verifier')
    const redirectUri = get('redirect_uri')
    const clientId = get('client_id')
    if (!code || !verifier || !redirectUri || !clientId) {
      return corsJson(400, { error: 'invalid_request', error_description: 'missing code/code_verifier/redirect_uri/client_id' })
    }
    const row = await consumeOAuthCode(sha256hex(code))
    if (!row) return corsJson(400, { error: 'invalid_grant', error_description: 'code invalid, expired, or already used' })
    if (row.client_id !== clientId) return corsJson(400, { error: 'invalid_grant', error_description: 'client mismatch' })
    if (row.redirect_uri !== redirectUri) return corsJson(400, { error: 'invalid_grant', error_description: 'redirect_uri mismatch' })
    if (!verifyPkceS256(verifier, row.code_challenge)) {
      return corsJson(400, { error: 'invalid_grant', error_description: 'PKCE verification failed' })
    }
    return tokenResponse(clientId, origin, true)
  }

  if (grant === 'refresh_token') {
    const refresh = get('refresh_token')
    const rt = refresh ? verifyOAuthRefreshToken(refresh) : null
    if (!rt) return corsJson(400, { error: 'invalid_grant', error_description: 'refresh_token invalid or expired' })
    return tokenResponse(rt.cid ?? 'wasify-mcp-oauth', origin, true)
  }

  return corsJson(400, { error: 'unsupported_grant_type' })
}
