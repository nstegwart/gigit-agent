import { describe, expect, it } from 'vitest'

import {
  countMappingProgressTasks,
  MAPPING_PROGRESS_STAGE_KEYS,
} from '#/server/mapping-version-loader'
import {
  deriveDynamicDenominator,
  ingestMappingSnapshot,
  mappingLiveProgress,
} from '#/server/adaptive-mapping'

describe('mapping-version-loader: progress stages', () => {
  it('declares mapping progress stages without hardcoded 639', () => {
    expect(MAPPING_PROGRESS_STAGE_KEYS).toContain('MAP_VERIFIED')
    expect(MAPPING_PROGRESS_STAGE_KEYS).not.toContain('639')
  })
})

describe('mapping-version-loader: live progress wire', () => {
  it('mappingLiveProgress uses dynamic denominator from ingest', () => {
    const version = ingestMappingSnapshot({
      schemaVersion: 'MFS_CANONICAL_TASK_SNAPSHOT_V1',
      tasks: Array.from({ length: 50 }, (_, i) => ({
        id: `t-${i}`,
        title: `T${i}`,
        projectId: 'p',
      })),
      generatedAt: '2026-07-16T04:00:00.000Z',
    }).version
    expect(deriveDynamicDenominator({ tasks: Array.from({ length: 50 }) })).toBe(50)
    const progress = mappingLiveProgress(version, 12)
    expect(progress.denominator).toBe(50)
    expect(progress.completed).toBe(12)
    expect(progress.notReadiness).toBe(true)
    expect(progress.label).toBe('mapping_progress')
  })
})

describe('mapping-version-loader: countMappingProgressTasks', () => {
  it('returns 0 for unknown board (honest degrade)', async () => {
    const n = await countMappingProgressTasks('__nonexistent_board_for_unit_test__')
    expect(n).toBe(0)
  })
})