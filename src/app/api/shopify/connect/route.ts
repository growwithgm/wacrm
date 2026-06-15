import { NextResponse } from 'next/server'
import crypto from 'crypto'
import { createClient } from '@/lib/supabase/server'
import { isValidShopDomain } from '@/lib/shopify/hmac'

// Reads customers/orders/checkouts/fulfillments; write_orders is needed to
// add/remove COD tags on orders; read_discounts/write_discounts are needed to
// generate per-customer single-use discount codes.
// NOTE: widening scopes requires already-connected merchants to RECONNECT
// before the new permission takes effect (existing tokens keep old scopes).
const SCOPES =
  'read_customers,read_orders,read_checkouts,read_fulfillments,write_orders,read_discounts,write_discounts'

/**
 * GET /api/shopify/connect?shop=mystore.myshopify.com
 *
 * Initiates the Shopify OAuth 2.0 authorization code flow.
 * Generates a CSRF nonce, stores it in a short-lived cookie, then
 * redirects the browser to Shopify's OAuth consent screen.
 */
export async function GET(request: Request) {
  try {
    const supabase = await createClient()
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser()
    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const clientId = process.env.SHOPIFY_CLIENT_ID
    if (!clientId) {
      console.error('[shopify/connect] SHOPIFY_CLIENT_ID env var is not set')
      return NextResponse.json(
        { error: 'Shopify integration is not configured on this server' },
        { status: 500 },
      )
    }

    const { searchParams } = new URL(request.url)
    const rawShop = searchParams.get('shop')?.toLowerCase().trim() ?? ''

    if (!rawShop) {
      return NextResponse.json({ error: 'shop parameter is required' }, { status: 400 })
    }

    // Accept both "mystore" and "mystore.myshopify.com"
    const shop = rawShop.includes('.') ? rawShop : `${rawShop}.myshopify.com`

    if (!isValidShopDomain(shop)) {
      return NextResponse.json(
        { error: 'Invalid shop domain — must be a *.myshopify.com address' },
        { status: 400 },
      )
    }

    // Generate a one-time CSRF nonce
    const state = crypto.randomBytes(16).toString('hex')

    // Resolve the callback URL: prefer the explicit env var, fall back to the
    // origin of the current request (works in local dev without env config).
    const origin = (
      process.env.NEXT_PUBLIC_SITE_URL ?? new URL(request.url).origin
    ).replace(/\/+$/, '')   // strip any trailing slashes so we never produce //
    const redirectUri = `${origin}/api/shopify/callback`

    const authUrl = new URL(`https://${shop}/admin/oauth/authorize`)
    authUrl.searchParams.set('client_id', clientId)
    authUrl.searchParams.set('scope', SCOPES)
    authUrl.searchParams.set('redirect_uri', redirectUri)
    authUrl.searchParams.set('state', state)

    const response = NextResponse.redirect(authUrl.toString())

    const cookieOpts = {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax' as const,
      maxAge: 300, // 5 minutes — more than enough to complete the OAuth round-trip
      path: '/',
    }

    // Store the nonce and the user id in short-lived cookies so the callback
    // can CSRF-check the state and know which user's config to update without
    // relying on a session that might not be available during the redirect.
    response.cookies.set('shopify_oauth_state', state, cookieOpts)
    response.cookies.set('shopify_oauth_uid', user.id, cookieOpts)

    return response
  } catch (error) {
    console.error('[shopify/connect] Unexpected error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
