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

// Look back a couple of days so a webhook outage of up to ~48h still gets
// reconciled. Bounded page count keeps each run within the time budget.
const LOOKBACK_DAYS = 2
const MAX_PAGES = 4
const PAGE_SIZE = 50

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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function syncStore(admin: any, config: ShopifyConfigRow) {
  const token = await getValidToken(config)
  const since = new Date(Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000).toISOString()
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
    for (const order of res.data.orders ?? []) {
      try {
        await upsertOrder(admin, config.user_id, config.store_domain, order, 'backfill')
        orders++
      } catch (err) {
        console.error('[shopify/cron] order upsert error:', err)
      }
    }
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
    for (const checkout of res.data.checkouts ?? []) {
      try {
        await upsertCheckout(admin, config.user_id, config.store_domain, checkout, 'backfill')
        // Create the recovery tracking row for sync-ingested carts too — not
        // only the live webhook. Idempotent; sending is still gated by the cron.
        await ensureCheckoutRecovery(admin, config.user_id, checkout)
        checkouts++
      } catch (err) {
        console.error('[shopify/cron] checkout upsert error:', err)
      }
    }
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
