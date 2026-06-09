import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createClient as createAdminClient } from '@supabase/supabase-js'
import { COD_FIELD_KEYS } from '@/lib/cod/fields'

// Service-role client for writes (mirrors /api/shopify/config). Lazy so a
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

// The COD columns the panel reads/writes. Everything else on shopify_config
// (tokens, connection state, tags) is intentionally NOT exposed here.
const COD_FIELDS = [
  'cod_enabled',
  'cod_template_name',
  'cod_template_language',
  'cod_confirm_var_map',
  'cod_thankyou_enabled',
  'cod_thankyou_template_name',
  'cod_thankyou_template_language',
  'cod_thankyou_var_map',
  'cod_reminders_enabled',
  'cod_reminder_count',
  'cod_reminder1_hours',
  'cod_reminder2_hours',
  'cod_noreply_hours',
  'cod_yes_message_enabled',
  'cod_yes_message_text',
  'cod_no_message_enabled',
  'cod_no_message_text',
  'cod_cancel_template_enabled',
  'cod_cancel_template_name',
  'cod_cancel_template_language',
  'cod_cancel_var_map',
  'cod_noreply_template_enabled',
  'cod_noreply_template_name',
  'cod_noreply_template_language',
  'cod_noreply_var_map',
] as const

// Statuses counted for the live panel. Includes the legacy values
// (cancel_requested, no_reply) so pre-flow rows still tally.
const COD_STATUSES = [
  'pending',
  'confirmed',
  'cancel_requested',
  'cancelled',
  'no_reply',
  'no_reply_cancelled',
] as const

/**
 * GET /api/shopify/cod-config
 * Returns the COD settings + live confirmation counts for the current user.
 *   { connected, config: { ...cod_* }, counts: { pending, confirmed, cancel_requested, no_reply } }
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
      // No store connected → COD config lives on shopify_config, so there's
      // nothing to configure yet. The UI shows a "connect Shopify first" state.
      return NextResponse.json({ connected: false })
    }

    // Live status counts — one cheap COUNT per status.
    const counts: Record<string, number> = {}
    await Promise.all(
      COD_STATUSES.map(async (status) => {
        const { count } = await supabase
          .from('cod_confirmations')
          .select('id', { count: 'exact', head: true })
          .eq('user_id', user.id)
          .eq('status', status)
        counts[status] = count ?? 0
      }),
    )

    const codConfig: Record<string, unknown> = {}
    for (const f of COD_FIELDS) codConfig[f] = config[f] ?? null

    return NextResponse.json({ connected: true, config: codConfig, counts })
  } catch (error) {
    console.error('[shopify/cod-config GET] error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

/**
 * PUT /api/shopify/cod-config
 * Saves COD settings. Only the COD_FIELDS keys are accepted; template names
 * must reference an Approved template the user actually has synced.
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
        { error: 'No Shopify store connected. Connect a store before configuring COD.' },
        { status: 400 },
      )
    }

    const body = (await request.json()) as Record<string, unknown>

    // Build a whitelisted update payload with light per-field validation.
    const update: Record<string, unknown> = {}
    for (const f of COD_FIELDS) {
      if (!(f in body)) continue
      const v = body[f]
      if (f === 'cod_reminder_count') {
        const n = Number(v)
        if (!Number.isInteger(n) || n < 0 || n > 2) {
          return NextResponse.json({ error: 'cod_reminder_count must be 0, 1, or 2' }, { status: 400 })
        }
        update[f] = n
      } else if (f.endsWith('_hours')) {
        const n = Number(v)
        if (!Number.isInteger(n) || n < 0 || n > 720) {
          return NextResponse.json({ error: `${f} must be 0–720 hours` }, { status: 400 })
        }
        update[f] = n
      } else if (f.endsWith('_var_map')) {
        // Placeholder-index → order-field-key map, e.g. {"1":"order_number"}.
        if (v == null) {
          update[f] = {}
        } else if (typeof v !== 'object' || Array.isArray(v)) {
          return NextResponse.json({ error: `${f} must be an object` }, { status: 400 })
        } else {
          for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
            if (!/^\d+$/.test(k)) {
              return NextResponse.json({ error: `${f}: keys must be placeholder numbers` }, { status: 400 })
            }
            if (typeof val !== 'string' || !COD_FIELD_KEYS.includes(val)) {
              return NextResponse.json({ error: `${f}: "${String(val)}" is not a valid field` }, { status: 400 })
            }
          }
          update[f] = v
        }
      } else if (f.endsWith('_enabled')) {
        update[f] = Boolean(v)
      } else if (f.endsWith('_text')) {
        // Free-text reply bodies — allow null/empty to clear, else cap length.
        if (v == null || v === '') {
          update[f] = null
        } else {
          const s = String(v)
          if (s.length > 1024) {
            return NextResponse.json({ error: `${f} must be 1024 characters or fewer` }, { status: 400 })
          }
          update[f] = s
        }
      } else {
        // template name / language — allow null to clear, else a trimmed string
        update[f] = v == null || v === '' ? null : String(v)
      }
    }

    // Validate any template names against the user's Approved templates so the
    // panel can never persist a template Meta would reject.
    const nameFields: (
      | 'cod_template_name'
      | 'cod_thankyou_template_name'
      | 'cod_cancel_template_name'
      | 'cod_noreply_template_name'
    )[] = [
      'cod_template_name',
      'cod_thankyou_template_name',
      'cod_cancel_template_name',
      'cod_noreply_template_name',
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
      return NextResponse.json({ error: 'No valid COD fields to update' }, { status: 400 })
    }

    update.updated_at = new Date().toISOString()

    const { error: updErr } = await db()
      .from('shopify_config')
      .update(update)
      .eq('user_id', user.id)
    if (updErr) {
      console.error('[shopify/cod-config PUT] update failed:', updErr.message)
      return NextResponse.json({ error: updErr.message }, { status: 500 })
    }

    return NextResponse.json({ success: true })
  } catch (error) {
    console.error('[shopify/cod-config PUT] error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
