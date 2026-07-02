import { mcpEnabled } from '@/lib/mcp/auth'
import {
  CODE_TTL_SEC,
  OAUTH_SCOPE,
  checkAuthSecret,
  oauthConfigured,
  randomToken,
  sha256hex,
} from '@/lib/mcp/oauth'
import { getOAuthClient, saveOAuthCode } from '@/lib/mcp/db'

export const runtime = 'nodejs'

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

interface AuthzParams {
  client_id: string
  redirect_uri: string
  response_type: string
  code_challenge: string
  code_challenge_method: string
  scope: string
  state: string
}

function readParams(sp: URLSearchParams): AuthzParams {
  return {
    client_id: sp.get('client_id') ?? '',
    redirect_uri: sp.get('redirect_uri') ?? '',
    response_type: sp.get('response_type') ?? '',
    code_challenge: sp.get('code_challenge') ?? '',
    code_challenge_method: sp.get('code_challenge_method') ?? '',
    scope: sp.get('scope') ?? OAUTH_SCOPE,
    state: sp.get('state') ?? '',
  }
}

type ValidateResult = { error: string } | { client: { client_id: string; client_name: string; redirect_uris: string[] } }

/** Validate the request against the registered client. */
async function validate(p: AuthzParams): Promise<ValidateResult> {
  if (p.response_type !== 'code') return { error: 'response_type must be "code"' }
  if (!p.code_challenge) return { error: 'code_challenge is required (PKCE)' }
  if (p.code_challenge_method !== 'S256') return { error: 'code_challenge_method must be "S256"' }
  if (!p.client_id) return { error: 'client_id is required' }
  const client = await getOAuthClient(p.client_id)
  if (!client) return { error: 'unknown client_id' }
  if (!p.redirect_uri || !client.redirect_uris.includes(p.redirect_uri)) {
    return { error: 'redirect_uri not registered for this client' }
  }
  return { client }
}

function consentPage(p: AuthzParams, clientName: string, error?: string): Response {
  const hidden = (['client_id', 'redirect_uri', 'response_type', 'code_challenge', 'code_challenge_method', 'scope', 'state'] as const)
    .map((k) => `<input type="hidden" name="${k}" value="${esc(p[k])}">`)
    .join('\n      ')
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Authorize Wasify MCP</title>
<style>body{font-family:system-ui,sans-serif;max-width:440px;margin:8vh auto;padding:0 20px;color:#0f172a}
h1{font-size:1.2rem}.card{border:1px solid #e2e8f0;border-radius:12px;padding:20px}
input[type=password]{width:100%;padding:10px;border:1px solid #cbd5e1;border-radius:8px;margin:8px 0 16px}
button{padding:10px 16px;border-radius:8px;border:0;font-weight:600;cursor:pointer}
.approve{background:#16a34a;color:#fff}.deny{background:#e2e8f0;color:#0f172a;margin-left:8px}
.err{color:#b91c1c;font-size:.9rem}.muted{color:#64748b;font-size:.85rem}
.tgt{background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:10px;font-size:.85rem;margin:12px 0;word-break:break-all}
.tgt code{color:#0f172a}</style></head>
<body><div class="card">
<h1>Authorize access to Wasify MCP</h1>
<p class="muted">Grants a client READ-ONLY access to your Wasify data plus the single test-message tool (to +34632189061 only). Verify the client below, then enter the authorization secret to approve.</p>
<div class="tgt"><strong>Client:</strong> ${esc(clientName)}<br><strong>Redirect:</strong> <code>${esc(p.redirect_uri)}</code></div>
${error ? `<p class="err">${esc(error)}</p>` : ''}
<form method="POST">
      ${hidden}
  <label for="s">Authorization secret</label>
  <input id="s" type="password" name="authorization_secret" autocomplete="off" autofocus>
  <div>
    <button class="approve" type="submit" name="decision" value="approve">Approve</button>
    <button class="deny" type="submit" name="decision" value="deny">Deny</button>
  </div>
</form>
</div></body></html>`
  return new Response(html, {
    status: error ? 401 : 200,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
  })
}

function errorPage(message: string, status = 400): Response {
  return new Response(`<!doctype html><meta charset="utf-8"><body style="font-family:system-ui;max-width:420px;margin:8vh auto"><h1>Authorization error</h1><p>${esc(message)}</p></body>`, {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
  })
}

function redirectBack(redirectUri: string, params: Record<string, string>): Response {
  const url = new URL(redirectUri)
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
  return new Response(null, { status: 302, headers: { location: url.toString(), 'cache-control': 'no-store' } })
}

export async function GET(req: Request): Promise<Response> {
  if (!mcpEnabled() || !oauthConfigured()) return errorPage('OAuth is not available.', 404)
  const p = readParams(new URL(req.url).searchParams)
  const v = await validate(p)
  if ('error' in v) return errorPage(v.error)
  return consentPage(p, v.client.client_name)
}

export async function POST(req: Request): Promise<Response> {
  if (!mcpEnabled() || !oauthConfigured()) return errorPage('OAuth is not available.', 404)

  const form = await req.formData()
  const get = (k: string) => String(form.get(k) ?? '')
  const p: AuthzParams = {
    client_id: get('client_id'),
    redirect_uri: get('redirect_uri'),
    response_type: get('response_type'),
    code_challenge: get('code_challenge'),
    code_challenge_method: get('code_challenge_method'),
    scope: get('scope') || OAUTH_SCOPE,
    state: get('state'),
  }
  const v = await validate(p)
  if ('error' in v) return errorPage(v.error)

  if (get('decision') === 'deny') {
    return redirectBack(p.redirect_uri, { error: 'access_denied', ...(p.state ? { state: p.state } : {}) })
  }

  // Single-user gate: only the holder of MCP_OAUTH_AUTH_SECRET can complete.
  if (!checkAuthSecret(get('authorization_secret'))) {
    return consentPage(p, v.client.client_name, 'Invalid authorization secret.')
  }

  const code = randomToken(32)
  await saveOAuthCode({
    code_hash: sha256hex(code),
    client_id: p.client_id,
    redirect_uri: p.redirect_uri,
    code_challenge: p.code_challenge,
    code_challenge_method: 'S256',
    scope: p.scope,
    expires_at: new Date(Date.now() + CODE_TTL_SEC * 1000).toISOString(),
  })

  return redirectBack(p.redirect_uri, { code, ...(p.state ? { state: p.state } : {}) })
}
