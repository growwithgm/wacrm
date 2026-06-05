import { NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import { createClient as createAdminClient } from '@supabase/supabase-js'
import { encrypt } from '@/lib/whatsapp/encryption'
import { verifyShopifyCallbackHmac, isValidShopDomain } from '@/lib/shopify/hmac'
import { exchangeCodeForToken, shopifyGraphQL } from '@/lib/shopify/client'
import { registerWebhooks } from '@/lib/shopify/webhooks'
import { shopifyWebhookCallbackUrl } from '@/lib/shopify/url'

// Lazy-initialized to avoid build-time crash when env vars are absent.
// Typed as `any` so Supabase's generated-type checks don't reject tables
// that aren't in the project's schema type — mirrors the pattern used in
// the WhatsApp webhook route.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _admin: any = null
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function db(): any {
  if (!_admin) {
    _admin = createAdminClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
    )
  }
  return _admin
}

interface ShopData {
  shop: { name: string; id: string }
}

/**
 * GET /api/shopify/callback
 *
 * Shopify redirects here after the merchant approves (or denies) the app.
 * Steps:
 *   1. CSRF: verify state cookie matches the query-param state.
 *   2. Security: verify Shopify's HMAC signature on the full query string.
 *   3. Exchange the authorization code for an access token.
 *   4. Fetch the shop name / id via GraphQL to confirm the token works.
 *   5. Persist the encrypted token(s) in shopify_config.
 *   6. Redirect back to /settings?tab=shopify.
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const origin = (
    process.env.NEXT_PUBLIC_SITE_URL ?? new URL(request.url).origin
  ).replace(/\/+$/, '')   // strip any trailing slashes so we never produce //

  const redirect = (path: string) =>
    NextResponse.redirect(`${origin}${path}`, { status: 302 })

  // ── 1. CSRF check ──────────────────────────────────────────────────────────
  const cookieStore = await cookies()
  const storedState = cookieStore.get('shopify_oauth_state')?.value
  const userId = cookieStore.get('shopify_oauth_uid')?.value
  const incomingState = searchParams.get('state')

  if (!storedState || storedState !== incomingState) {
    console.warn('[shopify/callback] State mismatch — possible CSRF attempt')
    return redirect('/settings?tab=shopify&error=invalid_state')
  }
  if (!userId) {
    return redirect('/settings?tab=shopify&error=session_expired')
  }

  // ── 2. HMAC verification ───────────────────────────────────────────────────
  const clientSecret = process.env.SHOPIFY_CLIENT_SECRET
  if (!clientSecret) {
    console.error('[shopify/callback] SHOPIFY_CLIENT_SECRET not set')
    return redirect('/settings?tab=shopify&error=server_misconfigured')
  }

  if (!verifyShopifyCallbackHmac(searchParams, clientSecret)) {
    console.warn('[shopify/callback] HMAC verification failed')
    return redirect('/settings?tab=shopify&error=invalid_hmac')
  }

  const shop = searchParams.get('shop') ?? ''
  const code = searchParams.get('code') ?? ''

  if (!shop || !code || !isValidShopDomain(shop)) {
    return redirect('/settings?tab=shopify&error=invalid_params')
  }

  // ── 3. Token exchange ──────────────────────────────────────────────────────
  try {
    const tokenData = await exchangeCodeForToken(shop, code)

    // ── 4. Validate token + fetch shop identity ─────────────────────────────
    const shopInfo = await shopifyGraphQL<ShopData>(
      shop,
      tokenData.access_token,
      `{ shop { name id } }`,
    )

    const shopName = shopInfo.data.shop.name
    const shopId = shopInfo.data.shop.id

    const tokenExpiresAt = tokenData.expires_in
      ? new Date(Date.now() + tokenData.expires_in * 1000).toISOString()
      : null

    // ── 5. Upsert shopify_config ────────────────────────────────────────────
    const upsertPayload = {
      store_domain: shop,
      access_token: encrypt(tokenData.access_token),
      refresh_token: tokenData.refresh_token
        ? encrypt(tokenData.refresh_token)
        : null,
      token_expires_at: tokenExpiresAt,
      scopes: tokenData.scope,
      shop_name: shopName,
      shop_id: shopId,
      connection_status: 'connected',
      updated_at: new Date().toISOString(),
    }

    const { data: existing } = await db()
      .from('shopify_config')
      .select('id')
      .eq('user_id', userId)
      .maybeSingle()

    if (existing) {
      await db().from('shopify_config').update(upsertPayload).eq('user_id', userId)
    } else {
      await db()
        .from('shopify_config')
        .insert({ user_id: userId, ...upsertPayload })
    }

    // ── 5b. Auto-register webhooks (best-effort) ────────────────────────────
    // Requires a public HTTPS callback — Shopify rejects http/localhost, so
    // this no-ops in local dev. Failures are logged with the exact Shopify
    // error (never fatal): the merchant is still connected, and the Shopify
    // settings page exposes a manual "Register Webhooks" retry either way.
    try {
      const callbackUrl = shopifyWebhookCallbackUrl(request)
      const { registered, failed } = await registerWebhooks(
        shop,
        tokenData.access_token,
        callbackUrl,
      )
      console.log('[shopify/callback] webhook registration', {
        shop,
        callbackUrl,
        registered,
        failed,
      })
      await db()
        .from('shopify_config')
        .update({
          webhooks_registered_at: registered.length > 0 ? new Date().toISOString() : null,
          webhook_topics: registered.length > 0 ? registered : null,
          updated_at: new Date().toISOString(),
        })
        .eq('user_id', userId)
    } catch (err) {
      console.error('[shopify/callback] Webhook registration error:', err)
    }

    // ── 6. Clear cookies and return to settings ─────────────────────────────
    const response = redirect('/settings?tab=shopify')
    response.cookies.delete('shopify_oauth_state')
    response.cookies.delete('shopify_oauth_uid')
    return response
  } catch (error) {
    console.error('[shopify/callback] Error:', error)
    const msg = error instanceof Error
      ? encodeURIComponent(error.message.slice(0, 200))
      : 'unknown_error'
    return redirect(`/settings?tab=shopify&error=${msg}`)
  }
}
