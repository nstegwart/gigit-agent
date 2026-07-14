import type { ReactNode } from 'react'

import { pinnedSurfaceDataAttrs } from '#/components/control-center/PinnedSurface'
import { formatDenseTimestamp } from '#/lib/display-label'
import type {
  AgentOngoingRowView,
  AgentRunRowView,
  AgentsScreenProps,
  ProductiveSubstateView,
} from './types'
import styles from './agents.module.css'

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
    row.lockIds.length === 0 ? '—' : row.lockIds.length <= 2
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

function RunRowDesktop({ row }: { row: AgentRunRowView }) {
  return (
    <tr
      data-testid="agent-run-row"
      data-run-id={row.runId}
      data-claim-state={row.claimState ?? 'none'}
      data-controller-run-id={row.controllerRunId ?? undefined}
      data-parent-run-id={row.parentRunId ?? undefined}
    >
      <td>
        <IdText value={row.runId} />
      </td>
      <td>
        {row.taskHref && row.taskId ? (
          <IdText value={row.taskId}>
            <a href={row.taskHref} data-testid="agent-run-task-link" title={row.taskId}>
              {row.taskId}
            </a>
          </IdText>
        ) : (
          <IdText value={row.taskId} />
        )}
      </td>
      <td>
        <IdText value={row.agentId} />
      </td>
      <td title={row.role ?? undefined}>{row.role ?? '—'}</td>
      <td>
        <IdText value={row.model} />
      </td>
      <td>{row.effort ?? '—'}</td>
      <td data-field="masked-account">
        <IdText value={row.maskedAccount} />
      </td>
      <td>
        <span className={styles.statusDot}>{row.status ?? '—'}</span>
      </td>
      <td>
        <ProductiveBadge state={row.productiveSubstate} />
      </td>
      <td>
        <RunOwnershipCell row={row} />
      </td>
      <td>
        <TimeText value={row.startedAt} />
      </td>
      <td>
        <TimeText value={row.heartbeatAt} />
      </td>
      <td>
        <TimeText value={row.materialProgressAt} />
      </td>
    </tr>
  )
}

function RunCardMobile({ row }: { row: AgentRunRowView }) {
  return (
    <li
      className={styles.card}
      data-testid="agent-run-card"
      data-run-id={row.runId}
      data-claim-state={row.claimState ?? 'none'}
      data-controller-run-id={row.controllerRunId ?? undefined}
      data-parent-run-id={row.parentRunId ?? undefined}
    >
      <IdText value={row.runId} />
      <ProductiveBadge state={row.productiveSubstate} />
      <div className={styles.metaChips}>
        <span className={styles.metaChip}>status {row.status ?? '—'}</span>
        <span className={styles.metaChip} title={row.agentId ?? undefined}>
          agent {row.agentId ?? '—'}
        </span>
        <span className={styles.metaChip}>role {row.role ?? '—'}</span>
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
      <RunOwnershipCell row={row} />
      <dl className={styles.cardMeta}>
        <div>
          <dt>Tugas</dt>
          <dd>
            {row.taskHref && row.taskId ? (
              <IdText value={row.taskId}>
                <a href={row.taskHref} data-testid="agent-run-task-link" title={row.taskId}>
                  {row.taskId}
                </a>
              </IdText>
            ) : (
              <IdText value={row.taskId} />
            )}
          </dd>
        </div>
        <div>
          <dt>Dimulai</dt>
          <dd>
            <TimeText value={row.startedAt} />
          </dd>
        </div>
        <div>
          <dt>Heartbeat</dt>
          <dd>
            <TimeText value={row.heartbeatAt} />
          </dd>
        </div>
        <div>
          <dt>Material</dt>
          <dd>
            <TimeText value={row.materialProgressAt} />
          </dd>
        </div>
      </dl>
    </li>
  )
}

/**
 * Prop-driven Agents/Runs screen.
 * Zero-click ONGOING from server `ongoing`; runs list preserves server order (no stall re-sort).
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
  const hideList =
    surfaceState === 'loading' ||
    surfaceState === 'error' ||
    surfaceState === 'forbidden' ||
    surfaceState === 'disconnected'

  const hasRows = ongoing.length + runs.length > 0

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
            Kepemilikan ONGOING zero-click dan inventaris run dari envelope pin, termasuk claim /
            lock / controller / parent bila server memproyeksikannya. Urutan stall ditentukan
            server — tidak dihitung ulang di sini.
          </p>
        </div>
        <div className={styles.summaryStrip}>
          <span className={`${styles.chip} ${styles.chipAccent}`} data-testid="agents-ongoing-count">
            <span aria-hidden="true">●</span>
            {ongoing.length} berlangsung
          </span>
          <span className={styles.chip} data-testid="agents-run-count">
            {runs.length} run
          </span>
          <span className={styles.chip}>pageSize {pageSize}</span>
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
          <p className={styles.bannerTitle}>
            {error.code}: agen tidak tersedia
          </p>
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

      {surfaceState === 'empty' || surfaceState === 'zero-results' || (!hideList && !hasRows) ? (
        <p className={styles.empty} data-testid="agents-empty">
          Tidak ada agen atau run pada pin ini.
        </p>
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

      {!hideList && runs.length > 0 ? (
        <>
          <p className={styles.sectionLabel} id="agents-runs-heading">
            Runs (server order)
          </p>
          <div className={styles.tableWrap} data-testid="agents-runs-table">
            <table className={styles.table} aria-labelledby="agents-runs-heading">
              <colgroup>
                <col className={styles.colRun} />
                <col className={styles.colTask} />
                <col className={styles.colAgent} />
                <col className={styles.colRole} />
                <col className={styles.colModel} />
                <col className={styles.colEffort} />
                <col className={styles.colAccount} />
                <col className={styles.colStatus} />
                <col className={styles.colState} />
                <col className={styles.colOwnership} />
                <col className={styles.colTime} />
                <col className={styles.colTime} />
                <col className={styles.colTime} />
              </colgroup>
              <thead>
                <tr>
                  <th scope="col">Run</th>
                  <th scope="col">Tugas</th>
                  <th scope="col">Agen</th>
                  <th scope="col">Peran</th>
                  <th scope="col">Model</th>
                  <th scope="col">Effort</th>
                  <th scope="col">Akun</th>
                  <th scope="col">Status</th>
                  <th scope="col">Keadaan</th>
                  <th scope="col">Kepemilikan</th>
                  <th scope="col">Dimulai</th>
                  <th scope="col">Heartbeat</th>
                  <th scope="col">Material</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((row) => (
                  <RunRowDesktop key={row.runId} row={row} />
                ))}
              </tbody>
            </table>
          </div>
          <ul className={styles.cardList} data-testid="agents-runs-cards">
            {runs.map((row) => (
              <RunCardMobile key={row.runId} row={row} />
            ))}
          </ul>
        </>
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
