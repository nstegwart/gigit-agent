/**
 * W-UI-2 — Feature directory + Fitur 360 unit tests.
 * Pure projection + component render (jsdom). No MySQL.
 * Meditation fixture: FEAT-MEDITATION appears as independent product feature.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'

import {
  projectFeatureDirectory,
  projectFeature360Ui,
  loadFeatureDirectory,
  loadFeature360Ui,
  loadFeatureDocMd,
  type FeatureDirectoryAvailable,
  type Feature360Available,
} from '#/server/control-center-rebuild-fns'
import {
  createMemoryRebuildParityDataAccess,
  setRebuildParityDataAccessForTests,
  REBUILD_DATA_TABLES_NOT_MIGRATED,
  type Feature360Payload,
} from '#/server/rebuild-parity-mcp'
import {
  STABLE_DOMAINS,
  type ProductFeatureRow,
  type FeatureTaskMapRow,
} from '#/server/product-features-store'
import type {
  FeatureDirectoryRow,
  RebuildLineageRecord,
} from '#/server/rebuild-lineage-store'
import {
  FeatureDirectoryScreen,
  Feature360Screen,
} from '#/components/control-center/fitur'
import {
  featureDirectoryQueryKey,
  feature360QueryKey,
  featureDocMdQueryKey,
  featureDirectoryQueryOptions,
  feature360QueryOptions,
} from '#/lib/control-center-query'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function feat(
  id: string,
  nama: string,
  domain: string,
  fcRefs: string[] = [],
  ringkasan: string | null = null,
): ProductFeatureRow {
  return {
    featureId: id,
    namaId: nama,
    domainBisnis: domain,
    ringkasanId: ringkasan,
    platformJson: null,
    capabilitiesJson: null,
    fcRefsJson: fcRefs,
    curated: true,
  }
}

function map(
  featureId: string,
  taskId: string,
  joinSource: FeatureTaskMapRow['joinSource'] = 'curated',
  confidence = 1,
): FeatureTaskMapRow {
  return { featureId, taskId, joinSource, confidence }
}

function lineage(
  taskId: string,
  verdict: string | null,
  over: Partial<RebuildLineageRecord> = {},
): RebuildLineageRecord {
  return {
    boardId: 'mfs-rebuild',
    taskId,
    disposition: 'PRODUCT',
    repository: 'legacy/rn-mfs81',
    origin: 'existing',
    featureContractId: 'FC-WELLNESS-MEDITATION',
    parityVerdict: verdict,
    acceptanceCovered: null,
    verifierModel: 'gpt-verify',
    verifiedAt: '2026-07-17T06:00:00.000Z',
    stage1Json: { origin: 'existing' },
    evidenceJson: [{ file: 'src/meditation/player.ts', line: 10, side: 'rebuild' }],
    gapsJson: verdict === 'PARTIAL' ? ['player seek incomplete'] : null,
    implementationJson: null,
    sourceHash: 'h1',
    syncedAt: '2026-07-17',
    ...over,
  }
}

function meditationFixtures() {
  const features = [
    feat(
      'FEAT-MEDITATION',
      'Meditasi',
      'Kesehatan & Wellness',
      ['FC-WELLNESS-MEDITATION'],
      'Katalog sesi meditasi dan player',
    ),
    feat('FEAT-FASTING', 'Puasa Intermiten', 'Kesehatan & Wellness', ['FC-WELLNESS-FASTING']),
    feat('FEAT-AUTH', 'Autentikasi', 'Akun & Profil', ['FC-AUTH']),
  ]
  const maps = [
    map('FEAT-MEDITATION', 'T-BE-DEP-MOD-MEDITATION-01', 'prefix', 0.6),
    map('FEAT-MEDITATION', 'T-RN-MED-PLAYER-02', 'keyword', 0.8),
    map('FEAT-FASTING', 'T-BE-FAST-01', 'fc', 0.9),
    map('FEAT-AUTH', 'T-BE-AUTH-01', 'curated', 1),
  ]
  const lineageRows = [
    lineage('T-BE-DEP-MOD-MEDITATION-01', 'MAPPED_100'),
    lineage('T-RN-MED-PLAYER-02', 'PARTIAL', {
      origin: 'firm-new-blindspot',
      evidenceJson: [
        { file: 'screens/MeditationPlayer.tsx', line: 42 },
        { file: 'legacy/MeditationPlayer.js', line: 88, side: 'legacy' },
      ],
    }),
    lineage('T-BE-FAST-01', 'MAPPED_100', {
      featureContractId: 'FC-WELLNESS-FASTING',
    }),
    lineage('T-BE-AUTH-01', 'MISSING', { featureContractId: 'FC-AUTH' }),
  ]
  const directory: Array<FeatureDirectoryRow> = [
    {
      featureContractId: 'FC-WELLNESS-MEDITATION',
      judulId: 'Meditasi (FC)',
      domainBisnis: 'Kesehatan & Wellness',
      ringkasanId: 'FC technical contract',
      docMd: '# Meditasi\n\nPlayer dan katalog sesi.',
      deliveryStatus: 'draft',
      linksJson: null,
      sourceHash: 'd1',
      syncedAt: '2026-07-17',
    },
  ]
  return { features, maps, lineageRows, directory }
}

function feature360Payload(): Feature360Payload {
  return {
    available: true,
    feature_id: 'FEAT-MEDITATION',
    nama_id: 'Meditasi',
    domain_bisnis: 'Kesehatan & Wellness',
    ringkasan_id: 'Katalog sesi meditasi dan player',
    bars: {
      pemetaan: {
        key: 'pemetaan',
        labelId: 'Pemetaan ke fitur',
        numerator: 2,
        denominator: 2,
        pct: 100,
      },
      terbukti_pindah: {
        key: 'terbukti_pindah',
        labelId: 'Terbukti pindah (MAPPED_100)',
        numerator: 1,
        denominator: 2,
        pct: 50,
      },
      siap_produksi: {
        key: 'siap_produksi',
        labelId: 'Siap produksi',
        numerator: 0,
        denominator: 2,
        pct: 0,
        placeholder: true,
        flag: 'PLACEHOLDER_SIAP_PRODUKSI_ZERO',
      },
    },
    tasks: [
      {
        task_id: 'T-BE-DEP-MOD-MEDITATION-01',
        join_source: 'prefix',
        confidence: 0.6,
        parity_verdict: 'MAPPED_100',
        origin: 'existing',
        feature_contract_id: 'FC-WELLNESS-MEDITATION',
      },
      {
        task_id: 'T-RN-MED-PLAYER-02',
        join_source: 'keyword',
        confidence: 0.8,
        parity_verdict: 'PARTIAL',
        origin: 'firm-new-blindspot',
        feature_contract_id: 'FC-WELLNESS-MEDITATION',
      },
    ],
    units_by_platform: {
      rn: [
        {
          unit_id: 'U-RN-MED-1',
          unit_type: 'screen',
          identifier: 'MeditationList',
          anchor: 'screens/MeditationList.tsx',
          coverage_status: 'covered',
          repo: 'legacy/rn-mfs81',
          feature_contract_id: 'FC-WELLNESS-MEDITATION',
        },
      ],
      backend: [],
    },
    docs_refs: [
      {
        feature_contract_id: 'FC-WELLNESS-MEDITATION',
        judul_id: 'Meditasi (FC)',
        delivery_status: 'draft',
        has_doc_md: true,
      },
    ],
    rollup: {
      taskCount: 2,
      lineageCount: 2,
      parityMapped100: 1,
      parityTotal: 2,
    },
  }
}

afterEach(() => {
  setRebuildParityDataAccessForTests(null)
})

// ---------------------------------------------------------------------------
// Projection
// ---------------------------------------------------------------------------

describe('feature directory projection', () => {
  it('groups by 8 stable domains and surfaces FEAT-MEDITATION as independent product feature', () => {
    const { features, maps, lineageRows } = meditationFixtures()
    const data = projectFeatureDirectory({
      boardId: 'mfs-rebuild',
      available: true,
      features,
      maps,
      lineage: lineageRows,
      unitCountByFeatureId: { 'FEAT-MEDITATION': 3, 'FEAT-FASTING': 1, 'FEAT-AUTH': 0 },
      docsOkByFeatureId: { 'FEAT-MEDITATION': true, 'FEAT-FASTING': false, 'FEAT-AUTH': false },
    })
    expect(data.available).toBe(true)
    if (!data.available) return
    expect(data.domains).toHaveLength(STABLE_DOMAINS.length)
    expect(data.domains.map((d) => d.domainBisnis)).toEqual([...STABLE_DOMAINS])

    const wellness = data.domains.find((d) => d.domainBisnis === 'Kesehatan & Wellness')
    expect(wellness?.features.map((f) => f.featureId)).toContain('FEAT-MEDITATION')
    const med = wellness?.features.find((f) => f.featureId === 'FEAT-MEDITATION')
    expect(med?.namaId).toBe('Meditasi')
    expect(med?.taskCount).toBe(2)
    expect(med?.unitCount).toBe(3)
    expect(med?.docsOk).toBe(true)
    expect(med?.mapped100).toBe(1)
    expect(med?.detailHref).toBe('/b/mfs-rebuild/fitur/FEAT-MEDITATION')
    // No technical id on card surface fields (nama is human)
    expect(med?.namaId).not.toMatch(/^FEAT-/)
    expect(med?.namaId).not.toMatch(/^FC-/)
  })

  it('graceful unavailable when tables missing', () => {
    const data = projectFeatureDirectory({
      boardId: 'mfs-rebuild',
      available: false,
      reason: REBUILD_DATA_TABLES_NOT_MIGRATED,
    })
    expect(data.available).toBe(false)
    if (data.available) return
    expect(data.emptyStateLabelId).toMatch(/migrasi/i)
    expect(data.technicalFcHref).toBe('/b/mfs-rebuild/features')
  })

  it('loadFeatureDirectory returns meditation when taxonomy injected (store path hermetic)', async () => {
    const { features, maps, lineageRows } = meditationFixtures()
    // listProductFeatures hits MySQL; inject rows for hermetic unit path (same as W-UI-1).
    const data = await loadFeatureDirectory('mfs-rebuild', {
      features,
      maps,
      lineage: lineageRows,
      unitCountByFeatureId: { 'FEAT-MEDITATION': 1, 'FEAT-FASTING': 0, 'FEAT-AUTH': 0 },
      docsOkByFeatureId: { 'FEAT-MEDITATION': true, 'FEAT-FASTING': false, 'FEAT-AUTH': false },
    })
    expect(data.available).toBe(true)
    if (!data.available) return
    const allIds = data.domains.flatMap((d) => d.features.map((f) => f.featureId))
    expect(allIds).toContain('FEAT-MEDITATION')
    const med = data.domains
      .flatMap((d) => d.features)
      .find((f) => f.featureId === 'FEAT-MEDITATION')
    expect(med?.docsOk).toBe(true)
    expect(med?.namaId).toBe('Meditasi')
  })

  it('loadFeatureDirectory graceful when rebuild tables absent', async () => {
    setRebuildParityDataAccessForTests(
      createMemoryRebuildParityDataAccess({ tablesPresent: false }),
    )
    const data = await loadFeatureDirectory('mfs-rebuild')
    expect(data.available).toBe(false)
    if (data.available) return
    expect(data.reason).toBe(REBUILD_DATA_TABLES_NOT_MIGRATED)
  })
})

describe('feature 360 projection', () => {
  it('projects 3 bars with siap_produksi placeholder note "belum dihitung"', () => {
    const { lineageRows, directory } = meditationFixtures()
    const ui = projectFeature360Ui({
      boardId: 'mfs-rebuild',
      featureId: 'FEAT-MEDITATION',
      payload: feature360Payload(),
      lineage: lineageRows,
      directory,
    })
    expect(ui.available).toBe(true)
    if (!ui.available) return
    expect(ui.namaId).toBe('Meditasi')
    expect(ui.bars.pemetaan.labelId).toBe('Pemetaan')
    expect(ui.bars.terbukti_pindah.labelId).toBe('Terbukti pindah')
    expect(ui.bars.siap_produksi.labelId).toBe('Siap produksi')
    expect(ui.bars.siap_produksi.numerator).toBe(0)
    expect(ui.bars.siap_produksi.placeholder).toBe(true)
    expect(ui.bars.siap_produksi.noteId).toBe('belum dihitung')
    expect(ui.tasks).toHaveLength(2)
    expect(ui.tasks[0]?.verdictTone).toBe('ok')
    expect(ui.tasks[1]?.verdictTone).toBe('warn')
    expect(ui.docs[0]?.docMd).toMatch(/Player dan katalog/)
    expect(ui.lineage[0]?.evidence[0]?.file).toBe('src/meditation/player.ts')
    expect(ui.lineage[1]?.gapClass).toBe('player seek incomplete')
  })

  it('graceful FEATURE_NOT_FOUND and tables missing', () => {
    const missing = projectFeature360Ui({
      boardId: 'mfs-rebuild',
      featureId: 'FEAT-X',
      payload: {
        available: false,
        reason: 'FEATURE_NOT_FOUND',
        tool: 'get_feature_360',
        error: 'No product feature FEAT-X',
      },
    })
    expect(missing.available).toBe(false)
    if (missing.available) return
    expect(missing.emptyStateLabelId).toMatch(/tidak ditemukan/i)

    const unmigrated = projectFeature360Ui({
      boardId: 'mfs-rebuild',
      featureId: 'FEAT-X',
      payload: {
        available: false,
        reason: REBUILD_DATA_TABLES_NOT_MIGRATED,
        tool: 'get_feature_360',
      },
    })
    expect(unmigrated.available).toBe(false)
    if (unmigrated.available) return
    expect(unmigrated.emptyStateLabelId).toMatch(/migrasi/i)
  })

  it('loadFeature360Ui + loadFeatureDocMd via memory access', async () => {
    const { features, maps, lineageRows, directory } = meditationFixtures()
    setRebuildParityDataAccessForTests(
      createMemoryRebuildParityDataAccess({
        tablesPresent: true,
        features,
        maps,
        lineage: lineageRows,
        directory,
        units: [
          {
            unitId: 'U-RN-MED-1',
            featureContractId: 'FC-WELLNESS-MEDITATION',
            unitType: 'screen',
            identifier: 'MeditationList',
            anchor: 'screens/MeditationList.tsx',
            notes: null,
            coverageStatus: 'covered',
            repo: 'legacy/rn-mfs81',
            sourceHash: 'u',
            syncedAt: 't',
          },
        ],
      }),
    )
    const ui = await loadFeature360Ui('mfs-rebuild', 'FEAT-MEDITATION')
    expect(ui.available).toBe(true)
    if (!ui.available) return
    expect(ui.featureId).toBe('FEAT-MEDITATION')
    expect(ui.unitsByPlatform.rn?.length).toBeGreaterThan(0)

    const doc = await loadFeatureDocMd('mfs-rebuild', 'FC-WELLNESS-MEDITATION')
    expect(doc.available).toBe(true)
    if (!doc.available) return
    expect(doc.hasDocMd).toBe(true)
    expect(doc.docMd).toMatch(/Meditasi/)
  })
})

// ---------------------------------------------------------------------------
// Query keys
// ---------------------------------------------------------------------------

describe('fitur query keys', () => {
  it('directory + 360 + doc keys are board-scoped', () => {
    expect(featureDirectoryQueryKey('mfs-rebuild')).toEqual([
      'control-center',
      'feature-directory',
      'mfs-rebuild',
    ])
    expect(feature360QueryKey('mfs-rebuild', 'FEAT-MEDITATION')).toEqual([
      'control-center',
      'feature-360',
      'mfs-rebuild',
      'FEAT-MEDITATION',
    ])
    expect(featureDocMdQueryKey('mfs-rebuild', 'FC-X')).toEqual([
      'control-center',
      'feature-doc-md',
      'mfs-rebuild',
      'FC-X',
    ])
    const opts = featureDirectoryQueryOptions('mfs-rebuild', async () => ({
      available: false,
      reason: 'x',
      boardId: 'mfs-rebuild',
      emptyStateLabelId: 'y',
      technicalFcHref: '/b/mfs-rebuild/features',
    }))
    expect(opts.queryKey[1]).toBe('feature-directory')
    const o360 = feature360QueryOptions(
      'mfs-rebuild',
      'FEAT-MEDITATION',
      async () => ({
        available: false,
        reason: 'x',
        boardId: 'mfs-rebuild',
        featureId: 'FEAT-MEDITATION',
        emptyStateLabelId: 'y',
        technicalFcHref: '/b/mfs-rebuild/features',
        directoryHref: '/b/mfs-rebuild/fitur',
      }),
    )
    expect(o360.queryKey[1]).toBe('feature-360')
  })
})

// ---------------------------------------------------------------------------
// Components
// ---------------------------------------------------------------------------

describe('FeatureDirectoryScreen', () => {
  it('renders domain cards including Meditasi without technical id on surface', () => {
    const { features, maps, lineageRows } = meditationFixtures()
    const data = projectFeatureDirectory({
      boardId: 'mfs-rebuild',
      available: true,
      features,
      maps,
      lineage: lineageRows,
      unitCountByFeatureId: { 'FEAT-MEDITATION': 3 },
      docsOkByFeatureId: { 'FEAT-MEDITATION': true },
    }) as FeatureDirectoryAvailable

    render(
      <FeatureDirectoryScreen
        boardId="mfs-rebuild"
        data={data}
        surfaceState="populated"
      />,
    )

    expect(screen.getByTestId('fitur-directory').getAttribute('data-surface')).toBe(
      'populated',
    )
    expect(screen.getByText('Meditasi')).toBeTruthy()
    expect(screen.getByTestId('fitur-technical-fc-link').getAttribute('href')).toBe(
      '/b/mfs-rebuild/features',
    )
    // Card surface text should not show FEAT-/FC- ids as primary copy
    const cards = screen.getAllByTestId('fitur-card')
    const medCard = cards.find((c) => c.getAttribute('data-feature-id') === 'FEAT-MEDITATION')
    expect(medCard).toBeTruthy()
    expect(medCard!.textContent).toMatch(/Meditasi/)
    expect(medCard!.textContent).toMatch(/docs ✓/)
    // Visible text excludes raw FEAT- id (attribute is ok for tests)
    expect(medCard!.textContent).not.toContain('FEAT-MEDITATION')
    expect(medCard!.textContent).not.toContain('FC-WELLNESS')
  })

  it('client-side search filters fitur cards', () => {
    const { features, maps, lineageRows } = meditationFixtures()
    const data = projectFeatureDirectory({
      boardId: 'mfs-rebuild',
      available: true,
      features,
      maps,
      lineage: lineageRows,
    }) as FeatureDirectoryAvailable

    render(
      <FeatureDirectoryScreen
        boardId="mfs-rebuild"
        data={data}
        surfaceState="populated"
      />,
    )

    fireEvent.change(screen.getByTestId('fitur-directory-search'), {
      target: { value: 'meditasi' },
    })
    expect(screen.getByText('Meditasi')).toBeTruthy()
    expect(screen.queryByText('Autentikasi')).toBeNull()
  })

  it('graceful empty-state when available:false', () => {
    render(
      <FeatureDirectoryScreen
        boardId="mfs-rebuild"
        data={{
          available: false,
          reason: REBUILD_DATA_TABLES_NOT_MIGRATED,
          boardId: 'mfs-rebuild',
          emptyStateLabelId:
            'Data rebuild belum diaktifkan — menunggu migrasi database (009/010)',
          technicalFcHref: '/b/mfs-rebuild/features',
        }}
        surfaceState="empty"
      />,
    )
    const empty = screen.getByTestId('fitur-directory-empty-state')
    expect(empty).toBeTruthy()
    expect(empty.textContent).toMatch(/menunggu migrasi/i)
  })
})

describe('Feature360Screen', () => {
  function populatedUi(): Feature360Available {
    const { lineageRows, directory } = meditationFixtures()
    return projectFeature360Ui({
      boardId: 'mfs-rebuild',
      featureId: 'FEAT-MEDITATION',
      payload: feature360Payload(),
      lineage: lineageRows,
      directory,
    }) as Feature360Available
  }

  it('renders 3 bars + 4 tabs (Isi/Progres/Dokumen/Lineage)', () => {
    const data = populatedUi()
    render(
      <Feature360Screen
        boardId="mfs-rebuild"
        featureId="FEAT-MEDITATION"
        data={data}
        surfaceState="populated"
      />,
    )

    expect(screen.getByTestId('fitur360-nama').textContent).toBe('Meditasi')
    expect(screen.getByTestId('fitur360-ringkasan').textContent).toMatch(/katalog sesi/i)
    expect(screen.getByTestId('fitur360-bar-pemetaan')).toBeTruthy()
    expect(screen.getByTestId('fitur360-bar-terbukti_pindah')).toBeTruthy()
    expect(screen.getByTestId('fitur360-bar-siap_produksi')).toBeTruthy()
    expect(screen.getByTestId('fitur360-bar-placeholder-note').textContent).toMatch(
      /belum dihitung/,
    )

    expect(screen.getByTestId('fitur360-tab-btn-isi').textContent).toBe('Isi')
    expect(screen.getByTestId('fitur360-tab-btn-progres').textContent).toBe('Progres')
    expect(screen.getByTestId('fitur360-tab-btn-dokumen').textContent).toBe('Dokumen')
    expect(screen.getByTestId('fitur360-tab-btn-lineage').textContent).toBe('Lineage')

    // Default tab Isi — unit table
    expect(screen.getByTestId('fitur360-tab-isi')).toBeTruthy()
    expect(screen.getByText('MeditationList')).toBeTruthy()

    fireEvent.click(screen.getByTestId('fitur360-tab-btn-progres'))
    expect(screen.getByTestId('fitur360-tab-progres')).toBeTruthy()
    const chips = screen.getAllByTestId('fitur360-verdict-chip')
    expect(chips.some((c) => c.getAttribute('data-tone') === 'ok')).toBe(true)
    expect(chips.some((c) => c.getAttribute('data-tone') === 'warn')).toBe(true)

    fireEvent.click(screen.getByTestId('fitur360-tab-btn-dokumen'))
    expect(screen.getByTestId('fitur360-doc-md').textContent).toMatch(/Player dan katalog/)

    fireEvent.click(screen.getByTestId('fitur360-tab-btn-lineage'))
    expect(screen.getAllByTestId('fitur360-lineage-item').length).toBeGreaterThan(0)
  })

  it('graceful empty-state when available:false', () => {
    render(
      <Feature360Screen
        boardId="mfs-rebuild"
        featureId="FEAT-X"
        data={{
          available: false,
          reason: REBUILD_DATA_TABLES_NOT_MIGRATED,
          boardId: 'mfs-rebuild',
          featureId: 'FEAT-X',
          emptyStateLabelId:
            'Data rebuild belum diaktifkan — menunggu migrasi database (009/010)',
          technicalFcHref: '/b/mfs-rebuild/features',
          directoryHref: '/b/mfs-rebuild/fitur',
        }}
        surfaceState="empty"
      />,
    )
    expect(screen.getByTestId('fitur360-empty-state')).toBeTruthy()
  })
})
