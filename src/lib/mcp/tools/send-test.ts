import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { isValidE164, sanitizePhoneForMeta } from '@/lib/whatsapp/phone-utils'
import { sendTemplateMessage, sendTextMessage } from '@/lib/whatsapp/meta-api'
import { decrypt } from '@/lib/whatsapp/encryption'
import { recordToolCall } from '../audit'
import { countAuditToday, getOwnerSendConfig } from '../db'

// ===========================================================================
// send_test_message (Phase 3) — the ONLY send-capable MCP tool.
//
// HARD SAFETY INVARIANTS:
//   * Recipient is a module constant. There is NO recipient input; the schema
//     even rejects a to/phone/recipient/... key if one is supplied.
//   * The number is re-asserted against TEST_RECIPIENT immediately before the
//     Meta call — a future refactor cannot slip a different number through.
//   * Meta send functions are called DIRECTLY (no /api/outbound/send, no
//     WACRM_API_TOKEN dependency) so the `to` we pass is exactly TEST_RECIPIENT.
//   * dry_run defaults ON: builds and returns the exact payload, sends nothing.
//   * A durable daily cap (MCP_TEST_DAILY_CAP, default 20) bounds real sends,
//     counted from mcp_audit_log (survives serverless restarts).
//   * Every call is audit-logged with NO message body / phone number (only a
//     redacted descriptor hash + template name).
// ===========================================================================

/** The one and only recipient this tool will ever message. */
export const TEST_RECIPIENT = '+34632189061'

/** Keys that could select a recipient — always rejected. */
export const RECIPIENT_KEYS = [
  'to',
  'phone',
  'recipient',
  'number',
  'msisdn',
  'phone_number',
  'wa_id',
  'whatsapp',
] as const

/** Throw if any recipient-selecting key is present. */
export function assertNoRecipientKey(args: Record<string, unknown>): void {
  const found = RECIPIENT_KEYS.filter((k) => k in args && args[k] !== undefined)
  if (found.length) {
    throw new Error(
      `send_test_message does not accept a recipient — forbidden key(s): ${found.join(', ')}`,
    )
  }
}

/** Re-assert the number is exactly the test recipient. Called right before Meta. */
export function assertIsTestRecipient(number: string): void {
  if (sanitizePhoneForMeta(number) !== sanitizePhoneForMeta(TEST_RECIPIENT)) {
    throw new Error('recipient re-assertion failed: refusing to send to a non-test number')
  }
}

function dailyCap(): number {
  const n = Number.parseInt(process.env.MCP_TEST_DAILY_CAP ?? '', 10)
  return Number.isFinite(n) && n > 0 ? n : 20
}

// zod raw shape. Allowed fields only, PLUS an explicit denylist: each recipient
// key is z.never() so the SDK's validation rejects the call if one is supplied.
export const SEND_TEST_SHAPE = {
  kind: z
    .enum(['template', 'text'])
    .default('template')
    .describe('template (default; works anytime) or text (only within the 24h window)'),
  template_name: z.string().max(200).optional().describe('approved template name (required for kind=template)'),
  template_language: z.string().max(20).optional().describe('template language code, e.g. "es" or "en_US"'),
  variables: z.array(z.string()).max(20).optional().describe('template body {{n}} variables, in order'),
  text: z.string().max(1000).optional().describe('free text (required for kind=text)'),
  dry_run: z
    .boolean()
    .default(true)
    .describe('default true: preview the payload, send nothing. Set false to send ONE real message.'),
  // Denylist — this tool NEVER accepts a recipient; it only messages the owner test number.
  to: z.never().optional(),
  phone: z.never().optional(),
  recipient: z.never().optional(),
  number: z.never().optional(),
  msisdn: z.never().optional(),
  phone_number: z.never().optional(),
  wa_id: z.never().optional(),
  whatsapp: z.never().optional(),
} as const

export interface SendTestArgs {
  kind?: 'template' | 'text'
  template_name?: string
  template_language?: string
  variables?: string[]
  text?: string
  dry_run?: boolean
  [k: string]: unknown
}

export interface SendDeps {
  sendTemplate: typeof sendTemplateMessage
  sendText: typeof sendTextMessage
  getSendConfig: typeof getOwnerSendConfig
  decrypt: typeof decrypt
  countToday: typeof countAuditToday
  record: typeof recordToolCall
}

const defaultDeps: SendDeps = {
  sendTemplate: sendTemplateMessage,
  sendText: sendTextMessage,
  getSendConfig: getOwnerSendConfig,
  decrypt,
  countToday: countAuditToday,
  record: recordToolCall,
}

/** Redacted descriptor for the audit hash — NEVER the raw text/variables/phone. */
function redact(args: SendTestArgs): Record<string, unknown> {
  return {
    tool: 'send_test_message',
    kind: args.kind ?? 'template',
    template_name: args.template_name,
    template_language: args.template_language,
    dry_run: args.dry_run ?? true,
    variables_count: Array.isArray(args.variables) ? args.variables.length : 0,
    text_len: typeof args.text === 'string' ? args.text.length : 0,
  }
}

function buildTemplatePayload(name: string, language: string | undefined, variables: string[], to: string) {
  const template: Record<string, unknown> = { name, language: { code: language ?? 'en_US' } }
  if (variables.length > 0) {
    template.components = [
      { type: 'body', parameters: variables.map((v) => ({ type: 'text', text: String(v) })) },
    ]
  }
  return { messaging_product: 'whatsapp', recipient_type: 'individual', to, type: 'template', template }
}

function buildTextPayload(text: string, to: string) {
  return { messaging_product: 'whatsapp', recipient_type: 'individual', to, type: 'text', text: { body: text } }
}

export async function runSendTest(
  args: SendTestArgs,
  deps: SendDeps = defaultDeps,
): Promise<Record<string, unknown>> {
  // 1. Denylist: reject any recipient-selecting key (defence in depth; the
  //    schema rejects these too, but this runs even if called directly).
  try {
    assertNoRecipientKey(args)
  } catch (e) {
    await deps.record('send_test_message', redact(args), 'denied', { detail: 'recipient_key' })
    throw e
  }

  const kind = args.kind ?? 'template'
  const dryRun = args.dry_run ?? true
  const templateName = args.template_name?.trim()
  const templateLanguage = args.template_language
  const variables = Array.isArray(args.variables) ? args.variables : []
  const text = typeof args.text === 'string' ? args.text : ''

  // 2. Validate per kind.
  if (kind === 'template' && !templateName) {
    throw new Error('template_name is required when kind="template"')
  }
  if (kind === 'text' && !text.trim()) {
    throw new Error('text is required when kind="text"')
  }

  const to = sanitizePhoneForMeta(TEST_RECIPIENT)
  if (!isValidE164(to)) throw new Error('TEST_RECIPIENT is not a valid E.164 number')

  const payload =
    kind === 'template'
      ? buildTemplatePayload(templateName as string, templateLanguage, variables, to)
      : buildTextPayload(text, to)

  const cap = dailyCap()
  const sentToday = await deps.countToday('send_test_message', 'ok')
  const auditTarget = kind === 'template' ? `template:${templateName}` : 'text'

  // 3. Dry run (default): return the exact payload, send nothing.
  if (dryRun) {
    await deps.record('send_test_message', redact(args), 'dry_run', { target: auditTarget })
    return {
      ok: true,
      dry_run: true,
      recipient: TEST_RECIPIENT,
      sanitized_to: to,
      kind,
      would_send: payload,
      sent_today: sentToday,
      daily_cap: cap,
      remaining_today: Math.max(0, cap - sentToday),
      note: 'DRY RUN — no message was sent to Meta. Set dry_run=false to send.',
    }
  }

  // 4. Real send — durable daily cap.
  if (sentToday >= cap) {
    await deps.record('send_test_message', redact(args), 'rate_limited', { target: auditTarget })
    return { ok: false, error: 'daily_cap_reached', sent_today: sentToday, daily_cap: cap }
  }

  const config = await deps.getSendConfig()
  if (!config?.phone_number_id || !config?.access_token) {
    await deps.record('send_test_message', redact(args), 'error', { detail: 'whatsapp_not_configured' })
    return { ok: false, error: 'WhatsApp is not configured for the owner account' }
  }

  let accessToken: string
  try {
    accessToken = deps.decrypt(config.access_token)
  } catch {
    await deps.record('send_test_message', redact(args), 'error', { detail: 'token_decrypt_failed' })
    return { ok: false, error: 'stored WhatsApp token could not be decrypted' }
  }

  // 5. Re-assert the recipient IMMEDIATELY before the Meta call.
  assertIsTestRecipient(to)

  try {
    const result =
      kind === 'template'
        ? await deps.sendTemplate({
            phoneNumberId: config.phone_number_id,
            accessToken,
            to,
            templateName: templateName as string,
            language: templateLanguage,
            params: variables,
          })
        : await deps.sendText({ phoneNumberId: config.phone_number_id, accessToken, to, text })
    await deps.record('send_test_message', redact(args), 'ok', { target: auditTarget })
    return {
      ok: true,
      dry_run: false,
      recipient: TEST_RECIPIENT,
      kind,
      whatsapp_message_id: result.messageId,
      sent_today: sentToday + 1,
      daily_cap: cap,
      remaining_today: Math.max(0, cap - sentToday - 1),
    }
  } catch (e) {
    await deps.record('send_test_message', redact(args), 'error', {
      detail: e instanceof Error ? e.name : 'send_error',
    })
    return { ok: false, error: e instanceof Error ? e.message : 'send failed' }
  }
}

export function registerSendTestTool(server: McpServer): void {
  server.tool(
    'send_test_message',
    `Send a SINGLE WhatsApp test message to the account owner's OWN number (${TEST_RECIPIENT}) ONLY. ` +
      'There is no recipient parameter and no way to message anyone else. Defaults to a DRY RUN ' +
      '(builds and returns the payload, sends nothing) and to a template (works outside the 24h window). ' +
      'Set dry_run=false to actually send one message. Subject to a durable daily cap.',
    SEND_TEST_SHAPE,
    async (args): Promise<{ content: { type: 'text'; text: string }[]; isError?: boolean }> => {
      try {
        const result = await runSendTest(args as SendTestArgs)
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          ...(result.ok === false ? { isError: true } : {}),
        }
      } catch (e) {
        const message = e instanceof Error ? e.message : 'send_test_message failed'
        return { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: message }) }], isError: true }
      }
    },
  )
}
