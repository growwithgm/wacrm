import { describe, expect, it } from 'vitest'
import {
  buildRecoveryParams,
  recoveryButtonSource,
  type RecoveryFields,
} from './fields'

const FIELDS: RecoveryFields = {
  first_name: 'María',
  full_name: 'María García',
  cart_total: '45,00 €',
  currency: 'EUR',
  items_count: 3,
}

describe('buildRecoveryParams', () => {
  it('empty map reproduces today\'s behavior ({{1}} first name, {{2}} cart total)', () => {
    expect(buildRecoveryParams({}, FIELDS, 2)).toEqual(['María', '45,00 €'])
    expect(buildRecoveryParams(null, FIELDS, 2)).toEqual(['María', '45,00 €'])
    expect(buildRecoveryParams(undefined, FIELDS, 2)).toEqual(['María', '45,00 €'])
  })

  it('honors a custom mapping', () => {
    const map = { '1': 'full_name', '2': 'items_count' }
    expect(buildRecoveryParams(map, FIELDS, 2)).toEqual(['María García', '3'])
  })

  it('falls back to the per-index default for unmapped placeholders', () => {
    // {{1}} set, {{2}} left to default (cart_total).
    expect(buildRecoveryParams({ '1': 'currency' }, FIELDS, 2)).toEqual(['EUR', '45,00 €'])
  })

  it('returns exactly placeholderCount params', () => {
    expect(buildRecoveryParams({}, FIELDS, 1)).toEqual(['María'])
    expect(buildRecoveryParams({}, FIELDS, 0)).toEqual([])
  })
})

describe('recoveryButtonSource', () => {
  it('defaults to the recovery URL when unset', () => {
    expect(recoveryButtonSource({})).toBe('recovery_url')
    expect(recoveryButtonSource(null)).toBe('recovery_url')
  })

  it('honors an explicit button source', () => {
    expect(recoveryButtonSource({ button: 'recovery_url' })).toBe('recovery_url')
  })
})
