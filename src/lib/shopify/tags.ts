/**
 * Add / remove tags on a Shopify order via the GraphQL Admin API.
 *
 * Requires the `write_orders` scope (read-only scopes can't mutate tags) —
 * see the OAuth `connect` route. The COD flow uses this to mark orders
 * "COD Pending Confirmation" / "COD Confirmed" / etc.
 */

import { shopifyGraphQL } from './client'

/** Build the Order GID from the numeric id we store in shopify_order_id. */
function orderGid(shopifyOrderId: string): string {
  return shopifyOrderId.startsWith('gid://')
    ? shopifyOrderId
    : `gid://shopify/Order/${shopifyOrderId}`
}

const TAGS_ADD = `
  mutation OrderTagsAdd($id: ID!, $tags: [String!]!) {
    tagsAdd(id: $id, tags: $tags) {
      node { id }
      userErrors { field message }
    }
  }
`

const TAGS_REMOVE = `
  mutation OrderTagsRemove($id: ID!, $tags: [String!]!) {
    tagsRemove(id: $id, tags: $tags) {
      node { id }
      userErrors { field message }
    }
  }
`

interface TagsResult {
  tagsAdd?: { userErrors: { message: string }[] }
  tagsRemove?: { userErrors: { message: string }[] }
}

export async function addOrderTags(
  storeDomain: string,
  accessToken: string,
  shopifyOrderId: string,
  tags: string[],
): Promise<void> {
  if (!tags.length) return
  const res = await shopifyGraphQL<TagsResult>(storeDomain, accessToken, TAGS_ADD, {
    id: orderGid(shopifyOrderId),
    tags,
  })
  const errs = res.data.tagsAdd?.userErrors ?? []
  if (errs.length) throw new Error(`tagsAdd failed: ${errs.map((e) => e.message).join('; ')}`)
}

export async function removeOrderTags(
  storeDomain: string,
  accessToken: string,
  shopifyOrderId: string,
  tags: string[],
): Promise<void> {
  if (!tags.length) return
  const res = await shopifyGraphQL<TagsResult>(storeDomain, accessToken, TAGS_REMOVE, {
    id: orderGid(shopifyOrderId),
    tags,
  })
  const errs = res.data.tagsRemove?.userErrors ?? []
  if (errs.length) throw new Error(`tagsRemove failed: ${errs.map((e) => e.message).join('; ')}`)
}
