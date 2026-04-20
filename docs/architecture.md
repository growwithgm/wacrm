# Architecture

One-page tour of the codebase — so you know where to look when you
want to change something in your fork.

## Stack

| Layer | Tool | Why |
|---|---|---|
| Rendering | **Next.js 16** (App Router) | Server components for data-fetch pages; client components where interactivity's needed. React 19. |
| UI | **Tailwind v4** + **shadcn/base-ui** primitives | Tailwind's zero-runtime styling, shadcn patterns for composable, dark-theme-first components. |
| Data + Auth | **Supabase** | Postgres with Row-Level Security, built-in email/password auth, Storage for avatars, Realtime for the inbox. |
| WhatsApp | **Meta Cloud API** | Official Business API. No third-party gateway. |
| Encryption | `node:crypto` AES-256-GCM | Per-user WhatsApp access + verify tokens at rest. |
| Scheduler | External HTTP pinger | Hits `GET /api/automations/cron` to drain Wait-step executions. |

No ORM, no GraphQL layer, no dedicated backend. The Next server-side
routes read and write Supabase directly via `@supabase/ssr`.

## Folder layout

```
wacrm/
├─ src/
│  ├─ app/                            Next.js App Router routes
│  │  ├─ (auth)/                        login, signup, forgot-password
│  │  ├─ (dashboard)/                   authenticated UI
│  │  │  ├─ dashboard/                    home / metrics / activity feed
│  │  │  ├─ inbox/                        shared inbox
│  │  │  ├─ contacts/                     contacts + tags
│  │  │  ├─ pipelines/                    Kanban deals
│  │  │  ├─ broadcasts/                   campaign list + builder
│  │  │  ├─ automations/                  flow builder + logs
│  │  │  └─ settings/                     Profile / WhatsApp / Templates / Tags
│  │  ├─ docs/                          this documentation, rendered
│  │  ├─ api/                           JSON endpoints (server-only)
│  │  │  ├─ whatsapp/webhook/             inbound from Meta
│  │  │  ├─ whatsapp/send/                outbound message
│  │  │  ├─ whatsapp/broadcast/           bulk dispatch
│  │  │  ├─ whatsapp/config/              settings read/write
│  │  │  ├─ whatsapp/templates/           template sync
│  │  │  ├─ whatsapp/media/[id]/          media relay
│  │  │  └─ automations/                  engine + cron + CRUD
│  │  ├─ page.tsx                       marketing landing
│  │  ├─ layout.tsx                     root layout, metadata, icon
│  │  ├─ opengraph-image.tsx            dynamic OG image
│  │  └─ icon.tsx                       dynamic favicon
│  ├─ components/
│  │  ├─ landing/                       marketing page sections
│  │  ├─ dashboard/                     dashboard widgets
│  │  ├─ inbox/                         conversation list, thread, composer
│  │  ├─ contacts/, pipelines/, broadcasts/, automations/, settings/
│  │  ├─ docs/                          docs viewer shell
│  │  ├─ seo/                           JSON-LD helpers
│  │  ├─ layout/                        header, sidebar, shell
│  │  └─ ui/                            shadcn/base-ui primitives
│  ├─ hooks/                          use-auth, use-realtime, etc.
│  ├─ lib/
│  │  ├─ supabase/                      client, server, middleware factories
│  │  ├─ whatsapp/                      Meta API client, encryption, phone utils
│  │  ├─ automations/                   engine, steps, validation, templates
│  │  ├─ dashboard/                     queries + date utils
│  │  ├─ docs/                          markdown loader for /docs/
│  │  ├─ seo/                           site config, FAQ data, structured data
│  │  └─ rate-limit.ts                  per-user token bucket
│  ├─ types/                          shared TypeScript types
│  └─ middleware.ts                   session-refresh middleware
├─ supabase/
│  └─ migrations/                     idempotent SQL files, run in order
├─ docs/                              you are here
├─ public/                            static assets
└─ next.config.ts                     Cache-Control + security headers
```

## Request lifecycle: inbound WhatsApp message

```
 Meta Cloud API ──POST──▶ /api/whatsapp/webhook
                           │
                           ├─ verifyMetaWebhookSignature (HMAC-SHA256)
                           │   └─ rejects 401 if META_APP_SECRET unset or wrong
                           │
                           ├─ supabaseAdmin (service-role, lazy init)
                           │
                           ├─ find contact by phone (create if new)
                           ├─ find or create conversation
                           ├─ insert message row
                           │
                           ├─ fire runAutomationsForTrigger(...)
                           │   └─ matches automations on new_message / keyword
                           │
                           └─ 200 OK (Meta retries otherwise)

Realtime fan-out:
  messages INSERT ──▶ supabase/realtime ──▶ inbox page subscription
                                              └─ appends to thread without refetch
```

## Request lifecycle: outbound message from the inbox

```
 Composer ──fetch──▶ /api/whatsapp/send
                      │
                      ├─ createClient() — user-scoped Supabase client
                      ├─ auth.getUser() — 401 if unauthed
                      ├─ checkRateLimit('send:<uid>', 60/min)
                      │
                      ├─ select whatsapp_config row (RLS-scoped)
                      ├─ decrypt(access_token)
                      │   └─ self-heal: upgrade CBC → GCM (fire-and-forget)
                      │
                      ├─ sendTextMessage / sendTemplateMessage (Meta API)
                      ├─ retry with phone-number variants on "not allowed"
                      │
                      ├─ insert message row with status = 'sent'
                      └─ 200 + wamid

UI:
  Optimistic temp row shown immediately.
  Real row arrives via Supabase realtime → replaces temp.
  If 429 / 5xx: temp row flips to status = 'failed'.
```

## Security primitives

- **Row-Level Security** on every table. Users see only their own
  rows via `auth.uid() = user_id`. Service-role bypasses RLS; only
  server-only modules use it.
- **Encryption** (`src/lib/whatsapp/encryption.ts`) — AES-256-GCM for
  WhatsApp tokens at rest. Backward-compatible decrypt for legacy
  CBC rows; self-heals on first use.
- **Webhook signatures** (`src/lib/whatsapp/webhook-signature.ts`) —
  HMAC-SHA256 with `META_APP_SECRET`. Fail-closed if the env var
  isn't set.
- **Cron secret** — `GET /api/automations/cron` requires
  `x-cron-secret: <AUTOMATION_CRON_SECRET>`. Constant-ish string
  comparison.
- **Rate limiting** (`src/lib/rate-limit.ts`) — per-user fixed window,
  process-local `Map`. Swap for Redis/Upstash at horizontal scale.
- **HTTP headers** (`next.config.ts`) — HSTS, nosniff,
  X-Frame-Options: DENY, Referrer-Policy, Permissions-Policy, and a
  report-only CSP.

## Where to change things

| Want to change… | Start here |
|---|---|
| Marketing copy / landing page | `src/app/page.tsx` + `src/components/landing/*` |
| Dashboard metrics | `src/lib/dashboard/queries.ts` + `src/components/dashboard/*` |
| Inbox behaviour | `src/app/(dashboard)/inbox/page.tsx` + `src/components/inbox/*` |
| Automation triggers / actions | `src/lib/automations/engine.ts`, `steps-tree.ts`, `meta-send.ts` |
| Add a DB column | new migration in `supabase/migrations/NNN_*.sql`, then update the matching `src/types/*.ts` |
| Change auth provider | `src/lib/supabase/{client,server}.ts` + `src/hooks/use-auth.tsx` + `middleware.ts` |
| Add a new API route | `src/app/api/<name>/route.ts`, pattern after existing routes |
| Tweak rate limits | `RATE_LIMITS` in `src/lib/rate-limit.ts` |
