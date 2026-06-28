import { NextResponse } from 'next/server'
import crypto from 'crypto'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { engineSendText } from '@/lib/flows/meta-send'
import { decrypt } from '@/lib/whatsapp/encryption'
import { sendTemplateMessage } from '@/lib/whatsapp/meta-api'
import {
  sanitizePhoneForMeta,
  isValidE164,
  phoneVariants,
  isRecipientNotAllowedError,
} from '@/lib/whatsapp/phone-utils'

export const runtime = 'nodejs'

// ---------------------------------------------------------------------------
// Machine-callable outbound endpoint for trusted internal callers (e.g. the
// B2B Lead CRM's "Send WhatsApp"). Unlike /api/whatsapp/send (cookie session +
// an existing conversation_id), this:
//   - authenticates with a bearer token (WACRM_API_TOKEN) — no user session,
//   - accepts a raw E.164-ish phone number,
//   - finds-or-creates the contact + conversation under the owner account, so
//     the message shows up in Wasify's inbox/threads exactly like any other,
//   - sends via the SAME Meta Cloud API code path used everywhere else,
//   - never returns or logs the Meta access token.
//
// Body (one of):
//   { "to": "+34600000000", "message": "free text" }
//   { "to": "+34600000000", "template": "name", "variables": ["a","b"], "language": "es" }
// ---------------------------------------------------------------------------

function bearerOk(header: string | null, expected: string): boolean {
  if (!header) return false
  const match = header.match(/^Bearer\s+(.+)$/i)
  const provided = match ? match[1] : ''
  const a = Buffer.from(provided)
  const b = Buffer.from(expected)
  if (a.length !== b.length) return false
  return crypto.timingSafeEqual(a, b)
}

export async function POST(request: Request) {
  const expected = process.env.WACRM_API_TOKEN
  if (!expected) {
    // Stay gracefully unconfigured rather than 500.
    return NextResponse.json({ error: 'not_configured' }, { status: 503 })
  }
  if (!bearerOk(request.headers.get('authorization'), expected)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  let body: {
    to?: unknown
    message?: unknown
    template?: unknown
    variables?: unknown
    language?: unknown
  }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 })
  }

  const to = typeof body.to === 'string' ? body.to : ''
  const message = typeof body.message === 'string' ? body.message.trim() : ''
  const template = typeof body.template === 'string' ? body.template.trim() : ''
  const variables = Array.isArray(body.variables) ? body.variables.map(String) : []
  const language = typeof body.language === 'string' ? body.language : undefined

  if (!to) {
    return NextResponse.json({ error: 'to is required' }, { status: 400 })
  }
  if (!message && !template) {
    return NextResponse.json(
      { error: 'message or template is required' },
      { status: 400 },
    )
  }

  const sanitized = sanitizePhoneForMeta(to)
  if (!isValidE164(sanitized)) {
    return NextResponse.json({ error: 'invalid phone number' }, { status: 400 })
  }

  const db = supabaseAdmin()

  // Resolve the owner account. Prefer an explicit env; otherwise fall back to
  // the single connected WhatsApp config (this deployment is single-tenant).
  let userId = process.env.WACRM_SEND_USER_ID ?? ''
  if (!userId) {
    const { data: configs } = await db
      .from('whatsapp_config')
      .select('user_id, status')
      .order('connected_at', { ascending: false })
    const rows = configs ?? []
    const connected = rows.filter((r) => r.status === 'connected')
    if (connected.length === 1) userId = connected[0].user_id
    else if (rows.length === 1) userId = rows[0].user_id
  }
  if (!userId) {
    return NextResponse.json(
      {
        error:
          'no_account: set WACRM_SEND_USER_ID, or connect exactly one WhatsApp config',
      },
      { status: 400 },
    )
  }

  // Find-or-create the contact (match phone across trunk-prefix variants).
  const variants = phoneVariants(sanitized)
  let contactId = ''
  const { data: foundContact } = await db
    .from('contacts')
    .select('id')
    .eq('user_id', userId)
    .in('phone', variants)
    .limit(1)
    .maybeSingle()
  if (foundContact) {
    contactId = foundContact.id
  } else {
    const { data: newContact, error: contactErr } = await db
      .from('contacts')
      .insert({ user_id: userId, phone: sanitized, name: null })
      .select('id')
      .single()
    if (contactErr || !newContact) {
      return NextResponse.json(
        { error: `contact create failed: ${contactErr?.message ?? 'unknown'}` },
        { status: 500 },
      )
    }
    contactId = newContact.id
  }

  // Find-or-create the conversation for this contact.
  let conversationId = ''
  const { data: foundConv } = await db
    .from('conversations')
    .select('id')
    .eq('user_id', userId)
    .eq('contact_id', contactId)
    .order('updated_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (foundConv) {
    conversationId = foundConv.id
  } else {
    const { data: newConv, error: convErr } = await db
      .from('conversations')
      .insert({ user_id: userId, contact_id: contactId, status: 'open' })
      .select('id')
      .single()
    if (convErr || !newConv) {
      return NextResponse.json(
        { error: `conversation create failed: ${convErr?.message ?? 'unknown'}` },
        { status: 500 },
      )
    }
    conversationId = newConv.id
  }

  // TEXT — reuse the engine's sender (phone-variant retry + DB persistence).
  if (message) {
    try {
      const { whatsapp_message_id } = await engineSendText({
        userId,
        conversationId,
        contactId,
        text: message,
      })
      return NextResponse.json({
        ok: true,
        type: 'text',
        conversation_id: conversationId,
        contact_id: contactId,
        whatsapp_message_id,
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'send failed'
      return NextResponse.json({ ok: false, error: msg }, { status: 502 })
    }
  }

  // TEMPLATE — required for first-touch outside the 24h window.
  const { data: config, error: configErr } = await db
    .from('whatsapp_config')
    .select('phone_number_id, access_token')
    .eq('user_id', userId)
    .single()
  if (configErr || !config) {
    return NextResponse.json(
      { ok: false, error: 'WhatsApp not configured for this account' },
      { status: 400 },
    )
  }

  let accessToken: string
  try {
    accessToken = decrypt(config.access_token)
  } catch {
    return NextResponse.json(
      { ok: false, error: 'stored token could not be decrypted' },
      { status: 500 },
    )
  }

  let waMessageId = ''
  let lastError: unknown = null
  for (const variant of variants) {
    try {
      const result = await sendTemplateMessage({
        phoneNumberId: config.phone_number_id,
        accessToken,
        to: variant,
        templateName: template,
        language,
        params: variables,
      })
      waMessageId = result.messageId
      lastError = null
      break
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err)
      if (!isRecipientNotAllowedError(m)) {
        lastError = err
        break
      }
      lastError = err
    }
  }
  if (!waMessageId) {
    const m = lastError instanceof Error ? lastError.message : 'template send failed'
    return NextResponse.json({ ok: false, error: `Meta API error: ${m}` }, { status: 502 })
  }

  const preview = `[template] ${template}`
  await db.from('messages').insert({
    conversation_id: conversationId,
    sender_type: 'bot',
    content_type: 'template',
    content_text: preview,
    template_name: template,
    message_id: waMessageId,
    status: 'sent',
  })
  await db
    .from('conversations')
    .update({
      last_message_text: preview,
      last_message_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', conversationId)

  return NextResponse.json({
    ok: true,
    type: 'template',
    conversation_id: conversationId,
    contact_id: contactId,
    whatsapp_message_id: waMessageId,
  })
}
