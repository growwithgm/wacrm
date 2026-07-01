// ---------------------------------------------------------------------------
// Shared pagination for MCP read tools.
//
// Every list tool takes an optional `limit` and an opaque `cursor`. The server
// CLAMPS the requested limit to a per-tool maximum (a client asking for 100000
// gets at most `max`), so no single tool call can bulk-dump the dataset. The
// cursor is an opaque base64url token encoding a row offset; ordering is always
// stabilised with an `id` tiebreaker so offset paging is deterministic even
// when many rows share a timestamp (e.g. a bulk Shopify sync).
// ---------------------------------------------------------------------------

/** Clamp a requested page size to [1, max], falling back to `def` when unset. */
export function clampLimit(requested: number | undefined, def: number, max: number): number {
  if (typeof requested !== 'number' || !Number.isFinite(requested)) return def
  const n = Math.floor(requested)
  if (n < 1) return 1
  return Math.min(n, max)
}

/** Decode an opaque cursor to a non-negative row offset. Invalid → 0. */
export function decodeCursor(cursor?: string): number {
  if (!cursor) return 0
  try {
    const n = parseInt(Buffer.from(cursor, 'base64url').toString('utf8'), 10)
    return Number.isFinite(n) && n >= 0 ? n : 0
  } catch {
    return 0
  }
}

/** Encode a row offset to an opaque cursor. */
export function encodeCursor(offset: number): string {
  return Buffer.from(String(offset), 'utf8').toString('base64url')
}

/**
 * Next cursor for the following page, or null on the last page. A full page
 * (rowCount === limit) implies there may be more; a short page is the end.
 */
export function nextCursor(rowCount: number, limit: number, offset: number): string | null {
  return rowCount === limit ? encodeCursor(offset + limit) : null
}
