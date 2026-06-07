import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { metaRawPost, metaRawGet } from '@/lib/whatsapp/meta-api'
import { decrypt } from '@/lib/whatsapp/encryption'

/**
 * POST /api/whatsapp/register
 *
 * Registers the stored phone_number_id to OUR credentials via the Cloud API
 * (`POST /{phone-number-id}/register` with messaging_product + a 6-digit pin).
 * This claims the number for our app even if it was previously connected to a
 * third-party app. Two-step verification off → pin "000000".
 *
 * Returns Meta's RAW responses (never throws on a Meta error) plus a follow-up
 * GET of the phone number's status/account_mode, so the operator sees exactly
 * what Meta said and whether the number is now active for our app.
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
    if (!config) return NextResponse.json({ error: 'WhatsApp is not configured yet.' }, { status: 400 })
    if (!config.phone_number_id) {
      return NextResponse.json(
        { error: 'Phone Number ID is missing — add it in API Credentials and save first.' },
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

    // Two-step is off → default pin "000000". Allow a 6-digit override.
    let pin = '000000'
    try {
      const body = await request.json()
      if (body?.pin && /^\d{6}$/.test(String(body.pin))) pin = String(body.pin)
    } catch {
      // no body — keep default
    }

    const register = await metaRawPost(
      `${config.phone_number_id}/register`,
      accessToken,
      { messaging_product: 'whatsapp', pin },
    )
    if (!register.ok) {
      console.error('[whatsapp/register] Meta rejected register:', JSON.stringify(register.body))
    }

    // Confirm the number's current state regardless of the register outcome.
    const phone = await metaRawGet(
      `${config.phone_number_id}?fields=id,display_phone_number,status,account_mode,quality_rating`,
      accessToken,
    )

    return NextResponse.json({ register, phone })
  } catch (error) {
    console.error('[whatsapp/register] error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
