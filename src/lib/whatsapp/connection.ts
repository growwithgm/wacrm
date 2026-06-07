/**
 * WhatsApp connection status — the single source of truth.
 *
 * A token can READ a phone number (passes verifyPhoneNumber) yet still be unable
 * to SEND, which surfaces only at send time as Meta #200. So we evaluate the
 * real send capability from debug_token:
 *   connected      — token valid AND whatsapp_business_messaging granted for the WABA
 *   cannot_send    — token valid but missing that messaging permission (sends #200)
 *   not_connected  — token invalid / revoked / expired
 */

import { debugToken, type MetaDebugTokenData } from './meta-api'

export type WaConnectionState = 'connected' | 'cannot_send' | 'not_connected'

export interface WaConnectionResult {
  state: WaConnectionState
  tokenValid: boolean
  detail: string
  scopes: string[]
}

const MESSAGING_SCOPE = 'whatsapp_business_messaging'

/**
 * Pure derivation from a debug_token response — unit-tested. `wabaId` is the
 * WhatsApp Business Account the phone number belongs to; messaging permission
 * must be granted for it (checked against the granular scope's target_ids).
 */
export function deriveStateFromDebug(
  data: MetaDebugTokenData | null | undefined,
  wabaId: string | null | undefined,
): WaConnectionResult {
  const scopes = data?.scopes ?? []

  if (!data || data.is_valid !== true) {
    return {
      state: 'not_connected',
      tokenValid: false,
      detail: data?.error?.message || 'Token is invalid, revoked, or expired.',
      scopes,
    }
  }

  // Explicit expiry guard (is_valid normally covers it; expires_at === 0 = never).
  if (typeof data.expires_at === 'number' && data.expires_at > 0 && data.expires_at * 1000 < Date.now()) {
    return { state: 'not_connected', tokenValid: false, detail: 'Token has expired.', scopes }
  }

  const granularMessaging = (data.granular_scopes ?? []).find((s) => s.scope === MESSAGING_SCOPE)
  let canSend: boolean
  if (granularMessaging) {
    const targets = granularMessaging.target_ids ?? []
    // Empty target_ids = scope granted without a per-WABA restriction.
    canSend = targets.length === 0 || (!!wabaId && targets.includes(String(wabaId)))
  } else {
    // No granular info — fall back to the flat scope list.
    canSend = scopes.includes(MESSAGING_SCOPE)
  }

  if (canSend) {
    return {
      state: 'connected',
      tokenValid: true,
      detail: 'Token is valid and can send for this WhatsApp Business Account.',
      scopes,
    }
  }

  return {
    state: 'cannot_send',
    tokenValid: true,
    detail: granularMessaging
      ? 'Token is valid but whatsapp_business_messaging is not granted for this WhatsApp Business Account — sends fail with #200.'
      : 'Token is valid but is missing the whatsapp_business_messaging permission — sends fail with #200.',
    scopes,
  }
}

/** Live evaluation: introspect the token, then derive the 3-state. */
export async function evaluateConnection(
  wabaId: string | null | undefined,
  accessToken: string,
): Promise<WaConnectionResult> {
  const data = await debugToken({ token: accessToken })
  return deriveStateFromDebug(data, wabaId)
}
