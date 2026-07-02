import crypto from 'crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  checkAuthSecret,
  isAllowedRedirect,
  issueAccessToken,
  issueRefreshToken,
  oauthConfigured,
  verifyMcpToken,
  verifyOAuthAccessToken,
  verifyOAuthRefreshToken,
  verifyPkceS256,
} from './oauth'

const OWNER = '15ea8034-8caf-4111-aaf1-a59a69f653e3'
const SIGNING = 'test-signing-secret-abc123'
const req = () => new Request('https://wasify-one.vercel.app/api/mcp/mcp')

// Mint a JWT exactly like oauth.ts (to craft expired / wrong-secret / tampered tokens).
function mint(payload: Record<string, unknown>, secret = SIGNING): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o), 'utf8').toString('base64url')
  const data = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64(payload)}`
  const sig = crypto.createHmac('sha256', secret).update(data).digest('base64url')
  return `${data}.${sig}`
}
const soon = () => Math.floor(Date.now() / 1000) + 3600
const past = () => Math.floor(Date.now() / 1000) - 10

beforeEach(() => {
  process.env.MCP_OWNER_USER_ID = OWNER
  process.env.MCP_OAUTH_SIGNING_SECRET = SIGNING
  process.env.MCP_OAUTH_AUTH_SECRET = 'consent-secret'
})
afterEach(() => {
  delete process.env.MCP_OWNER_USER_ID
  delete process.env.MCP_OAUTH_SIGNING_SECRET
  delete process.env.MCP_OAUTH_AUTH_SECRET
  delete process.env.MCP_BEARER_TOKEN
})

describe('oauthConfigured', () => {
  it('true only when both OAuth secrets are set', () => {
    expect(oauthConfigured()).toBe(true)
    delete process.env.MCP_OAUTH_AUTH_SECRET
    expect(oauthConfigured()).toBe(false)
  })
})

describe('access token validation is fail-closed', () => {
  it('accepts a freshly issued owner access token', () => {
    const tok = issueAccessToken('mcpc_x', 'https://wasify-one.vercel.app')
    const r = verifyOAuthAccessToken(tok)
    expect(r?.sub).toBe(OWNER)
    expect(r?.scope).toBe('mcp')
  })
  it('rejects an expired token', () => {
    const tok = mint({ typ: 'access', sub: OWNER, scope: 'mcp', iat: past(), exp: past() })
    expect(verifyOAuthAccessToken(tok)).toBeNull()
  })
  it('rejects a token signed with the wrong secret', () => {
    const tok = mint({ typ: 'access', sub: OWNER, scope: 'mcp', iat: Math.floor(Date.now() / 1000), exp: soon() }, 'WRONG-secret')
    expect(verifyOAuthAccessToken(tok)).toBeNull()
  })
  it('rejects a tampered signature', () => {
    const tok = issueAccessToken('mcpc_x', 'https://wasify-one.vercel.app')
    const tampered = tok.slice(0, -2) + (tok.endsWith('aa') ? 'bb' : 'aa')
    expect(verifyOAuthAccessToken(tampered)).toBeNull()
  })
  it('rejects a refresh token used as an access token (wrong typ)', () => {
    const refresh = issueRefreshToken('mcpc_x', 'https://wasify-one.vercel.app')
    expect(verifyOAuthAccessToken(refresh)).toBeNull()
  })
  it('rejects a token whose sub is not the owner', () => {
    const tok = mint({ typ: 'access', sub: 'someone-else', scope: 'mcp', iat: Math.floor(Date.now() / 1000), exp: soon() })
    expect(verifyOAuthAccessToken(tok)).toBeNull()
  })
  it('rejects everything when the signing secret is unset (fail-closed)', () => {
    const tok = issueAccessToken('mcpc_x', 'https://wasify-one.vercel.app')
    delete process.env.MCP_OAUTH_SIGNING_SECRET
    expect(verifyOAuthAccessToken(tok)).toBeNull()
  })
})

describe('refresh token validation', () => {
  it('accepts a valid refresh token, rejects an access token', () => {
    expect(verifyOAuthRefreshToken(issueRefreshToken('mcpc_x', 'https://x'))?.sub).toBe(OWNER)
    expect(verifyOAuthRefreshToken(issueAccessToken('mcpc_x', 'https://x'))).toBeNull()
  })
})

describe('OAuth resolves ONLY to the owner', () => {
  it('every issued access token carries sub = MCP_OWNER_USER_ID', () => {
    const r = verifyOAuthAccessToken(issueAccessToken('mcpc_x', 'https://x'))
    expect(r?.sub).toBe(OWNER)
  })
})

describe('PKCE S256', () => {
  it('accepts the correct verifier and rejects a wrong one', () => {
    const verifier = 'a'.repeat(64)
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url')
    expect(verifyPkceS256(verifier, challenge)).toBe(true)
    expect(verifyPkceS256('b'.repeat(64), challenge)).toBe(false)
    expect(verifyPkceS256('', challenge)).toBe(false)
  })
})

describe('consent secret gate', () => {
  it('constant-time matches only the exact secret', () => {
    expect(checkAuthSecret('consent-secret')).toBe(true)
    expect(checkAuthSecret('wrong')).toBe(false)
    expect(checkAuthSecret('')).toBe(false)
  })
})

describe('redirect allowlist', () => {
  it('allows https and localhost, rejects other http and junk', () => {
    expect(isAllowedRedirect('https://claude.ai/api/mcp/auth_callback')).toBe(true)
    expect(isAllowedRedirect('http://localhost:3000/cb')).toBe(true)
    expect(isAllowedRedirect('http://evil.example.com/cb')).toBe(false)
    expect(isAllowedRedirect('not-a-url')).toBe(false)
  })
})

describe('verifyMcpToken — dual path, OAuth independent of the bearer', () => {
  it('accepts a valid OAuth access token even with NO MCP_BEARER_TOKEN set', async () => {
    delete process.env.MCP_BEARER_TOKEN
    const tok = issueAccessToken('mcpc_x', 'https://x')
    const info = await verifyMcpToken(req(), tok)
    expect(info?.clientId).toBe('mcpc_x')
    expect(info?.token).toBe(tok)
  })
  it('still accepts the static bearer token (Stage 1-3 path unbroken)', async () => {
    process.env.MCP_BEARER_TOKEN = 'mcp_static_bearer'
    const info = await verifyMcpToken(req(), 'mcp_static_bearer')
    expect(info?.token).toBe('mcp_static_bearer')
  })
  it('rejects garbage on both paths', async () => {
    process.env.MCP_BEARER_TOKEN = 'mcp_static_bearer'
    expect(await verifyMcpToken(req(), 'garbage')).toBeUndefined()
    expect(await verifyMcpToken(req(), undefined)).toBeUndefined()
  })
})
