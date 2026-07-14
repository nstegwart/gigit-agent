import { pinnedSurfaceDataAttrs } from '#/components/control-center/PinnedSurface'
import type { FeatureFlowBranch, FeatureRowView, FeaturesScreenProps } from './types'
import styles from './features.module.css'

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

function ProjectionGapDisclosure({ projectionGaps }: { projectionGaps: string[] }) {
  return (
    <details className={styles.gapDisclosure} data-testid="features-partial-banner">
      <summary className={styles.gapDisclosureSummary}>
        Honest projection gaps ({projectionGaps.length})
      </summary>
      <div className={styles.gapDisclosureBody}>
        <p className={styles.bannerBody}>
          List surface shows envelope fields only — checklist/comments live on detail routes.
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

function FeatureContextChips({ row }: { row: FeatureRowView }) {
  const groups = CONTEXT_FIELDS.map(({ key, label }) => ({
    key,
    label,
    values: row[key],
  })).filter((g) => g.values.length > 0)

  if (groups.length === 0) {
    return (
      <span className={styles.chip} data-testid="feature-context-empty" data-field="context">
        no flow context
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

function FeatureCard({ row }: { row: FeatureRowView }) {
  return (
    <li
      className={styles.card}
      data-testid="feature-card"
      data-feature-id={row.featureId}
      data-flow-branch={row.flowBranch ?? 'none'}
    >
      {/* Name primary; technical FC id secondary (01A human-first). */}
      <div className={styles.nameCell}>{row.name}</div>
      <div className={styles.idCell} data-field="feature-id-secondary">
        {row.featureId}
      </div>
      <span className={branchClass(row.flowBranch)} data-field="flow-branch">
        {branchLabel(row.flowBranch)}
      </span>
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
          <dd className={styles.idCell}>
            {row.projectHref && row.projectId ? (
              <a href={row.projectHref}>{row.projectId}</a>
            ) : (
              row.projectId ?? '—'
            )}
          </dd>
        </div>
      </dl>
      <FeatureContextChips row={row} />
      <a className={styles.linkBtn} href={row.detailHref} data-testid="feature-detail-link">
        Buka fitur
      </a>
    </li>
  )
}

/**
 * Prop-driven Features list (UI_CONTRACT §2.5).
 * Server flow branch + pagination; no client phase recompute.
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

  return (
    <section
      className={[styles.root, className].filter(Boolean).join(' ')}
      data-testid="control-center-features"
      data-surface-state={surfaceState}
      data-board-id={boardId}
      data-feature-count={features.length}
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
            Ringkasan fitur dari pin server: cabang alur dan konteks rute/API/aturan/data saat ada.
            Nama fitur utama; ID teknis (FC-*) di baris sekunder.
          </p>
        </div>
        <div className={styles.summaryStrip}>
          <span className={`${styles.chip} ${styles.chipAccent}`} data-testid="features-count">
            <span aria-hidden="true">◇</span>
            {features.length} di halaman ini
          </span>
          <span className={styles.chip}>pageSize {pageSize}</span>
        </div>
      </header>

      {pin ? (
        <p
          className={styles.pinStrip}
          data-testid="features-pin"
          data-canonical-snapshot-id={pin.canonicalSnapshotId}
          data-canonical-hash={pin.canonicalHash}
          data-board-rev={pin.boardRev}
          data-lifecycle-rev={pin.lifecycleRev}
        >
          pin <code>{pin.canonicalSnapshotId}</code> · boardRev {pin.boardRev} · lifecycleRev{' '}
          {pin.lifecycleRev}
          {pin.stale ? ` · STALE ${pin.staleReason ?? ''}` : ''}
        </p>
      ) : null}

      {error ? (
        <div
          className={`${styles.banner} ${styles.banner_error}`}
          role="alert"
          data-testid="features-error"
        >
          <p className={styles.bannerTitle}>
            {error.code}: features unavailable
          </p>
          <p className={styles.bannerBody}>{error.message}</p>
          {onRetry ? (
            <button type="button" className={styles.retryBtn} onClick={onRetry}>
              Retry
            </button>
          ) : null}
        </div>
      ) : null}

      {surfaceState === 'stale' ? (
        <div className={`${styles.banner} ${styles.banner_stale}`} role="status">
          <p className={styles.bannerTitle}>Stale pin</p>
          <p className={styles.bannerBody}>
            {pin?.staleReason ?? 'Pinned aggregation is stale — refresh for current features.'}
          </p>
          {onRefresh ? (
            <button type="button" className={styles.retryBtn} onClick={onRefresh}>
              Refresh
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
          No features on this pin.
        </p>
      ) : null}

      {!hideList && features.length > 0 ? (
        <>
          <div className={styles.tableWrap} data-testid="features-table">
            <table className={styles.table}>
              <thead>
                <tr>
                  <th scope="col">Nama</th>
                  <th scope="col">ID teknis</th>
                  <th scope="col">Alur</th>
                  <th scope="col">Fase</th>
                  <th scope="col">Proyek</th>
                  <th scope="col">Tugas</th>
                  <th scope="col">Konteks</th>
                  <th scope="col">
                    <span className="sr-only">Buka</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {features.map((row) => (
                  <tr
                    key={row.featureId}
                    data-testid="feature-row"
                    data-feature-id={row.featureId}
                    data-flow-branch={row.flowBranch ?? 'none'}
                  >
                    <td className={styles.nameCell}>{row.name}</td>
                    <td className={styles.idCell} data-field="feature-id-secondary">
                      {row.featureId}
                    </td>
                    <td>
                      <span className={branchClass(row.flowBranch)}>
                        {branchLabel(row.flowBranch)}
                      </span>
                    </td>
                    <td>{row.phase ?? '—'}</td>
                    <td className={styles.idCell}>
                      {row.projectHref && row.projectId ? (
                        <a href={row.projectHref}>{row.projectId}</a>
                      ) : (
                        row.projectId ?? '—'
                      )}
                    </td>
                    <td className={styles.metric}>{row.taskCount}</td>
                    <td>
                      <FeatureContextChips row={row} />
                    </td>
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
            {features.map((row) => (
              <FeatureCard key={row.featureId} row={row} />
            ))}
          </ul>
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
