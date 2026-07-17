/**
 * W-UI-1 — Rebuild dashboard unit tests.
 * Pure server projection + component render (jsdom). No MySQL.
 */
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

import {
  aggregateRebuildDomains,
  buildRebuildChips,
  projectRebuildDashboard,
  loadRebuildDashboard,
  type RebuildDashboardAvailable,
  type RebuildDashboardData,
} from '#/server/control-center-rebuild-fns'
import {
  createMemoryRebuildParityDataAccess,
  setRebuildParityDataAccessForTests,
  REBUILD_DATA_TABLES_NOT_MIGRATED,
  type RebuildParityPayload,
} from '#/server/rebuild-parity-mcp'
import { STABLE_DOMAINS, type ProductFeatureRow, type FeatureTaskMapRow } from '#/server/product-features-store'
import type { RebuildLineageRecord } from '#/server/rebuild-lineage-store'
import {
  RebuildDashboardScreen,
  RebuildSparkline,
} from '#/components/control-center/rebuild'
import {
  rebuildQueryKey,
  rebuildQueryOptions,
} from '#/lib/control-center-query'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function parityAvailable(over: Partial<RebuildParityPayload> = {}): RebuildParityPayload {
  return {
    available: true,
    boardId: 'mfs-rebuild',
    latest: {
      capturedAt: '2026-07-17 06:00:00.000',
      mapped100: 1731,
      partialN: 200,
      missingN: 300,
      pendingN: 200,
      l0N: 70,
      measuredN: 2301,
      totalN: 2501,
      mappedPct: 69.2,
      sourceFile: 'reports/latest.txt',
      sourceHash: 'abc',
    },
    history: [
      {
        capturedAt: '2026-07-16 06:00:00.000',
        mapped100: 1600,
        partialN: 250,
        missingN: 350,
        pendingN: 250,
        measuredN: 2200,
        totalN: 2501,
      },
      {
        capturedAt: '2026-07-17 06:00:00.000',
        mapped100: 1731,
        partialN: 200,
        missingN: 300,
        pendingN: 200,
        measuredN: 2301,
        totalN: 2501,
      },
    ],
    verdictBreakdown: [
      { verdict: 'MAPPED_100', count: 1731 },
      { verdict: 'PARTIAL', count: 200 },
    ],
    freshness: {
      capturedAt: '2026-07-17 06:00:00.000',
      ageSeconds: 360,
      labelId: 'diukur ulang 6 menit lalu',
    },
    disclaimerId: 'terbukti secara bukti kode (MAPPED_100), bukan berarti production-ready',
    ...over,
  }
}

function feat(
  id: string,
  nama: string,
  domain: string,
  fcRefs: string[] = [],
): ProductFeatureRow {
  return {
    featureId: id,
    namaId: nama,
    domainBisnis: domain,
    ringkasanId: null,
    platformJson: null,
    capabilitiesJson: null,
    fcRefsJson: fcRefs,
    curated: true,
  }
}

function map(featureId: string, taskId: string): FeatureTaskMapRow {
  return { featureId, taskId, joinSource: 'curated', confidence: 1 }
}

function lineage(
  taskId: string,
  verdict: string | null,
  boardId = 'mfs-rebuild',
): RebuildLineageRecord {
  return {
    boardId,
    taskId,
    disposition: null,
    repository: null,
    origin: null,
    featureContractId: null,
    parityVerdict: verdict,
    acceptanceCovered: null,
    verifierModel: null,
    verifiedAt: null,
    stage1Json: null,
    evidenceJson: null,
    gapsJson: null,
    implementationJson: null,
    sourceHash: 'h',
    syncedAt: '2026-07-17',
  }
}

// ---------------------------------------------------------------------------
// Pure projection
// ---------------------------------------------------------------------------

describe('rebuild dashboard projection', () => {
  it('buildRebuildChips uses semantic tones and id-ID labels', () => {
    const chips = buildRebuildChips({
      mapped100: 1731,
      partialN: 200,
      missingN: 300,
      pendingN: 200,
      l0N: 70,
    })
    expect(chips).toEqual([
      { key: 'terbukti', labelId: 'Terbukti', count: 1731, tone: 'ok' },
      { key: 'sebagian', labelId: 'Sebagian', count: 200, tone: 'warn' },
      { key: 'belum_ada', labelId: 'Belum ada', count: 300, tone: 'blocked' },
      { key: 'belum_diukur', labelId: 'Belum diukur', count: 270, tone: 'muted' },
    ])
  })

  it('projectRebuildDashboard graceful unavailable', () => {
    const data = projectRebuildDashboard({
      boardId: 'mfs-rebuild',
      parity: {
        available: false,
        reason: REBUILD_DATA_TABLES_NOT_MIGRATED,
        tool: 'get_rebuild_parity',
      },
    })
    expect(data.available).toBe(false)
    if (!data.available) {
      expect(data.emptyStateLabelId).toMatch(/belum diaktifkan/)
      expect(data.reason).toBe(REBUILD_DATA_TABLES_NOT_MIGRATED)
    }
  })

  it('projectRebuildDashboard KPI 1731/2501 + 8 domains + disclaimer', () => {
    const features = [
      feat('FEAT-MEDITATION', 'Meditasi', 'Kesehatan & Wellness', ['FC-MED']),
      feat('FEAT-WORKOUT', 'Latihan', 'Latihan & Program', ['FC-WO']),
    ]
    const maps = [
      map('FEAT-MEDITATION', 'T-1'),
      map('FEAT-MEDITATION', 'T-2'),
      map('FEAT-WORKOUT', 'T-3'),
    ]
    const lin = [
      lineage('T-1', 'MAPPED_100'),
      lineage('T-2', 'PARTIAL'),
      lineage('T-3', 'MAPPED_100'),
    ]
    const data = projectRebuildDashboard({
      boardId: 'mfs-rebuild',
      parity: parityAvailable(),
      features,
      maps,
      lineage: lin,
      unitCountByFeatureId: { 'FEAT-MEDITATION': 4, 'FEAT-WORKOUT': 2 },
    })
    expect(data.available).toBe(true)
    if (!data.available) return
    expect(data.kpi.display).toBe('1731/2501')
    expect(data.kpi.mappedPct).toBe(69.2)
    expect(data.kpi.labelId).toBe('Terbukti pindah dari legacy')
    expect(data.disclaimerId).toMatch(/bukan berarti siap produksi/)
    expect(data.freshness.labelId).toBe('diukur ulang 6 menit lalu')
    expect(data.domains).toHaveLength(STABLE_DOMAINS.length)
    expect(data.domains.map((d) => d.domainBisnis)).toEqual([...STABLE_DOMAINS])
    const wellness = data.domains.find((d) => d.domainBisnis === 'Kesehatan & Wellness')
    expect(wellness?.featureCount).toBe(1)
    expect(wellness?.taskCount).toBe(2)
    expect(wellness?.topFeatures[0]?.namaId).toBe('Meditasi')
    expect(wellness?.topFeatures[0]?.detailHref).toBe(
      '/b/mfs-rebuild/fitur/FEAT-MEDITATION',
    )
    expect(wellness?.topFeatures[0]?.unitCount).toBe(4)
    // History sorted ascending for sparkline
    expect(data.history[0]?.mapped100).toBe(1600)
    expect(data.history[1]?.mapped100).toBe(1731)
  })

  it('aggregateRebuildDomains counts mapped100 from lineage', () => {
    const rows = aggregateRebuildDomains({
      boardId: 'mfs-rebuild',
      features: [feat('FEAT-X', 'X', 'Platform & Infrastruktur')],
      maps: [map('FEAT-X', 'A'), map('FEAT-X', 'B')],
      lineage: [lineage('A', 'MAPPED_100'), lineage('B', 'MISSING')],
      topN: 3,
    })
    const plat = rows.find((r) => r.domainBisnis === 'Platform & Infrastruktur')
    expect(plat?.mapped100).toBe(1)
    expect(plat?.taskCount).toBe(2)
  })
})

describe('loadRebuildDashboard graceful memory', () => {
  it('returns empty-state when tables absent (no throw)', async () => {
    const mem = createMemoryRebuildParityDataAccess({ tablesPresent: false })
    setRebuildParityDataAccessForTests(mem)
    try {
      const data = await loadRebuildDashboard('mfs-rebuild', { skipTaxonomy: true })
      expect(data.available).toBe(false)
      if (!data.available) {
        expect(data.emptyStateLabelId).toContain('009/010')
      }
    } finally {
      setRebuildParityDataAccessForTests(null)
    }
  })

  it('returns available KPI when memory tables present', async () => {
    const mem = createMemoryRebuildParityDataAccess({
      tablesPresent: true,
      rollups: [
        {
          id: 1,
          capturedAt: '2026-07-17 06:00:00.000',
          mapped100: 1731,
          partialN: 200,
          missingN: 300,
          pendingN: 200,
          l0N: 70,
          measuredN: 2301,
          totalN: 2501,
          sourceFile: null,
          rawText: null,
          sourceHash: null,
        },
      ],
    })
    setRebuildParityDataAccessForTests(mem)
    try {
      const data = await loadRebuildDashboard('mfs-rebuild', {
        skipTaxonomy: true,
        features: [],
        maps: [],
        lineage: [],
      })
      expect(data.available).toBe(true)
      if (data.available) {
        expect(data.kpi.display).toBe('1731/2501')
      }
    } finally {
      setRebuildParityDataAccessForTests(null)
    }
  })
})

// ---------------------------------------------------------------------------
// Query keys
// ---------------------------------------------------------------------------

describe('rebuild query options', () => {
  it('rebuildQueryKey / rebuildQueryOptions', () => {
    expect(rebuildQueryKey('mfs-rebuild')).toEqual([
      'control-center',
      'rebuild',
      'mfs-rebuild',
    ])
    const fetch = async () =>
      ({
        available: false,
        reason: REBUILD_DATA_TABLES_NOT_MIGRATED,
        boardId: 'mfs-rebuild',
        emptyStateLabelId: 'x',
      }) satisfies RebuildDashboardData
    const opts = rebuildQueryOptions('mfs-rebuild', fetch)
    expect(opts.queryKey).toEqual(['control-center', 'rebuild', 'mfs-rebuild'])
  })
})

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

describe('RebuildDashboardScreen', () => {
  it('renders graceful empty-state id-ID without error chrome', () => {
    render(
      <RebuildDashboardScreen
        boardId="mfs-rebuild"
        surfaceState="empty"
        data={{
          available: false,
          reason: REBUILD_DATA_TABLES_NOT_MIGRATED,
          boardId: 'mfs-rebuild',
          emptyStateLabelId:
            'Data rebuild belum diaktifkan — menunggu migrasi database (009/010)',
        }}
      />,
    )
    const empty = screen.getByTestId('rebuild-empty-state')
    expect(empty).toBeTruthy()
    expect(empty.textContent).toMatch(
      /Data rebuild belum diaktifkan — menunggu migrasi database \(009\/010\)/,
    )
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('renders KPI hero, chips, sparkline, domain table, feature cards', () => {
    const data = projectRebuildDashboard({
      boardId: 'mfs-rebuild',
      parity: parityAvailable(),
      features: [
        feat('FEAT-MEDITATION', 'Meditasi', 'Kesehatan & Wellness'),
      ],
      maps: [map('FEAT-MEDITATION', 'T-1')],
      lineage: [lineage('T-1', 'MAPPED_100')],
      unitCountByFeatureId: { 'FEAT-MEDITATION': 3 },
    }) as RebuildDashboardAvailable

    render(
      <RebuildDashboardScreen
        boardId="mfs-rebuild"
        surfaceState="populated"
        data={data}
        onTraceBlindspot={async () => ({ available: true, term: 'med', matchCount: 0 })}
      />,
    )

    expect(screen.getByTestId('rebuild-kpi-display').textContent).toBe('1731/2501')
    expect(screen.getByText('Terbukti pindah dari legacy')).toBeTruthy()
    expect(screen.getByTestId('rebuild-disclaimer').textContent).toMatch(
      /bukan berarti siap produksi/,
    )
    expect(screen.getByTestId('rebuild-freshness').textContent).toMatch(/diukur ulang/)
    expect(screen.getByTestId('rebuild-chip-row')).toBeTruthy()
    expect(screen.getByTestId('rebuild-sparkline')).toBeTruthy()
    expect(screen.getByTestId('rebuild-domain-table')).toBeTruthy()
    // 8 domain rows
    expect(screen.getAllByTestId('rebuild-domain-block')).toHaveLength(8)
    // Feature card in expanded first domain with features
    expect(screen.getByText('Meditasi')).toBeTruthy()
    const link = screen.getByTestId('rebuild-feature-card')
    expect(link.getAttribute('href')).toBe('/b/mfs-rebuild/fitur/FEAT-MEDITATION')
  })

  it('blindspot tracer renders JSON panel from injectable fetcher', async () => {
    const data = projectRebuildDashboard({
      boardId: 'mfs-rebuild',
      parity: parityAvailable(),
      features: [],
      maps: [],
      lineage: [],
    }) as RebuildDashboardAvailable

    const onTrace = vi.fn(async (term: string) => ({
      available: true,
      term,
      boardId: 'mfs-rebuild',
      matchCount: 1,
      primary_classification: 'STAGE2_PARTIAL',
      matches: [],
      related_feature_ids: ['FEAT-MEDITATION'],
      note_id: 'placeholder',
    }))

    render(
      <RebuildDashboardScreen
        boardId="mfs-rebuild"
        surfaceState="populated"
        data={data}
        onTraceBlindspot={onTrace}
      />,
    )

    const input = screen.getByTestId('rebuild-blindspot-input')
    fireEvent.change(input, { target: { value: 'meditation' } })
    fireEvent.click(screen.getByTestId('rebuild-blindspot-submit'))

    await waitFor(() => {
      expect(onTrace).toHaveBeenCalledWith('meditation')
      expect(screen.getByTestId('rebuild-blindspot-result').textContent).toMatch(
        /STAGE2_PARTIAL/,
      )
    })
  })

  it('RebuildSparkline empty history', () => {
    render(<RebuildSparkline history={[]} />)
    expect(screen.getByTestId('rebuild-sparkline-empty')).toBeTruthy()
  })
})

describe('AppShell Rebuild nav contract (smoke import)', () => {
  it('CONTROL_CENTER_NAV_LABELS_ID includes Rebuild after Ringkasan mapping', async () => {
    const { CONTROL_CENTER_NAV_LABELS_ID } = await import('#/components/AppShell')
    expect(CONTROL_CENTER_NAV_LABELS_ID.Overview).toBe('Ringkasan')
    expect(CONTROL_CENTER_NAV_LABELS_ID.Rebuild).toBe('Rebuild')
  })
})
