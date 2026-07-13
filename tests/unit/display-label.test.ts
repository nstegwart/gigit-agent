import { describe, expect, it } from 'vitest'

import {
  formatDenseTimestamp,
  formatOperationalLabel,
  truncateIdentifier,
} from '#/lib/display-label'

describe('formatOperationalLabel', () => {
  it('spaces SCREAMING_SNAKE operational enums', () => {
    expect(formatOperationalLabel('PRIORITY_FRONTIER_EMPTY')).toBe('PRIORITY FRONTIER EMPTY')
    expect(formatOperationalLabel('EMPTY_PRODUCT_SCOPE')).toBe('EMPTY PRODUCT SCOPE')
    expect(formatOperationalLabel('SALES_WEB_RELATED_BACKEND')).toBe('SALES WEB RELATED BACKEND')
  })

  it('preserves hyphenated ids (no mid-token rewrite)', () => {
    expect(formatOperationalLabel('run-synth-ongoing')).toBe('run-synth-ongoing')
  })

  it('handles null/empty', () => {
    expect(formatOperationalLabel(null)).toBe('')
    expect(formatOperationalLabel('')).toBe('')
    expect(formatOperationalLabel('  ')).toBe('')
  })
})

describe('formatDenseTimestamp', () => {
  it('compacts ISO without losing date+time', () => {
    expect(formatDenseTimestamp('2026-07-13T12:27:54.310Z')).toBe('2026-07-13 12:27')
  })

  it('returns em dash for empty', () => {
    expect(formatDenseTimestamp(null)).toBe('—')
  })
})

describe('truncateIdentifier', () => {
  it('keeps short ids whole', () => {
    expect(truncateIdentifier('run-1')).toEqual({
      display: 'run-1',
      full: 'run-1',
      truncated: false,
    })
  })

  it('truncates long ids with head…tail', () => {
    const r = truncateIdentifier('cc-mfs-rebuild-b15978e0a844fcc6', 8, 6)
    expect(r.truncated).toBe(true)
    expect(r.full).toBe('cc-mfs-rebuild-b15978e0a844fcc6')
    expect(r.display).toBe('cc-mfs-r…44fcc6')
  })
})
