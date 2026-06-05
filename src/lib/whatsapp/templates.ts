/**
 * Resolve a message template against what was SYNCED FROM META into
 * `message_templates`, so we always send Meta the exact name + language.code
 * it approved. Sending anything else is rejected with #132001 ("Template name
 * does not exist in the translation") — which fires for BOTH a wrong language
 * code (bare 'es' vs approved 'es_ES') and a wrong/drifted name
 * (`cod_confermation_1` vs approved `cod_confermation_1_`).
 *
 * Both the inbox send route and the COD engine resolve through here so a
 * template sent manually and via COD always carries identical values, and a
 * stale `shopify_config` name/language can't silently break sends.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Minimal Supabase-shaped client — satisfied by both the RLS server client
 *  and the service-role admin client, so callers resolve identically. */
interface DbLike {
  from(table: string): any
}

export interface ResolvedTemplate {
  /** Exact template name as synced from Meta (drift-corrected); falls back to
   *  the caller's name unchanged when nothing matched. */
  name: string
  /** Approved language code; null when nothing matched. */
  language: string | null
  /** True when a synced `message_templates` row backed this resolution. */
  matched: boolean
}

/** Strip surrounding whitespace + trailing underscores and lowercase, so a
 *  config name that drifted (e.g. a missing trailing "_") still matches the
 *  approved template. Only used as a fallback after an exact match fails. */
function normalizeName(s: string): string {
  return s.trim().replace(/_+$/, '').toLowerCase()
}

/**
 * Find the synced template best matching `name`, returning Meta's exact name
 * and language. Matching is exact-first, then normalized (drift-tolerant).
 * Among a matched name's language variants, the caller's `preferredLanguage`
 * wins when Meta actually has it, else the most-recently-synced row.
 */
export async function resolveTemplate(
  db: DbLike,
  userId: string,
  name: string,
  preferredLanguage?: string | null,
): Promise<ResolvedTemplate> {
  const { data } = await db
    .from('message_templates')
    .select('name, language')
    .eq('user_id', userId)
    .not('language', 'is', null)
    .order('updated_at', { ascending: false })

  const rows = (data ?? []) as { name: string; language: string }[]
  if (!rows.length) return { name, language: preferredLanguage ?? null, matched: false }

  // 1. Exact name match. 2. Normalized fallback so trailing-underscore /
  //    whitespace / case drift in the config can't cause #132001.
  let candidates = rows.filter((r) => r.name === name)
  if (!candidates.length) {
    const target = normalizeName(name)
    candidates = rows.filter((r) => normalizeName(r.name) === target)
  }
  if (!candidates.length) return { name, language: preferredLanguage ?? null, matched: false }

  const pick =
    (preferredLanguage && candidates.find((c) => c.language === preferredLanguage)) ||
    candidates[0]
  return { name: pick.name, language: pick.language, matched: true }
}

/**
 * Convenience wrapper used by the inbox send route: just the approved language
 * code for a template name, or null when it isn't synced (caller falls back).
 */
export async function resolveTemplateLanguage(
  db: DbLike,
  userId: string,
  templateName: string,
  preferred?: string | null,
): Promise<string | null> {
  const resolved = await resolveTemplate(db, userId, templateName, preferred)
  return resolved.matched ? resolved.language : null
}
