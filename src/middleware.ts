import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'

export async function middleware(request: NextRequest) {
  const mcpPath = request.nextUrl.pathname

  // OAuth discovery + endpoints are PUBLIC (the route handlers self-gate on
  // MCP_ENABLED + oauthConfigured, and enforce PKCE / the consent secret).
  // Skip the Supabase session work; no bearer required here.
  if (mcpPath.startsWith('/.well-known/oauth') || mcpPath.startsWith('/api/mcp/oauth')) {
    return NextResponse.next({ request })
  }

  // MCP transport: kill-switch only. The route handler enforces auth (static
  // bearer OR OAuth access token) and returns the 401 + WWW-Authenticate that
  // OAuth clients need to discover the authorization server — so we must NOT
  // short-circuit an unauthenticated request with a plain 401 here.
  if (mcpPath.startsWith('/api/mcp')) {
    if (process.env.MCP_ENABLED !== 'true') {
      return NextResponse.json({ error: 'mcp_disabled' }, { status: 503 })
    }
    return NextResponse.next({ request })
  }

  let supabaseResponse = NextResponse.next({ request })

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll()
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value, options }) => request.cookies.set(name, value))
          supabaseResponse = NextResponse.next({ request })
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options)
          )
        },
      },
    }
  )

  const { data: { user } } = await supabase.auth.getUser()

  // Auth pages - redirect to dashboard if already logged in
  if (user && (
    request.nextUrl.pathname === '/login' ||
    request.nextUrl.pathname === '/signup' ||
    request.nextUrl.pathname === '/forgot-password'
  )) {
    const url = request.nextUrl.clone()
    url.pathname = '/dashboard'
    return NextResponse.redirect(url)
  }

  // Protected pages - redirect to login if not authenticated
  const protectedPaths = ['/dashboard', '/inbox', '/contacts', '/pipelines', '/broadcasts', '/automations', '/settings']
  if (!user && protectedPaths.some(path => request.nextUrl.pathname.startsWith(path))) {
    const url = request.nextUrl.clone()
    url.pathname = '/login'
    return NextResponse.redirect(url)
  }

  // API routes that need auth (not webhooks)
  if (!user && request.nextUrl.pathname.startsWith('/api/whatsapp/') &&
      !request.nextUrl.pathname.includes('/webhook')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  return supabaseResponse
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
}
