import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { recordToolCall } from '../audit'
import {
  getAutomation,
  getBroadcast,
  getConnectionStatus,
  getContact,
  getConversationMessages,
  getDashboardMetrics,
  getFlowRuns,
  listAbandonedCheckouts,
  listAutomations,
  listBroadcasts,
  listContacts,
  listConversations,
  listFlows,
  listOrders,
  listPipelinesDeals,
  listTags,
  listTemplates,
} from '../db'

// ---------------------------------------------------------------------------
// Phase 2 READ-ONLY tools. Every tool: validated input, owner-scoped +
// column-allowlisted data access (see db.ts), server-clamped pagination, and
// an audit-log entry (tool + args hash + result, no PII). NO send/write tool
// is registered here — that is Phase 3.
// ---------------------------------------------------------------------------

type ToolResult = {
  content: { type: 'text'; text: string }[]
  isError?: boolean
}

async function run(
  tool: string,
  params: unknown,
  fn: () => Promise<unknown>,
  target?: string,
): Promise<ToolResult> {
  try {
    const result = await fn()
    await recordToolCall(tool, params, 'ok', target ? { target } : undefined)
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
  } catch (e) {
    const detail = e instanceof Error ? e.name : 'error'
    await recordToolCall(tool, params, 'error', { detail, ...(target ? { target } : {}) })
    const message = e instanceof Error ? e.message : 'unknown error'
    return { content: [{ type: 'text', text: JSON.stringify({ error: message }) }], isError: true }
  }
}

// Reusable pagination inputs.
const limit = z.number().int().positive().optional().describe('page size (clamped server-side to the tool max)')
const cursor = z.string().optional().describe('opaque pagination cursor from a previous response')

export function registerReadTools(server: McpServer): void {
  server.tool(
    'get_connection_status',
    'WhatsApp + Shopify connection status for the account (never returns access/verify/refresh tokens).',
    {},
    async () => run('get_connection_status', {}, () => getConnectionStatus()),
  )

  server.tool(
    'get_dashboard_metrics',
    'Aggregate account metrics: contacts, conversations by status, open deals value, broadcasts, automations, flows, orders, abandoned checkouts.',
    {},
    async () => run('get_dashboard_metrics', {}, () => getDashboardMetrics()),
  )

  server.tool(
    'list_contacts',
    'List/search contacts (name, phone, email, company, Shopify order stats). Paginated.',
    { query: z.string().max(200).optional().describe('substring match on name/phone/email/company'), limit, cursor },
    async (args) => run('list_contacts', args, () => listContacts(args)),
  )

  server.tool(
    'get_contact',
    'A single contact with its tags, recent deals, and note count.',
    { contact_id: z.string().describe('contact UUID') },
    async (args) => run('get_contact', args, () => getContact(args), `contact:${args.contact_id}`),
  )

  server.tool(
    'list_conversations',
    'List inbox conversations (with contact name/phone), most recent first. Paginated.',
    {
      status: z.enum(['open', 'pending', 'closed']).optional(),
      query: z.string().max(200).optional().describe('substring match on last message text'),
      limit,
      cursor,
    },
    async (args) => run('list_conversations', args, () => listConversations(args)),
  )

  server.tool(
    'get_conversation_messages',
    'Messages in one conversation (newest first). Paginated. Verifies the conversation belongs to the account.',
    { conversation_id: z.string().describe('conversation UUID'), limit, cursor },
    async (args) =>
      run('get_conversation_messages', args, () => getConversationMessages(args), `conversation:${args.conversation_id}`),
  )

  server.tool(
    'list_templates',
    'List WhatsApp message templates with their Meta approval status. Paginated.',
    {
      status: z.enum(['Draft', 'Pending', 'Approved', 'Rejected']).optional(),
      category: z.enum(['Marketing', 'Utility', 'Authentication']).optional(),
      limit,
      cursor,
    },
    async (args) => run('list_templates', args, () => listTemplates(args)),
  )

  server.tool(
    'list_broadcasts',
    'List broadcast campaigns with aggregate delivery stats. Paginated.',
    { status: z.enum(['draft', 'scheduled', 'sending', 'sent', 'failed']).optional(), limit, cursor },
    async (args) => run('list_broadcasts', args, () => listBroadcasts(args)),
  )

  server.tool(
    'get_broadcast',
    'One broadcast with its per-recipient delivery status (paginated recipients).',
    { broadcast_id: z.string().describe('broadcast UUID'), limit, cursor },
    async (args) => run('get_broadcast', args, () => getBroadcast(args), `broadcast:${args.broadcast_id}`),
  )

  server.tool(
    'list_automations',
    'List no-code automations (trigger, active state, run count). Paginated.',
    { active: z.boolean().optional().describe('filter by is_active'), limit, cursor },
    async (args) => run('list_automations', args, () => listAutomations(args)),
  )

  server.tool(
    'get_automation',
    'One automation with its step tree and recent execution logs.',
    { automation_id: z.string().describe('automation UUID') },
    async (args) => run('get_automation', args, () => getAutomation(args), `automation:${args.automation_id}`),
  )

  server.tool(
    'list_flows',
    'List conversational flows (status, trigger, run count). Paginated.',
    { status: z.enum(['draft', 'active', 'archived']).optional(), limit, cursor },
    async (args) => run('list_flows', args, () => listFlows(args)),
  )

  server.tool(
    'get_flow_runs',
    'List flow runs (with contact name/phone), most recent first. Filter by flow, contact, or status. Paginated.',
    {
      flow_id: z.string().optional().describe('flow UUID'),
      contact_id: z.string().optional().describe('contact UUID'),
      status: z.enum(['active', 'completed', 'handed_off', 'timed_out', 'paused_by_agent', 'failed']).optional(),
      limit,
      cursor,
    },
    async (args) => run('get_flow_runs', args, () => getFlowRuns(args)),
  )

  server.tool(
    'list_pipelines_deals',
    'Sales pipelines + stages, plus deals (with contact + stage) filtered by pipeline/stage/status. Deals paginated.',
    {
      pipeline_id: z.string().optional(),
      stage_id: z.string().optional(),
      status: z.enum(['open', 'won', 'lost']).optional(),
      limit,
      cursor,
    },
    async (args) => run('list_pipelines_deals', args, () => listPipelinesDeals(args)),
  )

  server.tool(
    'list_tags',
    'List contact tags. Paginated.',
    { limit, cursor },
    async (args) => run('list_tags', args, () => listTags(args)),
  )

  server.tool(
    'list_orders',
    'List Shopify orders (customer, totals, financial/fulfillment/COD status, tracking). Paginated.',
    {
      cod_status: z.enum(['pending', 'confirmed', 'cancel_requested', 'no_reply']).optional(),
      financial_status: z.string().max(40).optional(),
      limit,
      cursor,
    },
    async (args) => run('list_orders', args, () => listOrders(args)),
  )

  server.tool(
    'list_abandoned_checkouts',
    'List Shopify abandoned checkouts (customer, totals, recovery URL, recovered flag). Never returns the checkout token. Paginated.',
    { recovered: z.boolean().optional().describe('filter by recovered'), limit, cursor },
    async (args) => run('list_abandoned_checkouts', args, () => listAbandonedCheckouts(args)),
  )
}
