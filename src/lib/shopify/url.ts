/**
 * Resolve the public base URL of this app for building Shopify callback URLs.
 *
 * Shopify requires webhook addresses to be public HTTPS URLs. We prefer the
 * explicit NEXT_PUBLIC_SITE_URL; otherwise we derive the origin from the
 * forwarded host headers and force HTTPS. We deliberately do NOT trust
 * `new URL(request.url).origin` first, because on Vercel that can resolve to
 * the platform-internal URL behind the proxy — which is exactly how a webhook
 * address ends up non-public and Shopify silently rejects every subscription.
 */
export function resolveAppBaseUrl(request: Request): string {
  const env = process.env.NEXT_PUBLIC_SITE_URL?.trim()
  if (env) return env.replace(/\/+$/, '')

  const host =
    request.headers.get('x-forwarded-host') ??
    request.headers.get('host') ??
    new URL(request.url).host

  const isLocal = host.startsWith('localhost') || host.startsWith('127.0.0.1')
  return `${isLocal ? 'http' : 'https'}://${host}`
}

/** The Shopify webhook callback URL for this deployment. */
export function shopifyWebhookCallbackUrl(request: Request): string {
  return `${resolveAppBaseUrl(request)}/api/shopify/webhook`
}
