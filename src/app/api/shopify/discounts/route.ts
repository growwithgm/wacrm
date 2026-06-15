import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

// Validate a discount definition payload. Returns a normalized object or an
// error string.
function normalizeDiscount(body: Record<string, unknown>):
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; error: string } {
  const label = typeof body.label === 'string' ? body.label.trim() : ''
  if (!label) return { ok: false, error: 'A label is required' }
  if (label.length > 80) return { ok: false, error: 'Label must be 80 characters or fewer' }

  const pct = Number(body.percentage)
  if (!Number.isFinite(pct) || pct <= 0 || pct > 100) {
    return { ok: false, error: 'Percentage must be between 0 and 100' }
  }

  let expiryDays: number | null = null
  if (body.expiry_days != null && body.expiry_days !== '') {
    const n = Number(body.expiry_days)
    if (!Number.isInteger(n) || n <= 0 || n > 3650) {
      return { ok: false, error: 'Expiry (days) must be a whole number between 1 and 3650' }
    }
    expiryDays = n
  }

  let minOrder: number | null = null
  if (body.min_order_amount != null && body.min_order_amount !== '') {
    const n = Number(body.min_order_amount)
    if (!Number.isFinite(n) || n < 0) {
      return { ok: false, error: 'Minimum order amount must be 0 or more' }
    }
    minOrder = Math.round(n * 100) / 100
  }

  return {
    ok: true,
    value: {
      label,
      percentage: Math.round(pct * 100) / 100,
      expiry_days: expiryDays,
      min_order_amount: minOrder,
      enabled: body.enabled == null ? true : Boolean(body.enabled),
    },
  }
}

/**
 * GET /api/shopify/discounts
 * Lists the user's discount definitions + recent generated codes, and
 * whether a Shopify store is connected (needed for code generation).
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

    const [discountsRes, codesRes, configRes] = await Promise.all([
      supabase.from('discounts').select('*').order('created_at', { ascending: false }),
      supabase
        .from('discount_codes')
        .select('id, discount_id, contact_id, code, status, percentage, expires_at, created_at')
        .order('created_at', { ascending: false })
        .limit(50),
      supabase
        .from('shopify_config')
        .select('store_domain, scopes')
        .eq('user_id', user.id)
        .maybeSingle(),
    ])

    const scopes = (configRes.data?.scopes as string | null) ?? ''
    return NextResponse.json({
      connected: !!configRes.data,
      // Surfaced so the UI can warn before the merchant tries to generate.
      hasDiscountScope: scopes.split(',').map((s) => s.trim()).includes('write_discounts'),
      discounts: discountsRes.data ?? [],
      codes: codesRes.data ?? [],
    })
  } catch (error) {
    console.error('[shopify/discounts GET] error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

/** POST /api/shopify/discounts — create a discount definition. */
export async function POST(request: Request) {
  try {
    const supabase = await createClient()
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser()
    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const body = (await request.json()) as Record<string, unknown>
    const norm = normalizeDiscount(body)
    if (!norm.ok) return NextResponse.json({ error: norm.error }, { status: 400 })

    const { data, error } = await supabase
      .from('discounts')
      .insert({ ...norm.value, user_id: user.id })
      .select()
      .single()
    if (error) {
      console.error('[shopify/discounts POST] insert failed:', error.message)
      return NextResponse.json({ error: error.message }, { status: 500 })
    }
    return NextResponse.json({ discount: data })
  } catch (error) {
    console.error('[shopify/discounts POST] error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

/** PUT /api/shopify/discounts — update a definition (edit / enable / disable). */
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

    const body = (await request.json()) as Record<string, unknown>
    const id = typeof body.id === 'string' ? body.id : ''
    if (!id) return NextResponse.json({ error: 'id is required' }, { status: 400 })

    // Enable/disable-only fast path.
    if (Object.keys(body).length === 2 && 'enabled' in body) {
      const { error } = await supabase
        .from('discounts')
        .update({ enabled: Boolean(body.enabled) })
        .eq('id', id)
        .eq('user_id', user.id)
      if (error) return NextResponse.json({ error: error.message }, { status: 500 })
      return NextResponse.json({ success: true })
    }

    const norm = normalizeDiscount(body)
    if (!norm.ok) return NextResponse.json({ error: norm.error }, { status: 400 })

    const { error } = await supabase
      .from('discounts')
      .update(norm.value)
      .eq('id', id)
      .eq('user_id', user.id)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ success: true })
  } catch (error) {
    console.error('[shopify/discounts PUT] error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

/** DELETE /api/shopify/discounts?id=... — remove a definition (codes cascade). */
export async function DELETE(request: Request) {
  try {
    const supabase = await createClient()
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser()
    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const id = new URL(request.url).searchParams.get('id')
    if (!id) return NextResponse.json({ error: 'id is required' }, { status: 400 })

    const { error } = await supabase
      .from('discounts')
      .delete()
      .eq('id', id)
      .eq('user_id', user.id)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ success: true })
  } catch (error) {
    console.error('[shopify/discounts DELETE] error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
