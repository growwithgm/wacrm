import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  __setMcpDbClientForTests,
  COLS,
  FORBIDDEN_COLUMNS,
  getConnectionStatus,
  listContacts,
} from './db'

const OWNER = '15ea8034-8caf-4111-aaf1-a59a69f653e3'

// A chainable Supabase-query mock that records every .from() table and
// .eq(col, val) applied, and resolves to an empty result set.
interface MockBuilder {
  from(t: string): MockBuilder
  select(...a: unknown[]): MockBuilder
  eq(c: string, v: unknown): MockBuilder
  in(...a: unknown[]): MockBuilder
  or(...a: unknown[]): MockBuilder
  gte(...a: unknown[]): MockBuilder
  order(...a: unknown[]): MockBuilder
  range(...a: unknown[]): MockBuilder
  limit(...a: unknown[]): MockBuilder
  maybeSingle(): Promise<{ data: unknown; error: null }>
  then(res: (v: { data: unknown[]; error: null; count: number }) => unknown): unknown
}

function makeMock() {
  const eqs: Array<[string, unknown]> = []
  const tables: string[] = []
  const b: MockBuilder = {
    from(t) {
      tables.push(t)
      return b
    },
    select: () => b,
    eq(c, v) {
      eqs.push([c, v])
      return b
    },
    in: () => b,
    or: () => b,
    gte: () => b,
    order: () => b,
    range: () => b,
    limit: () => b,
    maybeSingle: () => Promise.resolve({ data: { id: 'x' }, error: null }),
    then: (res) => res({ data: [], error: null, count: 0 }),
  }
  return { client: b as unknown as SupabaseClient, eqs, tables }
}

describe('MCP column allowlists', () => {
  it('connection-status columns never expose access/verify/refresh tokens', () => {
    expect(COLS.whatsapp_config).not.toContain('access_token')
    expect(COLS.whatsapp_config).not.toContain('verify_token')
    expect(COLS.shopify_config).not.toContain('access_token')
    expect(COLS.shopify_config).not.toContain('refresh_token')
  })

  it('no allowlist contains any forbidden token column', () => {
    for (const cols of Object.values(COLS)) {
      for (const forbidden of FORBIDDEN_COLUMNS) {
        expect(cols).not.toContain(forbidden)
      }
    }
  })

  it('abandoned-checkout allowlist omits the checkout `token` column', () => {
    expect(COLS.shopify_checkouts.split(',')).not.toContain('token')
  })
})

describe('MCP owner scoping', () => {
  beforeEach(() => {
    process.env.MCP_OWNER_USER_ID = OWNER
  })
  afterEach(() => {
    __setMcpDbClientForTests(null)
    delete process.env.MCP_OWNER_USER_ID
  })

  it('listContacts pins the query to the owner user_id', async () => {
    const mock = makeMock()
    __setMcpDbClientForTests(mock.client)
    await listContacts({})
    expect(mock.tables).toContain('contacts')
    expect(mock.eqs).toContainEqual(['user_id', OWNER])
  })

  it('getConnectionStatus scopes both config reads to the owner', async () => {
    const mock = makeMock()
    __setMcpDbClientForTests(mock.client)
    await getConnectionStatus()
    expect(mock.tables).toEqual(expect.arrayContaining(['whatsapp_config', 'shopify_config']))
    const ownerEqs = mock.eqs.filter(([c, v]) => c === 'user_id' && v === OWNER)
    expect(ownerEqs.length).toBeGreaterThanOrEqual(2)
  })
})
