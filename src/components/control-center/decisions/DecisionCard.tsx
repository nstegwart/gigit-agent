import {
  actionLabel,
  CONTENT_REVIEW_CHIP_LABEL,
  decisionActionAvailability,
  decisionMutationRevs,
  defaultSnoozedUntil,
  isExpiredDecisionStatus,
  resolveDecisionOwnerDisplay,
} from './decisionActions'
import type {
  DecisionActionError,
  DecisionActionHandlers,
  DecisionActionKind,
  DecisionItemView,
  DecisionSeverity,
  DecisionsPinView,
} from './types'
import styles from './decisions.module.css'

/** Existing board-scoped detail routes only — never invent private paths. */
function projectHref(boardId: string, projectId: string): string {
  return `/b/${encodeURIComponent(boardId)}/projects/${encodeURIComponent(projectId)}`
}
function featureHref(boardId: string, featureId: string): string {
  return `/b/${encodeURIComponent(boardId)}/features/${encodeURIComponent(featureId)}`
}
function taskHref(boardId: string, taskId: string): string {
  return `/b/${encodeURIComponent(boardId)}/tasks/${encodeURIComponent(taskId)}`
}
function agentsHref(boardId: string): string {
  return `/b/${encodeURIComponent(boardId)}/agents`
}

function severityClass(sev: DecisionSeverity): string {
  if (sev === 'CRITICAL' || sev === 'HIGH') return styles.sevCritical
  if (sev === 'MEDIUM') return styles.sevMedium
  return styles.sevLow
}

function statusClass(status: string): string {
  const s = status.toUpperCase()
  if (s === 'OPEN') return styles.statusOpen
  if (s === 'ACKNOWLEDGED') return styles.statusAck
  if (s === 'RESOLVED') return styles.statusResolved
  if (s === 'REJECTED' || s === 'EXPIRED' || s === 'CANCELLED') {
    return styles.statusRejected
  }
  return styles.statusAck
}

function severityIcon(sev: DecisionSeverity): string {
  if (sev === 'CRITICAL' || sev === 'HIGH') return '!'
  if (sev === 'MEDIUM') return '•'
  return '·'
}

function displayOrDash(v: string | number | null | undefined): string {
  if (v === null || v === undefined || v === '') return '—'
  const s = String(v).trim()
  // Epoch / zero timestamps are projection holes, not real times.
  if (
    s === '0' ||
    s === '1970-01-01T00:00:00.000Z' ||
    s === '1970-01-01T00:00:00Z' ||
    s.startsWith('1970-01-01')
  ) {
    return '—'
  }
  const t = Date.parse(s)
  if (Number.isFinite(t) && t <= 0) return '—'
  return s
}

export function DecisionCard({
  item,
  boardId,
  pin,
  canAct = true,
  pending = false,
  pendingAction = null,
  actionError = null,
  actions,
}: {
  item: DecisionItemView
  /** Required for entity deep links to existing project/feature/task/agents routes. */
  boardId: string
  pin?: DecisionsPinView | null
  canAct?: boolean
  pending?: boolean
  pendingAction?: DecisionActionKind | null
  actionError?: DecisionActionError | null
  actions?: DecisionActionHandlers
}) {
  const qId = `dec-q-${item.decisionId}`
  const optId = `dec-opt-${item.decisionId}`
  const evId = `dec-ev-${item.decisionId}`
  const recId = `dec-rec-${item.decisionId}`
  const errId = `dec-err-${item.decisionId}`
  const actErrId = `dec-act-err-${item.decisionId}`
  const owner = resolveDecisionOwnerDisplay(item)
  const avail = decisionActionAvailability(item, { canAct })
  const revs = decisionMutationRevs(item, pin?.boardRev)
  const expired = isExpiredDecisionStatus(item.status)
  const questionRaw = item.question?.trim() ?? ''
  const questionIsDup =
    !questionRaw ||
    questionRaw === item.title?.trim() ||
    questionRaw === item.decisionId ||
    questionRaw === owner.technicalTitle

  const selectedDeclining =
    item.selectedOptionId &&
    item.options.some((o) => o.optionId === item.selectedOptionId && o.declining)

  const busy = pending
  const missingRevs = revs == null && (avail.canResolve || avail.canAcknowledge || avail.canReject || avail.canSnooze)

  function basePayload() {
    if (!revs) {
      throw new Error('CAS revs unavailable')
    }
    return {
      boardId,
      decisionId: item.decisionId,
      expectedRev: revs.expectedRev,
      expectedBoardRev: revs.expectedBoardRev,
    }
  }

  async function run(fn: (() => void | Promise<void>) | undefined) {
    if (!fn || busy) return
    await fn()
  }

  return (
    <article
      className={`${styles.card}${item.blocking ? ` ${styles.cardBlocking}` : ''}${
        expired ? ` ${styles.cardExpired}` : ''
      }`}
      data-testid="decision-card"
      data-decision-id={item.decisionId}
      data-blocking={item.blocking ? 'true' : 'false'}
      data-severity={item.severity}
      data-status={item.status}
      data-partial={item.partialFields ? 'true' : 'false'}
      data-content-review-required={owner.contentReviewRequired ? 'true' : 'false'}
      data-effective-review-status={owner.effectiveReviewStatus}
      data-selected-option={item.selectedOptionId ?? undefined}
      data-selected-declining={selectedDeclining ? 'true' : 'false'}
      data-pending={busy ? 'true' : 'false'}
      data-pending-action={busy && pendingAction ? pendingAction : undefined}
      aria-labelledby={`dec-title-${item.decisionId}`}
      aria-busy={busy || undefined}
    >
      <div className={styles.cardHead}>
        <span className={`${styles.chip} ${severityClass(item.severity)}`}>
          <span aria-hidden="true">{severityIcon(item.severity)}</span>
          {item.severity}
        </span>
        <span className={`${styles.chip} ${statusClass(item.status)}`}>
          <span aria-hidden="true">●</span>
          {item.status}
        </span>
        {item.blocking ? (
          <span className={`${styles.chip} ${styles.blockingBadge}`}>
            <span aria-hidden="true">⛔</span>
            Blocking
          </span>
        ) : null}
        {owner.contentReviewRequired ? (
          <span
            className={`${styles.chip} ${styles.contentReviewBadge}`}
            data-testid="decision-content-review"
            role="status"
            title={owner.effectiveReviewStatus}
          >
            {CONTENT_REVIEW_CHIP_LABEL}
          </span>
        ) : null}
        {item.status === 'REJECTED' ? (
          <span className={`${styles.chip} ${styles.statusRejected}`} data-testid="decision-rejected-badge">
            Rejected (not declined option)
          </span>
        ) : null}
        {item.status === 'RESOLVED' && selectedDeclining ? (
          <span className={`${styles.chip} ${styles.statusResolved}`} data-testid="decision-declined-badge">
            Declined option (RESOLVED)
          </span>
        ) : null}
        {expired ? (
          <span className={`${styles.chip} ${styles.statusRejected}`} data-testid="decision-expired-badge">
            Expired
          </span>
        ) : null}
        <span className={styles.decisionId} title={item.decisionId}>
          {item.decisionId}
        </span>
      </div>

      <h3 id={`dec-title-${item.decisionId}`} className={styles.title} data-testid="decision-owner-title">
        {owner.primaryTitle}
      </h3>

      {owner.statusSentence ? (
        <p className={styles.statusSentence} data-testid="decision-status-sentence">
          {owner.statusSentence}
        </p>
      ) : null}

      {owner.ownerAction ? (
        <p className={styles.ownerActionLine} data-testid="decision-owner-action-copy">
          <span className={styles.fieldLabel}>Owner action</span>
          <span className={styles.fieldValue}>{owner.ownerAction}</span>
        </p>
      ) : null}

      {(owner.whyItMatters || owner.next || owner.blocker) && (
        <dl className={styles.hdGrid} data-testid="decision-human-display">
          {owner.whyItMatters ? (
            <div className={styles.metaCell}>
              <dt>Why it matters</dt>
              <dd data-testid="decision-why">{owner.whyItMatters}</dd>
            </div>
          ) : null}
          {owner.next ? (
            <div className={styles.metaCell}>
              <dt>Next</dt>
              <dd data-testid="decision-next">{owner.next}</dd>
            </div>
          ) : null}
          {owner.blocker ? (
            <div className={styles.metaCell}>
              <dt>Blocker</dt>
              <dd data-testid="decision-blocker">{owner.blocker}</dd>
            </div>
          ) : null}
        </dl>
      )}

      {owner.contentReviewRequired &&
      owner.technicalTitle &&
      owner.technicalTitle !== owner.primaryTitle ? (
        <details className={styles.diagDetails} data-testid="decision-technical-title">
          <summary>Detail teknis</summary>
          <p className={styles.technicalTitleNote}>
            Judul teknis: {owner.technicalTitle}
          </p>
          <p className={styles.technicalTitleNote}>
            Status peninjauan: {owner.effectiveReviewStatus}
          </p>
        </details>
      ) : null}

      <div className={styles.field}>
        <span className={styles.fieldLabel} id={qId}>
          Question
        </span>
        {questionIsDup ? (
          <p
            className={`${styles.fieldValue} ${styles.fieldPartial}`}
            aria-labelledby={qId}
            data-testid="decision-question-partial"
          >
            Question not projected by server envelope.
          </p>
        ) : (
          <p className={styles.fieldValue} aria-labelledby={qId} data-testid="decision-question">
            {questionRaw}
          </p>
        )}
      </div>

      <dl className={styles.metaGrid}>
        <div className={styles.metaCell}>
          <dt>Due</dt>
          <dd data-testid="decision-due">{displayOrDash(item.dueAt)}</dd>
        </div>
        <div className={styles.metaCell}>
          <dt>Created</dt>
          <dd data-testid="decision-created">{displayOrDash(item.createdAt)}</dd>
        </div>
        <div className={styles.metaCell}>
          <dt>Type</dt>
          <dd>{displayOrDash(item.type)}</dd>
        </div>
        <div className={styles.metaCell}>
          <dt>Snooze</dt>
          <dd data-testid="decision-snooze">
            {item.blocking
              ? 'Cannot hide (blocking)'
              : item.snoozedUntil
                ? item.snoozedUntil
                : '—'}
          </dd>
        </div>
        <div className={styles.metaCell}>
          <dt>Owner</dt>
          <dd data-testid="decision-owner">{displayOrDash(item.ownerId)}</dd>
        </div>
        <div className={styles.metaCell}>
          <dt>Resolver</dt>
          <dd data-testid="decision-resolver">{displayOrDash(item.resolverId)}</dd>
        </div>
        <div className={styles.metaCell}>
          <dt>entityRev</dt>
          <dd data-testid="decision-entity-rev">{displayOrDash(item.entityRev)}</dd>
        </div>
        <div className={styles.metaCell}>
          <dt>boardRev</dt>
          <dd data-testid="decision-board-rev">{displayOrDash(item.boardRev)}</dd>
        </div>
        <div className={styles.metaCell}>
          <dt>expectedRev</dt>
          <dd data-testid="decision-expected-rev">{displayOrDash(item.expectedRev)}</dd>
        </div>
        <div className={styles.metaCell}>
          <dt>Approval</dt>
          <dd data-testid="decision-approval">{displayOrDash(item.scopedApprovalId)}</dd>
        </div>
        <div className={styles.metaCell}>
          <dt>Audit</dt>
          <dd data-testid="decision-audit">
            {item.auditIds && item.auditIds.length > 0 ? item.auditIds.join(', ') : '—'}
          </dd>
        </div>
        <div className={styles.metaCell}>
          <dt>Selected option</dt>
          <dd data-testid="decision-selected-option">
            {displayOrDash(item.selectedOptionId)}
          </dd>
        </div>
        <div className={styles.metaCell}>
          <dt>Project</dt>
          <dd data-testid="decision-project">
            {item.projectId ? (
              <a
                href={projectHref(boardId, item.projectId)}
                data-testid="decision-project-link"
              >
                {item.projectId}
              </a>
            ) : (
              '—'
            )}
          </dd>
        </div>
        <div className={styles.metaCell}>
          <dt>Feature</dt>
          <dd data-testid="decision-feature">
            {item.featureId ? (
              <a
                href={featureHref(boardId, item.featureId)}
                data-testid="decision-feature-link"
              >
                {item.featureId}
              </a>
            ) : (
              '—'
            )}
          </dd>
        </div>
        <div className={styles.metaCell}>
          <dt>Task</dt>
          <dd data-testid="decision-task">
            {item.taskId ? (
              <a href={taskHref(boardId, item.taskId)} data-testid="decision-task-link">
                {item.taskId}
              </a>
            ) : (
              '—'
            )}
          </dd>
        </div>
        <div className={styles.metaCell}>
          <dt>Run</dt>
          <dd data-testid="decision-run">
            {item.runId ? (
              <a
                href={agentsHref(boardId)}
                data-testid="decision-run-link"
                title={`Open agents/run context for ${item.runId}`}
                aria-label={`Open agents/run context for ${item.runId}`}
              >
                {item.runId}
              </a>
            ) : (
              '—'
            )}
          </dd>
        </div>
      </dl>

      <div className={styles.field}>
        <span className={styles.fieldLabel} id={evId}>
          Evidence
        </span>
        {item.evidence.length > 0 ? (
          <ul className={styles.evidenceList} aria-labelledby={evId} data-testid="decision-evidence">
            {item.evidence.map((e) => (
              <li key={e} className={styles.evidenceItem}>
                {e}
              </li>
            ))}
          </ul>
        ) : (
          <p
            className={`${styles.fieldValue} ${styles.fieldPartial}`}
            aria-labelledby={evId}
            data-testid="decision-evidence-empty"
          >
            No evidence receipts on this record.
          </p>
        )}
      </div>

      <div className={styles.field}>
        <span className={styles.fieldLabel} id={optId}>
          Options &amp; tradeoffs
        </span>
        {item.options.length > 0 ? (
          <ul className={styles.options} aria-labelledby={optId} data-testid="decision-options">
            {item.options.map((o) => (
              <li
                key={o.optionId}
                className={styles.optionRow}
                data-option-id={o.optionId}
                data-declining={o.declining ? 'true' : 'false'}
                data-selected={
                  item.selectedOptionId === o.optionId ? 'true' : 'false'
                }
              >
                <span>
                  {o.label}
                  {o.declining ? ' (declining)' : ''}
                  {item.selectedOptionId === o.optionId ? ' · selected' : ''}
                </span>
                {o.tradeoffs ? (
                  <span className={styles.optionTradeoff}>Tradeoff: {o.tradeoffs}</span>
                ) : (
                  <span className={styles.optionTradeoff}>Tradeoff: not provided</span>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <p
            className={`${styles.fieldValue} ${styles.fieldPartial}`}
            aria-labelledby={optId}
            data-testid="decision-options-partial"
          >
            Options not available on this record.
          </p>
        )}
      </div>

      <div className={styles.field}>
        <span className={styles.fieldLabel} id={recId}>
          Recommendation
        </span>
        {item.recommendation ? (
          <p
            className={styles.fieldValue}
            aria-labelledby={recId}
            data-testid="decision-recommendation"
          >
            {item.recommendation}
          </p>
        ) : (
          <p
            className={`${styles.fieldValue} ${styles.fieldPartial}`}
            aria-labelledby={recId}
            data-testid="decision-recommendation-partial"
          >
            Agent recommendation not available on this record.
          </p>
        )}
      </div>

      {item.partialFields ? (
        <p
          id={errId}
          className={styles.fieldError}
          role="status"
          data-testid="decision-partial-notice"
        >
          Partial decision payload — missing:{' '}
          {(item.absentFields && item.absentFields.length > 0
            ? item.absentFields
            : ['some public fields']
          ).join(', ')}
          .
        </p>
      ) : null}

      {expired ? (
        <div
          className={`${styles.banner} ${styles.bannerCompact} ${styles.banner_error}`}
          role="status"
          data-testid="decision-expired-state"
        >
          <p className={styles.bannerTitle}>Decision expired</p>
          <p className={styles.bannerBody}>
            This request closed by expiry. No acknowledge, resolve, reject, or snooze actions.
          </p>
        </div>
      ) : null}

      {actionError ? (
        <p
          id={actErrId}
          className={styles.fieldError}
          role="alert"
          data-testid="decision-action-error"
          data-error-code={actionError.code}
        >
          <strong>{actionError.code}</strong>
          {actionError.message ? `: ${actionError.message}` : null}
          {actionError.action ? ` (${actionError.action})` : null}
        </p>
      ) : null}

      {missingRevs ? (
        <p className={styles.fieldError} role="status" data-testid="decision-rev-missing">
          CAS revisions missing — cannot mutate safely.
        </p>
      ) : null}

      <div className={styles.actions} aria-label="Owner actions" data-testid="decision-actions">
        {avail.canAcknowledge ? (
          <button
            type="button"
            className={`${styles.actionBtn} ${styles.actionBtnPrimary}`}
            data-testid="decision-action-acknowledge"
            data-action="acknowledge"
            disabled={busy || !revs || !actions?.onAcknowledge}
            aria-disabled={busy || !revs || !actions?.onAcknowledge ? true : undefined}
            onClick={() =>
              void run(() => actions?.onAcknowledge?.({ ...basePayload() }))
            }
          >
            {busy && pendingAction === 'acknowledge'
              ? 'Acknowledging…'
              : actionLabel('acknowledge')}
          </button>
        ) : null}

        {avail.canResolve && item.options.length > 0
          ? item.options.map((o) => (
              <button
                key={o.optionId}
                type="button"
                className={`${styles.actionBtn}${
                  o.declining ? ` ${styles.actionBtnSecondary}` : ` ${styles.actionBtnPrimary}`
                }`}
                data-testid="decision-action-resolve"
                data-action="resolve"
                data-option-id={o.optionId}
                data-declining={o.declining ? 'true' : 'false'}
                disabled={busy || !revs || !actions?.onResolve}
                aria-disabled={busy || !revs || !actions?.onResolve ? true : undefined}
                title={
                  o.declining
                    ? 'Declining option resolves as RESOLVED (not REJECTED)'
                    : `Resolve with ${o.label}`
                }
                onClick={() =>
                  void run(() =>
                    actions?.onResolve?.({
                      ...basePayload(),
                      selectedOptionId: o.optionId,
                    }),
                  )
                }
              >
                {busy && pendingAction === 'resolve'
                  ? 'Resolving…'
                  : o.declining
                    ? `Decline: ${o.label}`
                    : `Resolve: ${o.label}`}
              </button>
            ))
          : null}

        {avail.canResolve && item.options.length === 0 ? (
          <span
            className={styles.actionHint}
            data-testid="decision-action-resolve-unavailable"
          >
            Resolve needs projected options
          </span>
        ) : null}

        {avail.canReject ? (
          <button
            type="button"
            className={`${styles.actionBtn} ${styles.actionBtnDanger}`}
            data-testid="decision-action-reject"
            data-action="reject"
            disabled={busy || !revs || !actions?.onReject}
            aria-disabled={busy || !revs || !actions?.onReject ? true : undefined}
            title="Reject the request itself (not a declining option)"
            onClick={() => void run(() => actions?.onReject?.({ ...basePayload() }))}
          >
            {busy && pendingAction === 'reject' ? 'Rejecting…' : actionLabel('reject')}
          </button>
        ) : null}

        {avail.canSnooze ? (
          <button
            type="button"
            className={`${styles.actionBtn} ${styles.actionBtnSecondary}`}
            data-testid="decision-action-snooze"
            data-action="snooze"
            disabled={busy || !revs || !actions?.onSnooze}
            aria-disabled={busy || !revs || !actions?.onSnooze ? true : undefined}
            onClick={() =>
              void run(() =>
                actions?.onSnooze?.({
                  ...basePayload(),
                  snoozedUntil: defaultSnoozedUntil(),
                }),
              )
            }
          >
            {busy && pendingAction === 'snooze' ? 'Snoozing…' : actionLabel('snooze')}
          </button>
        ) : item.blocking && isOpenDecisionStatusLocal(item.status) ? (
          <span
            className={`${styles.actionHint} ${styles.actionHintBlocked}`}
            data-testid="decision-action-snooze-blocked"
            title={avail.snoozeBlockedReason ?? undefined}
          >
            Snooze unavailable (blocking)
          </span>
        ) : null}

        {!avail.canAcknowledge &&
        !avail.canResolve &&
        !avail.canReject &&
        !avail.canSnooze &&
        !expired
          ? item.ownerActions.map((label, i) => (
              <span
                key={`${item.decisionId}-hint-${i}`}
                className={`${styles.actionHint}${
                  i === 0 ? ` ${styles.actionHintPrimary}` : ''
                }`}
                data-testid="decision-owner-action"
              >
                {label}
              </span>
            ))
          : null}
      </div>
    </article>
  )
}

function isOpenDecisionStatusLocal(status: string): boolean {
  const s = status.toUpperCase()
  return s === 'OPEN' || s === 'ACKNOWLEDGED'
}
