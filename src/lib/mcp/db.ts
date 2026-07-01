import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { ownerUserId } from './auth'
import { clampLimit, decodeCursor, nextCursor } from './pagination'

// ===========================================================================
// MCP data-access layer (READ-ONLY, Phase 2).
//
// THE ONLY FILE IN src/lib/mcp THAT TOUCHES A SUPABASE CLIENT. Tool code in
// tools/*.ts must import from here, never build queries itself.
//
// Access model (Option B): a dedicated service-role client (bypasses RLS) is
// used, but EVERY query is explicitly pinned to MCP_OWNER_USER_ID — directly
// via `.eq('user_id', owner)` for tables that carry user_id, or via an
// owner-ownership check on the parent row for child tables (messages,
// broadcast_recipients, pipeline_stages, flow_run_events, ...). No tool can
// read another account's data even though RLS is bypassed.
//
// Column allowlists (COLS) are explicit and NEVER include access_token,
// verify_token, refresh_token, or any raw Shopify/Meta credential. Every list
// is paginated with a server-clamped max page size.
// ===========================================================================

let _client: SupabaseClient | null = null

function db(): SupabaseClient {
  if (_client) return _client
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) {
    throw new Error('MCP db: NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not configured')
  }
  _client = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
  return _client
}

/** Test seam — inject a mock client. Not used in production paths. */
export function __setMcpDbClientForTests(c: SupabaseClient | null): void {
  _client = c
}

// --- Column allowlists (NO token/secret columns) ---------------------------

export const COLS = {
  // Connection status: intentionally omits access_token / verify_token.
  whatsapp_config: 'id,phone_number_id,waba_id,waba_name,status,connected_at,last_checked_at,created_at,updated_at',
  // Intentionally omits access_token / refresh_token.
  shopify_config: 'id,store_domain,shop_name,shop_id,connection_status,scopes,last_synced_at,token_expires_at,created_at,updated_at',
  contacts: 'id,name,phone,email,company,avatar_url,created_at,updated_at,shopify_customer_id,shopify_store_domain,shopify_total_orders,shopify_total_spent,shopify_currency,shopify_last_order_at,shopify_tags',
  tags: 'id,name,color,created_at',
  conversations: 'id,contact_id,status,assigned_agent_id,last_message_text,last_message_at,last_inbound_at,unread_count,created_at,updated_at',
  messages: 'id,conversation_id,sender_type,content_type,content_text,media_url,template_name,message_id,status,reply_to_message_id,interactive_reply_id,created_at',
  message_templates: 'id,name,category,language,header_type,header_content,body_text,footer_text,buttons,status,created_at,updated_at',
  broadcasts: 'id,name,template_name,template_language,status,total_recipients,sent_count,delivered_count,read_count,replied_count,failed_count,scheduled_at,created_at',
  broadcast_recipients: 'id,broadcast_id,contact_id,status,sent_at,delivered_at,read_at,replied_at,error_message,whatsapp_message_id,created_at',
  automations: 'id,name,description,trigger_type,trigger_config,is_active,execution_count,last_executed_at,created_at,updated_at',
  automation_steps: 'id,automation_id,parent_step_id,branch,step_type,step_config,position,created_at',
  automation_logs: 'id,automation_id,contact_id,trigger_event,status,error_message,created_at',
  flows: 'id,name,description,status,trigger_type,trigger_config,entry_node_id,execution_count,last_executed_at,created_at,updated_at',
  flow_nodes: 'id,flow_id,node_key,node_type,config,position_x,position_y,created_at',
  flow_runs: 'id,flow_id,contact_id,conversation_id,status,current_node_key,reprompt_count,started_at,last_advanced_at,ended_at,end_reason',
  flow_run_events: 'id,flow_run_id,event_type,node_key,payload,created_at',
  pipelines: 'id,name,created_at',
  pipeline_stages: 'id,pipeline_id,name,position,color,created_at',
  deals: 'id,pipeline_id,stage_id,contact_id,conversation_id,assigned_to,title,value,currency,notes,expected_close_date,status,created_at,updated_at',
  shopify_orders: 'id,contact_id,store_domain,shopify_order_id,order_number,name,customer_name,customer_phone,customer_email,currency,total_price,subtotal_price,total_shipping,financial_status,fulfillment_status,payment_gateway,line_items,tags,tracking_number,tracking_url,tracking_company,shipment_status,fulfilled_at,order_created_at,cancelled_at,cod_status,created_at,updated_at',
  // Intentionally omits `token` (Shopify checkout token).
  shopify_checkouts: 'id,contact_id,store_domain,shopify_checkout_id,customer_name,customer_phone,customer_email,line_items,abandoned_checkout_url,currency,total_price,shopify_created_at,abandoned_at,completed_at,recovered,recovered_order_id,created_at,updated_at',
  // Small contact embed for list joins.
  contactEmbed: 'contact:contacts(id,name,phone)',
} as const

/** Token/secret column names that must never appear in any allowlist. */
export const FORBIDDEN_COLUMNS = ['access_token', 'verify_token', 'refresh_token'] as const

// --- Helpers ---------------------------------------------------------------

type Row = Record<string, unknown>
interface Page {
  items: Row[]
  next_cursor: string | null
  page_size: number
}

function ownerScoped(table: string, cols: string) {
  return db().from(table).select(cols).eq('user_id', ownerUserId())
}

function fail(msg: string): never {
  throw new Error(msg)
}

// --- Read functions (one per tool) -----------------------------------------

export async function listContacts(p: { query?: string; limit?: number; cursor?: string }): Promise<Page> {
  const limit = clampLimit(p.limit, 25, 100)
  const offset = decodeCursor(p.cursor)
  let q = ownerScoped('contacts', COLS.contacts)
  if (p.query && p.query.trim()) {
    // Strip characters that would break PostgREST's `or` filter grammar.
    const s = p.query.replace(/[,()*%\\]/g, ' ').trim()
    if (s) q = q.or(`name.ilike.*${s}*,phone.ilike.*${s}*,email.ilike.*${s}*,company.ilike.*${s}*`)
  }
  const { data, error } = await q
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .range(offset, offset + limit - 1)
  if (error) fail(error.message)
  const items = (data ?? []) as unknown as Row[]
  return { items, next_cursor: nextCursor(items.length, limit, offset), page_size: limit }
}

export async function getContact(p: { contact_id: string }): Promise<Row> {
  const owner = ownerUserId()
  const { data: contact, error } = await db()
    .from('contacts')
    .select(COLS.contacts)
    .eq('id', p.contact_id)
    .eq('user_id', owner)
    .maybeSingle()
  if (error) fail(error.message)
  if (!contact) fail('contact not found for this account')

  const [{ data: tagLinks }, { data: deals }, notes] = await Promise.all([
    db().from('contact_tags').select('tag:tags(id,name,color)').eq('contact_id', p.contact_id),
    db()
      .from('deals')
      .select('id,title,value,currency,status,stage:pipeline_stages(name)')
      .eq('user_id', owner)
      .eq('contact_id', p.contact_id)
      .order('updated_at', { ascending: false })
      .limit(5),
    db()
      .from('contact_notes')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', owner)
      .eq('contact_id', p.contact_id),
  ])
  return {
    ...(contact as Row),
    tags: ((tagLinks ?? []) as unknown as Array<{ tag: unknown }>).map((t) => t.tag),
    recent_deals: deals ?? [],
    notes_count: notes.count ?? 0,
  }
}

export async function listConversations(p: {
  status?: string
  query?: string
  limit?: number
  cursor?: string
}): Promise<Page> {
  const limit = clampLimit(p.limit, 25, 50)
  const offset = decodeCursor(p.cursor)
  let q = ownerScoped('conversations', `${COLS.conversations},${COLS.contactEmbed}`)
  if (p.status) q = q.eq('status', p.status)
  if (p.query && p.query.trim()) {
    const s = p.query.replace(/[,()*%\\]/g, ' ').trim()
    if (s) q = q.or(`last_message_text.ilike.*${s}*`)
  }
  const { data, error } = await q
    .order('last_message_at', { ascending: false, nullsFirst: false })
    .order('id', { ascending: false })
    .range(offset, offset + limit - 1)
  if (error) fail(error.message)
  const items = (data ?? []) as unknown as Row[]
  return { items, next_cursor: nextCursor(items.length, limit, offset), page_size: limit }
}

export async function getConversationMessages(p: {
  conversation_id: string
  limit?: number
  cursor?: string
}): Promise<Page> {
  const limit = clampLimit(p.limit, 30, 50)
  const offset = decodeCursor(p.cursor)
  // Owner check on the parent conversation before reading any messages.
  const { data: conv, error: convErr } = await db()
    .from('conversations')
    .select('id')
    .eq('id', p.conversation_id)
    .eq('user_id', ownerUserId())
    .maybeSingle()
  if (convErr) fail(convErr.message)
  if (!conv) fail('conversation not found for this account')

  const { data, error } = await db()
    .from('messages')
    .select(COLS.messages)
    .eq('conversation_id', p.conversation_id)
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .range(offset, offset + limit - 1)
  if (error) fail(error.message)
  const items = (data ?? []) as unknown as Row[]
  return { items, next_cursor: nextCursor(items.length, limit, offset), page_size: limit }
}

export async function listTemplates(p: {
  status?: string
  category?: string
  limit?: number
  cursor?: string
}): Promise<Page> {
  const limit = clampLimit(p.limit, 50, 100)
  const offset = decodeCursor(p.cursor)
  let q = ownerScoped('message_templates', COLS.message_templates)
  if (p.status) q = q.eq('status', p.status)
  if (p.category) q = q.eq('category', p.category)
  const { data, error } = await q
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .range(offset, offset + limit - 1)
  if (error) fail(error.message)
  const items = (data ?? []) as unknown as Row[]
  return { items, next_cursor: nextCursor(items.length, limit, offset), page_size: limit }
}

export async function listBroadcasts(p: { status?: string; limit?: number; cursor?: string }): Promise<Page> {
  const limit = clampLimit(p.limit, 25, 50)
  const offset = decodeCursor(p.cursor)
  let q = ownerScoped('broadcasts', COLS.broadcasts)
  if (p.status) q = q.eq('status', p.status)
  const { data, error } = await q
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .range(offset, offset + limit - 1)
  if (error) fail(error.message)
  const items = (data ?? []) as unknown as Row[]
  return { items, next_cursor: nextCursor(items.length, limit, offset), page_size: limit }
}

export async function getBroadcast(p: { broadcast_id: string; limit?: number; cursor?: string }): Promise<Row> {
  const limit = clampLimit(p.limit, 50, 100)
  const offset = decodeCursor(p.cursor)
  const { data: broadcast, error } = await db()
    .from('broadcasts')
    .select(COLS.broadcasts)
    .eq('id', p.broadcast_id)
    .eq('user_id', ownerUserId())
    .maybeSingle()
  if (error) fail(error.message)
  if (!broadcast) fail('broadcast not found for this account')

  const { data: recipients, error: rErr } = await db()
    .from('broadcast_recipients')
    .select(`${COLS.broadcast_recipients},${COLS.contactEmbed}`)
    .eq('broadcast_id', p.broadcast_id)
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .range(offset, offset + limit - 1)
  if (rErr) fail(rErr.message)
  const items = (recipients ?? []) as unknown as Row[]
  return {
    ...(broadcast as Row),
    recipients: items,
    recipients_next_cursor: nextCursor(items.length, limit, offset),
  }
}

export async function listAutomations(p: { active?: boolean; limit?: number; cursor?: string }): Promise<Page> {
  const limit = clampLimit(p.limit, 50, 100)
  const offset = decodeCursor(p.cursor)
  let q = ownerScoped('automations', COLS.automations)
  if (typeof p.active === 'boolean') q = q.eq('is_active', p.active)
  const { data, error } = await q
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .range(offset, offset + limit - 1)
  if (error) fail(error.message)
  const items = (data ?? []) as unknown as Row[]
  return { items, next_cursor: nextCursor(items.length, limit, offset), page_size: limit }
}

export async function getAutomation(p: { automation_id: string }): Promise<Row> {
  const owner = ownerUserId()
  const { data: automation, error } = await db()
    .from('automations')
    .select(COLS.automations)
    .eq('id', p.automation_id)
    .eq('user_id', owner)
    .maybeSingle()
  if (error) fail(error.message)
  if (!automation) fail('automation not found for this account')

  const [{ data: steps }, { data: logs }] = await Promise.all([
    db().from('automation_steps').select(COLS.automation_steps).eq('automation_id', p.automation_id).order('position'),
    db()
      .from('automation_logs')
      .select(COLS.automation_logs)
      .eq('user_id', owner)
      .eq('automation_id', p.automation_id)
      .order('created_at', { ascending: false })
      .limit(10),
  ])
  return { ...(automation as Row), steps: steps ?? [], recent_logs: logs ?? [] }
}

export async function listFlows(p: { status?: string; limit?: number; cursor?: string }): Promise<Page> {
  const limit = clampLimit(p.limit, 50, 100)
  const offset = decodeCursor(p.cursor)
  let q = ownerScoped('flows', COLS.flows)
  if (p.status) q = q.eq('status', p.status)
  const { data, error } = await q
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .range(offset, offset + limit - 1)
  if (error) fail(error.message)
  const items = (data ?? []) as unknown as Row[]
  return { items, next_cursor: nextCursor(items.length, limit, offset), page_size: limit }
}

export async function getFlowRuns(p: {
  flow_id?: string
  contact_id?: string
  status?: string
  limit?: number
  cursor?: string
}): Promise<Page> {
  const limit = clampLimit(p.limit, 25, 50)
  const offset = decodeCursor(p.cursor)
  let q = ownerScoped('flow_runs', `${COLS.flow_runs},${COLS.contactEmbed}`)
  if (p.flow_id) q = q.eq('flow_id', p.flow_id)
  if (p.contact_id) q = q.eq('contact_id', p.contact_id)
  if (p.status) q = q.eq('status', p.status)
  const { data, error } = await q
    .order('started_at', { ascending: false, nullsFirst: false })
    .order('id', { ascending: false })
    .range(offset, offset + limit - 1)
  if (error) fail(error.message)
  const items = (data ?? []) as unknown as Row[]
  return { items, next_cursor: nextCursor(items.length, limit, offset), page_size: limit }
}

export async function listPipelinesDeals(p: {
  pipeline_id?: string
  stage_id?: string
  status?: string
  limit?: number
  cursor?: string
}): Promise<Row> {
  const owner = ownerUserId()
  const limit = clampLimit(p.limit, 25, 50)
  const offset = decodeCursor(p.cursor)

  const { data: pipelines, error: pErr } = await db()
    .from('pipelines')
    .select(COLS.pipelines)
    .eq('user_id', owner)
    .order('created_at', { ascending: true })
  if (pErr) fail(pErr.message)
  const pipelineIds = ((pipelines ?? []) as unknown as Array<{ id: string }>).map((r) => r.id)

  let stages: Row[] = []
  if (pipelineIds.length) {
    const { data: stageRows, error: sErr } = await db()
      .from('pipeline_stages')
      .select(COLS.pipeline_stages)
      .in('pipeline_id', pipelineIds)
      .order('position')
    if (sErr) fail(sErr.message)
    stages = (stageRows ?? []) as unknown as Row[]
  }

  let dq = db().from('deals').select(`${COLS.deals},${COLS.contactEmbed},stage:pipeline_stages(name)`).eq('user_id', owner)
  if (p.pipeline_id) dq = dq.eq('pipeline_id', p.pipeline_id)
  if (p.stage_id) dq = dq.eq('stage_id', p.stage_id)
  if (p.status) dq = dq.eq('status', p.status)
  const { data: deals, error: dErr } = await dq
    .order('updated_at', { ascending: false, nullsFirst: false })
    .order('id', { ascending: false })
    .range(offset, offset + limit - 1)
  if (dErr) fail(dErr.message)
  const dealItems = (deals ?? []) as unknown as Row[]

  return {
    pipelines: pipelines ?? [],
    stages,
    deals: dealItems,
    deals_next_cursor: nextCursor(dealItems.length, limit, offset),
  }
}

export async function listTags(p: { limit?: number; cursor?: string }): Promise<Page> {
  const limit = clampLimit(p.limit, 100, 200)
  const offset = decodeCursor(p.cursor)
  const { data, error } = await ownerScoped('tags', COLS.tags)
    .order('name', { ascending: true })
    .order('id', { ascending: false })
    .range(offset, offset + limit - 1)
  if (error) fail(error.message)
  const items = (data ?? []) as unknown as Row[]
  return { items, next_cursor: nextCursor(items.length, limit, offset), page_size: limit }
}

export async function listOrders(p: {
  cod_status?: string
  financial_status?: string
  limit?: number
  cursor?: string
}): Promise<Page> {
  const limit = clampLimit(p.limit, 25, 50)
  const offset = decodeCursor(p.cursor)
  let q = ownerScoped('shopify_orders', `${COLS.shopify_orders},${COLS.contactEmbed}`)
  if (p.cod_status) q = q.eq('cod_status', p.cod_status)
  if (p.financial_status) q = q.eq('financial_status', p.financial_status)
  const { data, error } = await q
    .order('order_created_at', { ascending: false, nullsFirst: false })
    .order('id', { ascending: false })
    .range(offset, offset + limit - 1)
  if (error) fail(error.message)
  const items = (data ?? []) as unknown as Row[]
  return { items, next_cursor: nextCursor(items.length, limit, offset), page_size: limit }
}

export async function listAbandonedCheckouts(p: {
  recovered?: boolean
  limit?: number
  cursor?: string
}): Promise<Page> {
  const limit = clampLimit(p.limit, 25, 50)
  const offset = decodeCursor(p.cursor)
  let q = ownerScoped('shopify_checkouts', `${COLS.shopify_checkouts},${COLS.contactEmbed}`)
  if (typeof p.recovered === 'boolean') q = q.eq('recovered', p.recovered)
  const { data, error } = await q
    .order('abandoned_at', { ascending: false, nullsFirst: false })
    .order('id', { ascending: false })
    .range(offset, offset + limit - 1)
  if (error) fail(error.message)
  const items = (data ?? []) as unknown as Row[]
  return { items, next_cursor: nextCursor(items.length, limit, offset), page_size: limit }
}

export async function getConnectionStatus(): Promise<Row> {
  const owner = ownerUserId()
  const [{ data: wa }, { data: shop }] = await Promise.all([
    db().from('whatsapp_config').select(COLS.whatsapp_config).eq('user_id', owner).maybeSingle(),
    db().from('shopify_config').select(COLS.shopify_config).eq('user_id', owner).maybeSingle(),
  ])
  return { whatsapp: wa ?? null, shopify: shop ?? null }
}

export async function getDashboardMetrics(): Promise<Row> {
  const owner = ownerUserId()
  const head = (t: string) => db().from(t).select('id', { count: 'exact', head: true }).eq('user_id', owner)

  const [
    contactsTotal,
    convOpen,
    convPending,
    convClosed,
    openDeals,
    broadcastsTotal,
    autoTotal,
    autoActive,
    flowsTotal,
    flowsActive,
    ordersTotal,
    checkoutsTotal,
    checkoutsRecovered,
  ] = await Promise.all([
    head('contacts'),
    head('conversations').eq('status', 'open'),
    head('conversations').eq('status', 'pending'),
    head('conversations').eq('status', 'closed'),
    db().from('deals').select('value').eq('user_id', owner).eq('status', 'open'),
    head('broadcasts'),
    head('automations'),
    head('automations').eq('is_active', true),
    head('flows'),
    head('flows').eq('status', 'active'),
    head('shopify_orders'),
    head('shopify_checkouts'),
    head('shopify_checkouts').eq('recovered', true),
  ])

  const openDealsRows = (openDeals.data ?? []) as unknown as Array<{ value: number | null }>
  const openDealsValue = openDealsRows.reduce((sum, d) => sum + (d.value ?? 0), 0)

  return {
    contacts_total: contactsTotal.count ?? 0,
    conversations: {
      open: convOpen.count ?? 0,
      pending: convPending.count ?? 0,
      closed: convClosed.count ?? 0,
    },
    open_deals: { count: openDealsRows.length, total_value: openDealsValue },
    broadcasts_total: broadcastsTotal.count ?? 0,
    automations: { total: autoTotal.count ?? 0, active: autoActive.count ?? 0 },
    flows: { total: flowsTotal.count ?? 0, active: flowsActive.count ?? 0 },
    shopify_orders_total: ordersTotal.count ?? 0,
    abandoned_checkouts: {
      total: checkoutsTotal.count ?? 0,
      recovered: checkoutsRecovered.count ?? 0,
    },
  }
}

// --- Audit sink (durable; backs Stage 3's daily send cap) ------------------

export async function insertAuditRow(row: {
  tool: string
  result: string
  params_hash?: string | null
  target?: string | null
  detail?: string | null
}): Promise<void> {
  try {
    await db().from('mcp_audit_log').insert({
      tool: row.tool,
      actor: 'mcp',
      result: row.result,
      params_hash: row.params_hash ?? null,
      target: row.target ?? null,
      detail: row.detail ?? null,
    })
  } catch {
    // Best-effort: never let audit failure break a tool call.
  }
}

/** Count today's (UTC) successful rows for a tool. Backs the Stage 3 daily cap. */
export async function countAuditToday(tool: string, result = 'ok'): Promise<number> {
  const start = new Date()
  start.setUTCHours(0, 0, 0, 0)
  const { count } = await db()
    .from('mcp_audit_log')
    .select('id', { count: 'exact', head: true })
    .eq('tool', tool)
    .eq('result', result)
    .gte('created_at', start.toISOString())
  return count ?? 0
}
