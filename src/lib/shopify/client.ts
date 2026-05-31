import { createClient as createAdminClient } from '@supabase/supabase-js'
import { encrypt, decrypt } from '@/lib/whatsapp/encryption'

export const SHOPIFY_API_VERSION = '2026-04'

// Refresh the token when fewer than 5 minutes remain.
const EXPIRY_BUFFER_MS = 5 * 60 * 1000

export interface ShopifyConfigRow {
  id: string
  user_id: string
  store_domain: string
  access_token: string       // AES-256-GCM encrypted
  refresh_token: string | null  // encrypted, null for non-expiring tokens
  token_expires_at: string | null
  scopes: string | null
  shop_name: string | null
  shop_id: string | null
  connection_status: 'connected' | 'disconnected' | 'error'
  last_synced_at: string | null
}

// ─── Token Exchange ───────────────────────────────────────────────────────────

export interface TokenResponse {
  access_token: string
  refresh_token?: string
  expires_in?: number
  scope: string
}

/**
 * POST the OAuth authorization code to Shopify and receive an access token.
 * Called once, immediately after the user authorises the app.
 */
export async function exchangeCodeForToken(
  shop: string,
  code: string,
): Promise<TokenResponse> {
  const res = await fetch(`https://${shop}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: process.env.SHOPIFY_CLIENT_ID!,
      client_secret: process.env.SHOPIFY_CLIENT_SECRET!,
      code,
    }),
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Token exchange failed (${res.status}): ${text}`)
  }
  return res.json() as Promise<TokenResponse>
}

/**
 * Refresh an expiring offline access token.
 * As of April 1 2026, all new Shopify public-app offline tokens expire
 * and must be refreshed before they run out.
 */
async function refreshAccessToken(
  shop: string,
  refreshToken: string,
): Promise<TokenResponse> {
  const res = await fetch(`https://${shop}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: process.env.SHOPIFY_CLIENT_ID!,
      client_secret: process.env.SHOPIFY_CLIENT_SECRET!,
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    }),
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Token refresh failed (${res.status}): ${text}`)
  }
  return res.json() as Promise<TokenResponse>
}

// ─── Token Resolution ─────────────────────────────────────────────────────────

/**
 * Given a shopify_config row, decrypt and return a valid access token,
 * refreshing it first if it is about to expire.  Writes the new token back
 * to the DB when a refresh occurs so the next call is instant.
 *
 * Throws if the token has expired and cannot be refreshed (user must reconnect).
 */
export async function getValidToken(config: ShopifyConfigRow): Promise<string> {
  const rawToken = decrypt(config.access_token)

  // No expiry info → non-expiring / legacy token, use as-is.
  if (!config.token_expires_at) return rawToken

  const expiresAt = new Date(config.token_expires_at).getTime()
  if (Date.now() + EXPIRY_BUFFER_MS < expiresAt) return rawToken

  // Token expired or about to — attempt refresh.
  if (!config.refresh_token) {
    throw new Error(
      'Access token expired and no refresh token is available. Please reconnect your Shopify store.',
    )
  }

  const rawRefreshToken = decrypt(config.refresh_token)
  const refreshed = await refreshAccessToken(config.store_domain, rawRefreshToken)

  const now = Date.now()
  const newExpiresAt = refreshed.expires_in
    ? new Date(now + refreshed.expires_in * 1000).toISOString()
    : null

  // Persist the fresh token so subsequent requests skip the refresh round-trip.
  // Typed as `any` to match the lazy-init admin-client pattern used across routes.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db: any = createAdminClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  )
  await db
    .from('shopify_config')
    .update({
      access_token: encrypt(refreshed.access_token),
      ...(refreshed.refresh_token
        ? { refresh_token: encrypt(refreshed.refresh_token) }
        : {}),
      token_expires_at: newExpiresAt,
      updated_at: new Date().toISOString(),
    })
    .eq('id', config.id)

  return refreshed.access_token
}

// ─── GraphQL Client ───────────────────────────────────────────────────────────

export interface GraphQLCostExtension {
  actualQueryCost: number
  throttleStatus: {
    currentlyAvailable: number
    restoreRate: number
    maximumAvailable: number
  }
}

export interface GraphQLResponse<T> {
  data: T
  extensions?: { cost?: GraphQLCostExtension }
}

/**
 * Execute a Shopify Admin GraphQL request.
 * Throws on non-2xx HTTP status or top-level `errors` in the response body.
 */
export async function shopifyGraphQL<T = unknown>(
  storeDomain: string,
  accessToken: string,
  query: string,
  variables?: Record<string, unknown>,
): Promise<GraphQLResponse<T>> {
  const url = `https://${storeDomain}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': accessToken,
    },
    body: JSON.stringify({ query, variables }),
  })

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Shopify GraphQL HTTP ${res.status}: ${text}`)
  }

  const json = await res.json()

  if (json.errors?.length) {
    const msg = json.errors.map((e: { message: string }) => e.message).join('; ')
    throw new Error(`Shopify GraphQL errors: ${msg}`)
  }

  return json as GraphQLResponse<T>
}
