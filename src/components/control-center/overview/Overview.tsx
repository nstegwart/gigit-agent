/**
 * C3 Overview composition — prop-driven only.
 * ART editorial order (01B): (1) program position/readiness (2) priority + evidence
 * progress (3) ongoing (4) next (5) top blocker/decision (6) work-bucket summary.
 * No fetch, no bucket/readiness/priority recomputation.
 *
 * Sticky decision shelf (C3-C10): app summary + collapsed pill live in a
 * non-scrolling chrome band; mission body scrolls in a sibling region so
 * section boxes never geometrically intersect the pill (real flow reservation).
 */
import { useLayoutEffect, useRef } from 'react'
import type { RefObject } from 'react'
import { formatOperationalLabel } from '#/lib/display-label'
import { formatAgeSeconds } from '#/lib/control-center-query'
import { pinnedSurfaceDataAttrs } from '#/components/control-center/PinnedSurface'
import styles from './overview.module.css'
import type {
  OverviewAppSummary,
  OverviewBucketStrip,
  OverviewGlobalCard,
  OverviewOngoingItem,
  OverviewPriorityCard,
  OverviewProps,
} from './types'
import { AppSummaryBar } from './AppSummaryBar'
import { NeedsYourDecision } from './NeedsYourDecision'
import { PriorityCard } from './PriorityCard'
import { GlobalCard } from './GlobalCard'
import { BucketStrip } from './BucketStrip'
import { OngoingZeroClick } from './OngoingZeroClick'
import { LowerPanels } from './LowerPanels'
import { EmptySlot, OverviewSkeleton, SurfaceBanner } from './SurfaceBanner'

type PinnedSurfaceLike<T> = {
  boardId: string
  canonicalSnapshotId: string
  canonicalHash: string
  boardRev: number
  lifecycleRev: number
  generatedAt: string
  data: T | null
}

type OverviewWorkWire = {
  items: ReadonlyArray<{
    taskId: string
    title: string
    bucket: string | null
    targetGate: string | null
    ownerHumanDisplay?: OverviewOngoingItem['ownerHumanDisplay']
  }>
}

type OverviewAgentsWire = {
  runs: ReadonlyArray<{
    taskId: string | null
    agentId: string | null
    role: string | null
    model: string | null
    effort: string | null
    maskedAccount: string | null
    status: string | null
    startedAt: string | null
    heartbeatAt: string | null
    materialProgressAt: string | null
    productiveSubstate: string | null
    evidenceLink?: string | null
  }>
  ongoing?: ReadonlyArray<{
    taskId: string
    targetGate: string
    agentId: string
    role: string
    model: string | null
    effort: string | null
    maskedAccount: string | null
    startedAgeSeconds: number | null
    heartbeatAgeSeconds: number | null
    materialProgressAgeSeconds: number | null
    productiveSubstate: string | null
    evidenceLink: string | null
    ownerHumanDisplay?: OverviewOngoingItem['ownerHumanDisplay']
  }>
}

function samePinnedRevision(
  left: PinnedSurfaceLike<unknown> | null | undefined,
  right: PinnedSurfaceLike<unknown> | null | undefined,
): boolean {
  return Boolean(
    left &&
      right &&
      left.boardId === right.boardId &&
      left.canonicalSnapshotId === right.canonicalSnapshotId &&
      left.canonicalHash === right.canonicalHash &&
      left.boardRev === right.boardRev &&
      left.lifecycleRev === right.lifecycleRev,
  )
}

function presentString(value: string | null | undefined): string | null {
  const trimmed = value?.trim()
  return trimmed ? trimmed : null
}

function pinnedAgeLabel(
  eventAt: string | null | undefined,
  generatedAt: string,
): string | null {
  const eventMs = eventAt ? Date.parse(eventAt) : Number.NaN
  const generatedMs = Date.parse(generatedAt)
  if (!Number.isFinite(eventMs) || !Number.isFinite(generatedMs)) return null
  return formatAgeSeconds(Math.max(0, Math.floor((generatedMs - eventMs) / 1_000)))
}

function projectedAgeLabel(value: number | null | undefined): string | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? formatAgeSeconds(value)
    : null
}

function productiveState(
  value: string | null | undefined,
): OverviewOngoingItem['productiveState'] | null {
  return value === 'PRODUCTIVE' || value === 'IDLE' || value === 'STALLED'
    ? value
    : null
}

function recoverPinnedOngoing(
  overview: PinnedSurfaceLike<unknown>,
  work: PinnedSurfaceLike<OverviewWorkWire> | null | undefined,
  agents: PinnedSurfaceLike<OverviewAgentsWire> | null | undefined,
): OverviewOngoingItem[] {
  if (
    !samePinnedRevision(overview, work) ||
    !samePinnedRevision(overview, agents) ||
    !work?.data ||
    !agents?.data
  ) {
    return []
  }

  const runsByTaskId = new Map<string, OverviewAgentsWire['runs'][number]>()
  for (const run of agents.data.runs) {
    const taskId = presentString(run.taskId)
    if (!taskId || runsByTaskId.has(taskId)) continue
    if (run.status !== 'running' && run.status !== 'RUNNING') continue
    runsByTaskId.set(taskId, run)
  }

  // The durable Agents projection intentionally keeps evidence off raw run
  // summaries. Its complete zero-click contract lives in `data.ongoing`.
  // Prefer that server projection; retain raw runs only for older envelopes.
  const projectedByTaskId = new Map<
    string,
    NonNullable<OverviewAgentsWire['ongoing']>[number]
  >()
  for (const row of agents.data.ongoing ?? []) {
    const taskId = presentString(row.taskId)
    if (!taskId || projectedByTaskId.has(taskId)) continue
    projectedByTaskId.set(taskId, row)
  }

  const recovered: OverviewOngoingItem[] = []
  for (const row of work.data.items) {
    if (row.bucket !== 'ONGOING') continue
    const taskId = presentString(row.taskId)
    const title = presentString(row.title)
    const projected = taskId ? projectedByTaskId.get(taskId) : undefined
    const run = taskId ? runsByTaskId.get(taskId) : undefined
    const targetGate = presentString(projected?.targetGate ?? row.targetGate)
    const agentId = presentString(projected ? projected.agentId : run?.agentId)
    const role = presentString(projected ? projected.role : run?.role)
    const model = presentString(projected ? projected.model : run?.model)
    const effort = presentString(projected ? projected.effort : run?.effort)
    const maskedAccount = presentString(
      projected ? projected.maskedAccount : run?.maskedAccount,
    )
    const startedAge = projected
      ? projectedAgeLabel(projected.startedAgeSeconds)
      : pinnedAgeLabel(run?.startedAt, overview.generatedAt)
    const heartbeatAge = projected
      ? projectedAgeLabel(projected.heartbeatAgeSeconds)
      : pinnedAgeLabel(run?.heartbeatAt, overview.generatedAt)
    const materialProgressAge = projected
      ? projectedAgeLabel(projected.materialProgressAgeSeconds)
      : pinnedAgeLabel(run?.materialProgressAt, overview.generatedAt)
    const state = productiveState(
      projected ? projected.productiveSubstate : run?.productiveSubstate,
    )
    const evidenceHref = presentString(
      projected ? projected.evidenceLink : run?.evidenceLink,
    )

    // Fail closed: fallback is permitted only when every pinned zero-click field
    // exists. Never fill a card with guessed agent/account/age/evidence values.
    if (
      !taskId ||
      !title ||
      !targetGate ||
      !agentId ||
      !role ||
      !model ||
      !effort ||
      !maskedAccount ||
      !startedAge ||
      !heartbeatAge ||
      !materialProgressAge ||
      !state ||
      !evidenceHref
    ) {
      continue
    }

    recovered.push({
      taskId,
      title,
      targetGate,
      agentId,
      role,
      model,
      effort,
      maskedAccount,
      startedAge,
      heartbeatAge,
      materialProgressAge,
      productiveState: state,
      evidenceLabel: 'evidence',
      evidenceHref,
      ownerHumanDisplay:
        row.ownerHumanDisplay ?? projected?.ownerHumanDisplay ?? null,
    })
  }
  return recovered
}

/**
 * Reconcile complete, same-pin Overview support surfaces without inventing data.
 * Server Overview order remains primary; Work order is used only when its own
 * Overview ongoing list is absent and Agents supplies a complete projected row.
 */
export function reconcileAuthenticatedOverviewProps(
  props: OverviewProps,
  overview: PinnedSurfaceLike<unknown> | null | undefined,
  work: PinnedSurfaceLike<OverviewWorkWire> | null | undefined,
  agents: PinnedSurfaceLike<OverviewAgentsWire> | null | undefined,
): OverviewProps {
  if (!overview) return props
  const ongoing = props.ongoing.length
    ? props.ongoing
    : recoverPinnedOngoing(overview, work, agents)
  const expectedOngoing = props.buckets?.counts.ONGOING ?? 0
  const pinComplete = Boolean(
    props.pin?.canonicalSnapshotId &&
      props.pin.canonicalHash &&
      typeof props.pin.boardRev === 'number' &&
      typeof props.pin.lifecycleRev === 'number',
  )
  const structurallyComplete = Boolean(
    pinComplete &&
      props.appSummary &&
      props.decision &&
      props.priority &&
      props.global &&
      props.buckets &&
      props.lower &&
      !props.error &&
      ongoing.length >= expectedOngoing,
  )
  const surfaceState =
    props.surfaceState === 'partial' && structurallyComplete
      ? props.decision?.topItem?.blocking
        ? 'needs-human'
        : 'populated'
      : props.surfaceState

  return ongoing === props.ongoing && surfaceState === props.surfaceState
    ? props
    : { ...props, ongoing, surfaceState }
}

/**
 * Plain id-ID position sentence from already-projected server fields only.
 * Never invents readiness percentages as program truth.
 */
function programPositionStatement(
  appSummary: OverviewAppSummary | null,
  priority: OverviewPriorityCard | null,
  global: OverviewGlobalCard | null,
): string {
  const board = appSummary?.boardLabel?.trim() || appSummary?.boardId || 'Program'
  const stageRaw = appSummary?.liveStage.trim() || ''
  const stage = stageRaw ? formatOperationalLabel(stageRaw) : 'tahap tidak diketahui'

  if (global?.complete === true && global.g5Pass === true) {
    return `${board} pada tahap ${stage}: cakupan terlacak selesai dengan G5 lulus berdasarkan bukti saat ini. Kesiapan program berasal dari bukti, bukan persentase statis.`
  }
  if (global?.complete === true) {
    return `${board} pada tahap ${stage}: pekerjaan terlacak ditandai selesai, tetapi kesiapan program/G5 masih menunggu bukti. Bucket pekerjaan bukan kesiapan mapping/produk/program.`
  }
  if (priority?.complete === true && global?.complete === false) {
    return `${board} pada tahap ${stage}: portofolio prioritas selesai, tetapi kesiapan global program belum lengkap. 100% prioritas tidak berarti 100% program.`
  }
  if (global?.g5Pass === false) {
    const capped = global.cappedBy
      ? ` Dibatasi oleh ${formatOperationalLabel(global.cappedBy)}.`
      : ''
    return `${board} pada tahap ${stage}: program belum siap (G5 belum lulus).${capped} Progres dihitung dari bukti evidence, bukan angka statis.`
  }
  if (priority?.g5Pass === false) {
    return `${board} pada tahap ${stage}: portofolio prioritas masih berjalan; G5 prioritas belum lulus. Posisi mengikuti evidence terbaru.`
  }
  if (global || priority) {
    return `${board} pada tahap ${stage}: program sedang berjalan. Posisi kesiapan mengikuti evidence saat ini; bucket pekerjaan dipisahkan dari kesiapan mapping/produk/program.`
  }
  return `${board} pada tahap ${stage}. Data posisi/kesiapan belum tersedia penuh untuk ringkasan ini.`
}

function NextCue({ buckets }: { buckets: OverviewBucketStrip | null }) {
  if (!buckets) {
    return (
      <section data-testid="overview-next" aria-labelledby="ov-next-title">
        <h2 id="ov-next-title" className={styles.sectionLabel}>
          Berikutnya
        </h2>
        <EmptySlot>Ringkasan pekerjaan berikutnya belum tersedia.</EmptySlot>
      </section>
    )
  }
  const nextCount = buckets.counts.NEXT
  const queuedCount = buckets.counts.QUEUED
  return (
    <section data-testid="overview-next" aria-labelledby="ov-next-title">
      <h2 id="ov-next-title" className={styles.sectionLabel}>
        Berikutnya
      </h2>
      <div className={styles.nextCueCard}>
        <p className={styles.nextCueLead} data-testid="overview-next-lead">
          {nextCount === 0
            ? 'Tidak ada item Berikutnya yang siap dijadwalkan saat ini.'
            : `${nextCount} pekerjaan Berikutnya siap dilanjutkan setelah prasyarat terpenuhi.`}
        </p>
        <p className={styles.nextCueMeta} data-testid="overview-next-meta">
          Antrian valid: {queuedCount} menunggu giliran (belum dijadwalkan). Pilih bucket
          Berikutnya untuk membuka daftar lengkap.
        </p>
      </div>
    </section>
  )
}

function ProgramPosition({
  appSummary,
  priority,
  global,
}: {
  appSummary: OverviewAppSummary | null
  priority: OverviewPriorityCard | null
  global: OverviewGlobalCard | null
}) {
  const statement = programPositionStatement(appSummary, priority, global)
  const stage = appSummary?.liveStage
    ? formatOperationalLabel(appSummary.liveStage)
    : null
  const readinessBits: string[] = []
  if (global) {
    readinessBits.push(
      global.complete ? 'Cakupan terlacak: selesai' : 'Cakupan terlacak: belum selesai',
    )
    readinessBits.push(global.g5Pass ? 'G5 program: lulus' : 'G5 program: belum lulus')
    if (global.boardReadinessPercent != null) {
      readinessBits.push(
        `Rasio board (evidence): ${global.boardReadinessPercent}% — bukan jaminan kesiapan program`,
      )
    }
  }
  if (priority) {
    readinessBits.push(
      priority.complete
        ? 'Portofolio prioritas: selesai'
        : `Portofolio prioritas: ${priority.prodReadyWithEvidence}/${priority.productDenominator} PROD_READY ber-evidence`,
    )
  }

  return (
    <section
      className={styles.programPosition}
      data-testid="overview-program-position"
      aria-labelledby="ov-position-title"
    >
      <p className={styles.programEyebrow}>Ringkasan Program</p>
      <h2 id="ov-position-title" className={styles.programHeadline}>
        Di mana posisi program sekarang?
      </h2>
      <p className={styles.programStatement} data-testid="overview-position-statement">
        {statement}
      </p>
      {stage || readinessBits.length ? (
        <ul className={styles.programMeta} data-testid="overview-position-meta">
          {stage ? <li>Tahap: {stage}</li> : null}
          {readinessBits.map((bit) => (
            <li key={bit}>{bit}</li>
          ))}
        </ul>
      ) : null}
    </section>
  )
}

function MissionBody({
  surfaceState,
  appSummary,
  decision,
  priority,
  global,
  buckets,
  ongoing,
  lower,
  pillCollapsed,
  onPillExpand,
  onPillCollapse,
  enableStickyPill,
  needsHuman,
  stickyShelfHostRef,
}: {
  surfaceState: OverviewProps['surfaceState']
  appSummary: OverviewProps['appSummary']
  decision: OverviewProps['decision']
  priority: OverviewProps['priority']
  global: OverviewProps['global']
  buckets: OverviewProps['buckets']
  ongoing: OverviewProps['ongoing']
  lower: OverviewProps['lower']
  pillCollapsed?: boolean
  onPillExpand?: () => void
  onPillCollapse?: () => void
  enableStickyPill?: boolean
  needsHuman: boolean
  stickyShelfHostRef?: RefObject<HTMLElement | null>
}) {
  return (
    <>
      {/* ART order: (1) position (2) priority+progress (3) ongoing (4) next (5) decision (6) buckets */}
      <ProgramPosition appSummary={appSummary} priority={priority} global={global} />

      {surfaceState === 'empty' && !decision?.count && !ongoing.length && !priority ? (
        <EmptySlot>
          Ringkasan kosong — belum ada data misi terlacak untuk board ini.
        </EmptySlot>
      ) : null}

      <div className={styles.priorityGlobal}>
        <PriorityCard data={priority} />
        <GlobalCard data={global} />
      </div>

      <OngoingZeroClick
        items={ongoing}
        emptyLabel={
          surfaceState === 'zero-results'
            ? 'Tidak ada item Sedang dikerjakan yang cocok dengan filter saat ini.'
            : 'Tidak ada pekerjaan Sedang dikerjakan.'
        }
      />

      <NextCue buckets={buckets} />

      <NeedsYourDecision
        decision={decision}
        pillCollapsed={pillCollapsed}
        onPillExpand={onPillExpand}
        onPillCollapse={onPillCollapse}
        enableStickyPill={enableStickyPill}
        elevated={needsHuman}
        stickyShelfHostRef={stickyShelfHostRef}
      />

      <BucketStrip data={buckets} />

      <LowerPanels data={lower} />
    </>
  )
}

export function Overview({
  surfaceState,
  appSummary,
  pin,
  decision,
  priority,
  global,
  buckets,
  ongoing,
  lower,
  partialErrors,
  error,
  onRetry,
  onReconnect,
  pillCollapsed,
  onPillExpand,
  onPillCollapse,
  enableStickyPill = true,
  liveMessage,
  className,
}: OverviewProps) {
  /** Hard terminal surfaces: no mission body. disconnected/stale/partial still render data. */
  const hideMissionBody =
    surfaceState === 'error' || surfaceState === 'forbidden' || surfaceState === 'loading'

  const needsHuman =
    surfaceState === 'needs-human' ||
    (decision?.topItem?.blocking === true && decision.count > 0)

  const pinMeta =
    pin ??
    (appSummary
      ? {
          canonicalSnapshotId: appSummary.canonicalSnapshotId ?? null,
          canonicalHash: appSummary.canonicalHash ?? null,
          boardRev: typeof appSummary.boardRev === 'number' ? appSummary.boardRev : null,
          lifecycleRev:
            typeof appSummary.lifecycleRev === 'number' ? appSummary.lifecycleRev : null,
        }
      : null)

  const rootRef = useRef<HTMLDivElement | null>(null)
  const stickyShelfRef = useRef<HTMLDivElement | null>(null)

  // Fill #view client height so the mission region owns overflow (shelf stays fixed).
  useLayoutEffect(() => {
    const root = rootRef.current
    if (!root || typeof document === 'undefined') return
    const view = document.getElementById('view')
    if (!view) return
    const apply = () => {
      const h = view.clientHeight
      if (h > 40) root.style.height = `${h}px`
      else root.style.height = ''
    }
    apply()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(apply)
    ro.observe(view)
    return () => {
      ro.disconnect()
      root.style.height = ''
    }
  }, [surfaceState, hideMissionBody])

  // Legacy CSS var for fallback sticky top when shelf host is absent (unit tests).
  useLayoutEffect(() => {
    const root = rootRef.current
    if (!root || typeof ResizeObserver === 'undefined') return
    const bar = root.querySelector('[data-testid="overview-app-summary"]')
    const apply = () => {
      const h = bar instanceof HTMLElement ? Math.ceil(bar.getBoundingClientRect().height) : 0
      root.style.setProperty('--cc-sticky-pill-top', `${h}px`)
    }
    apply()
    if (!(bar instanceof HTMLElement)) return
    const ro = new ResizeObserver(apply)
    ro.observe(bar)
    return () => ro.disconnect()
  }, [surfaceState, appSummary, pillCollapsed, hideMissionBody])

  const shelfActive = enableStickyPill && !hideMissionBody && Boolean(appSummary)

  const missionProps = {
    surfaceState,
    appSummary,
    decision,
    priority,
    global,
    buckets,
    ongoing,
    lower,
    pillCollapsed,
    onPillExpand,
    onPillCollapse,
    enableStickyPill,
    needsHuman,
  }

  return (
    <div
      ref={rootRef}
      className={`${styles.root}${shelfActive ? ` ${styles.rootShelf}` : ''}${className ? ` ${className}` : ''}`}
      data-testid="control-center-overview"
      data-surface-state={surfaceState}
      data-needs-human={needsHuman ? 'true' : 'false'}
      data-shelf-layout={shelfActive ? 'true' : 'false'}
      data-pill-collapsed={pillCollapsed ? 'true' : 'false'}
      {...pinnedSurfaceDataAttrs(pinMeta)}
    >
      {/* Coalesced live updates: single polite region; parent supplies latest message */}
      <div
        className={styles.liveRegion}
        aria-live="polite"
        aria-atomic="true"
        data-testid="overview-live"
      >
        {liveMessage ?? ''}
      </div>

      <SurfaceBanner
        state={surfaceState}
        error={error}
        partialErrors={partialErrors}
        staleReason={appSummary?.staleReason ?? error?.message}
        onRetry={onRetry}
        onReconnect={onReconnect}
      />

      {surfaceState === 'loading' ? <OverviewSkeleton /> : null}

      {surfaceState === 'error' || surfaceState === 'forbidden' ? null : (
        <>
          {shelfActive ? (
            <>
              {/* Non-scrolling sticky chrome: app summary + collapsed decision pill.
                  Mission content scrolls in the sibling below — real flow reservation. */}
              <div
                ref={stickyShelfRef}
                className={styles.stickyChrome}
                data-testid="overview-sticky-chrome"
              >
                {appSummary ? <AppSummaryBar summary={appSummary} /> : null}
              </div>
              <div
                className={styles.missionScroll}
                data-testid="overview-mission-scroll"
                id="overview-mission-scroll"
              >
                <MissionBody {...missionProps} stickyShelfHostRef={stickyShelfRef} />
              </div>
            </>
          ) : (
            <>
              {appSummary && surfaceState !== 'loading' ? (
                <AppSummaryBar summary={appSummary} />
              ) : null}

              {!hideMissionBody ? <MissionBody {...missionProps} /> : null}
            </>
          )}
        </>
      )}
    </div>
  )
}
