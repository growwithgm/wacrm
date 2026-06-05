import { NextResponse } from 'next/server'
import { createClient as createAdminClient } from '@supabase/supabase-js'
import { verifyShopifyWebhookHmac } from '@/lib/shopify/hmac'
import { upsertOrder, upsertCheckout, applyFulfillmentEvent } from '@/lib/shopify/store'
import type { RestOrder, RestCheckout, RestFulfillment } from '@/lib/shopify/transform'

// Node runtime — needs `crypto` for HMAC verification.
export const runtime = 'nodejs'

// Lazy admin client (service role) — webhooks carry no user session, so we
// resolve the user from the shop domain and write with RLS bypassed.
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

/**
 * POST /api/shopify/webhook
 *
 * Single endpoint for every Shopify topic we subscribe to (registered in
 * the OAuth callback). Flow:
 *   1. Read the RAW body (HMAC is computed over exact bytes).
 *   2. Verify the X-Shopify-Hmac-Sha256 signature with the app secret.
 *   3. Resolve the store → user via X-Shopify-Shop-Domain.
 *   4. Upsert based on X-Shopify-Topic.
 *
 * Returns 200 on success (and on safely-ignored topics). Returns 401 on a
 * bad signature, and 500 on an unexpected error so Shopify retries — every
 * write is an idempotent upsert, so retries are safe.
 */
export async function POST(request: Request) {
  const secret = process.env.SHOPIFY_CLIENT_SECRET
  if (!secret) {
    console.error('[shopify/webhook] SHOPIFY_CLIENT_SECRET not set')
    return NextResponse.json({ error: 'not configured' }, { status: 503 })
  }

  // 1. Raw body
  const rawBody = await request.text()

  // 2. HMAC
  const hmacHeader = request.headers.get('x-shopify-hmac-sha256')
  if (!verifyShopifyWebhookHmac(rawBody, hmacHeader, secret)) {
    console.warn('[shopify/webhook] HMAC verification failed')
    return NextResponse.json({ error: 'invalid signature' }, { status: 401 })
  }

  const topic = request.headers.get('x-shopify-topic') ?? ''
  const shopDomain = request.headers.get('x-shopify-shop-domain') ?? ''

  if (!shopDomain) {
    return NextResponse.json({ error: 'missing shop domain' }, { status: 400 })
  }

  try {
    // 3. Resolve store → user
    const { data: config } = await db()
      .from('shopify_config')
      .select('user_id, store_domain')
      .eq('store_domain', shopDomain)
      .maybeSingle()

    if (!config?.user_id) {
      // Unknown / disconnected store — ack so Shopify stops retrying.
      console.warn(`[shopify/webhook] No config for shop ${shopDomain} (topic ${topic})`)
      return NextResponse.json({ ok: true, ignored: 'unknown_shop' })
    }

    const userId: string = config.user_id
    const storeDomain: string = config.store_domain ?? shopDomain
    const payload = JSON.parse(rawBody)

    // 4. Dispatch
    switch (topic) {
      case 'orders/create':
      case 'orders/updated':
        await upsertOrder(db(), userId, storeDomain, payload as RestOrder)
        break

      case 'checkouts/create':
      case 'checkouts/update':
        await upsertCheckout(db(), userId, storeDomain, payload as RestCheckout)
        break

      case 'fulfillments/create':
      case 'fulfillments/update':
        await applyFulfillmentEvent(db(), userId, payload as RestFulfillment)
        break

      default:
        console.warn(`[shopify/webhook] Unhandled topic: ${topic}`)
        return NextResponse.json({ ok: true, ignored: topic })
    }

    return NextResponse.json({ ok: true, topic })
  } catch (err) {
    // 500 → Shopify retries with backoff; upserts are idempotent so this is safe.
    console.error(`[shopify/webhook] Error handling ${topic}:`, err)
    return NextResponse.json({ error: 'processing failed' }, { status: 500 })
  }
}
