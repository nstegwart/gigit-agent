/**
 * W-UI-5 — Grouped global search (Fitur / Tugas / Dokumen / Unit).
 * Pure projector + component render. LOCAL ONLY; no MySQL.
 * Meditation case: query "meditation" → Meditasi feature first, related tasks grouped.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen, within } from '@testing-library/react'

import {
  groupFlatSearchResults,
  formatFeatureBreadcrumb,
  mapPinKindToSection,
  mergeGroupedSections,
  SEARCH_SECTION_LABEL_ID,
  totalGroupedCount,
} from '#/components/control-center/search/groupSearchResults'
import { SearchScreen } from '#/components/control-center/search/SearchScreen'
import {
  projectGroupedSearch,
  searchTextMatches,
  type GroupedSearchAvailable,
} from '#/server/control-center-rebuild-fns'
import type {
  FeatureTaskMapRow,
  ProductFeatureRow,
  ProductFeatureSeedEntry,
} from '#/server/product-features-store'
import type {
  FeatureDirectoryRow,
  FeatureUnitRow,
} from '#/server/rebuild-lineage-store'
import {
  groupedSearchQueryKey,
  searchQueryKey,
} from '#/lib/control-center-query'

afterEach(() => {
  cleanup()
})

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
    ringkasanId: `Ringkasan ${nama}`,
    platformJson: { rn: true },
    capabilitiesJson: ['katalog'],
    fcRefsJson: fcRefs,
    curated: false,
  }
}

function map(
  featureId: string,
  taskId: string,
  joinSource: FeatureTaskMapRow['joinSource'] = 'keyword',
): FeatureTaskMapRow {
  return { featureId, taskId, joinSource, confidence: 0.4 }
}

const MEDITATION: ProductFeatureRow = feat(
  'FEAT-MEDITATION',
  'Meditasi',
  'Kesehatan & Wellness',
  ['FC-RN-WELLNESS-SUITE', 'FC-BE-WELL-CONTENT-API'],
)

const PUASA: ProductFeatureRow = feat(
  'FEAT-PUASA',
  'Puasa Intermiten',
  'Kesehatan & Wellness',
  ['FC-RN-WELLNESS-SUITE'],
)

const SEED_MED: ProductFeatureSeedEntry = {
  feature_id: 'FEAT-MEDITATION',
  nama_id: 'Meditasi',
  domain_bisnis: 'Kesehatan & Wellness',
  join: {
    keywords: ['meditat', 'meditasi', 'bubble-breath'],
    id_includes: ['MEDITATION', 'MEDITASI'],
  },
}

describe('groupFlatSearchResults (pin-flat)', () => {
  it('maps kinds to Fitur / Tugas / Dokumen / Unit and skips empty sections', () => {
    const sections = groupFlatSearchResults([
      {
        kind: 'task',
        id: 'T-1',
        title: 'Tugas meditasi',
        subtitle: 'Meditasi · Kesehatan & Wellness',
        href: '/work/T-1',
        technicalAlias: 'T-1',
      },
      {
        kind: 'feature',
        id: 'F-1',
        title: 'Meditasi',
        href: '/features/F-1',
        technicalAlias: 'F-1',
      },
      {
        kind: 'decision',
        id: 'D-1',
        title: 'Keputusan',
        href: '/decisions/D-1',
      },
      {
        kind: 'project',
        id: 'P-1',
        title: 'Proyek',
        href: '/projects/P-1',
      },
    ])
    expect(sections.map((s) => s.labelId)).toEqual([
      'Fitur',
      'Tugas',
      'Dokumen',
      'Unit',
    ])
    expect(sections[0]!.items[0]!.title).toBe('Meditasi')
    expect(sections[1]!.items[0]!.breadcrumb).toContain('Meditasi')
    expect(mapPinKindToSection('evidence')).toBe('dokumen')
    expect(formatFeatureBreadcrumb('Meditasi', 'Kesehatan & Wellness')).toBe(
      'Meditasi · Kesehatan & Wellness',
    )
  })

  it('dedupes by section+id and merges product-first', () => {
    const a = groupFlatSearchResults([
      { kind: 'feature', id: 'X', title: 'A', href: '/a' },
    ])
    const b = groupFlatSearchResults([
      { kind: 'feature', id: 'X', title: 'B', href: '/b' },
      { kind: 'task', id: 'T', title: 'T', href: '/t' },
    ])
    const merged = mergeGroupedSections(a, b)
    expect(merged.find((s) => s.key === 'fitur')!.items).toHaveLength(1)
    expect(merged.find((s) => s.key === 'fitur')!.items[0]!.title).toBe('A')
    expect(totalGroupedCount(merged)).toBe(2)
  })
})

describe('projectGroupedSearch — meditation case', () => {
  it('groups meditation query: Fitur Meditasi first, then related tasks with breadcrumb', () => {
    const maps = [
      map('FEAT-MEDITATION', 'T-RN-INT-WELLNESS'),
      map('FEAT-MEDITATION', 'T-BE-WELL-MEDITATION-CATALOG'),
      map('FEAT-PUASA', 'T-RN-FASTING-1'),
    ]
    const units: FeatureUnitRow[] = [
      {
        unitId: 'U-MED-PLAYER',
        featureContractId: 'FC-RN-WELLNESS-SUITE',
        unitType: 'screen',
        identifier: 'MeditationPlayer',
        anchor: 'rn:MeditationPlayer',
        notes: null,
        repo: 'rn-mfs81',
        coverageStatus: null,
        sourceHash: null,
        syncedAt: null,
      },
    ]
    const directory: FeatureDirectoryRow[] = [
      {
        featureContractId: 'FC-BE-WELL-CONTENT-API',
        judulId: 'API konten wellness meditasi',
        domainBisnis: 'Kesehatan & Wellness',
        ringkasanId: null,
        deliveryStatus: 'draft',
        docMd: '# Meditasi',
        linksJson: null,
        sourceHash: 'abc',
        syncedAt: null,
      },
    ]

    const result = projectGroupedSearch({
      boardId: 'mfs-rebuild',
      query: 'meditation',
      available: true,
      features: [MEDITATION, PUASA],
      maps,
      units,
      directory,
      seedEntries: [SEED_MED],
    })

    expect(result.available).toBe(true)
    const ok = result as GroupedSearchAvailable
    expect(ok.sections.map((s) => s.key)).toEqual(
      expect.arrayContaining(['fitur', 'tugas']),
    )
    expect(ok.sections[0]!.key).toBe('fitur')
    expect(ok.sections[0]!.labelId).toBe('Fitur')
    expect(ok.sections[0]!.items[0]!.title).toBe('Meditasi')
    expect(ok.sections[0]!.items[0]!.breadcrumb).toBe(
      'Meditasi · Kesehatan & Wellness',
    )
    expect(ok.sections[0]!.items[0]!.technicalAlias).toBe('FEAT-MEDITATION')

    const tugas = ok.sections.find((s) => s.key === 'tugas')!
    expect(tugas.items.map((i) => i.id).sort()).toEqual([
      'T-BE-WELL-MEDITATION-CATALOG',
      'T-RN-INT-WELLNESS',
    ])
    for (const t of tugas.items) {
      expect(t.breadcrumb).toBe('Meditasi · Kesehatan & Wellness')
      expect(t.kindLabelId).toBe('Tugas')
    }

    // Puasa task must NOT appear for meditation query
    expect(tugas.items.some((i) => i.id === 'T-RN-FASTING-1')).toBe(false)

    const unit = ok.sections.find((s) => s.key === 'unit')
    if (unit) {
      expect(unit.items.some((i) => i.id === 'U-MED-PLAYER')).toBe(true)
      expect(unit.items[0]!.breadcrumb).toContain('Meditasi')
    }

    const dok = ok.sections.find((s) => s.key === 'dokumen')
    if (dok) {
      expect(dok.items[0]!.title).toMatch(/meditasi|wellness/i)
    }
  })

  it('matches FEAT-MEDITATION via featureId without seed keywords', () => {
    const result = projectGroupedSearch({
      boardId: 'mfs-rebuild',
      query: 'meditation',
      available: true,
      features: [MEDITATION],
      maps: [],
      units: [],
      directory: [],
      seedEntries: null,
    })
    expect(result.available).toBe(true)
    const ok = result as GroupedSearchAvailable
    expect(ok.totalCount).toBeGreaterThanOrEqual(1)
    expect(ok.sections[0]!.items[0]!.id).toBe('FEAT-MEDITATION')
  })

  it('returns empty sections for empty query and unavailable honestly', () => {
    const empty = projectGroupedSearch({
      boardId: 'mfs-rebuild',
      query: '',
      available: true,
      features: [MEDITATION],
    })
    expect(empty.available).toBe(true)
    expect((empty as GroupedSearchAvailable).totalCount).toBe(0)

    const down = projectGroupedSearch({
      boardId: 'mfs-rebuild',
      query: 'meditation',
      available: false,
    })
    expect(down.available).toBe(false)
    expect(down.sections).toHaveLength(0)
    expect(down.dataGaps.some((g) => g.includes('UNAVAILABLE'))).toBe(true)
  })

  it('searchTextMatches is substring-based', () => {
    expect(searchTextMatches('FEAT-MEDITATION\nMeditasi', 'meditation')).toBe(
      true,
    )
    expect(searchTextMatches('puasa', 'meditation')).toBe(false)
  })
})

describe('SearchScreen grouped render', () => {
  it('renders id-ID section headers, breadcrumb, and kind chip', () => {
    const grouped: GroupedSearchAvailable = {
      available: true,
      boardId: 'mfs-rebuild',
      query: 'meditation',
      totalCount: 2,
      dataGaps: [],
      sections: [
        {
          key: 'fitur',
          labelId: 'Fitur',
          tone: 'accent',
          items: [
            {
              id: 'FEAT-MEDITATION',
              title: 'Meditasi',
              breadcrumb: 'Meditasi · Kesehatan & Wellness',
              kind: 'fitur',
              kindLabelId: 'Fitur',
              href: '/b/mfs-rebuild/fitur/FEAT-MEDITATION',
              technicalAlias: 'FEAT-MEDITATION',
            },
          ],
        },
        {
          key: 'tugas',
          labelId: 'Tugas',
          tone: 'ok',
          items: [
            {
              id: 'T-RN-INT-WELLNESS',
              title: 'T-RN-INT-WELLNESS',
              breadcrumb: 'Meditasi · Kesehatan & Wellness',
              kind: 'tugas',
              kindLabelId: 'Tugas',
              href: '/b/mfs-rebuild/work/T-RN-INT-WELLNESS',
              technicalAlias: 'T-RN-INT-WELLNESS',
            },
          ],
        },
      ],
    }

    render(
      <SearchScreen
        surfaceState="populated"
        boardId="mfs-rebuild"
        query="meditation"
        results={[]}
        grouped={grouped}
      />,
    )

    expect(screen.getByTestId('search-results-grouped')).toBeTruthy()
    expect(screen.getByTestId('search-section-fitur')).toBeTruthy()
    expect(screen.getByTestId('search-section-label-fitur').textContent).toBe(
      'Fitur',
    )
    expect(screen.getByTestId('search-section-label-tugas').textContent).toBe(
      'Tugas',
    )
    // no dokumen section rendered when empty
    expect(screen.queryByTestId('search-section-dokumen')).toBeNull()

    const fiturList = screen.getByTestId('search-list-fitur')
    expect(within(fiturList).getByText('Meditasi')).toBeTruthy()
    expect(
      within(fiturList).getByTestId('search-result-breadcrumb').textContent,
    ).toBe('Meditasi · Kesehatan & Wellness')
    expect(
      within(fiturList).getByTestId('search-result-kind-chip').textContent,
    ).toBe('Fitur')

    const tugasList = screen.getByTestId('search-list-tugas')
    expect(
      within(tugasList).getAllByTestId('search-result-breadcrumb')[0]!
        .textContent,
    ).toBe('Meditasi · Kesehatan & Wellness')
  })

  it('shows id-ID zero-results empty state', () => {
    render(
      <SearchScreen
        surfaceState="zero-results"
        boardId="mfs-rebuild"
        query="zzzz-no-hit"
        results={[]}
        grouped={{
          available: true,
          boardId: 'mfs-rebuild',
          query: 'zzzz-no-hit',
          sections: [],
          totalCount: 0,
          dataGaps: [],
        }}
      />,
    )
    const empty = screen.getByTestId('search-zero-results')
    expect(empty.textContent).toContain('Tidak ada hasil')
    expect(empty.textContent).toContain('zzzz-no-hit')
  })

  it('groups pin-flat results when product grouped unavailable', () => {
    render(
      <SearchScreen
        surfaceState="populated"
        boardId="mfs-rebuild"
        query="checkout"
        results={[
          {
            kind: 'task',
            id: 'T-1',
            title: 'Checkout web',
            subtitle: null,
            href: '/work/T-1',
            technicalAlias: 'T-1',
          },
          {
            kind: 'feature',
            id: 'F-1',
            title: 'Checkout',
            subtitle: null,
            href: '/features/F-1',
            technicalAlias: 'F-1',
          },
        ]}
        grouped={{
          available: false,
          reason: 'REBUILD_DATA_TABLES_NOT_MIGRATED',
          boardId: 'mfs-rebuild',
          query: 'checkout',
          sections: [],
          totalCount: 0,
          dataGaps: ['PRODUCT_SEARCH_TABLES_UNAVAILABLE'],
          emptyStateLabelId: 'x',
        }}
      />,
    )
    expect(screen.getByTestId('search-section-fitur')).toBeTruthy()
    expect(screen.getByTestId('search-section-tugas')).toBeTruthy()
    expect(SEARCH_SECTION_LABEL_ID.fitur).toBe('Fitur')
  })
})

describe('query keys W-UI-5', () => {
  it('search + grouped-search keys are stable', () => {
    expect(searchQueryKey('mfs-rebuild', 'meditation')).toEqual([
      'control-center',
      'search',
      'mfs-rebuild',
      'meditation',
    ])
    expect(groupedSearchQueryKey('mfs-rebuild', 'meditation')).toEqual([
      'control-center',
      'grouped-search',
      'mfs-rebuild',
      'meditation',
    ])
  })
})
