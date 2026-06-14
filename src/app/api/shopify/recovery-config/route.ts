import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createClient as createAdminClient } from '@supabase/supabase-js'

// Service-role client for writes (mirrors /api/shopify/cod-config). Lazy so a
// missing env var doesn't crash the build.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _admin: any = null
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function db(): any {
  if (!_admin) {
    _admin = createAdminClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
    )
  }
  return _admin
}

// The recovery_* columns the panel reads/writes (migrations 026 + 027).
// Everything else on shopify_config is intentionally NOT exposed here.
const RECOVERY_FIELDS = [
  'recovery_enabled',
  'recovery_delay1_minutes',
  'recovery_delay2_minutes',
  'recovery_delay3_minutes',
  'recovery_cooldown_days',
  'recovery_template_name_es',
  'recovery_template_lang_es',
  'recovery_template_name_en',
  'recovery_template_lang_en',
  'recovery_stop_keywords',
] as const

// Recovery sequence statuses surfaced as live counts.
const RECOVERY_STATUSES = [
  'active',
  'done',
  'completed_order',
  'skipped_no_phone',
  'suppressed_cooldown',
  'opted_out',
] as const

/**
 * GET /api/shopify/recovery-config
 * Returns recovery settings + live sequence counts for the current user.
 */
export async function GET() {
  try {
    const supabase = await createClient()
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser()
    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { data: config } = await supabase
      .from('shopify_config')
      .select('*')
      .eq('user_id', user.id)
      .maybeSingle()

    if (!config) {
      // Recovery config lives on shopify_config — nothing to configure
      // until a store is connected. UI shows a "connect Shopify" state.
      return NextResponse.json({ connected: false })
    }

    const counts: Record<string, number> = {}
    await Promise.all(
      RECOVERY_STATUSES.map(async (status) => {
        const { count } = await supabase
          .from('checkout_recoveries')
          .select('id', { count: 'exact', head: true })
          .eq('user_id', user.id)
          .eq('status', status)
        counts[status] = count ?? 0
      }),
    )

    const recoveryConfig: Record<string, unknown> = {}
    for (const f of RECOVERY_FIELDS) recoveryConfig[f] = config[f] ?? null

    return NextResponse.json({ connected: true, config: recoveryConfig, counts })
  } catch (error) {
    console.error('[shopify/recovery-config GET] error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

/**
 * PUT /api/shopify/recovery-config
 * Saves recovery settings. Whitelisted fields only; template names must
 * reference an Approved template the user actually has synced.
 */
export async function PUT(request: Request) {
  try {
    const supabase = await createClient()
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser()
    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { data: config } = await supabase
      .from('shopify_config')
      .select('user_id')
      .eq('user_id', user.id)
      .maybeSingle()
    if (!config) {
      return NextResponse.json(
        { error: 'No Shopify store connected. Connect a store before configuring recovery.' },
        { status: 400 },
      )
    }

    const body = (await request.json()) as Record<string, unknown>

    const update: Record<string, unknown> = {}
    for (const f of RECOVERY_FIELDS) {
      if (!(f in body)) continue
      const v = body[f]
      if (f === 'recovery_enabled') {
        update[f] = Boolean(v)
      } else if (f.endsWith('_minutes')) {
        const n = Number(v)
        // Up to ~30 days in minutes — generous but bounded.
        if (!Number.isInteger(n) || n < 0 || n > 43200) {
          return NextResponse.json({ error: `${f} must be 0–43200 minutes` }, { status: 400 })
        }
        update[f] = n
      } else if (f === 'recovery_cooldown_days') {
        const n = Number(v)
        if (!Number.isInteger(n) || n < 0 || n > 365) {
          return NextResponse.json({ error: 'recovery_cooldown_days must be 0–365' }, { status: 400 })
        }
        update[f] = n
      } else if (f === 'recovery_stop_keywords') {
        if (v == null) {
          update[f] = []
        } else if (!Array.isArray(v)) {
          return NextResponse.json({ error: 'recovery_stop_keywords must be an array' }, { status: 400 })
        } else {
          // Normalize: trim, drop empties, lowercase, dedupe, cap count + length.
          const cleaned = Array.from(
            new Set(
              v
                .map((k) => String(k).trim().toLowerCase())
                .filter((k) => k.length > 0 && k.length <= 64),
            ),
          ).slice(0, 50)
          update[f] = cleaned
        }
      } else {
        // template name / language — allow null to clear, else trimmed string
        update[f] = v == null || v === '' ? null : String(v)
      }
    }

    // Validate any template names against the user's Approved templates.
    const nameFields: ('recovery_template_name_es' | 'recovery_template_name_en')[] = [
      'recovery_template_name_es',
      'recovery_template_name_en',
    ]
    for (const nf of nameFields) {
      const name = update[nf]
      if (typeof name === 'string' && name.length > 0) {
        const { data: tpl } = await supabase
          .from('message_templates')
          .select('id')
          .eq('user_id', user.id)
          .eq('name', name)
          .eq('status', 'Approved')
          .limit(1)
          .maybeSingle()
        if (!tpl) {
          return NextResponse.json(
            { error: `Template "${name}" is not an approved template. Sync templates and pick an Approved one.` },
            { status: 400 },
          )
        }
      }
    }

    if (Object.keys(update).length === 0) {
      return NextResponse.json({ error: 'No valid recovery fields to update' }, { status: 400 })
    }

    update.updated_at = new Date().toISOString()

    const { error: updErr } = await db()
      .from('shopify_config')
      .update(update)
      .eq('user_id', user.id)
    if (updErr) {
      console.error('[shopify/recovery-config PUT] update failed:', updErr.message)
      return NextResponse.json({ error: updErr.message }, { status: 500 })
    }

    return NextResponse.json({ success: true })
  } catch (error) {
    console.error('[shopify/recovery-config PUT] error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
