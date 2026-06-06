'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { toast } from 'sonner'
import {
  BadgeCheck,
  CheckCircle2,
  Clock,
  Loader2,
  MessageSquareText,
  PackageCheck,
  Store,
  XCircle,
} from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'

// ─── Types ──────────────────────────────────────────────────────────────────

interface CodConfig {
  cod_enabled: boolean
  cod_template_name: string | null
  cod_template_language: string | null
  cod_thankyou_enabled: boolean
  cod_thankyou_template_name: string | null
  cod_thankyou_template_language: string | null
  cod_reminders_enabled: boolean
  cod_reminder_count: number
  cod_reminder1_hours: number
  cod_reminder2_hours: number
  cod_noreply_hours: number
}

interface CodCounts {
  pending: number
  confirmed: number
  cancel_requested: number
  no_reply: number
}

interface ApprovedTpl {
  name: string
  language: string
}

const DEFAULTS: CodConfig = {
  cod_enabled: true,
  cod_template_name: null,
  cod_template_language: null,
  cod_thankyou_enabled: false,
  cod_thankyou_template_name: null,
  cod_thankyou_template_language: null,
  cod_reminders_enabled: true,
  cod_reminder_count: 2,
  cod_reminder1_hours: 24,
  cod_reminder2_hours: 48,
  cod_noreply_hours: 72,
}

// Composite key for the template <Select> (a template is unique by name+lang).
const SEP = ':::'
const tplKey = (name: string | null, language: string | null) =>
  name && language ? `${name}${SEP}${language}` : ''

// ─── Approved-template dropdown (reused for confirmation + thank-you) ─────────

function ApprovedTemplateSelect({
  templates,
  name,
  language,
  onChange,
  disabled,
}: {
  templates: ApprovedTpl[]
  name: string | null
  language: string | null
  onChange: (name: string, language: string) => void
  disabled?: boolean
}) {
  return (
    <Select
      value={tplKey(name, language)}
      onValueChange={(v) => {
        const tpl = templates.find((t) => tplKey(t.name, t.language) === v)
        if (tpl) onChange(tpl.name, tpl.language)
      }}
      disabled={disabled}
    >
      <SelectTrigger className="w-full max-w-md">
        <SelectValue placeholder="Select an approved template" />
      </SelectTrigger>
      <SelectContent>
        {templates.length === 0 ? (
          <SelectItem value="__none" disabled>
            No approved templates — sync templates first
          </SelectItem>
        ) : (
          templates.map((t) => (
            <SelectItem key={tplKey(t.name, t.language)} value={tplKey(t.name, t.language)}>
              {t.name}{' '}
              <span className="text-muted-foreground">({t.language})</span>
            </SelectItem>
          ))
        )}
      </SelectContent>
    </Select>
  )
}

function StatCard({
  label,
  value,
  icon: Icon,
  tone,
}: {
  label: string
  value: number
  icon: typeof BadgeCheck
  tone: string
}) {
  return (
    <Card>
      <CardContent className="flex items-center gap-3 p-4">
        <div className={`flex h-10 w-10 items-center justify-center rounded-xl ${tone}`}>
          <Icon className="h-5 w-5" />
        </div>
        <div>
          <p className="font-heading text-2xl font-bold text-foreground">{value}</p>
          <p className="text-xs text-muted-foreground">{label}</p>
        </div>
      </CardContent>
    </Card>
  )
}

// ─── Main panel ───────────────────────────────────────────────────────────────

export function CodSettings() {
  const supabase = createClient()

  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [connected, setConnected] = useState(false)
  const [config, setConfig] = useState<CodConfig>(DEFAULTS)
  const [counts, setCounts] = useState<CodCounts>({
    pending: 0,
    confirmed: 0,
    cancel_requested: 0,
    no_reply: 0,
  })
  const [templates, setTemplates] = useState<ApprovedTpl[]>([])

  const set = useCallback(<K extends keyof CodConfig>(key: K, value: CodConfig[K]) => {
    setConfig((c) => ({ ...c, [key]: value }))
  }, [])

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      setLoading(true)
      try {
        // Approved templates (same source the inbox picker uses — reflects
        // whatever is synced from Meta, so newly-approved templates appear).
        const {
          data: { user },
        } = await supabase.auth.getUser()
        if (user) {
          const { data: tpls } = await supabase
            .from('message_templates')
            .select('name, language, status')
            .eq('user_id', user.id)
            .eq('status', 'Approved')
            .order('created_at', { ascending: false })
          if (!cancelled) {
            const seen = new Set<string>()
            const list: ApprovedTpl[] = []
            for (const t of (tpls as ApprovedTpl[]) ?? []) {
              const key = tplKey(t.name, t.language)
              if (!t.name || !t.language || seen.has(key)) continue
              seen.add(key)
              list.push({ name: t.name, language: t.language })
            }
            setTemplates(list)
          }
        }

        const res = await fetch('/api/shopify/cod-config')
        const data = await res.json()
        if (cancelled) return
        if (!data.connected) {
          setConnected(false)
          return
        }
        setConnected(true)
        setCounts(data.counts ?? counts)
        // Merge server values over defaults (nulls fall back to defaults for
        // the non-nullable fields).
        const c = data.config ?? {}
        setConfig({
          cod_enabled: c.cod_enabled ?? DEFAULTS.cod_enabled,
          cod_template_name: c.cod_template_name ?? null,
          cod_template_language: c.cod_template_language ?? null,
          cod_thankyou_enabled: c.cod_thankyou_enabled ?? DEFAULTS.cod_thankyou_enabled,
          cod_thankyou_template_name: c.cod_thankyou_template_name ?? null,
          cod_thankyou_template_language: c.cod_thankyou_template_language ?? null,
          cod_reminders_enabled: c.cod_reminders_enabled ?? DEFAULTS.cod_reminders_enabled,
          cod_reminder_count: c.cod_reminder_count ?? DEFAULTS.cod_reminder_count,
          cod_reminder1_hours: c.cod_reminder1_hours ?? DEFAULTS.cod_reminder1_hours,
          cod_reminder2_hours: c.cod_reminder2_hours ?? DEFAULTS.cod_reminder2_hours,
          cod_noreply_hours: c.cod_noreply_hours ?? DEFAULTS.cod_noreply_hours,
        })
      } catch (err) {
        console.error('[cod-settings] load failed:', err)
        if (!cancelled) toast.error('Failed to load COD settings')
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function handleSave() {
    // Guard: if a step is enabled it needs a template.
    if (config.cod_enabled && !config.cod_template_name) {
      toast.error('Pick a confirmation template (Step 1) before saving.')
      return
    }
    if (config.cod_thankyou_enabled && !config.cod_thankyou_template_name) {
      toast.error('Pick a thank-you template (Step 3) or turn the thank-you off.')
      return
    }
    setSaving(true)
    try {
      const res = await fetch('/api/shopify/cod-config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Save failed')
      toast.success('COD settings saved')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Save failed')
    } finally {
      setSaving(false)
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
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="font-heading text-2xl font-bold text-foreground">COD Confirmation</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Configure the cash-on-delivery confirmation flow over WhatsApp.
          </p>
        </div>
        {connected && (
          <Button onClick={handleSave} disabled={saving}>
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            Save changes
          </Button>
        )}
      </div>

      {!connected ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
            <Store className="h-8 w-8 text-muted-foreground" />
            <p className="font-heading font-semibold text-foreground">No Shopify store connected</p>
            <p className="max-w-sm text-sm text-muted-foreground">
              COD settings live on your connected store. Connect Shopify first, then come back to
              configure the confirmation flow.
            </p>
            <Button render={<Link href="/shopify" />}>Connect Shopify</Button>
          </CardContent>
        </Card>
      ) : (
        <>
          {/* Live status */}
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatCard label="Pending" value={counts.pending} icon={Clock} tone="bg-amber-500/15 text-amber-500" />
            <StatCard label="Confirmed" value={counts.confirmed} icon={CheckCircle2} tone="bg-primary/15 text-primary" />
            <StatCard label="Cancelled" value={counts.cancel_requested} icon={XCircle} tone="bg-rose-500/15 text-rose-500" />
            <StatCard label="No reply" value={counts.no_reply} icon={Clock} tone="bg-slate-500/15 text-slate-400" />
          </div>

          {/* Master toggle */}
          <Card>
            <CardContent className="flex items-center justify-between gap-4 p-5">
              <div>
                <p className="font-heading font-semibold text-foreground">COD automation</p>
                <p className="text-sm text-muted-foreground">
                  Master switch — when off, no confirmation messages, reminders, or tags are sent
                  for new COD orders.
                </p>
              </div>
              <Switch
                checked={config.cod_enabled}
                onCheckedChange={(v) => set('cod_enabled', v)}
              />
            </CardContent>
          </Card>

          {/* Step 1 — confirmation template */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <MessageSquareText className="h-4 w-4 text-primary" />
                Step 1 · Confirmation template
              </CardTitle>
              <CardDescription>
                The approved template sent immediately when a COD order arrives. Variables:
                {' '}<code className="text-xs">{'{{1}}'}</code> order number,{' '}
                <code className="text-xs">{'{{2}}'}</code> total.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-2">
              <Label>Template</Label>
              <ApprovedTemplateSelect
                templates={templates}
                name={config.cod_template_name}
                language={config.cod_template_language}
                onChange={(name, language) => {
                  set('cod_template_name', name)
                  set('cod_template_language', language)
                }}
              />
              {config.cod_template_name && (
                <p className="text-xs text-muted-foreground">
                  Selected: <span className="font-medium text-foreground">{config.cod_template_name}</span>{' '}
                  ({config.cod_template_language})
                </p>
              )}
            </CardContent>
          </Card>

          {/* Step 2 — reply handling (read-only) */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <BadgeCheck className="h-4 w-4 text-primary" />
                Step 2 · Reply handling
              </CardTitle>
              <CardDescription>
                How customer replies are matched. Accent- and case-insensitive (SÍ / Sí / si all
                match). Handled automatically by the engine.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-2">
              <div className="flex items-center gap-2 rounded-lg border border-border bg-muted/40 px-3 py-2 text-sm">
                <CheckCircle2 className="h-4 w-4 text-primary" />
                <span className="font-medium text-foreground">&ldquo;SÍ confirmo&rdquo;</span>
                <span className="text-muted-foreground">→ marks the order Confirmed</span>
              </div>
              <div className="flex items-center gap-2 rounded-lg border border-border bg-muted/40 px-3 py-2 text-sm">
                <XCircle className="h-4 w-4 text-rose-500" />
                <span className="font-medium text-foreground">&ldquo;NO cancelar&rdquo;</span>
                <span className="text-muted-foreground">→ marks the order Cancelled (manual review; never auto-cancelled)</span>
              </div>
            </CardContent>
          </Card>

          {/* Step 3 — thank-you */}
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between gap-4">
                <div>
                  <CardTitle className="flex items-center gap-2 text-base">
                    <PackageCheck className="h-4 w-4 text-primary" />
                    Step 3 · Thank-you message
                  </CardTitle>
                  <CardDescription>
                    Sent once after a customer confirms. The COD flow ends after it.
                  </CardDescription>
                </div>
                <Switch
                  checked={config.cod_thankyou_enabled}
                  onCheckedChange={(v) => set('cod_thankyou_enabled', v)}
                />
              </div>
            </CardHeader>
            {config.cod_thankyou_enabled && (
              <CardContent className="space-y-2">
                <Label>Thank-you template</Label>
                <ApprovedTemplateSelect
                  templates={templates}
                  name={config.cod_thankyou_template_name}
                  language={config.cod_thankyou_template_language}
                  onChange={(name, language) => {
                    set('cod_thankyou_template_name', name)
                    set('cod_thankyou_template_language', language)
                  }}
                />
                <p className="text-xs text-muted-foreground">
                  Body variables are auto-fitted to the template ({'{{1}}'} order, {'{{2}}'} total) —
                  a template with no variables also works.
                </p>
              </CardContent>
            )}
          </Card>

          {/* Step 4 — reminders */}
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between gap-4">
                <div>
                  <CardTitle className="flex items-center gap-2 text-base">
                    <Clock className="h-4 w-4 text-primary" />
                    Step 4 · Reminders
                  </CardTitle>
                  <CardDescription>
                    Re-send the confirmation template to customers who haven&rsquo;t replied.
                  </CardDescription>
                </div>
                <Switch
                  checked={config.cod_reminders_enabled}
                  onCheckedChange={(v) => set('cod_reminders_enabled', v)}
                />
              </div>
            </CardHeader>
            {config.cod_reminders_enabled && (
              <CardContent className="space-y-4">
                <div className="space-y-2">
                  <Label>How many reminders</Label>
                  <Select
                    value={String(config.cod_reminder_count)}
                    onValueChange={(v) => set('cod_reminder_count', Number(v))}
                  >
                    <SelectTrigger className="w-40">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="0">None</SelectItem>
                      <SelectItem value="1">1 reminder</SelectItem>
                      <SelectItem value="2">2 reminders</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                  <div className="space-y-2">
                    <Label htmlFor="r1">1st reminder after (hours)</Label>
                    <Input
                      id="r1"
                      type="number"
                      min={0}
                      value={config.cod_reminder1_hours}
                      onChange={(e) => set('cod_reminder1_hours', Number(e.target.value))}
                      disabled={config.cod_reminder_count < 1}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="r2">2nd reminder after (hours)</Label>
                    <Input
                      id="r2"
                      type="number"
                      min={0}
                      value={config.cod_reminder2_hours}
                      onChange={(e) => set('cod_reminder2_hours', Number(e.target.value))}
                      disabled={config.cod_reminder_count < 2}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="nr">Mark &ldquo;No reply&rdquo; after (hours)</Label>
                    <Input
                      id="nr"
                      type="number"
                      min={0}
                      value={config.cod_noreply_hours}
                      onChange={(e) => set('cod_noreply_hours', Number(e.target.value))}
                    />
                  </div>
                </div>
                <p className="text-xs text-muted-foreground">
                  At the &ldquo;No reply&rdquo; cutoff the order is tagged for review — it is never
                  auto-cancelled.
                </p>
              </CardContent>
            )}
          </Card>

          <div className="flex justify-end">
            <Button onClick={handleSave} disabled={saving}>
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              Save changes
            </Button>
          </div>
        </>
      )}
    </div>
  )
}
