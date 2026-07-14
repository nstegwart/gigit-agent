/**
 * ART S09–S10 human-first task detail (prop-driven).
 * Owner humanDisplay primary; technical fields demoted to mode=technical.
 */
import type { TaskDetailViewModel } from '#/lib/control-center-route-adapters'

export type TaskDetailScreenProps = TaskDetailViewModel & {
  onRetry?: () => void
  className?: string
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
  const title =
    contentReviewRequired || !ownerPrimaryTitle
      ? ownerPrimaryTitle || 'Perlu tinjauan konten'
      : ownerPrimaryTitle

  return (
    <section
      className={className}
      data-testid="control-center-task-detail"
      data-surface-state={surfaceState}
      data-board-id={boardId}
      data-task-id={taskId}
      data-mode={mode}
      data-content-review-required={contentReviewRequired ? 'true' : 'false'}
    >
      <header style={{ marginBottom: 16 }}>
        <p style={{ fontSize: 12, color: 'var(--text-faint)', margin: 0 }}>Detail tugas</p>
        <h1 style={{ fontSize: 22, margin: '4px 0 8px' }} data-testid="task-detail-title">
          {surfaceState === 'zero-results' || surfaceState === 'error'
            ? 'Tugas tidak ditemukan'
            : title}
        </h1>
        <p style={{ margin: 0, color: 'var(--text-muted)' }} data-testid="task-detail-status">
          {statusSentence || (error ? error.message : '')}
        </p>
        <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
          <a href={workHref} data-testid="task-detail-back-work">
            ← Pekerjaan
          </a>
          {isTechnical ? (
            <a href={humanHref} data-testid="task-detail-mode-human">
              Mode pemilik
            </a>
          ) : (
            <a href={technicalHref} data-testid="task-detail-mode-technical">
              Mode teknis
            </a>
          )}
          {onRetry ? (
            <button type="button" onClick={onRetry} data-testid="task-detail-retry">
              Coba lagi
            </button>
          ) : null}
        </div>
      </header>

      {error && surfaceState !== 'populated' && surfaceState !== 'stale' ? (
        <div role="alert" data-testid="task-detail-error">
          {error.code}: {error.message}
        </div>
      ) : null}

      {surfaceState !== 'zero-results' && surfaceState !== 'error' && surfaceState !== 'forbidden' ? (
        <div data-testid="task-detail-body">
          {contentReviewRequired ? (
            <p data-testid="task-detail-review-badge" data-review-status={effectiveReviewStatus}>
              Konten perlu tinjauan ({effectiveReviewStatus})
            </p>
          ) : null}
          {ownerAction ? (
            <p data-testid="task-detail-owner-action">
              <strong>Tindakan:</strong> {ownerAction}
            </p>
          ) : null}
          {whyItMatters ? (
            <p data-testid="task-detail-why">
              <strong>Mengapa penting:</strong> {whyItMatters}
            </p>
          ) : null}
          {next ? (
            <p data-testid="task-detail-next">
              <strong>Berikutnya:</strong> {next}
            </p>
          ) : null}
          {blocker ? (
            <p data-testid="task-detail-blocker">
              <strong>Penghambat:</strong> {blocker}
            </p>
          ) : null}

          {isTechnical ? (
            <dl data-testid="task-detail-technical" style={{ marginTop: 20 }}>
              <dt>taskId</dt>
              <dd>
                <code>{taskId}</code>
              </dd>
              <dt>technicalTitle</dt>
              <dd>{technicalTitle}</dd>
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
          ) : null}
        </div>
      ) : null}

      {pin ? (
        <footer
          data-testid="task-detail-pin"
          style={{ marginTop: 24, fontSize: 12, color: 'var(--text-faint)' }}
        >
          pin {pin.canonicalSnapshotId} · rev {pin.boardRev}/{pin.lifecycleRev}
          {pin.stale ? ` · STALE ${pin.staleReason ?? ''}` : ''}
        </footer>
      ) : null}
    </section>
  )
}
