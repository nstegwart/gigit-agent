/**
 * FAN-SEARCH — Direction B "Pencarian" screen.
 * Entity-grouped results (Fitur / Tugas / Dokumen / Unit) via UI kit primitives.
 * Data/logic unchanged — presentation only.
 */
import { useEffect, useMemo, useState } from 'react'

import type { SearchResultViewModel } from '#/lib/control-center-route-adapters'
import { formatOperationalLabel } from '#/lib/display-label'
import type { GroupedSearchData } from '#/server/control-center-rebuild-fns'
import {
  Badge,
  Breadcrumb,
  Button,
  Card,
  Disclosure,
  EmptyState,
  KpiStat,
  MonoCell,
  PageHeader,
  Pagination,
  Pill,
  ProgressBar,
  StatusChip,
  Table,
  Tabs,
  Toolbar,
  type StatusChipVariant,
  type TableColumn,
} from '#/components/ui'

import {
  groupFlatSearchResults,
  mergeGroupedSections,
  SEARCH_SECTION_LABEL_ID,
  SEARCH_SECTION_ORDER,
  totalGroupedCount,
  type GroupedSearchHit,
  type GroupedSearchSection,
  type SearchEntitySectionKey,
} from './groupSearchResults'
import styles from './search.module.css'

export type SearchScreenProps = {
  surfaceState:
    | SearchResultViewModel['surfaceState']
    | 'loading'
    | 'error'
    | 'forbidden'
    | 'zero-results'
    | 'empty'
    | 'populated'
    | 'stale'
    | 'partial'
  boardId: string
  query: string
  /** Pin-flat results (legacy ART path). Grouped client-side when product sections absent. */
  results?: SearchResultViewModel['results']
  /** Product/rebuild grouped search (preferred when available). */
  grouped?: GroupedSearchData | null
  pin?: SearchResultViewModel['pin']
  error?: SearchResultViewModel['error']
  dataGaps?: ReadonlyArray<string>
  onRetry?: () => void
  returnHref?: string
  className?: string
}

const PAGE_SIZE_DEFAULT = 25

type SectionFilter = 'all' | SearchEntitySectionKey

/**
 * Owner-facing entity title (id-ID). Prefer human title when distinct from
 * technical id; otherwise clean operational label. Technical id stays mono secondary.
 */
function humanEntityTitle(
  title: string,
  technicalAlias: string | null,
  id: string,
): string {
  const raw = (title ?? '').trim()
  const tech = (technicalAlias ?? id ?? '').trim()
  if (!raw) {
    return formatOperationalLabel(tech) || tech || '—'
  }
  if (tech && raw === tech) {
    return formatOperationalLabel(raw) || raw
  }
  // Title already human (e.g. "Meditasi") — keep as-is.
  return raw
}

function sectionCountMap(
  sections: ReadonlyArray<GroupedSearchSection>,
): Record<SearchEntitySectionKey, number> {
  const counts: Record<SearchEntitySectionKey, number> = {
    fitur: 0,
    tugas: 0,
    dokumen: 0,
    unit: 0,
  }
  for (const sec of sections) {
    counts[sec.key] = sec.items.length
  }
  return counts
}

/** Semantic surface status only — never decorative. */
function surfaceStatusChip(
  surfaceState: SearchScreenProps['surfaceState'],
): { variant: StatusChipVariant; label: string } | null {
  switch (surfaceState) {
    case 'populated':
      return { variant: 'done', label: 'Terisi' }
    case 'stale':
    case 'partial':
      return { variant: 'warn', label: 'Sebagian / basi' }
    case 'error':
    case 'forbidden':
      return { variant: 'blocked', label: 'Gagal' }
    case 'loading':
      return { variant: 'ongoing', label: 'Memuat' }
    case 'zero-results':
      return { variant: 'pending', label: 'Kosong' }
    case 'empty':
      return { variant: 'next', label: 'Siap mencari' }
    default:
      return null
  }
}

function filterHits(
  items: ReadonlyArray<GroupedSearchHit>,
  needle: string,
): Array<GroupedSearchHit> {
  const n = needle.trim().toLocaleLowerCase('id-ID')
  if (!n) return [...items]
  return items.filter((item) => {
    const blob = [
      item.title,
      item.breadcrumb ?? '',
      item.technicalAlias ?? '',
      item.id,
      item.kindLabelId,
    ]
      .join('\n')
      .toLocaleLowerCase('id-ID')
    return blob.includes(n)
  })
}

function SectionResultsTable({
  section,
  filterText,
}: {
  section: GroupedSearchSection
  filterText: string
}) {
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(PAGE_SIZE_DEFAULT)

  const filtered = useMemo(
    () => filterHits(section.items, filterText),
    [section.items, filterText],
  )

  useEffect(() => {
    setPage(1)
  }, [filterText, section.key, section.items.length])

  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize))
  const safePage = Math.min(page, pageCount)
  const pageRows = filtered.slice(
    (safePage - 1) * pageSize,
    safePage * pageSize,
  )

  const columns: Array<TableColumn<GroupedSearchHit>> = [
    {
      id: 'title',
      header: 'Judul',
      cell: (row) => {
        const human = humanEntityTitle(row.title, row.technicalAlias, row.id)
        const tech =
          row.technicalAlias?.trim() ||
          (row.id !== human ? row.id : null)
        return (
          <div
            className={styles.titleCell}
            data-testid="search-result-row"
            data-kind={row.kind}
            data-id={row.id}
          >
            {row.href ? (
              <a
                className={styles.titleLink}
                href={row.href}
                data-field="title"
              >
                {human}
              </a>
            ) : (
              <span className={styles.titleText} data-field="title">
                {human}
              </span>
            )}
            {tech && tech !== human ? (
              <span
                className={styles.techSecondary}
                data-field="technical-alias"
                title={tech}
              >
                {tech}
              </span>
            ) : null}
          </div>
        )
      },
    },
    {
      id: 'breadcrumb',
      header: 'Lokasi',
      cell: (row) =>
        row.breadcrumb ? (
          <span
            className={styles.breadcrumbCell}
            data-field="breadcrumb"
            data-testid="search-result-breadcrumb"
          >
            {row.breadcrumb}
          </span>
        ) : (
          <span className={styles.na}>—</span>
        ),
    },
    {
      id: 'kind',
      header: 'Jenis',
      cell: (row) => (
        <Badge
          variant="neutral"
          data-field="kind-chip"
          data-testid="search-result-kind-chip"
          data-tone={section.tone}
        >
          {row.kindLabelId}
        </Badge>
      ),
    },
    {
      id: 'id',
      header: 'ID',
      mono: true,
      cell: (row) => (
        <MonoCell>
          <span title={row.id}>{row.technicalAlias ?? row.id}</span>
        </MonoCell>
      ),
    },
  ]

  return (
    <div data-testid={`search-list-${section.key}`}>
      <Table
        columns={columns}
        rows={pageRows}
        rowKey={(r) => `${r.kind}:${r.id}`}
        loading={false}
        empty="Tidak ada baris pada filter ini."
        caption={`Hasil ${section.labelId}`}
        aria-label={`Tabel hasil ${section.labelId}`}
      />
      {filtered.length > 0 ? (
        <div className={styles.pager}>
          <Pagination
            page={safePage}
            pageSize={pageSize}
            total={filtered.length}
            onPageChange={setPage}
            onPageSizeChange={(size) => {
              setPageSize(size)
              setPage(1)
            }}
            data-testid={`search-pagination-${section.key}`}
          />
        </div>
      ) : null}
    </div>
  )
}

export function SearchScreen({
  surfaceState,
  boardId,
  query,
  results = [],
  grouped = null,
  pin,
  error,
  dataGaps,
  onRetry,
  returnHref,
  className,
}: SearchScreenProps) {
  const [localFilter, setLocalFilter] = useState('')
  const [sectionFilter, setSectionFilter] = useState<SectionFilter>('all')

  const sections: Array<GroupedSearchSection> = useMemo(() => {
    const productSections =
      grouped && grouped.available === true ? grouped.sections : []
    const pinSections = groupFlatSearchResults(results)
    if (productSections.length > 0 && pinSections.length > 0) {
      return mergeGroupedSections(productSections, pinSections)
    }
    if (productSections.length > 0) return [...productSections]
    return pinSections
  }, [grouped, results])

  const total = totalGroupedCount(sections)
  const counts = useMemo(() => sectionCountMap(sections), [sections])
  const gaps =
    dataGaps ??
    (grouped && grouped.available === true ? grouped.dataGaps : []) ??
    []

  const showZero =
    surfaceState === 'zero-results' ||
    (query.trim().length > 0 &&
      total === 0 &&
      surfaceState !== 'loading' &&
      surfaceState !== 'error' &&
      surfaceState !== 'empty')

  const showEmptyQuery = surfaceState === 'empty' || query.trim().length === 0
  const isLoading = surfaceState === 'loading'

  const visibleSections = useMemo(() => {
    if (sectionFilter === 'all') return sections
    return sections.filter((s) => s.key === sectionFilter)
  }, [sections, sectionFilter])

  const boardHref = `/b/${encodeURIComponent(boardId)}`
  const filledSections = SEARCH_SECTION_ORDER.filter((k) => counts[k] > 0).length
  const statusChip = surfaceStatusChip(surfaceState)

  const subtitle = showEmptyQuery
    ? 'Cari fitur, tugas, dokumen, atau unit dengan istilah manusia atau ID teknis.'
    : query.trim()
      ? `Kueri: ${query}${total > 0 ? ` · ${total} hasil` : ''}`
      : 'Hasil pencarian pada board ini.'

  const resultsPanel = (
    <>
      {!showEmptyQuery && !showZero ? (
        <div className={styles.kpiRow} data-testid="search-kpi-row">
          <KpiStat value={total} label="Total hasil" size="sm" />
          <KpiStat
            value={counts.fitur}
            label={SEARCH_SECTION_LABEL_ID.fitur}
            size="sm"
          />
          <KpiStat
            value={counts.tugas}
            label={SEARCH_SECTION_LABEL_ID.tugas}
            size="sm"
          />
          <KpiStat
            value={counts.dokumen}
            label={SEARCH_SECTION_LABEL_ID.dokumen}
            size="sm"
          />
          <KpiStat
            value={counts.unit}
            label={SEARCH_SECTION_LABEL_ID.unit}
            size="sm"
          />
        </div>
      ) : null}

      {!showEmptyQuery && total > 0 ? (
        <div className={styles.progressSlot}>
          <ProgressBar
            value={filledSections}
            max={SEARCH_SECTION_ORDER.length}
            label={`${filledSections}/${SEARCH_SECTION_ORDER.length} entitas · ${total} baris`}
          />
        </div>
      ) : null}

      {!showEmptyQuery ? (
        <Toolbar
          data-testid="search-toolbar"
          searchProps={{
            value: localFilter,
            onChange: (e) => setLocalFilter(e.target.value),
            placeholder: 'Saring hasil di halaman ini…',
            'aria-label': 'Saring hasil pencarian',
            disabled: isLoading || total === 0,
          }}
          filters={
            <>
              <Pill
                active={sectionFilter === 'all'}
                onClick={() => setSectionFilter('all')}
                data-testid="search-filter-all"
              >
                Semua{total > 0 ? ` (${total})` : ''}
              </Pill>
              {SEARCH_SECTION_ORDER.map((key) => (
                <Pill
                  key={key}
                  active={sectionFilter === key}
                  onClick={() => setSectionFilter(key)}
                  disabled={counts[key] === 0}
                  data-testid={`search-filter-${key}`}
                >
                  {SEARCH_SECTION_LABEL_ID[key]}
                  {counts[key] > 0 ? ` (${counts[key]})` : ''}
                </Pill>
              ))}
            </>
          }
        />
      ) : null}

      {showEmptyQuery ? (
        <EmptyState
          title="Masukkan kueri pencarian"
          description={
            <>
              Gunakan bilah pencarian (⌘K / /) atau parameter <code>?q=</code>.
              Cari fitur, tugas, dokumen, atau unit dengan istilah manusia (mis.{' '}
              <strong>meditation</strong>) atau ID teknis.
            </>
          }
          data-testid="search-empty"
        />
      ) : null}

      {showZero && !showEmptyQuery ? (
        <EmptyState
          title="Tidak ada hasil"
          description={
            <>
              Tidak ada hasil untuk “{query}”. Coba istilah Indonesia, English,
              atau ID teknis (mis. FEAT-MEDITATION).
            </>
          }
          action={
            onRetry ? (
              <Button variant="secondary" size="sm" onClick={onRetry}>
                Muat ulang
              </Button>
            ) : undefined
          }
          data-testid="search-zero-results"
        />
      ) : null}

      {sections.length > 0 ? (
        <div
          className={styles.sectionStack}
          data-testid="search-results-grouped"
        >
          {visibleSections.map((sec) => (
            <Card
              key={sec.key}
              flush
              data-testid={`search-section-${sec.key}`}
              data-section={sec.key}
              aria-labelledby={`search-section-heading-${sec.key}`}
              title={
                <span className={styles.sectionHeaderInline}>
                  <span
                    id={`search-section-heading-${sec.key}`}
                    data-testid={`search-section-label-${sec.key}`}
                  >
                    {sec.labelId}
                  </span>
                  <Badge variant="neutral" mono>
                    {sec.items.length}
                  </Badge>
                </span>
              }
              subtitle={`${sec.items.length} entitas · dikelompokkan per ${sec.labelId.toLocaleLowerCase('id-ID')}`}
            >
              <SectionResultsTable section={sec} filterText={localFilter} />
            </Card>
          ))}
        </div>
      ) : null}

      {sections.length === 0 && results.length > 0 ? (
        <ul className={styles.flatFallback} data-testid="search-results">
          {results.map((r) => (
            <li
              key={`${r.kind}:${r.id}`}
              className={styles.flatRow}
              data-testid="search-result-row"
              data-kind={r.kind}
              data-id={r.id}
            >
              <a href={r.href}>
                <span data-field="title">
                  {humanEntityTitle(r.title, r.technicalAlias, r.id)}
                </span>
              </a>
            </li>
          ))}
        </ul>
      ) : null}
    </>
  )

  return (
    <section
      className={`${styles.root}${className ? ` ${className}` : ''}`}
      data-testid="control-center-search"
      data-surface-state={surfaceState}
      data-board-id={boardId}
      data-query={query}
      data-section-count={sections.length}
      data-result-total={total}
    >
      <PageHeader
        eyebrow="Pencarian"
        title={
          <span className={styles.sectionHeaderInline}>
            <span data-testid="search-title">Hasil pencarian</span>
            {statusChip ? (
              <StatusChip variant={statusChip.variant} showDot>
                {statusChip.label}
              </StatusChip>
            ) : null}
          </span>
        }
        subtitle={
          <span data-testid="search-query">
            {showEmptyQuery ? (
              subtitle
            ) : (
              <>
                Kueri: <strong>{query || '(kosong)'}</strong>
                {total > 0 ? (
                  <span data-testid="search-total-count"> · {total} hasil</span>
                ) : null}
              </>
            )}
          </span>
        }
        breadcrumb={
          <Breadcrumb
            items={[
              { label: 'Board', href: boardHref },
              { label: 'Pencarian' },
            ]}
          />
        }
        actions={
          <>
            {returnHref ? (
              <Button
                variant="secondary"
                size="sm"
                data-testid="search-return-context"
                onClick={() => {
                  window.location.assign(returnHref)
                }}
              >
                Kembali ke konteks
              </Button>
            ) : null}
            {onRetry ? (
              <Button
                variant="secondary"
                size="sm"
                onClick={onRetry}
                data-testid="search-retry"
              >
                Muat ulang
              </Button>
            ) : null}
          </>
        }
      />

      {error ? (
        <Card
          title="Kesalahan pencarian"
          data-testid="search-error"
          role="alert"
        >
          <p>
            {error.code}: {error.message}
          </p>
          {onRetry ? (
            <Button variant="primary" size="sm" onClick={onRetry}>
              Coba lagi
            </Button>
          ) : null}
        </Card>
      ) : null}

      <Tabs
        data-testid="search-tabs"
        defaultValue="hasil"
        items={[
          {
            id: 'hasil',
            label: 'Hasil',
            panel: (
              <div className={styles.sectionStack}>{resultsPanel}</div>
            ),
          },
          {
            id: 'bantuan',
            label: 'Bantuan',
            panel: (
              <EmptyState
                title="Cara memakai pencarian"
                description="Ketik istilah manusia (mis. meditasi, checkout) atau ID teknis (FEAT-…, T-…). Hasil dikelompokkan per Fitur, Tugas, Dokumen, dan Unit. Saring dengan bilah alat; buka Detail teknis untuk pin/hash."
              />
            ),
          },
        ]}
      />

      <Disclosure summary="Detail teknis" data-testid="search-tech-disclosure">
        <dl className={styles.techDl}>
          <dt>Board</dt>
          <dd className={styles.mono}>{boardId}</dd>
          <dt>Kueri</dt>
          <dd>{query || '(kosong)'}</dd>
          <dt>Status permukaan</dt>
          <dd className={styles.mono}>{surfaceState}</dd>
          <dt>Total hasil</dt>
          <dd className={styles.mono}>{total}</dd>
          {pin ? (
            <>
              <dt>Pin</dt>
              <dd className={styles.mono} data-testid="search-pin">
                {pin.canonicalSnapshotId}
              </dd>
              <dt>Revisi</dt>
              <dd className={styles.mono}>
                board {pin.boardRev} / lifecycle {pin.lifecycleRev}
              </dd>
              <dt>Hash</dt>
              <dd className={styles.mono}>{pin.canonicalHash}</dd>
              {pin.stale ? (
                <>
                  <dt>Stale</dt>
                  <dd className={styles.mono}>{pin.staleReason ?? 'STALE'}</dd>
                </>
              ) : null}
            </>
          ) : (
            <>
              <dt>Pin</dt>
              <dd className={styles.na}>—</dd>
            </>
          )}
        </dl>
        {gaps.length > 0 ? (
          <div data-testid="search-data-gaps">
            <p>Catatan data:</p>
            <ul className={styles.gapList}>
              {gaps.map((g) => (
                <li key={g}>{g}</li>
              ))}
            </ul>
          </div>
        ) : null}
      </Disclosure>
    </section>
  )
}
