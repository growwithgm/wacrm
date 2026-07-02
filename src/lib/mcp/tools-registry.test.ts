import { describe, expect, it } from 'vitest'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { registerReadTools } from './tools/read'
import { registerSendTestTool } from './tools/send-test'

// Guards against scope creep: the OAuth work (Phase 4) must NOT add, remove, or
// rename any tool. The MCP surface is exactly the 17 read tools + the single
// guarded send tool — and nothing else.
const EXPECTED_TOOLS = [
  'get_automation',
  'get_broadcast',
  'get_connection_status',
  'get_contact',
  'get_conversation_messages',
  'get_dashboard_metrics',
  'get_flow_runs',
  'list_abandoned_checkouts',
  'list_automations',
  'list_broadcasts',
  'list_contacts',
  'list_conversations',
  'list_flows',
  'list_orders',
  'list_pipelines_deals',
  'list_tags',
  'list_templates',
  'send_test_message',
].sort()

describe('MCP tool registry', () => {
  it('registers exactly the 17 read tools + send_test_message and nothing else', () => {
    const names: string[] = []
    const mockServer = { tool: (name: string) => names.push(name) } as unknown as McpServer
    registerReadTools(mockServer)
    registerSendTestTool(mockServer)
    expect(names.sort()).toEqual(EXPECTED_TOOLS)
    expect(names.length).toBe(18)
    expect(names.filter((n) => n === 'send_test_message').length).toBe(1)
  })
})
