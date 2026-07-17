import {
  Badge,
  Button,
  Card,
  Disclosure,
  StatusChip,
  type StatusChipVariant,
} from '#/components/ui'
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

function statusVariant(status: string): StatusChipVariant {
  const s = status.toUpperCase()
  if (s === 'RESOLVED') return 'done'
  if (s === 'OPEN') return 'ongoing'
  if (s === 'ACKNOWLEDGED') return 'next'
  if (s === 'REJECTED' || s === 'EXPIRED' || s === 'CANCELLED') return 'blocked'
  return 'pending'
}

function statusLabelId(status: string): string {
  const s = status.toUpperCase()
  if (s === 'OPEN') return 'Terbuka'
  if (s === 'ACKNOWLEDGED') return 'Diakui'
  if (s === 'RESOLVED') return 'Selesai'
  if (s === 'REJECTED') return 'Ditolak'
  if (s === 'EXPIRED') return 'Kedaluwarsa'
  if (s === 'CANCELLED') return 'Dibatalkan'
  return status
}

function severityLabelId(sev: DecisionSeverity): string {
  if (sev === 'CRITICAL') return 'Kritis'
  if (sev === 'HIGH') return 'Tinggi'
  if (sev === 'MEDIUM') return 'Sedang'
  return 'Rendah'
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
  const missingRevs =
    revs == null &&
    (avail.canResolve || avail.canAcknowledge || avail.canReject || avail.canSnooze)

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

  const techSecondary =
    owner.technicalTitle && owner.technicalTitle !== owner.primaryTitle
      ? owner.technicalTitle
      : item.decisionId !== owner.primaryTitle
        ? item.decisionId
        : null

  return (
    <Card
      as="article"
      className={[
        item.blocking ? styles.cardBlocking : '',
        expired ? styles.cardExpired : '',
      ]
        .filter(Boolean)
        .join(' ')}
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
      <div className={styles.cardBody}>
        <div className={styles.cardHead}>
          <Badge variant="neutral" data-testid="decision-severity-badge">
            {severityLabelId(item.severity)}
          </Badge>
          <StatusChip
            variant={statusVariant(item.status)}
            data-testid="decision-status-chip"
          >
            {statusLabelId(item.status)}
          </StatusChip>
          {item.blocking ? (
            <StatusChip variant="blocked" data-testid="decision-blocking-chip">
              Menghambat
            </StatusChip>
          ) : null}
          {owner.contentReviewRequired ? (
            <StatusChip
              variant="warn"
              data-testid="decision-content-review"
              role="status"
              title={owner.effectiveReviewStatus}
            >
              {CONTENT_REVIEW_CHIP_LABEL}
            </StatusChip>
          ) : null}
          {item.status === 'REJECTED' ? (
            <Badge variant="neutral" data-testid="decision-rejected-badge">
              Ditolak (bukan opsi penolakan)
            </Badge>
          ) : null}
          {item.status === 'RESOLVED' && selectedDeclining ? (
            <Badge variant="neutral" data-testid="decision-declined-badge">
              Opsi ditolak (RESOLVED)
            </Badge>
          ) : null}
          {expired ? (
            <Badge variant="neutral" data-testid="decision-expired-badge">
              Kedaluwarsa
            </Badge>
          ) : null}
          <span className={styles.techSecondary} title={item.decisionId}>
            {item.decisionId}
          </span>
        </div>

        <div className={styles.titleBlock}>
          <h3
            id={`dec-title-${item.decisionId}`}
            className={styles.title}
            data-testid="decision-owner-title"
          >
            {owner.primaryTitle}
          </h3>
          {techSecondary ? (
            <span className={styles.techSecondary} title={techSecondary}>
              {techSecondary}
            </span>
          ) : null}
        </div>

        {owner.statusSentence ? (
          <p className={styles.statusSentence} data-testid="decision-status-sentence">
            {owner.statusSentence}
          </p>
        ) : null}

        {owner.ownerAction ? (
          <p className={styles.ownerActionLine} data-testid="decision-owner-action-copy">
            <span className={styles.fieldLabel}>Tindakan pemilik</span>
            <span className={styles.fieldValue}>{owner.ownerAction}</span>
          </p>
        ) : null}

        {(owner.whyItMatters || owner.next || owner.blocker) && (
          <dl className={styles.hdGrid} data-testid="decision-human-display">
            {owner.whyItMatters ? (
              <div className={styles.metaCell}>
                <dt>Mengapa penting</dt>
                <dd data-testid="decision-why">{owner.whyItMatters}</dd>
              </div>
            ) : null}
            {owner.next ? (
              <div className={styles.metaCell}>
                <dt>Berikutnya</dt>
                <dd data-testid="decision-next">{owner.next}</dd>
              </div>
            ) : null}
            {owner.blocker ? (
              <div className={styles.metaCell}>
                <dt>Penghambat</dt>
                <dd data-testid="decision-blocker">{owner.blocker}</dd>
              </div>
            ) : null}
          </dl>
        )}

        {owner.contentReviewRequired &&
        owner.technicalTitle &&
        owner.technicalTitle !== owner.primaryTitle ? (
          <Disclosure
            summary="Detail teknis"
            data-testid="decision-technical-title"
          >
            <dl className={styles.techDl}>
              <dt>Judul teknis</dt>
              <dd className={styles.mono}>{owner.technicalTitle}</dd>
              <dt>Status peninjauan</dt>
              <dd className={styles.mono}>{owner.effectiveReviewStatus}</dd>
            </dl>
          </Disclosure>
        ) : null}

        <div className={styles.field}>
          <span className={styles.fieldLabel} id={qId}>
            Pertanyaan
          </span>
          {questionIsDup ? (
            <p
              className={`${styles.fieldValue} ${styles.fieldPartial}`}
              aria-labelledby={qId}
              data-testid="decision-question-partial"
            >
              Pertanyaan tidak diproyeksikan oleh envelope server.
            </p>
          ) : (
            <p
              className={styles.fieldValue}
              aria-labelledby={qId}
              data-testid="decision-question"
            >
              {questionRaw}
            </p>
          )}
        </div>

        <dl className={styles.metaGrid}>
          <div className={styles.metaCell}>
            <dt>Jatuh tempo</dt>
            <dd data-testid="decision-due">{displayOrDash(item.dueAt)}</dd>
          </div>
          <div className={styles.metaCell}>
            <dt>Dibuat</dt>
            <dd data-testid="decision-created">{displayOrDash(item.createdAt)}</dd>
          </div>
          <div className={styles.metaCell}>
            <dt>Jenis</dt>
            <dd>{displayOrDash(item.type)}</dd>
          </div>
          <div className={styles.metaCell}>
            <dt>Tunda</dt>
            <dd data-testid="decision-snooze">
              {item.blocking
                ? 'Tidak bisa disembunyikan (menghambat)'
                : item.snoozedUntil
                  ? item.snoozedUntil
                  : '—'}
            </dd>
          </div>
          <div className={styles.metaCell}>
            <dt>Pemilik</dt>
            <dd data-testid="decision-owner">{displayOrDash(item.ownerId)}</dd>
          </div>
          <div className={styles.metaCell}>
            <dt>Penyelesai</dt>
            <dd data-testid="decision-resolver">{displayOrDash(item.resolverId)}</dd>
          </div>
          <div className={styles.metaCell}>
            <dt>Proyek</dt>
            <dd data-testid="decision-project">
              {item.projectId ? (
                <a
                  className={styles.entityLink}
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
            <dt>Fitur</dt>
            <dd data-testid="decision-feature">
              {item.featureId ? (
                <a
                  className={styles.entityLink}
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
            <dt>Tugas</dt>
            <dd data-testid="decision-task">
              {item.taskId ? (
                <a
                  className={styles.entityLink}
                  href={taskHref(boardId, item.taskId)}
                  data-testid="decision-task-link"
                >
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
                  className={styles.entityLink}
                  href={agentsHref(boardId)}
                  data-testid="decision-run-link"
                  title={`Buka konteks agen/run untuk ${item.runId}`}
                  aria-label={`Buka konteks agen/run untuk ${item.runId}`}
                >
                  {item.runId}
                </a>
              ) : (
                '—'
              )}
            </dd>
          </div>
        </dl>

        <Disclosure summary="Detail teknis" data-testid="decision-tech-disclosure">
          <dl className={styles.techDl}>
            <dt>entityRev</dt>
            <dd className={styles.mono} data-testid="decision-entity-rev">
              {displayOrDash(item.entityRev)}
            </dd>
            <dt>boardRev</dt>
            <dd className={styles.mono} data-testid="decision-board-rev">
              {displayOrDash(item.boardRev)}
            </dd>
            <dt>expectedRev</dt>
            <dd className={styles.mono} data-testid="decision-expected-rev">
              {displayOrDash(item.expectedRev)}
            </dd>
            <dt>Persetujuan</dt>
            <dd className={styles.mono} data-testid="decision-approval">
              {displayOrDash(item.scopedApprovalId)}
            </dd>
            <dt>Audit</dt>
            <dd className={styles.mono} data-testid="decision-audit">
              {item.auditIds && item.auditIds.length > 0
                ? item.auditIds.join(', ')
                : '—'}
            </dd>
            <dt>Opsi terpilih</dt>
            <dd className={styles.mono} data-testid="decision-selected-option">
              {displayOrDash(item.selectedOptionId)}
            </dd>
            <dt>decisionId</dt>
            <dd className={styles.mono}>{item.decisionId}</dd>
          </dl>
        </Disclosure>

        <div className={styles.field}>
          <span className={styles.fieldLabel} id={evId}>
            Bukti
          </span>
          {item.evidence.length > 0 ? (
            <ul
              className={styles.evidenceList}
              aria-labelledby={evId}
              data-testid="decision-evidence"
            >
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
              Tidak ada resi bukti pada catatan ini.
            </p>
          )}
        </div>

        <div className={styles.field}>
          <span className={styles.fieldLabel} id={optId}>
            Opsi &amp; trade-off
          </span>
          {item.options.length > 0 ? (
            <ul
              className={styles.options}
              aria-labelledby={optId}
              data-testid="decision-options"
            >
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
                    {o.declining ? ' (penolakan)' : ''}
                    {item.selectedOptionId === o.optionId ? ' · terpilih' : ''}
                  </span>
                  {o.tradeoffs ? (
                    <span className={styles.optionTradeoff}>
                      Trade-off: {o.tradeoffs}
                    </span>
                  ) : (
                    <span className={styles.optionTradeoff}>
                      Trade-off: tidak disediakan
                    </span>
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
              Opsi tidak tersedia pada catatan ini.
            </p>
          )}
        </div>

        <div className={styles.field}>
          <span className={styles.fieldLabel} id={recId}>
            Rekomendasi
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
              Rekomendasi agen tidak tersedia pada catatan ini.
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
            Muatan keputusan sebagian — hilang:{' '}
            {(item.absentFields && item.absentFields.length > 0
              ? item.absentFields
              : ['beberapa kolom publik']
            ).join(', ')}
            .
          </p>
        ) : null}

        {expired ? (
          <Card
            variant="panel"
            data-testid="decision-expired-state"
            role="status"
            title="Keputusan kedaluwarsa"
          >
            <p className={styles.bannerBody}>
              Permintaan ini ditutup karena kedaluwarsa. Tidak ada tindakan akui,
              selesaikan, tolak, atau tunda.
            </p>
          </Card>
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
            Revisi CAS hilang — tidak aman untuk mengubah.
          </p>
        ) : null}

        <div
          className={styles.actions}
          aria-label="Tindakan pemilik"
          data-testid="decision-actions"
        >
          {avail.canAcknowledge ? (
            <Button
              type="button"
              variant="primary"
              size="md"
              className={styles.actionBtn}
              data-testid="decision-action-acknowledge"
              data-action="acknowledge"
              disabled={busy || !revs || !actions?.onAcknowledge}
              aria-disabled={busy || !revs || !actions?.onAcknowledge ? true : undefined}
              onClick={() =>
                void run(() => actions?.onAcknowledge?.({ ...basePayload() }))
              }
            >
              {busy && pendingAction === 'acknowledge'
                ? 'Mengakui…'
                : actionLabel('acknowledge')}
            </Button>
          ) : null}

          {avail.canResolve && item.options.length > 0
            ? item.options.map((o) => (
                <Button
                  key={o.optionId}
                  type="button"
                  variant={o.declining ? 'secondary' : 'primary'}
                  size="md"
                  className={styles.actionBtn}
                  data-testid="decision-action-resolve"
                  data-action="resolve"
                  data-option-id={o.optionId}
                  data-declining={o.declining ? 'true' : 'false'}
                  disabled={busy || !revs || !actions?.onResolve}
                  aria-disabled={busy || !revs || !actions?.onResolve ? true : undefined}
                  title={
                    o.declining
                      ? 'Opsi penolakan diselesaikan sebagai RESOLVED (bukan REJECTED)'
                      : `Selesaikan dengan ${o.label}`
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
                    ? 'Menyelesaikan…'
                    : o.declining
                      ? `Tolak opsi: ${o.label}`
                      : `Selesaikan: ${o.label}`}
                </Button>
              ))
            : null}

          {avail.canResolve && item.options.length === 0 ? (
            <span
              className={styles.actionHint}
              data-testid="decision-action-resolve-unavailable"
            >
              Selesaikan membutuhkan opsi terproyeksi
            </span>
          ) : null}

          {avail.canReject ? (
            <Button
              type="button"
              variant="danger"
              size="md"
              className={styles.actionBtn}
              data-testid="decision-action-reject"
              data-action="reject"
              disabled={busy || !revs || !actions?.onReject}
              aria-disabled={busy || !revs || !actions?.onReject ? true : undefined}
              title="Tolak permintaan itu sendiri (bukan opsi penolakan)"
              onClick={() => void run(() => actions?.onReject?.({ ...basePayload() }))}
            >
              {busy && pendingAction === 'reject' ? 'Menolak…' : actionLabel('reject')}
            </Button>
          ) : null}

          {avail.canSnooze ? (
            <Button
              type="button"
              variant="secondary"
              size="md"
              className={styles.actionBtn}
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
              {busy && pendingAction === 'snooze' ? 'Menunda…' : actionLabel('snooze')}
            </Button>
          ) : item.blocking && isOpenDecisionStatusLocal(item.status) ? (
            <span
              className={`${styles.actionHint} ${styles.actionHintBlocked}`}
              data-testid="decision-action-snooze-blocked"
              title={avail.snoozeBlockedReason ?? undefined}
            >
              Tunda tidak tersedia (menghambat)
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
      </div>
    </Card>
  )
}

function isOpenDecisionStatusLocal(status: string): boolean {
  const s = status.toUpperCase()
  return s === 'OPEN' || s === 'ACKNOWLEDGED'
}
