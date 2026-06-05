/**
 * Shopify webhook registration via the GraphQL Admin API.
 *
 * Why GraphQL (not REST): REST `POST /webhooks.json` is the legacy path and
 * Shopify increasingly rejects webhook *creation* over REST even when REST
 * reads still work — which is the kind of silent, all-topics failure that
 * left registration broken. The GraphQL `webhookSubscriptionCreate` mutation
 * is the supported path and returns structured `userErrors` we can surface
 * verbatim instead of swallowing them.
 *
 * Note: Shopify always delivers the REST-style topic (e.g. `orders/create`)
 * in the `X-Shopify-Topic` header regardless of how the subscription was
 * created, so the webhook receiver's topic switch is unaffected.
 */

import { shopifyGraphQL } from './client'

// REST-style topic (what the receiver matches on) ↔ GraphQL enum.
const TOPIC_MAP: Record<string, string> = {
  'orders/create': 'ORDERS_CREATE',
  'orders/updated': 'ORDERS_UPDATED',
  'checkouts/create': 'CHECKOUTS_CREATE',
  'checkouts/update': 'CHECKOUTS_UPDATE',
  'fulfillments/create': 'FULFILLMENTS_CREATE',
  'fulfillments/update': 'FULFILLMENTS_UPDATE',
  // Lifecycle: fires when the merchant uninstalls the app — triggers cleanup.
  'app/uninstalled': 'APP_UNINSTALLED',
}

const ENUM_TO_REST: Record<string, string> = Object.fromEntries(
  Object.entries(TOPIC_MAP).map(([rest, gql]) => [gql, rest]),
)

/** The events Phase A subscribes to (REST-style topic strings). */
export const WEBHOOK_TOPICS = Object.keys(TOPIC_MAP)

export interface RegisterWebhooksResult {
  /** The exact callback URL we asked Shopify to deliver to. */
  callbackUrl: string
  /** REST-style topics that are now subscribed (created or already existed). */
  registered: string[]
  /** Topics that failed, with the verbatim Shopify error. */
  failed: { topic: string; error: string }[]
}

const CREATE_MUTATION = `
  mutation CreateWebhook($topic: WebhookSubscriptionTopic!, $sub: WebhookSubscriptionInput!) {
    webhookSubscriptionCreate(topic: $topic, webhookSubscription: $sub) {
      webhookSubscription { id }
      userErrors { field message }
    }
  }
`

interface CreateResult {
  webhookSubscriptionCreate: {
    webhookSubscription: { id: string } | null
    userErrors: { field: string[] | null; message: string }[]
  }
}

/**
 * Subscribe every Phase A topic to `callbackUrl`. Idempotent: Shopify reports
 * "has already been taken" for an existing subscription, which we treat as a
 * success. Each topic is attempted independently so one failure doesn't hide
 * the others — and every failure carries Shopify's exact message.
 */
export async function registerWebhooks(
  storeDomain: string,
  accessToken: string,
  callbackUrl: string,
): Promise<RegisterWebhooksResult> {
  const registered: string[] = []
  const failed: { topic: string; error: string }[] = []

  for (const [restTopic, gqlTopic] of Object.entries(TOPIC_MAP)) {
    try {
      const res = await shopifyGraphQL<CreateResult>(storeDomain, accessToken, CREATE_MUTATION, {
        topic: gqlTopic,
        sub: { callbackUrl, format: 'JSON' },
      })
      const errs = res.data.webhookSubscriptionCreate?.userErrors ?? []
      if (errs.length > 0) {
        const msg = errs.map((e) => e.message).join('; ')
        // Already subscribed → idempotent success, not a failure.
        if (/already been taken|already exists|already created/i.test(msg)) {
          registered.push(restTopic)
        } else {
          failed.push({ topic: restTopic, error: msg })
        }
      } else {
        registered.push(restTopic)
      }
    } catch (err) {
      failed.push({ topic: restTopic, error: err instanceof Error ? err.message : String(err) })
    }
  }

  return { callbackUrl, registered, failed }
}

const LIST_QUERY = `
  query ListWebhooks {
    webhookSubscriptions(first: 100) {
      edges {
        node {
          id
          topic
          endpoint {
            __typename
            ... on WebhookHttpEndpoint { callbackUrl }
          }
        }
      }
    }
  }
`

interface ListResult {
  webhookSubscriptions: {
    edges: {
      node: {
        id: string
        topic: string
        endpoint: { __typename: string; callbackUrl?: string } | null
      }
    }[]
  }
}

export interface LiveWebhook {
  id: string
  topic: string
  callbackUrl: string | null
}

/**
 * Query the subscriptions that actually exist on the store right now — the
 * source of truth the UI shows, rather than our own stored flag.
 */
export async function listWebhooks(
  storeDomain: string,
  accessToken: string,
): Promise<LiveWebhook[]> {
  const res = await shopifyGraphQL<ListResult>(storeDomain, accessToken, LIST_QUERY)
  return res.data.webhookSubscriptions.edges.map((e) => ({
    id: e.node.id,
    topic: ENUM_TO_REST[e.node.topic] ?? e.node.topic.toLowerCase().replace(/_/g, '/'),
    callbackUrl: e.node.endpoint?.callbackUrl ?? null,
  }))
}

const DELETE_MUTATION = `
  mutation DeleteWebhook($id: ID!) {
    webhookSubscriptionDelete(id: $id) {
      deletedWebhookSubscriptionId
      userErrors { message }
    }
  }
`

interface DeleteResult {
  webhookSubscriptionDelete: {
    deletedWebhookSubscriptionId: string | null
    userErrors: { message: string }[]
  }
}

/**
 * Delete this app's webhook subscriptions for a store (those pointing at our
 * callback URL; pass no URL to remove all of ours). Best-effort — used by the
 * manual Disconnect while the token is still valid. (On a real uninstall,
 * Shopify removes the subscriptions itself.)
 */
export async function deleteWebhooks(
  storeDomain: string,
  accessToken: string,
  callbackUrl?: string,
): Promise<{ deleted: number }> {
  const subs = await listWebhooks(storeDomain, accessToken)
  const ours = callbackUrl ? subs.filter((s) => s.callbackUrl === callbackUrl) : subs
  let deleted = 0
  for (const s of ours) {
    try {
      await shopifyGraphQL<DeleteResult>(storeDomain, accessToken, DELETE_MUTATION, { id: s.id })
      deleted++
    } catch (err) {
      console.error('[shopify] webhook delete failed', s.topic, err)
    }
  }
  return { deleted }
}
