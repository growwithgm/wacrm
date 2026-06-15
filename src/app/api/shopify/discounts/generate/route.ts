import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createClient as createAdminClient } from '@supabase/supabase-js'
import { generateDiscountCodeForContact } from '@/lib/shopify/discounts'

export const runtime = 'nodejs'

// Service-role client for the write to discount_codes (RLS is read-only for
// users). Lazy so a missing env var doesn't crash the build.
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

/**
 * POST /api/shopify/discounts/generate
 * Body: { discount_id, contact_id? }
 *
 * Generates (or reuses) a unique single-use code for the given discount.
 * Used by the "Generate test code" button now, and the same lib function
 * (generateDiscountCodeForContact) will be called by a template-send later.
 *
 * The user is authenticated here, and ownership of the discount is verified
 * inside the generator (tenant-scoped), so the service-role write is safe.
 */
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

    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>
    const discountId = typeof body.discount_id === 'string' ? body.discount_id : ''
    const contactId = typeof body.contact_id === 'string' ? body.contact_id : null
    if (!discountId) {
      return NextResponse.json({ error: 'discount_id is required' }, { status: 400 })
    }

    // If a contact_id is supplied, confirm it belongs to this user (RLS via
    // the authed client) before handing it to the service-role writer.
    if (contactId) {
      const { data: contact } = await supabase
        .from('contacts')
        .select('id')
        .eq('id', contactId)
        .maybeSingle()
      if (!contact) {
        return NextResponse.json({ error: 'Contact not found' }, { status: 404 })
      }
    }

    const result = await generateDiscountCodeForContact(db(), user.id, discountId, contactId)
    return NextResponse.json({
      code: result.code,
      reused: result.reused,
      expires_at: result.expiresAt,
      shopify_discount_id: result.shopifyDiscountId,
    })
  } catch (error) {
    // Surface the Shopify/validation message to the test UI; never a 500
    // stack. A missing write_discounts scope shows up here as a Shopify
    // access error — the merchant must reconnect Shopify.
    const message = error instanceof Error ? error.message : 'Failed to generate code'
    console.error('[shopify/discounts/generate] error:', message)
    return NextResponse.json({ error: message }, { status: 400 })
  }
}
