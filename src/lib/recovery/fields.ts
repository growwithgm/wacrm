/**
 * Checkout-derived fields a merchant can map a recovery template's
 * placeholder to — mirrors src/lib/cod/fields.ts.
 *
 * Shared by the engine (fills values at send time), the recovery-config API
 * (validates a saved mapping) and the /recovery UI (renders the dropdowns)
 * so the three can't drift.
 */

/** Sources for body placeholders ({{1}}, {{2}}, …). */
export const RECOVERY_FIELD_OPTIONS = [
  { key: 'first_name', label: 'Customer first name' },
  { key: 'full_name', label: 'Customer full name' },
  { key: 'cart_total', label: 'Cart total' },
  { key: 'currency', label: 'Currency' },
  { key: 'items_count', label: 'Items count' },
] as const

/** Sources for the dynamic URL button. */
export const RECOVERY_URL_OPTIONS = [
  { key: 'recovery_url', label: 'Recovery link (abandoned checkout URL)' },
] as const

export type RecoveryFieldKey = (typeof RECOVERY_FIELD_OPTIONS)[number]['key']
export type RecoveryUrlKey = (typeof RECOVERY_URL_OPTIONS)[number]['key']

export const RECOVERY_FIELD_KEYS: readonly string[] = RECOVERY_FIELD_OPTIONS.map((o) => o.key)
export const RECOVERY_URL_KEYS: readonly string[] = RECOVERY_URL_OPTIONS.map((o) => o.key)

/**
 * Default mapping = today's hardcoded behavior:
 *   {{1}} → customer first name, {{2}} → cart total, button → recovery URL.
 * The reserved "button" key maps the dynamic URL button.
 */
export const RECOVERY_DEFAULT_VAR_MAP: Record<string, string> = {
  '1': 'first_name',
  '2': 'cart_total',
  button: 'recovery_url',
}

/** The checkout values used to fill a mapped placeholder. */
export interface RecoveryFields {
  first_name?: string | null
  full_name?: string | null
  cart_total?: string | null
  currency?: string | null
  items_count?: number | null
}

/** Resolve one mapped body-field key to its string value. */
export function recoveryFieldValue(key: string | undefined, f: RecoveryFields): string {
  switch (key) {
    case 'first_name':
      return f.first_name ?? ''
    case 'full_name':
      return f.full_name ?? ''
    case 'cart_total':
      return f.cart_total ?? ''
    case 'currency':
      return f.currency ?? ''
    case 'items_count':
      return f.items_count != null ? String(f.items_count) : ''
    default:
      return ''
  }
}

/**
 * Build the ordered body-params array for a template: position i → the value
 * mapped to placeholder i+1. Falls back to the default map per index when a
 * mapping isn't set, so an empty map reproduces today's behavior.
 */
export function buildRecoveryParams(
  varMap: Record<string, string> | null | undefined,
  fields: RecoveryFields,
  placeholderCount: number,
): string[] {
  const map = varMap && Object.keys(varMap).length > 0 ? varMap : RECOVERY_DEFAULT_VAR_MAP
  const out: string[] = []
  for (let i = 1; i <= placeholderCount; i++) {
    const key = map[String(i)] ?? RECOVERY_DEFAULT_VAR_MAP[String(i)]
    out.push(recoveryFieldValue(key, fields))
  }
  return out
}

/** The URL source key selected for the button (falls back to the default). */
export function recoveryButtonSource(varMap: Record<string, string> | null | undefined): string {
  return (varMap?.button as string) || RECOVERY_DEFAULT_VAR_MAP.button
}
