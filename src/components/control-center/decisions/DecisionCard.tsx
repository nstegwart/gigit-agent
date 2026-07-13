import type { DecisionItemView, DecisionSeverity } from './types'
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
}: {
  item: DecisionItemView
  /** Required for entity deep links to existing project/feature/task/agents routes. */
  boardId: string
}) {
  const qId = `dec-q-${item.decisionId}`
  const optId = `dec-opt-${item.decisionId}`
  const evId = `dec-ev-${item.decisionId}`
  const recId = `dec-rec-${item.decisionId}`
  const errId = `dec-err-${item.decisionId}`
  const titleRaw = item.title?.trim() ?? ''
  const questionRaw = item.question?.trim() ?? ''
  const titleDisplay =
    titleRaw && titleRaw !== item.decisionId
      ? titleRaw
      : titleRaw || 'Decision needs your action'
  const questionIsDup =
    !questionRaw ||
    questionRaw === titleRaw ||
    questionRaw === item.decisionId ||
    (titleRaw === item.decisionId && questionRaw === item.decisionId)

  const selectedDeclining =
    item.selectedOptionId &&
    item.options.some((o) => o.optionId === item.selectedOptionId && o.declining)

  return (
    <article
      className={`${styles.card}${item.blocking ? ` ${styles.cardBlocking}` : ''}`}
      data-testid="decision-card"
      data-decision-id={item.decisionId}
      data-blocking={item.blocking ? 'true' : 'false'}
      data-severity={item.severity}
      data-status={item.status}
      data-partial={item.partialFields ? 'true' : 'false'}
      data-selected-option={item.selectedOptionId ?? undefined}
      data-selected-declining={selectedDeclining ? 'true' : 'false'}
      aria-labelledby={`dec-title-${item.decisionId}`}
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
        <span className={styles.decisionId} title={item.decisionId}>
          {item.decisionId}
        </span>
      </div>

      <h3 id={`dec-title-${item.decisionId}`} className={styles.title}>
        {titleDisplay}
      </h3>

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

      <div className={styles.actions} aria-label="Owner actions">
        {item.ownerActions.map((label, i) => (
          <span
            key={`${item.decisionId}-act-${i}`}
            className={`${styles.actionHint}${
              i === 0 ? ` ${styles.actionHintPrimary}` : ''
            }${item.blocking && /snooze/i.test(label) ? ` ${styles.actionHintBlocked}` : ''}`}
            data-testid="decision-owner-action"
          >
            {label}
          </span>
        ))}
      </div>
    </article>
  )
}
