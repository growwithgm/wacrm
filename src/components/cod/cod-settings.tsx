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
  Reply,
  Store,
  XCircle,
} from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
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
import { COD_FIELD_OPTIONS, countPlaceholders } from '@/lib/cod/fields'

// ─── Types ──────────────────────────────────────────────────────────────────

type VarMap = Record<string, string>

interface CodConfig {
  cod_enabled: boolean
  cod_template_name: string | null
  cod_template_language: string | null
  cod_confirm_var_map: VarMap
  cod_thankyou_enabled: boolean
  cod_thankyou_template_name: string | null
  cod_thankyou_template_language: string | null
  cod_thankyou_var_map: VarMap
  cod_reminders_enabled: boolean
  cod_reminder_count: number
  cod_reminder1_hours: number
  cod_reminder2_hours: number
  cod_noreply_hours: number
  cod_yes_message_enabled: boolean
  cod_yes_message_text: string
  cod_no_message_enabled: boolean
  cod_no_message_text: string
  cod_cancel_template_enabled: boolean
  cod_cancel_template_name: string | null
  cod_cancel_template_language: string | null
  cod_cancel_var_map: VarMap
  cod_noreply_template_enabled: boolean
  cod_noreply_template_name: string | null
  cod_noreply_template_language: string | null
  cod_noreply_var_map: VarMap
}

interface CodCounts {
  pending: number
  confirmed: number
  cancel_requested: number
  cancelled: number
  no_reply: number
  no_reply_cancelled: number
}

interface ApprovedTpl {
  name: string
  language: string
  body_text: string
}

const DEFAULT_VAR_MAP: VarMap = { '1': 'order_number', '2': 'total' }

const DEFAULTS: CodConfig = {
  cod_enabled: true,
  cod_template_name: null,
  cod_template_language: null,
  cod_confirm_var_map: { ...DEFAULT_VAR_MAP },
  cod_thankyou_enabled: false,
  cod_thankyou_template_name: null,
  cod_thankyou_template_language: null,
  cod_thankyou_var_map: { ...DEFAULT_VAR_MAP },
  cod_reminders_enabled: true,
  cod_reminder_count: 2,
  cod_reminder1_hours: 24,
  cod_reminder2_hours: 48,
  cod_noreply_hours: 72,
  cod_yes_message_enabled: false,
  cod_yes_message_text: '',
  cod_no_message_enabled: false,
  cod_no_message_text: '',
  cod_cancel_template_enabled: false,
  cod_cancel_template_name: null,
  cod_cancel_template_language: null,
  cod_cancel_var_map: {},
  cod_noreply_template_enabled: false,
  cod_noreply_template_name: null,
  cod_noreply_template_language: null,
  cod_noreply_var_map: { ...DEFAULT_VAR_MAP },
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

// ─── Per-template variable mapping (Part A) ──────────────────────────────────
// One dropdown per {{n}} placeholder in the selected template's body, mapping
// it to an order-derived field. Reused for the confirmation, thank-you, and
// no-reply template slots.

function VariableMapping({
  templates,
  name,
  language,
  varMap,
  onChange,
}: {
  templates: ApprovedTpl[]
  name: string | null
  language: string | null
  varMap: VarMap
  onChange: (next: VarMap) => void
}) {
  if (!name) return null
  const tpl = templates.find((t) => t.name === name && t.language === language)
  const count = tpl ? countPlaceholders(tpl.body_text ?? '') : 0
  if (count === 0) {
    return <p className="text-xs text-muted-foreground">This template has no variables to map.</p>
  }
  return (
    <div className="space-y-2 rounded-lg border border-border bg-muted/30 p-3">
      <p className="text-xs font-medium text-foreground">Fill each variable with an order field:</p>
      {Array.from({ length: count }, (_, idx) => {
        const i = String(idx + 1)
        return (
          <div key={i} className="flex items-center gap-2">
            <code className="w-10 shrink-0 text-xs text-muted-foreground">{`{{${i}}}`}</code>
            <Select
              value={varMap[i] ?? ''}
              onValueChange={(v) => {
                if (v) onChange({ ...varMap, [i]: v })
              }}
            >
              <SelectTrigger className="w-full max-w-xs">
                <SelectValue placeholder="Choose a field" />
              </SelectTrigger>
              <SelectContent>
                {COD_FIELD_OPTIONS.map((o) => (
                  <SelectItem key={o.key} value={o.key}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )
      })}
    </div>
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
    cancelled: 0,
    no_reply: 0,
    no_reply_cancelled: 0,
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
            .select('name, language, status, body_text')
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
              list.push({ name: t.name, language: t.language, body_text: t.body_text ?? '' })
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
          cod_confirm_var_map: c.cod_confirm_var_map ?? { ...DEFAULT_VAR_MAP },
          cod_thankyou_enabled: c.cod_thankyou_enabled ?? DEFAULTS.cod_thankyou_enabled,
          cod_thankyou_template_name: c.cod_thankyou_template_name ?? null,
          cod_thankyou_template_language: c.cod_thankyou_template_language ?? null,
          cod_thankyou_var_map: c.cod_thankyou_var_map ?? { ...DEFAULT_VAR_MAP },
          cod_reminders_enabled: c.cod_reminders_enabled ?? DEFAULTS.cod_reminders_enabled,
          cod_reminder_count: c.cod_reminder_count ?? DEFAULTS.cod_reminder_count,
          cod_reminder1_hours: c.cod_reminder1_hours ?? DEFAULTS.cod_reminder1_hours,
          cod_reminder2_hours: c.cod_reminder2_hours ?? DEFAULTS.cod_reminder2_hours,
          cod_noreply_hours: c.cod_noreply_hours ?? DEFAULTS.cod_noreply_hours,
          cod_yes_message_enabled: c.cod_yes_message_enabled ?? DEFAULTS.cod_yes_message_enabled,
          cod_yes_message_text: c.cod_yes_message_text ?? '',
          cod_no_message_enabled: c.cod_no_message_enabled ?? DEFAULTS.cod_no_message_enabled,
          cod_no_message_text: c.cod_no_message_text ?? '',
          cod_cancel_template_enabled:
            c.cod_cancel_template_enabled ?? DEFAULTS.cod_cancel_template_enabled,
          cod_cancel_template_name: c.cod_cancel_template_name ?? null,
          cod_cancel_template_language: c.cod_cancel_template_language ?? null,
          cod_cancel_var_map: c.cod_cancel_var_map ?? {},
          cod_noreply_template_enabled:
            c.cod_noreply_template_enabled ?? DEFAULTS.cod_noreply_template_enabled,
          cod_noreply_template_name: c.cod_noreply_template_name ?? null,
          cod_noreply_template_language: c.cod_noreply_template_language ?? null,
          cod_noreply_var_map: c.cod_noreply_var_map ?? { ...DEFAULT_VAR_MAP },
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
    if (config.cod_yes_message_enabled && !config.cod_yes_message_text.trim()) {
      toast.error('Enter the “SÍ” reply text or turn it off.')
      return
    }
    if (config.cod_no_message_enabled && !config.cod_no_message_text.trim()) {
      toast.error('Enter the “NO” reply text or turn it off.')
      return
    }
    if (config.cod_cancel_template_enabled && !config.cod_cancel_template_name) {
      toast.error('Pick a cancel template (Reply responses) or turn it off.')
      return
    }
    if (config.cod_noreply_template_enabled && !config.cod_noreply_template_name) {
      toast.error('Pick a no-reply template (Reply responses) or turn it off.')
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
            <StatCard label="Cancelled" value={counts.cancelled + counts.cancel_requested} icon={XCircle} tone="bg-rose-500/15 text-rose-500" />
            <StatCard label="No-reply cancelled" value={counts.no_reply_cancelled + counts.no_reply} icon={Clock} tone="bg-slate-500/15 text-slate-400" />
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
                The approved template sent immediately when a COD order arrives. Map each of its
                variables to an order field below.
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
              <VariableMapping
                templates={templates}
                name={config.cod_template_name}
                language={config.cod_template_language}
                varMap={config.cod_confirm_var_map}
                onChange={(next) => set('cod_confirm_var_map', next)}
              />
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
                <span className="text-muted-foreground">→ flags the order as Cancel Requested (tagged for manual review — never auto-cancelled in Shopify)</span>
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
                <VariableMapping
                  templates={templates}
                  name={config.cod_thankyou_template_name}
                  language={config.cod_thankyou_template_language}
                  varMap={config.cod_thankyou_var_map}
                  onChange={(next) => set('cod_thankyou_var_map', next)}
                />
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

          {/* Part B — response messages per reply outcome */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <Reply className="h-4 w-4 text-primary" />
                Reply responses
              </CardTitle>
              <CardDescription>
                Optional messages after each reply outcome. Immediate SÍ/NO replies are inside the
                24h window, so you can send free text. The no-reply case is outside the window, so it
                must be an approved template.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-5">
              {/* On "SÍ confirmo" — free text */}
              <div className="space-y-2">
                <div className="flex items-center justify-between gap-4">
                  <div className="flex items-center gap-2">
                    <CheckCircle2 className="h-4 w-4 text-primary" />
                    <span className="text-sm font-medium text-foreground">
                      On &ldquo;SÍ confirmo&rdquo; — free text
                    </span>
                  </div>
                  <Switch
                    checked={config.cod_yes_message_enabled}
                    onCheckedChange={(v) => set('cod_yes_message_enabled', v)}
                  />
                </div>
                {config.cod_yes_message_enabled && (
                  <Textarea
                    rows={2}
                    placeholder="e.g. ¡Gracias! Tu pedido está confirmado y lo preparamos ahora."
                    value={config.cod_yes_message_text}
                    onChange={(e) => set('cod_yes_message_text', e.target.value)}
                  />
                )}
              </div>

              {/* On "NO cancelar" — free text */}
              <div className="space-y-2 border-t border-border pt-4">
                <div className="flex items-center justify-between gap-4">
                  <div className="flex items-center gap-2">
                    <XCircle className="h-4 w-4 text-rose-500" />
                    <span className="text-sm font-medium text-foreground">
                      On &ldquo;NO cancelar&rdquo; — free text
                    </span>
                  </div>
                  <Switch
                    checked={config.cod_no_message_enabled}
                    onCheckedChange={(v) => set('cod_no_message_enabled', v)}
                  />
                </div>
                {config.cod_no_message_enabled && (
                  <Textarea
                    rows={2}
                    placeholder="e.g. Hemos registrado tu solicitud de cancelación. Te contactaremos."
                    value={config.cod_no_message_text}
                    onChange={(e) => set('cod_no_message_text', e.target.value)}
                  />
                )}
              </div>

              {/* On "NO cancelar" — approved template (cancel acknowledgement) */}
              <div className="space-y-2 border-t border-border pt-4">
                <div className="flex items-center justify-between gap-4">
                  <div className="flex items-center gap-2">
                    <XCircle className="h-4 w-4 text-rose-500" />
                    <span className="text-sm font-medium text-foreground">
                      On &ldquo;NO cancelar&rdquo; — approved template
                    </span>
                  </div>
                  <Switch
                    checked={config.cod_cancel_template_enabled}
                    onCheckedChange={(v) => set('cod_cancel_template_enabled', v)}
                  />
                </div>
                {config.cod_cancel_template_enabled && (
                  <div className="space-y-2">
                    <p className="text-xs text-muted-foreground">
                      Sent when the customer replies NO — flips the order to Cancelled.
                    </p>
                    <ApprovedTemplateSelect
                      templates={templates}
                      name={config.cod_cancel_template_name}
                      language={config.cod_cancel_template_language}
                      onChange={(name, language) => {
                        set('cod_cancel_template_name', name)
                        set('cod_cancel_template_language', language)
                      }}
                    />
                    <VariableMapping
                      templates={templates}
                      name={config.cod_cancel_template_name}
                      language={config.cod_cancel_template_language}
                      varMap={config.cod_cancel_var_map}
                      onChange={(next) => set('cod_cancel_var_map', next)}
                    />
                  </div>
                )}
              </div>

              {/* After no reply — approved template (window closed) */}
              <div className="space-y-2 border-t border-border pt-4">
                <div className="flex items-center justify-between gap-4">
                  <div className="flex items-center gap-2">
                    <Clock className="h-4 w-4 text-slate-400" />
                    <span className="text-sm font-medium text-foreground">
                      After no reply — approved template
                    </span>
                  </div>
                  <Switch
                    checked={config.cod_noreply_template_enabled}
                    onCheckedChange={(v) => set('cod_noreply_template_enabled', v)}
                  />
                </div>
                {config.cod_noreply_template_enabled && (
                  <div className="space-y-2">
                    <p className="text-xs text-muted-foreground">
                      Sent at the &ldquo;No reply&rdquo; cutoff. The 24h window has closed, so only an
                      approved template can be used here.
                    </p>
                    <ApprovedTemplateSelect
                      templates={templates}
                      name={config.cod_noreply_template_name}
                      language={config.cod_noreply_template_language}
                      onChange={(name, language) => {
                        set('cod_noreply_template_name', name)
                        set('cod_noreply_template_language', language)
                      }}
                    />
                    <VariableMapping
                      templates={templates}
                      name={config.cod_noreply_template_name}
                      language={config.cod_noreply_template_language}
                      varMap={config.cod_noreply_var_map}
                      onChange={(next) => set('cod_noreply_var_map', next)}
                    />
                  </div>
                )}
              </div>
            </CardContent>
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
