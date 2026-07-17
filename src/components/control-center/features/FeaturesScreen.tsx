import { useMemo, useState, type ReactNode } from 'react'

import { pinnedSurfaceDataAttrs } from '#/components/control-center/PinnedSurface'
import type { FeatureFlowBranch, FeatureRowView, FeaturesScreenProps } from './types'
import styles from './features.module.css'

type ListFilter = 'attention' | 'hold' | 'active' | 'all'
type ListGroup = 'none' | 'project' | 'phase'

function branchLabel(branch: FeatureFlowBranch): string {
  if (!branch) return '—'
  return branch
}

function branchClass(branch: FeatureFlowBranch): string {
  if (branch === 'success') return `${styles.statusDot} ${styles.statusOk}`
  if (branch === 'fail') return `${styles.statusDot} ${styles.statusBlocked}`
  if (branch === 'expired') return `${styles.statusDot} ${styles.statusWarn}`
  if (branch === 'open') return `${styles.statusDot} ${styles.chipAccent}`
  return styles.statusDot
}

/** Mono + ellipsis; full value always in title (never mid-token wrap). */
function IdText({
  value,
  className,
  children,
  field,
}: {
  value: string | null | undefined
  className?: string
  children?: ReactNode
  field?: string
}) {
  const full = value ?? '—'
  return (
    <span
      className={className ?? styles.idCell}
      title={full}
      data-full-value={value ?? undefined}
      data-field={field}
    >
      {children ?? full}
    </span>
  )
}

function ProjectionGapDisclosure({ projectionGaps }: { projectionGaps: string[] }) {
  return (
    <details className={styles.gapDisclosure} data-testid="features-partial-banner">
      <summary className={styles.gapDisclosureSummary}>
        Celah proyeksi jujur ({projectionGaps.length})
      </summary>
      <div className={styles.gapDisclosureBody}>
        <p className={styles.bannerBody}>
          Daftar hanya menampilkan field envelope — checklist/komentar ada di rute detail.
        </p>
        <ul className={styles.gapList}>
          {projectionGaps.map((g) => (
            <li key={g}>{g}</li>
          ))}
        </ul>
      </div>
    </details>
  )
}

const CONTEXT_FIELDS: Array<{
  key: keyof Pick<
    FeatureRowView,
    | 'pageRoutes'
    | 'apiEndpoints'
    | 'logicRules'
    | 'dataContext'
    | 'geoVariants'
    | 'providerVariants'
    | 'sideEffectsReadback'
    | 'styleContext'
  >
  label: string
}> = [
  { key: 'pageRoutes', label: 'routes' },
  { key: 'apiEndpoints', label: 'api' },
  { key: 'logicRules', label: 'rules' },
  { key: 'dataContext', label: 'data' },
  { key: 'geoVariants', label: 'geo' },
  { key: 'providerVariants', label: 'provider' },
  { key: 'sideEffectsReadback', label: 'readback' },
  { key: 'styleContext', label: 'style' },
]

function rowHasContext(row: FeatureRowView): boolean {
  return CONTEXT_FIELDS.some(({ key }) => row[key].length > 0)
}

function rowHasFlow(row: FeatureRowView): boolean {
  return row.flowBranch != null
}

function isHoldPhase(row: FeatureRowView): boolean {
  return row.phase != null && /^hold$/i.test(row.phase.trim())
}

/** Perlu perhatian: HOLD, fail/expired, atau cabang alur belum ada (belum success). */
function needsAttention(row: FeatureRowView): boolean {
  if (isHoldPhase(row)) return true
  if (row.flowBranch === 'fail' || row.flowBranch === 'expired') return true
  if (row.flowBranch == null) return true
  if (row.flowBranch === 'open') return true
  return false
}

function FeatureContextChips({ row }: { row: FeatureRowView }) {
  const groups = CONTEXT_FIELDS.map(({ key, label }) => ({
    key,
    label,
    values: row[key],
  })).filter((g) => g.values.length > 0)

  if (groups.length === 0) {
    // Column only mounts when ≥1 row has context — empty cell is quiet dash, not spam copy.
    return (
      <span className={styles.mutedDash} data-testid="feature-context-empty" data-field="context">
        —
      </span>
    )
  }

  return (
    <div className={styles.summaryStrip} data-testid="feature-context" data-field="context">
      {groups.map((g) => (
        <span
          key={g.key}
          className={styles.chip}
          data-context-kind={g.key}
          title={g.values.join(', ')}
        >
          {g.label} <strong>{g.values.length}</strong>
          <span className="sr-only">: {g.values.join(', ')}</span>
        </span>
      ))}
    </div>
  )
}

function FeatureCard({
  row,
  showFlow,
  showContext,
}: {
  row: FeatureRowView
  showFlow: boolean
  showContext: boolean
}) {
  return (
    <li
      className={styles.card}
      data-testid="feature-card"
      data-feature-id={row.featureId}
      data-flow-branch={row.flowBranch ?? 'none'}
    >
      {/* Name primary; technical FC id secondary (01A human-first). */}
      <div className={styles.nameCell}>{row.name}</div>
      <IdText value={row.featureId} field="feature-id-secondary" />
      {showFlow ? (
        <span className={branchClass(row.flowBranch)} data-field="flow-branch">
          {branchLabel(row.flowBranch)}
        </span>
      ) : null}
      <dl className={styles.cardMeta}>
        <div>
          <dt>Fase</dt>
          <dd>{row.phase ?? '—'}</dd>
        </div>
        <div>
          <dt>Tugas</dt>
          <dd className={styles.metric}>{row.taskCount}</dd>
        </div>
        <div>
          <dt>Proyek</dt>
          <dd>
            {row.projectHref && row.projectId ? (
              <a href={row.projectHref} className={styles.idLink} title={row.projectId}>
                <IdText value={row.projectId} />
              </a>
            ) : (
              <IdText value={row.projectId} />
            )}
          </dd>
        </div>
      </dl>
      {showContext ? <FeatureContextChips row={row} /> : null}
      <a className={styles.linkBtn} href={row.detailHref} data-testid="feature-detail-link">
        Buka fitur
      </a>
    </li>
  )
}

function filterLabel(f: ListFilter): string {
  if (f === 'attention') return 'Perlu perhatian'
  if (f === 'hold') return 'HOLD'
  if (f === 'active') return 'Aktif'
  return 'Semua'
}

function groupLabel(g: ListGroup): string {
  if (g === 'project') return 'Per proyek'
  if (g === 'phase') return 'Per fase'
  return 'Tanpa grup'
}

function applyFilter(rows: FeatureRowView[], filter: ListFilter): FeatureRowView[] {
  if (filter === 'all') return rows
  if (filter === 'hold') return rows.filter(isHoldPhase)
  if (filter === 'active') return rows.filter((r) => !isHoldPhase(r))
  return rows.filter(needsAttention)
}

function groupKey(row: FeatureRowView, group: ListGroup): string {
  if (group === 'project') return row.projectId?.trim() || '(tanpa proyek)'
  if (group === 'phase') return row.phase?.trim() || '(tanpa fase)'
  return ''
}

/**
 * Prop-driven Features list (UI_CONTRACT §2.5).
 * Server flow branch + pagination; no client phase recompute.
 * W-FIX-FEATURES: dead Alur/Konteks columns, ID ellipsis, demote pin chrome, list filters.
 */
export function FeaturesScreen({
  surfaceState,
  boardId,
  features,
  pageSize,
  nextCursor,
  pin,
  error,
  projectionGaps,
  liveMessage,
  onRetry,
  onRefresh,
  onNextPage,
  className,
}: FeaturesScreenProps) {
  const [listFilter, setListFilter] = useState<ListFilter>('attention')
  const [listGroup, setListGroup] = useState<ListGroup>('none')

  const hideList =
    surfaceState === 'loading' ||
    surfaceState === 'error' ||
    surfaceState === 'forbidden' ||
    surfaceState === 'disconnected'

  const pinAttrs = pinnedSurfaceDataAttrs(
    pin
      ? {
          canonicalSnapshotId: pin.canonicalSnapshotId,
          canonicalHash: pin.canonicalHash,
          boardRev: pin.boardRev,
          lifecycleRev: pin.lifecycleRev,
          generatedAt: pin.generatedAt,
          freshnessAgeSeconds: pin.freshnessAgeSeconds,
          stale: pin.stale,
        }
      : null,
  )
  const projectionGapList = projectionGaps ?? []
  const showProjectionGaps =
    surfaceState === 'partial' || (projectionGapList.length > 0 && surfaceState === 'populated')

  // Column gates use the full page set (not filtered) so filter changes do not thrash headers.
  const showFlowCol = useMemo(() => features.some(rowHasFlow), [features])
  const showContextCol = useMemo(() => features.some(rowHasContext), [features])

  const filtered = useMemo(
    () => applyFilter(features, listFilter),
    [features, listFilter],
  )

  const grouped = useMemo(() => {
    if (listGroup === 'none') {
      return [{ key: '', rows: filtered }]
    }
    const map = new Map<string, FeatureRowView[]>()
    for (const row of filtered) {
      const k = groupKey(row, listGroup)
      const bucket = map.get(k)
      if (bucket) bucket.push(row)
      else map.set(k, [row])
    }
    return Array.from(map.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, rows]) => ({ key, rows }))
  }, [filtered, listGroup])

  const filterOptions: ListFilter[] = ['attention', 'hold', 'active', 'all']
  const groupOptions: ListGroup[] = ['none', 'project', 'phase']

  return (
    <section
      className={[styles.root, className].filter(Boolean).join(' ')}
      data-testid="control-center-features"
      data-surface-state={surfaceState}
      data-board-id={boardId}
      data-feature-count={features.length}
      data-filtered-count={filtered.length}
      data-list-filter={listFilter}
      data-list-group={listGroup}
      data-show-flow-col={showFlowCol ? '1' : '0'}
      data-show-context-col={showContextCol ? '1' : '0'}
      data-reflow-breakpoint="768"
      aria-labelledby="features-page-title"
      {...pinAttrs}
    >
      <div
        className={styles.liveRegion}
        role="status"
        aria-live="polite"
        aria-atomic="true"
        data-testid="features-live"
      >
        {liveMessage ?? ''}
      </div>

      <header className={styles.pageHead}>
        <div>
          <p className={styles.eyebrow}>IA · Fitur / Alur</p>
          <h1 id="features-page-title" className={styles.pageTitle}>
            Fitur
          </h1>
          <p className={styles.pageSub}>
            Ringkasan fitur dari pin server. Nama fitur utama; ID teknis (FC-*) mono + ellipsis.
            Kolom alur/konteks hanya tampil jika ada nilai nyata di halaman ini.
          </p>
        </div>
        <div className={styles.summaryStrip}>
          <span className={`${styles.chip} ${styles.chipAccent}`} data-testid="features-count">
            <span aria-hidden="true">◇</span>
            {filtered.length}
            {filtered.length !== features.length
              ? ` dari ${features.length}`
              : ''}{' '}
            di halaman ini
          </span>
        </div>
      </header>

      {/* pin / boardRev / lifecycleRev / pageSize — engineer chrome under disclosure */}
      <details className={styles.gapDisclosure} data-testid="features-technical">
        <summary className={styles.gapDisclosureSummary}>Detail teknis</summary>
        <div className={styles.gapDisclosureBody}>
          <p className={styles.technicalIdLine}>
            <span className={styles.technicalIdLabel}>pageSize</span>
            <code data-testid="features-page-size">{pageSize}</code>
          </p>
          {pin ? (
            <div
              data-testid="features-pin"
              data-canonical-snapshot-id={pin.canonicalSnapshotId}
              data-canonical-hash={pin.canonicalHash}
              data-board-rev={pin.boardRev}
              data-lifecycle-rev={pin.lifecycleRev}
            >
              <p className={styles.technicalIdLine}>
                <span className={styles.technicalIdLabel}>pin</span>
                <code title={pin.canonicalSnapshotId}>{pin.canonicalSnapshotId}</code>
              </p>
              <p className={styles.technicalIdLine}>
                <span className={styles.technicalIdLabel}>boardRev</span>
                <code>{pin.boardRev}</code>
              </p>
              <p className={styles.technicalIdLine}>
                <span className={styles.technicalIdLabel}>lifecycleRev</span>
                <code>{pin.lifecycleRev}</code>
              </p>
              {pin.stale ? (
                <p className={`${styles.banner} ${styles.banner_stale}`} style={{ marginTop: 8 }}>
                  <span className={styles.bannerTitle}>STALE</span>{' '}
                  <span className={styles.bannerBody}>{pin.staleReason ?? 'snapshot usang'}</span>
                </p>
              ) : null}
            </div>
          ) : null}
        </div>
      </details>

      {error ? (
        <div
          className={`${styles.banner} ${styles.banner_error}`}
          role="alert"
          data-testid="features-error"
        >
          <p className={styles.bannerTitle}>
            {error.code}: fitur tidak tersedia
          </p>
          <p className={styles.bannerBody}>{error.message}</p>
          {onRetry ? (
            <button type="button" className={styles.retryBtn} onClick={onRetry}>
              Coba lagi
            </button>
          ) : null}
        </div>
      ) : null}

      {surfaceState === 'stale' ? (
        <div className={`${styles.banner} ${styles.banner_stale}`} role="status">
          <p className={styles.bannerTitle}>Pin basi</p>
          <p className={styles.bannerBody}>
            {pin?.staleReason ?? 'Agregasi pin basi — muat ulang untuk fitur terkini.'}
          </p>
          {onRefresh ? (
            <button type="button" className={styles.retryBtn} onClick={onRefresh}>
              Muat ulang
            </button>
          ) : null}
        </div>
      ) : null}

      {surfaceState === 'loading' ? (
        <div className={styles.skeleton} data-testid="features-skeleton" aria-hidden="true">
          <div className={styles.skeletonCard} />
          <div className={styles.skeletonCard} />
        </div>
      ) : null}

      {surfaceState === 'empty' || surfaceState === 'zero-results' ? (
        <p className={styles.empty} data-testid="features-empty">
          Tidak ada fitur pada pin ini.
        </p>
      ) : null}

      {!hideList && features.length > 0 ? (
        <div className={styles.filterBar} data-testid="features-filter-bar" role="toolbar" aria-label="Filter dan grup fitur">
          <div className={styles.projectChips} role="group" aria-label="Filter daftar">
            {filterOptions.map((f) => (
              <button
                key={f}
                type="button"
                className={
                  listFilter === f
                    ? `${styles.projectChip} ${styles.projectChipActive}`
                    : styles.projectChip
                }
                aria-pressed={listFilter === f}
                data-testid={`features-filter-${f}`}
                onClick={() => setListFilter(f)}
              >
                {filterLabel(f)}
              </button>
            ))}
          </div>
          <div className={styles.projectChips} role="group" aria-label="Grup daftar">
            {groupOptions.map((g) => (
              <button
                key={g}
                type="button"
                className={
                  listGroup === g
                    ? `${styles.projectChip} ${styles.projectChipActive}`
                    : styles.projectChip
                }
                aria-pressed={listGroup === g}
                data-testid={`features-group-${g}`}
                onClick={() => setListGroup(g)}
              >
                {groupLabel(g)}
              </button>
            ))}
          </div>
        </div>
      ) : null}

      {!hideList && features.length > 0 && filtered.length === 0 ? (
        <p className={styles.empty} data-testid="features-filter-empty">
          Tidak ada fitur untuk filter «{filterLabel(listFilter)}». Pilih «Semua» untuk menampilkan
          seluruh halaman.
        </p>
      ) : null}

      {!hideList && filtered.length > 0 ? (
        <>
          {grouped.map((section) => (
            <div
              key={section.key || '__all__'}
              className={styles.groupSection}
              data-testid={section.key ? 'features-group-section' : 'features-group-flat'}
              data-group-key={section.key || undefined}
            >
              {section.key ? (
                <h2 className={styles.groupHeading}>
                  {listGroup === 'project' ? 'Proyek' : 'Fase'} · {section.key}
                  <span className={styles.groupCount}>{section.rows.length}</span>
                </h2>
              ) : null}

              <div className={styles.tableWrap} data-testid="features-table">
                <table className={styles.table}>
                  <thead>
                    <tr>
                      <th scope="col">Nama</th>
                      <th scope="col">ID teknis</th>
                      {showFlowCol ? <th scope="col">Alur</th> : null}
                      <th scope="col">Fase</th>
                      <th scope="col">Proyek</th>
                      <th scope="col">Tugas</th>
                      {showContextCol ? <th scope="col">Konteks</th> : null}
                      <th scope="col">
                        <span className="sr-only">Buka</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {section.rows.map((row) => (
                      <tr
                        key={row.featureId}
                        data-testid="feature-row"
                        data-feature-id={row.featureId}
                        data-flow-branch={row.flowBranch ?? 'none'}
                      >
                        <td className={styles.nameCell}>{row.name}</td>
                        <td>
                          <IdText value={row.featureId} field="feature-id-secondary" />
                        </td>
                        {showFlowCol ? (
                          <td>
                            <span className={branchClass(row.flowBranch)}>
                              {branchLabel(row.flowBranch)}
                            </span>
                          </td>
                        ) : null}
                        <td>{row.phase ?? '—'}</td>
                        <td>
                          {row.projectHref && row.projectId ? (
                            <a
                              href={row.projectHref}
                              className={styles.idLink}
                              title={row.projectId}
                            >
                              <IdText value={row.projectId} />
                            </a>
                          ) : (
                            <IdText value={row.projectId} />
                          )}
                        </td>
                        <td className={styles.metric}>{row.taskCount}</td>
                        {showContextCol ? (
                          <td>
                            <FeatureContextChips row={row} />
                          </td>
                        ) : null}
                        <td>
                          <a
                            className={styles.linkBtn}
                            href={row.detailHref}
                            data-testid="feature-detail-link"
                          >
                            Buka
                          </a>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <ul className={styles.cardList} data-testid="features-cards">
                {section.rows.map((row) => (
                  <FeatureCard
                    key={row.featureId}
                    row={row}
                    showFlow={showFlowCol}
                    showContext={showContextCol}
                  />
                ))}
              </ul>
            </div>
          ))}
        </>
      ) : null}

      {showProjectionGaps && projectionGapList.length > 0 ? (
        <ProjectionGapDisclosure projectionGaps={projectionGapList} />
      ) : null}

      {nextCursor ? (
        <div className={styles.summaryStrip}>
          <span className={styles.chip} data-testid="features-next-cursor">
            More pages (server cursor)
          </span>
          {onNextPage ? (
            <button type="button" className={styles.retryBtn} onClick={onNextPage}>
              Next page
            </button>
          ) : null}
        </div>
      ) : null}
    </section>
  )
}
