import {
  Badge,
  Disclosure,
  StatusChip,
  type StatusChipVariant,
} from '#/components/ui'
import { formatLifecycleStageLabel } from '#/lib/display-label'
import type { PrimaryBucket } from '#/lib/control-plane-types'
import {
  BUCKET_SEMANTICS,
  OVERLAY_LABELS,
  formatAgeSeconds,
  livenessLabel,
} from './labels'
import type { WorkItemRow } from './types'
import styles from './work.module.css'
import { resolveOwnerDisplay } from './ownerDisplay'
import { OwnerHumanFields } from './OwnerHumanFields'

const TONE_TO_CHIP: Record<
  (typeof BUCKET_SEMANTICS)[PrimaryBucket]['tone'],
  StatusChipVariant
> = {
  done: 'done',
  recon: 'warn',
  ongoing: 'ongoing',
  next: 'next',
  queued: 'pending',
  blocked: 'blocked',
}

export interface WorkRowProps {
  item: WorkItemRow
  /** When true, render as interactive card surface (mobile reflow). */
  asCard?: boolean
  onActivate?: (item: WorkItemRow) => void
}

function BucketBadge({ bucket }: { bucket: PrimaryBucket }) {
  const sem = BUCKET_SEMANTICS[bucket]
  return (
    <StatusChip
      variant={TONE_TO_CHIP[sem.tone]}
      data-testid="work-row-bucket"
      data-bucket={bucket}
    >
      {sem.shortLabel}
    </StatusChip>
  )
}

function OverlayBadges({ overlays }: { overlays: WorkItemRow['overlays'] }) {
  if (!overlays.length) return null
  return (
    <div className={styles.badgeStack} data-testid="work-row-overlays">
      {overlays.map((o) => (
        <Badge key={o} variant="neutral" data-overlay={o}>
          {OVERLAY_LABELS[o]}
        </Badge>
      ))}
    </div>
  )
}

function ReconciliationBlock({ item }: { item: WorkItemRow }) {
  const r = item.reconciliation
  const show =
    item.bucket === 'RECONCILIATION_PENDING' ||
    (r &&
      (item.overlays.includes('RECONCILIATION_DRILLDOWN') ||
        item.overlays.includes('STALE_CLAIM') ||
        item.overlays.includes('BEYOND_STAGE_ONGOING')))
  if (!show || !r) return null

  const age =
    r.age ??
    (typeof r.ageSeconds === 'number' ? formatAgeSeconds(r.ageSeconds) : '')

  return (
    <dl className={styles.reconGrid} data-testid="work-row-reconciliation">
      {r.runId ? (
        <>
          <dt>Proses</dt>
          <dd>{r.runId}</dd>
        </>
      ) : null}
      {r.claimId ? (
        <>
          <dt>Klaim</dt>
          <dd>
            {r.claimId}
            {r.claimState ? ` (${r.claimState})` : ''}
          </dd>
        </>
      ) : null}
      {!r.claimId && r.claimState ? (
        <>
          <dt>Status klaim</dt>
          <dd>{r.claimState}</dd>
        </>
      ) : null}
      {r.lockId ? (
        <>
          <dt>Kunci</dt>
          <dd>
            {r.lockId}
            {r.lockOwner ? ` · ${r.lockOwner}` : ''}
          </dd>
        </>
      ) : null}
      {r.action ? (
        <>
          <dt>Tindakan</dt>
          <dd>
            {r.action}
            {r.dryRun === true
              ? ' (simulasi)'
              : r.dryRun === false
                ? ' (aktif)'
                : ''}
          </dd>
        </>
      ) : null}
      {age ? (
        <>
          <dt>Usia</dt>
          <dd>{age}</dd>
        </>
      ) : null}
      {r.ownerAgentId || r.ownerRole || r.ownerMaskedAccount ? (
        <>
          <dt>Pemilik</dt>
          <dd>
            {[r.ownerAgentId, r.ownerRole, r.ownerMaskedAccount]
              .filter(Boolean)
              .join(' · ')}
          </dd>
        </>
      ) : null}
    </dl>
  )
}

function OngoingBlock({ item }: { item: WorkItemRow }) {
  const o = item.ongoing
  if (!o || item.bucket !== 'ONGOING') return null
  const live = String(o.liveness ?? '').toUpperCase()
  const liveVariant: StatusChipVariant =
    live === 'PRODUCTIVE'
      ? 'done'
      : live === 'STALLED' || live === 'EXPIRED'
        ? 'blocked'
        : 'pending'
  const started =
    o.startedAge ??
    (typeof o.startedAgeSeconds === 'number'
      ? formatAgeSeconds(o.startedAgeSeconds)
      : '')
  const heartbeat =
    o.heartbeatAge ??
    (typeof o.heartbeatAgeSeconds === 'number'
      ? formatAgeSeconds(o.heartbeatAgeSeconds)
      : '')
  const material =
    o.materialProgressAge ??
    (typeof o.materialProgressAgeSeconds === 'number'
      ? formatAgeSeconds(o.materialProgressAgeSeconds)
      : '')

  return (
    <div className={styles.ongoingMeta} data-testid="work-row-ongoing">
      {o.targetGate ? <span>Target tahap {o.targetGate}</span> : null}
      {o.role ? <span>Peran {o.role}</span> : null}
      {o.agentId ? <span className={styles.mono}>{o.agentId}</span> : null}
      {started ? <span>Dimulai {started}</span> : null}
      {heartbeat ? <span>Aktivitas terakhir {heartbeat}</span> : null}
      {material ? <span>Progres material {material}</span> : null}
      {o.liveness ? (
        <StatusChip variant={liveVariant} data-liveness={live}>
          {livenessLabel(o.liveness)}
        </StatusChip>
      ) : null}
      {o.evidenceLink ? (
        <a
          href={o.evidenceLink}
          onClick={(e) => e.stopPropagation()}
          data-testid="work-row-evidence"
        >
          Bukti
        </a>
      ) : null}
      {o.agentId || o.model || o.effort || o.maskedAccount ? (
        <Disclosure summary="Detail eksekusi">
          <span className={styles.mono}>
            {[o.agentId, o.model, o.effort, o.maskedAccount]
              .filter(Boolean)
              .join(' · ')}
          </span>
        </Disclosure>
      ) : null}
    </div>
  )
}

/**
 * Surface-level reason only when it looks owner-actionable (not pure integrity codes).
 * DATA_INTEGRITY / MISSING_DISPLAY / hash-like tokens stay under "Detail teknis".
 */
function ReasonLine({ item }: { item: WorkItemRow }) {
  const parts: Array<string> = []
  if (item.blockReason) parts.push(item.blockReason)
  if (item.reason && item.reason !== item.blockReason) parts.push(item.reason)
  if (!parts.length) return null
  const joined = parts.join(' · ')
  const technicalNoise =
    /^(DATA_INTEGRITY|MISSING_DISPLAY|CONTENT_REVIEW_REQUIRED|STALE_|UNCLASSIFIED)/i.test(
      joined,
    ) || /DATA_INTEGRITY|MISSING_DISPLAY/.test(joined)
  if (technicalNoise) return null
  return (
    <div className={styles.reason} data-testid="work-row-reason">
      {joined}
    </div>
  )
}

function ownerDisplayFor(item: WorkItemRow) {
  return resolveOwnerDisplay({
    technicalTitle: item.title,
    taskId: item.taskId,
    ownerPrimaryTitle: item.ownerPrimaryTitle,
    statusSentence: item.statusSentence,
    ownerAction: item.ownerAction,
    whyItMatters: item.whyItMatters,
    next: item.next,
    blocker: item.blocker,
    contentReviewRequired: item.contentReviewRequired,
    effectiveReviewStatus: item.effectiveReviewStatus,
    citations: item.citations,
    ownerHumanDisplay: item.ownerHumanDisplay,
  })
}

function TitleBlock({
  item,
  href,
  onActivate,
}: {
  item: WorkItemRow
  href?: string
  onActivate?: WorkRowProps['onActivate']
}) {
  const display = ownerDisplayFor(item)
  const titleClass = styles.taskTitle
  const titleNode = href ? (
    <a
      href={href}
      className={titleClass}
      data-testid={`work-row-link-${item.taskId}`}
      data-field="ownerPrimaryTitle"
      onClick={(e) => {
        e.stopPropagation()
        handleActivate(item, onActivate, e)
      }}
    >
      {display.primaryTitle}
    </a>
  ) : (
    <div
      className={titleClass}
      data-testid="work-row-owner-title"
      data-field="ownerPrimaryTitle"
    >
      {display.primaryTitle}
    </div>
  )

  return (
    <div
      className={styles.titleBlock}
      data-testid="work-row-title-block"
      data-content-review-required={
        display.contentReviewRequired ? 'true' : 'false'
      }
      data-owner-primary-title={display.primaryTitle}
      data-used-technical-fallback={
        display.usedTechnicalFallback ? 'true' : 'false'
      }
    >
      {titleNode}
      <div
        className={styles.taskId}
        data-testid="work-row-task-id"
        data-field="taskId"
        title={item.taskId}
      >
        {item.taskId}
      </div>
      <OwnerHumanFields display={display} testIdPrefix="work-row" />
      <Disclosure summary="Detail teknis">
        {display.technicalTitle &&
        display.technicalTitle !== display.primaryTitle ? (
          <div
            className={styles.technicalSecondary}
            data-testid="work-row-technical-title"
            data-field="technicalTitle"
            title={display.technicalTitle}
          >
            {display.technicalTitle}
          </div>
        ) : (
          <p className={styles.reason}>Tidak ada judul teknis terpisah.</p>
        )}
      </Disclosure>
    </div>
  )
}

/**
 * SPA onActivate on primary click only. Modifier / non-primary clicks keep
 * native <a href={detailHref}> (open-in-new-tab, middle-click).
 */
function handleActivate(
  item: WorkItemRow,
  onActivate: WorkRowProps['onActivate'],
  e?: {
    preventDefault: () => void
    metaKey?: boolean
    ctrlKey?: boolean
    shiftKey?: boolean
    altKey?: boolean
    button?: number
  },
) {
  if (!onActivate) return
  if (e?.metaKey || e?.ctrlKey || e?.shiftKey || e?.altKey) return
  if (typeof e?.button === 'number' && e.button !== 0) return
  e?.preventDefault()
  onActivate(item)
}

function StageProjectReadiness({ item }: { item: WorkItemRow }) {
  return (
    <>
      {item.lifecycleStage ? (
        <StatusChip
          variant="pending"
          showDot={false}
          data-testid="work-row-stage"
          data-stage={item.lifecycleStage}
          title={item.lifecycleStage}
        >
          {formatLifecycleStageLabel(item.lifecycleStage)}
        </StatusChip>
      ) : (
        '—'
      )}
      {item.projectId ? (
        <>
          <br />
          <span className={styles.mono}>{item.projectId}</span>
        </>
      ) : null}
    </>
  )
}

/**
 * Work list row. Displays server bucket/reason only — never classifies.
 * Owner primary title from humanDisplay; never raw technical title as primary.
 * Completed rows remain DONE with reconciliation/stale/beyond-stage overlays.
 */
export function WorkRow({ item, asCard = false, onActivate }: WorkRowProps) {
  const href = item.detailHref ?? undefined
  const display = ownerDisplayFor(item)

  if (asCard) {
    return (
      <div
        className={styles.card}
        role="group"
        data-testid={`work-row-${item.taskId}`}
        data-task-id={item.taskId}
        data-bucket={item.bucket}
        data-detail-href={href ?? undefined}
        data-content-review-required={
          display.contentReviewRequired ? 'true' : 'false'
        }
        tabIndex={0}
        onClick={(e) => {
          if ((e.target as HTMLElement).closest('a')) return
          onActivate?.(item)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            onActivate?.(item)
          }
        }}
      >
        <div className={styles.cardHeader}>
          <TitleBlock item={item} href={href} onActivate={onActivate} />
          <BucketBadge bucket={item.bucket} />
        </div>
        <OverlayBadges overlays={item.overlays} />
        <ReasonLine item={item} />
        <ReconciliationBlock item={item} />
        <OngoingBlock item={item} />
        <div className={styles.ongoingMeta}>
          {item.lifecycleStage ? (
            <StatusChip
              variant="pending"
              showDot={false}
              data-testid="work-row-stage"
              data-stage={item.lifecycleStage}
              title={item.lifecycleStage}
            >
              {formatLifecycleStageLabel(item.lifecycleStage)}
            </StatusChip>
          ) : null}
          {item.projectId ? (
            <span className={styles.mono}>{item.projectId}</span>
          ) : null}
          {item.readinessDisplay != null && item.readinessDisplay !== '' ? (
            <span>{String(item.readinessDisplay)}</span>
          ) : null}
        </div>
      </div>
    )
  }

  return (
    <tr
      data-testid={`work-row-${item.taskId}`}
      data-task-id={item.taskId}
      data-bucket={item.bucket}
      data-detail-href={href ?? undefined}
      data-content-review-required={
        display.contentReviewRequired ? 'true' : 'false'
      }
      tabIndex={0}
      onClick={() => handleActivate(item, onActivate)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          if (onActivate) {
            onActivate(item)
          } else if (href) {
            window.location.assign(href)
          }
        }
      }}
    >
      <td>
        <TitleBlock item={item} href={href} onActivate={onActivate} />
        <ReasonLine item={item} />
        <ReconciliationBlock item={item} />
        <OngoingBlock item={item} />
      </td>
      <td>
        <div className={styles.badgeStack}>
          <BucketBadge bucket={item.bucket} />
          <OverlayBadges overlays={item.overlays} />
        </div>
      </td>
      <td className={styles.reason}>
        <StageProjectReadiness item={item} />
      </td>
      <td className={styles.reason}>
        {item.readinessDisplay != null && item.readinessDisplay !== ''
          ? String(item.readinessDisplay)
          : '—'}
      </td>
    </tr>
  )
}

/** Cell builders for kit Table composition (WorkList). */
export function workRowTitleCell(
  item: WorkItemRow,
  onActivate?: WorkRowProps['onActivate'],
) {
  const href = item.detailHref ?? undefined
  const display = ownerDisplayFor(item)
  return (
    <div
      className={styles.rowShell}
      data-testid={`work-row-${item.taskId}`}
      data-task-id={item.taskId}
      data-bucket={item.bucket}
      data-detail-href={href ?? undefined}
      data-content-review-required={
        display.contentReviewRequired ? 'true' : 'false'
      }
      tabIndex={0}
      role="button"
      onClick={() => handleActivate(item, onActivate)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          handleActivate(item, onActivate)
        }
      }}
    >
      <TitleBlock item={item} href={href} onActivate={onActivate} />
      <ReasonLine item={item} />
      <ReconciliationBlock item={item} />
      <OngoingBlock item={item} />
    </div>
  )
}

export function workRowStatusCell(item: WorkItemRow) {
  return (
    <div className={styles.badgeStack}>
      <BucketBadge bucket={item.bucket} />
      <OverlayBadges overlays={item.overlays} />
    </div>
  )
}

export function workRowStageCell(item: WorkItemRow) {
  return (
    <div className={styles.reason}>
      <StageProjectReadiness item={item} />
    </div>
  )
}

export function workRowReadinessCell(item: WorkItemRow) {
  return (
    <span className={styles.mono}>
      {item.readinessDisplay != null && item.readinessDisplay !== ''
        ? String(item.readinessDisplay)
        : '—'}
    </span>
  )
}
