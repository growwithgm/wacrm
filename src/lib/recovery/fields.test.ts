import { describe, expect, it } from 'vitest'
import {
  buildRecoveryParams,
  recoveryButtonSource,
  varMapUsesDiscount,
  recoveryFieldValue,
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
    expect(recoveryButtonSource({ button: 'recovery_url_with_discount' })).toBe(
      'recovery_url_with_discount',
    )
  })
})

describe('varMapUsesDiscount', () => {
  it('is false for empty / default-only maps', () => {
    expect(varMapUsesDiscount(null)).toBe(false)
    expect(varMapUsesDiscount({})).toBe(false)
    expect(varMapUsesDiscount({ '1': 'first_name', '2': 'cart_total' })).toBe(false)
  })

  it('is true when a body placeholder maps to discount_code', () => {
    expect(varMapUsesDiscount({ '1': 'first_name', '2': 'discount_code' })).toBe(true)
  })

  it('is true when the button uses the with-discount URL', () => {
    expect(varMapUsesDiscount({ button: 'recovery_url_with_discount' })).toBe(true)
  })

  it('is false when the button is the plain recovery URL', () => {
    expect(varMapUsesDiscount({ button: 'recovery_url' })).toBe(false)
  })
})

describe('recoveryFieldValue (discount_code)', () => {
  it('returns the generated code, or empty when absent', () => {
    const f: RecoveryFields = { discount_code: 'SAVE10-AB12' }
    expect(recoveryFieldValue('discount_code', f)).toBe('SAVE10-AB12')
    expect(recoveryFieldValue('discount_code', {})).toBe('')
  })
})
