import { Icon } from '#/lib/icons'
import type { PrimaryBucket } from '#/lib/control-plane-types'
import {
  BUCKET_SEMANTICS,
  OVERLAY_LABELS,
  formatAgeSeconds,
  livenessLabel,
} from './labels'
import type { WorkItemRow } from './types'
import styles from './work.module.css'

const BADGE_CLASS: Record<(typeof BUCKET_SEMANTICS)[PrimaryBucket]['tone'], string> = {
  done: styles.badgeDone,
  recon: styles.badgeRecon,
  ongoing: styles.badgeOngoing,
  next: styles.badgeNext,
  queued: styles.badgeQueued,
  blocked: styles.badgeBlocked,
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
    <span
      className={`${styles.badge} ${BADGE_CLASS[sem.tone]}`}
      data-testid="work-row-bucket"
      data-bucket={bucket}
    >
      <Icon name={sem.icon} size={12} />
      <span>{sem.shortLabel}</span>
    </span>
  )
}

function OverlayBadges({ overlays }: { overlays: WorkItemRow['overlays'] }) {
  if (!overlays.length) return null
  return (
    <div className={styles.badgeStack} data-testid="work-row-overlays">
      {overlays.map((o) => (
        <span key={o} className={`${styles.badge} ${styles.badgeOverlay}`} data-overlay={o}>
          <Icon name="alert" size={11} />
          {OVERLAY_LABELS[o] ?? o}
        </span>
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
    r.age ?? (typeof r.ageSeconds === 'number' ? formatAgeSeconds(r.ageSeconds) : '')

  return (
    <dl className={styles.reconGrid} data-testid="work-row-reconciliation">
      {r.runId ? (
        <>
          <dt>Run</dt>
          <dd>{r.runId}</dd>
        </>
      ) : null}
      {r.claimId ? (
        <>
          <dt>Claim</dt>
          <dd>
            {r.claimId}
            {r.claimState ? ` (${r.claimState})` : ''}
          </dd>
        </>
      ) : null}
      {!r.claimId && r.claimState ? (
        <>
          <dt>Claim state</dt>
          <dd>{r.claimState}</dd>
        </>
      ) : null}
      {r.lockId ? (
        <>
          <dt>Lock</dt>
          <dd>
            {r.lockId}
            {r.lockOwner ? ` · ${r.lockOwner}` : ''}
          </dd>
        </>
      ) : null}
      {r.action ? (
        <>
          <dt>Action</dt>
          <dd>
            {r.action}
            {r.dryRun === true ? ' (dry-run)' : r.dryRun === false ? ' (live)' : ''}
          </dd>
        </>
      ) : null}
      {age ? (
        <>
          <dt>Age</dt>
          <dd>{age}</dd>
        </>
      ) : null}
      {r.ownerAgentId || r.ownerRole || r.ownerMaskedAccount ? (
        <>
          <dt>Owner</dt>
          <dd>
            {[r.ownerAgentId, r.ownerRole, r.ownerMaskedAccount].filter(Boolean).join(' · ')}
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
  const productive = live === 'PRODUCTIVE'
  const started =
    o.startedAge ??
    (typeof o.startedAgeSeconds === 'number' ? formatAgeSeconds(o.startedAgeSeconds) : '')
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
      {o.targetGate ? <span>Gate {o.targetGate}</span> : null}
      {o.agentId ? <span>Agent {o.agentId}</span> : null}
      {o.role ? <span>{o.role}</span> : null}
      {o.model || o.effort ? <span>{[o.model, o.effort].filter(Boolean).join(' / ')}</span> : null}
      {o.maskedAccount ? <span>Acct {o.maskedAccount}</span> : null}
      {started ? <span>Started {started}</span> : null}
      {heartbeat ? <span>HB {heartbeat}</span> : null}
      {material ? <span>Progress {material}</span> : null}
      {o.liveness ? (
        <span className={styles.liveness} data-liveness={live}>
          <span
            className={productive ? styles.livenessPulse : styles.livenessHollow}
            aria-hidden="true"
          />
          {livenessLabel(o.liveness)}
        </span>
      ) : null}
      {o.evidenceLink ? (
        <a
          href={o.evidenceLink}
          onClick={(e) => e.stopPropagation()}
          data-testid="work-row-evidence"
        >
          Evidence
        </a>
      ) : null}
    </div>
  )
}

function ReasonLine({ item }: { item: WorkItemRow }) {
  const parts: Array<string> = []
  if (item.blockReason) parts.push(item.blockReason)
  if (item.reason && item.reason !== item.blockReason) parts.push(item.reason)
  if (!parts.length) return null
  return (
    <div className={styles.reason} data-testid="work-row-reason">
      {parts.join(' · ')}
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

/**
 * Work list row. Displays server bucket/reason only — never classifies.
 * Completed rows remain DONE with reconciliation/stale/beyond-stage overlays.
 * Drilldown: prefers native <a href={detailHref}> for accessible navigation;
 * optional onActivate intercepts for SPA navigate while keeping href for
 * open-in-new-tab / crawlers / no-JS.
 */
export function WorkRow({ item, asCard = false, onActivate }: WorkRowProps) {
  const href = item.detailHref ?? undefined

  if (asCard) {
    // Card shell is a div (not <a>/<button>): may contain title + evidence links.
    // Native drilldown = title <a href={detailHref}>; shell click → onActivate SPA.
    return (
      <div
        className={styles.card}
        role="group"
        data-testid={`work-row-${item.taskId}`}
        data-task-id={item.taskId}
        data-bucket={item.bucket}
        data-detail-href={href ?? undefined}
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
          <div>
            {href ? (
              <a
                href={href}
                className={styles.taskTitle}
                data-testid={`work-row-link-${item.taskId}`}
                onClick={(e) => {
                  e.stopPropagation()
                  handleActivate(item, onActivate, e)
                }}
              >
                {item.title}
              </a>
            ) : (
              <div className={styles.taskTitle}>{item.title}</div>
            )}
            <div className={styles.taskId}>{item.taskId}</div>
          </div>
          <BucketBadge bucket={item.bucket} />
        </div>
        <OverlayBadges overlays={item.overlays} />
        <ReasonLine item={item} />
        <ReconciliationBlock item={item} />
        <OngoingBlock item={item} />
        <div className={styles.ongoingMeta}>
          {item.lifecycleStage ? <span>{item.lifecycleStage}</span> : null}
          {item.projectId ? <span>{item.projectId}</span> : null}
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
        {href ? (
          <a
            href={href}
            className={styles.taskTitle}
            data-testid={`work-row-link-${item.taskId}`}
            onClick={(e) => {
              e.stopPropagation()
              handleActivate(item, onActivate, e)
            }}
          >
            {item.title}
          </a>
        ) : (
          <div className={styles.taskTitle}>{item.title}</div>
        )}
        <div className={styles.taskId}>{item.taskId}</div>
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
        {item.lifecycleStage ?? '—'}
        {item.projectId ? (
          <>
            <br />
            {item.projectId}
          </>
        ) : null}
      </td>
      <td className={styles.reason}>
        {item.readinessDisplay != null && item.readinessDisplay !== ''
          ? String(item.readinessDisplay)
          : '—'}
      </td>
    </tr>
  )
}
