/**
 * Resolve the Meta-approved language code for a message template.
 *
 * The `language.code` we send Meta MUST exactly match an approved translation,
 * or Meta rejects the send with #132001 ("Template name does not exist in the
 * translation"). The authoritative source is the language we synced FROM Meta
 * into `message_templates` — NOT a hand-set default like the bare 'es', which
 * mismatches a template Meta actually approved as 'es_ES'.
 *
 * Both the inbox send route and the COD engine call this so they resolve the
 * language identically: the manual send to a number works, so COD sending the
 * same name to the same number must use the same resolved code.
 *
 *   preferred — a caller's desired code (e.g. the COD config language). Honored
 *               ONLY when Meta actually has that exact translation; otherwise we
 *               fall back to the most-recently-synced approved code for the name.
 *
 * Returns null when the template isn't synced at all; the caller decides the
 * last-resort fallback.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Minimal Supabase-shaped client — satisfied by both the RLS server client
 *  and the service-role admin client, so callers resolve identically. */
interface DbLike {
  from(table: string): any
}

export async function resolveTemplateLanguage(
  db: DbLike,
  userId: string,
  templateName: string,
  preferred?: string | null,
): Promise<string | null> {
  const { data } = await db
    .from('message_templates')
    .select('language')
    .eq('user_id', userId)
    .eq('name', templateName)
    .not('language', 'is', null)
    .order('updated_at', { ascending: false })

  const rows = (data ?? []) as { language: string }[]
  if (!rows.length) return null
  // Honor the caller's preferred code only if Meta actually approved it.
  if (preferred && rows.some((r) => r.language === preferred)) return preferred
  return rows[0].language
}
