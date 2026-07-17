/**
 * Agents / Runs — Direction B presentation (FAN-AGENTS).
 * Prop-driven only: server order preserved; live-first active filter + history toggle.
 * Data/logic unchanged — chrome via `#/components/ui` primitives + tokens.
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react'

import { pinnedSurfaceDataAttrs } from '#/components/control-center/PinnedSurface'
import { formatDenseTimestamp, formatOperationalLabel } from '#/lib/display-label'
import {
  Badge,
  Breadcrumb,
  Button,
  Card,
  Disclosure,
  EmptyState,
  KpiStat,
  MonoCell,
  PageHeader,
  Pagination,
  Pill,
  ProgressBar,
  Skeleton,
  StatusChip,
  Table,
  Tabs,
  Toolbar,
  type StatusChipVariant,
  type TableColumn,
} from '#/components/ui'
import type {
  AgentOngoingRowView,
  AgentRunRowView,
  AgentsScreenProps,
  ProductiveSubstateView,
} from './types'
import styles from './agents.module.css'

/** Active fleet statuses — default table filter (case-insensitive). */
const ACTIVE_STATUSES = new Set(['RUNNING', 'BLOCKED', 'QUEUED'])

const CLIENT_PAGE_SIZE_DEFAULT = 25

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

function statusChipVariant(status: string | null | undefined): StatusChipVariant {
  if (!status) return 'pending'
  const s = String(status).trim().toUpperCase()
  if (s === 'RUNNING' || s === 'ONGOING') return 'ongoing'
  if (s === 'BLOCKED' || s === 'FAILED' || s === 'ERROR') return 'blocked'
  if (s === 'QUEUED' || s === 'PENDING' || s === 'CANCELLED') return 'pending'
  if (s === 'DONE' || s === 'COMPLETED' || s === 'SUCCESS') return 'done'
  if (s === 'STALLED' || s === 'WARN') return 'warn'
  return 'pending'
}

function productiveChipVariant(state: ProductiveSubstateView): StatusChipVariant {
  if (state === 'PRODUCTIVE') return 'done'
  if (state === 'STALLED') return 'blocked'
  if (state === 'IDLE') return 'warn'
  return 'pending'
}

function productiveLabelId(state: ProductiveSubstateView): string {
  if (state === 'PRODUCTIVE') return 'Produktif'
  if (state === 'STALLED') return 'Mandek'
  if (state === 'IDLE') return 'Menganggur'
  return '—'
}

function statusLabelId(status: string | null | undefined): string {
  if (!status) return '—'
  const s = String(status).trim().toUpperCase()
  if (s === 'RUNNING') return 'Berjalan'
  if (s === 'BLOCKED') return 'Terhambat'
  if (s === 'QUEUED') return 'Antre'
  if (s === 'DONE' || s === 'COMPLETED') return 'Selesai'
  if (s === 'CANCELLED' || s === 'CANCELED') return 'Dibatalkan'
  if (s === 'FAILED' || s === 'ERROR') return 'Gagal'
  return formatOperationalLabel(status) || status
}

/**
 * Entity title: humanDisplay id-ID when projected; clean fallback; technical id mono secondary.
 * Never invents owner copy — only displays projected fields.
 */
function ongoingPrimaryTitle(row: AgentOngoingRowView): string {
  const reviewOk =
    row.contentReviewRequired !== true &&
    (row.effectiveReviewStatus == null ||
      row.effectiveReviewStatus === 'REVIEWED' ||
      row.effectiveReviewStatus === 'GENERATED_NEEDS_REVIEW')
  const hd = row.ownerPrimaryTitle?.trim()
  if (hd && reviewOk && row.contentReviewRequired !== true) return hd
  if (hd && row.contentReviewRequired !== true) return hd
  // Clean fallback: projected title if non-empty and not raw-id-only, else readable task id.
  const t = row.title?.trim()
  if (t && t !== row.taskId) return t
  if (t) return t
  return formatOperationalLabel(row.taskId) || row.taskId || 'Tanpa judul'
}

function runPrimaryTitle(row: AgentRunRowView): string {
  if (row.taskId) {
    const human = formatOperationalLabel(row.taskId)
    return human || row.taskId
  }
  return 'Tanpa tugas'
}

function ProductiveChip({ state }: { state: ProductiveSubstateView }) {
  const label = productiveLabelId(state)
  return (
    <StatusChip
      variant={productiveChipVariant(state)}
      data-productive-state={state ?? 'none'}
      role="status"
      aria-label={`Keadaan kerja: ${label}`}
    >
      {label}
    </StatusChip>
  )
}

function RunStatusChip({ status }: { status: string | null | undefined }) {
  return (
    <StatusChip variant={statusChipVariant(status)} title={status ?? undefined}>
      {statusLabelId(status)}
    </StatusChip>
  )
}

function ProjectionGapDisclosure({
  projectionGaps,
}: {
  projectionGaps: readonly string[]
}) {
  if (projectionGaps.length === 0) return null
  return (
    <Disclosure
      data-testid="agents-partial-banner"
      summary={`Celah proyeksi jujur (${projectionGaps.length})`}
    >
      <p className={styles.bannerBody}>
        Umur relatif dan tautan bukti ada pada baris ONGOING zero-click bila server
        memproyeksikannya. Baris run hanya menampilkan stempel waktu.
      </p>
      <ul className={styles.gapList}>
        {projectionGaps.map((g) => (
          <li key={g}>{g}</li>
        ))}
      </ul>
    </Disclosure>
  )
}

function RunOwnershipBlock({ row }: { row: AgentRunRowView }) {
  const locksLabel =
    row.lockIds.length === 0
      ? '—'
      : row.lockIds.length <= 2
        ? row.lockIds.join(', ')
        : `${row.lockIds.slice(0, 2).join(', ')} +${row.lockIds.length - 2}`
  return (
    <div
      className={styles.metaRow}
      data-testid="agent-run-ownership"
      data-claim-state={row.claimState ?? 'none'}
      data-lock-count={row.lockIds.length}
      data-controller-run-id={row.controllerRunId ?? undefined}
      data-parent-run-id={row.parentRunId ?? undefined}
    >
      <Badge mono data-field="claim-state" title={row.claimState ?? undefined}>
        claim {row.claimState ?? '—'}
      </Badge>
      <Badge mono data-field="lock-ids" title={row.lockIds.length ? row.lockIds.join(', ') : undefined}>
        locks {locksLabel}
      </Badge>
      <Badge mono data-field="controller-run-id" title={row.controllerRunId ?? undefined}>
        ctrl {row.controllerRunId ?? '—'}
      </Badge>
      <Badge mono data-field="parent-run-id" title={row.parentRunId ?? undefined}>
        parent {row.parentRunId ?? '—'}
      </Badge>
    </div>
  )
}

function RunTechnicalDetail({ row }: { row: AgentRunRowView }) {
  return (
    <Disclosure data-testid="agent-run-detail" summary="Detail teknis">
      <dl className={styles.techDl}>
        <dt>Run</dt>
        <dd>
          <IdText value={row.runId} />
        </dd>
        <dt>Agen</dt>
        <dd>
          <IdText value={row.agentId} />
        </dd>
        <dt>Model</dt>
        <dd>
          <IdText value={row.model} />
        </dd>
        <dt>Effort</dt>
        <dd>{row.effort ?? '—'}</dd>
        <dt>Keadaan</dt>
        <dd>
          <ProductiveChip state={row.productiveSubstate} />
        </dd>
        <dt>Dimulai</dt>
        <dd>
          <TimeText value={row.startedAt} />
        </dd>
        <dt>Heartbeat</dt>
        <dd>
          <TimeText value={row.heartbeatAt} />
        </dd>
        <dt>Material</dt>
        <dd>
          <TimeText value={row.materialProgressAt} />
        </dd>
      </dl>
      <RunOwnershipBlock row={row} />
    </Disclosure>
  )
}

function TaskTitleCell({ row }: { row: AgentRunRowView }) {
  const primary = runPrimaryTitle(row)
  const fullId = row.taskId ?? '—'
  return (
    <div
      className={styles.entityTitle}
      data-testid="agent-run-row"
      data-run-id={row.runId}
      data-claim-state={row.claimState ?? 'none'}
      data-controller-run-id={row.controllerRunId ?? undefined}
      data-parent-run-id={row.parentRunId ?? undefined}
      data-run-status={row.status ?? undefined}
      data-field="task"
    >
      <div className={styles.entityPrimary}>
        {row.taskHref && row.taskId ? (
          <a href={row.taskHref} data-testid="agent-run-task-link" title={row.taskId}>
            {primary}
          </a>
        ) : (
          <span title={fullId}>{primary}</span>
        )}
      </div>
      {row.taskId ? (
        <IdText value={row.taskId} className={styles.idCell} />
      ) : (
        <span className={styles.idCell}>—</span>
      )}
      <RunTechnicalDetail row={row} />
    </div>
  )
}

function OngoingCard({ row }: { row: AgentOngoingRowView }) {
  const primary = ongoingPrimaryTitle(row)
  return (
    <li
      className={styles.ongoingCard}
      data-testid="agent-ongoing-row"
      data-task-id={row.taskId}
      data-productive-state={row.productiveSubstate ?? 'none'}
    >
      <Card
        flush={false}
        title={
          <div className={styles.entityTitle}>
            <span className={styles.entityPrimary} title={primary}>
              {primary}
            </span>
            <IdText value={row.taskId} />
          </div>
        }
        headerActions={<ProductiveChip state={row.productiveSubstate} />}
      >
        <div className={styles.stack}>
          {row.statusSentence ? (
            <p className={styles.muted}>{row.statusSentence}</p>
          ) : null}
          <div className={styles.metaRow}>
            <Badge title={row.targetGate || undefined}>
              gate <strong>{row.targetGate || '—'}</strong>
            </Badge>
            <Badge title={row.agentId || undefined}>
              agent <MonoCell>{row.agentId || '—'}</MonoCell>
            </Badge>
            <Badge>
              role <strong>{row.role || '—'}</strong>
            </Badge>
            <Badge mono title={row.model ?? undefined}>
              {row.model ?? '—'}
            </Badge>
            <Badge>effort {row.effort ?? '—'}</Badge>
            <Badge mono data-field="masked-account" title={row.maskedAccount}>
              {row.maskedAccount}
            </Badge>
          </div>

          <div className={styles.ages} data-testid="agent-ongoing-ages">
            <div className={styles.ageCell}>
              <span className={styles.ageLabel}>Dimulai</span>
              <span className={styles.ageValue} data-field="started-age">
                {row.startedAge}
              </span>
            </div>
            <div className={styles.ageCell}>
              <span className={styles.ageLabel}>Heartbeat</span>
              <span className={styles.ageValue} data-field="heartbeat-age">
                {row.heartbeatAge}
              </span>
            </div>
            <div className={styles.ageCell}>
              <span className={styles.ageLabel}>Material</span>
              <span className={styles.ageValue} data-field="material-age">
                {row.materialProgressAge}
              </span>
            </div>
          </div>

          <div className={styles.actionsRow}>
            {row.evidenceLink ? (
              <a className={styles.linkAction} href={row.evidenceLink} data-field="evidence">
                Bukti
              </a>
            ) : (
              <Badge data-field="evidence">tanpa bukti</Badge>
            )}
            <a className={styles.linkAction} href={row.taskHref} data-testid="agent-task-link">
              Buka tugas
            </a>
          </div>

          <Disclosure summary="Detail teknis">
            <dl className={styles.techDl}>
              <dt>Task id</dt>
              <dd>
                <IdText value={row.taskId} />
              </dd>
              <dt>Agent id</dt>
              <dd>
                <IdText value={row.agentId} />
              </dd>
              <dt>Model</dt>
              <dd>
                <IdText value={row.model} />
              </dd>
              <dt>Overlay</dt>
              <dd>{row.overlays.length ? row.overlays.join(', ') : '—'}</dd>
              {row.whyItMatters ? (
                <>
                  <dt>Mengapa penting</dt>
                  <dd title={row.whyItMatters}>{row.whyItMatters}</dd>
                </>
              ) : null}
              {row.blocker ? (
                <>
                  <dt>Blocker</dt>
                  <dd title={row.blocker}>{row.blocker}</dd>
                </>
              ) : null}
            </dl>
          </Disclosure>
        </div>
      </Card>
    </li>
  )
}

function RunCardMobile({ row }: { row: AgentRunRowView }) {
  const age = formatAgeFromIso(row.startedAt)
  const primary = runPrimaryTitle(row)
  return (
    <li
      data-testid="agent-run-card"
      data-run-id={row.runId}
      data-claim-state={row.claimState ?? 'none'}
      data-controller-run-id={row.controllerRunId ?? undefined}
      data-parent-run-id={row.parentRunId ?? undefined}
      data-run-status={row.status ?? undefined}
    >
      <Card
        title={
          <div className={styles.entityTitle}>
            <div className={styles.entityPrimary}>
              {row.taskHref && row.taskId ? (
                <a href={row.taskHref} data-testid="agent-run-task-link" title={row.taskId}>
                  {primary}
                </a>
              ) : (
                <span title={row.taskId ?? undefined}>{primary}</span>
              )}
            </div>
            {row.taskId ? <IdText value={row.taskId} /> : null}
          </div>
        }
        headerActions={<RunStatusChip status={row.status} />}
      >
        <div className={styles.stack}>
          <div className={styles.metaRow}>
            <Badge>role {row.role ?? '—'}</Badge>
            <Badge title={row.startedAt ?? undefined}>umur {age}</Badge>
            <Badge mono data-field="masked-account" title={row.maskedAccount}>
              {row.maskedAccount}
            </Badge>
          </div>
          <RunTechnicalDetail row={row} />
        </div>
      </Card>
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
    <div data-testid="agents-empty-active">
      <EmptyState
        title="Tidak ada agen yang sedang berjalan"
        description={
          <>
            Tidak ada run dengan status RUNNING, BLOCKED, atau QUEUED pada pin ini. Owner
            tidak melihat inventaris run lama di sini — itu riwayat, bukan fleet hidup.
            {historyCount > 0 && !showHistory ? (
              <>
                {' '}
                <span data-testid="agents-history-hint">
                  {historyCount} run riwayat (CANCELLED/DONE/dll.) disembunyikan.
                </span>
              </>
            ) : null}
          </>
        }
        action={
          <div className={styles.actionsRow}>
            {historyCount > 0 && !showHistory ? (
              <Button
                type="button"
                variant="primary"
                size="sm"
                onClick={onShowHistory}
                data-testid="agents-show-history-cta"
              >
                Lihat riwayat ({historyCount})
              </Button>
            ) : null}
            <a className={styles.linkAction} href={workHref} data-testid="agents-cta-work">
              Buka Pekerjaan
            </a>
            <a className={styles.linkAction} href={opsHref} data-testid="agents-cta-ops">
              Buka Operasi
            </a>
          </div>
        }
      />
    </div>
  )
}

function matchesSearch(row: AgentRunRowView, q: string): boolean {
  if (!q) return true
  const hay = [
    row.runId,
    row.taskId,
    row.agentId,
    row.role,
    row.model,
    row.effort,
    row.maskedAccount,
    row.status,
    row.claimState,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
  return hay.includes(q)
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
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState<string | null>(null)
  const [page, setPage] = useState(1)
  const [clientPageSize, setClientPageSize] = useState(CLIENT_PAGE_SIZE_DEFAULT)

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
    const base = showHistory ? runs : active
    return { activeRuns: active, historyRuns: history, visibleRuns: base }
  }, [runs, showHistory])

  const q = search.trim().toLowerCase()
  const filteredRuns = useMemo(() => {
    let list = visibleRuns
    if (q) list = list.filter((r) => matchesSearch(r, q))
    if (statusFilter) {
      const want = statusFilter.toUpperCase()
      list = list.filter((r) => String(r.status ?? '').trim().toUpperCase() === want)
    }
    return list
  }, [visibleRuns, q, statusFilter])

  // Reset page when filter inputs change (presentation only).
  useEffect(() => {
    setPage(1)
  }, [showHistory, q, statusFilter, clientPageSize])

  const pageCount = Math.max(1, Math.ceil(filteredRuns.length / clientPageSize))
  const safePage = Math.min(page, pageCount)
  const pagedRuns = useMemo(() => {
    const start = (safePage - 1) * clientPageSize
    return filteredRuns.slice(start, start + clientPageSize)
  }, [filteredRuns, safePage, clientPageSize])

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

  const fleetTotal = activeRuns.length + historyRuns.length
  const boardHref = boardId ? `/b/${encodeURIComponent(boardId)}` : '/'

  const runColumns: Array<TableColumn<AgentRunRowView>> = useMemo(
    () => [
      {
        id: 'task',
        header: 'Tugas',
        cell: (row) => <TaskTitleCell row={row} />,
      },
      {
        id: 'role',
        header: 'Peran',
        cell: (row) => (
          <span title={row.role ?? undefined}>{row.role ?? '—'}</span>
        ),
      },
      {
        id: 'status',
        header: 'Status',
        cell: (row) => <RunStatusChip status={row.status} />,
      },
      {
        id: 'age',
        header: 'Umur',
        mono: true,
        cell: (row) => {
          const age = formatAgeFromIso(row.startedAt)
          return (
            <span
              className={styles.timeCell}
              title={row.startedAt ?? undefined}
              data-field="age"
            >
              {age}
            </span>
          )
        },
      },
      {
        id: 'account',
        header: 'Akun',
        mono: true,
        cell: (row) => (
          <span data-field="masked-account">
            <IdText value={row.maskedAccount} />
          </span>
        ),
      },
    ],
    [],
  )

  const statusFilterOptions = useMemo(() => {
    const set = new Set<string>()
    for (const r of visibleRuns) {
      if (r.status) set.add(String(r.status).trim().toUpperCase())
    }
    return Array.from(set).sort()
  }, [visibleRuns])

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

      <PageHeader
        eyebrow="Misi Q2"
        title={<span id="agents-page-title">Agen / Run</span>}
        subtitle="Siapa mengerjakan apa sekarang: run aktif (RUNNING / BLOCKED / QUEUED) dan ONGOING zero-click. Riwayat CANCELLED/DONE disembunyikan sampai Anda membuka toggle Riwayat."
        breadcrumb={
          <Breadcrumb
            items={[
              { label: 'Papan', href: boardHref },
              { label: 'Agen' },
            ]}
          />
        }
        actions={
          onRefresh ? (
            <Button type="button" variant="secondary" size="sm" onClick={onRefresh}>
              Muat ulang
            </Button>
          ) : null
        }
      />

      <div className={styles.kpiRow}>
        <KpiStat
          size="sm"
          value={
            <span data-testid="agents-ongoing-count">
              {activeRuns.length} berlangsung
            </span>
          }
          label="Fleet hidup"
          hint="Run aktif + ONGOING zero-click"
        />
        <KpiStat
          size="sm"
          value={
            <span data-testid="agents-run-count">{historyRuns.length} riwayat</span>
          }
          label="Riwayat"
          hint="Inventaris non-aktif"
        />
        <KpiStat
          size="sm"
          value={
            <span data-testid="agents-live-inventory">
              {activeRuns.length} berlangsung · {historyRuns.length} riwayat
            </span>
          }
          label="Live vs inventaris"
          hint={`pageSize server ${pageSize}`}
        />
      </div>

      {fleetTotal > 0 ? (
        <div className={styles.fleetBar}>
          <ProgressBar
            value={activeRuns.length}
            max={fleetTotal}
            label={`${activeRuns.length}/${fleetTotal} aktif`}
          />
        </div>
      ) : null}

      {pin ? (
        <Disclosure
          data-testid="agents-pin"
          data-canonical-snapshot-id={pin.canonicalSnapshotId}
          data-canonical-hash={pin.canonicalHash}
          data-board-rev={pin.boardRev}
          data-lifecycle-rev={pin.lifecycleRev}
          summary="Detail teknis"
        >
          <dl className={styles.techDl}>
            <dt>Pin</dt>
            <dd>
              <code title={pin.canonicalSnapshotId}>{pin.canonicalSnapshotId}</code>
            </dd>
            <dt>boardRev</dt>
            <dd>{pin.boardRev}</dd>
            <dt>lifecycleRev</dt>
            <dd>{pin.lifecycleRev}</dd>
            <dt>Hash</dt>
            <dd>
              <IdText value={pin.canonicalHash} />
            </dd>
            {pin.stale ? (
              <>
                <dt>Stale</dt>
                <dd title={pin.staleReason ?? undefined}>{pin.staleReason ?? 'STALE'}</dd>
              </>
            ) : null}
          </dl>
        </Disclosure>
      ) : null}

      {error ? (
        <div
          className={`${styles.banner} ${styles.bannerError}`}
          role="alert"
          data-testid="agents-error"
        >
          <p className={styles.bannerTitle}>{error.code}: agen tidak tersedia</p>
          <p className={styles.bannerBody}>{error.message}</p>
          {onRetry ? (
            <Button type="button" variant="primary" size="sm" onClick={onRetry}>
              Coba lagi
            </Button>
          ) : null}
        </div>
      ) : null}

      {surfaceState === 'stale' ? (
        <div className={`${styles.banner} ${styles.bannerStale}`} role="status">
          <p className={styles.bannerTitle}>Pin basi</p>
          <p className={styles.bannerBody}>
            {pin?.staleReason ?? 'Agregasi pin basi — muat ulang untuk run terkini.'}
          </p>
          {onRefresh ? (
            <Button type="button" variant="primary" size="sm" onClick={onRefresh}>
              Muat ulang
            </Button>
          ) : null}
        </div>
      ) : null}

      {surfaceState === 'loading' ? (
        <div className={styles.skeletonStack} data-testid="agents-skeleton" aria-hidden="true">
          <Skeleton height={72} width="100%" />
          <Skeleton height={72} width="100%" />
          <Skeleton height={160} width="100%" />
        </div>
      ) : null}

      {surfaceState === 'empty' ||
      surfaceState === 'zero-results' ||
      (!hideList && !hasAnyData) ? (
        <EmptyState
          data-testid="agents-empty"
          title="Tidak ada agen atau run pada pin ini"
          description="Fleet kosong pada snapshot ini. Periksa Pekerjaan atau Operasi untuk konteks."
        />
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
        <Card
          title={<span id="agents-ongoing-heading">ONGOING (zero-click)</span>}
          subtitle={`${ongoing.length} tugas sedang dikerjakan pada pin ini`}
          flush
        >
          <ul
            className={styles.ongoingGrid}
            data-testid="agents-ongoing-list"
            aria-labelledby="agents-ongoing-heading"
          >
            {ongoing.map((row) => (
              <OngoingCard key={row.taskId} row={row} />
            ))}
          </ul>
        </Card>
      ) : null}

      {!hideList && (visibleRuns.length > 0 || showHistory) ? (
        <Card
          title={
            <span id="agents-runs-heading">
              {showHistory
                ? 'Runs (semua · urutan server)'
                : 'Runs aktif (RUNNING / BLOCKED / QUEUED)'}
            </span>
          }
          subtitle={
            showHistory
              ? 'Termasuk riwayat; urutan halaman server dipertahankan'
              : 'Hanya fleet hidup; buka Riwayat untuk inventaris non-aktif'
          }
          flush
        >
          <div className={styles.stack}>
            <Toolbar
              searchProps={{
                value: search,
                onChange: (e) => setSearch(e.target.value),
                placeholder: 'Cari run, tugas, peran, akun…',
                'aria-label': 'Cari run',
              }}
              filters={
                <>
                  <Pill
                    active={!showHistory}
                    onClick={() => setShowHistory(false)}
                    data-testid="agents-live-filter"
                  >
                    Aktif ({activeRuns.length})
                  </Pill>
                  {historyRuns.length > 0 ? (
                    <Pill
                      active={showHistory}
                      aria-pressed={showHistory}
                      data-testid="agents-history-toggle"
                      onClick={() => setShowHistory((v) => !v)}
                    >
                      {showHistory
                        ? 'Sembunyikan riwayat'
                        : `Riwayat (${historyRuns.length})`}
                    </Pill>
                  ) : null}
                  {statusFilterOptions.map((s) => (
                    <Pill
                      key={s}
                      active={statusFilter === s}
                      onClick={() =>
                        setStatusFilter((cur) => (cur === s ? null : s))
                      }
                    >
                      {statusLabelId(s)}
                    </Pill>
                  ))}
                </>
              }
            />

            {(() => {
              const runsBody =
                pagedRuns.length > 0 ? (
                  <>
                    <div
                      className={`${styles.tableHost} ${styles.tableFixed}`}
                      data-testid="agents-runs-table"
                    >
                      <Table
                        columns={runColumns}
                        rows={pagedRuns}
                        rowKey={(r) => r.runId}
                        caption={
                          showHistory
                            ? 'Runs semua status'
                            : 'Runs aktif RUNNING BLOCKED QUEUED'
                        }
                        aria-label="Tabel run agen"
                        empty="Tidak ada run yang cocok."
                      />
                    </div>
                    <ul className={styles.cardList} data-testid="agents-runs-cards">
                      {pagedRuns.map((row) => (
                        <RunCardMobile key={row.runId} row={row} />
                      ))}
                    </ul>
                    {filteredRuns.length > clientPageSize ||
                    filteredRuns.length > 10 ? (
                      <Pagination
                        page={safePage}
                        pageSize={clientPageSize}
                        total={filteredRuns.length}
                        onPageChange={setPage}
                        onPageSizeChange={(n) => {
                          setClientPageSize(n)
                          setPage(1)
                        }}
                      />
                    ) : null}
                  </>
                ) : showHistory &&
                  historyRuns.length === 0 &&
                  activeRuns.length > 0 ? (
                  <p className={styles.muted} data-testid="agents-history-empty">
                    Tidak ada run riwayat pada halaman ini.
                  </p>
                ) : filteredRuns.length === 0 && visibleRuns.length > 0 ? (
                  <EmptyState
                    title="Tidak ada hasil"
                    description="Ubah kata kunci atau filter status."
                    action={
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          setSearch('')
                          setStatusFilter(null)
                        }}
                      >
                        Hapus filter
                      </Button>
                    }
                  />
                ) : null

              if (historyRuns.length === 0) {
                return runsBody
              }

              return (
                <Tabs
                  value={showHistory ? 'history' : 'live'}
                  onValueChange={(id) => setShowHistory(id === 'history')}
                  items={[
                    {
                      id: 'live',
                      label: `Aktif (${activeRuns.length})`,
                      panel: <div className={styles.stack}>{runsBody}</div>,
                    },
                    {
                      id: 'history',
                      label: `Riwayat (${historyRuns.length})`,
                      panel: <div className={styles.stack}>{runsBody}</div>,
                    },
                  ]}
                />
              )
            })()}
          </div>
        </Card>
      ) : null}

      {showProjectionGaps && projectionGapList.length > 0 ? (
        <ProjectionGapDisclosure projectionGaps={projectionGapList} />
      ) : null}

      {nextCursor ? (
        <div className={styles.actionsRow}>
          <Badge data-testid="agents-next-cursor">Halaman server berikutnya</Badge>
          {onNextPage ? (
            <Button type="button" variant="secondary" size="sm" onClick={onNextPage}>
              Halaman berikutnya
            </Button>
          ) : null}
        </div>
      ) : null}
    </section>
  )
}
