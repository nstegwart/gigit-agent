/**
 * ART S09–S10 human-first task detail (prop-driven).
 * Owner humanDisplay primary; technical fields demoted to "Detail teknis"
 * disclosure (human mode) or expanded panel (mode=technical).
 * Never invents humanDisplay copy — only displays projected props.
 */
import type { TaskDetailViewModel } from '#/lib/control-center-route-adapters'
import styles from './task-detail.module.css'

export type TaskDetailScreenProps = TaskDetailViewModel & {
  onRetry?: () => void
  className?: string
}

function TechnicalFields({
  taskId,
  technicalTitle,
  bucket,
  overlays,
  projectId,
  featureId,
  lifecycleStage,
  targetGate,
  claimState,
  blockReason,
}: {
  taskId: string
  technicalTitle: string
  bucket: string | null
  overlays: ReadonlyArray<string>
  projectId: string | null
  featureId: string | null
  lifecycleStage: string | null
  targetGate: string | null
  claimState: string | null
  blockReason: string | null
}) {
  return (
    <dl className={styles.technicalGrid} data-testid="task-detail-technical">
      <dt>taskId</dt>
      <dd>
        <code>{taskId}</code>
      </dd>
      <dt>technicalTitle</dt>
      <dd>{technicalTitle || '—'}</dd>
      <dt>bucket</dt>
      <dd>{bucket ?? '—'}</dd>
      <dt>overlays</dt>
      <dd>{overlays.length ? overlays.join(', ') : '—'}</dd>
      <dt>projectId</dt>
      <dd>{projectId ?? '—'}</dd>
      <dt>featureId</dt>
      <dd>{featureId ?? '—'}</dd>
      <dt>lifecycleStage</dt>
      <dd>{lifecycleStage ?? '—'}</dd>
      <dt>targetGate</dt>
      <dd>{targetGate ?? '—'}</dd>
      <dt>claimState</dt>
      <dd>{claimState ?? '—'}</dd>
      <dt>blockReason</dt>
      <dd>{blockReason ?? '—'}</dd>
    </dl>
  )
}

export function TaskDetailScreen({
  surfaceState,
  boardId,
  taskId,
  mode,
  ownerPrimaryTitle,
  statusSentence,
  ownerAction,
  whyItMatters,
  next,
  blocker,
  contentReviewRequired,
  effectiveReviewStatus,
  technicalTitle,
  projectId,
  featureId,
  bucket,
  overlays,
  blockReason,
  lifecycleStage,
  targetGate,
  claimState,
  pin,
  error,
  workHref,
  technicalHref,
  humanHref,
  onRetry,
  className,
}: TaskDetailScreenProps) {
  const isTechnical = mode === 'technical'
  // Prefer projected owner title; never invent narrative. Fallback shell only when empty.
  const title =
    ownerPrimaryTitle && ownerPrimaryTitle.trim().length > 0
      ? ownerPrimaryTitle
      : 'Perlu tinjauan konten'

  const missing =
    surfaceState === 'zero-results' ||
    surfaceState === 'error' ||
    surfaceState === 'forbidden'

  const technicalProps = {
    taskId,
    technicalTitle,
    bucket,
    overlays,
    projectId,
    featureId,
    lifecycleStage,
    targetGate,
    claimState,
    blockReason,
  }

  return (
    <section
      className={[styles.root, className].filter(Boolean).join(' ')}
      data-testid="control-center-task-detail"
      data-surface-state={surfaceState}
      data-board-id={boardId}
      data-task-id={taskId}
      data-mode={mode}
      data-content-review-required={contentReviewRequired ? 'true' : 'false'}
    >
      <header className={styles.pageHead}>
        <p className={styles.eyebrow}>Detail tugas</p>
        <h1 className={styles.pageTitle} data-testid="task-detail-title">
          {missing ? 'Tugas tidak ditemukan' : title}
        </h1>
        <p className={styles.statusSentence} data-testid="task-detail-status">
          {statusSentence || (error ? error.message : '')}
        </p>
        <div className={styles.actions}>
          <a href={workHref} className={styles.linkBtn} data-testid="task-detail-back-work">
            ← Pekerjaan
          </a>
          {isTechnical ? (
            <a
              href={humanHref}
              className={styles.modeLink}
              data-testid="task-detail-mode-human"
            >
              Mode pemilik
            </a>
          ) : (
            <a
              href={technicalHref}
              className={`${styles.modeLink} ${styles.modeLinkActive}`}
              data-testid="task-detail-mode-technical"
            >
              Mode teknis
            </a>
          )}
          {onRetry ? (
            <button
              type="button"
              className={styles.retryBtn}
              onClick={onRetry}
              data-testid="task-detail-retry"
            >
              Coba lagi
            </button>
          ) : null}
        </div>
      </header>

      {error && surfaceState !== 'populated' && surfaceState !== 'stale' ? (
        <div className={styles.errorBanner} role="alert" data-testid="task-detail-error">
          {error.code}: {error.message}
        </div>
      ) : null}

      {!missing ? (
        <div className={styles.body} data-testid="task-detail-body">
          {contentReviewRequired ? (
            <p
              className={styles.reviewBadge}
              data-testid="task-detail-review-badge"
              data-review-status={effectiveReviewStatus}
              role="status"
            >
              Perlu tinjauan konten
            </p>
          ) : null}

          {ownerAction ? (
            <div className={styles.ownerAction} data-testid="task-detail-owner-action">
              <span className={styles.ownerFieldLabel}>Tindakan</span>
              {ownerAction}
            </div>
          ) : null}
          {whyItMatters ? (
            <p className={styles.ownerField} data-testid="task-detail-why">
              <span className={styles.ownerFieldLabel}>Mengapa penting</span>
              {whyItMatters}
            </p>
          ) : null}
          {next ? (
            <p className={styles.ownerField} data-testid="task-detail-next">
              <span className={styles.ownerFieldLabel}>Berikutnya</span>
              {next}
            </p>
          ) : null}
          {blocker ? (
            <p className={styles.ownerField} data-testid="task-detail-blocker">
              <span className={styles.ownerFieldLabel}>Penghambat</span>
              {blocker}
            </p>
          ) : null}

          {isTechnical ? (
            <div className={styles.technicalExpanded} data-testid="task-detail-technical-panel">
              <p className={styles.technicalExpandedTitle}>Detail teknis</p>
              <TechnicalFields {...technicalProps} />
            </div>
          ) : (
            <details className={styles.technicalDisclosure} data-testid="task-detail-technical-disclosure">
              <summary>Detail teknis</summary>
              <div className={styles.technicalPanel}>
                <TechnicalFields {...technicalProps} />
              </div>
            </details>
          )}
        </div>
      ) : null}

      {pin ? (
        <footer className={styles.pinFooter} data-testid="task-detail-pin">
          pin {pin.canonicalSnapshotId} · rev {pin.boardRev}/{pin.lifecycleRev}
          {pin.stale ? ` · STALE ${pin.staleReason ?? ''}` : ''}
        </footer>
      ) : null}
    </section>
  )
}
