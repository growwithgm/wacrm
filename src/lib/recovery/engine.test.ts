import { describe, expect, it } from 'vitest'
import { matchesStopKeyword } from './engine'

describe('matchesStopKeyword', () => {
  const defaults = ['stop', 'baja', 'parar', 'unsubscribe']

  it('matches a bare keyword (case-insensitive)', () => {
    expect(matchesStopKeyword('STOP', defaults)).toBe(true)
    expect(matchesStopKeyword('stop', defaults)).toBe(true)
    expect(matchesStopKeyword('Unsubscribe', defaults)).toBe(true)
  })

  it('matches a keyword embedded as a whole word', () => {
    expect(matchesStopKeyword('STOP please', defaults)).toBe(true)
    expect(matchesStopKeyword('quiero baja por favor', defaults)).toBe(true)
  })

  it('is accent-insensitive', () => {
    expect(matchesStopKeyword('PÁRAR', defaults)).toBe(true)
  })

  it('does NOT match a keyword inside another word', () => {
    expect(matchesStopKeyword('stopwatch', defaults)).toBe(false)
    expect(matchesStopKeyword('trabajar', defaults)).toBe(false) // contains "baja"
  })

  it('does not match unrelated replies (e.g. COD SÍ/NO)', () => {
    expect(matchesStopKeyword('SÍ confirmo', defaults)).toBe(false)
    expect(matchesStopKeyword('NO cancelar', defaults)).toBe(false)
    expect(matchesStopKeyword('gracias', defaults)).toBe(false)
  })

  it('supports multi-word keywords via substring', () => {
    expect(matchesStopKeyword('por favor no molestar mas', ['no molestar'])).toBe(true)
    expect(matchesStopKeyword('molestar', ['no molestar'])).toBe(false)
  })

  it('falls back to defaults when no keywords configured', () => {
    expect(matchesStopKeyword('stop', null)).toBe(true)
    expect(matchesStopKeyword('stop', [])).toBe(true)
  })

  it('returns false for empty / missing text', () => {
    expect(matchesStopKeyword(null, defaults)).toBe(false)
    expect(matchesStopKeyword('', defaults)).toBe(false)
    expect(matchesStopKeyword('   ', defaults)).toBe(false)
  })

  it('uses a custom keyword list', () => {
    expect(matchesStopKeyword('cancelar', ['cancelar'])).toBe(true)
    expect(matchesStopKeyword('cancelar', defaults)).toBe(false) // not in defaults
  })
})
