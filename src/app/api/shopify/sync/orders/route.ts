import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createClient as createAdminClient } from '@supabase/supabase-js'
import { getValidToken, shopifyRest } from '@/lib/shopify/client'
import { upsertOrder } from '@/lib/shopify/store'
import type { ShopifyConfigRow } from '@/lib/shopify/client'
import type { RestOrder } from '@/lib/shopify/transform'

// Orders carry line items + embedded fulfillments, so each one fans out to
// several DB writes — 25/page keeps a call comfortably under the 10s budget.
const PAGE_SIZE = 25

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
 * POST /api/shopify/sync/orders
 *
 * Backfill historical orders one page at a time. The UI calls this in a
 * loop, passing back `next_cursor` (a REST `page_info` token) until `done`.
 *
 * Request body:  { cursor?: string, total_processed?: number }
 * Response:      { done, next_cursor, processed, total_processed, errors }
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
    const totalSoFar: number = body.total_processed ?? 0

    const { data: config } = await supabase
      .from('shopify_config')
      .select('*')
      .eq('user_id', user.id)
      .maybeSingle()

    if (!config) {
      return NextResponse.json({ error: 'No Shopify store connected' }, { status: 400 })
    }

    let token: string
    try {
      token = await getValidToken(config as ShopifyConfigRow)
    } catch (err) {
      return NextResponse.json(
        { error: err instanceof Error ? err.message : 'Token error' },
        { status: 401 },
      )
    }

    // First page filters to all statuses; subsequent pages must use only
    // limit + page_info (Shopify rejects other filters alongside a cursor).
    const path = cursor
      ? `orders.json?limit=${PAGE_SIZE}&page_info=${encodeURIComponent(cursor)}`
      : `orders.json?status=any&limit=${PAGE_SIZE}`

    let result: Awaited<ReturnType<typeof shopifyRest<{ orders: RestOrder[] }>>>
    try {
      result = await shopifyRest<{ orders: RestOrder[] }>(config.store_domain, token, path)
    } catch (err) {
      return NextResponse.json(
        { error: err instanceof Error ? err.message : 'Shopify API error' },
        { status: 502 },
      )
    }

    const orders = result.data.orders ?? []
    let errors = 0
    for (const order of orders) {
      try {
        await upsertOrder(db(), user.id, config.store_domain, order)
      } catch (err) {
        console.error('[shopify/sync/orders] upsert error:', err)
        errors++
      }
    }

    const totalProcessed = totalSoFar + orders.length
    const done = !result.nextPageInfo

    return NextResponse.json({
      done,
      next_cursor: result.nextPageInfo,
      processed: orders.length,
      total_processed: totalProcessed,
      errors,
    })
  } catch (error) {
    console.error('[shopify/sync/orders] Unexpected error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
