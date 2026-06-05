/**
 * Shopify REST payload → Wasify row mappers.
 *
 * Both the initial sync routes and the webhook receiver feed Shopify's
 * REST-shaped JSON through these, so an order looks identical in the DB
 * whether it arrived via a backfill page or an `orders/create` webhook.
 *
 * Payloads are typed loosely (lots of optional, deeply-nested fields we
 * don't all model) — we only pull the columns the schema in migration 016
 * declares, and stash the whole payload in `raw` for anything we add later.
 */

import { normalizePhone } from '@/lib/whatsapp/phone-utils'

// ─── Loose REST shapes (only the fields we read) ───────────────────────────────

interface RestAddress {
  name?: string | null
  first_name?: string | null
  last_name?: string | null
  address1?: string | null
  address2?: string | null
  city?: string | null
  province?: string | null
  zip?: string | null
  country?: string | null
  country_code?: string | null
  phone?: string | null
}

interface RestLineItem {
  title?: string | null
  name?: string | null
  quantity?: number | null
  price?: string | null
  variant_title?: string | null
  sku?: string | null
}

interface RestCustomer {
  first_name?: string | null
  last_name?: string | null
  email?: string | null
  phone?: string | null
}

export interface RestFulfillment {
  id?: number | string
  order_id?: number | string
  status?: string | null
  shipment_status?: string | null
  tracking_number?: string | null
  tracking_numbers?: string[] | null
  tracking_url?: string | null
  tracking_urls?: string[] | null
  tracking_company?: string | null
  created_at?: string | null
  updated_at?: string | null
}

export interface RestOrder {
  id: number | string
  order_number?: number | string | null
  name?: string | null
  created_at?: string | null
  processed_at?: string | null
  cancelled_at?: string | null
  currency?: string | null
  total_price?: string | null
  subtotal_price?: string | null
  total_shipping_price_set?: { shop_money?: { amount?: string | null } } | null
  financial_status?: string | null
  fulfillment_status?: string | null
  email?: string | null
  phone?: string | null
  customer?: RestCustomer | null
  shipping_address?: RestAddress | null
  billing_address?: RestAddress | null
  line_items?: RestLineItem[] | null
  shipping_lines?: { title?: string | null }[] | null
  payment_gateway_names?: string[] | null
  gateway?: string | null
  tags?: string | null
  fulfillments?: RestFulfillment[] | null
}

export interface RestCheckout {
  id: number | string
  token?: string | null
  created_at?: string | null
  updated_at?: string | null
  completed_at?: string | null
  email?: string | null
  phone?: string | null
  customer?: RestCustomer | null
  shipping_address?: RestAddress | null
  billing_address?: RestAddress | null
  line_items?: RestLineItem[] | null
  abandoned_checkout_url?: string | null
  total_price?: string | null
  currency?: string | null
  presentment_currency?: string | null
}

// ─── Row shapes (mirror migration 016) ─────────────────────────────────────────

export interface OrderRow {
  user_id: string
  store_domain: string | null
  shopify_order_id: string
  order_number: string | null
  name: string | null
  customer_name: string | null
  customer_phone: string | null
  customer_email: string | null
  shipping_address: RestAddress | null
  shipping_method: string | null
  currency: string | null
  total_price: number | null
  subtotal_price: number | null
  total_shipping: number | null
  financial_status: string | null
  fulfillment_status: string | null
  payment_gateway: string | null
  line_items: LineItem[] | null
  tags: string[] | null
  tracking_number: string | null
  tracking_url: string | null
  tracking_company: string | null
  shipment_status: string | null
  fulfilled_at: string | null
  order_created_at: string | null
  cancelled_at: string | null
  raw: unknown
}

export interface CheckoutRow {
  user_id: string
  store_domain: string | null
  shopify_checkout_id: string
  token: string | null
  customer_name: string | null
  customer_phone: string | null
  customer_email: string | null
  line_items: LineItem[] | null
  abandoned_checkout_url: string | null
  currency: string | null
  total_price: number | null
  shopify_created_at: string | null
  abandoned_at: string | null
  completed_at: string | null
  recovered: boolean
  raw: unknown
}

export interface FulfillmentRow {
  user_id: string
  shopify_order_id: string | null
  shopify_fulfillment_id: string
  status: string | null
  shipment_status: string | null
  tracking_number: string | null
  tracking_url: string | null
  tracking_company: string | null
  shopify_created_at: string | null
  shopify_updated_at: string | null
  raw: unknown
}

export interface LineItem {
  title: string
  quantity: number
  price: string | null
  variant_title: string | null
  sku: string | null
}

/** The denormalized tracking columns written onto shopify_orders. */
export interface OrderTrackingPatch {
  tracking_number: string | null
  tracking_url: string | null
  tracking_company: string | null
  shipment_status: string | null
  fulfilled_at: string | null
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

function num(v: string | null | undefined): number | null {
  if (v == null || v === '') return null
  const n = parseFloat(v)
  return Number.isFinite(n) ? n : null
}

/** Best-effort E.164. Falls back to the trimmed raw so display still works. */
export function tryNormalizePhone(raw: string | null | undefined): string | null {
  if (!raw || !raw.trim()) return null
  try {
    return normalizePhone(raw.trim())
  } catch {
    return raw.trim()
  }
}

function customerName(
  customer: RestCustomer | null | undefined,
  address: RestAddress | null | undefined,
): string | null {
  const fromCustomer = [customer?.first_name, customer?.last_name].filter(Boolean).join(' ').trim()
  if (fromCustomer) return fromCustomer
  if (address?.name?.trim()) return address.name.trim()
  const fromAddress = [address?.first_name, address?.last_name].filter(Boolean).join(' ').trim()
  return fromAddress || null
}

function mapLineItems(items: RestLineItem[] | null | undefined): LineItem[] | null {
  if (!items?.length) return null
  return items.map((li) => ({
    title: li.title ?? li.name ?? 'Item',
    quantity: li.quantity ?? 1,
    price: li.price ?? null,
    variant_title: li.variant_title ?? null,
    sku: li.sku ?? null,
  }))
}

function commaTagsToArray(tags: string | null | undefined): string[] | null {
  if (!tags?.trim()) return null
  const arr = tags.split(',').map((t) => t.trim()).filter(Boolean)
  return arr.length ? arr : null
}

/** Pull the richest phone available off an order, in priority order. */
export function resolveOrderPhone(order: RestOrder): string | null {
  return tryNormalizePhone(
    order.phone ||
      order.customer?.phone ||
      order.shipping_address?.phone ||
      order.billing_address?.phone ||
      null,
  )
}

export function resolveCheckoutPhone(checkout: RestCheckout): string | null {
  return tryNormalizePhone(
    checkout.phone ||
      checkout.customer?.phone ||
      checkout.shipping_address?.phone ||
      checkout.billing_address?.phone ||
      null,
  )
}

function pickTracking(f: RestFulfillment): {
  tracking_number: string | null
  tracking_url: string | null
  tracking_company: string | null
} {
  return {
    tracking_number: f.tracking_number ?? f.tracking_numbers?.[0] ?? null,
    tracking_url: f.tracking_url ?? f.tracking_urls?.[0] ?? null,
    tracking_company: f.tracking_company ?? null,
  }
}

/**
 * Latest-fulfillment tracking for an order, for the denormalized columns.
 * "Latest" = highest created_at among the order's fulfillments.
 */
export function trackingFromOrder(order: RestOrder): OrderTrackingPatch | null {
  const fulfillments = order.fulfillments ?? []
  if (!fulfillments.length) return null
  const latest = [...fulfillments].sort((a, b) => {
    const ta = a.created_at ? Date.parse(a.created_at) : 0
    const tb = b.created_at ? Date.parse(b.created_at) : 0
    return tb - ta
  })[0]
  const tracking = pickTracking(latest)
  return {
    ...tracking,
    shipment_status: latest.shipment_status ?? null,
    fulfilled_at: latest.created_at ?? null,
  }
}

// ─── Mappers ───────────────────────────────────────────────────────────────────

export function mapOrder(
  order: RestOrder,
  ctx: { userId: string; storeDomain: string | null },
): OrderRow {
  const tracking = trackingFromOrder(order)
  const gateway =
    order.payment_gateway_names?.filter(Boolean).join(', ') || order.gateway || null

  return {
    user_id: ctx.userId,
    store_domain: ctx.storeDomain,
    shopify_order_id: String(order.id),
    order_number: order.order_number != null ? String(order.order_number) : null,
    name: order.name ?? null,
    customer_name: customerName(order.customer, order.shipping_address),
    customer_phone: resolveOrderPhone(order),
    customer_email: order.email ?? order.customer?.email ?? null,
    shipping_address: order.shipping_address ?? null,
    shipping_method: order.shipping_lines?.[0]?.title ?? null,
    currency: order.currency ?? null,
    total_price: num(order.total_price),
    subtotal_price: num(order.subtotal_price),
    total_shipping: num(order.total_shipping_price_set?.shop_money?.amount),
    financial_status: order.financial_status ?? null,
    fulfillment_status: order.fulfillment_status ?? null,
    payment_gateway: gateway,
    line_items: mapLineItems(order.line_items),
    tags: commaTagsToArray(order.tags),
    tracking_number: tracking?.tracking_number ?? null,
    tracking_url: tracking?.tracking_url ?? null,
    tracking_company: tracking?.tracking_company ?? null,
    shipment_status: tracking?.shipment_status ?? null,
    fulfilled_at: tracking?.fulfilled_at ?? null,
    order_created_at: order.created_at ?? order.processed_at ?? null,
    cancelled_at: order.cancelled_at ?? null,
    raw: order,
  }
}

export function mapCheckout(
  checkout: RestCheckout,
  ctx: { userId: string; storeDomain: string | null },
): CheckoutRow {
  return {
    user_id: ctx.userId,
    store_domain: ctx.storeDomain,
    shopify_checkout_id: String(checkout.id),
    token: checkout.token ?? null,
    customer_name: customerName(checkout.customer, checkout.shipping_address),
    customer_phone: resolveCheckoutPhone(checkout),
    customer_email: checkout.email ?? checkout.customer?.email ?? null,
    line_items: mapLineItems(checkout.line_items),
    abandoned_checkout_url: checkout.abandoned_checkout_url ?? null,
    currency: checkout.currency ?? checkout.presentment_currency ?? null,
    total_price: num(checkout.total_price),
    shopify_created_at: checkout.created_at ?? null,
    // Shopify only surfaces a checkout here once it's abandonment-eligible,
    // so created_at is the best "abandoned at" signal we have.
    abandoned_at: checkout.created_at ?? null,
    completed_at: checkout.completed_at ?? null,
    recovered: !!checkout.completed_at,
    raw: checkout,
  }
}

export function mapFulfillment(
  f: RestFulfillment,
  ctx: { userId: string },
): FulfillmentRow {
  const tracking = pickTracking(f)
  return {
    user_id: ctx.userId,
    shopify_order_id: f.order_id != null ? String(f.order_id) : null,
    shopify_fulfillment_id: String(f.id),
    status: f.status ?? null,
    shipment_status: f.shipment_status ?? null,
    tracking_number: tracking.tracking_number,
    tracking_url: tracking.tracking_url,
    tracking_company: tracking.tracking_company,
    shopify_created_at: f.created_at ?? null,
    shopify_updated_at: f.updated_at ?? null,
    raw: f,
  }
}

/** Order tracking patch derived from a single fulfillment webhook payload. */
export function trackingPatchFromFulfillment(f: RestFulfillment): OrderTrackingPatch {
  const tracking = pickTracking(f)
  return {
    ...tracking,
    shipment_status: f.shipment_status ?? null,
    fulfilled_at: f.created_at ?? null,
  }
}

// ─── Contact linking ───────────────────────────────────────────────────────────

/**
 * Resolve the local contact a Shopify order/checkout belongs to, matching
 * by phone first (E.164) then email. Returns null when no contact matches —
 * the order is still stored, just unlinked, and can be re-linked on the next
 * customer sync. Uses the service-role client (typed `any` like the rest of
 * the Shopify routes).
 */
export async function resolveContactId(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
  userId: string,
  phone: string | null,
  email: string | null,
): Promise<string | null> {
  if (phone) {
    const { data } = await db
      .from('contacts')
      .select('id')
      .eq('user_id', userId)
      .eq('phone', phone)
      .limit(1)
      .maybeSingle()
    if (data?.id) return data.id as string
  }
  if (email) {
    const { data } = await db
      .from('contacts')
      .select('id')
      .eq('user_id', userId)
      .eq('email', email)
      .limit(1)
      .maybeSingle()
    if (data?.id) return data.id as string
  }
  return null
}
