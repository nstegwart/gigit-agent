/**
 * C3-R1A: raw Work URL search parsing — `?stale=1` must not crash.
 * Support evidence only (LOCAL ONLY); no browser pair.
 */
import { describe, expect, it } from 'vitest'

import {
  coerceWorkSearchString,
  parseWorkRouteSearch,
  selectDefaultWorkBucket,
  workSearchSchema,
} from '#/routes/b.$boardId.work.index'
import { parseWorkDeepLink } from '#/components/control-center/work'

describe('coerceWorkSearchString', () => {
  it('coerces number 1 / boolean / string; drops invalid objects', () => {
    expect(coerceWorkSearchString(1)).toBe('1')
    expect(coerceWorkSearchString(0)).toBe('0')
    expect(coerceWorkSearchString(true)).toBe('true')
    expect(coerceWorkSearchString(false)).toBe('false')
    expect(coerceWorkSearchString('1')).toBe('1')
    expect(coerceWorkSearchString('true')).toBe('true')
    expect(coerceWorkSearchString(undefined)).toBeUndefined()
    expect(coerceWorkSearchString(null)).toBeUndefined()
    expect(coerceWorkSearchString('')).toBeUndefined()
    expect(coerceWorkSearchString({ x: 1 })).toBeUndefined()
    expect(coerceWorkSearchString([1])).toBeUndefined()
    expect(coerceWorkSearchString(Number.NaN)).toBeUndefined()
  })
})

describe('parseWorkRouteSearch — previously failing ?stale=1', () => {
  it('accepts raw number stale=1 without throw (C3-V1 BLOCKER)', () => {
    // TanStack / URL parsers often pass ?stale=1 as number, not string
    const parsed = parseWorkRouteSearch({ stale: 1 })
    expect(parsed.stale).toBe('1')
    const deep = parseWorkDeepLink('mfs-rebuild', { stale: parsed.stale })
    expect(deep.staleOverlay).toBe(true)
  })

  it('UI-generated string stale=1 / true / STALE overlay remain truthy', () => {
    expect(parseWorkRouteSearch({ stale: '1' }).stale).toBe('1')
    expect(parseWorkRouteSearch({ stale: 'true' }).stale).toBe('true')
    const viaOverlay = parseWorkDeepLink('b', {
      stale: parseWorkRouteSearch({}).stale,
      overlay: 'STALE_DATA_SOURCE',
    })
    expect(viaOverlay.staleOverlay).toBe(true)
  })

  it('absent stale → undefined; overlay false when no STALE overlay param', () => {
    const parsed = parseWorkRouteSearch({})
    expect(parsed.stale).toBeUndefined()
    expect(parseWorkDeepLink('b', { stale: parsed.stale }).staleOverlay).toBe(false)
  })

  it('invalid stale values do not crash; coerce to omit', () => {
    expect(() => parseWorkRouteSearch({ stale: { bad: true } })).not.toThrow()
    expect(parseWorkRouteSearch({ stale: { bad: true } }).stale).toBeUndefined()
    expect(() => parseWorkRouteSearch({ stale: ['1'] })).not.toThrow()
    expect(parseWorkRouteSearch({ stale: ['1'] }).stale).toBeUndefined()
    expect(() => parseWorkRouteSearch(null)).not.toThrow()
    expect(parseWorkRouteSearch(null)).toEqual({})
    expect(() => parseWorkRouteSearch(undefined)).not.toThrow()
    expect(() => parseWorkRouteSearch('stale=1')).not.toThrow()
  })

  it('boolean true/false search values coerce deterministically', () => {
    expect(parseWorkRouteSearch({ stale: true }).stale).toBe('true')
    expect(parseWorkRouteSearch({ stale: false }).stale).toBe('false')
    expect(parseWorkDeepLink('b', { stale: 'true' }).staleOverlay).toBe(true)
    // 'false' is not a truthy stale token in parseWorkDeepLink
    expect(parseWorkDeepLink('b', { stale: 'false' }).staleOverlay).toBe(false)
  })

  it('schema.parse via workSearchSchema accepts coerced number through preprocess', () => {
    const r = workSearchSchema.safeParse({ stale: 1, bucket: 'BLOCKED', boardRev: 12 })
    expect(r.success).toBe(true)
    if (r.success) {
      expect(r.data.stale).toBe('1')
      expect(r.data.bucket).toBe('BLOCKED')
      expect(r.data.boardRev).toBe('12')
    }
  })
})

describe('selectDefaultWorkBucket (W-FIX-WORK smart landing)', () => {
  it('picks largest non-empty; production shape lands on BLOCKED not empty ONGOING', () => {
    expect(
      selectDefaultWorkBucket({
        DONE: 0,
        RECONCILIATION_PENDING: 0,
        ONGOING: 0,
        NEXT: 0,
        QUEUED: 0,
        BLOCKED: 2501,
      }),
    ).toBe('BLOCKED')
  })

  it('null/undefined/all-zero → ONGOING provisional', () => {
    expect(selectDefaultWorkBucket(null)).toBe('ONGOING')
    expect(selectDefaultWorkBucket(undefined)).toBe('ONGOING')
    expect(
      selectDefaultWorkBucket({
        DONE: 0,
        RECONCILIATION_PENDING: 0,
        ONGOING: 0,
        NEXT: 0,
        QUEUED: 0,
        BLOCKED: 0,
      }),
    ).toBe('ONGOING')
  })

  it('largest wins over needs-action when counts differ', () => {
    expect(
      selectDefaultWorkBucket({
        DONE: 0,
        RECONCILIATION_PENDING: 0,
        ONGOING: 3,
        NEXT: 1,
        QUEUED: 0,
        BLOCKED: 2,
      }),
    ).toBe('ONGOING')
  })

  it('ties break by needs-action priority BLOCKED > NEXT > QUEUED > ONGOING', () => {
    expect(
      selectDefaultWorkBucket({
        DONE: 0,
        RECONCILIATION_PENDING: 0,
        ONGOING: 5,
        NEXT: 5,
        QUEUED: 0,
        BLOCKED: 5,
      }),
    ).toBe('BLOCKED')
    expect(
      selectDefaultWorkBucket({
        DONE: 0,
        RECONCILIATION_PENDING: 0,
        ONGOING: 4,
        NEXT: 4,
        QUEUED: 0,
        BLOCKED: 0,
      }),
    ).toBe('NEXT')
  })
})
