/**
 * COD (cash-on-delivery) confirmation engine.
 *
 * State machine (see migration 019):
 *   pending → confirmed         (customer replies SÍ/yes)
 *           → cancel_requested  (customer replies NO)
 *           → no_reply          (72h of silence; tag only, never auto-cancel)
 *
 * Triggered ONLY from the live orders/create webhook — startCodConfirmation
 * is never called from a backfill/scheduled sync, so backfilled orders can
 * never enter the flow. All writes use the service-role client (typed `any`,
 * like the other server-side Shopify/WhatsApp code).
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { getValidToken, type ShopifyConfigRow } from '@/lib/shopify/client'
import { addOrderTags, removeOrderTags } from '@/lib/shopify/tags'
import { resolveOrderPhone, type RestOrder } from '@/lib/shopify/transform'
import { sendTemplateMessage } from '@/lib/whatsapp/meta-api'
import { decrypt } from '@/lib/whatsapp/encryption'
import { sanitizePhoneForMeta, phonesMatch, phoneVariants, isRecipientNotAllowedError } from '@/lib/whatsapp/phone-utils'

// ─── COD order detection ────────────────────────────────────────────────────

/**
 * True for an unpaid cash-on-delivery order — the trigger condition. Matches
 * a COD gateway (incl. Spanish "contra reembolso") OR a `pending` financial
 * status, and excludes anything already paid/refunded.
 */
export function isCodPendingOrder(order: RestOrder): boolean {
  const fin = (order.financial_status ?? '').toLowerCase()
  if (['paid', 'refunded', 'partially_refunded', 'voided'].includes(fin)) return false

  const gateways = [...(order.payment_gateway_names ?? []), order.gateway ?? '']
    .join(' ')
    .toLowerCase()
  const isCodGateway = /cash on delivery|\bcod\b|contra\s?reembolso|contrareembolso/.test(gateways)

  return isCodGateway || fin === 'pending'
}

// ─── Reply matching ─────────────────────────────────────────────────────────

/** Classify a customer reply (text or button title) as yes / no / unknown. */
export function matchCodReply(raw: string | null | undefined): 'yes' | 'no' | null {
  if (!raw) return null
  // Lower-case + strip accents so "Sí" → "si".
  const t = raw.trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  if (/^(si|yes|confirmar|confirmo|confirm|ok|vale|acepto)\b/.test(t)) return 'yes'
  if (/^(no|cancelar|cancel|anular)\b/.test(t)) return 'no'
  return null
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function customerName(order: RestOrder): string | null {
  const fromCustomer = [order.customer?.first_name, order.customer?.last_name]
    .filter(Boolean)
    .join(' ')
    .trim()
  return fromCustomer || order.shipping_address?.name || null
}

/** Find-or-create the contact + conversation for a phone (outbound first-touch). */
async function ensureContactConversation(
  db: any,
  userId: string,
  phone: string,
  name: string | null,
): Promise<{ contactId: string; conversationId: string }> {
  const { data: contacts } = await db
    .from('contacts')
    .select('id, phone')
    .eq('user_id', userId)
  let contact = (contacts ?? []).find(
    (c: { phone: string | null }) => !!c.phone && phonesMatch(c.phone, phone),
  )
  if (!contact) {
    const { data: created } = await db
      .from('contacts')
      .insert({ user_id: userId, phone, name: name || phone })
      .select('id')
      .single()
    contact = created
  }

  const { data: conv } = await db
    .from('conversations')
    .select('id')
    .eq('user_id', userId)
    .eq('contact_id', contact.id)
    .maybeSingle()
  let conversationId = conv?.id
  if (!conversationId) {
    const { data: createdConv } = await db
      .from('conversations')
      .insert({ user_id: userId, contact_id: contact.id })
      .select('id')
      .single()
    conversationId = createdConv?.id
  }

  return { contactId: contact.id, conversationId }
}

/** Send a COD template and record it in the conversation. Throws on send failure. */
async function sendCodTemplate(
  db: any,
  userId: string,
  conversationId: string,
  contactId: string | null,
  phone: string,
  templateName: string,
  language: string,
  params: string[],
): Promise<string> {
  const { data: wa } = await db
    .from('whatsapp_config')
    .select('phone_number_id, access_token')
    .eq('user_id', userId)
    .maybeSingle()
  if (!wa?.access_token) throw new Error('WhatsApp not configured')

  const accessToken = decrypt(wa.access_token)
  const sanitized = sanitizePhoneForMeta(phone)
  // Same trunk-0 resilience as /api/whatsapp/send: try the with/without
  // leading-zero variants, retrying ONLY on Meta's "recipient not in allowed
  // list" rejection. Any other error is terminal.
  const variants = phoneVariants(sanitized)
  console.log('[cod] sending template', { to: sanitized, variants, templateName, language, params })

  let result: { messageId: string } | null = null
  let workingPhone = sanitized
  let lastError: unknown = null

  for (const variant of variants) {
    try {
      result = await sendTemplateMessage({
        phoneNumberId: wa.phone_number_id,
        accessToken,
        to: variant,
        templateName,
        language,
        params,
      })
      workingPhone = variant
      lastError = null
      break
    } catch (err) {
      lastError = err
      const message = err instanceof Error ? err.message : String(err)
      if (!isRecipientNotAllowedError(message)) break
      console.warn(`[cod] variant "${variant}" rejected by Meta, trying next…`)
    }
  }

  if (!result) {
    // Every variant failed (or a terminal error). Surface it in the inbox with
    // Meta's exact error instead of leaving an empty conversation, then re-throw.
    const detail = lastError instanceof Error ? lastError.message : String(lastError)
    console.error('[cod] template send failed', { phone: sanitized, templateName, language, detail })
    await db.from('messages').insert({
      conversation_id: conversationId,
      sender_type: 'bot',
      content_type: 'template',
      template_name: templateName,
      status: 'failed',
      content_text: `COD ${templateName} failed to send: ${detail}`,
    })
    await db
      .from('conversations')
      .update({
        last_message_text: `[COD failed] ${templateName}`,
        last_message_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', conversationId)
    throw lastError instanceof Error ? lastError : new Error(detail)
  }

  // A non-original variant worked — persist it so future sends (reminders,
  // and other flows) go straight through on the first attempt.
  if (workingPhone !== sanitized && contactId) {
    await db.from('contacts').update({ phone: workingPhone }).eq('id', contactId)
    console.log('[cod] auto-corrected contact phone', { from: sanitized, to: workingPhone })
  }

  await db.from('messages').insert({
    conversation_id: conversationId,
    sender_type: 'bot',
    content_type: 'template',
    template_name: templateName,
    message_id: result.messageId,
    status: 'sent',
  })
  await db
    .from('conversations')
    .update({
      last_message_text: `[COD] ${templateName}`,
      last_message_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', conversationId)

  return result.messageId
}

// ─── Trigger: start a confirmation ──────────────────────────────────────────

/**
 * Begin a COD confirmation for a webhook-arrived order: create the state row,
 * tag the order "COD Pending Confirmation", set cod_status=pending, and send
 * the initial template. Idempotent (one per order). Best-effort throughout —
 * a tag/send failure is logged but never throws back into the webhook.
 */
export async function startCodConfirmation(
  db: any,
  userId: string,
  storeDomain: string | null,
  order: RestOrder,
  orderRowId: string | null,
): Promise<void> {
  try {
    const shopifyOrderId = String(order.id)

    // Idempotency: skip if already started (handles orders/create + /updated,
    // and Shopify webhook retries).
    const { data: existing } = await db
      .from('cod_confirmations')
      .select('id')
      .eq('user_id', userId)
      .eq('shopify_order_id', shopifyOrderId)
      .maybeSingle()
    if (existing) return

    const { data: config } = await db
      .from('shopify_config')
      .select('*')
      .eq('user_id', userId)
      .maybeSingle()
    if (!config || !config.cod_enabled) return

    const phone = resolveOrderPhone(order)
    if (!phone) {
      console.warn('[cod] no phone on order — skipping', shopifyOrderId)
      return
    }

    const orderNumber =
      order.name ?? (order.order_number != null ? `#${order.order_number}` : `#${shopifyOrderId}`)
    const total = order.total_price != null ? String(order.total_price) : ''
    const currency = order.currency ?? null

    const { contactId, conversationId } = await ensureContactConversation(
      db,
      userId,
      phone,
      customerName(order),
    )

    const { data: conf, error: insErr } = await db
      .from('cod_confirmations')
      .insert({
        user_id: userId,
        order_id: orderRowId,
        shopify_order_id: shopifyOrderId,
        store_domain: storeDomain,
        contact_id: contactId,
        conversation_id: conversationId,
        phone,
        order_number: orderNumber,
        total,
        currency,
        status: 'pending',
        messages_sent: 0,
      })
      .select('id')
      .single()
    if (insErr) {
      // Unique violation = a concurrent webhook already started it. Fine.
      console.warn('[cod] confirmation insert skipped:', insErr.message)
      return
    }

    if (orderRowId) {
      await db
        .from('shopify_orders')
        .update({ cod_status: 'pending', updated_at: new Date().toISOString() })
        .eq('id', orderRowId)
    }

    // Tag "COD Pending Confirmation" (needs write_orders scope).
    try {
      const token = await getValidToken(config as ShopifyConfigRow)
      await addOrderTags(config.store_domain, token, shopifyOrderId, [config.cod_tag_pending])
    } catch (err) {
      console.error('[cod] tag pending failed:', err)
    }

    // Send the initial template (Message 1).
    try {
      await sendCodTemplate(
        db,
        userId,
        conversationId,
        contactId,
        phone,
        config.cod_template_name,
        config.cod_template_language,
        [orderNumber, total],
      )
      await db
        .from('cod_confirmations')
        .update({ messages_sent: 1, last_message_at: new Date().toISOString() })
        .eq('id', conf.id)
    } catch (err) {
      console.error('[cod] initial template send failed:', err)
    }

    console.log('[cod] started confirmation', { shopifyOrderId, phone, orderNumber })
  } catch (err) {
    console.error('[cod] startCodConfirmation error:', err)
  }
}

// ─── Reply handling (from the WhatsApp inbound webhook) ──────────────────────

/**
 * Process an inbound message as a potential COD reply. No-op unless the
 * contact has an active (pending) confirmation AND the text matches SÍ/NO.
 */
export async function handleCodReply(
  db: any,
  args: { userId: string; contactId: string | null; text: string | null },
): Promise<void> {
  try {
    const { userId, contactId, text } = args
    if (!contactId) return

    const match = matchCodReply(text)
    if (!match) return // unrelated reply — leave pending, reminders continue

    const { data: conf } = await db
      .from('cod_confirmations')
      .select('*')
      .eq('user_id', userId)
      .eq('contact_id', contactId)
      .eq('status', 'pending')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (!conf) return

    const { data: config } = await db
      .from('shopify_config')
      .select('*')
      .eq('user_id', userId)
      .maybeSingle()

    let token: string | null = null
    if (config) {
      try {
        token = await getValidToken(config as ShopifyConfigRow)
      } catch (err) {
        console.error('[cod] token for reply tagging failed:', err)
      }
    }
    const sid = conf.shopify_order_id

    if (match === 'yes') {
      if (token && config) {
        try {
          await removeOrderTags(config.store_domain, token, sid, [config.cod_tag_pending])
          await addOrderTags(config.store_domain, token, sid, [config.cod_tag_confirmed])
        } catch (err) {
          console.error('[cod] confirm tagging failed:', err)
        }
      }
      await db
        .from('cod_confirmations')
        .update({ status: 'confirmed', reply_text: text, replied_at: new Date().toISOString() })
        .eq('id', conf.id)
      if (conf.order_id) {
        await db.from('shopify_orders').update({ cod_status: 'confirmed' }).eq('id', conf.order_id)
      }
      console.log('[cod] confirmed', sid)
    } else {
      // NO → cancel requested. Remove pending + add cancel tag (manual review;
      // we never auto-cancel in Shopify).
      if (token && config) {
        try {
          await removeOrderTags(config.store_domain, token, sid, [config.cod_tag_pending])
          await addOrderTags(config.store_domain, token, sid, [config.cod_tag_cancel])
        } catch (err) {
          console.error('[cod] cancel tagging failed:', err)
        }
      }
      await db
        .from('cod_confirmations')
        .update({
          status: 'cancel_requested',
          reply_text: text,
          replied_at: new Date().toISOString(),
        })
        .eq('id', conf.id)
      if (conf.order_id) {
        await db
          .from('shopify_orders')
          .update({ cod_status: 'cancel_requested' })
          .eq('id', conf.order_id)
      }
      console.log('[cod] cancel requested', sid)
    }
  } catch (err) {
    console.error('[cod] handleCodReply error:', err)
  }
}

// ─── Timers (reminders + no-reply) ──────────────────────────────────────────

async function sendReminder(db: any, config: any, conf: any): Promise<void> {
  if (!conf.conversation_id || !conf.phone) return
  await sendCodTemplate(
    db,
    conf.user_id,
    conf.conversation_id,
    conf.contact_id,
    conf.phone,
    config.cod_template_name,
    config.cod_template_language,
    [conf.order_number ?? '', conf.total ?? ''],
  )
}

/**
 * Sweep pending confirmations: send reminder 2 at 24h, reminder 3 at 48h, and
 * tag "COD No Reply" at 72h (no auto-cancel). At most one action per row per
 * run; the messages_sent counter makes it safe to run as often as you like.
 */
export async function runCodTimers(db: any): Promise<{
  processed: number
  reminders: number
  noReplies: number
}> {
  const now = Date.now()
  const { data: pendings } = await db
    .from('cod_confirmations')
    .select('*')
    .eq('status', 'pending')
    .order('created_at', { ascending: true })
    .limit(500)

  const configCache = new Map<string, any>()
  async function cfg(userId: string) {
    if (configCache.has(userId)) return configCache.get(userId)
    const { data } = await db.from('shopify_config').select('*').eq('user_id', userId).maybeSingle()
    configCache.set(userId, data)
    return data
  }

  let reminders = 0
  let noReplies = 0

  for (const conf of (pendings ?? []) as any[]) {
    try {
      const config = await cfg(conf.user_id)
      if (!config) continue
      const ageHours = (now - new Date(conf.created_at).getTime()) / 3_600_000

      if (ageHours >= config.cod_noreply_hours) {
        try {
          const token = await getValidToken(config as ShopifyConfigRow)
          await addOrderTags(config.store_domain, token, conf.shopify_order_id, [config.cod_tag_noreply])
        } catch (err) {
          console.error('[cod] no-reply tagging failed:', err)
        }
        await db
          .from('cod_confirmations')
          .update({ status: 'no_reply', no_reply_at: new Date().toISOString() })
          .eq('id', conf.id)
        if (conf.order_id) {
          await db.from('shopify_orders').update({ cod_status: 'no_reply' }).eq('id', conf.order_id)
        }
        noReplies++
      } else if (ageHours >= config.cod_reminder2_hours && conf.messages_sent < 3) {
        await sendReminder(db, config, conf)
        await db
          .from('cod_confirmations')
          .update({
            messages_sent: 3,
            reminder2_sent_at: new Date().toISOString(),
            last_message_at: new Date().toISOString(),
          })
          .eq('id', conf.id)
        reminders++
      } else if (ageHours >= config.cod_reminder1_hours && conf.messages_sent < 2) {
        await sendReminder(db, config, conf)
        await db
          .from('cod_confirmations')
          .update({
            messages_sent: 2,
            reminder1_sent_at: new Date().toISOString(),
            last_message_at: new Date().toISOString(),
          })
          .eq('id', conf.id)
        reminders++
      }
    } catch (err) {
      console.error('[cod] timer row failed', conf.id, err)
    }
  }

  return { processed: pendings?.length ?? 0, reminders, noReplies }
}
