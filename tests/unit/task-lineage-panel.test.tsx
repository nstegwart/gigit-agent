/**
 * W-UI-3 — Per-task Lineage Rebuild panel.
 * Pure projection + component (verdict chip, stepper, graceful) + fixture T-RN-WELL-MED.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, within } from '@testing-library/react'

import {
  buildLineageSummarySentence,
  formatRelativeId,
  loadTaskLineage,
  mapParityVerdictToChip,
  projectTaskLineage,
  splitEvidenceSides,
  TASK_LINEAGE_UNAVAILABLE_LABEL_ID,
  type TaskLineageAvailable,
} from '#/server/control-center-rebuild-fns'
import {
  createMemoryRebuildParityDataAccess,
  setRebuildParityDataAccessForTests,
  REBUILD_DATA_TABLES_NOT_MIGRATED,
} from '#/server/rebuild-parity-mcp'
import type { RebuildLineageRecord } from '#/server/rebuild-lineage-store'
import { LineagePanel } from '#/components/control-center/task-detail'
import {
  taskLineageQueryKey,
  taskLineageQueryOptions,
} from '#/lib/control-center-query'

// ---------------------------------------------------------------------------
// Fixtures — T-RN-WELL-MED MAPPED_100 (shape mirrors REBUILD_LINEAGE.jsonl)
// ---------------------------------------------------------------------------

const NOW_MS = Date.parse('2026-07-17T12:00:00.000Z')

function fixtureRnWellMed(over: Partial<RebuildLineageRecord> = {}): RebuildLineageRecord {
  return {
    boardId: 'mfs-rebuild',
    taskId: 'T-RN-WELL-MED',
    disposition: 'ACTIVE',
    repository: 'legacy/rn-mfs81',
    origin: 'existing',
    featureContractId: 'FC-RN-WELLNESS-SUITE',
    parityVerdict: 'MAPPED_100',
    acceptanceCovered: 'full',
    verifierModel: 'gemini-3.5-flash',
    verifiedAt: '2026-07-16T06:00:00.000Z',
    stage1Json: {
      origin: 'existing',
      covered_legacy_units: ['RN-P50-MEDITATION'],
      legacy_anchors: [
        {
          repo: 'legacy/rn-mfs81',
          file: 'src/Navigations.js',
          symbol: 'Stack.Screen meditation stack',
          line_start: 696,
          fact: 'Registers meditation stack',
        },
      ],
      gap_class: 'EXISTING_MAPPED',
      featureContractId: 'FC-RN-WELLNESS-SUITE',
    },
    evidenceJson: [
      'legacy/rn-mfs81/src/Navigations.js:696-747',
      'legacy/rn-mfs81/src/screens/meditation-detail/index.js:230-233',
      'rebuild-backend/routes/api/meditation_breathing__guided.php:19-53',
      'rebuild-backend/routes/api/meditation_breathing.php:37-39',
    ],
    gapsJson: [],
    implementationJson: {
      has_real_output: true,
    },
    sourceHash: 'fixture-t-rn-well-med',
    syncedAt: '2026-07-17T06:00:00.000Z',
    ...over,
  }
}

afterEach(() => {
  setRebuildParityDataAccessForTests(null)
})

// ---------------------------------------------------------------------------
// Pure projection
// ---------------------------------------------------------------------------

describe('task lineage projection', () => {
  it('mapParityVerdictToChip uses semantic tones + id-ID labels', () => {
    expect(mapParityVerdictToChip('MAPPED_100')).toEqual({
      key: 'terbukti',
      labelId: 'Terbukti',
      tone: 'ok',
    })
    expect(mapParityVerdictToChip('PARTIAL')).toEqual({
      key: 'sebagian',
      labelId: 'Sebagian',
      tone: 'warn',
    })
    expect(mapParityVerdictToChip('MISSING')).toEqual({
      key: 'belum_ada',
      labelId: 'Belum ada',
      tone: 'blocked',
    })
    expect(mapParityVerdictToChip(null)).toEqual({
      key: 'belum_diukur',
      labelId: 'Belum diukur',
      tone: 'muted',
    })
    expect(mapParityVerdictToChip('PENDING')).toEqual({
      key: 'belum_diukur',
      labelId: 'Belum diukur',
      tone: 'muted',
    })
  })

  it('splitEvidenceSides separates legacy vs rebuild file:line', () => {
    const sides = splitEvidenceSides([
      'legacy/rn-mfs81/src/Navigations.js:696-747',
      'rebuild-backend/routes/api/meditation_breathing.php:37-39',
    ])
    expect(sides.legacy).toEqual(['legacy/rn-mfs81/src/Navigations.js:696-747'])
    expect(sides.rebuild).toEqual([
      'rebuild-backend/routes/api/meditation_breathing.php:37-39',
    ])
  })

  it('formatRelativeId emits id-ID relative labels', () => {
    expect(formatRelativeId('2026-07-17T11:54:00.000Z', NOW_MS)).toBe('6 menit lalu')
    expect(formatRelativeId('2026-07-16T12:00:00.000Z', NOW_MS)).toBe('1 hari lalu')
    expect(formatRelativeId(null, NOW_MS)).toBeNull()
  })

  it('buildLineageSummarySentence variants match verdict', () => {
    expect(
      buildLineageSummarySentence({
        chipKey: 'terbukti',
        verifierModel: 'gemini-3.5-flash',
        verifiedRelativeId: '1 hari lalu',
      }),
    ).toBe(
      'Task ini terbukti pindah ke rebuild (diverifikasi gemini-3.5-flash 1 hari lalu).',
    )
    expect(
      buildLineageSummarySentence({
        chipKey: 'sebagian',
        verifierModel: null,
        verifiedRelativeId: null,
      }),
    ).toBe('Task ini hanya sebagian pindah ke rebuild — masih ada gap bukti.')
    expect(
      buildLineageSummarySentence({
        chipKey: 'belum_ada',
        verifierModel: null,
        verifiedRelativeId: null,
      }),
    ).toBe(
      'Task ini belum terbukti pindah ke rebuild (bukti kode belum lengkap).',
    )
    expect(
      buildLineageSummarySentence({
        chipKey: 'belum_diukur',
        verifierModel: null,
        verifiedRelativeId: null,
      }),
    ).toBe('Parity task ini belum diukur.')
  })

  it('projectTaskLineage T-RN-WELL-MED MAPPED_100 is rollup-first complete', () => {
    const p = projectTaskLineage(fixtureRnWellMed(), { nowMs: NOW_MS })
    expect(p.available).toBe(true)
    expect(p.taskId).toBe('T-RN-WELL-MED')
    expect(p.parityVerdict).toBe('MAPPED_100')
    expect(p.chip).toEqual({ key: 'terbukti', labelId: 'Terbukti', tone: 'ok' })
    expect(p.summarySentenceId).toContain('terbukti pindah ke rebuild')
    expect(p.summarySentenceId).toContain('gemini-3.5-flash')
    expect(p.summarySentenceId).toContain('1 hari lalu')
    expect(p.origin.labelId).toBe('existing')
    expect(p.origin.coveredUnitCount).toBe(1)
    expect(p.origin.coveredUnits).toEqual(['RN-P50-MEDITATION'])
    expect(p.origin.legacyAnchors.length).toBe(1)
    expect(p.evidence.legacy.length).toBe(2)
    expect(p.evidence.rebuild.length).toBe(2)
    expect(p.evidence.gaps).toEqual([])
    expect(p.implementation.hasRealOutput).toBe(true)
    expect(p.implementation.hasRealOutputLabelId).toMatch(/nyata/i)
    expect(p.technical.featureContractId).toBe('FC-RN-WELLNESS-SUITE')
  })

  it('projectTaskLineage PARTIAL includes gaps + blindspot origin label', () => {
    const p = projectTaskLineage(
      fixtureRnWellMed({
        taskId: 'T-AFF-PARTIAL',
        parityVerdict: 'PARTIAL',
        origin: 'firm-new-blindspot',
        gapsJson: ['gap A', 'gap B'],
        implementationJson: { has_real_output: false, commit_sha: 'abc1234' },
        stage1Json: {
          origin: 'firm-new-blindspot',
          covered_legacy_units: [],
          gap_class: 'STAGE2_PARTIAL',
        },
      }),
      { nowMs: NOW_MS },
    )
    expect(p.chip.key).toBe('sebagian')
    expect(p.origin.labelId).toBe('blindspot-baru')
    expect(p.evidence.gaps).toEqual(['gap A', 'gap B'])
    expect(p.implementation.hasRealOutput).toBe(false)
    expect(p.implementation.commitSha).toBe('abc1234')
  })

  it('loadTaskLineage graceful when tables missing', async () => {
    setRebuildParityDataAccessForTests(
      createMemoryRebuildParityDataAccess({ tablesPresent: false }),
    )
    const data = await loadTaskLineage('mfs-rebuild', 'T-RN-WELL-MED')
    expect(data.available).toBe(false)
    if (data.available) throw new Error('expected unavailable')
    expect(data.reason).toBe(REBUILD_DATA_TABLES_NOT_MIGRATED)
    expect(data.emptyStateLabelId).toBe(TASK_LINEAGE_UNAVAILABLE_LABEL_ID)
  })

  it('loadTaskLineage graceful when task absent from lineage', async () => {
    setRebuildParityDataAccessForTests(
      createMemoryRebuildParityDataAccess({
        tablesPresent: true,
        lineage: [fixtureRnWellMed()],
      }),
    )
    const data = await loadTaskLineage('mfs-rebuild', 'T-DOES-NOT-EXIST')
    expect(data.available).toBe(false)
    if (data.available) throw new Error('expected unavailable')
    expect(data.reason).toBe('TASK_LINEAGE_NOT_FOUND')
    expect(data.emptyStateLabelId).toBe(TASK_LINEAGE_UNAVAILABLE_LABEL_ID)
  })

  it('loadTaskLineage returns projected record via memory access', async () => {
    setRebuildParityDataAccessForTests(
      createMemoryRebuildParityDataAccess({
        tablesPresent: true,
        lineage: [fixtureRnWellMed()],
      }),
    )
    const data = await loadTaskLineage('mfs-rebuild', 'T-RN-WELL-MED', {
      nowMs: NOW_MS,
    })
    expect(data.available).toBe(true)
    if (!data.available) throw new Error('expected available')
    expect(data.taskId).toBe('T-RN-WELL-MED')
    expect(data.chip.key).toBe('terbukti')
  })

  it('loadTaskLineage accepts injected record (no DB)', async () => {
    const data = await loadTaskLineage('mfs-rebuild', 'T-RN-WELL-MED', {
      record: fixtureRnWellMed(),
      nowMs: NOW_MS,
    })
    expect(data.available).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Query keys
// ---------------------------------------------------------------------------

describe('task lineage query options', () => {
  it('taskLineageQueryKey is board+task scoped', () => {
    expect(taskLineageQueryKey('mfs-rebuild', 'T-RN-WELL-MED')).toEqual([
      'control-center',
      'task-lineage',
      'mfs-rebuild',
      'T-RN-WELL-MED',
    ])
  })

  it('taskLineageQueryOptions wires key + fetcher', async () => {
    const fixture = await loadTaskLineage('mfs-rebuild', 'T-RN-WELL-MED', {
      record: fixtureRnWellMed(),
      nowMs: NOW_MS,
    })
    const opts = taskLineageQueryOptions('mfs-rebuild', 'T-RN-WELL-MED', async () => fixture)
    expect(opts.queryKey).toEqual([
      'control-center',
      'task-lineage',
      'mfs-rebuild',
      'T-RN-WELL-MED',
    ])
    const data = await opts.queryFn!({} as never)
    expect(data).toEqual(fixture)
  })
})

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

describe('LineagePanel component', () => {
  it('renders verdict chip + summary + 3-step stepper for T-RN-WELL-MED', () => {
    const data = projectTaskLineage(fixtureRnWellMed(), {
      nowMs: NOW_MS,
    }) as TaskLineageAvailable
    render(<LineagePanel data={data} surfaceState="ready" />)

    expect(screen.getByTestId('task-lineage-panel').getAttribute('data-chip')).toBe(
      'terbukti',
    )
    const chip = screen.getByTestId('task-lineage-verdict-chip')
    expect(chip.textContent).toContain('Terbukti')
    expect(chip.getAttribute('data-tone')).toBe('ok')
    expect(screen.getByTestId('task-lineage-summary-sentence').textContent).toMatch(
      /terbukti pindah ke rebuild/i,
    )

    const stepper = screen.getByTestId('task-lineage-stepper')
    expect(within(stepper).getByTestId('task-lineage-step-asal').textContent).toContain(
      'Asal-usul',
    )
    expect(within(stepper).getByTestId('task-lineage-step-bukti').textContent).toContain(
      'Bukti pindah',
    )
    expect(within(stepper).getByTestId('task-lineage-step-impl').textContent).toContain(
      'Implementasi',
    )

    expect(screen.getByTestId('task-lineage-covered-count').textContent).toContain('1')
    expect(screen.getByTestId('task-lineage-evidence-legacy')).toBeTruthy()
    expect(screen.getByTestId('task-lineage-evidence-rebuild')).toBeTruthy()
    expect(screen.getByTestId('task-lineage-impl-output').textContent).toMatch(
      /keluaran implementasi nyata/i,
    )
    expect(screen.getByText('Lineage Rebuild')).toBeTruthy()
  })

  it('renders graceful small line when unavailable (not a large empty panel)', () => {
    render(
      <LineagePanel
        data={{
          available: false,
          reason: 'TASK_LINEAGE_NOT_FOUND',
          boardId: 'mfs-rebuild',
          taskId: 'T-X',
          emptyStateLabelId: TASK_LINEAGE_UNAVAILABLE_LABEL_ID,
        }}
        surfaceState="unavailable"
      />,
    )
    const line = screen.getByTestId('task-lineage-unavailable')
    expect(line.textContent).toBe(TASK_LINEAGE_UNAVAILABLE_LABEL_ID)
    expect(screen.queryByTestId('task-lineage-panel')).toBeNull()
    expect(screen.queryByTestId('task-lineage-stepper')).toBeNull()
  })

  it('renders graceful line for null data with unavailable surface', () => {
    render(<LineagePanel data={null} surfaceState="unavailable" />)
    expect(screen.getByTestId('task-lineage-unavailable').textContent).toMatch(
      /Data lineage belum tersedia/i,
    )
  })

  it('shows gaps block for PARTIAL', () => {
    const data = projectTaskLineage(
      fixtureRnWellMed({
        parityVerdict: 'PARTIAL',
        gapsJson: ['CRITICAL rebuild_anchor stale'],
      }),
      { nowMs: NOW_MS },
    )
    render(<LineagePanel data={data} />)
    expect(screen.getByTestId('task-lineage-verdict-chip').textContent).toContain(
      'Sebagian',
    )
    expect(screen.getByTestId('task-lineage-gaps').textContent).toContain(
      'CRITICAL rebuild_anchor stale',
    )
  })

  it('shows loading line while surface=loading and data null', () => {
    render(<LineagePanel data={null} surfaceState="loading" />)
    expect(screen.getByTestId('task-lineage-loading').textContent).toMatch(
      /Memuat lineage/i,
    )
  })
})
