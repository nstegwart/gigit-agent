/**
 * ART S09–S10 human-first task detail (prop-driven) — Direction B.
 * Owner humanDisplay primary; technical fields in Disclosure "Detail teknis".
 * Never invents humanDisplay copy — only displays projected props.
 * W-UI-3: Lineage Rebuild panel after main owner summary.
 */
import type { TaskDetailViewModel } from '#/lib/control-center-route-adapters'
import type { TaskLineageData } from '#/server/control-center-rebuild-fns'
import {
  Badge,
  Breadcrumb,
  Button,
  Card,
  Disclosure,
  EmptyState,
  PageHeader,
  StatusChip,
  type StatusChipVariant,
} from '#/components/ui'
import { LineagePanel, type LineagePanelSurface } from './LineagePanel'
import styles from './task-detail.module.css'

export type TaskDetailScreenProps = TaskDetailViewModel & {
  onRetry?: () => void
  className?: string
  /** W-UI-3 lineage payload (null while loading / not yet fetched). */
  lineage?: TaskLineageData | null
  lineageSurface?: LineagePanelSurface
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
        <code className={styles.mono}>{taskId}</code>
      </dd>
      <dt>technicalTitle</dt>
      <dd>{technicalTitle || '—'}</dd>
      <dt>bucket</dt>
      <dd>{bucket ?? '—'}</dd>
      <dt>overlays</dt>
      <dd>{overlays.length ? overlays.join(', ') : '—'}</dd>
      <dt>projectId</dt>
      <dd>
        {projectId ? <code className={styles.mono}>{projectId}</code> : '—'}
      </dd>
      <dt>featureId</dt>
      <dd>
        {featureId ? <code className={styles.mono}>{featureId}</code> : '—'}
      </dd>
      <dt>lifecycleStage</dt>
      <dd>
        {lifecycleStage ? (
          <code className={styles.mono}>{lifecycleStage}</code>
        ) : (
          '—'
        )}
      </dd>
      <dt>targetGate</dt>
      <dd>
        {targetGate ? <code className={styles.mono}>{targetGate}</code> : '—'}
      </dd>
      <dt>claimState</dt>
      <dd>{claimState ?? '—'}</dd>
      <dt>blockReason</dt>
      <dd>{blockReason ?? '—'}</dd>
    </dl>
  )
}

function claimVariant(claimState: string | null): StatusChipVariant {
  if (!claimState) return 'pending'
  const s = claimState.toUpperCase()
  if (/BLOCK|FAIL|HOLD/.test(s)) return 'blocked'
  if (/CLAIM|RUN|ACTIVE|BUSY/.test(s)) return 'ongoing'
  if (/DONE|FREE|IDLE|RELEASE/.test(s)) return 'done'
  if (/WARN|STALE/.test(s)) return 'warn'
  return 'pending'
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
  lineage = null,
  lineageSurface,
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

  const actions = (
    <div className={styles.actions}>
      <a href={workHref} className={styles.linkBtn} data-testid="task-detail-back-work">
        ← Pekerjaan
      </a>
      {isTechnical ? (
        <a href={humanHref} className={styles.linkGhost} data-testid="task-detail-mode-human">
          Mode pemilik
        </a>
      ) : (
        <a
          href={technicalHref}
          className={styles.linkGhost}
          data-testid="task-detail-mode-technical"
        >
          Mode teknis
        </a>
      )}
      {onRetry ? (
        <Button
          type="button"
          variant="primary"
          size="sm"
          onClick={onRetry}
          data-testid="task-detail-retry"
        >
          Coba lagi
        </Button>
      ) : null}
    </div>
  )

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
      <PageHeader
        eyebrow="Detail tugas"
        title={
          <span data-testid="task-detail-title">
            {missing ? 'Tugas tidak ditemukan' : title}
          </span>
        }
        subtitle={
          <span data-testid="task-detail-status" className={styles.statusSentence}>
            {statusSentence || (error ? error.message : '')}
          </span>
        }
        breadcrumb={
          <Breadcrumb
            items={[
              { label: 'Pekerjaan', href: workHref },
              { label: missing ? taskId : title },
            ]}
          />
        }
        actions={actions}
      />

      {error && surfaceState !== 'populated' && surfaceState !== 'stale' ? (
        <div className={styles.errorBanner} role="alert" data-testid="task-detail-error">
          <StatusChip variant="blocked" showDot>
            {error.code}
          </StatusChip>
          <span>{error.message}</span>
        </div>
      ) : null}

      {missing ? (
        <EmptyState
          title="Tugas tidak ditemukan"
          description={
            error?.message ||
            'Entitas ini tidak tersedia pada pin board saat ini, atau akses ditolak.'
          }
          action={
            onRetry ? (
              <Button type="button" variant="primary" size="sm" onClick={onRetry}>
                Coba lagi
              </Button>
            ) : undefined
          }
        />
      ) : (
        <div className={styles.body} data-testid="task-detail-body">
          <div className={styles.badgeRow}>
            {contentReviewRequired ? (
              <span data-testid="task-detail-review-badge" data-review-status={effectiveReviewStatus}>
                <StatusChip variant="warn" showDot>
                  Perlu tinjauan konten
                </StatusChip>
              </span>
            ) : null}
            {claimState ? (
              <StatusChip variant={claimVariant(claimState)} showDot>
                {claimState}
              </StatusChip>
            ) : null}
            {lifecycleStage ? (
              <Badge mono variant="neutral" title={lifecycleStage}>
                {lifecycleStage}
              </Badge>
            ) : null}
            {targetGate ? (
              <Badge mono variant="brand" title={targetGate}>
                → {targetGate}
              </Badge>
            ) : null}
          </div>

          {ownerAction ? (
            <Card title="Tindakan" data-testid="task-detail-owner-action">
              <p className={styles.ownerActionBody}>{ownerAction}</p>
            </Card>
          ) : null}

          {(whyItMatters || next || blocker) && (
            <Card title="Ringkasan pemilik">
              {whyItMatters ? (
                <div className={styles.ownerField} data-testid="task-detail-why">
                  <span className={styles.ownerFieldLabel}>Mengapa penting</span>
                  {whyItMatters}
                </div>
              ) : null}
              {next ? (
                <div className={styles.ownerField} data-testid="task-detail-next">
                  <span className={styles.ownerFieldLabel}>Berikutnya</span>
                  {next}
                </div>
              ) : null}
              {blocker ? (
                <div className={styles.ownerField} data-testid="task-detail-blocker">
                  <span className={styles.ownerFieldLabel}>Penghambat</span>
                  <StatusChip variant="blocked" showDot>
                    {blocker}
                  </StatusChip>
                </div>
              ) : null}
            </Card>
          )}

          {/* W-UI-3: Lineage Rebuild after main summary, before technical disclosure */}
          <LineagePanel data={lineage} surfaceState={lineageSurface} />

          {isTechnical ? (
            <Card
              title="Detail teknis"
              data-testid="task-detail-technical-panel"
            >
              <TechnicalFields {...technicalProps} />
            </Card>
          ) : (
            <Disclosure
              summary="Detail teknis"
              data-testid="task-detail-technical-disclosure"
            >
              <TechnicalFields {...technicalProps} />
            </Disclosure>
          )}
        </div>
      )}

      {pin ? (
        <footer className={styles.pinFooter} data-testid="task-detail-pin">
          <Disclosure summary="Pin & revisi board">
            <dl className={styles.technicalGrid}>
              <dt>canonicalSnapshotId</dt>
              <dd>
                <code className={styles.mono}>{pin.canonicalSnapshotId}</code>
              </dd>
              <dt>boardRev / lifecycleRev</dt>
              <dd className={styles.mono}>
                {pin.boardRev}/{pin.lifecycleRev}
              </dd>
              {pin.stale ? (
                <>
                  <dt>stale</dt>
                  <dd>
                    <StatusChip variant="warn" showDot>
                      STALE {pin.staleReason ?? ''}
                    </StatusChip>
                  </dd>
                </>
              ) : null}
            </dl>
          </Disclosure>
        </footer>
      ) : null}
    </section>
  )
}
