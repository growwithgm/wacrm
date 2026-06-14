/**
 * Abandoned-checkout recovery via WhatsApp.
 *
 * One tracking row per checkout (checkout_recoveries, UNIQUE per
 * user+checkout). The webhook creates the row when a checkout arrives
 * live; the cron sweep (runRecoveryTimers — same scheduler the COD flow
 * uses) sends up to 3 reminder templates at configurable delays, then
 * stops. Mandatory guards:
 *
 *   1. ORDER-COMPLETE — the sweep re-reads the checkout row before every
 *      send; Shopify's checkouts/update sets completed_at when the
 *      checkout converts, which flips the sequence to 'completed_order'.
 *   2. PHONE — checkouts without a usable phone are marked
 *      'skipped_no_phone' and never enter the sweep.
 *   3. DEDUPE / ANTI-SPAM — one sequence per checkout (DB unique), and a
 *      new sequence is suppressed when the same phone already received a
 *      recovery within recovery_cooldown_days.
 *
 * Everything is scoped to user_id; rows are only created from the live
 * webhook path (never from backfill/cron sync), mirroring the COD flow.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { resolveCheckoutPhone, type RestCheckout } from '@/lib/shopify/transform'
import { sendTemplateMessage } from '@/lib/whatsapp/meta-api'
import { decrypt } from '@/lib/whatsapp/encryption'
import {
  sanitizePhoneForMeta,
  phonesMatch,
  phoneVariants,
  isRecipientNotAllowedError,
} from '@/lib/whatsapp/phone-utils'
import { resolveTemplate } from '@/lib/whatsapp/templates'
import { countPlaceholders } from '@/lib/cod/fields'
import { ensureContactConversation } from '@/lib/cod/engine'

// Fallback delays (minutes) when the config columns are absent
// (pre-migration). The real values live on shopify_config and are
// editable without a code change.
const DEFAULT_DELAY1_MIN = 45
const DEFAULT_DELAY2_MIN = 24 * 60
const DEFAULT_DELAY3_MIN = 48 * 60
const DEFAULT_COOLDOWN_DAYS = 7

// Opt-out keywords used when shopify_config.recovery_stop_keywords is
// absent/empty (pre-migration or never configured). The merchant edits
// the real list in the Recovery settings UI.
const DEFAULT_STOP_KEYWORDS = ['stop', 'baja', 'parar', 'unsubscribe']

/** Lowercase, strip accents, collapse whitespace — for keyword matching. */
function normalizeForMatch(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * True when the inbound text contains any opt-out keyword. Single-word
 * keywords match on a whole-word boundary ("stop", "STOP please" → yes;
 * "stopwatch" → no); multi-word keywords ("no molestar") match as a
 * normalized substring. Accent- and case-insensitive.
 */
export function matchesStopKeyword(
  text: string | null | undefined,
  keywords: string[] | null | undefined,
): boolean {
  if (!text) return false
  const list = (keywords && keywords.length > 0 ? keywords : DEFAULT_STOP_KEYWORDS)
    .map(normalizeForMatch)
    .filter(Boolean)
  if (list.length === 0) return false
  const haystack = normalizeForMatch(text)
  if (!haystack) return false
  for (const kw of list) {
    if (kw.includes(' ')) {
      if (haystack.includes(kw)) return true
    } else {
      // Whole-word match so "baja" doesn't fire on "trabajar".
      const re = new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegExp(kw)}([^\\p{L}\\p{N}]|$)`, 'u')
      if (re.test(haystack)) return true
    }
  }
  return false
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** First word of the customer name, with a locale-aware fallback. */
function firstNameOf(name: string | null | undefined, isSpanish: boolean): string {
  const first = (name ?? '').trim().split(/\s+/)[0]
  return first || (isSpanish ? 'cliente' : 'there')
}

/** "45.00 EUR" → "45,00 €" / "$45.00" depending on locale+currency. */
function formatTotal(
  total: number | null | undefined,
  currency: string | null | undefined,
  isSpanish: boolean,
): string {
  if (total == null) return ''
  const cur = currency || 'EUR'
  try {
    return new Intl.NumberFormat(isSpanish ? 'es-ES' : 'en-US', {
      style: 'currency',
      currency: cur,
    }).format(total)
  } catch {
    return `${total.toFixed(2)} ${cur}`
  }
}

/**
 * Meta dynamic URL buttons only accept a SUFFIX — the template is created
 * with a fixed prefix like "https://store.com/{{1}}". We therefore pass
 * the path+query of Shopify's abandoned_checkout_url (never construct our
 * own link). The template's button prefix must be the storefront domain.
 */
function urlButtonSuffix(abandonedUrl: string | null | undefined): string | null {
  if (!abandonedUrl) return null
  try {
    const u = new URL(abandonedUrl)
    return `${u.pathname.replace(/^\//, '')}${u.search}`
  } catch {
    return null
  }
}

function isSpanishLocale(locale: string | null | undefined): boolean {
  return (locale ?? '').trim().toLowerCase().startsWith('es')
}

// ─── Webhook entry point: create/refresh the tracking row ───────────────────

/**
 * Called from the Shopify webhook (checkouts/create | checkouts/update),
 * AFTER upsertCheckout has persisted the row. Live-webhook path only —
 * backfill sync never starts a sequence. Idempotent: at most one
 * checkout_recoveries row per checkout ever exists.
 */
export async function ensureCheckoutRecovery(
  db: any,
  userId: string,
  checkout: RestCheckout,
): Promise<void> {
  try {
    const { data: config } = await db
      .from('shopify_config')
      .select('*')
      .eq('user_id', userId)
      .maybeSingle()
    if (!config?.recovery_enabled) return

    const shopifyCheckoutId = String(checkout.id)

    const { data: row } = await db
      .from('shopify_checkouts')
      .select('id, customer_phone, completed_at, recovered')
      .eq('user_id', userId)
      .eq('shopify_checkout_id', shopifyCheckoutId)
      .maybeSingle()
    if (!row) return

    const { data: existing } = await db
      .from('checkout_recoveries')
      .select('id, status, phone')
      .eq('user_id', userId)
      .eq('shopify_checkout_id', shopifyCheckoutId)
      .maybeSingle()

    // GUARD 1 (order complete) at intake: a checkouts/update that carries
    // completed_at stops an active sequence immediately.
    if (row.completed_at || row.recovered) {
      if (existing && existing.status === 'active') {
        await db
          .from('checkout_recoveries')
          .update({ status: 'completed_order' })
          .eq('id', existing.id)
        console.log('[recovery] checkout completed — sequence stopped', shopifyCheckoutId)
      }
      return
    }

    const phone = row.customer_phone ?? resolveCheckoutPhone(checkout)

    if (existing) {
      // checkouts/update often arrives as the customer fills in their
      // details — if we skipped for a missing phone and one is now
      // present, activate the sequence (timer anchor stays at the
      // original created_at).
      if (existing.status === 'skipped_no_phone' && phone) {
        await db
          .from('checkout_recoveries')
          .update({ status: 'active', phone })
          .eq('id', existing.id)
        console.log('[recovery] phone arrived — sequence activated', shopifyCheckoutId)
      }
      return // GUARD 3: one sequence per checkout, never restarted
    }

    // GUARD 2: no usable phone → record as skipped (visible, never swept).
    if (!phone) {
      await db.from('checkout_recoveries').insert({
        user_id: userId,
        checkout_id: row.id,
        shopify_checkout_id: shopifyCheckoutId,
        status: 'skipped_no_phone',
      })
      return
    }

    // GUARD 3 (anti-spam cooldown): if this phone already received at
    // least one recovery reminder within the cooldown window, suppress.
    const cooldownDays = config.recovery_cooldown_days ?? DEFAULT_COOLDOWN_DAYS
    const since = new Date(Date.now() - cooldownDays * 24 * 60 * 60 * 1000).toISOString()
    const { data: recent } = await db
      .from('checkout_recoveries')
      .select('phone, reminders_sent')
      .eq('user_id', userId)
      .gte('created_at', since)
      .gte('reminders_sent', 1)
    const inCooldown = (recent ?? []).some(
      (r: { phone: string | null }) => !!r.phone && phonesMatch(r.phone, phone),
    )

    await db.from('checkout_recoveries').insert({
      user_id: userId,
      checkout_id: row.id,
      shopify_checkout_id: shopifyCheckoutId,
      phone,
      status: inCooldown ? 'suppressed_cooldown' : 'active',
    })
    console.log(
      inCooldown
        ? '[recovery] sequence suppressed (cooldown)'
        : '[recovery] sequence started',
      shopifyCheckoutId,
    )
  } catch (err) {
    // Best-effort: a recovery bookkeeping failure must never break the
    // webhook's checkout upsert.
    console.error('[recovery] ensureCheckoutRecovery failed:', err)
  }
}

// ─── Template send (URL button variant of the COD sender) ────────────────────

/**
 * Send one recovery template and record it in the conversation. Mirrors
 * sendCodTemplate (resolveTemplate + trunk-0 variant retry + inbox
 * failure capture) plus the dynamic URL button. Throws on terminal
 * failure so the sweep can record last_error.
 */
async function sendRecoveryTemplate(
  db: any,
  userId: string,
  conversationId: string,
  contactId: string | null,
  phone: string,
  templateName: string,
  language: string,
  params: string[],
  urlSuffix: string | null,
  renderedBody: string,
): Promise<string> {
  const { data: wa } = await db
    .from('whatsapp_config')
    .select('phone_number_id, access_token')
    .eq('user_id', userId)
    .maybeSingle()
  if (!wa?.access_token) throw new Error('WhatsApp not configured')

  const accessToken = decrypt(wa.access_token)

  const resolved = await resolveTemplate(db, userId, templateName, language)
  const effectiveName = resolved.name
  const effectiveLanguage = resolved.language ?? language

  const sanitized = sanitizePhoneForMeta(phone)
  const variants = phoneVariants(sanitized)

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
        urlButtonParam: urlSuffix ?? undefined,
      })
      workingPhone = variant
      lastError = null
      break
    } catch (err) {
      lastError = err
      const message = err instanceof Error ? err.message : String(err)
      if (!isRecipientNotAllowedError(message)) break
      console.warn(`[recovery] variant "${variant}" rejected by Meta, trying next…`)
    }
  }

  if (!result) {
    const detail = lastError instanceof Error ? lastError.message : String(lastError)
    console.error('[recovery] template send failed', {
      phone: sanitized,
      name: effectiveName,
      detail,
    })
    await db.from('messages').insert({
      conversation_id: conversationId,
      sender_type: 'bot',
      content_type: 'template',
      template_name: effectiveName,
      status: 'failed',
      content_text: `Recovery ${effectiveName} failed to send: ${detail}`,
    })
    await db
      .from('conversations')
      .update({
        last_message_text: `[Recovery failed] ${effectiveName}`,
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
    content_type: 'template',
    template_name: effectiveName,
    content_text: renderedBody || null,
    message_id: result.messageId,
    status: 'sent',
  })
  await db
    .from('conversations')
    .update({
      last_message_text: renderedBody || `[Recovery] ${effectiveName}`,
      last_message_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', conversationId)

  return result.messageId
}

// ─── Cron sweep ──────────────────────────────────────────────────────────────

/**
 * Process active recovery sequences. Runs on the SAME cron as the COD
 * timers (/api/cod/cron and /api/shopify/cron/sync). Idempotent: each
 * reminder stage fires once (reminders_sent gate), and a row whose
 * checkout completed is stopped before any send. Delays are read from
 * shopify_config per tenant; age is measured from the recovery row's
 * created_at (back-date it to test, exactly like cod_confirmations).
 */
export async function runRecoveryTimers(db: any): Promise<{
  processed: number
  sent: number
  stopped: number
}> {
  const now = Date.now()
  const { data: rows } = await db
    .from('checkout_recoveries')
    .select('*')
    .eq('status', 'active')
    .order('created_at', { ascending: true })
    .limit(500)

  const configCache = new Map<string, any>()
  async function cfg(userId: string) {
    if (configCache.has(userId)) return configCache.get(userId)
    const { data } = await db
      .from('shopify_config')
      .select('*')
      .eq('user_id', userId)
      .maybeSingle()
    configCache.set(userId, data)
    return data
  }

  let sent = 0
  let stopped = 0

  for (const rec of (rows ?? []) as any[]) {
    try {
      const config = await cfg(rec.user_id)
      if (!config?.recovery_enabled) continue

      // GUARD 1 (order complete): re-read the checkout RIGHT BEFORE any
      // send decision. checkouts/update sets completed_at/recovered when
      // the checkout converts to an order — a paying customer must never
      // get a "you left items" message.
      const { data: checkout } = await db
        .from('shopify_checkouts')
        .select('*')
        .eq('id', rec.checkout_id)
        .maybeSingle()
      if (!checkout) continue
      if (checkout.completed_at || checkout.recovered) {
        await db
          .from('checkout_recoveries')
          .update({ status: 'completed_order' })
          .eq('id', rec.id)
        stopped++
        continue
      }

      // GUARD 2 (defensive re-check): phone vanished → skip out.
      const phone = rec.phone ?? checkout.customer_phone
      if (!phone) {
        await db
          .from('checkout_recoveries')
          .update({ status: 'skipped_no_phone' })
          .eq('id', rec.id)
        continue
      }

      const ageMinutes = (now - new Date(rec.created_at).getTime()) / 60_000
      const d1 = config.recovery_delay1_minutes ?? DEFAULT_DELAY1_MIN
      const d2 = config.recovery_delay2_minutes ?? DEFAULT_DELAY2_MIN
      const d3 = config.recovery_delay3_minutes ?? DEFAULT_DELAY3_MIN

      // Highest due stage first, one send per sweep per row — the same
      // ladder pattern as the COD timers. reminders_sent jumps straight
      // to the fired stage, so a long-overdue row sends ONE reminder
      // (the latest due) instead of a burst, and a double cron run is a
      // no-op.
      let stage: 1 | 2 | 3 | null = null
      if (ageMinutes >= d3 && rec.reminders_sent < 3) stage = 3
      else if (ageMinutes >= d2 && rec.reminders_sent < 2) stage = 2
      else if (ageMinutes >= d1 && rec.reminders_sent < 1) stage = 1
      if (stage === null) continue

      // Template selection by checkout language — never hardcoded.
      const spanish = isSpanishLocale(checkout.customer_locale)
      let templateName: string | null = spanish
        ? config.recovery_template_name_es
        : config.recovery_template_name_en
      let templateLang: string = spanish
        ? config.recovery_template_lang_es || 'es'
        : config.recovery_template_lang_en || 'en_US'
      // Fall back to whichever single template IS configured rather than
      // silently stalling (e.g. only Spanish exists today).
      if (!templateName) {
        templateName = spanish
          ? config.recovery_template_name_en
          : config.recovery_template_name_es
        templateLang = spanish
          ? config.recovery_template_lang_en || 'en_US'
          : config.recovery_template_lang_es || 'es'
      }
      if (!templateName) {
        await db
          .from('checkout_recoveries')
          .update({ last_error: 'no recovery template configured' })
          .eq('id', rec.id)
        continue
      }

      // {{1}} first name, {{2}} cart total with currency. Sliced to the
      // template's actual placeholder count so Meta never rejects for
      // extra params.
      const fullParams = [
        firstNameOf(checkout.customer_name, spanish),
        formatTotal(checkout.total_price, checkout.currency, spanish),
      ]
      const { data: tpl } = await db
        .from('message_templates')
        .select('body_text')
        .eq('user_id', rec.user_id)
        .eq('name', templateName)
        .order('updated_at', { ascending: false })
        .limit(1)
        .maybeSingle()
      const placeholderCount = countPlaceholders(tpl?.body_text ?? '')
      const params = fullParams.slice(0, placeholderCount)
      const renderedBody = (tpl?.body_text ?? '').replace(
        /\{\{(\d+)\}\}/g,
        (_: string, raw: string) => params[Number(raw) - 1] ?? `{{${raw}}}`,
      )

      const suffix = urlButtonSuffix(checkout.abandoned_checkout_url)

      const { contactId, conversationId } = await ensureContactConversation(
        db,
        rec.user_id,
        phone,
        checkout.customer_name ?? null,
      )

      await sendRecoveryTemplate(
        db,
        rec.user_id,
        conversationId,
        contactId,
        phone,
        templateName,
        templateLang,
        params,
        suffix,
        renderedBody,
      )

      const nowIso = new Date().toISOString()
      await db
        .from('checkout_recoveries')
        .update({
          reminders_sent: stage,
          [`reminder${stage}_sent_at`]: nowIso,
          contact_id: contactId,
          conversation_id: conversationId,
          phone,
          last_error: null,
          // After the final reminder the sequence is finished.
          ...(stage === 3 ? { status: 'done' } : {}),
        })
        .eq('id', rec.id)
      console.log(`[recovery] reminder ${stage} sent`, rec.shopify_checkout_id)
      sent++
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err)
      console.error('[recovery] sweep row failed', rec.id, detail)
      await db
        .from('checkout_recoveries')
        .update({ last_error: detail })
        .eq('id', rec.id)
    }
  }

  return { processed: rows?.length ?? 0, sent, stopped }
}

// ─── Customer STOP / opt-out ────────────────────────────────────────────────

/**
 * Stop a contact's ACTIVE recovery sequence(s) when they reply with a
 * configured opt-out keyword.
 *
 * Called from the inbound webhook ALONGSIDE handleCodReply — it never
 * touches COD's SÍ/NO handling. Scope is deliberately narrow:
 *   - only flips checkout_recoveries rows that are still 'active' to
 *     'opted_out' (no further reminders for those checkouts);
 *   - does NOT set any permanent/global block — a future new checkout
 *     starts a fresh sequence normally;
 *   - does NOT touch COD, orders, tags, or the conversation.
 *
 * Idempotent: an already-stopped sequence is not 'active', so a second
 * STOP reply updates nothing. Best-effort — failures are logged only.
 */
export async function handleRecoveryOptOut(
  db: any,
  args: {
    userId: string
    contactId: string | null
    text: string | null
  },
): Promise<{ optedOut: number }> {
  try {
    const { userId, contactId, text } = args
    if (!contactId || !text) return { optedOut: 0 }

    // The contact can only reply to a recovery message we already sent,
    // and that send stamps contact_id on the row — so an active sequence
    // for this contact is the right and reliable match. Read keywords
    // from the tenant's config (falls back to defaults when unset).
    const { data: config } = await db
      .from('shopify_config')
      .select('recovery_stop_keywords')
      .eq('user_id', userId)
      .maybeSingle()

    if (!matchesStopKeyword(text, config?.recovery_stop_keywords)) {
      return { optedOut: 0 } // unrelated reply — leave everything as-is
    }

    // Stop every still-active sequence for this contact. A STOP reply
    // means "stop messaging me about carts", so we don't single out one
    // checkout. Only 'active' rows are touched (idempotent).
    const { data: stopped } = await db
      .from('checkout_recoveries')
      .update({ status: 'opted_out', last_error: null })
      .eq('user_id', userId)
      .eq('contact_id', contactId)
      .eq('status', 'active')
      .select('id')

    const count = stopped?.length ?? 0
    if (count > 0) {
      console.log('[recovery] opt-out — stopped active sequences', { contactId, count })
    }
    return { optedOut: count }
  } catch (err) {
    console.error('[recovery] handleRecoveryOptOut failed:', err)
    return { optedOut: 0 }
  }
}
