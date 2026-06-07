'use client'

import { useCallback, useEffect, useState } from 'react'
import type { WaConnectionState } from '@/lib/whatsapp/connection'

export type WaUiState = WaConnectionState | 'unknown'

interface WaPayload {
  state?: WaConnectionState
  connected?: boolean
  detail?: string
  message?: string
  waba_name?: string | null
  waba_info?: { name?: string } | null
  last_checked_at?: string | null
  needs_reset?: boolean
  subscribed?: boolean | null
  app_name?: string | null
}

export interface WaConnection {
  state: WaUiState
  detail: string
  wabaName: string | null
  lastCheckedAt: string | null
  needsReset: boolean
  /** Inbound: is the app subscribed to the WABA's webhooks? null = unknown. */
  subscribed: boolean | null
  appName: string | null
  loading: boolean
  /** Force a fresh live check (used by "Test API Connection"); returns the payload. */
  refresh: () => Promise<WaPayload>
}

// Module-level cache shared by every consumer (sidebar + settings banner + pill)
// so the live Meta check runs at most once per TTL regardless of mounts.
let cache: { ts: number; data: WaPayload } | null = null
let inflight: Promise<WaPayload> | null = null
const TTL = 60_000

async function load(force: boolean): Promise<WaPayload> {
  if (!force && cache && Date.now() - cache.ts < TTL) return cache.data
  if (!force && inflight) return inflight
  const p = fetch('/api/whatsapp/config')
    .then((r) => r.json() as Promise<WaPayload>)
    .then((data) => {
      cache = { ts: Date.now(), data }
      return data
    })
    .finally(() => {
      if (inflight === p) inflight = null
    })
  if (!force) inflight = p
  return p
}

function toState(d: WaPayload | null): WaUiState {
  if (!d) return 'unknown'
  if (d.state) return d.state
  return d.connected ? 'connected' : 'not_connected'
}

export function useWhatsAppConnection(): WaConnection {
  const [data, setData] = useState<WaPayload | null>(cache?.data ?? null)
  const [loading, setLoading] = useState(!cache)

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const d = await load(true)
      setData(d)
      return d
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    let alive = true
    load(false)
      .then((d) => {
        if (alive) {
          setData(d)
          setLoading(false)
        }
      })
      .catch(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [])

  return {
    state: toState(data),
    detail: data?.detail ?? data?.message ?? '',
    wabaName: data?.waba_name ?? data?.waba_info?.name ?? null,
    lastCheckedAt: data?.last_checked_at ?? null,
    needsReset: !!data?.needs_reset,
    subscribed: data?.subscribed ?? null,
    appName: data?.app_name ?? null,
    loading,
    refresh,
  }
}

/**
 * Shared presentation for each state so the banner, pill, and sidebar match.
 * Green = primary (theme), amber = the one status colour allowed outside tokens,
 * red = destructive (theme). Everything else stays on theme tokens.
 */
export const WA_STATE_UI: Record<
  WaUiState,
  { label: string; dot: string; text: string; tint: string; border: string }
> = {
  connected: {
    label: 'Connected',
    dot: 'bg-primary',
    text: 'text-primary',
    tint: 'bg-primary/10',
    border: 'border-primary/30',
  },
  cannot_send: {
    label: 'Connected — cannot send',
    dot: 'bg-amber-500',
    text: 'text-amber-600',
    tint: 'bg-amber-500/10',
    border: 'border-amber-500/30',
  },
  not_connected: {
    label: 'Not connected',
    dot: 'bg-destructive',
    text: 'text-destructive',
    tint: 'bg-destructive/10',
    border: 'border-destructive/30',
  },
  unknown: {
    label: 'Checking…',
    dot: 'bg-muted-foreground',
    text: 'text-muted-foreground',
    tint: 'bg-muted',
    border: 'border-border',
  },
}
