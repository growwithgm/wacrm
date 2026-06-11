/**
 * COD (cash-on-delivery) confirmation engine.
 *
 * State machine (see migration 019):
 *   pending → confirmed           (customer replies SÍ/yes)
 *           → cancelled           (customer replies NO)
 *           → no_reply_cancelled  (72h of silence; Phase 2 timers)
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
import { sendTemplateMessage, sendTextMessage } from '@/lib/whatsapp/meta-api'
import { decrypt } from '@/lib/whatsapp/encryption'
import { sanitizePhoneForMeta, phonesMatch, phoneVariants, isRecipientNotAllowedError } from '@/lib/whatsapp/phone-utils'
import { resolveTemplate } from '@/lib/whatsapp/templates'
import { buildCodParams, countPlaceholders, type CodOrderFields } from './fields'

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

/** Order fields from the live RestOrder — for the initial confirmation send. */
function fieldsFromOrder(order: RestOrder, orderNumber: string, total: string): CodOrderFields {
  const itemsCount = (order.line_items ?? []).reduce(
    (sum, li) => sum + (li.quantity ?? 0),
    0,
  )
  return {
    first_name: order.customer?.first_name ?? null,
    full_name: customerName(order),
    order_number: orderNumber,
    total,
    currency: order.currency ?? null,
    items_count: itemsCount || null,
    shipping_city: order.shipping_address?.city ?? null,
  }
}

/** Order fields from a stored cod_confirmations row — reminders/thank-you/no-reply. */
function fieldsFromConf(conf: any): CodOrderFields {
  return {
    first_name: conf.customer_first_name ?? null,
    full_name: conf.customer_full_name ?? null,
    order_number: conf.order_number ?? null,
    total: conf.total ?? null,
    currency: conf.currency ?? null,
    items_count: conf.items_count ?? null,
    shipping_city: conf.shipping_city ?? null,
  }
}

/**
 * Build a template's body params from a per-slot variable map: read the body to
 * count {{n}} placeholders, then fill each from the mapped order field. A
 * 0-variable template sends no params (so Meta never rejects it for extras).
 * When the map is absent it falls back to the legacy default ({{1}} order
 * number, {{2}} total) — preserving pre-migration behavior.
 */
async function paramsForTemplate(
  db: any,
  userId: string,
  templateName: string,
  varMap: Record<string, string> | null | undefined,
  fields: CodOrderFields,
): Promise<string[]> {
  const { data: tpl } = await db
    .from('message_templates')
    .select('body_text')
    .eq('user_id', userId)
    .eq('name', templateName)
    .order('updated_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  const count = countPlaceholders(tpl?.body_text ?? '')
  return buildCodParams(varMap, fields, count)
}

/**
 * Send a free-text WhatsApp message (a 24h-window reply to SÍ/NO) and record it
 * in the conversation. Mirrors sendCodTemplate's variant retry + inbox failure
 * capture. Throws on terminal failure so the caller can log best-effort.
 */
async function sendCodText(
  db: any,
  userId: string,
  conversationId: string,
  contactId: string | null,
  phone: string,
  text: string,
): Promise<string> {
  const { data: wa } = await db
    .from('whatsapp_config')
    .select('phone_number_id, access_token')
    .eq('user_id', userId)
    .maybeSingle()
  if (!wa?.access_token) throw new Error('WhatsApp not configured')

  const accessToken = decrypt(wa.access_token)
  const sanitized = sanitizePhoneForMeta(phone)
  const variants = phoneVariants(sanitized)

  let result: { messageId: string } | null = null
  let workingPhone = sanitized
  let lastError: unknown = null

  for (const variant of variants) {
    try {
      result = await sendTextMessage({
        phoneNumberId: wa.phone_number_id,
        accessToken,
        to: variant,
        text,
      })
      workingPhone = variant
      lastError = null
      break
    } catch (err) {
      lastError = err
      const message = err instanceof Error ? err.message : String(err)
      if (!isRecipientNotAllowedError(message)) break
      console.warn(`[cod] text variant "${variant}" rejected by Meta, trying next…`)
    }
  }

  if (!result) {
    const detail = lastError instanceof Error ? lastError.message : String(lastError)
    console.error('[cod] text send failed', { phone: sanitized, detail })
    await db.from('messages').insert({
      conversation_id: conversationId,
      sender_type: 'bot',
      content_type: 'text',
      status: 'failed',
      content_text: `COD message failed to send: ${detail}`,
    })
    await db
      .from('conversations')
      .update({
        last_message_text: '[COD failed]',
        last_message_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', conversationId)
    throw lastError instanceof Error ? lastError : new Error(detail)
  }

  if (workingPhone !== sanitized && contactId) {
    await db.from('contacts').update({ phone: workingPhone }).eq('id', contactId)
  }

  await db.from('messages').insert({
    conversation_id: conversationId,
    sender_type: 'bot',
    content_type: 'text',
    content_text: text,
    message_id: result.messageId,
    status: 'sent',
  })
  await db
    .from('conversations')
    .update({
      last_message_text: text,
      last_message_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', conversationId)

  return result.messageId
}

/** Find-or-create the contact + conversation for a phone (outbound first-touch).
 *  Exported for reuse by the checkout-recovery engine — same dedupe semantics
 *  as the inbound webhook (phonesMatch + user_id/contact_id keys). */
export async function ensureContactConversation(
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

  // Resolve the EXACT name + language Meta approved, from the synced
  // message_templates — never trust the shopify_config values verbatim. Both a
  // drifted name (config `cod_confermation_1` vs approved `cod_confermation_1_`)
  // and a stale language code trigger #132001. resolveTemplate matches the
  // config name exactly, then normalized (trailing "_"/whitespace/case), so a
  // single character of drift can't break the send again.
  const resolved = await resolveTemplate(db, userId, templateName, language)
  const effectiveName = resolved.name
  const effectiveLanguage = resolved.language ?? language
  if (!resolved.matched) {
    console.warn('[cod] template not found in synced message_templates — sending config values as-is', {
      templateName,
      language,
    })
  } else if (effectiveName !== templateName || effectiveLanguage !== language) {
    console.warn('[cod] corrected template from config to synced Meta values', {
      configName: templateName,
      configLanguage: language,
      approvedName: effectiveName,
      approvedLanguage: effectiveLanguage,
    })
  }

  const sanitized = sanitizePhoneForMeta(phone)
  // Same trunk-0 resilience as /api/whatsapp/send: try the with/without
  // leading-zero variants, retrying ONLY on Meta's "recipient not in allowed
  // list" rejection. Any other error is terminal.
  const variants = phoneVariants(sanitized)
  console.log('[cod] sending template', {
    to: sanitized,
    variants,
    name: effectiveName,
    language: effectiveLanguage,
    params,
  })

  let result: { messageId: string } | null = null
  let workingPhone = sanitized
  let lastError: unknown = null

  for (const variant of variants) {
    try {
      result = await sendTemplateMessage({
        phoneNumberId: wa.phone_number_id,
        accessToken,
        to: variant,
        templateName: effectiveName,
        language: effectiveLanguage,
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
    console.error('[cod] template send failed', { phone: sanitized, name: effectiveName, language: effectiveLanguage, detail })
    await db.from('messages').insert({
      conversation_id: conversationId,
      sender_type: 'bot',
      content_type: 'template',
      template_name: effectiveName,
      status: 'failed',
      content_text: `COD ${effectiveName} failed to send: ${detail}`,
    })
    await db
      .from('conversations')
      .update({
        last_message_text: `[COD failed] ${effectiveName}`,
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
    template_name: effectiveName,
    message_id: result.messageId,
    status: 'sent',
  })
  await db
    .from('conversations')
    .update({
      last_message_text: `[COD] ${effectiveName}`,
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
    const fields = fieldsFromOrder(order, orderNumber, total)

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

    // Snapshot the mappable order fields for later sends (reminders / thank-you
    // / no-reply run from this row, with no live order). Best-effort + separate
    // so a pre-021 deploy can't break confirmation creation.
    const { error: snapErr } = await db
      .from('cod_confirmations')
      .update({
        customer_first_name: fields.first_name,
        customer_full_name: fields.full_name,
        items_count: fields.items_count,
        shipping_city: fields.shipping_city,
      })
      .eq('id', conf.id)
    if (snapErr) {
      console.warn('[cod] order-field snapshot skipped (run migration 021?):', snapErr.message)
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

    // Send the initial template (Message 1), filling variables per the
    // configured confirmation mapping.
    try {
      const params = await paramsForTemplate(
        db,
        userId,
        config.cod_template_name,
        config.cod_confirm_var_map,
        fields,
      )
      await sendCodTemplate(
        db,
        userId,
        conversationId,
        contactId,
        phone,
        config.cod_template_name,
        config.cod_template_language,
        params,
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
  args: {
    userId: string
    contactId: string | null
    text: string | null
    /** Quick-reply button payload / interactive reply id, when the customer
     *  tapped a button instead of typing. Matched as a fallback to `text`. */
    replyId?: string | null
  },
): Promise<void> {
  try {
    const { userId, contactId, text, replyId } = args
    if (!contactId) return

    // Match the typed text first, then the button payload / interactive reply
    // id — a template quick-reply "SÍ"/"NO" tap arrives with the title in
    // content_text and the payload in interactive_reply_id. matchCodReply is
    // accent/case-insensitive (SÍ/Sí/si/SI → yes).
    const match = matchCodReply(text) ?? matchCodReply(replyId ?? null)
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

      // Step 3 — optional thank-you message. Sent at most once (guarded by
      // cod_thankyou_sent_at); after it goes out the COD flow is complete —
      // status is no longer 'pending', so runCodTimers skips this row. The
      // thank-you reuses sendCodTemplate, so resolveTemplate (the name/lang
      // resolver) still applies. Best-effort: a failure is logged + surfaced
      // in the inbox by sendCodTemplate but never reverts the confirmation.
      if (
        config?.cod_thankyou_enabled &&
        config.cod_thankyou_template_name &&
        !conf.cod_thankyou_sent_at &&
        conf.conversation_id &&
        conf.phone
      ) {
        try {
          const params = await paramsForTemplate(
            db,
            userId,
            config.cod_thankyou_template_name,
            config.cod_thankyou_var_map,
            fieldsFromConf(conf),
          )
          await sendCodTemplate(
            db,
            userId,
            conf.conversation_id,
            conf.contact_id,
            conf.phone,
            config.cod_thankyou_template_name,
            config.cod_thankyou_template_language || config.cod_template_language,
            params,
          )
          await db
            .from('cod_confirmations')
            .update({ cod_thankyou_sent_at: new Date().toISOString() })
            .eq('id', conf.id)
          console.log('[cod] thank-you sent', sid)
        } catch (err) {
          console.error('[cod] thank-you send failed:', err)
        }
      }

      // Part B — optional free-text confirmation reply. Inside the 24h window,
      // so plain text is allowed (no template/approval needed). Independent of
      // the Step 3 thank-you template above.
      if (
        config?.cod_yes_message_enabled &&
        config.cod_yes_message_text &&
        conf.conversation_id &&
        conf.phone
      ) {
        try {
          await sendCodText(
            db,
            userId,
            conf.conversation_id,
            conf.contact_id,
            conf.phone,
            config.cod_yes_message_text,
          )
          console.log('[cod] yes message sent', sid)
        } catch (err) {
          console.error('[cod] yes message send failed:', err)
        }
      }
    } else {
      // NO → cancelled. Flip the pending tag to the cancel tag (manual review;
      // we never auto-cancel the Shopify order itself).
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
          status: 'cancelled',
          reply_text: text,
          replied_at: new Date().toISOString(),
        })
        .eq('id', conf.id)
      if (conf.order_id) {
        await db
          .from('shopify_orders')
          .update({ cod_status: 'cancelled' })
          .eq('id', conf.order_id)
      }

      // Send the cancel-acknowledgement template (the NO-outcome message).
      // Reuses sendCodTemplate (resolveTemplate applies). Best-effort.
      if (
        config?.cod_cancel_template_enabled &&
        config.cod_cancel_template_name &&
        conf.conversation_id &&
        conf.phone
      ) {
        try {
          const params = await paramsForTemplate(
            db,
            userId,
            config.cod_cancel_template_name,
            config.cod_cancel_var_map,
            fieldsFromConf(conf),
          )
          await sendCodTemplate(
            db,
            userId,
            conf.conversation_id,
            conf.contact_id,
            conf.phone,
            config.cod_cancel_template_name,
            config.cod_cancel_template_language || config.cod_template_language,
            params,
          )
          console.log('[cod] cancel template sent', sid)
        } catch (err) {
          console.error('[cod] cancel template send failed:', err)
        }
      }

      // Part B — optional free-text cancel reply (inside the 24h window).
      if (
        config?.cod_no_message_enabled &&
        config.cod_no_message_text &&
        conf.conversation_id &&
        conf.phone
      ) {
        try {
          await sendCodText(
            db,
            userId,
            conf.conversation_id,
            conf.contact_id,
            conf.phone,
            config.cod_no_message_text,
          )
          console.log('[cod] no message sent', sid)
        } catch (err) {
          console.error('[cod] no message send failed:', err)
        }
      }
      console.log('[cod] cancelled', sid)
    }
  } catch (err) {
    console.error('[cod] handleCodReply error:', err)
  }
}

// ─── Timers (reminders + no-reply) ──────────────────────────────────────────

async function sendReminder(db: any, config: any, conf: any): Promise<void> {
  if (!conf.conversation_id || !conf.phone) return
  // Reminders re-send the confirmation template, so they use its mapping.
  const params = await paramsForTemplate(
    db,
    conf.user_id,
    config.cod_template_name,
    config.cod_confirm_var_map,
    fieldsFromConf(conf),
  )
  await sendCodTemplate(
    db,
    conf.user_id,
    conf.conversation_id,
    conf.contact_id,
    conf.phone,
    config.cod_template_name,
    config.cod_template_language,
    params,
  )
}

/**
 * Sweep pending confirmations (the Vercel cron path). Idempotent — at most one
 * action per row per run, guarded by messages_sent (reminder) and the status
 * transition (no-reply). A row that the customer answered is no longer
 * 'pending', so it's never selected here → it can never get the no-reply cancel.
 *   - age ≥ cod_reminder1_hours (24h), reminder not yet sent → send reminder
 *     (reuses the confirmation template), stamp reminder1_sent_at. Once.
 *   - age ≥ cod_noreply_hours (72h) → send the no-reply template, flip the
 *     pending tag → no-reply tag, set status = 'no_reply_cancelled'.
 * Safe to run on a once-daily Hobby cron (actions fire at the next sweep).
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

      // Step 4 reminder controls. Default to ON / 2 when the columns are
      // absent (pre-migration), preserving the original behavior. The 72h
      // no-reply tagging below is independent of these and always runs.
      const remindersOn = config.cod_reminders_enabled !== false
      const reminderCount = config.cod_reminder_count ?? 2

      if (ageHours >= config.cod_noreply_hours) {
        try {
          const token = await getValidToken(config as ShopifyConfigRow)
          // Flip the pending tag → the no-reply (cancelled) tag.
          await removeOrderTags(config.store_domain, token, conf.shopify_order_id, [config.cod_tag_pending])
          await addOrderTags(config.store_domain, token, conf.shopify_order_id, [config.cod_tag_noreply])
        } catch (err) {
          console.error('[cod] no-reply tagging failed:', err)
        }

        // Part B — optional no-reply message. The 24h window has closed, so this
        // MUST be an approved template (free text isn't allowed here). Reuses
        // sendCodTemplate (resolveTemplate applies). Best-effort so a send
        // failure still lets the row settle to no_reply.
        if (
          config.cod_noreply_template_enabled &&
          config.cod_noreply_template_name &&
          conf.conversation_id &&
          conf.phone
        ) {
          try {
            const params = await paramsForTemplate(
              db,
              conf.user_id,
              config.cod_noreply_template_name,
              config.cod_noreply_var_map,
              fieldsFromConf(conf),
            )
            await sendCodTemplate(
              db,
              conf.user_id,
              conf.conversation_id,
              conf.contact_id,
              conf.phone,
              config.cod_noreply_template_name,
              config.cod_noreply_template_language || config.cod_template_language,
              params,
            )
            console.log('[cod] no-reply template sent', conf.shopify_order_id)
          } catch (err) {
            console.error('[cod] no-reply template send failed:', err)
          }
        }

        await db
          .from('cod_confirmations')
          .update({ status: 'no_reply_cancelled', no_reply_at: new Date().toISOString() })
          .eq('id', conf.id)
        if (conf.order_id) {
          await db.from('shopify_orders').update({ cod_status: 'no_reply_cancelled' }).eq('id', conf.order_id)
        }
        console.log('[cod] no-reply cancelled', conf.shopify_order_id)
        noReplies++
      } else if (
        remindersOn &&
        reminderCount >= 2 &&
        ageHours >= config.cod_reminder2_hours &&
        conf.messages_sent < 3
      ) {
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
      } else if (
        remindersOn &&
        reminderCount >= 1 &&
        ageHours >= config.cod_reminder1_hours &&
        conf.messages_sent < 2
      ) {
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
