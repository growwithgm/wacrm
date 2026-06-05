import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createClient as createAdminClient } from '@supabase/supabase-js'
import { getValidToken, shopifyRest } from '@/lib/shopify/client'
import { upsertCheckout } from '@/lib/shopify/store'
import type { ShopifyConfigRow } from '@/lib/shopify/client'
import type { RestCheckout } from '@/lib/shopify/transform'

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

/**
 * POST /api/shopify/sync/checkouts
 *
 * Backfill abandoned checkouts one page at a time (the `/checkouts.json`
 * REST endpoint returns abandoned checkouts). Same cursor-loop contract as
 * the orders sync.
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

    const path = cursor
      ? `checkouts.json?limit=${PAGE_SIZE}&page_info=${encodeURIComponent(cursor)}`
      : `checkouts.json?limit=${PAGE_SIZE}`

    let result: Awaited<ReturnType<typeof shopifyRest<{ checkouts: RestCheckout[] }>>>
    try {
      result = await shopifyRest<{ checkouts: RestCheckout[] }>(config.store_domain, token, path)
    } catch (err) {
      return NextResponse.json(
        { error: err instanceof Error ? err.message : 'Shopify API error' },
        { status: 502 },
      )
    }

    const checkouts = result.data.checkouts ?? []
    let errors = 0
    for (const checkout of checkouts) {
      try {
        await upsertCheckout(db(), user.id, config.store_domain, checkout)
      } catch (err) {
        console.error('[shopify/sync/checkouts] upsert error:', err)
        errors++
      }
    }

    const totalProcessed = totalSoFar + checkouts.length
    const done = !result.nextPageInfo

    return NextResponse.json({
      done,
      next_cursor: result.nextPageInfo,
      processed: checkouts.length,
      total_processed: totalProcessed,
      errors,
    })
  } catch (error) {
    console.error('[shopify/sync/checkouts] Unexpected error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
