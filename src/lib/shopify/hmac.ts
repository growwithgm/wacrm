import crypto from 'crypto'

/**
 * Verify the HMAC-SHA256 signature Shopify attaches to OAuth callbacks.
 *
 * Shopify signs all query parameters *except* `hmac` itself, sorted
 * alphabetically, as `key=value` pairs joined by `&`. Special characters
 * `%` and `&` inside values are percent-encoded per the Shopify spec.
 */
export function verifyShopifyCallbackHmac(
  searchParams: URLSearchParams,
  clientSecret: string,
): boolean {
  const incoming = searchParams.get('hmac')
  if (!incoming) return false

  const pairs: string[] = []
  for (const [key, value] of searchParams.entries()) {
    if (key === 'hmac') continue
    // Shopify spec: % → %25, & → %26 inside values
    const encodedValue = value.replace(/%/g, '%25').replace(/&/g, '%26')
    pairs.push(`${key}=${encodedValue}`)
  }
  pairs.sort()

  const digest = crypto
    .createHmac('sha256', clientSecret)
    .update(pairs.join('&'))
    .digest('hex')

  try {
    return crypto.timingSafeEqual(
      Buffer.from(digest, 'hex'),
      Buffer.from(incoming, 'hex'),
    )
  } catch {
    return false
  }
}

/**
 * Reject obviously invalid shop domains early to prevent open-redirect
 * attacks (a malicious `shop` param pointing to an attacker's server).
 */
export function isValidShopDomain(shop: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9-]*\.myshopify\.com$/.test(shop)
}

/**
 * Verify the HMAC Shopify attaches to webhook deliveries.
 *
 * Unlike the OAuth callback HMAC (hex digest over sorted query params),
 * webhook HMAC is the **base64** digest of the raw, unparsed request body
 * keyed with the app's client secret, delivered in the
 * `X-Shopify-Hmac-Sha256` header. The body MUST be the exact bytes Shopify
 * sent — so callers pass the raw Buffer (`Buffer.from(await request.arrayBuffer())`).
 * A string is also accepted (encoded as UTF-8) for convenience.
 */
export function verifyShopifyWebhookHmac(
  rawBody: Buffer | string,
  hmacHeader: string | null,
  clientSecret: string,
): boolean {
  if (!hmacHeader) return false

  const body = typeof rawBody === 'string' ? Buffer.from(rawBody, 'utf8') : rawBody
  const digest = crypto.createHmac('sha256', clientSecret).update(body).digest('base64')

  try {
    const a = Buffer.from(digest)
    const b = Buffer.from(hmacHeader)
    return a.length === b.length && crypto.timingSafeEqual(a, b)
  } catch {
    return false
  }
}
