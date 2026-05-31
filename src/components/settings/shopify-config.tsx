'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { toast } from 'sonner'
import {
  CheckCircle2,
  ExternalLink,
  Loader2,
  RefreshCw,
  ShoppingCart,
  Unplug,
  Users,
  XCircle,
  Store,
  ArrowRight,
} from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { useAuth } from '@/hooks/use-auth'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'

// ─── Types ────────────────────────────────────────────────────────────────────

interface ConfigState {
  connected: boolean
  shop_name?: string
  store_domain?: string
  last_synced_at?: string | null
  plan?: string | null
  reason?: string
  message?: string
}

interface SyncProgress {
  running: boolean
  total_processed: number
  created: number
  updated: number
  errors: number
}

function formatTimestamp(ts: string | null | undefined): string {
  if (!ts) return 'Never'
  try {
    return new Date(ts).toLocaleString(undefined, {
      dateStyle: 'medium',
      timeStyle: 'short',
    })
  } catch {
    return ts
  }
}

// ─── Component ────────────────────────────────────────────────────────────────

export function ShopifyConfig() {
  const { user, loading: authLoading } = useAuth()
  const supabase = createClient()
  const searchParams = useSearchParams()

  const [loading, setLoading] = useState(true)
  const [checking, setChecking] = useState(false)
  const [config, setConfig] = useState<ConfigState | null>(null)
  const [shopDomain, setShopDomain] = useState('')
  const [disconnecting, setDisconnecting] = useState(false)

  const [sync, setSync] = useState<SyncProgress>({
    running: false,
    total_processed: 0,
    created: 0,
    updated: 0,
    errors: 0,
  })

  // Only load config once per user (same pattern as WhatsAppConfig)
  const fetchedForRef = useRef<string | null>(null)

  // ── Load config ─────────────────────────────────────────────────────────────
  const fetchConfig = useCallback(async () => {
    setLoading(true)
    try {
      // Quick cached read from DB
      const { data } = await supabase
        .from('shopify_config')
        .select('connection_status, shop_name, store_domain, last_synced_at')
        .eq('user_id', user!.id)
        .maybeSingle()

      if (data) {
        setConfig({
          connected: data.connection_status === 'connected',
          shop_name: data.shop_name ?? undefined,
          store_domain: data.store_domain,
          last_synced_at: data.last_synced_at,
        })
      } else {
        setConfig({ connected: false })
      }
    } catch (err) {
      console.error('[ShopifyConfig] fetchConfig error:', err)
    } finally {
      setLoading(false)
    }

    // Background re-validation via API
    if (!user) return
    setChecking(true)
    try {
      const res = await fetch('/api/shopify/config')
      const payload = await res.json()
      setConfig({
        connected: payload.connected ?? false,
        shop_name: payload.shop_name,
        store_domain: payload.store_domain,
        last_synced_at: payload.last_synced_at,
        plan: payload.plan,
        reason: payload.reason,
        message: payload.message,
      })
    } catch {
      // Keep cached state on network error
    } finally {
      setChecking(false)
    }
  }, [supabase, user])

  useEffect(() => {
    if (authLoading || !user) return
    if (fetchedForRef.current === user.id) return
    fetchedForRef.current = user.id
    fetchConfig()
  }, [authLoading, user, fetchConfig])

  // ── Handle error from OAuth callback URL ─────────────────────────────────
  useEffect(() => {
    const err = searchParams.get('error')
    if (!err) return
    const messages: Record<string, string> = {
      invalid_state: 'OAuth state mismatch — please try connecting again.',
      invalid_hmac: 'Shopify callback signature was invalid — possible tampering.',
      session_expired: 'Your session expired during the OAuth flow. Please try again.',
      server_misconfigured: 'Shopify env vars are not configured on the server.',
      invalid_params: 'Shopify returned invalid parameters in the callback.',
    }
    toast.error(messages[err] ?? decodeURIComponent(err))
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ── Connect ─────────────────────────────────────────────────────────────────
  function handleConnect() {
    const raw = shopDomain.trim().toLowerCase()
    if (!raw) {
      toast.error('Enter your store domain first')
      return
    }
    const domain = raw.includes('.') ? raw : `${raw}.myshopify.com`
    // Full page navigation — backend will redirect to Shopify OAuth
    window.location.href = `/api/shopify/connect?shop=${encodeURIComponent(domain)}`
  }

  // ── Disconnect ───────────────────────────────────────────────────────────────
  async function handleDisconnect() {
    if (
      !confirm(
        'Disconnect your Shopify store? Synced customer data (contacts) will remain but Shopify fields will no longer update.',
      )
    )
      return

    setDisconnecting(true)
    try {
      const res = await fetch('/api/shopify/config', { method: 'DELETE' })
      const data = await res.json()
      if (!res.ok) {
        toast.error(data.error ?? 'Failed to disconnect')
        return
      }
      toast.success('Shopify store disconnected')
      fetchedForRef.current = null
      fetchConfig()
    } catch {
      toast.error('Failed to disconnect')
    } finally {
      setDisconnecting(false)
    }
  }

  // ── Sync customers ───────────────────────────────────────────────────────────
  async function handleSync() {
    if (sync.running) return

    setSync({ running: true, total_processed: 0, created: 0, updated: 0, errors: 0 })
    let cursor: string | null = null
    let totalCreated = 0
    let totalUpdated = 0
    let totalErrors = 0
    let totalProcessed = 0

    try {
      while (true) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const pageRes: Response = await fetch('/api/shopify/sync', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ cursor, total_processed: totalProcessed }),
        })
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const data: any = await pageRes.json()

        if (!pageRes.ok) {
          toast.error(data.error ?? 'Sync failed')
          break
        }

        totalCreated += data.created ?? 0
        totalUpdated += data.updated ?? 0
        totalErrors += data.errors ?? 0
        totalProcessed = data.total_processed ?? totalProcessed

        setSync({
          running: !data.done,
          total_processed: totalProcessed,
          created: totalCreated,
          updated: totalUpdated,
          errors: totalErrors,
        })

        if (data.done) {
          toast.success(
            `Sync complete — ${totalCreated} imported, ${totalUpdated} updated${totalErrors > 0 ? `, ${totalErrors} errors` : ''}`,
          )
          // Refresh config to show new last_synced_at
          fetchedForRef.current = null
          fetchConfig()
          break
        }

        cursor = data.next_cursor
      }
    } catch (err) {
      console.error('[ShopifyConfig] sync error:', err)
      toast.error('Sync interrupted — check Vercel logs')
      setSync((prev) => ({ ...prev, running: false }))
    }
  }

  // ─── Render ─────────────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="size-6 animate-spin text-primary" />
      </div>
    )
  }

  const isConnected = config?.connected ?? false

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_380px] mt-4">
      {/* ── Left: main panel ─────────────────────────────────────────────── */}
      <div className="space-y-6">

        {/* Connection status banner */}
        <div
          className={
            isConnected
              ? 'rounded-xl border border-green-500 bg-green-900/50 p-4'
              : 'rounded-xl border border-red-500 bg-red-900/50 p-4'
          }
        >
          <div className="flex items-start gap-3">
            {isConnected ? (
              <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-green-400" />
            ) : (
              <XCircle className="mt-0.5 size-5 shrink-0 text-red-400" />
            )}
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <p
                  className={
                    isConnected
                      ? 'font-semibold text-green-200'
                      : 'font-semibold text-red-200'
                  }
                >
                  {isConnected
                    ? `Connected — Store: ${config?.shop_name ?? config?.store_domain}`
                    : 'Not Connected'}
                </p>
                {checking && (
                  <RefreshCw className="size-3.5 animate-spin text-slate-400" />
                )}
              </div>
              {!isConnected && (
                <p className="mt-1 text-sm text-red-300/80">
                  {config?.message ??
                    'Connect your Shopify store using the form below.'}
                </p>
              )}
              {isConnected && config?.plan && (
                <p className="mt-1 text-xs text-green-300/70">Plan: {config.plan}</p>
              )}
              <p className="mt-1.5 text-xs text-slate-400">
                Last synced:{' '}
                {checking ? 'Verifying…' : formatTimestamp(config?.last_synced_at)}
              </p>
            </div>
          </div>
        </div>

        {/* Connect / Manage card */}
        {!isConnected ? (
          <Card className="bg-slate-900 border-slate-700">
            <CardHeader>
              <CardTitle className="text-white flex items-center gap-2">
                <ShoppingCart className="size-5" />
                Connect Shopify Store
              </CardTitle>
              <CardDescription className="text-slate-400">
                Enter your Shopify store domain to start the OAuth connection flow.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label className="text-slate-300">Store domain</Label>
                <div className="flex gap-2">
                  <Input
                    placeholder="mystore.myshopify.com"
                    value={shopDomain}
                    onChange={(e) => setShopDomain(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && handleConnect()}
                    className="bg-slate-800 border-slate-700 text-white placeholder:text-slate-500"
                  />
                  <Button
                    onClick={handleConnect}
                    className="shrink-0 bg-primary hover:bg-primary/90"
                  >
                    Connect <ArrowRight className="size-4" />
                  </Button>
                </div>
                <p className="text-xs text-slate-500">
                  You will be redirected to Shopify to authorise the connection.
                  You can enter just the subdomain (e.g. <code>mystore</code>) or
                  the full domain.
                </p>
              </div>
            </CardContent>
          </Card>
        ) : (
          <>
            {/* Store info */}
            <Card className="bg-slate-900 border-slate-700">
              <CardHeader>
                <CardTitle className="text-white flex items-center gap-2">
                  <Store className="size-5" />
                  Connected Store
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="flex justify-between rounded-xl bg-slate-800 px-4 py-3">
                  <span className="text-sm text-slate-400">Store</span>
                  <span className="text-sm font-medium text-white">
                    {config?.shop_name ?? '—'}
                  </span>
                </div>
                <div className="flex justify-between rounded-xl bg-slate-800 px-4 py-3">
                  <span className="text-sm text-slate-400">Domain</span>
                  <a
                    href={`https://${config?.store_domain}/admin`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-1 text-sm text-primary hover:text-primary/80"
                  >
                    {config?.store_domain}
                    <ExternalLink className="size-3" />
                  </a>
                </div>
                <div className="flex justify-between rounded-xl bg-slate-800 px-4 py-3">
                  <span className="text-sm text-slate-400">Last synced</span>
                  <span className="text-sm text-white">
                    {formatTimestamp(config?.last_synced_at)}
                  </span>
                </div>
              </CardContent>
            </Card>

            {/* Sync progress / result */}
            {(sync.running || sync.total_processed > 0) && (
              <Card className="bg-slate-900 border-slate-700">
                <CardContent className="pt-5">
                  <div className="flex items-center gap-3">
                    {sync.running ? (
                      <Loader2 className="size-5 animate-spin text-primary" />
                    ) : (
                      <CheckCircle2 className="size-5 text-green-400" />
                    )}
                    <div>
                      <p className="text-sm font-medium text-white">
                        {sync.running
                          ? `Syncing… ${sync.total_processed.toLocaleString()} processed`
                          : `Sync complete — ${sync.total_processed.toLocaleString()} processed`}
                      </p>
                      <p className="text-xs text-slate-400">
                        {sync.created} imported · {sync.updated} updated
                        {sync.errors > 0 && ` · ${sync.errors} errors`}
                      </p>
                    </div>
                  </div>
                </CardContent>
              </Card>
            )}

            {/* Action buttons */}
            <div className="flex flex-wrap gap-3">
              <Button
                onClick={handleSync}
                disabled={sync.running}
                className="bg-primary hover:bg-primary/90 text-primary-foreground"
              >
                {sync.running ? (
                  <>
                    <Loader2 className="size-4 animate-spin" />
                    Syncing…
                  </>
                ) : (
                  <>
                    <Users className="size-4" />
                    Sync Customers
                  </>
                )}
              </Button>

              <Button
                variant="outline"
                onClick={handleDisconnect}
                disabled={disconnecting || sync.running}
                className="border-red-900 text-red-400 hover:text-red-300 hover:bg-red-950/40"
              >
                {disconnecting ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <Unplug className="size-4" />
                )}
                Disconnect Store
              </Button>
            </div>
          </>
        )}
      </div>

      {/* ── Right: info sidebar ──────────────────────────────────────────── */}
      <div>
        <Card className="bg-slate-900 border-slate-700">
          <CardHeader>
            <CardTitle className="text-white text-base">
              Shopify Integration
            </CardTitle>
            <CardDescription className="text-slate-400">
              Phase 1: OAuth connect + customer data sync.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2 text-sm text-slate-400">
              <p className="font-medium text-slate-300">What gets synced</p>
              <ul className="space-y-1 list-disc list-inside">
                <li>Customer name, email, phone (E.164)</li>
                <li>Lifetime order count &amp; total spend</li>
                <li>Last order date</li>
                <li>Shopify customer tags</li>
              </ul>
            </div>

            <div className="space-y-2 text-sm text-slate-400">
              <p className="font-medium text-slate-300">Dedup logic</p>
              <ol className="space-y-1 list-decimal list-inside">
                <li>Match on Shopify customer ID</li>
                <li>Match on phone number</li>
                <li>Match on email address</li>
                <li>Create new contact if no match</li>
              </ol>
              <p>
                Existing WhatsApp contacts are enriched — not duplicated.
              </p>
            </div>

            <div className="pt-2 border-t border-slate-700">
              <a
                href="https://shopify.dev/docs/api/admin-graphql"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 text-sm text-primary hover:text-primary/80"
              >
                <ExternalLink className="size-3.5" />
                Shopify Admin GraphQL API
              </a>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
