import crypto from 'crypto'
import { getPublicOrigin } from 'mcp-handler'
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js'
import { ownerUserId, verifyMcpBearer } from './auth'

// ===========================================================================
// OAuth 2.1 Authorization Server for the Wasify MCP (Phase 4).
//
// Adds an ADDITIONAL auth path (for the Claude web custom connector, which
// requires OAuth + PKCE, not a static bearer). It runs ALONGSIDE the existing
// bearer path — Claude Code keeps using `Authorization: Bearer mcp_...`.
//
// INDEPENDENCE FROM THE BEARER SECRET: this module NEVER reads MCP_BEARER_TOKEN.
// OAuth uses its OWN secrets (MCP_OAUTH_SIGNING_SECRET, MCP_OAUTH_AUTH_SECRET),
// so rotating MCP_BEARER_TOKEN cannot break OAuth (and vice-versa).
//
// SCOPE: OAuth does NOT widen anything. Issued tokens carry sub = the single
// owner (MCP_OWNER_USER_ID); tools are already owner-pinned regardless of how
// the caller authenticated, so no other account is ever reachable. Same 17
// read tools + the single guarded send_test_message. No new tools.
//
// FAIL-CLOSED: access tokens are HS256-signed, expiring, and rejected on any
// mismatch/expiry/wrong-type — the same posture as the bearer path.
// ===========================================================================

export const OAUTH_SCOPE = 'mcp'
export const ACCESS_TTL_SEC = 3600 // 1h
export const REFRESH_TTL_SEC = 30 * 24 * 3600 // 30d
export const CODE_TTL_SEC = 120 // 2m one-time auth code

const nowSec = () => Math.floor(Date.now() / 1000)

/** OAuth is available only when BOTH its dedicated secrets are configured. */
export function oauthConfigured(): boolean {
  return Boolean(process.env.MCP_OAUTH_SIGNING_SECRET && process.env.MCP_OAUTH_AUTH_SECRET)
}

function signingSecret(): string | null {
  const s = process.env.MCP_OAUTH_SIGNING_SECRET
  return s && s.length > 0 ? s : null
}

// --- Minimal HS256 JWT ------------------------------------------------------

type JwtPayload = Record<string, unknown> & { exp: number; iat: number; sub: string; typ: string }

function b64urlJson(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj), 'utf8').toString('base64url')
}

function signJwt(payload: Record<string, unknown>): string {
  const secret = signingSecret()
  if (!secret) throw new Error('MCP_OAUTH_SIGNING_SECRET not configured')
  const header = b64urlJson({ alg: 'HS256', typ: 'JWT' })
  const body = b64urlJson(payload)
  const data = `${header}.${body}`
  const sig = crypto.createHmac('sha256', secret).update(data).digest('base64url')
  return `${data}.${sig}`
}

/** Verify signature + expiry. Returns payload or null (fail-closed). */
export function verifyJwt(token: string): JwtPayload | null {
  const secret = signingSecret()
  if (!secret) return null
  const parts = token.split('.')
  if (parts.length !== 3) return null
  const [h, b, s] = parts
  const expected = crypto.createHmac('sha256', secret).update(`${h}.${b}`).digest('base64url')
  const a = Buffer.from(s)
  const e = Buffer.from(expected)
  if (a.length !== e.length || !crypto.timingSafeEqual(a, e)) return null
  let payload: JwtPayload
  try {
    payload = JSON.parse(Buffer.from(b, 'base64url').toString('utf8'))
  } catch {
    return null
  }
  if (typeof payload?.exp !== 'number' || payload.exp < nowSec()) return null
  return payload
}

// --- Token issuance ---------------------------------------------------------

export function issueAccessToken(clientId: string, origin: string): string {
  const iat = nowSec()
  return signJwt({
    iss: origin,
    sub: ownerUserId(),
    aud: `${origin}/api/mcp/mcp`,
    cid: clientId,
    scope: OAUTH_SCOPE,
    typ: 'access',
    iat,
    exp: iat + ACCESS_TTL_SEC,
    jti: crypto.randomUUID(),
  })
}

export function issueRefreshToken(clientId: string, origin: string): string {
  const iat = nowSec()
  return signJwt({
    iss: origin,
    sub: ownerUserId(),
    cid: clientId,
    typ: 'refresh',
    iat,
    exp: iat + REFRESH_TTL_SEC,
    jti: crypto.randomUUID(),
  })
}

/** Validate an OAuth access token: signed, unexpired, typ=access, owner sub. */
export function verifyOAuthAccessToken(token: string): { sub: string; scope: string; cid?: string } | null {
  const p = verifyJwt(token)
  if (!p || p.typ !== 'access') return null
  if (p.sub !== ownerUserId()) return null
  return { sub: p.sub, scope: typeof p.scope === 'string' ? p.scope : OAUTH_SCOPE, cid: typeof p.cid === 'string' ? p.cid : undefined }
}

/** Validate a refresh token: signed, unexpired, typ=refresh, owner sub. */
export function verifyOAuthRefreshToken(token: string): { sub: string; cid?: string } | null {
  const p = verifyJwt(token)
  if (!p || p.typ !== 'refresh') return null
  if (p.sub !== ownerUserId()) return null
  return { sub: p.sub, cid: typeof p.cid === 'string' ? p.cid : undefined }
}

// --- Combined verifier for withMcpAuth (OAuth OR static bearer) -------------

/**
 * withMcpAuth verifyToken: accept an OAuth access token OR the static bearer.
 * Both resolve to the same owner-scoped access; neither widens tools.
 */
export async function verifyMcpToken(req: Request, bearerToken?: string): Promise<AuthInfo | undefined> {
  if (bearerToken) {
    const oauth = verifyOAuthAccessToken(bearerToken)
    if (oauth) {
      return { token: bearerToken, clientId: oauth.cid ?? 'wasify-mcp-oauth', scopes: [oauth.scope] }
    }
  }
  // Fall back to the Stage-1 static bearer path (unchanged).
  return verifyMcpBearer(req, bearerToken)
}

// --- Auth-secret gate (single-user consent) --------------------------------

/** Constant-time check of the consent secret that gates who can complete OAuth. */
export function checkAuthSecret(provided: string): boolean {
  const expected = process.env.MCP_OAUTH_AUTH_SECRET
  if (!expected) return false
  const a = Buffer.from(provided ?? '')
  const e = Buffer.from(expected)
  if (a.length !== e.length) return false
  return crypto.timingSafeEqual(a, e)
}

// --- PKCE -------------------------------------------------------------------

/** Verify PKCE S256: base64url(sha256(verifier)) === challenge. */
export function verifyPkceS256(verifier: string, challenge: string): boolean {
  if (!verifier || !challenge) return false
  const computed = crypto.createHash('sha256').update(verifier).digest('base64url')
  const a = Buffer.from(computed)
  const e = Buffer.from(challenge)
  if (a.length !== e.length) return false
  return crypto.timingSafeEqual(a, e)
}

// --- misc helpers -----------------------------------------------------------

export const randomToken = (bytes = 32): string => crypto.randomBytes(bytes).toString('base64url')
export const sha256hex = (s: string): string => crypto.createHash('sha256').update(s).digest('hex')
export const nowSeconds = nowSec

/**
 * Canonical public origin for issuer / endpoint URLs / token iss+aud. Pinned to
 * NEXT_PUBLIC_SITE_URL when set (so a spoofed X-Forwarded-Host cannot poison the
 * advertised OAuth metadata); falls back to the proxy-derived origin otherwise.
 */
export function canonicalOrigin(req: Request): string {
  const site = process.env.NEXT_PUBLIC_SITE_URL
  if (site && /^https?:\/\//i.test(site)) return site.replace(/\/+$/, '')
  return getPublicOrigin(req)
}

/** Max redirect URIs a single dynamically-registered client may declare. */
export const MAX_REDIRECT_URIS = 5

/** Allowed redirect targets: https only (plus http://localhost for dev). */
export function isAllowedRedirect(uri: string): boolean {
  try {
    const u = new URL(uri)
    if (u.protocol === 'https:') return true
    if (u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1')) return true
    return false
  } catch {
    return false
  }
}

// --- Discovery metadata -----------------------------------------------------

export function authorizationServerMetadata(origin: string): Record<string, unknown> {
  return {
    issuer: origin,
    authorization_endpoint: `${origin}/api/mcp/oauth/authorize`,
    token_endpoint: `${origin}/api/mcp/oauth/token`,
    registration_endpoint: `${origin}/api/mcp/oauth/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    scopes_supported: [OAUTH_SCOPE],
  }
}

export function protectedResourceMetadata(origin: string): Record<string, unknown> {
  return {
    resource: `${origin}/api/mcp/mcp`,
    authorization_servers: [origin],
    scopes_supported: [OAUTH_SCOPE],
    bearer_methods_supported: ['header'],
  }
}

// --- JSON + CORS response helper (metadata/token/register are cross-origin) -

export function corsJson(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET, POST, OPTIONS',
      'access-control-allow-headers': 'content-type, authorization',
      'cache-control': 'no-store',
    },
  })
}

export function corsPreflight(): Response {
  return new Response(null, {
    status: 204,
    headers: {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET, POST, OPTIONS',
      'access-control-allow-headers': 'content-type, authorization',
    },
  })
}
