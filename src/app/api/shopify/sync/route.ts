import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createClient as createAdminClient } from '@supabase/supabase-js'
import { getValidToken, shopifyGraphQL } from '@/lib/shopify/client'
import { normalizePhone } from '@/lib/whatsapp/phone-utils'
import type { ShopifyConfigRow } from '@/lib/shopify/client'

// 50 customers per page keeps each Vercel function call well under 10 s,
// even on the Hobby plan. The client loops until done=true.
const PAGE_SIZE = 50

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

// ─── GraphQL Query ────────────────────────────────────────────────────────────

interface CustomerNode {
  id: string
  firstName: string | null
  lastName: string | null
  email: string | null
  phone: string | null
  numberOfOrders: number
  amountSpent: { amount: string; currencyCode: string } | null
  lastOrder: { processedAt: string } | null
  tags: string[]
}

interface CustomersQueryResult {
  customers: {
    pageInfo: { hasNextPage: boolean; endCursor: string | null }
    edges: Array<{ node: CustomerNode }>
  }
}

const CUSTOMERS_QUERY = `
  query ShopifyCustomers($first: Int!, $after: String) {
    customers(first: $first, after: $after) {
      pageInfo { hasNextPage endCursor }
      edges {
        node {
          id
          firstName
          lastName
          email
          phone
          numberOfOrders
          amountSpent { amount currencyCode }
          lastOrder { processedAt }
          tags
        }
      }
    }
  }
`

// ─── Phone Normalization ──────────────────────────────────────────────────────

function tryNormalizePhone(raw: string | null): string | null {
  if (!raw) return null
  try {
    return normalizePhone(raw)
  } catch {
    // Shopify phone numbers are sometimes incomplete (e.g. no country code).
    // Return the raw value so the contact can still be created; phone-based
    // dedup just won't fire for this customer.
    return raw
  }
}

// ─── Contact Upsert ───────────────────────────────────────────────────────────

interface ExistingContact {
  id: string
  name: string | null
  email: string | null
  phone: string | null
}

/**
 * POST /api/shopify/sync
 *
 * Fetch one page of Shopify customers and upsert them into contacts.
 *
 * Request body: { cursor?: string, total_processed?: number }
 *
 * Response:
 *   { done, next_cursor, processed, total_processed, created, updated, errors }
 *
 * The UI calls this in a loop, passing back `next_cursor` each time, until
 * `done` is true.  Each call is independent and fast (<10 s) so no Vercel
 * timeout is hit regardless of store size.
 */
export async function POST(request: Request) {
  try {
    const supabase = await createClient()
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser()
    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const body = await request.json().catch(() => ({}))
    const cursor: string | null = body.cursor ?? null
    const totalProcessedSoFar: number = body.total_processed ?? 0

    // Load Shopify config
    const { data: config } = await supabase
      .from('shopify_config')
      .select('*')
      .eq('user_id', user.id)
      .maybeSingle()

    if (!config) {
      return NextResponse.json({ error: 'No Shopify store connected' }, { status: 400 })
    }

    // Get a valid (possibly refreshed) access token
    let token: string
    try {
      token = await getValidToken(config as ShopifyConfigRow)
    } catch (err) {
      return NextResponse.json(
        { error: err instanceof Error ? err.message : 'Token error' },
        { status: 401 },
      )
    }

    // Fetch one page from Shopify
    let gqlResult: Awaited<ReturnType<typeof shopifyGraphQL<CustomersQueryResult>>>
    try {
      gqlResult = await shopifyGraphQL<CustomersQueryResult>(
        config.store_domain,
        token,
        CUSTOMERS_QUERY,
        { first: PAGE_SIZE, after: cursor },
      )
    } catch (err) {
      return NextResponse.json(
        { error: err instanceof Error ? err.message : 'Shopify API error' },
        { status: 502 },
      )
    }

    const { pageInfo, edges } = gqlResult.data.customers

    // Rate-limit courtesy pause: if we've used most of the query budget,
    // wait just long enough for the bucket to partially restore before
    // returning (the client will call us again for the next page anyway,
    // but we don't want it to hammer us while Shopify throttles).
    const cost = gqlResult.extensions?.cost
    if (cost) {
      const { currentlyAvailable, restoreRate, maximumAvailable } = cost.throttleStatus
      const safeFloor = maximumAvailable * 0.2 // stay above 20 % of bucket
      if (currentlyAvailable < safeFloor) {
        const waitMs = Math.ceil((safeFloor - currentlyAvailable) / restoreRate) * 1000
        await new Promise((r) => setTimeout(r, Math.min(waitMs, 4_000)))
      }
    }

    if (edges.length === 0) {
      return NextResponse.json({
        done: !pageInfo.hasNextPage,
        next_cursor: pageInfo.endCursor,
        processed: 0,
        total_processed: totalProcessedSoFar,
        created: 0,
        updated: 0,
        errors: 0,
      })
    }

    // ── Batch DB lookups (3 queries regardless of page size) ─────────────────

    // 1. By shopify_customer_id
    const allShopifyIds = edges.map((e) => e.node.id)
    const { data: byShopifyIdRows } = await db()
      .from('contacts')
      .select('id, name, email, phone, shopify_customer_id')
      .eq('user_id', user.id)
      .in('shopify_customer_id', allShopifyIds)

    const shopifyIdMap = new Map<string, ExistingContact>(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (byShopifyIdRows ?? []).map((c: any) => [c.shopify_customer_id as string, c as ExistingContact]),
    )

    // 2. By normalized phone — for customers not yet matched
    const unmatchedAfterShopifyId = edges.filter((e) => !shopifyIdMap.has(e.node.id))
    const phoneToShopifyId = new Map<string, string>()
    for (const { node } of unmatchedAfterShopifyId) {
      const p = tryNormalizePhone(node.phone)
      if (p) phoneToShopifyId.set(p, node.id)
    }
    const phonesToLookup = [...phoneToShopifyId.keys()]

    const { data: byPhoneRows } = phonesToLookup.length > 0
      ? await db()
          .from('contacts')
          .select('id, name, email, phone')
          .eq('user_id', user.id)
          .in('phone', phonesToLookup)
      : { data: [] }

    const phoneMap = new Map<string, ExistingContact>(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (byPhoneRows ?? []).map((c: any) => [c.phone as string, c as ExistingContact]),
    )

    // 3. By email — for customers still unmatched
    const matchedPhones = new Set(
      unmatchedAfterShopifyId
        .map((e) => tryNormalizePhone(e.node.phone))
        .filter((p): p is string => !!p && phoneMap.has(p)),
    )
    const unmatchedAfterPhone = unmatchedAfterShopifyId.filter((e) => {
      const p = tryNormalizePhone(e.node.phone)
      return !p || !matchedPhones.has(p)
    })
    const emailToShopifyId = new Map<string, string>()
    for (const { node } of unmatchedAfterPhone) {
      if (node.email) emailToShopifyId.set(node.email, node.id)
    }
    const emailsToLookup = [...emailToShopifyId.keys()]

    const { data: byEmailRows } = emailsToLookup.length > 0
      ? await db()
          .from('contacts')
          .select('id, name, email, phone')
          .eq('user_id', user.id)
          .in('email', emailsToLookup)
      : { data: [] }

    const emailMap = new Map<string, ExistingContact>(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (byEmailRows ?? []).map((c: any) => [c.email as string, c as ExistingContact]),
    )

    // ── Apply changes ─────────────────────────────────────────────────────────

    let created = 0, updated = 0, errors = 0

    for (const { node: customer } of edges) {
      try {
        const normalizedPhone = tryNormalizePhone(customer.phone)
        const fullName =
          [customer.firstName, customer.lastName].filter(Boolean).join(' ').trim() || null

        const shopifyFields = {
          shopify_customer_id: customer.id,
          shopify_store_domain: config.store_domain,
          shopify_total_orders: customer.numberOfOrders,
          shopify_total_spent: customer.amountSpent
            ? parseFloat(customer.amountSpent.amount)
            : null,
          shopify_currency: customer.amountSpent?.currencyCode ?? null,
          shopify_last_order_at: customer.lastOrder?.processedAt ?? null,
          shopify_tags: customer.tags.length > 0 ? customer.tags : null,
          updated_at: new Date().toISOString(),
        }

        // Helper: only overwrite a contact's native field if it is empty
        const enrich = (existing: ExistingContact) => ({
          ...shopifyFields,
          ...(fullName && !existing.name ? { name: fullName } : {}),
          ...(customer.email && !existing.email ? { email: customer.email } : {}),
          ...(normalizedPhone && !existing.phone ? { phone: normalizedPhone } : {}),
        })

        // ── Update path ───────────────────────────────────────────────────────
        const existingByShopifyId = shopifyIdMap.get(customer.id)
        if (existingByShopifyId) {
          await db()
            .from('contacts')
            .update(enrich(existingByShopifyId))
            .eq('id', existingByShopifyId.id)
          updated++
          continue
        }

        const existingByPhone =
          normalizedPhone ? phoneMap.get(normalizedPhone) : undefined
        if (existingByPhone) {
          await db()
            .from('contacts')
            .update(enrich(existingByPhone))
            .eq('id', existingByPhone.id)
          updated++
          continue
        }

        const existingByEmail = customer.email ? emailMap.get(customer.email) : undefined
        if (existingByEmail) {
          await db()
            .from('contacts')
            .update(enrich(existingByEmail))
            .eq('id', existingByEmail.id)
          updated++
          continue
        }

        // ── Insert path ───────────────────────────────────────────────────────
        // Skip customers with no usable contact identifier
        if (!normalizedPhone && !customer.email) continue

        const { error: insertError } = await db().from('contacts').insert({
          user_id: user.id,
          name: fullName,
          phone: normalizedPhone,
          email: customer.email ?? null,
          ...shopifyFields,
        })

        if (insertError) {
          console.error('[shopify/sync] Insert error:', insertError.message)
          errors++
        } else {
          created++
        }
      } catch (err) {
        console.error('[shopify/sync] Customer error:', err)
        errors++
      }
    }

    const totalProcessed = totalProcessedSoFar + edges.length

    // Mark last_synced_at when we finish the final page
    if (!pageInfo.hasNextPage) {
      await db()
        .from('shopify_config')
        .update({
          last_synced_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq('user_id', user.id)
    }

    return NextResponse.json({
      done: !pageInfo.hasNextPage,
      next_cursor: pageInfo.hasNextPage ? pageInfo.endCursor : null,
      processed: edges.length,
      total_processed: totalProcessed,
      created,
      updated,
      errors,
    })
  } catch (error) {
    console.error('[shopify/sync] Unexpected error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
