/**
 * Discount code generation — Shopify Admin GraphQL.
 *
 * Given a merchant-defined discount (the `discounts` table), generate a
 * UNIQUE, SINGLE-USE percentage code on the tenant's Shopify store via
 * `discountCodeBasicCreate`, and record it in `discount_codes`.
 *
 * The reusable entry point is `generateDiscountCodeForContact` — a clean
 * callable a future template-send will call. It is multi-tenant (uses the
 * tenant's own Shopify connection/token) and never regenerates blindly:
 * an existing active, unexpired code for the same (discount, contact) is
 * reused.
 *
 * Requires the Shopify `write_discounts` (+ `read_discounts`) OAuth scope.
 * The app must be reconnected after that scope is added, otherwise the
 * mutation returns an access error — surfaced, never thrown into a send
 * path the caller doesn't guard.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { randomBytes } from 'crypto'
import { getValidToken, shopifyGraphQL, type ShopifyConfigRow } from './client'

export interface DiscountRow {
  id: string
  user_id: string
  label: string
  percentage: number
  expiry_days: number | null
  min_order_amount: number | null
  enabled: boolean
}

export interface GeneratedCode {
  code: string
  shopifyDiscountId: string | null
  expiresAt: string | null
  reused: boolean
}

// Unambiguous alphabet (no 0/O/1/I) for human-readable, hard-to-mistype codes.
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

/** A short uppercase prefix derived from the discount label (fallback WASIFY). */
function prefixFromLabel(label: string): string {
  const cleaned = label.toUpperCase().replace(/[^A-Z0-9]/g, '')
  return cleaned.slice(0, 8) || 'WASIFY'
}

/** Generate a random `PREFIX-XXXXXX` code. */
function buildCode(label: string): string {
  const bytes = randomBytes(8)
  let suffix = ''
  for (let i = 0; i < 6; i++) {
    suffix += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length]
  }
  return `${prefixFromLabel(label)}-${suffix}`
}

const CREATE_DISCOUNT_MUTATION = `
  mutation CreateDiscountCode($basicCodeDiscount: DiscountCodeBasicInput!) {
    discountCodeBasicCreate(basicCodeDiscount: $basicCodeDiscount) {
      codeDiscountNode {
        id
        codeDiscount {
          ... on DiscountCodeBasic {
            title
            status
            endsAt
            codes(first: 1) { nodes { code } }
          }
        }
      }
      userErrors { field code message }
    }
  }
`

interface CreateDiscountResult {
  discountCodeBasicCreate: {
    codeDiscountNode: { id: string } | null
    userErrors: { field: string[] | null; code: string | null; message: string }[]
  }
}

/**
 * Create one single-use percentage discount code on Shopify. Returns the
 * Shopify discount node id. Throws with a readable message on userErrors
 * or transport failure (callers in a send path must guard).
 */
async function createShopifyCode(
  config: ShopifyConfigRow,
  token: string,
  args: {
    code: string
    title: string
    percentage: number // 0–100
    endsAt: string | null
    minOrderAmount: number | null
  },
): Promise<string> {
  const basicCodeDiscount: Record<string, unknown> = {
    title: args.title,
    code: args.code,
    startsAt: new Date().toISOString(),
    // Single use overall + once per customer.
    usageLimit: 1,
    appliesOncePerCustomer: true,
    // Available to all buyers (the unique single-use code is the gate).
    context: { all: 'ALL' },
    customerGets: {
      // Shopify expects a 0.00–1.00 fraction for percentage.
      value: { percentage: Math.round(args.percentage) / 100 },
      items: { all: true },
    },
  }
  if (args.endsAt) basicCodeDiscount.endsAt = args.endsAt
  if (args.minOrderAmount != null) {
    basicCodeDiscount.minimumRequirement = {
      subtotal: { greaterThanOrEqualToSubtotal: args.minOrderAmount.toFixed(2) },
    }
  }

  const res = await shopifyGraphQL<CreateDiscountResult>(
    config.store_domain,
    token,
    CREATE_DISCOUNT_MUTATION,
    { basicCodeDiscount },
  )

  const payload = res.data.discountCodeBasicCreate
  const errs = payload?.userErrors ?? []
  if (errs.length > 0) {
    throw new Error(
      `Shopify rejected the discount: ${errs.map((e) => e.message).join('; ')}`,
    )
  }
  const id = payload?.codeDiscountNode?.id
  if (!id) throw new Error('Shopify did not return a discount id')
  return id
}

/**
 * Generate (or reuse) a unique single-use discount code for a contact.
 *
 * @param db        Supabase service-role client (writes bypass RLS).
 * @param userId    Tenant.
 * @param discountId  A row in `discounts`, must belong to userId + be enabled.
 * @param contactId   The recipient, or null for a "generate test code" run.
 * @returns the code string and metadata.
 *
 * Reuse: if `contactId` is set and an active, unexpired code already exists
 * for this (discount, contact), it is returned instead of creating another.
 */
export async function generateDiscountCodeForContact(
  db: any,
  userId: string,
  discountId: string,
  contactId: string | null,
): Promise<GeneratedCode> {
  // 1. Load + validate the discount definition (tenant-scoped).
  const { data: discount } = await db
    .from('discounts')
    .select('*')
    .eq('id', discountId)
    .eq('user_id', userId)
    .maybeSingle()
  if (!discount) throw new Error('Discount not found')
  if (!discount.enabled) throw new Error('This discount is disabled')

  // 2. Reuse an existing active, unexpired code for this contact.
  if (contactId) {
    const { data: existing } = await db
      .from('discount_codes')
      .select('code, shopify_discount_id, expires_at, status')
      .eq('user_id', userId)
      .eq('discount_id', discountId)
      .eq('contact_id', contactId)
      .eq('status', 'active')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (
      existing &&
      (!existing.expires_at || new Date(existing.expires_at).getTime() > Date.now())
    ) {
      return {
        code: existing.code,
        shopifyDiscountId: existing.shopify_discount_id,
        expiresAt: existing.expires_at,
        reused: true,
      }
    }
  }

  // 3. Resolve the tenant's Shopify connection + a valid token.
  const { data: config } = await db
    .from('shopify_config')
    .select('*')
    .eq('user_id', userId)
    .maybeSingle()
  if (!config) throw new Error('No Shopify store connected')
  const token = await getValidToken(config as ShopifyConfigRow)

  // 4. Build the code + expiry, then create it on Shopify.
  const code = buildCode(discount.label as string)
  const expiresAt =
    discount.expiry_days != null
      ? new Date(Date.now() + Number(discount.expiry_days) * 24 * 60 * 60 * 1000).toISOString()
      : null
  const title = `${discount.label} (${Number(discount.percentage)}% • Wasify)`

  const shopifyDiscountId = await createShopifyCode(config as ShopifyConfigRow, token, {
    code,
    title,
    percentage: Number(discount.percentage),
    endsAt: expiresAt,
    minOrderAmount: discount.min_order_amount != null ? Number(discount.min_order_amount) : null,
  })

  // 5. Record it. The unique (user_id, code) constraint makes this safe.
  const { error: insErr } = await db.from('discount_codes').insert({
    user_id: userId,
    discount_id: discountId,
    contact_id: contactId,
    code,
    shopify_discount_id: shopifyDiscountId,
    percentage: discount.percentage,
    status: 'active',
    expires_at: expiresAt,
  })
  if (insErr) {
    // The code exists on Shopify but our row failed — log loudly; the code
    // is still valid and returned, just not yet in history.
    console.error('[discounts] code created on Shopify but DB insert failed:', insErr.message)
  }

  return { code, shopifyDiscountId, expiresAt, reused: false }
}
