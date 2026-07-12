import { describe, it, expect } from 'vitest'
import {
  fmtDate,
  dur,
  PHASE_CLS,
  STATUS_LBL,
  PROJ_STATUS,
  AGENT_ICON,
} from '#/lib/format'

describe('fmtDate', () => {
  it('formats a full timestamp as "<d> <Mon> · HH:MM"', () => {
    expect(fmtDate('2026-07-11T19:10:00+07:00')).toBe('11 Jul · 19:10')
  })

  it('formats a date-only value without a time part', () => {
    expect(fmtDate('2026-07-11')).toBe('11 Jul')
  })

  it('returns "" for empty / null / undefined', () => {
    expect(fmtDate('')).toBe('')
    expect(fmtDate(null)).toBe('')
    expect(fmtDate(undefined)).toBe('')
  })

  it('drops leading zero on the day of month', () => {
    expect(fmtDate('2026-01-05T09:03:00+07:00')).toBe('5 Jan · 09:03')
  })
})

describe('dur', () => {
  it('formats spans of an hour or more as "Xh Ym"', () => {
    expect(dur('2026-07-11T10:00:00Z', '2026-07-11T11:28:00Z')).toBe('1h 28m')
  })

  it('formats sub-hour spans as "Ym"', () => {
    expect(dur('2026-07-11T10:00:00Z', '2026-07-11T10:28:00Z')).toBe('28m')
  })

  it('returns "" when either timestamp is missing', () => {
    expect(dur(undefined, '2026-07-11T10:28:00Z')).toBe('')
    expect(dur('2026-07-11T10:00:00Z', undefined)).toBe('')
    expect(dur(undefined, undefined)).toBe('')
  })

  it('returns "" for a non-positive span', () => {
    expect(dur('2026-07-11T11:00:00Z', '2026-07-11T10:00:00Z')).toBe('')
    expect(dur('2026-07-11T10:00:00Z', '2026-07-11T10:00:00Z')).toBe('')
  })
})

describe('presentation constant maps', () => {
  it('PHASE_CLS has every phase key', () => {
    expect(Object.keys(PHASE_CLS).sort()).toEqual(
      ['backlog', 'build', 'design', 'done', 'qa', 'review-owner', 'spec', 'uat'].sort(),
    )
  })

  it('STATUS_LBL has every run-status key', () => {
    expect(Object.keys(STATUS_LBL).sort()).toEqual(
      ['blocked', 'done', 'failed', 'queued', 'running'].sort(),
    )
  })

  it('PROJ_STATUS has every project-status key with [class, label] tuples', () => {
    expect(Object.keys(PROJ_STATUS).sort()).toEqual(
      ['internal', 'live', 'planned'].sort(),
    )
    expect(PROJ_STATUS.live).toEqual(['st-live', 'Live'])
  })

  it('AGENT_ICON has every agent-type key', () => {
    expect(Object.keys(AGENT_ICON).sort()).toEqual(
      ['claude', 'codex', 'grok'].sort(),
    )
  })
})
