/**
 * Shopify webhook registration.
 *
 * Called from the OAuth callback once a store connects, so order /
 * checkout / fulfillment events start flowing into /api/shopify/webhook
 * automatically without the merchant touching the Shopify admin.
 */

import { shopifyRestPost } from './client'

/** The events Phase A subscribes to. Must match the cases in the webhook route. */
export const WEBHOOK_TOPICS = [
  'orders/create',
  'orders/updated',
  'checkouts/create',
  'checkouts/update',
  'fulfillments/create',
  'fulfillments/update',
] as const

export type WebhookTopic = (typeof WEBHOOK_TOPICS)[number]

export interface RegisterWebhooksResult {
  registered: string[]
  failed: { topic: string; error: string }[]
}

/**
 * Register every Phase A webhook for a store. Idempotent: Shopify returns
 * 422 "address for this topic has already been taken" when a subscription
 * already exists, which we treat as success so reconnecting (or re-running)
 * is safe.
 *
 * `callbackUrl` must be a public HTTPS URL — Shopify rejects http/localhost,
 * so webhooks only register from a deployed environment.
 */
export async function registerWebhooks(
  storeDomain: string,
  accessToken: string,
  callbackUrl: string,
): Promise<RegisterWebhooksResult> {
  const registered: string[] = []
  const failed: { topic: string; error: string }[] = []

  for (const topic of WEBHOOK_TOPICS) {
    try {
      await shopifyRestPost(storeDomain, accessToken, 'webhooks.json', {
        webhook: { topic, address: callbackUrl, format: 'json' },
      })
      registered.push(topic)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (/already been taken|already exists/i.test(msg)) {
        registered.push(topic)
        continue
      }
      failed.push({ topic, error: msg })
    }
  }

  return { registered, failed }
}
