import { pinnedSurfaceDataAttrs } from '#/components/control-center/PinnedSurface'
import type { ProjectsScreenProps, ProjectRowView } from './types'
import styles from './projects.module.css'

function statusTone(status: string | null): string {
  const s = (status ?? '').toLowerCase()
  if (!s) return styles.statusDot
  if (/(done|ready|ok|active|prod)/.test(s)) return `${styles.statusDot} ${styles.statusOk}`
  if (/(block|fail|error)/.test(s)) return `${styles.statusDot} ${styles.statusBlocked}`
  if (/(warn|stale|partial|risk)/.test(s)) return `${styles.statusDot} ${styles.statusWarn}`
  return styles.statusDot
}

function ProjectionGapDisclosure({ projectionGaps }: { projectionGaps: string[] }) {
  return (
    <details className={styles.gapDisclosure} data-testid="projects-partial-banner">
      <summary className={styles.gapDisclosureSummary}>
        Honest projection gaps ({projectionGaps.length})
      </summary>
      <div className={styles.gapDisclosureBody}>
        <p className={styles.bannerBody}>
          Some project detail fields are not on the public list envelope. Empty slots are not
          fabricated readiness.
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

function formatReadinessPercent(value: number | null): string {
  return value == null ? '—' : `${value}%`
}

function formatEvidenceOk(value: boolean | null): string {
  if (value === true) return 'ok'
  if (value === false) return 'gap'
  return '—'
}

function ProjectCard({ row }: { row: ProjectRowView }) {
  return (
    <li
      className={styles.card}
      data-testid="project-card"
      data-project-id={row.projectId}
      data-readiness-percent={row.readinessPercent ?? undefined}
      data-readiness-stage={row.readinessStage ?? undefined}
      data-readiness-evidence-ok={
        row.readinessEvidenceOk == null ? undefined : String(row.readinessEvidenceOk)
      }
    >
      <div className={styles.idCell}>{row.projectId}</div>
      <div className={styles.nameCell}>{row.name}</div>
      <span className={statusTone(row.status)} data-field="status">
        {row.status ?? '—'}
      </span>
      <dl className={styles.cardMeta}>
        <div>
          <dt>Tasks</dt>
          <dd className={styles.metric}>{row.taskCount}</dd>
        </div>
        <div>
          <dt>Done</dt>
          <dd className={styles.metric}>{row.doneCount}</dd>
        </div>
        <div>
          <dt>Blocked</dt>
          <dd className={styles.metric}>{row.blockedCount}</dd>
        </div>
        <div>
          <dt>Ready</dt>
          <dd className={styles.metric} data-field="readiness-percent">
            {formatReadinessPercent(row.readinessPercent)}
          </dd>
        </div>
        <div>
          <dt>Stage</dt>
          <dd data-field="readiness-stage">{row.readinessStage ?? '—'}</dd>
        </div>
        <div>
          <dt>Evidence</dt>
          <dd data-field="readiness-evidence-ok">
            {formatEvidenceOk(row.readinessEvidenceOk)}
          </dd>
        </div>
      </dl>
      <a className={styles.linkBtn} href={row.detailHref} data-testid="project-detail-link">
        Open project
      </a>
    </li>
  )
}

/**
 * Prop-driven Projects list (UI_CONTRACT §2.4).
 * Server summaries only — no client readiness recompute.
 */
export function ProjectsScreen({
  surfaceState,
  boardId,
  projects,
  productDenominator,
  bucketCounts,
  pin,
  error,
  projectionGaps,
  liveMessage,
  onRetry,
  onRefresh,
  className,
}: ProjectsScreenProps) {
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
      data-testid="control-center-projects"
      data-surface-state={surfaceState}
      data-board-id={boardId}
      data-project-count={projects.length}
      data-reflow-breakpoint="768"
      aria-labelledby="projects-page-title"
      {...pinAttrs}
    >
      <div
        className={styles.liveRegion}
        role="status"
        aria-live="polite"
        aria-atomic="true"
        data-testid="projects-live"
      >
        {liveMessage ?? ''}
      </div>

      <header className={styles.pageHead}>
        <div>
          <p className={styles.eyebrow}>IA · Projects</p>
          <h1 id="projects-page-title" className={styles.pageTitle}>
            Projects
          </h1>
          <p className={styles.pageSub}>
            Server-derived project summaries from the pinned control-center envelope, including
            readiness percent / stage / evidence when the projector proves them. Not recomputed in
            the browser.
          </p>
        </div>
        <div className={styles.summaryStrip}>
          <span className={`${styles.chip} ${styles.chipAccent}`} data-testid="projects-count">
            <span aria-hidden="true">▣</span>
            {projects.length} projects
          </span>
          {productDenominator != null ? (
            <span className={styles.chip} data-testid="projects-product-denom">
              product denom {productDenominator}
            </span>
          ) : null}
        </div>
      </header>

      {pin ? (
        <p
          className={styles.pinStrip}
          data-testid="projects-pin"
          data-canonical-snapshot-id={pin.canonicalSnapshotId}
          data-canonical-hash={pin.canonicalHash}
          data-board-rev={pin.boardRev}
          data-lifecycle-rev={pin.lifecycleRev}
        >
          pin <code>{pin.canonicalSnapshotId}</code> · hash{' '}
          <code>
            {pin.canonicalHash.length > 12
              ? `${pin.canonicalHash.slice(0, 10)}…`
              : pin.canonicalHash}
          </code>{' '}
          · boardRev {pin.boardRev} · lifecycleRev {pin.lifecycleRev}
          {pin.stale ? ` · STALE ${pin.staleReason ?? ''}` : ''}
        </p>
      ) : null}

      {bucketCounts && Object.keys(bucketCounts).length > 0 ? (
        <div className={styles.summaryStrip} data-testid="projects-bucket-strip" aria-label="Bucket counts">
          {Object.entries(bucketCounts).map(([k, v]) => (
            <span key={k} className={styles.chip}>
              {k} <strong>{v}</strong>
            </span>
          ))}
        </div>
      ) : null}

      {error ? (
        <div
          className={`${styles.banner} ${styles.banner_error}`}
          role="alert"
          data-testid="projects-error"
        >
          <p className={styles.bannerTitle}>
            {error.code}: projects unavailable
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
        <div className={`${styles.banner} ${styles.banner_stale}`} role="status" data-testid="projects-stale">
          <p className={styles.bannerTitle}>Stale pin</p>
          <p className={styles.bannerBody}>
            {pin?.staleReason ?? 'Pinned aggregation is stale — refresh for current projects.'}
          </p>
          {onRefresh ? (
            <button type="button" className={styles.retryBtn} onClick={onRefresh}>
              Refresh
            </button>
          ) : null}
        </div>
      ) : null}

      {surfaceState === 'loading' ? (
        <div className={styles.skeleton} data-testid="projects-skeleton" aria-hidden="true">
          <div className={styles.skeletonCard} />
          <div className={styles.skeletonCard} />
        </div>
      ) : null}

      {surfaceState === 'empty' || surfaceState === 'zero-results' ? (
        <p className={styles.empty} data-testid="projects-empty">
          No projects on this pin.
        </p>
      ) : null}

      {!hideList && projects.length > 0 ? (
        <>
          <div className={styles.tableWrap} data-testid="projects-table">
            <table className={styles.table}>
              <thead>
                <tr>
                  <th scope="col">Project</th>
                  <th scope="col">Name</th>
                  <th scope="col">Status</th>
                  <th scope="col">Tasks</th>
                  <th scope="col">Done</th>
                  <th scope="col">Blocked</th>
                  <th scope="col">Ready</th>
                  <th scope="col">Stage</th>
                  <th scope="col">Evidence</th>
                  <th scope="col">
                    <span className="sr-only">Open</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {projects.map((row) => (
                  <tr
                    key={row.projectId}
                    data-testid="project-row"
                    data-project-id={row.projectId}
                    data-readiness-percent={row.readinessPercent ?? undefined}
                    data-readiness-stage={row.readinessStage ?? undefined}
                    data-readiness-evidence-ok={
                      row.readinessEvidenceOk == null
                        ? undefined
                        : String(row.readinessEvidenceOk)
                    }
                  >
                    <td className={styles.idCell}>{row.projectId}</td>
                    <td className={styles.nameCell}>{row.name}</td>
                    <td>
                      <span className={statusTone(row.status)}>{row.status ?? '—'}</span>
                    </td>
                    <td className={styles.metric}>{row.taskCount}</td>
                    <td className={styles.metric}>{row.doneCount}</td>
                    <td className={styles.metric}>{row.blockedCount}</td>
                    <td className={styles.metric} data-field="readiness-percent">
                      {formatReadinessPercent(row.readinessPercent)}
                    </td>
                    <td data-field="readiness-stage">{row.readinessStage ?? '—'}</td>
                    <td data-field="readiness-evidence-ok">
                      {formatEvidenceOk(row.readinessEvidenceOk)}
                    </td>
                    <td>
                      <a
                        className={styles.linkBtn}
                        href={row.detailHref}
                        data-testid="project-detail-link"
                      >
                        Open
                      </a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <ul className={styles.cardList} data-testid="projects-cards">
            {projects.map((row) => (
              <ProjectCard key={row.projectId} row={row} />
            ))}
          </ul>
        </>
      ) : null}

      {showProjectionGaps && projectionGapList.length > 0 ? (
        <ProjectionGapDisclosure projectionGaps={projectionGapList} />
      ) : null}
    </section>
  )
}
