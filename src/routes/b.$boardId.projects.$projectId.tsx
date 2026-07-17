// Project detail — Direction B (FAN-PROJECTS). Data/logic preserved; presentation
// via UI kit. Runs collapsed; tasks Table+Pagination (TasksTable); domain groups.
import {
  useEffect,
  useMemo,
  useState,
  type ComponentProps,
  type CSSProperties,
  type ReactNode,
} from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { BoardLink as Link } from '#/components/BoardLink'

import {
  boardQueryOptions,
  lifecycleQueryOptions,
  rollupQueryOptions,
  tasksQueryOptions,
  useBoard,
  useBoardId,
  useLifecycle,
  useRollup,
  useTasks,
} from '#/lib/board-query'
import {
  Badge,
  Breadcrumb,
  Button,
  Card,
  Disclosure,
  EmptyState,
  KpiStat,
  PageHeader,
  ProgressBar,
  StatusChip,
  type StatusChipVariant,
} from '#/components/ui'
import {
  countAttentionRuns,
  PROJECT_RUNS_PAGE_SIZE,
  RunCard,
  sortProjectRuns,
} from '#/components/RunCard'
import { FeatureRow } from '#/components/FeatureRow'
import { Architecture } from '#/components/Architecture'
import { DesignLinks } from '#/components/DesignLinks'
import { WireGraph } from '#/components/WireGraph'
import { resolveTaskDisplayTitle, TasksTable } from '#/components/TasksTable'
import type { Feature } from '#/lib/types'

/**
 * SSR-safe client gate: server + first client paint render the same fallback,
 * then mount children. Used to avoid React #418 from browser-only dependency map.
 */
function ClientOnly({
  children,
  fallback,
}: {
  children: ReactNode
  fallback: ReactNode
}) {
  const [ready, setReady] = useState(false)
  useEffect(() => {
    setReady(true)
  }, [])
  return ready ? <>{children}</> : <>{fallback}</>
}

export const Route = createFileRoute('/b/$boardId/projects/$projectId')({
  loader: async ({ context, params }) => {
    await Promise.all([
      context.queryClient.ensureQueryData(boardQueryOptions(params.boardId)),
      context.queryClient.ensureQueryData(tasksQueryOptions(params.boardId)),
      context.queryClient.ensureQueryData(rollupQueryOptions(params.boardId)),
      context.queryClient.ensureQueryData(lifecycleQueryOptions(params.boardId)),
    ])
  },
  component: View,
})

const stackStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 'var(--sp-4)',
}

const kpiRowStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))',
  gap: 'var(--sp-3)',
}

const monoStyle: CSSProperties = {
  fontFamily: 'var(--mono, ui-monospace, monospace)',
  fontSize: 'var(--type-caption-size, 12px)',
  color: 'var(--text-faint)',
}

const techDlStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'auto 1fr',
  gap: '4px 12px',
  margin: 0,
  fontSize: 'var(--type-caption-size, 12px)',
}

function projectStatusVariant(status: string | null | undefined): StatusChipVariant {
  const s = (status ?? '').toLowerCase()
  if (!s) return 'pending'
  if (/(done|ready|ok|active|live|prod|selesai)/.test(s)) return 'done'
  if (/(block|fail|error)/.test(s)) return 'blocked'
  if (/(warn|stale|partial|risk)/.test(s)) return 'warn'
  if (/(progress|build|run|ongoing)/.test(s)) return 'ongoing'
  if (/(internal|next)/.test(s)) return 'next'
  return 'pending'
}

function projectStatusLabel(status: string | null | undefined): string {
  const s = (status ?? '').toLowerCase()
  if (s === 'live') return 'Live'
  if (s === 'planned') return 'Direncanakan'
  if (s === 'internal') return 'Internal'
  if (!status) return '—'
  return status
}

/** Domain-group labels id-ID (presentation only). */
const DOMAIN_GROUP_LABELS: Record<string, string> = {
  Blocked: 'Terhambat',
  'In progress': 'Sedang dikerjakan',
  Backlog: 'Backlog',
  'Parked for later': 'Ditunda',
}

/** Controlled Disclosure — DetailsHTMLAttributes has `open`, not `defaultOpen`. */
function ToggleDisclosure({
  summary,
  initiallyOpen = false,
  children,
  ...rest
}: {
  summary: ReactNode
  initiallyOpen?: boolean
  children: ReactNode
} & Omit<ComponentProps<typeof Disclosure>, 'summary' | 'children' | 'open' | 'onToggle'>) {
  const [open, setOpen] = useState(initiallyOpen)
  return (
    <Disclosure
      summary={summary}
      open={open}
      onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}
      {...rest}
    >
      {children}
    </Disclosure>
  )
}

function View() {
  const m = useBoard()
  const boardId = useBoardId()
  const { tasks: allTasks, byId: taskById } = useTasks()
  const rollup = useRollup()
  const cfg = useLifecycle()
  const { projectId } = Route.useParams()
  const p = m.projById[projectId]
  const [showAllRuns, setShowAllRuns] = useState(false)
  const projectsHref = `/b/${boardId}/projects/`

  // Hooks before any early return (Rules of Hooks) — empty when project missing
  const runs = useMemo(
    () => (p ? sortProjectRuns(m.runs.filter((r) => r.project === p.id)) : []),
    [m.runs, p],
  )
  const projTasks = useMemo(
    () =>
      p
        ? allTasks
            .filter((t) => t.projectId === p.id)
            .slice()
            .sort((a, b) => a.id.localeCompare(b.id))
        : [],
    [allTasks, p],
  )

  if (!p) {
    return (
      <div className="wrap" style={stackStyle}>
        <PageHeader
          breadcrumb={
            <Breadcrumb
              items={[
                { label: 'Proyek', href: projectsHref },
                { label: 'Tidak ditemukan' },
              ]}
            />
          }
          title="Proyek tidak ditemukan"
          subtitle="Id proyek tidak ada di board ini."
        />
        <EmptyState
          title="Proyek tidak ditemukan"
          description={`Tidak ada proyek dengan id ${projectId}.`}
          action={
            <Link to="/projects" style={{ textDecoration: 'none' }}>
              <Button variant="secondary" size="sm">
                Kembali ke daftar
              </Button>
            </Link>
          }
        />
      </div>
    )
  }

  const activeFeatures = p.features.filter((f) => !f.parked)
  const attention = countAttentionRuns(runs)
  const visibleRuns = showAllRuns ? runs : runs.slice(0, PROJECT_RUNS_PAGE_SIZE)
  const hiddenRunCount = Math.max(0, runs.length - PROJECT_RUNS_PAGE_SIZE)
  const readiness = rollup.byProject[p.id]
  const readyPct = readiness?.readinessPercent ?? 0
  const displayName = p.nama || p.id

  const groups: Array<[string, Array<Feature>]> = [
    ['Blocked', p.features.filter((f) => f.blocked)],
    ['In progress', p.features.filter((f) => !f.blocked && !f.parked && f.fase !== 'backlog')],
    ['Backlog', p.features.filter((f) => !f.blocked && !f.parked && f.fase === 'backlog')],
    ['Parked for later', p.features.filter((f) => f.parked)],
  ].filter((g): g is [string, Array<Feature>] => g[1].length > 0)

  return (
    <div className="wrap" style={stackStyle} data-testid="project-detail">
      <PageHeader
        breadcrumb={
          <Breadcrumb
            items={[
              { label: 'Proyek', href: projectsHref },
              { label: displayName },
            ]}
          />
        }
        eyebrow="Struktur · Proyek"
        title={displayName}
        subtitle={
          <span style={{ display: 'inline-flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
            <StatusChip variant={projectStatusVariant(p.status)}>
              {projectStatusLabel(p.status)}
            </StatusChip>
            <span style={{ color: 'var(--text-dim)' }}>
              Tahap: <strong style={{ color: 'var(--text)', fontWeight: 500 }}>{p.stage || p.status}</strong>
            </span>
            <Badge mono>{p.id}</Badge>
          </span>
        }
      />

      {p.ringkas ? (
        <Card>
          <p style={{ margin: 0, color: 'var(--text-dim)', fontSize: 'var(--type-body-size, 14px)', lineHeight: 1.5 }}>
            {p.ringkas}
          </p>
        </Card>
      ) : null}

      <div style={kpiRowStyle}>
        <KpiStat size="sm" value={activeFeatures.length} label="Fitur aktif" />
        <KpiStat size="sm" value={projTasks.length} label="Tugas" />
        <KpiStat size="sm" value={runs.length} label="Runs" />
        <KpiStat
          size="sm"
          value={`${readyPct}%`}
          label="Siap produksi"
          hint={readiness ? `floor ${readiness.floor ?? '—'}` : undefined}
        />
        {attention > 0 ? (
          <KpiStat size="sm" value={attention} label="Perlu perhatian" hint="running/failed" />
        ) : null}
      </div>

      {readiness ? (
        <Card title="Kesiapan" subtitle="Rollup tahap lifecycle proyek">
          <ProgressBar
            value={readyPct}
            max={100}
            ok={readyPct >= 100}
            label={`${readyPct}% · ${readiness.atMilestone}/${readiness.total} di milestone`}
          />
        </Card>
      ) : null}

      {/* Tasks first (owner priority) — runs are secondary chrome */}
      <Card
        title="Tugas"
        subtitle={
          projTasks.length
            ? `${projTasks.length} tugas · tabel + paginasi · grup domain`
            : 'Belum ada tugas di proyek ini'
        }
        flush={projTasks.length > 0}
        headerActions={
          projTasks.length ? <Badge>{projTasks.length}</Badge> : null
        }
      >
        {projTasks.length ? (
          <div style={{ padding: 'var(--sp-3) 0 0' }}>
            <TasksTable
              tasks={projTasks}
              runsByTask={m.runsByTask}
              readinessByGroup={rollup.byFeature}
              milestone={rollup.milestone}
              cfg={cfg}
            />
          </div>
        ) : (
          <EmptyState
            title="Tidak ada tugas"
            description="Proyek ini belum memiliki tugas terdaftar."
          />
        )}
      </Card>

      {runs.length ? (
        <Card
          title="Runs"
          subtitle={
            attention > 0
              ? `${runs.length} total · ${attention} running/failed (prioritas)`
              : `${runs.length} total · running/failed dulu`
          }
          data-testid="project-runs-section"
          headerActions={<Badge>{runs.length}</Badge>}
        >
          <ToggleDisclosure
            summary={
              showAllRuns
                ? `Runs terbuka (${runs.length})`
                : `Runs (ciut · tampil ${visibleRuns.length}/${runs.length})`
            }
            initiallyOpen={runs.length <= PROJECT_RUNS_PAGE_SIZE}
            data-testid="project-runs-disclosure"
          >
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
                gap: 'var(--sp-3)',
              }}
              data-testid="project-runs-grid"
              data-visible={visibleRuns.length}
            >
              {visibleRuns.map((r) => {
                const bound = r.taskId ? taskById[r.taskId] : undefined
                const humanTask = bound ? resolveTaskDisplayTitle(bound) : undefined
                return (
                  <RunCard
                    key={r.id}
                    run={r}
                    model={m}
                    taskTitle={humanTask}
                  />
                )
              })}
            </div>
            {!showAllRuns && hiddenRunCount > 0 ? (
              <div style={{ marginTop: 12 }}>
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  data-testid="project-runs-show-all"
                  onClick={() => setShowAllRuns(true)}
                >
                  Lihat semua ({runs.length})
                </Button>
              </div>
            ) : null}
            {showAllRuns && runs.length > PROJECT_RUNS_PAGE_SIZE ? (
              <div style={{ marginTop: 12 }}>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  data-testid="project-runs-collapse"
                  onClick={() => setShowAllRuns(false)}
                >
                  Ciutkan runs
                </Button>
              </div>
            ) : null}
          </ToggleDisclosure>
        </Card>
      ) : null}

      {groups.map(([title, feats]) => {
        const label = DOMAIN_GROUP_LABELS[title] ?? title
        const defaultOpen = title !== 'Parked for later'
        return (
          <Card
            key={title}
            title={label}
            subtitle={`${feats.length} fitur`}
            headerActions={<Badge>{feats.length}</Badge>}
          >
            <ToggleDisclosure summary={`${label} · ${feats.length}`} initiallyOpen={defaultOpen}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-2)' }}>
                {[...feats]
                  .sort((a, b) => {
                    const d = (b.pct ?? 0) - (a.pct ?? 0)
                    if (d !== 0) return d
                    return a.id.localeCompare(b.id)
                  })
                  .map((f) => (
                    <FeatureRow key={f.id} feature={f} model={m} />
                  ))}
              </div>
            </ToggleDisclosure>
          </Card>
        )
      })}

      <Card title="Arsitektur">
        <Architecture project={p} />
        <div style={{ marginTop: 'var(--sp-3)' }}>
          <DesignLinks scope="project" id={p.id} links={p.design} />
        </div>
      </Card>

      {p.features.length > 0 ? (
        <Card title="Peta ketergantungan">
          <ClientOnly
            fallback={
              <p
                data-testid="dependency-map-ssr-placeholder"
                style={{ margin: 0, color: 'var(--text-faint)', fontSize: 13 }}
              >
                Memuat peta ketergantungan…
              </p>
            }
          >
            <WireGraph features={p.features} />
          </ClientOnly>
        </Card>
      ) : null}

      <Disclosure summary="Detail teknis">
        <dl style={techDlStyle}>
          <dt>Id</dt>
          <dd style={monoStyle}>{p.id}</dd>
          <dt>Status</dt>
          <dd style={monoStyle}>{p.status}</dd>
          <dt>Stage</dt>
          <dd style={monoStyle}>{p.stage || '—'}</dd>
          {p.repo ? (
            <>
              <dt>Repo</dt>
              <dd style={monoStyle}>{p.repo}</dd>
            </>
          ) : null}
          {readiness ? (
            <>
              <dt>Floor</dt>
              <dd style={monoStyle}>{readiness.floor ?? '—'}</dd>
              <dt>Milestone</dt>
              <dd style={monoStyle}>
                {readiness.atMilestone}/{readiness.total}
                {rollup.milestone ? ` · ${rollup.milestone}` : ''}
              </dd>
            </>
          ) : null}
          <dt>Fitur</dt>
          <dd style={monoStyle}>{p.features.length}</dd>
          <dt>Tugas</dt>
          <dd style={monoStyle}>{projTasks.length}</dd>
          <dt>Runs</dt>
          <dd style={monoStyle}>{runs.length}</dd>
        </dl>
      </Disclosure>
    </div>
  )
}
