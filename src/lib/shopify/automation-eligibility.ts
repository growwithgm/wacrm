/**
 * Automation-eligibility gate for Shopify commerce records.
 *
 * THE RULE (Priority 2): a Shopify order/checkout may trigger a WhatsApp
 * message ONLY if it arrived live via a webhook (`source === 'webhook'`).
 * Backfilled records — manual "Sync" buttons and the scheduled cron — are
 * DISPLAY ONLY and must never message a customer, no matter how recent.
 *
 * Every future flow (COD confirmation, abandoned-cart recovery, tracking
 * updates) MUST pass its candidate records through these helpers before
 * sending anything. Do not query records for messaging without them.
 *
 * Defense in depth: abandoned-cart sends additionally require the cart to be
 * recent (default 24h, configurable per store via
 * shopify_config.abandoned_window_hours) — so even a webhook-sourced cart
 * that's gone stale can't be messaged.
 */

export const DEFAULT_ABANDONED_WINDOW_HOURS = 24

export interface SourcedRecord {
  source?: string | null
}

/** True only for records that arrived live via a Shopify webhook. */
export function isWebhookSourced(record: SourcedRecord | null | undefined): boolean {
  return record?.source === 'webhook'
}

export interface AbandonedCheckoutLike extends SourcedRecord {
  abandoned_at?: string | null
  recovered?: boolean | null
}

/**
 * Whether an abandoned checkout may receive a WhatsApp recovery message:
 * webhook-sourced, not yet recovered, and abandoned within `windowHours`.
 */
export function isAbandonedCartMessageable(
  checkout: AbandonedCheckoutLike | null | undefined,
  windowHours: number = DEFAULT_ABANDONED_WINDOW_HOURS,
): boolean {
  if (!isWebhookSourced(checkout)) return false
  if (!checkout || checkout.recovered) return false
  if (!checkout.abandoned_at) return false

  const ageMs = Date.now() - Date.parse(checkout.abandoned_at)
  if (!Number.isFinite(ageMs) || ageMs < 0) return false
  return ageMs <= windowHours * 60 * 60 * 1000
}

/**
 * Whether an order may receive an order-triggered WhatsApp message (COD
 * confirmation, tracking update, …). Gate is webhook-source; per-flow recency
 * / status checks layer on top of this.
 */
export function isOrderMessageable(order: SourcedRecord | null | undefined): boolean {
  return isWebhookSourced(order)
}
