import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import {
  assertIsTestRecipient,
  assertNoRecipientKey,
  RECIPIENT_KEYS,
  runSendTest,
  SEND_TEST_SHAPE,
  TEST_RECIPIENT,
  type SendDeps,
} from './send-test'

function setup(overrides: Record<string, unknown> = {}) {
  const calls: { template?: Record<string, unknown>; text?: Record<string, unknown> } = {}
  const m = {
    sendTemplate: vi.fn((a: Record<string, unknown>) => {
      calls.template = a
      return Promise.resolve({ messageId: 'wamid.TEST' })
    }),
    sendText: vi.fn((a: Record<string, unknown>) => {
      calls.text = a
      return Promise.resolve({ messageId: 'wamid.TEST' })
    }),
    getSendConfig: vi.fn(async () => ({ phone_number_id: '999', access_token: 'enc' })),
    decrypt: vi.fn(() => 'plaintext-token'),
    countToday: vi.fn(async () => 0),
    record: vi.fn(async () => {}),
    ...overrides,
  }
  return { m, deps: m as unknown as SendDeps, calls }
}

describe('send_test_message — recipient denylist', () => {
  it('rejects a call carrying a `to` key and does NOT send', async () => {
    const { m, deps } = setup()
    await expect(
      runSendTest({ kind: 'template', template_name: 't', to: '+11111111111' }, deps),
    ).rejects.toThrow(/recipient/i)
    expect(m.sendTemplate).not.toHaveBeenCalled()
    expect(m.record).toHaveBeenCalledWith('send_test_message', expect.anything(), 'denied', expect.anything())
  })

  it('assertNoRecipientKey throws for every forbidden key, passes for allowed args', () => {
    for (const k of RECIPIENT_KEYS) {
      expect(() => assertNoRecipientKey({ [k]: '+11111111111' })).toThrow()
    }
    expect(() => assertNoRecipientKey({ kind: 'template', template_name: 't' })).not.toThrow()
  })

  it('the zod schema itself rejects a `to`/`phone` field', () => {
    const schema = z.object(SEND_TEST_SHAPE)
    expect(schema.safeParse({ to: '+11111111111', kind: 'template', template_name: 't' }).success).toBe(false)
    expect(schema.safeParse({ phone: '+11111111111', kind: 'template', template_name: 't' }).success).toBe(false)
    expect(schema.safeParse({ kind: 'template', template_name: 't' }).success).toBe(true)
  })
})

describe('send_test_message — dry run', () => {
  it('defaults to dry run and makes ZERO Meta calls', async () => {
    const { m, deps } = setup()
    const res = await runSendTest({ kind: 'template', template_name: 'welcome' }, deps)
    expect(res.dry_run).toBe(true)
    expect(m.sendTemplate).not.toHaveBeenCalled()
    expect(m.sendText).not.toHaveBeenCalled()
    expect(res.would_send).toBeTruthy()
    expect(m.record).toHaveBeenCalledWith('send_test_message', expect.anything(), 'dry_run', expect.anything())
  })

  it('dry-run payload targets the sanitized test recipient only', async () => {
    const { deps } = setup()
    const res = (await runSendTest({ kind: 'template', template_name: 'welcome', dry_run: true }, deps)) as {
      would_send: { to: string }
    }
    expect(res.would_send.to).toBe('34632189061')
  })
})

describe('send_test_message — daily cap', () => {
  it('rejects a real send once the cap is reached and does NOT call Meta', async () => {
    const { m, deps } = setup({ countToday: vi.fn(async () => 20) })
    const res = await runSendTest({ kind: 'template', template_name: 'welcome', dry_run: false }, deps)
    expect(res.ok).toBe(false)
    expect(res.error).toBe('daily_cap_reached')
    expect(m.sendTemplate).not.toHaveBeenCalled()
    expect(m.record).toHaveBeenCalledWith('send_test_message', expect.anything(), 'rate_limited', expect.anything())
  })
})

describe('send_test_message — real send path', () => {
  it('sends exactly ONE message to the hardcoded test number', async () => {
    const { m, deps, calls } = setup()
    const res = (await runSendTest(
      { kind: 'template', template_name: 'welcome', template_language: 'es', dry_run: false },
      deps,
    )) as { ok: boolean; whatsapp_message_id: string }
    expect(m.sendTemplate).toHaveBeenCalledTimes(1)
    expect(m.sendText).not.toHaveBeenCalled()
    expect(calls.template?.to).toBe('34632189061') // sanitize('+34632189061')
    expect(calls.template?.templateName).toBe('welcome')
    expect(res.ok).toBe(true)
    expect(res.whatsapp_message_id).toBe('wamid.TEST')
    expect(m.record).toHaveBeenCalledWith('send_test_message', expect.anything(), 'ok', expect.anything())
  })
})

describe('send_test_message — pre-send re-assertion', () => {
  it('accepts the test recipient (with or without +) and rejects anything else', () => {
    expect(() => assertIsTestRecipient('+34632189061')).not.toThrow()
    expect(() => assertIsTestRecipient('34632189061')).not.toThrow()
    expect(() => assertIsTestRecipient('+11111111111')).toThrow(/re-assertion/i)
    expect(() => assertIsTestRecipient('')).toThrow()
  })

  it('TEST_RECIPIENT is the owner test number', () => {
    expect(TEST_RECIPIENT).toBe('+34632189061')
  })
})
