import { NextResponse } from 'next/server'
import { createClient as createAdminClient } from '@supabase/supabase-js'
import { verifyShopifyWebhookHmac } from '@/lib/shopify/hmac'
import {
  upsertOrder,
  upsertCheckout,
  applyFulfillmentEvent,
  cleanupStoreData,
} from '@/lib/shopify/store'
import { isCodPendingOrder, startCodConfirmation } from '@/lib/cod/engine'
import { ensureCheckoutRecovery } from '@/lib/recovery/engine'
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
 * Append a row to the in-app webhook delivery log. Best-effort: logging must
 * never change the response Shopify sees, so failures here are swallowed.
 */
async function logEvent(event: {
  shop: string
  topic: string
  user_id: string | null
  hmac_valid: boolean
  status: string
  detail: string | null
}) {
  try {
    await db().from('shopify_webhook_events').insert(event)
  } catch (err) {
    console.error('[shopify/webhook] failed to write delivery log:', err)
  }
}

/**
 * POST /api/shopify/webhook
 *
 * Single endpoint for every Shopify topic we subscribe to. Flow:
 *   1. Read the RAW body bytes (HMAC is over exact bytes).
 *   2. Verify the X-Shopify-Hmac-Sha256 signature with the app secret.
 *   3. Resolve the store → user via X-Shopify-Shop-Domain.
 *   4. Upsert based on X-Shopify-Topic.
 *
 * Every outcome is logged to shopify_webhook_events (visible in the Shopify
 * settings page) AND to the console, so it's clear whether a delivery
 * arrived and where it stopped: delivery, HMAC, lookup, or save.
 *
 * 200 on success / safely-ignored; 401 on bad signature; 500 on a recoverable
 * error so Shopify retries (every write is an idempotent upsert).
 */
export async function POST(request: Request) {
  const topic = request.headers.get('x-shopify-topic') ?? ''
  const shopDomain = request.headers.get('x-shopify-shop-domain') ?? ''

  const secret = process.env.SHOPIFY_CLIENT_SECRET
  if (!secret) {
    console.error('[shopify/webhook] SHOPIFY_CLIENT_SECRET not set')
    return NextResponse.json({ error: 'not configured' }, { status: 503 })
  }

  // 1. Raw body bytes (do NOT re-encode — HMAC must match Shopify's exact bytes)
  const rawBuf = Buffer.from(await request.arrayBuffer())

  // 2. HMAC
  const hmacHeader = request.headers.get('x-shopify-hmac-sha256')
  const hmacValid = verifyShopifyWebhookHmac(rawBuf, hmacHeader, secret)

  console.log('[shopify/webhook] hit', {
    topic,
    shop: shopDomain,
    bytes: rawBuf.length,
    hmacValid,
  })

  if (!hmacValid) {
    await logEvent({
      shop: shopDomain,
      topic,
      user_id: null,
      hmac_valid: false,
      status: 'invalid_hmac',
      detail: hmacHeader ? 'signature mismatch' : 'missing hmac header',
    })
    return NextResponse.json({ error: 'invalid signature' }, { status: 401 })
  }

  if (!shopDomain) {
    return NextResponse.json({ error: 'missing shop domain' }, { status: 400 })
  }

  try {
    // 3. Resolve store → user. Capture the error (previously dropped) — a
    // failing lookup here was silently acked as "unknown shop" with no save.
    const { data: config, error: configErr } = await db()
      .from('shopify_config')
      .select('user_id, store_domain')
      .eq('store_domain', shopDomain)
      .maybeSingle()

    if (configErr) {
      console.error('[shopify/webhook] config lookup failed:', configErr)
      await logEvent({
        shop: shopDomain,
        topic,
        user_id: null,
        hmac_valid: true,
        status: 'config_error',
        detail: configErr.message ?? 'config lookup failed',
      })
      // 500 → Shopify retries; transient DB issues self-heal.
      return NextResponse.json({ error: 'config lookup failed' }, { status: 500 })
    }

    if (!config?.user_id) {
      console.warn(`[shopify/webhook] No config for shop ${shopDomain} (topic ${topic})`)
      await logEvent({
        shop: shopDomain,
        topic,
        user_id: null,
        hmac_valid: true,
        status: 'ignored_unknown_shop',
        detail: `no shopify_config row matches store_domain="${shopDomain}"`,
      })
      return NextResponse.json({ ok: true, ignored: 'unknown_shop' })
    }

    const userId: string = config.user_id
    const storeDomain: string = config.store_domain ?? shopDomain
    const payload = JSON.parse(rawBuf.toString('utf8'))

    // 4. Dispatch
    switch (topic) {
      case 'orders/create':
      case 'orders/updated': {
        // 'webhook' source — the ONLY path that marks a record automation-eligible.
        const orderPayload = payload as RestOrder
        const orderRowId = await upsertOrder(db(), userId, storeDomain, orderPayload, 'webhook')
        // COD confirmation trigger. Reaching this code means the order arrived
        // live via webhook (sync/cron never dispatch webhooks), so this is the
        // only place COD can start — backfilled orders never enter the flow.
        // startCodConfirmation is idempotent (one per order).
        if (isCodPendingOrder(orderPayload)) {
          await startCodConfirmation(db(), userId, storeDomain, orderPayload, orderRowId)
        }
        break
      }

      case 'checkouts/create':
      case 'checkouts/update': {
        const checkoutPayload = payload as RestCheckout
        await upsertCheckout(db(), userId, storeDomain, checkoutPayload, 'webhook')
        // Abandoned-checkout recovery bookkeeping. Like COD, only the live
        // webhook path can start a sequence — backfill sync never does.
        // Idempotent (one row per checkout) and best-effort internally.
        await ensureCheckoutRecovery(db(), userId, checkoutPayload)
        break
      }

      case 'fulfillments/create':
      case 'fulfillments/update':
        await applyFulfillmentEvent(db(), userId, payload as RestFulfillment)
        break

      case 'app/uninstalled':
      case 'shop/redact': {
        // Merchant removed the app (or GDPR shop redaction). Shopify revokes
        // the token and removes its own webhooks on uninstall, so we just
        // purge our side: all commerce data + the connection row.
        const counts = await cleanupStoreData(db(), userId, storeDomain)
        await db().from('shopify_config').delete().eq('user_id', userId)
        console.log('[shopify/webhook] store cleanup on', topic, {
          shop: shopDomain,
          counts,
        })
        break
      }

      default:
        console.warn(`[shopify/webhook] Unhandled topic: ${topic}`)
        await logEvent({
          shop: shopDomain,
          topic,
          user_id: userId,
          hmac_valid: true,
          status: 'ignored_topic',
          detail: `no handler for topic "${topic}"`,
        })
        return NextResponse.json({ ok: true, ignored: topic })
    }

    await logEvent({
      shop: shopDomain,
      topic,
      user_id: userId,
      hmac_valid: true,
      status: 'processed',
      detail: null,
    })
    console.log('[shopify/webhook] processed', { topic, shop: shopDomain })
    return NextResponse.json({ ok: true, topic })
  } catch (err) {
    // 500 → Shopify retries with backoff; upserts are idempotent so this is safe.
    const detail = err instanceof Error ? err.message : String(err)
    console.error(`[shopify/webhook] Error handling ${topic}:`, err)
    await logEvent({
      shop: shopDomain,
      topic,
      user_id: null,
      hmac_valid: true,
      status: 'error',
      detail,
    })
    return NextResponse.json({ error: 'processing failed' }, { status: 500 })
  }
}
