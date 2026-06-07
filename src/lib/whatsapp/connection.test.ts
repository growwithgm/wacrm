import { describe, it, expect } from 'vitest'
import { deriveStateFromDebug } from './connection'

const WABA = '26259535476964141'

describe('deriveStateFromDebug', () => {
  it('connected — valid token with messaging granted for our WABA', () => {
    const r = deriveStateFromDebug(
      {
        is_valid: true,
        scopes: ['whatsapp_business_management', 'whatsapp_business_messaging'],
        granular_scopes: [
          { scope: 'whatsapp_business_messaging', target_ids: [WABA, '999'] },
          { scope: 'whatsapp_business_management', target_ids: [WABA] },
        ],
      },
      WABA,
    )
    expect(r.state).toBe('connected')
    expect(r.tokenValid).toBe(true)
  })

  it('cannot_send — messaging granted but for a DIFFERENT WABA', () => {
    const r = deriveStateFromDebug(
      {
        is_valid: true,
        scopes: ['whatsapp_business_messaging'],
        granular_scopes: [{ scope: 'whatsapp_business_messaging', target_ids: ['111', '222'] }],
      },
      WABA,
    )
    expect(r.state).toBe('cannot_send')
    expect(r.tokenValid).toBe(true)
  })

  it('cannot_send — valid token with management only, no messaging', () => {
    const r = deriveStateFromDebug(
      {
        is_valid: true,
        scopes: ['whatsapp_business_management'],
        granular_scopes: [{ scope: 'whatsapp_business_management', target_ids: [WABA] }],
      },
      WABA,
    )
    expect(r.state).toBe('cannot_send')
  })

  it('not_connected — revoked / invalid token', () => {
    const r = deriveStateFromDebug(
      { is_valid: false, error: { code: 190, message: 'Token has been revoked' } },
      WABA,
    )
    expect(r.state).toBe('not_connected')
    expect(r.tokenValid).toBe(false)
    expect(r.detail).toMatch(/revoked/i)
  })

  it('not_connected — null/empty debug response', () => {
    expect(deriveStateFromDebug(null, WABA).state).toBe('not_connected')
    expect(deriveStateFromDebug(undefined, WABA).state).toBe('not_connected')
  })

  it('not_connected — valid flag but past expiry', () => {
    const r = deriveStateFromDebug(
      { is_valid: true, expires_at: 1, scopes: ['whatsapp_business_messaging'] },
      WABA,
    )
    expect(r.state).toBe('not_connected')
  })

  it('connected — messaging in flat scopes when no granular info present', () => {
    const r = deriveStateFromDebug(
      { is_valid: true, scopes: ['whatsapp_business_messaging'] },
      WABA,
    )
    expect(r.state).toBe('connected')
  })

  it('connected — granular messaging with empty target_ids (unrestricted)', () => {
    const r = deriveStateFromDebug(
      {
        is_valid: true,
        scopes: ['whatsapp_business_messaging'],
        granular_scopes: [{ scope: 'whatsapp_business_messaging', target_ids: [] }],
      },
      WABA,
    )
    expect(r.state).toBe('connected')
  })
})
