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
