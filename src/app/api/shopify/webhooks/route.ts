import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createClient as createAdminClient } from '@supabase/supabase-js'
import { getValidToken } from '@/lib/shopify/client'
import { registerWebhooks, listWebhooks, WEBHOOK_TOPICS } from '@/lib/shopify/webhooks'
import { shopifyWebhookCallbackUrl } from '@/lib/shopify/url'
import type { ShopifyConfigRow } from '@/lib/shopify/client'

export const runtime = 'nodejs'

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

async function loadConfig(userId: string) {
  const supabase = await createClient()
  const { data } = await supabase
    .from('shopify_config')
    .select('*')
    .eq('user_id', userId)
    .maybeSingle()
  return data
}

/**
 * GET /api/shopify/webhooks
 *
 * Live webhook status straight from Shopify (not our stored flag): which
 * topics are subscribed, to what callback URL, and whether they all point at
 * THIS deployment's expected URL.
 */
export async function GET(request: Request) {
  try {
    const supabase = await createClient()
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser()
    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const config = await loadConfig(user.id)
    if (!config) {
      return NextResponse.json({ connected: false, error: 'No Shopify store connected' })
    }

    const expectedCallbackUrl = shopifyWebhookCallbackUrl(request)

    let token: string
    try {
      token = await getValidToken(config as ShopifyConfigRow)
    } catch (err) {
      return NextResponse.json({
        connected: true,
        error: err instanceof Error ? err.message : 'Token error',
        expected_callback_url: expectedCallbackUrl,
        subscriptions: [],
      })
    }

    try {
      const subs = await listWebhooks(config.store_domain, token)
      const ours = subs.filter((s) => s.callbackUrl === expectedCallbackUrl)
      const registeredTopics = ours.map((s) => s.topic)
      const allPresent = WEBHOOK_TOPICS.every((t) => registeredTopics.includes(t))
      return NextResponse.json({
        connected: true,
        expected_callback_url: expectedCallbackUrl,
        required_topics: WEBHOOK_TOPICS,
        subscriptions: subs,
        registered_topics: registeredTopics,
        all_present: allPresent,
        webhooks_registered_at: config.webhooks_registered_at ?? null,
      })
    } catch (err) {
      return NextResponse.json({
        connected: true,
        error: err instanceof Error ? err.message : 'Failed to list webhooks',
        expected_callback_url: expectedCallbackUrl,
        subscriptions: [],
      })
    }
  } catch (error) {
    console.error('[shopify/webhooks GET] Unexpected error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

/**
 * POST /api/shopify/webhooks
 *
 * Register (or re-register) all Phase A webhooks for the connected store —
 * no OAuth reconnect required. Returns the exact callback URL used plus the
 * verbatim per-topic result, so any Shopify error is visible immediately.
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

    const config = await loadConfig(user.id)
    if (!config) {
      return NextResponse.json({ error: 'No Shopify store connected' }, { status: 400 })
    }

    const callbackUrl = shopifyWebhookCallbackUrl(request)

    // Fail fast with a clear message if we'd be handing Shopify a non-HTTPS
    // address — Shopify rejects those, and it's the single most common cause.
    if (!callbackUrl.startsWith('https://')) {
      return NextResponse.json(
        {
          error: `Callback URL is not HTTPS (${callbackUrl}). Set NEXT_PUBLIC_SITE_URL to your public https URL and retry from production.`,
          callback_url: callbackUrl,
        },
        { status: 400 },
      )
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

    const result = await registerWebhooks(config.store_domain, token, callbackUrl)
    console.log('[shopify/webhooks POST] registration result', {
      shop: config.store_domain,
      callbackUrl: result.callbackUrl,
      registered: result.registered,
      failed: result.failed,
    })

    await db()
      .from('shopify_config')
      .update({
        webhooks_registered_at: result.registered.length > 0 ? new Date().toISOString() : null,
        webhook_topics: result.registered.length > 0 ? result.registered : null,
        updated_at: new Date().toISOString(),
      })
      .eq('user_id', user.id)

    return NextResponse.json({
      ok: result.failed.length === 0,
      callback_url: result.callbackUrl,
      registered: result.registered,
      failed: result.failed,
    })
  } catch (error) {
    console.error('[shopify/webhooks POST] Unexpected error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
