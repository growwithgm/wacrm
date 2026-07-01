import crypto from 'crypto'
import { insertAuditRow } from './db'

// ---------------------------------------------------------------------------
// MCP audit logging. Records tool name, principal, a SHA-256 hash of the
// arguments, a redacted target, and the result — NEVER raw arguments, phone
// numbers, or message bodies. The hash is one-way, so even a `query` argument
// containing a phone fragment cannot be recovered from the log.
// ---------------------------------------------------------------------------

export type AuditResult = 'ok' | 'error' | 'dry_run' | 'rate_limited' | 'denied'

/** One-way SHA-256 hash of the (stable-serialised) tool arguments. */
export function hashParams(params: unknown): string {
  return crypto.createHash('sha256').update(JSON.stringify(params ?? {})).digest('hex')
}

/** Record a tool invocation. Best-effort; failures never propagate. */
export async function recordToolCall(
  tool: string,
  params: unknown,
  result: AuditResult,
  opts?: { target?: string; detail?: string },
): Promise<void> {
  await insertAuditRow({
    tool,
    result,
    params_hash: hashParams(params),
    target: opts?.target ?? null,
    detail: opts?.detail ?? null,
  })
}
