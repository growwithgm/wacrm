import { describe, expect, it } from 'vitest'
import { clampLimit, decodeCursor, encodeCursor, nextCursor } from './pagination'

describe('clampLimit', () => {
  it('falls back to the default when unset', () => {
    expect(clampLimit(undefined, 25, 100)).toBe(25)
  })
  it('caps an over-large request to the max', () => {
    expect(clampLimit(1000, 25, 100)).toBe(100)
  })
  it('caps absurd values to the max (no bulk dump)', () => {
    expect(clampLimit(1e12, 25, 50)).toBe(50)
  })
  it('floors to at least 1', () => {
    expect(clampLimit(0, 25, 100)).toBe(1)
    expect(clampLimit(-5, 25, 100)).toBe(1)
  })
  it('passes through an in-range value', () => {
    expect(clampLimit(30, 25, 100)).toBe(30)
  })
  it('floors fractional requests', () => {
    expect(clampLimit(10.9, 25, 100)).toBe(10)
  })
  it('ignores NaN', () => {
    expect(clampLimit(Number.NaN, 25, 100)).toBe(25)
  })
})

describe('cursor', () => {
  it('round-trips an offset', () => {
    expect(decodeCursor(encodeCursor(75))).toBe(75)
  })
  it('treats a missing cursor as offset 0', () => {
    expect(decodeCursor(undefined)).toBe(0)
  })
  it('treats garbage as offset 0', () => {
    expect(decodeCursor('%%%not-a-cursor')).toBe(0)
  })
  it('returns null next cursor on a short (final) page', () => {
    expect(nextCursor(10, 25, 0)).toBeNull()
  })
  it('advances the offset on a full page', () => {
    const c = nextCursor(25, 25, 50)
    expect(c).not.toBeNull()
    expect(decodeCursor(c as string)).toBe(75)
  })
})
