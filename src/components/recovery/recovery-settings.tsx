'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { toast } from 'sonner'
import {
  Ban,
  CheckCircle2,
  Clock,
  Loader2,
  MessageSquareText,
  PhoneOff,
  Store,
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

// ─── Types ──────────────────────────────────────────────────────────────────

interface RecoveryConfig {
  recovery_enabled: boolean
  recovery_delay1_minutes: number
  recovery_delay2_minutes: number
  recovery_delay3_minutes: number
  recovery_cooldown_days: number
  // One template per reminder (1 / 2 / 3), per language family.
  recovery_template1_name_es: string | null
  recovery_template2_name_es: string | null
  recovery_template3_name_es: string | null
  recovery_template_lang_es: string | null
  recovery_template1_name_en: string | null
  recovery_template2_name_en: string | null
  recovery_template3_name_en: string | null
  recovery_template_lang_en: string | null
  recovery_stop_keywords: string[]
}

interface RecoveryCounts {
  active: number
  done: number
  completed_order: number
  skipped_no_phone: number
  suppressed_cooldown: number
  opted_out: number
}

interface ApprovedTpl {
  name: string
  language: string
  body_text: string
}

const DEFAULTS: RecoveryConfig = {
  recovery_enabled: false,
  recovery_delay1_minutes: 45,
  recovery_delay2_minutes: 1440,
  recovery_delay3_minutes: 2880,
  recovery_cooldown_days: 7,
  recovery_template1_name_es: null,
  recovery_template2_name_es: null,
  recovery_template3_name_es: null,
  recovery_template_lang_es: 'es',
  recovery_template1_name_en: null,
  recovery_template2_name_en: null,
  recovery_template3_name_en: null,
  recovery_template_lang_en: 'en_US',
  recovery_stop_keywords: ['stop', 'baja', 'parar', 'unsubscribe'],
}

// Composite key for the template <Select> (a template is unique by name+lang).
const SEP = ':::'
const tplKey = (name: string | null, language: string | null) =>
  name && language ? `${name}${SEP}${language}` : ''

// ─── Approved-template dropdown (same pattern as the COD settings page) ───────

function ApprovedTemplateSelect({
  templates,
  name,
  language,
  onChange,
}: {
  templates: ApprovedTpl[]
  name: string | null
  language: string | null
  onChange: (name: string, language: string) => void
}) {
  return (
    <Select
      value={tplKey(name, language)}
      onValueChange={(v) => {
        const tpl = templates.find((t) => tplKey(t.name, t.language) === v)
        if (tpl) onChange(tpl.name, tpl.language)
      }}
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
              {t.name} <span className="text-muted-foreground">({t.language})</span>
            </SelectItem>
          ))
        )}
      </SelectContent>
    </Select>
  )
}

// ─── One reminder's template pickers (Spanish + English) ──────────────────────
// Each reminder (1/2/3) gets its own approved template per language family.
// The shared family language hint is updated when a template is picked.

type EsNameKey =
  | 'recovery_template1_name_es'
  | 'recovery_template2_name_es'
  | 'recovery_template3_name_es'
type EnNameKey =
  | 'recovery_template1_name_en'
  | 'recovery_template2_name_en'
  | 'recovery_template3_name_en'

function ReminderTemplateRow({
  stage,
  label,
  templates,
  config,
  set,
}: {
  stage: 1 | 2 | 3
  label: string
  templates: ApprovedTpl[]
  config: RecoveryConfig
  set: <K extends keyof RecoveryConfig>(key: K, value: RecoveryConfig[K]) => void
}) {
  const esKey = `recovery_template${stage}_name_es` as EsNameKey
  const enKey = `recovery_template${stage}_name_en` as EnNameKey
  return (
    <div className="space-y-3 rounded-lg border border-border bg-muted/20 p-4">
      <p className="font-heading text-sm font-semibold text-foreground">{label}</p>
      <div className="space-y-2">
        <Label className="text-xs text-muted-foreground">Spanish</Label>
        <ApprovedTemplateSelect
          templates={templates}
          name={config[esKey]}
          language={config.recovery_template_lang_es}
          onChange={(name, language) => {
            set(esKey, name)
            set('recovery_template_lang_es', language)
          }}
        />
      </div>
      <div className="space-y-2">
        <Label className="text-xs text-muted-foreground">English</Label>
        <ApprovedTemplateSelect
          templates={templates}
          name={config[enKey]}
          language={config.recovery_template_lang_en}
          onChange={(name, language) => {
            set(enKey, name)
            set('recovery_template_lang_en', language)
          }}
        />
      </div>
    </div>
  )
}

// ─── Delay field: minute-backed, shown in human units ────────────────────────
// Stores canonical minutes on the config; the unit (minutes/hours) is a
// display choice the merchant can flip. Hours is offered only when the value
// is a whole number of hours, so we never silently round.

function DelayField({
  id,
  label,
  minutes,
  onChange,
}: {
  id: string
  label: string
  minutes: number
  onChange: (minutes: number) => void
}) {
  const startsAsHours = minutes % 60 === 0 && minutes >= 60
  const [unit, setUnit] = useState<'minutes' | 'hours'>(startsAsHours ? 'hours' : 'minutes')
  const display = unit === 'hours' ? minutes / 60 : minutes

  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      <div className="flex items-center gap-2">
        <Input
          id={id}
          type="number"
          min={0}
          value={display}
          onChange={(e) => {
            const n = Number(e.target.value)
            onChange(unit === 'hours' ? Math.round(n * 60) : Math.round(n))
          }}
          className="w-28"
        />
        <Select value={unit} onValueChange={(v) => setUnit(v as 'minutes' | 'hours')}>
          <SelectTrigger className="w-32">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="minutes">minutes</SelectItem>
            <SelectItem value="hours">hours</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <p className="text-xs text-muted-foreground">After checkout abandoned ({minutes} min total)</p>
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
  icon: typeof CheckCircle2
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

export function RecoverySettings() {
  const supabase = createClient()

  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [connected, setConnected] = useState(false)
  const [config, setConfig] = useState<RecoveryConfig>(DEFAULTS)
  const [counts, setCounts] = useState<RecoveryCounts>({
    active: 0,
    done: 0,
    completed_order: 0,
    skipped_no_phone: 0,
    suppressed_cooldown: 0,
    opted_out: 0,
  })
  const [templates, setTemplates] = useState<ApprovedTpl[]>([])
  // Stop keywords edited as raw text (comma/newline separated) for a natural
  // editing feel; parsed to an array on save.
  const [keywordsText, setKeywordsText] = useState('')

  const set = useCallback(<K extends keyof RecoveryConfig>(key: K, value: RecoveryConfig[K]) => {
    setConfig((c) => ({ ...c, [key]: value }))
  }, [])

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      setLoading(true)
      try {
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

        const res = await fetch('/api/shopify/recovery-config')
        const data = await res.json()
        if (cancelled) return
        if (!data.connected) {
          setConnected(false)
          return
        }
        setConnected(true)
        setCounts((prev) => ({ ...prev, ...(data.counts ?? {}) }))
        const c = data.config ?? {}
        const merged: RecoveryConfig = {
          recovery_enabled: c.recovery_enabled ?? DEFAULTS.recovery_enabled,
          recovery_delay1_minutes: c.recovery_delay1_minutes ?? DEFAULTS.recovery_delay1_minutes,
          recovery_delay2_minutes: c.recovery_delay2_minutes ?? DEFAULTS.recovery_delay2_minutes,
          recovery_delay3_minutes: c.recovery_delay3_minutes ?? DEFAULTS.recovery_delay3_minutes,
          recovery_cooldown_days: c.recovery_cooldown_days ?? DEFAULTS.recovery_cooldown_days,
          recovery_template1_name_es: c.recovery_template1_name_es ?? null,
          recovery_template2_name_es: c.recovery_template2_name_es ?? null,
          recovery_template3_name_es: c.recovery_template3_name_es ?? null,
          recovery_template_lang_es: c.recovery_template_lang_es ?? 'es',
          recovery_template1_name_en: c.recovery_template1_name_en ?? null,
          recovery_template2_name_en: c.recovery_template2_name_en ?? null,
          recovery_template3_name_en: c.recovery_template3_name_en ?? null,
          recovery_template_lang_en: c.recovery_template_lang_en ?? 'en_US',
          recovery_stop_keywords: Array.isArray(c.recovery_stop_keywords)
            ? c.recovery_stop_keywords
            : DEFAULTS.recovery_stop_keywords,
        }
        setConfig(merged)
        setKeywordsText(merged.recovery_stop_keywords.join(', '))
      } catch (err) {
        console.error('[recovery-settings] load failed:', err)
        if (!cancelled) toast.error('Failed to load recovery settings')
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function parseKeywords(raw: string): string[] {
    return Array.from(
      new Set(
        raw
          .split(/[\n,]/)
          .map((k) => k.trim().toLowerCase())
          .filter(Boolean),
      ),
    )
  }

  async function handleSave() {
    const anyTemplate =
      config.recovery_template1_name_es ||
      config.recovery_template2_name_es ||
      config.recovery_template3_name_es ||
      config.recovery_template1_name_en ||
      config.recovery_template2_name_en ||
      config.recovery_template3_name_en
    if (config.recovery_enabled && !anyTemplate) {
      toast.error('Pick at least one reminder template before enabling recovery.')
      return
    }
    setSaving(true)
    try {
      const payload = { ...config, recovery_stop_keywords: parseKeywords(keywordsText) }
      const res = await fetch('/api/shopify/recovery-config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Save failed')
      toast.success('Recovery settings saved')
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
          <h1 className="font-heading text-2xl font-bold text-foreground">Cart Recovery</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Win back abandoned checkouts with up to 3 WhatsApp reminders.
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
              Recovery settings live on your connected store. Connect Shopify first, then come back to
              configure the recovery flow.
            </p>
            <Button render={<Link href="/shopify" />}>Connect Shopify</Button>
          </CardContent>
        </Card>
      ) : (
        <>
          {/* Live status */}
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatCard label="Active" value={counts.active} icon={Clock} tone="bg-amber-500/15 text-amber-500" />
            <StatCard label="Recovered" value={counts.completed_order} icon={CheckCircle2} tone="bg-primary/15 text-primary" />
            <StatCard label="Opted out" value={counts.opted_out} icon={Ban} tone="bg-rose-500/15 text-rose-500" />
            <StatCard label="Skipped (no phone)" value={counts.skipped_no_phone} icon={PhoneOff} tone="bg-slate-500/15 text-slate-400" />
          </div>

          {/* Master toggle */}
          <Card>
            <CardContent className="flex items-center justify-between gap-4 p-5">
              <div>
                <p className="font-heading font-semibold text-foreground">Cart recovery automation</p>
                <p className="text-sm text-muted-foreground">
                  Master switch — when off, no recovery reminders are sent for new abandoned checkouts.
                </p>
              </div>
              <Switch
                checked={config.recovery_enabled}
                onCheckedChange={(v) => set('recovery_enabled', v)}
              />
            </CardContent>
          </Card>

          {/* Reminder timing */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <Clock className="h-4 w-4 text-primary" />
                Reminder timing
              </CardTitle>
              <CardDescription>
                When each reminder is sent after a checkout is abandoned. A reminder is skipped if the
                checkout converts to an order or the customer opts out.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                <DelayField
                  id="d1"
                  label="1st reminder"
                  minutes={config.recovery_delay1_minutes}
                  onChange={(m) => set('recovery_delay1_minutes', m)}
                />
                <DelayField
                  id="d2"
                  label="2nd reminder"
                  minutes={config.recovery_delay2_minutes}
                  onChange={(m) => set('recovery_delay2_minutes', m)}
                />
                <DelayField
                  id="d3"
                  label="3rd reminder"
                  minutes={config.recovery_delay3_minutes}
                  onChange={(m) => set('recovery_delay3_minutes', m)}
                />
              </div>
              <div className="space-y-2 border-t border-border pt-4">
                <Label htmlFor="cooldown">Cooldown between sequences (days)</Label>
                <Input
                  id="cooldown"
                  type="number"
                  min={0}
                  value={config.recovery_cooldown_days}
                  onChange={(e) => set('recovery_cooldown_days', Math.round(Number(e.target.value)))}
                  className="w-28"
                />
                <p className="text-xs text-muted-foreground">
                  Don&rsquo;t start a new sequence if the same customer already received a recovery within
                  this many days.
                </p>
              </div>
            </CardContent>
          </Card>

          {/* Templates */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <MessageSquareText className="h-4 w-4 text-primary" />
                Recovery templates
              </CardTitle>
              <CardDescription>
                Pick a separate approved template for each reminder. The language is chosen
                automatically from the checkout&rsquo;s locale ({'{{1}}'} = customer first name,
                {' '}{'{{2}}'} = cart total, plus a dynamic recovery-link button). English slots are
                optional until you connect an English store.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <ReminderTemplateRow
                stage={1}
                label="Reminder 1"
                templates={templates}
                config={config}
                set={set}
              />
              <ReminderTemplateRow
                stage={2}
                label="Reminder 2"
                templates={templates}
                config={config}
                set={set}
              />
              <ReminderTemplateRow
                stage={3}
                label="Reminder 3"
                templates={templates}
                config={config}
                set={set}
              />
            </CardContent>
          </Card>

          {/* Opt-out keywords */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <Ban className="h-4 w-4 text-rose-500" />
                Opt-out keywords
              </CardTitle>
              <CardDescription>
                If a customer replies to a recovery message with one of these words, their current
                recovery sequence stops. Matching is case- and accent-insensitive. A future checkout
                still starts a new sequence. Separate words with commas or new lines.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-2">
              <Textarea
                rows={2}
                placeholder="stop, baja, parar, unsubscribe"
                value={keywordsText}
                onChange={(e) => setKeywordsText(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                Opt-out only stops cart recovery — it never affects COD confirmations.
              </p>
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
