import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createClient as createAdminClient } from '@supabase/supabase-js'
import { getValidToken, shopifyGraphQL } from '@/lib/shopify/client'
import type { ShopifyConfigRow } from '@/lib/shopify/client'

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

interface ShopInfo {
  shop: { name: string; plan: { displayName: string } }
}

/**
 * GET /api/shopify/config
 *
 * Returns the cached connection state from DB immediately, then re-validates
 * the token against the Shopify API and writes the fresh status back.
 *
 * Response (connected):
 *   { connected: true, shop_name, store_domain, last_synced_at, plan }
 *
 * Response (not connected):
 *   { connected: false, reason, message, store_domain?, last_synced_at? }
 */
export async function GET() {
  try {
    const supabase = await createClient()
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser()
    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { data: config } = await supabase
      .from('shopify_config')
      .select('*')
      .eq('user_id', user.id)
      .maybeSingle()

    if (!config) {
      return NextResponse.json({
        connected: false,
        reason: 'no_config',
        message:
          'No Shopify store connected yet. Enter your store domain and click "Connect Shopify Store".',
      })
    }

    // Validate token and fetch live shop info
    try {
      const token = await getValidToken(config as ShopifyConfigRow)
      const info = await shopifyGraphQL<ShopInfo>(
        config.store_domain,
        token,
        `{ shop { name plan { displayName } } }`,
      )

      await db()
        .from('shopify_config')
        .update({ connection_status: 'connected', updated_at: new Date().toISOString() })
        .eq('user_id', user.id)

      return NextResponse.json({
        connected: true,
        shop_name: info.data.shop.name,
        store_domain: config.store_domain,
        last_synced_at: config.last_synced_at,
        plan: info.data.shop.plan?.displayName ?? null,
        webhooks_registered_at: config.webhooks_registered_at ?? null,
        webhook_topics: config.webhook_topics ?? [],
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error'
      console.error('[shopify/config GET] Validation failed:', message)

      await db()
        .from('shopify_config')
        .update({ connection_status: 'error', updated_at: new Date().toISOString() })
        .eq('user_id', user.id)

      return NextResponse.json({
        connected: false,
        reason: 'api_error',
        message,
        store_domain: config.store_domain,
        last_synced_at: config.last_synced_at,
      })
    }
  } catch (error) {
    console.error('[shopify/config GET] Unexpected error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

/**
 * DELETE /api/shopify/config
 *
 * Removes the Shopify connection for the authenticated user.
 */
export async function DELETE() {
  try {
    const supabase = await createClient()
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser()
    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { error: deleteError } = await supabase
      .from('shopify_config')
      .delete()
      .eq('user_id', user.id)

    if (deleteError) {
      return NextResponse.json({ error: deleteError.message }, { status: 500 })
    }

    return NextResponse.json({ success: true })
  } catch (error) {
    console.error('[shopify/config DELETE] Unexpected error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
