import { timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'
import { createClient as createAdminClient } from '@supabase/supabase-js'
import { getValidToken, shopifyRest } from '@/lib/shopify/client'
import { upsertOrder, upsertCheckout } from '@/lib/shopify/store'
import { runCodTimers } from '@/lib/cod/engine'
import { runRecoveryTimers, ensureCheckoutRecovery } from '@/lib/recovery/engine'
import type { ShopifyConfigRow } from '@/lib/shopify/client'
import type { RestOrder, RestCheckout } from '@/lib/shopify/transform'

export const runtime = 'nodejs'
// Multi-store sync can take a while; allow more than the default (Pro plan).
export const maxDuration = 60

// This cron is a backfill SAFETY NET that runs every ~15 min — webhooks are the
// real-time path. A 12h window still reconciles a webhook outage of up to ~12h
// (48× the run cadence) while keeping each run well under cron-job.org's 30s
// timeout. Longer gaps are covered by the manual 30-day Sync buttons. The
// bounded page count caps the per-run row count on traffic spikes.
const LOOKBACK_HOURS = 12
const MAX_PAGES = 2
const PAGE_SIZE = 50
// Per-item upserts run in bounded-concurrency batches: the dominant cost is the
// sequential round-trip latency to (free-tier) Supabase, so processing ~8 at a
// time collapses wall-clock from ~per-row to ~per-batch without overwhelming
// the connection pool. Kept inside one page so pagination stays sequential.
const BATCH_SIZE = 8

function safeEq(a: string, b: string): boolean {
  const ba = Buffer.from(a)
  const bb = Buffer.from(b)
  return ba.length === bb.length && timingSafeEqual(ba, bb)
}

// Accept either Vercel's CRON_SECRET (Authorization: Bearer …) or the shared
// AUTOMATION_CRON_SECRET (x-cron-secret), matching the existing cron routes.
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
 * Run `fn` over `items` in chunks of `size`, awaiting each chunk before the
 * next. `fn` is expected to swallow its own errors (per-item try/catch), so a
 * single failing item never rejects the batch and never blocks its siblings —
 * same isolation as the previous one-at-a-time loop, just concurrent.
 */
async function inBatches<T>(
  items: T[],
  size: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  for (let i = 0; i < items.length; i += size) {
    await Promise.all(items.slice(i, i + size).map(fn))
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function syncStore(admin: any, config: ShopifyConfigRow) {
  const token = await getValidToken(config)
  const since = new Date(Date.now() - LOOKBACK_HOURS * 60 * 60 * 1000).toISOString()
  let orders = 0
  let checkouts = 0

  // Recently-updated orders (catches new orders + status changes a missed
  // webhook would have carried). source='backfill' — never automation-eligible.
  let cursor: string | null = null
  for (let page = 0; page < MAX_PAGES; page++) {
    const path: string = cursor
      ? `orders.json?limit=${PAGE_SIZE}&page_info=${encodeURIComponent(cursor)}`
      : `orders.json?status=any&limit=${PAGE_SIZE}&updated_at_min=${encodeURIComponent(since)}`
    const res = await shopifyRest<{ orders: RestOrder[] }>(config.store_domain, token, path)
    await inBatches(res.data.orders ?? [], BATCH_SIZE, async (order) => {
      try {
        await upsertOrder(admin, config.user_id, config.store_domain, order, 'backfill')
        orders++
      } catch (err) {
        console.error('[shopify/cron] order upsert error:', err)
      }
    })
    if (!res.nextPageInfo) break
    cursor = res.nextPageInfo
  }

  // Recently-created abandoned checkouts.
  cursor = null
  for (let page = 0; page < MAX_PAGES; page++) {
    const path: string = cursor
      ? `checkouts.json?limit=${PAGE_SIZE}&page_info=${encodeURIComponent(cursor)}`
      : `checkouts.json?limit=${PAGE_SIZE}&created_at_min=${encodeURIComponent(since)}`
    const res = await shopifyRest<{ checkouts: RestCheckout[] }>(config.store_domain, token, path)
    await inBatches(res.data.checkouts ?? [], BATCH_SIZE, async (checkout) => {
      try {
        await upsertCheckout(admin, config.user_id, config.store_domain, checkout, 'backfill')
        // Create the recovery tracking row for sync-ingested carts too — not
        // only the live webhook. Idempotent; sending is still gated by the cron.
        // Runs after the checkout upsert (it reads the persisted row), so these
        // two stay ordered within an item even though items run concurrently.
        await ensureCheckoutRecovery(admin, config.user_id, checkout)
        checkouts++
      } catch (err) {
        console.error('[shopify/cron] checkout upsert error:', err)
      }
    })
    if (!res.nextPageInfo) break
    cursor = res.nextPageInfo
  }

  return { orders, checkouts }
}

/**
 * GET /api/shopify/cron/sync
 *
 * Server-side backup sync (Priority 3). Runs on a Vercel Cron schedule —
 * independent of any browser tab — and reconciles recently changed orders
 * and abandoned checkouts for every connected store. This is a SAFETY NET
 * only: webhooks are the real-time path, and everything written here is
 * 'backfill' source, so it can never trigger a WhatsApp message.
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

  const { data: configs, error } = await admin.from('shopify_config').select('*')
  if (error) {
    console.error('[shopify/cron] config scan failed:', error.message)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  let stores = 0
  let orders = 0
  let checkouts = 0
  const failures: { store: string; error: string }[] = []

  for (const config of (configs ?? []) as ShopifyConfigRow[]) {
    try {
      const r = await syncStore(admin, config)
      stores++
      orders += r.orders
      checkouts += r.checkouts
    } catch (err) {
      failures.push({
        store: config.store_domain,
        error: err instanceof Error ? err.message : String(err),
      })
      console.error(`[shopify/cron] store ${config.store_domain} failed:`, err)
    }
  }

  // COD reminder/no-reply sweep runs on the same schedule. Reminders fire at
  // 24/48h and the no-reply tag at 72h, so a daily run advances each row by one
  // step; the messages_sent guards make it safe to run more often too.
  let cod = { processed: 0, reminders: 0, noReplies: 0 }
  try {
    cod = await runCodTimers(admin)
  } catch (err) {
    console.error('[shopify/cron] COD timers failed:', err)
  }

  // Abandoned-checkout recovery sweep — same scheduler as COD, same
  // idempotency guards (reminders_sent gates + order-complete check).
  let recovery = { processed: 0, sent: 0, stopped: 0 }
  try {
    recovery = await runRecoveryTimers(admin)
  } catch (err) {
    console.error('[shopify/cron] recovery timers failed:', err)
  }

  return NextResponse.json({ ok: true, stores, orders, checkouts, cod, recovery, failures })
}
