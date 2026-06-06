/**
 * Order-derived fields a merchant can map a COD template's {{n}} placeholder to.
 *
 * Shared by the engine (fills the value at send time), the cod-config API
 * (validates a saved mapping), and the /cod UI (renders the dropdown) so the
 * three can't drift. Nothing here is store data — these are the app's fixed set
 * of mappable order fields.
 */

export const COD_FIELD_OPTIONS = [
  { key: 'first_name', label: 'Customer first name' },
  { key: 'full_name', label: 'Customer full name' },
  { key: 'order_number', label: 'Order number' },
  { key: 'total', label: 'Order total' },
  { key: 'currency', label: 'Currency' },
  { key: 'items_count', label: 'Items count' },
  { key: 'shipping_city', label: 'Shipping city' },
] as const

export type CodFieldKey = (typeof COD_FIELD_OPTIONS)[number]['key']

export const COD_FIELD_KEYS: readonly string[] = COD_FIELD_OPTIONS.map((o) => o.key)

/** Default mapping = the legacy hardcoded behavior ({{1}} order number, {{2}} total). */
export const COD_DEFAULT_VAR_MAP: Record<string, string> = { '1': 'order_number', '2': 'total' }

/** The order fields captured for a confirmation, used to fill mapped variables. */
export interface CodOrderFields {
  first_name?: string | null
  full_name?: string | null
  order_number?: string | null
  total?: string | null
  currency?: string | null
  items_count?: number | null
  shipping_city?: string | null
}

/** Resolve one mapped field key to its string value (empty string when absent). */
export function codFieldValue(key: string | undefined, f: CodOrderFields): string {
  switch (key) {
    case 'first_name':
      return f.first_name ?? ''
    case 'full_name':
      return f.full_name ?? ''
    case 'order_number':
      return f.order_number ?? ''
    case 'total':
      return f.total ?? ''
    case 'currency':
      return f.currency ?? ''
    case 'items_count':
      return f.items_count != null ? String(f.items_count) : ''
    case 'shipping_city':
      return f.shipping_city ?? ''
    default:
      return ''
  }
}

/**
 * Count a template body's placeholders as the highest {{n}} index — Meta numbers
 * body params contiguously from 1, so the max index is how many params to send.
 */
export function countPlaceholders(body: string): number {
  let max = 0
  for (const m of body.matchAll(/\{\{(\d+)\}\}/g)) max = Math.max(max, Number(m[1]))
  return max
}

/**
 * Build the ordered body-params array for a template: position i → the value
 * mapped to placeholder i+1. Falls back to the default map when none is set.
 */
export function buildCodParams(
  varMap: Record<string, string> | null | undefined,
  fields: CodOrderFields,
  placeholderCount: number,
): string[] {
  const map = varMap ?? COD_DEFAULT_VAR_MAP
  const out: string[] = []
  for (let i = 1; i <= placeholderCount; i++) {
    out.push(codFieldValue(map[String(i)], fields))
  }
  return out
}
