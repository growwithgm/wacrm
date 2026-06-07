import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { subscribeApp, getSubscribedApps } from '@/lib/whatsapp/meta-api'
import { decrypt } from '@/lib/whatsapp/encryption'

/**
 * POST /api/whatsapp/subscribe
 *
 * Subscribes the stored token's app to this WABA's webhooks (the inbound fix —
 * without this, no incoming WhatsApp messages arrive). Then reads back
 * subscribed_apps so the caller can confirm the app now appears.
 */
export async function POST() {
  try {
    const supabase = await createClient()
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser()
    if (authError || !user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const { data: config } = await supabase
      .from('whatsapp_config')
      .select('waba_id, access_token')
      .eq('user_id', user.id)
      .maybeSingle()
    if (!config) {
      return NextResponse.json({ error: 'WhatsApp is not configured yet.' }, { status: 400 })
    }
    if (!config.waba_id) {
      return NextResponse.json(
        { error: 'WhatsApp Business Account ID (WABA ID) is missing — add it in API Credentials and save first.' },
        { status: 400 },
      )
    }

    let accessToken: string
    try {
      accessToken = decrypt(config.access_token)
    } catch {
      return NextResponse.json(
        { error: 'Stored token cannot be decrypted. Reset the configuration and re-enter the token.' },
        { status: 400 },
      )
    }

    try {
      const res = await subscribeApp({ wabaId: config.waba_id, accessToken })
      let subscribedApps: unknown = null
      try {
        const apps = await getSubscribedApps({ wabaId: config.waba_id, accessToken })
        subscribedApps = apps.data ?? []
      } catch (err) {
        console.warn('[whatsapp/subscribe] readback failed:', err)
      }
      return NextResponse.json({ success: !!res.success, subscribed_apps: subscribedApps })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Subscribe failed'
      console.error('[whatsapp/subscribe] failed:', message)
      return NextResponse.json({ error: message }, { status: 502 })
    }
  } catch (error) {
    console.error('[whatsapp/subscribe] error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
