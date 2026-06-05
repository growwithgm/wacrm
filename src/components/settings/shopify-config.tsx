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
  ShoppingBag,
  Unplug,
  Users,
  XCircle,
  Store,
  ArrowRight,
  Webhook,
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
  webhooks_registered_at?: string | null
  webhook_topics?: string[]
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
  const emptyProgress: SyncProgress = {
    running: false,
    total_processed: 0,
    created: 0,
    updated: 0,
    errors: 0,
  }
  const [orderSync, setOrderSync] = useState<SyncProgress>(emptyProgress)
  const [checkoutSync, setCheckoutSync] = useState<SyncProgress>(emptyProgress)

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
        webhooks_registered_at: payload.webhooks_registered_at,
        webhook_topics: payload.webhook_topics,
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

  // ── Generic resource sync (orders / abandoned checkouts) ─────────────────────
  // The /orders and /checkouts endpoints share the cursor-loop contract; they
  // report { processed, total_processed, errors, done, next_cursor } per page.
  async function runResourceSync(
    endpoint: string,
    label: string,
    setProgress: React.Dispatch<React.SetStateAction<SyncProgress>>,
  ) {
    setProgress({ ...emptyProgress, running: true })
    let cursor: string | null = null
    let totalErrors = 0
    let totalProcessed = 0

    try {
      while (true) {
        const res: Response = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ cursor, total_processed: totalProcessed }),
        })
        const data: {
          done?: boolean
          next_cursor?: string | null
          total_processed?: number
          errors?: number
          error?: string
        } = await res.json()

        if (!res.ok) {
          toast.error(data.error ?? `${label} sync failed`)
          setProgress((p) => ({ ...p, running: false }))
          break
        }

        totalErrors += data.errors ?? 0
        totalProcessed = data.total_processed ?? totalProcessed
        setProgress({
          running: !data.done,
          total_processed: totalProcessed,
          created: 0,
          updated: 0,
          errors: totalErrors,
        })

        if (data.done) {
          toast.success(
            `${label} sync complete — ${totalProcessed} processed${totalErrors > 0 ? `, ${totalErrors} errors` : ''}`,
          )
          break
        }
        cursor = data.next_cursor ?? null
      }
    } catch (err) {
      console.error(`[ShopifyConfig] ${label} sync error:`, err)
      toast.error(`${label} sync interrupted`)
      setProgress((p) => ({ ...p, running: false }))
    }
  }

  const handleSyncOrders = () => {
    if (!orderSync.running) runResourceSync('/api/shopify/sync/orders', 'Orders', setOrderSync)
  }
  const handleSyncCheckouts = () => {
    if (!checkoutSync.running)
      runResourceSync('/api/shopify/sync/checkouts', 'Abandoned checkouts', setCheckoutSync)
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
                  <RefreshCw className="size-3.5 animate-spin text-muted-foreground" />
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
              <p className="mt-1.5 text-xs text-muted-foreground">
                Last synced:{' '}
                {checking ? 'Verifying…' : formatTimestamp(config?.last_synced_at)}
              </p>
            </div>
          </div>
        </div>

        {/* Connect / Manage card */}
        {!isConnected ? (
          <Card className="bg-card border-border">
            <CardHeader>
              <CardTitle className="text-foreground flex items-center gap-2">
                <ShoppingCart className="size-5" />
                Connect Shopify Store
              </CardTitle>
              <CardDescription className="text-muted-foreground">
                Enter your Shopify store domain to start the OAuth connection flow.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label className="text-foreground">Store domain</Label>
                <div className="flex gap-2">
                  <Input
                    placeholder="mystore.myshopify.com"
                    value={shopDomain}
                    onChange={(e) => setShopDomain(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && handleConnect()}
                    className="bg-muted border-border text-foreground placeholder:text-muted-foreground"
                  />
                  <Button
                    onClick={handleConnect}
                    className="shrink-0 bg-primary hover:bg-primary/90"
                  >
                    Connect <ArrowRight className="size-4" />
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">
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
            <Card className="bg-card border-border">
              <CardHeader>
                <CardTitle className="text-foreground flex items-center gap-2">
                  <Store className="size-5" />
                  Connected Store
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="flex justify-between rounded-xl bg-muted px-4 py-3">
                  <span className="text-sm text-muted-foreground">Store</span>
                  <span className="text-sm font-medium text-foreground">
                    {config?.shop_name ?? '—'}
                  </span>
                </div>
                <div className="flex justify-between rounded-xl bg-muted px-4 py-3">
                  <span className="text-sm text-muted-foreground">Domain</span>
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
                <div className="flex justify-between rounded-xl bg-muted px-4 py-3">
                  <span className="text-sm text-muted-foreground">Last synced</span>
                  <span className="text-sm text-foreground">
                    {formatTimestamp(config?.last_synced_at)}
                  </span>
                </div>
              </CardContent>
            </Card>

            {/* Webhook status */}
            <Card className="bg-card border-border">
              <CardContent className="pt-5">
                <div className="flex items-start gap-3">
                  <div
                    className={
                      config?.webhooks_registered_at
                        ? 'flex size-9 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary'
                        : 'flex size-9 shrink-0 items-center justify-center rounded-xl bg-muted text-muted-foreground'
                    }
                  >
                    <Webhook className="size-5" />
                  </div>
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-foreground">
                      {config?.webhooks_registered_at
                        ? 'Webhooks active'
                        : 'Webhooks not registered'}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {config?.webhooks_registered_at
                        ? `${config.webhook_topics?.length ?? 0} topics (orders, checkouts, fulfillments) · since ${formatTimestamp(config.webhooks_registered_at)}`
                        : 'Order / checkout / fulfillment events register automatically on connect — but only from a public HTTPS deployment. Reconnect from production to enable.'}
                    </p>
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* Sync progress / result */}
            {(sync.running || sync.total_processed > 0) && (
              <Card className="bg-card border-border">
                <CardContent className="pt-5">
                  <div className="flex items-center gap-3">
                    {sync.running ? (
                      <Loader2 className="size-5 animate-spin text-primary" />
                    ) : (
                      <CheckCircle2 className="size-5 text-green-400" />
                    )}
                    <div>
                      <p className="text-sm font-medium text-foreground">
                        {sync.running
                          ? `Syncing… ${sync.total_processed.toLocaleString()} processed`
                          : `Sync complete — ${sync.total_processed.toLocaleString()} processed`}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {sync.created} imported · {sync.updated} updated
                        {sync.errors > 0 && ` · ${sync.errors} errors`}
                      </p>
                    </div>
                  </div>
                </CardContent>
              </Card>
            )}

            {/* Sync actions */}
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
                onClick={handleSyncOrders}
                disabled={orderSync.running}
                className="border-border text-foreground hover:bg-muted"
              >
                {orderSync.running ? (
                  <>
                    <Loader2 className="size-4 animate-spin" />
                    Syncing orders… {orderSync.total_processed.toLocaleString()}
                  </>
                ) : (
                  <>
                    <ShoppingBag className="size-4" />
                    Sync Orders
                  </>
                )}
              </Button>

              <Button
                variant="outline"
                onClick={handleSyncCheckouts}
                disabled={checkoutSync.running}
                className="border-border text-foreground hover:bg-muted"
              >
                {checkoutSync.running ? (
                  <>
                    <Loader2 className="size-4 animate-spin" />
                    Syncing carts… {checkoutSync.total_processed.toLocaleString()}
                  </>
                ) : (
                  <>
                    <ShoppingCart className="size-4" />
                    Sync Abandoned Checkouts
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

            {/* Orders / checkouts sync result lines */}
            {(orderSync.total_processed > 0 || checkoutSync.total_processed > 0) && (
              <div className="space-y-1 text-xs text-muted-foreground">
                {orderSync.total_processed > 0 && (
                  <p>
                    Orders: {orderSync.total_processed.toLocaleString()} processed
                    {orderSync.errors > 0 && ` · ${orderSync.errors} errors`}
                  </p>
                )}
                {checkoutSync.total_processed > 0 && (
                  <p>
                    Abandoned checkouts: {checkoutSync.total_processed.toLocaleString()} processed
                    {checkoutSync.errors > 0 && ` · ${checkoutSync.errors} errors`}
                  </p>
                )}
              </div>
            )}
          </>
        )}
      </div>

      {/* ── Right: info sidebar ──────────────────────────────────────────── */}
      <div>
        <Card className="bg-card border-border">
          <CardHeader>
            <CardTitle className="text-foreground text-base">
              Shopify Integration
            </CardTitle>
            <CardDescription className="text-muted-foreground">
              OAuth connect, plus customer, order, abandoned-checkout &amp; fulfillment
              sync with live webhooks.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2 text-sm text-muted-foreground">
              <p className="font-medium text-foreground">What gets synced</p>
              <ul className="space-y-1 list-disc list-inside">
                <li>Customers — name, email, phone, lifetime orders &amp; spend</li>
                <li>Orders — totals, payment &amp; fulfillment status, line items</li>
                <li>Abandoned checkouts — cart items, value &amp; recovery link</li>
                <li>Fulfillments — tracking number, carrier &amp; shipment status</li>
              </ul>
              <p className="text-xs">
                Backfill with the sync buttons; webhooks keep everything current after.
              </p>
            </div>

            <div className="space-y-2 text-sm text-muted-foreground">
              <p className="font-medium text-foreground">Dedup logic</p>
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

            <div className="pt-2 border-t border-border">
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
