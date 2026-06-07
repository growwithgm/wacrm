import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { metaRawGet, debugToken } from '@/lib/whatsapp/meta-api'
import { decrypt } from '@/lib/whatsapp/encryption'

/**
 * GET /api/whatsapp/diagnostics
 *
 * Surfaces Meta's RAW responses (status + body, errors included) for the things
 * that explain inbound + outbound failures, using the stored token:
 *   - token app id/name/validity/scopes (who the token belongs to)
 *   - subscribed_apps  (inbound: is the app subscribed to the WABA?)
 *   - phone_numbers under the WABA + the specific phone number (outbound #200)
 *   - the decrypted verify token + whether META_APP_SECRET is configured
 *
 * Owner-only (auth-scoped). Read-only.
 */
export async function GET() {
  try {
    const supabase = await createClient()
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser()
    if (authError || !user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const { data: config } = await supabase
      .from('whatsapp_config')
      .select('phone_number_id, waba_id, access_token, verify_token')
      .eq('user_id', user.id)
      .maybeSingle()
    if (!config) return NextResponse.json({ error: 'WhatsApp is not configured yet.' }, { status: 400 })

    let accessToken: string
    try {
      accessToken = decrypt(config.access_token)
    } catch {
      return NextResponse.json(
        { error: 'Stored token cannot be decrypted. Reset the configuration and re-enter the token.' },
        { status: 400 },
      )
    }

    let verifyToken: string | null = null
    try {
      verifyToken = config.verify_token ? decrypt(config.verify_token) : null
    } catch {
      verifyToken = '(cannot decrypt)'
    }

    const secret = process.env.META_APP_SECRET
    const appSecretConfigured = !!secret && secret !== 'test123' && secret !== 'your-app-secret'

    const token = await debugToken({ token: accessToken })
    const wabaId = config.waba_id
    const phoneId = config.phone_number_id

    const [subscribedApps, phoneNumbers, phone] = await Promise.all([
      wabaId ? metaRawGet(`${wabaId}/subscribed_apps`, accessToken) : Promise.resolve(null),
      wabaId
        ? metaRawGet(
            `${wabaId}/phone_numbers?fields=id,display_phone_number,verified_name,quality_rating,code_verification_status,platform_type`,
            accessToken,
          )
        : Promise.resolve(null),
      phoneId
        ? metaRawGet(`${phoneId}?fields=id,display_phone_number,verified_name,quality_rating`, accessToken)
        : Promise.resolve(null),
    ])

    return NextResponse.json({
      token_app: {
        id: token.app_id ?? null,
        name: token.application ?? null,
        type: token.type ?? null,
        is_valid: token.is_valid ?? false,
        scopes: token.scopes ?? [],
        granular_scopes: token.granular_scopes ?? [],
      },
      waba_id: wabaId ?? null,
      phone_number_id: phoneId ?? null,
      verify_token: verifyToken,
      app_secret_configured: appSecretConfigured,
      subscribed_apps: subscribedApps,
      phone_numbers: phoneNumbers,
      phone,
    })
  } catch (error) {
    console.error('[whatsapp/diagnostics] error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
