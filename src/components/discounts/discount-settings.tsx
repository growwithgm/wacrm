'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { toast } from 'sonner'
import {
  AlertTriangle,
  Loader2,
  Percent,
  Plus,
  Store,
  Tag,
  Ticket,
  Trash2,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'

// ─── Types ──────────────────────────────────────────────────────────────────

interface Discount {
  id: string
  label: string
  percentage: number
  expiry_days: number | null
  min_order_amount: number | null
  enabled: boolean
}

interface DiscountCode {
  id: string
  discount_id: string
  contact_id: string | null
  code: string
  status: string
  percentage: number | null
  expires_at: string | null
  created_at: string
}

const EMPTY_FORM = {
  label: '',
  percentage: '',
  expiry_days: '',
  min_order_amount: '',
}

// ─── Main panel ───────────────────────────────────────────────────────────────

export function DiscountSettings() {
  const [loading, setLoading] = useState(true)
  const [connected, setConnected] = useState(false)
  const [hasScope, setHasScope] = useState(false)
  const [discounts, setDiscounts] = useState<Discount[]>([])
  const [codes, setCodes] = useState<DiscountCode[]>([])

  const [form, setForm] = useState({ ...EMPTY_FORM })
  const [creating, setCreating] = useState(false)
  // id of the discount currently generating a test code (for per-row spinner).
  const [generatingId, setGeneratingId] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/shopify/discounts')
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Failed to load')
      setConnected(!!data.connected)
      setHasScope(!!data.hasDiscountScope)
      setDiscounts(data.discounts ?? [])
      setCodes(data.codes ?? [])
    } catch (err) {
      console.error('[discount-settings] load failed:', err)
      toast.error('Failed to load discounts')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  async function handleCreate() {
    if (!form.label.trim()) {
      toast.error('Enter a label')
      return
    }
    const pct = Number(form.percentage)
    if (!Number.isFinite(pct) || pct <= 0 || pct > 100) {
      toast.error('Percentage must be between 0 and 100')
      return
    }
    setCreating(true)
    try {
      const res = await fetch('/api/shopify/discounts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          label: form.label.trim(),
          percentage: pct,
          expiry_days: form.expiry_days === '' ? null : Number(form.expiry_days),
          min_order_amount: form.min_order_amount === '' ? null : Number(form.min_order_amount),
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Failed to create')
      setForm({ ...EMPTY_FORM })
      toast.success('Discount created')
      await load()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to create')
    } finally {
      setCreating(false)
    }
  }

  async function handleToggle(d: Discount, enabled: boolean) {
    // Optimistic — revert on error.
    setDiscounts((prev) => prev.map((x) => (x.id === d.id ? { ...x, enabled } : x)))
    const res = await fetch('/api/shopify/discounts', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: d.id, enabled }),
    })
    if (!res.ok) {
      setDiscounts((prev) => prev.map((x) => (x.id === d.id ? { ...x, enabled: !enabled } : x)))
      toast.error('Failed to update')
    }
  }

  async function handleDelete(d: Discount) {
    if (!confirm(`Delete "${d.label}"? Generated codes stay valid on Shopify but are removed from history.`)) {
      return
    }
    const res = await fetch(`/api/shopify/discounts?id=${encodeURIComponent(d.id)}`, {
      method: 'DELETE',
    })
    if (!res.ok) {
      toast.error('Failed to delete')
      return
    }
    toast.success('Discount deleted')
    await load()
  }

  async function handleGenerateTest(d: Discount) {
    setGeneratingId(d.id)
    try {
      const res = await fetch('/api/shopify/discounts/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // No contact_id → a standalone test code.
        body: JSON.stringify({ discount_id: d.id }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Failed to generate')
      toast.success(`Test code created on Shopify: ${data.code}`)
      await load()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to generate')
    } finally {
      setGeneratingId(null)
    }
  }

  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-heading text-2xl font-bold text-foreground">Discounts</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Define percentage discounts and generate per-customer single-use codes on Shopify.
        </p>
      </div>

      {!connected ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
            <Store className="h-8 w-8 text-muted-foreground" />
            <p className="font-heading font-semibold text-foreground">No Shopify store connected</p>
            <p className="max-w-sm text-sm text-muted-foreground">
              Discount codes are created on your Shopify store. Connect Shopify first, then come back
              to define discounts.
            </p>
            <Button render={<Link href="/shopify" />}>Connect Shopify</Button>
          </CardContent>
        </Card>
      ) : (
        <>
          {/* Scope warning — generation needs write_discounts. */}
          {!hasScope && (
            <Card className="border-amber-500/40 bg-amber-500/5">
              <CardContent className="flex items-start gap-3 p-5">
                <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-500" />
                <div className="space-y-1">
                  <p className="font-heading font-semibold text-foreground">
                    Reconnect Shopify to enable code generation
                  </p>
                  <p className="text-sm text-muted-foreground">
                    Generating codes needs the <code className="text-foreground">write_discounts</code>{' '}
                    permission, which your current connection doesn&rsquo;t have. Reconnect your store to
                    grant it — your existing data is preserved.
                  </p>
                  <Button render={<Link href="/shopify" />} variant="outline" size="sm" className="mt-2">
                    Reconnect Shopify
                  </Button>
                </div>
              </CardContent>
            </Card>
          )}

          {/* Create a discount */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <Percent className="h-4 w-4 text-primary" />
                New discount
              </CardTitle>
              <CardDescription>
                Define a percentage discount. Min order and expiry are optional.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="d-label">Label</Label>
                  <Input
                    id="d-label"
                    placeholder="e.g. Welcome 10%"
                    value={form.label}
                    onChange={(e) => setForm((f) => ({ ...f, label: e.target.value }))}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="d-pct">Percentage (%)</Label>
                  <Input
                    id="d-pct"
                    type="number"
                    min={1}
                    max={100}
                    placeholder="10"
                    value={form.percentage}
                    onChange={(e) => setForm((f) => ({ ...f, percentage: e.target.value }))}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="d-exp">Expiry (days, optional)</Label>
                  <Input
                    id="d-exp"
                    type="number"
                    min={1}
                    placeholder="No expiry"
                    value={form.expiry_days}
                    onChange={(e) => setForm((f) => ({ ...f, expiry_days: e.target.value }))}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="d-min">Minimum order amount (optional)</Label>
                  <Input
                    id="d-min"
                    type="number"
                    min={0}
                    step="0.01"
                    placeholder="No minimum"
                    value={form.min_order_amount}
                    onChange={(e) => setForm((f) => ({ ...f, min_order_amount: e.target.value }))}
                  />
                </div>
              </div>
              <div className="flex justify-end">
                <Button onClick={handleCreate} disabled={creating}>
                  {creating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
                  Add discount
                </Button>
              </div>
            </CardContent>
          </Card>

          {/* Existing discounts */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <Tag className="h-4 w-4 text-primary" />
                Your discounts
              </CardTitle>
              <CardDescription>
                Enable/disable, delete, or generate a single-use test code to verify it appears in
                Shopify Admin → Discounts.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {discounts.length === 0 ? (
                <p className="py-6 text-center text-sm text-muted-foreground">
                  No discounts yet — create one above.
                </p>
              ) : (
                discounts.map((d) => (
                  <div
                    key={d.id}
                    className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-muted/20 p-4"
                  >
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-heading text-sm font-bold text-foreground">{d.label}</span>
                        <span className="rounded-full bg-primary/15 px-2 py-0.5 text-xs font-bold text-primary">
                          {Number(d.percentage)}%
                        </span>
                      </div>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {d.expiry_days ? `Expires ${d.expiry_days}d after generation` : 'No expiry'}
                        {' · '}
                        {d.min_order_amount != null ? `Min order ${Number(d.min_order_amount).toFixed(2)}` : 'No minimum'}
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => handleGenerateTest(d)}
                        disabled={generatingId === d.id || !hasScope}
                        title={hasScope ? 'Create a test code on Shopify' : 'Reconnect Shopify with write_discounts first'}
                      >
                        {generatingId === d.id ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          <Ticket className="h-4 w-4" />
                        )}
                        Generate test code
                      </Button>
                      <Switch checked={d.enabled} onCheckedChange={(v) => handleToggle(d, v)} />
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => handleDelete(d)}
                        className="text-muted-foreground hover:text-rose-500"
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                ))
              )}
            </CardContent>
          </Card>

          {/* Recent generated codes */}
          {codes.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <Ticket className="h-4 w-4 text-primary" />
                  Recent codes
                </CardTitle>
                <CardDescription>The latest single-use codes generated on Shopify.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-2">
                {codes.map((c) => (
                  <div
                    key={c.id}
                    className="flex items-center justify-between gap-3 rounded-lg border border-border bg-muted/20 px-3 py-2 text-sm"
                  >
                    <code className="font-mono font-semibold text-foreground">{c.code}</code>
                    <div className="flex items-center gap-3 text-xs text-muted-foreground">
                      {c.percentage != null && <span>{Number(c.percentage)}%</span>}
                      <span className="capitalize">{c.status}</span>
                      <span>{new Date(c.created_at).toLocaleDateString()}</span>
                    </div>
                  </div>
                ))}
              </CardContent>
            </Card>
          )}
        </>
      )}
    </div>
  )
}
