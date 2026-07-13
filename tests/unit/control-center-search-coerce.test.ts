/**
 * C3-R4I H1: fail-soft cursor/pageSize search for decisions/features/agents/evidence.
 * Support evidence only (LOCAL ONLY); no browser pair.
 */
import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import {
  coerceControlCenterSearchString,
  controlCenterCursorSearchSchema,
  parseControlCenterCursorSearch,
} from '#/lib/control-center-search'

describe('coerceControlCenterSearchString', () => {
  it('coerces number/boolean/string; drops invalid objects', () => {
    expect(coerceControlCenterSearchString(50)).toBe('50')
    expect(coerceControlCenterSearchString(12)).toBe('12')
    expect(coerceControlCenterSearchString(0)).toBe('0')
    expect(coerceControlCenterSearchString(true)).toBe('true')
    expect(coerceControlCenterSearchString(false)).toBe('false')
    expect(coerceControlCenterSearchString('50')).toBe('50')
    expect(coerceControlCenterSearchString(undefined)).toBeUndefined()
    expect(coerceControlCenterSearchString(null)).toBeUndefined()
    expect(coerceControlCenterSearchString('')).toBeUndefined()
    expect(coerceControlCenterSearchString({ x: 1 })).toBeUndefined()
    expect(coerceControlCenterSearchString([50])).toBeUndefined()
    expect(coerceControlCenterSearchString(Number.NaN)).toBeUndefined()
  })
})

describe('parseControlCenterCursorSearch — numeric pageSize/cursor never throw', () => {
  it('accepts raw number pageSize=50 and cursor=12 without throw', () => {
    const parsed = parseControlCenterCursorSearch({ pageSize: 50, cursor: 12 })
    expect(parsed.pageSize).toBe('50')
    expect(parsed.cursor).toBe('12')
  })

  it('accepts string pageSize/cursor', () => {
    const parsed = parseControlCenterCursorSearch({ pageSize: '50', cursor: 'abc' })
    expect(parsed.pageSize).toBe('50')
    expect(parsed.cursor).toBe('abc')
  })

  it('absent / invalid do not crash; coerce to omit', () => {
    expect(() => parseControlCenterCursorSearch({})).not.toThrow()
    expect(parseControlCenterCursorSearch({})).toEqual({})
    expect(() => parseControlCenterCursorSearch(null)).not.toThrow()
    expect(parseControlCenterCursorSearch(null)).toEqual({})
    expect(() => parseControlCenterCursorSearch({ pageSize: { bad: true } })).not.toThrow()
    expect(parseControlCenterCursorSearch({ pageSize: { bad: true } }).pageSize).toBeUndefined()
    expect(() => parseControlCenterCursorSearch({ cursor: ['x'] })).not.toThrow()
    expect(parseControlCenterCursorSearch({ cursor: ['x'] }).cursor).toBeUndefined()
  })

  it('schema.safeParse accepts coerced numbers through preprocess', () => {
    const r = controlCenterCursorSearchSchema.safeParse({ pageSize: 50, cursor: 12 })
    expect(r.success).toBe(true)
    if (r.success) {
      expect(r.data.pageSize).toBe('50')
      expect(r.data.cursor).toBe('12')
    }
  })

  it('raw z.string schema (pre-fix) rejects number — documents the bug class', () => {
    // Historical proof: fail-hard string-only schemas crash on numeric search values.
    const legacy = z.object({
      cursor: z.string().optional(),
      pageSize: z.string().optional(),
    })
    expect(legacy.safeParse({ pageSize: 50 }).success).toBe(false)
    expect(legacy.safeParse({ cursor: 12 }).success).toBe(false)
    // After coerce path: success
    expect(controlCenterCursorSearchSchema.safeParse({ pageSize: 50 }).success).toBe(true)
  })
})
