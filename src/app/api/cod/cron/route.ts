import { timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'
import { createClient as createAdminClient } from '@supabase/supabase-js'
import { runCodTimers } from '@/lib/cod/engine'
import { runRecoveryTimers } from '@/lib/recovery/engine'

export const runtime = 'nodejs'

function safeEq(a: string, b: string): boolean {
  const ba = Buffer.from(a)
  const bb = Buffer.from(b)
  return ba.length === bb.length && timingSafeEqual(ba, bb)
}

// Same auth as the Shopify sync cron: Vercel CRON_SECRET (Bearer) or the
// shared AUTOMATION_CRON_SECRET (x-cron-secret).
function authorized(request: Request): boolean {
  const bearer = process.env.CRON_SECRET
  const auth = request.headers.get('authorization') ?? ''
  if (bearer && auth.startsWith('Bearer ') && safeEq(auth.slice(7), bearer)) return true

  const alt = process.env.AUTOMATION_CRON_SECRET
  const supplied = request.headers.get('x-cron-secret') ?? ''
  if (alt && supplied && safeEq(supplied, alt)) return true

  return false
}

/**
 * GET /api/cod/cron
 *
 * Standalone COD reminder/no-reply sweep. The same sweep also runs inside the
 * daily /api/shopify/cron/sync, so this endpoint is for running it on its own
 * schedule (e.g. hourly on Vercel Pro) or triggering it manually. Idempotent.
 */
export async function GET(request: Request) {
  if (!process.env.CRON_SECRET && !process.env.AUTOMATION_CRON_SECRET) {
    return NextResponse.json({ error: 'cron not configured' }, { status: 503 })
  }
  if (!authorized(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const admin = createAdminClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  )

  try {
    const cod = await runCodTimers(admin)
    // Abandoned-checkout recovery shares this sweep — same scheduler,
    // same manual trigger for testing. Idempotent like the COD timers.
    let recovery = { processed: 0, sent: 0, stopped: 0 }
    try {
      recovery = await runRecoveryTimers(admin)
    } catch (err) {
      console.error('[cod/cron] recovery timers failed:', err)
    }
    return NextResponse.json({ ok: true, cod, recovery })
  } catch (err) {
    console.error('[cod/cron] failed:', err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'COD cron failed' },
      { status: 500 },
    )
  }
}
