import { useMemo, useState, type ReactNode } from 'react'

import { pinnedSurfaceDataAttrs } from '#/components/control-center/PinnedSurface'
import { formatDenseTimestamp } from '#/lib/display-label'
import type {
  AgentOngoingRowView,
  AgentRunRowView,
  AgentsScreenProps,
  ProductiveSubstateView,
} from './types'
import styles from './agents.module.css'

/** Active fleet statuses — default table filter (case-insensitive). */
const ACTIVE_STATUSES = new Set(['RUNNING', 'BLOCKED', 'QUEUED'])

function isActiveRunStatus(status: string | null | undefined): boolean {
  if (!status) return false
  return ACTIVE_STATUSES.has(String(status).trim().toUpperCase())
}

/** Relative age from ISO timestamp (presentation only; full ISO stays in title). */
function formatAgeFromIso(iso: string | null | undefined): string {
  if (!iso) return '—'
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return '—'
  const sec = Math.max(0, Math.floor((Date.now() - t) / 1000))
  if (sec < 60) return `${sec}s`
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}m`
  const h = Math.floor(min / 60)
  const mm = min % 60
  return mm ? `${h}h ${mm}m` : `${h}h`
}

/** Accessible mono cell: ellipsis CSS + full value in title. */
function IdText({
  value,
  className,
  children,
}: {
  value: string | null | undefined
  className?: string
  children?: ReactNode
}) {
  const full = value ?? '—'
  return (
    <span className={className ?? styles.idCell} title={full} data-full-value={value ?? undefined}>
      {children ?? full}
    </span>
  )
}

function TimeText({ value }: { value: string | null | undefined }) {
  const full = value ?? '—'
  const display = value ? formatDenseTimestamp(value) : '—'
  return (
    <span className={styles.timeCell} title={full} data-full-value={value ?? undefined}>
      {display}
    </span>
  )
}

function prodClass(state: ProductiveSubstateView): string {
  if (state === 'PRODUCTIVE') return `${styles.prodBadge} ${styles.prodProductive}`
  if (state === 'STALLED') return `${styles.prodBadge} ${styles.prodStalled}`
  if (state === 'IDLE') return `${styles.prodBadge} ${styles.prodIdle}`
  return styles.prodBadge
}

function ProductiveBadge({ state }: { state: ProductiveSubstateView }) {
  const label = state ?? '—'
  return (
    <span
      className={prodClass(state)}
      data-productive-state={state ?? 'none'}
      role="status"
      aria-label={`Work state: ${label}`}
    >
      <span aria-hidden="true">
        {state === 'PRODUCTIVE' ? '●' : state === 'STALLED' ? '■' : '○'}
      </span>
      {label}
    </span>
  )
}

function ProjectionGapDisclosure({
  projectionGaps,
}: {
  projectionGaps: readonly string[] | null | undefined
}) {
  if (!projectionGaps || projectionGaps.length === 0) return null
  return (
    <details className={styles.gapDisclosure} data-testid="agents-partial-banner">
      <summary className={styles.gapDisclosureSummary}>
        Celah proyeksi jujur ({projectionGaps.length})
      </summary>
      <div className={styles.gapDisclosureBody}>
        <p className={styles.bannerBody}>
          Relative ages and evidence live on zero-click ONGOING rows when the server projects
          them. Run rows show timestamps only.
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

function OngoingCard({ row }: { row: AgentOngoingRowView }) {
  return (
    <li
      className={styles.ongoingCard}
      data-testid="agent-ongoing-row"
      data-task-id={row.taskId}
      data-productive-state={row.productiveSubstate ?? 'none'}
    >
      <div className={styles.pageHead} style={{ gap: 8 }}>
        <div style={{ minWidth: 0 }}>
          <IdText value={row.taskId} />
          <div className={styles.nameCell}>{row.title}</div>
        </div>
        <ProductiveBadge state={row.productiveSubstate} />
      </div>

      <div className={styles.metaChips}>
        <span className={styles.metaChip} title={row.targetGate || undefined}>
          gate <strong>{row.targetGate || '—'}</strong>
        </span>
        <span className={styles.metaChip} title={row.agentId || undefined}>
          agent <strong>{row.agentId || '—'}</strong>
        </span>
        <span className={styles.metaChip}>
          role <strong>{row.role || '—'}</strong>
        </span>
        <span
          className={`${styles.metaChip} ${styles.metaChipMono}`}
          title={row.model ?? undefined}
        >
          {row.model ?? '—'}
        </span>
        <span className={styles.metaChip}>effort {row.effort ?? '—'}</span>
        <span
          className={`${styles.metaChip} ${styles.metaChipMono}`}
          data-field="masked-account"
          title={row.maskedAccount}
        >
          {row.maskedAccount}
        </span>
      </div>

      <div className={styles.ages} data-testid="agent-ongoing-ages">
        <div>
          <span className={styles.ageLabel}>Dimulai</span>
          <span data-field="started-age">{row.startedAge}</span>
        </div>
        <div>
          <span className={styles.ageLabel}>Heartbeat</span>
          <span data-field="heartbeat-age">{row.heartbeatAge}</span>
        </div>
        <div>
          <span className={styles.ageLabel}>Material</span>
          <span data-field="material-age">{row.materialProgressAge}</span>
        </div>
      </div>

      <div className={styles.summaryStrip}>
        {row.evidenceLink ? (
          <a className={styles.linkBtn} href={row.evidenceLink} data-field="evidence">
            Bukti
          </a>
        ) : (
          <span className={styles.metaChip} data-field="evidence">
            tanpa bukti
          </span>
        )}
        <a className={styles.linkBtn} href={row.taskHref} data-testid="agent-task-link">
          Buka tugas
        </a>
      </div>
    </li>
  )
}

function RunOwnershipCell({ row }: { row: AgentRunRowView }) {
  const locksLabel =
    row.lockIds.length === 0
      ? '—'
      : row.lockIds.length <= 2
        ? row.lockIds.join(', ')
        : `${row.lockIds.slice(0, 2).join(', ')} +${row.lockIds.length - 2}`
  return (
    <div
      className={styles.metaChips}
      data-testid="agent-run-ownership"
      data-claim-state={row.claimState ?? 'none'}
      data-lock-count={row.lockIds.length}
      data-controller-run-id={row.controllerRunId ?? undefined}
      data-parent-run-id={row.parentRunId ?? undefined}
    >
      <span className={styles.metaChip} data-field="claim-state" title={row.claimState ?? undefined}>
        claim <strong>{row.claimState ?? '—'}</strong>
      </span>
      <span
        className={`${styles.metaChip} ${styles.metaChipMono}`}
        data-field="lock-ids"
        title={row.lockIds.length ? row.lockIds.join(', ') : undefined}
      >
        locks {locksLabel}
      </span>
      <span
        className={`${styles.metaChip} ${styles.metaChipMono}`}
        data-field="controller-run-id"
        title={row.controllerRunId ?? undefined}
      >
        ctrl {row.controllerRunId ?? '—'}
      </span>
      <span
        className={`${styles.metaChip} ${styles.metaChipMono}`}
        data-field="parent-run-id"
        title={row.parentRunId ?? undefined}
      >
        parent {row.parentRunId ?? '—'}
      </span>
    </div>
  )
}

function TaskCell({ row }: { row: AgentRunRowView }) {
  const label = row.taskId ?? '—'
  return (
    <div className={styles.taskPrimary} data-field="task">
      {row.taskHref && row.taskId ? (
        <IdText value={row.taskId} className={styles.taskTitle}>
          <a href={row.taskHref} data-testid="agent-run-task-link" title={row.taskId}>
            {label}
          </a>
        </IdText>
      ) : (
        <IdText value={row.taskId} className={styles.taskTitle} />
      )}
    </div>
  )
}

function RunDetailPanel({ row }: { row: AgentRunRowView }) {
  return (
    <details className={styles.rowDetail} data-testid="agent-run-detail">
      <summary className={styles.rowDetailSummary}>Detail</summary>
      <div className={styles.rowDetailBody}>
        <div className={styles.detailGrid}>
          <div>
            <span className={styles.ageLabel}>Run</span>
            <IdText value={row.runId} />
          </div>
          <div>
            <span className={styles.ageLabel}>Agen</span>
            <IdText value={row.agentId} />
          </div>
          <div>
            <span className={styles.ageLabel}>Model</span>
            <IdText value={row.model} />
          </div>
          <div>
            <span className={styles.ageLabel}>Effort</span>
            <span>{row.effort ?? '—'}</span>
          </div>
          <div>
            <span className={styles.ageLabel}>Keadaan</span>
            <ProductiveBadge state={row.productiveSubstate} />
          </div>
          <div>
            <span className={styles.ageLabel}>Dimulai</span>
            <TimeText value={row.startedAt} />
          </div>
          <div>
            <span className={styles.ageLabel}>Heartbeat</span>
            <TimeText value={row.heartbeatAt} />
          </div>
          <div>
            <span className={styles.ageLabel}>Material</span>
            <TimeText value={row.materialProgressAt} />
          </div>
        </div>
        <RunOwnershipCell row={row} />
      </div>
    </details>
  )
}

function RunRowDesktop({ row }: { row: AgentRunRowView }) {
  const age = formatAgeFromIso(row.startedAt)
  return (
    <tr
      data-testid="agent-run-row"
      data-run-id={row.runId}
      data-claim-state={row.claimState ?? 'none'}
      data-controller-run-id={row.controllerRunId ?? undefined}
      data-parent-run-id={row.parentRunId ?? undefined}
      data-run-status={row.status ?? undefined}
    >
      <td>
        <TaskCell row={row} />
      </td>
      <td className={styles.cellRole} title={row.role ?? undefined}>
        {row.role ?? '—'}
      </td>
      <td>
        <span className={styles.statusDot} title={row.status ?? undefined}>
          {row.status ?? '—'}
        </span>
      </td>
      <td>
        <span
          className={styles.timeCell}
          title={row.startedAt ?? undefined}
          data-field="age"
        >
          {age}
        </span>
      </td>
      <td data-field="masked-account">
        <IdText value={row.maskedAccount} />
        <RunDetailPanel row={row} />
      </td>
    </tr>
  )
}

function RunCardMobile({ row }: { row: AgentRunRowView }) {
  const age = formatAgeFromIso(row.startedAt)
  return (
    <li
      className={styles.card}
      data-testid="agent-run-card"
      data-run-id={row.runId}
      data-claim-state={row.claimState ?? 'none'}
      data-controller-run-id={row.controllerRunId ?? undefined}
      data-parent-run-id={row.parentRunId ?? undefined}
      data-run-status={row.status ?? undefined}
    >
      <TaskCell row={row} />
      <div className={styles.metaChips}>
        <span className={styles.metaChip}>role {row.role ?? '—'}</span>
        <span className={styles.metaChip}>status {row.status ?? '—'}</span>
        <span className={styles.metaChip} title={row.startedAt ?? undefined}>
          umur {age}
        </span>
        <span
          className={`${styles.metaChip} ${styles.metaChipMono}`}
          data-field="masked-account"
          title={row.maskedAccount}
        >
          {row.maskedAccount}
        </span>
      </div>
      <RunDetailPanel row={row} />
    </li>
  )
}

function ActiveEmptyState({
  boardId,
  historyCount,
  showHistory,
  onShowHistory,
}: {
  boardId: string
  historyCount: number
  showHistory: boolean
  onShowHistory: () => void
}) {
  const workHref = boardId ? `/b/${encodeURIComponent(boardId)}/work` : '/work'
  const opsHref = boardId ? `/b/${encodeURIComponent(boardId)}/ops` : '/ops'
  return (
    <div className={styles.emptyState} data-testid="agents-empty-active">
      <p className={styles.emptyTitle}>Tidak ada agen yang sedang berjalan</p>
      <p className={styles.emptyBody}>
        Tidak ada run dengan status RUNNING, BLOCKED, atau QUEUED pada pin ini. Owner tidak
        melihat inventaris run lama di sini — itu riwayat, bukan fleet hidup.
      </p>
      {historyCount > 0 && !showHistory ? (
        <p className={styles.emptyBody} data-testid="agents-history-hint">
          {historyCount} run riwayat (CANCELLED/DONE/dll.) disembunyikan.
        </p>
      ) : null}
      <div className={styles.emptyActions}>
        {historyCount > 0 && !showHistory ? (
          <button
            type="button"
            className={styles.retryBtn}
            onClick={onShowHistory}
            data-testid="agents-show-history-cta"
          >
            Lihat riwayat ({historyCount})
          </button>
        ) : null}
        <a className={styles.linkBtn} href={workHref} data-testid="agents-cta-work">
          Buka Pekerjaan
        </a>
        <a className={styles.linkBtn} href={opsHref} data-testid="agents-cta-ops">
          Buka Operasi
        </a>
      </div>
    </div>
  )
}

/**
 * Prop-driven Agents/Runs screen.
 * Zero-click ONGOING from server `ongoing`; runs list preserves server order (no stall re-sort).
 * Client default filter: active statuses only; history behind Riwayat toggle.
 */
export function AgentsScreen({
  surfaceState,
  boardId,
  ongoing,
  runs,
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
}: AgentsScreenProps) {
  const [showHistory, setShowHistory] = useState(false)

  const hideList =
    surfaceState === 'loading' ||
    surfaceState === 'error' ||
    surfaceState === 'forbidden' ||
    surfaceState === 'disconnected'

  const { activeRuns, historyRuns, visibleRuns } = useMemo(() => {
    const active: AgentRunRowView[] = []
    const history: AgentRunRowView[] = []
    // Preserve server order in both partitions.
    for (const r of runs) {
      if (isActiveRunStatus(r.status)) active.push(r)
      else history.push(r)
    }
    const visible = showHistory ? runs : active
    return { activeRuns: active, historyRuns: history, visibleRuns: visible }
  }, [runs, showHistory])

  const hasAnyData = ongoing.length + runs.length > 0
  const showActiveEmpty =
    !hideList &&
    hasAnyData &&
    ongoing.length === 0 &&
    activeRuns.length === 0 &&
    !showHistory

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
      data-testid="control-center-agents"
      data-surface-state={surfaceState}
      data-board-id={boardId}
      data-ongoing-count={ongoing.length}
      data-run-count={runs.length}
      data-active-run-count={activeRuns.length}
      data-history-run-count={historyRuns.length}
      data-show-history={showHistory ? 'true' : 'false'}
      data-reflow-breakpoint="768"
      aria-labelledby="agents-page-title"
      {...pinAttrs}
    >
      <div
        className={styles.liveRegion}
        role="status"
        aria-live="polite"
        aria-atomic="true"
        data-testid="agents-live"
      >
        {liveMessage ?? ''}
      </div>

      <header className={styles.pageHead}>
        <div>
          <p className={styles.eyebrow}>Misi Q2</p>
          <h1 id="agents-page-title" className={styles.pageTitle}>
            Agen / Run
          </h1>
          <p className={styles.pageSub}>
            Siapa mengerjakan apa sekarang: run aktif (RUNNING / BLOCKED / QUEUED) dan ONGOING
            zero-click. Riwayat CANCELLED/DONE disembunyikan sampai Anda membuka toggle Riwayat.
          </p>
        </div>
        <div className={styles.summaryStrip}>
          <span
            className={`${styles.chip} ${styles.chipAccent}`}
            data-testid="agents-ongoing-count"
            title="Run aktif + ONGOING zero-click (fleet hidup)"
          >
            <span aria-hidden="true">●</span>
            {activeRuns.length} berlangsung
          </span>
          <span
            className={styles.chip}
            data-testid="agents-run-count"
            title="Inventaris run non-aktif (CANCELLED/DONE/dll.)"
          >
            {historyRuns.length} riwayat
          </span>
          <span
            className={styles.chip}
            data-testid="agents-live-inventory"
            title="Live vs inventaris"
          >
            {activeRuns.length} berlangsung · {historyRuns.length} riwayat
          </span>
          <span className={styles.chip}>pageSize {pageSize}</span>
          {historyRuns.length > 0 ? (
            <button
              type="button"
              className={`${styles.chip} ${styles.historyToggle} ${showHistory ? styles.historyToggleOn : ''}`}
              aria-pressed={showHistory}
              data-testid="agents-history-toggle"
              onClick={() => setShowHistory((v) => !v)}
            >
              {showHistory ? 'Sembunyikan riwayat' : `Riwayat (${historyRuns.length})`}
            </button>
          ) : null}
        </div>
      </header>

      {pin ? (
        <p
          className={styles.pinStrip}
          data-testid="agents-pin"
          data-canonical-snapshot-id={pin.canonicalSnapshotId}
          data-canonical-hash={pin.canonicalHash}
          data-board-rev={pin.boardRev}
          data-lifecycle-rev={pin.lifecycleRev}
        >
          pin{' '}
          <code title={pin.canonicalSnapshotId}>{pin.canonicalSnapshotId}</code> · boardRev{' '}
          {pin.boardRev} · lifecycleRev {pin.lifecycleRev}
          {pin.stale ? ` · STALE ${pin.staleReason ?? ''}` : ''}
        </p>
      ) : null}

      {error ? (
        <div
          className={`${styles.banner} ${styles.banner_error}`}
          role="alert"
          data-testid="agents-error"
        >
          <p className={styles.bannerTitle}>{error.code}: agen tidak tersedia</p>
          <p className={styles.bannerBody}>{error.message}</p>
          {onRetry ? (
            <button type="button" className={styles.retryBtn} onClick={onRetry}>
              Coba lagi
            </button>
          ) : null}
        </div>
      ) : null}

      {surfaceState === 'stale' ? (
        <div className={`${styles.banner} ${styles.banner_stale}`} role="status">
          <p className={styles.bannerTitle}>Pin basi</p>
          <p className={styles.bannerBody}>
            {pin?.staleReason ?? 'Agregasi pin basi — muat ulang untuk run terkini.'}
          </p>
          {onRefresh ? (
            <button type="button" className={styles.retryBtn} onClick={onRefresh}>
              Muat ulang
            </button>
          ) : null}
        </div>
      ) : null}

      {surfaceState === 'loading' ? (
        <div className={styles.skeleton} data-testid="agents-skeleton" aria-hidden="true">
          <div className={styles.skeletonCard} />
          <div className={styles.skeletonCard} />
        </div>
      ) : null}

      {surfaceState === 'empty' ||
      surfaceState === 'zero-results' ||
      (!hideList && !hasAnyData) ? (
        <p className={styles.empty} data-testid="agents-empty">
          Tidak ada agen atau run pada pin ini.
        </p>
      ) : null}

      {showActiveEmpty ? (
        <ActiveEmptyState
          boardId={boardId}
          historyCount={historyRuns.length}
          showHistory={showHistory}
          onShowHistory={() => setShowHistory(true)}
        />
      ) : null}

      {!hideList && ongoing.length > 0 ? (
        <>
          <p className={styles.sectionLabel} id="agents-ongoing-heading">
            ONGOING (zero-click)
          </p>
          <ul
            className={styles.ongoingGrid}
            data-testid="agents-ongoing-list"
            aria-labelledby="agents-ongoing-heading"
          >
            {ongoing.map((row) => (
              <OngoingCard key={row.taskId} row={row} />
            ))}
          </ul>
        </>
      ) : null}

      {!hideList && visibleRuns.length > 0 ? (
        <>
          <p className={styles.sectionLabel} id="agents-runs-heading">
            {showHistory
              ? 'Runs (semua · urutan server)'
              : 'Runs aktif (RUNNING / BLOCKED / QUEUED)'}
          </p>
          <div className={styles.tableWrap} data-testid="agents-runs-table">
            <table className={styles.table} aria-labelledby="agents-runs-heading">
              <colgroup>
                <col className={styles.colTask} />
                <col className={styles.colRole} />
                <col className={styles.colStatus} />
                <col className={styles.colTime} />
                <col className={styles.colAccount} />
              </colgroup>
              <thead>
                <tr>
                  <th scope="col">Tugas</th>
                  <th scope="col">Peran</th>
                  <th scope="col">Status</th>
                  <th scope="col">Umur</th>
                  <th scope="col">Akun</th>
                </tr>
              </thead>
              <tbody>
                {visibleRuns.map((row) => (
                  <RunRowDesktop key={row.runId} row={row} />
                ))}
              </tbody>
            </table>
          </div>
          <ul className={styles.cardList} data-testid="agents-runs-cards">
            {visibleRuns.map((row) => (
              <RunCardMobile key={row.runId} row={row} />
            ))}
          </ul>
        </>
      ) : null}

      {!hideList && showHistory && historyRuns.length === 0 && activeRuns.length > 0 ? (
        <p className={styles.empty} data-testid="agents-history-empty">
          Tidak ada run riwayat pada halaman ini.
        </p>
      ) : null}

      {showProjectionGaps && projectionGapList.length > 0 ? (
        <ProjectionGapDisclosure projectionGaps={projectionGapList} />
      ) : null}

      {nextCursor ? (
        <div className={styles.summaryStrip}>
          <span className={styles.chip} data-testid="agents-next-cursor">
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
