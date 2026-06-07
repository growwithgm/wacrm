import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { metaRawPost, debugToken } from '@/lib/whatsapp/meta-api'
import { decrypt } from '@/lib/whatsapp/encryption'
import { sanitizePhoneForMeta } from '@/lib/whatsapp/phone-utils'

/**
 * POST /api/whatsapp/test-send
 *
 * Isolation diagnostic for the deep #200. Uses the SAME stored token the real
 * send path uses (whatsapp_config.access_token), so there's no token mismatch:
 *   - reports the token's app id/name/type (debug_token) → answers "which token"
 *   - posts a plain TEXT message (account-permission test)
 *   - optionally posts a TEMPLATE message with the exact body we'd send
 * Returns the EXACT request bodies + Meta's RAW responses (code, error_subcode,
 * error_data.details, fbtrace_id) for each — never throws on a Meta error.
 *
 * Does not touch the production send functions.
 */
export async function POST(request: Request) {
  try {
    const supabase = await createClient()
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser()
    if (authError || !user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const { data: config } = await supabase
      .from('whatsapp_config')
      .select('phone_number_id, access_token')
      .eq('user_id', user.id)
      .maybeSingle()
    if (!config?.phone_number_id) {
      return NextResponse.json({ error: 'WhatsApp phone number is not configured.' }, { status: 400 })
    }

    // SAME source as the real send path (whatsapp_config.access_token).
    let accessToken: string
    try {
      accessToken = decrypt(config.access_token)
    } catch {
      return NextResponse.json(
        { error: 'Stored token cannot be decrypted. Reset the configuration and re-enter the token.' },
        { status: 400 },
      )
    }

    const body = await request.json().catch(() => ({}))
    const to = sanitizePhoneForMeta(String(body?.to ?? ''))
    if (!to) return NextResponse.json({ error: 'Recipient phone number is required.' }, { status: 400 })
    const templateName = body?.templateName ? String(body.templateName) : null
    const templateLanguage = body?.templateLanguage ? String(body.templateLanguage) : 'es'

    // Identify the token the send path actually uses (answers #4 at runtime).
    const token = await debugToken({ token: accessToken })
    console.log(
      '[whatsapp/test-send] token app:',
      JSON.stringify({ app_id: token.app_id, application: token.application, type: token.type, is_valid: token.is_valid }),
    )

    const phoneId = config.phone_number_id

    // 1) Plain text — isolates account-permission vs template-config.
    const textRequest = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'text',
      text: { body: 'Wasify test message' },
    }
    const textResponse = await metaRawPost(`${phoneId}/messages`, accessToken, textRequest)
    console.log('[whatsapp/test-send] text result:', JSON.stringify({ ok: textResponse.ok, status: textResponse.status, body: textResponse.body }))

    // 2) Optional template — the exact body our send code would build.
    let template: { request: unknown; response: { ok: boolean; status: number; body: unknown } } | null = null
    if (templateName) {
      const templateRequest = {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to,
        type: 'template',
        template: { name: templateName, language: { code: templateLanguage } },
      }
      const templateResponse = await metaRawPost(`${phoneId}/messages`, accessToken, templateRequest)
      console.log('[whatsapp/test-send] template result:', JSON.stringify({ name: templateName, language: templateLanguage, ok: templateResponse.ok, status: templateResponse.status, body: templateResponse.body }))
      template = { request: templateRequest, response: templateResponse }
    }

    return NextResponse.json({
      token_app: {
        id: token.app_id ?? null,
        name: token.application ?? null,
        type: token.type ?? null,
        is_valid: token.is_valid ?? false,
      },
      phone_number_id: phoneId,
      text: { request: textRequest, response: textResponse },
      template,
    })
  } catch (error) {
    console.error('[whatsapp/test-send] error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
