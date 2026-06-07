import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { verifyPhoneNumber, verifyWABA } from '@/lib/whatsapp/meta-api'
import { evaluateConnection } from '@/lib/whatsapp/connection'
import { encrypt, decrypt } from '@/lib/whatsapp/encryption'

/**
 * GET /api/whatsapp/config
 *
 * Health-check: decrypts the stored token, verifies with Meta, and writes
 * the fresh status back to the DB so the next page-load can show a cached
 * result immediately before the background re-validation completes.
 *
 * Response shape:
 *   { connected: true,  phone_info: {...}, waba_info: {...} | null, last_checked_at: string }
 *   { connected: false, reason: 'no_config',        message: '...' }
 *   { connected: false, reason: 'token_corrupted',  message: '...', needs_reset: true }
 *   { connected: false, reason: 'meta_api_error',   message: '...' }
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

    const { data: config, error: configError } = await supabase
      .from('whatsapp_config')
      .select('phone_number_id, waba_id, access_token, status, waba_name, last_checked_at')
      .eq('user_id', user.id)
      .maybeSingle()

    if (configError) {
      console.error('Error fetching whatsapp_config:', configError)
      return NextResponse.json(
        { connected: false, reason: 'db_error', message: 'Failed to fetch configuration' },
        { status: 200 }
      )
    }

    if (!config) {
      return NextResponse.json(
        {
          connected: false,
          reason: 'no_config',
          message: 'No WhatsApp configuration saved yet. Fill in the form and click Save Configuration.',
        },
        { status: 200 }
      )
    }

    // Try to decrypt the stored token.
    let accessToken: string
    try {
      accessToken = decrypt(config.access_token)
    } catch (err) {
      console.error('[whatsapp/config GET] Token decryption failed:', err)

      await supabase
        .from('whatsapp_config')
        .update({ status: 'disconnected', connection_state: 'not_connected', last_checked_at: new Date().toISOString() })
        .eq('user_id', user.id)

      return NextResponse.json(
        {
          connected: false,
          state: 'not_connected',
          reason: 'token_corrupted',
          needs_reset: true,
          message:
            'The stored access token cannot be decrypted with the current ENCRYPTION_KEY. This usually means the key changed, or it differs between environments (local vs Hostinger vs Vercel). Click "Reset Configuration" below, then re-save.',
        },
        { status: 200 }
      )
    }

    // Evaluate real SEND capability from the token via debug_token — the source
    // of truth for the 3-state status. A token can read the phone number yet
    // still be unable to send (Meta #200); debug_token's granular scopes reveal
    // whether whatsapp_business_messaging is granted for this WABA.
    const result = await evaluateConnection(config.waba_id, accessToken)

    // Best-effort display details — do NOT affect the computed state.
    let phoneInfo: Awaited<ReturnType<typeof verifyPhoneNumber>> | null = null
    try {
      phoneInfo = await verifyPhoneNumber({ phoneNumberId: config.phone_number_id, accessToken })
    } catch {
      // state already determined by debug_token
    }
    let wabaInfo: Awaited<ReturnType<typeof verifyWABA>> | null = null
    if (config.waba_id) {
      try {
        wabaInfo = await verifyWABA({ wabaId: config.waba_id, accessToken })
      } catch {
        // non-blocking
      }
    }

    // Persist the 3-state so the sidebar/pill read one source. Keep the legacy
    // 2-state `status` meaningful (green/amber = configured + token valid).
    const lastCheckedAt = new Date().toISOString()
    const dbUpdate: Record<string, unknown> = {
      connection_state: result.state,
      status: result.state === 'not_connected' ? 'disconnected' : 'connected',
      last_checked_at: lastCheckedAt,
    }
    if (wabaInfo?.name) dbUpdate.waba_name = wabaInfo.name

    await supabase.from('whatsapp_config').update(dbUpdate).eq('user_id', user.id)

    return NextResponse.json({
      connected: result.state === 'connected',
      state: result.state,
      can_send: result.state === 'connected',
      token_valid: result.tokenValid,
      detail: result.detail,
      scopes: result.scopes,
      phone_info: phoneInfo,
      waba_info: wabaInfo,
      waba_name: wabaInfo?.name ?? config.waba_name ?? null,
      last_checked_at: lastCheckedAt,
    })
  } catch (error) {
    console.error('Error in WhatsApp config GET:', error)
    return NextResponse.json(
      { connected: false, reason: 'unknown', message: 'Internal server error' },
      { status: 500 }
    )
  }
}

/**
 * POST /api/whatsapp/config
 *
 * Saves or updates the WhatsApp config. Verifies credentials with Meta first,
 * fetches WABA account name if waba_id is provided, then encrypts and stores.
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

    const body = await request.json()
    const { phone_number_id, waba_id, access_token, verify_token } = body

    if (!access_token || !phone_number_id) {
      return NextResponse.json(
        { error: 'access_token and phone_number_id are required' },
        { status: 400 }
      )
    }

    // Phone number verification — non-blocking (save with warning if Meta rejects).
    let phoneInfo: Awaited<ReturnType<typeof verifyPhoneNumber>> | null = null
    let metaWarning: string | null = null
    try {
      phoneInfo = await verifyPhoneNumber({ phoneNumberId: phone_number_id, accessToken: access_token })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown Meta API error'
      console.warn('[whatsapp/config POST] Meta verification failed (non-blocking):', message)
      metaWarning = message
    }

    // WABA account name — non-blocking, only attempted when waba_id is provided.
    let wabaInfo: Awaited<ReturnType<typeof verifyWABA>> | null = null
    if (waba_id && access_token) {
      try {
        wabaInfo = await verifyWABA({ wabaId: waba_id, accessToken: access_token })
      } catch (err) {
        console.warn('[whatsapp/config POST] WABA name fetch failed (non-blocking):', err)
      }
    }

    // Encrypt sensitive tokens.
    let encryptedAccessToken: string
    let encryptedVerifyToken: string | null
    try {
      encryptedAccessToken = encrypt(access_token)
      encryptedVerifyToken = verify_token ? encrypt(verify_token) : null
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown encryption error'
      console.error('Encryption failed:', message)
      return NextResponse.json(
        {
          error:
            'Failed to encrypt token. Check that ENCRYPTION_KEY is a valid 64-character hex string in your environment variables.',
        },
        { status: 500 }
      )
    }

    const configStatus = phoneInfo ? 'connected' : 'disconnected'
    const connectedAt = phoneInfo ? new Date().toISOString() : null
    const lastCheckedAt = new Date().toISOString()

    const { data: existing } = await supabase
      .from('whatsapp_config')
      .select('id')
      .eq('user_id', user.id)
      .maybeSingle()

    if (existing) {
      const { error: updateError } = await supabase
        .from('whatsapp_config')
        .update({
          phone_number_id,
          waba_id: waba_id || null,
          access_token: encryptedAccessToken,
          verify_token: encryptedVerifyToken,
          status: configStatus,
          connected_at: connectedAt,
          waba_name: wabaInfo?.name ?? null,
          last_checked_at: lastCheckedAt,
          updated_at: new Date().toISOString(),
        })
        .eq('user_id', user.id)

      if (updateError) {
        console.error('Error updating whatsapp_config:', updateError)
        return NextResponse.json(
          { error: `Failed to update configuration: ${updateError.message}` },
          { status: 500 }
        )
      }
    } else {
      const { error: insertError } = await supabase
        .from('whatsapp_config')
        .insert({
          user_id: user.id,
          phone_number_id,
          waba_id: waba_id || null,
          access_token: encryptedAccessToken,
          verify_token: encryptedVerifyToken,
          status: configStatus,
          connected_at: connectedAt,
          waba_name: wabaInfo?.name ?? null,
          last_checked_at: lastCheckedAt,
        })

      if (insertError) {
        console.error('Error inserting whatsapp_config:', insertError)
        return NextResponse.json(
          { error: `Failed to save configuration: ${insertError.message}` },
          { status: 500 }
        )
      }
    }

    return NextResponse.json({
      success: true,
      phone_info: phoneInfo,
      waba_info: wabaInfo,
      last_checked_at: lastCheckedAt,
      ...(metaWarning ? { warning: metaWarning } : {}),
    })
  } catch (error) {
    console.error('Error in WhatsApp config POST:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

/**
 * DELETE /api/whatsapp/config
 *
 * Removes the authenticated user's WhatsApp configuration row.
 * Used by the "Reset Configuration" button to recover from a corrupted
 * encrypted token (mismatched ENCRYPTION_KEY across environments).
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
      .from('whatsapp_config')
      .delete()
      .eq('user_id', user.id)

    if (deleteError) {
      console.error('Error deleting whatsapp_config:', deleteError)
      return NextResponse.json(
        { error: 'Failed to delete configuration' },
        { status: 500 }
      )
    }

    return NextResponse.json({ success: true })
  } catch (error) {
    console.error('Error in WhatsApp config DELETE:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
