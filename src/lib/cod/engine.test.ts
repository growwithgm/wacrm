import { describe, it, expect } from 'vitest'
import { matchCodReply } from './engine'

describe('matchCodReply', () => {
  // The REAL approved template button titles are full strings, not bare
  // "SÍ"/"NO". These two are the ones that actually arrive in content_text
  // when a customer taps a COD confirmation button.
  it('classifies the real COD quick-reply button titles', () => {
    expect(matchCodReply('SÍ confirmo')).toBe('yes')
    expect(matchCodReply('NO cancelar')).toBe('no')
  })

  // "NO cancelar" contains both "no" and "cancelar" — both NO-side keywords,
  // never YES — so it can never be misread as a confirmation. The YES regex is
  // checked first but matches none of its tokens here.
  it('never misreads "NO cancelar" as yes', () => {
    expect(matchCodReply('NO cancelar')).not.toBe('yes')
    expect(matchCodReply('no cancelar')).toBe('no')
    expect(matchCodReply('NO CANCELAR')).toBe('no')
  })

  it('handles accents and case (SÍ/Sí/si/SI → yes)', () => {
    for (const s of ['SÍ', 'Sí', 'sí', 'si', 'SI']) {
      expect(matchCodReply(s)).toBe('yes')
    }
    for (const s of ['NO', 'No', 'no']) {
      expect(matchCodReply(s)).toBe('no')
    }
  })

  it('matches other affirmative/negative wordings', () => {
    expect(matchCodReply('confirmo')).toBe('yes')
    expect(matchCodReply('Confirmar pedido')).toBe('yes')
    expect(matchCodReply('yes')).toBe('yes')
    expect(matchCodReply('no gracias')).toBe('no')
    expect(matchCodReply('cancelar')).toBe('no')
  })

  it('returns null for unrelated / empty replies', () => {
    expect(matchCodReply('quizás')).toBeNull()
    expect(matchCodReply('tal vez')).toBeNull()
    expect(matchCodReply('')).toBeNull()
    expect(matchCodReply(null)).toBeNull()
    expect(matchCodReply(undefined)).toBeNull()
  })
})
