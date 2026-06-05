/**
 * Persistence helpers for Shopify commerce data.
 *
 * Shared by the sync routes (initial backfill) and the webhook receiver
 * (incremental updates) so an order/checkout/fulfillment is written the
 * same way regardless of how it arrived. All writes go through the
 * service-role client (typed `any`, same as the other Shopify routes) and
 * are idempotent upserts keyed on the Shopify id.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import {
  mapOrder,
  mapCheckout,
  mapFulfillment,
  trackingPatchFromFulfillment,
  resolveContactId,
  type RestOrder,
  type RestCheckout,
  type RestFulfillment,
} from './transform'

/**
 * Upsert a Shopify order (+ its inline fulfillments). Resolves the linked
 * contact by phone/email. Returns the local order row id (or null).
 */
export async function upsertOrder(
  db: any,
  userId: string,
  storeDomain: string | null,
  order: RestOrder,
  source: 'webhook' | 'backfill',
): Promise<string | null> {
  const row = mapOrder(order, { userId, storeDomain })
  const contact_id = await resolveContactId(db, userId, row.customer_phone, row.customer_email)

  // Only stamp `source` on the live (webhook) path. Backfill omits it so an
  // INSERT takes the DB default ('backfill') and a row that's already
  // 'webhook' is never downgraded back to 'backfill' on conflict.
  const payload: Record<string, unknown> = { ...row, contact_id }
  if (source === 'webhook') payload.source = 'webhook'

  const { data, error } = await db
    .from('shopify_orders')
    .upsert(payload, { onConflict: 'user_id,shopify_order_id' })
    .select('id')
    .maybeSingle()

  if (error) throw new Error(`order upsert failed: ${error.message}`)
  const orderRowId: string | null = data?.id ?? null

  // Orders payloads embed their fulfillments — persist them too. mapOrder
  // already set the latest tracking on the order, so no order patch here.
  if (orderRowId && order.fulfillments?.length) {
    for (const f of order.fulfillments) {
      await upsertFulfillmentRow(db, userId, f, orderRowId)
    }
  }

  return orderRowId
}

/** Upsert an abandoned checkout, linking it to a contact by phone/email. */
export async function upsertCheckout(
  db: any,
  userId: string,
  storeDomain: string | null,
  checkout: RestCheckout,
  source: 'webhook' | 'backfill',
): Promise<void> {
  const row = mapCheckout(checkout, { userId, storeDomain })
  const contact_id = await resolveContactId(db, userId, row.customer_phone, row.customer_email)

  // See upsertOrder: backfill must never downgrade a live ('webhook') record.
  const payload: Record<string, unknown> = { ...row, contact_id }
  if (source === 'webhook') payload.source = 'webhook'

  const { error } = await db
    .from('shopify_checkouts')
    .upsert(payload, { onConflict: 'user_id,shopify_checkout_id' })

  if (error) throw new Error(`checkout upsert failed: ${error.message}`)
}

/**
 * Upsert a single fulfillment row, resolving its local order row id from
 * the Shopify order id when not already known. Does NOT touch the order's
 * denormalized tracking — callers that represent a fulfillment *event*
 * (the webhook) use `applyFulfillmentEvent` for that.
 */
export async function upsertFulfillmentRow(
  db: any,
  userId: string,
  f: RestFulfillment,
  knownOrderRowId?: string | null,
): Promise<string | null> {
  const row = mapFulfillment(f, { userId })

  let orderRowId: string | null = knownOrderRowId ?? null
  if (!orderRowId && row.shopify_order_id) {
    const { data } = await db
      .from('shopify_orders')
      .select('id')
      .eq('user_id', userId)
      .eq('shopify_order_id', row.shopify_order_id)
      .maybeSingle()
    orderRowId = data?.id ?? null
  }

  const { error } = await db
    .from('shopify_fulfillments')
    .upsert({ ...row, order_id: orderRowId }, { onConflict: 'user_id,shopify_fulfillment_id' })

  if (error) throw new Error(`fulfillment upsert failed: ${error.message}`)
  return orderRowId
}

/**
 * Handle a fulfillments/create|update webhook: upsert the fulfillment row
 * and push its tracking onto the parent order's denormalized columns (the
 * latest event wins), so the Orders page and customer panel show current
 * tracking without a join.
 */
export async function applyFulfillmentEvent(
  db: any,
  userId: string,
  f: RestFulfillment,
): Promise<void> {
  const orderRowId = await upsertFulfillmentRow(db, userId, f)
  if (!orderRowId) return

  const patch = trackingPatchFromFulfillment(f)
  await db
    .from('shopify_orders')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', orderRowId)
}
