/**
 * Public unauthenticated features list (01A public surface).
 * Loads allowlisted /api/public-snapshot — no board session required.
 * FAN-PUBLIC: Direction B presentation via #/components/ui kit only.
 */
import { Link, createFileRoute } from '@tanstack/react-router'
import { useCallback, useEffect, useMemo, useState } from 'react'

import type { FeatureRowView } from '#/components/control-center/features/types'
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
  StatusChip,
  Table,
  Toolbar,
  type StatusChipVariant,
  type TableColumn,
} from '#/components/ui'
import { formatLifecycleStageLabel } from '#/lib/display-label'
import {
  DEFAULT_PUBLIC_BOARD_ID,
  fetchPublicSnapshot,
  pinViewFromPublicSnapshot,
  publicFeaturesListHref,
  publicSnapshotToFeatureRows,
  type PublicSnapshotPayload,
} from '#/lib/public-features'

type Search = { boardId?: string }

const PAGE_SIZE_DEFAULT = 25

/** Lifecycle stages treated as progressed for the mini bar (semantic green). */
const PROGRESSED_STAGES = new Set([
  'MAPPED',
  'MAP_VERIFIED',
  'BUILT',
  'FUNCTIONAL',
  'INTEGRATED',
  'STAGING_PROVEN',
  'PROD_READY',
  'LIVE_VERIFIED',
])

function miniProgress(row: FeatureRowView): {
  total: number
  done: number
  pct: number
} {
  const sumStages = Object.values(row.stageCounts).reduce((s, n) => s + n, 0)
  const total = row.taskCount > 0 ? row.taskCount : sumStages
  if (total <= 0) return { total: 0, done: 0, pct: 0 }
  let done = 0
  for (const [stage, count] of Object.entries(row.stageCounts)) {
    if (PROGRESSED_STAGES.has(stage)) done += count
  }
  const pct = Math.min(100, Math.round((done / total) * 100))
  return { total, done, pct }
}

/** Owner human title: name first; clean technical fallback; never raw placeholder. */
function humanFeatureTitle(row: FeatureRowView): string {
  const name = typeof row.name === 'string' ? row.name.trim() : ''
  if (name && name !== row.featureId) return name
  let s = (name || row.featureId).trim()
  s = s.replace(/\[[^\]]*\]\s*/g, '')
  s = s.replace(/\b(?:T|FC|BE|WEB|RN|AFF|SALES)-[A-Z0-9._-]+\b/gi, ' ')
  s = s.replace(/[_/.-]+/g, ' ').replace(/\s+/g, ' ').trim()
  if (!s) return row.featureId
  return s.charAt(0).toUpperCase() + s.slice(1)
}

function dominantStage(row: FeatureRowView): { label: string; variant: StatusChipVariant } | null {
  const entries = Object.entries(row.stageCounts).sort((a, b) => b[1] - a[1])
  if (entries.length === 0) return null
  const [stage] = entries[0]!
  const u = stage.toUpperCase()
  let variant: StatusChipVariant = 'pending'
  if (u === 'PROD_READY' || u === 'LIVE_VERIFIED' || u === 'DONE') variant = 'done'
  else if (u === 'STAGING_PROVEN' || u === 'INTEGRATED' || u === 'FUNCTIONAL' || u === 'BUILT')
    variant = 'ongoing'
  else if (u === 'MAPPED' || u === 'MAP_VERIFIED' || u === 'MAPPING') variant = 'next'
  else if (/BLOCK|FAIL|HOLD/.test(u)) variant = 'blocked'
  else if (/WARN|REVIEW/.test(u)) variant = 'warn'
  return { label: formatLifecycleStageLabel(stage) || stage, variant }
}

function humanProjectLabel(projectId: string): string {
  const s = projectId.trim()
  if (!s) return '—'
  // Keep short technical project keys mono-friendly; light humanize hyphens/underscores.
  const human = s.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim()
  return human.charAt(0).toUpperCase() + human.slice(1)
}

export const Route = createFileRoute('/public/features/')({
  validateSearch: (raw: Record<string, unknown>): Search => {
    const boardId =
      typeof raw.boardId === 'string' && raw.boardId.trim().length > 0
        ? raw.boardId.trim()
        : DEFAULT_PUBLIC_BOARD_ID
    return { boardId }
  },
  component: PublicFeaturesPage,
  head: () => ({
    meta: [
      { title: 'Fitur publik — Cairn' },
      {
        name: 'description',
        content: 'Daftar fitur dan node progres tugas (snapshot publik, tanpa login).',
      },
    ],
  }),
})

function PublicFeaturesPage() {
  const { boardId = DEFAULT_PUBLIC_BOARD_ID } = Route.useSearch()
  const [snap, setSnap] = useState<PublicSnapshotPayload | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [query, setQuery] = useState('')
  const [projectFilter, setProjectFilter] = useState<string | null>(null)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(PAGE_SIZE_DEFAULT)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    const result = await fetchPublicSnapshot(boardId)
    if (!result.ok) {
      setSnap(null)
      setError(result.message || `Gagal memuat snapshot (${result.status})`)
      setLoading(false)
      return
    }
    setSnap(result.data)
    setLoading(false)
  }, [boardId])

  useEffect(() => {
    void load()
  }, [load])

  const rows = useMemo(() => publicSnapshotToFeatureRows(snap, boardId), [snap, boardId])
  const pin = useMemo(() => pinViewFromPublicSnapshot(snap, boardId), [snap, boardId])

  const projectIds = useMemo(() => {
    const set = new Set<string>()
    for (const r of rows) {
      if (r.projectId && r.projectId.trim()) set.add(r.projectId.trim())
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b))
  }, [rows])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return rows.filter((row) => {
      if (projectFilter && row.projectId !== projectFilter) return false
      if (!q) return true
      const name = humanFeatureTitle(row).toLowerCase()
      const id = row.featureId.toLowerCase()
      const project = (row.projectId ?? '').toLowerCase()
      return name.includes(q) || id.includes(q) || project.includes(q)
    })
  }, [rows, query, projectFilter])

  // Reset page when filter/search changes.
  useEffect(() => {
    setPage(1)
  }, [query, projectFilter, pageSize, boardId])

  const totalFiltered = filtered.length
  const pageCount = Math.max(1, Math.ceil(totalFiltered / pageSize))
  const safePage = Math.min(Math.max(1, page), pageCount)
  const pageStart = totalFiltered === 0 ? 0 : (safePage - 1) * pageSize
  const pageRows = filtered.slice(pageStart, pageStart + pageSize)

  const totalTasks = useMemo(
    () => rows.reduce((s, r) => s + (r.taskCount > 0 ? r.taskCount : 0), 0),
    [rows],
  )
  const progressedTasks = useMemo(() => {
    let done = 0
    for (const r of rows) {
      done += miniProgress(r).done
    }
    return done
  }, [rows])

  const columns: Array<TableColumn<FeatureRowView>> = useMemo(
    () => [
      {
        id: 'name',
        header: 'Fitur',
        cell: (row) => {
          const title = humanFeatureTitle(row)
          return (
            <div
              data-testid="public-feature-row"
              data-feature-id={row.featureId}
              style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-1)', minWidth: 0 }}
            >
              <Link
                to="/public/features/$featureId"
                params={{ featureId: row.featureId }}
                search={{ boardId }}
                data-testid="public-feature-link"
                style={{
                  color: 'var(--text)',
                  fontWeight: 600,
                  textDecoration: 'none',
                  fontSize: 'var(--type-body-size)',
                  lineHeight: 'var(--type-body-line)',
                }}
              >
                {title}
              </Link>
              <span
                style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: 'var(--type-caption-size)',
                  lineHeight: 'var(--type-caption-line)',
                  color: 'var(--text-faint)',
                }}
                title={row.featureId}
              >
                {row.featureId}
              </span>
            </div>
          )
        },
      },
      {
        id: 'project',
        header: 'Proyek',
        cell: (row) =>
          row.projectId ? (
            <span title={row.projectId}>{humanProjectLabel(row.projectId)}</span>
          ) : (
            <span style={{ color: 'var(--text-faint)' }}>—</span>
          ),
      },
      {
        id: 'tasks',
        header: 'Tugas',
        align: 'right',
        mono: true,
        cell: (row) => <span>{row.taskCount}</span>,
      },
      {
        id: 'progress',
        header: 'Progres',
        cell: (row) => {
          const prog = miniProgress(row)
          return (
            <div data-testid="public-feature-progress" style={{ minWidth: 140 }}>
              <ProgressBar
                value={prog.done}
                max={prog.total}
                ok={prog.pct >= 100 && prog.total > 0}
                label={
                  prog.total > 0
                    ? `${prog.done}/${prog.total} (${prog.pct}%)`
                    : '0 tugas'
                }
              />
            </div>
          )
        },
      },
      {
        id: 'stage',
        header: 'Tahap utama',
        cell: (row) => {
          const dom = dominantStage(row)
          if (!dom) return <span style={{ color: 'var(--text-faint)' }}>—</span>
          return <StatusChip variant={dom.variant}>{dom.label}</StatusChip>
        },
      },
      {
        id: 'phase',
        header: 'Fase',
        cell: (row) =>
          row.phase ? (
            <Badge variant="neutral">{row.phase}</Badge>
          ) : (
            <span style={{ color: 'var(--text-faint)' }}>—</span>
          ),
      },
      {
        id: 'open',
        header: '',
        align: 'right',
        cell: (row) => (
          <Link
            to="/public/features/$featureId"
            params={{ featureId: row.featureId }}
            search={{ boardId }}
            data-testid="public-feature-open"
            style={{
              color: 'var(--accent)',
              fontSize: 'var(--type-small-size)',
              textDecoration: 'none',
              whiteSpace: 'nowrap',
            }}
          >
            Buka →
          </Link>
        ),
      },
    ],
    [boardId],
  )

  const kpiHint =
    filtered.length !== rows.length
      ? `${filtered.length} cocok filter · ${rows.length} total`
      : undefined

  return (
    <div data-testid="public-features-page" data-board-id={boardId}>
      <div
        data-testid="public-features-list"
        style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-5)' }}
      >
        <PageHeader
          eyebrow="Publik · Tanpa login"
          title="Fitur publik"
          subtitle={
            <>
              Daftar fitur dari snapshot publik board{' '}
              <MonoCell>{boardId}</MonoCell>. Klik baris untuk melihat node progres tugas — tidak
              memerlukan sesi board.
            </>
          }
          breadcrumb={
            <Breadcrumb
              items={[
                { label: 'Publik', href: publicFeaturesListHref(boardId) },
                { label: 'Fitur' },
              ]}
            />
          }
          actions={
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void load()}
              disabled={loading}
            >
              Muat ulang
            </Button>
          }
        />

        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
            gap: 'var(--sp-3)',
          }}
        >
          <Card>
            <KpiStat
              size="sm"
              value={
                <span data-testid="public-features-count">
                  {filtered.length}
                  {filtered.length !== rows.length ? ` / ${rows.length}` : ''}
                </span>
              }
              label="Fitur"
              hint={kpiHint}
            />
          </Card>
          <Card>
            <KpiStat size="sm" value={totalTasks} label="Tugas terhubung" />
          </Card>
          <Card>
            <KpiStat
              size="sm"
              value={
                totalTasks > 0 ? (
                  <ProgressBar
                    value={progressedTasks}
                    max={totalTasks}
                    ok={progressedTasks >= totalTasks}
                  />
                ) : (
                  '—'
                )
              }
              label="Progres agregat"
              hint={totalTasks > 0 ? `${progressedTasks}/${totalTasks} tahap lanjut` : 'Belum ada tugas'}
            />
          </Card>
          {pin ? (
            <Card>
              <KpiStat
                size="sm"
                value={pin.stale ? 'Usang' : 'Segar'}
                label="Snapshot"
                hint={`rev ${pin.boardRev}`}
              />
            </Card>
          ) : null}
        </div>

        {error ? (
          <Card data-testid="public-features-error">
            <EmptyState
              title="Snapshot publik tidak tersedia"
              description={error}
              action={
                <Button variant="primary" size="sm" onClick={() => void load()}>
                  Coba lagi
                </Button>
              }
            />
          </Card>
        ) : null}

        {!error && loading && !snap ? (
          <Card>
            <EmptyState
              title="Memuat snapshot publik…"
              description="Mengambil daftar fitur dari endpoint publik."
              data-testid="public-features-loading"
            />
          </Card>
        ) : null}

        {!loading && !error && rows.length === 0 ? (
          <Card>
            <EmptyState
              title="Tidak ada fitur"
              description="Tidak ada fitur pada snapshot publik ini (jujur kosong)."
              data-testid="public-features-empty"
            />
          </Card>
        ) : null}

        {!error && rows.length > 0 ? (
          <Card
            title="Daftar fitur"
            subtitle="Tabel + pencarian + filter proyek. ID teknis ditampilkan sekunder mono."
            flush
            data-testid="public-features-card-list"
            headerActions={
              pin?.stale ? (
                <StatusChip variant="warn">Snapshot usang</StatusChip>
              ) : null
            }
            footer={
              totalFiltered > 0 ? (
                <Pagination
                  page={safePage}
                  pageSize={pageSize}
                  total={totalFiltered}
                  onPageChange={setPage}
                  onPageSizeChange={(n) => {
                    setPageSize(n)
                    setPage(1)
                  }}
                />
              ) : null
            }
          >
            <div
              data-testid="public-features-filters"
              style={{ padding: 'var(--sp-3) var(--sp-4) 0' }}
            >
              <Toolbar
                searchProps={{
                  id: 'public-features-search',
                  value: query,
                  onChange: (e) => setQuery(e.currentTarget.value),
                  placeholder: 'Cari fitur…',
                  'aria-label': 'Cari fitur',
                  autoComplete: 'off',
                  name: 'public-features-search',
                }}
                filters={
                  <div
                    role="group"
                    aria-label="Filter proyek"
                    data-testid="public-features-project-filters"
                    style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--sp-2)' }}
                  >
                    <Pill
                      active={projectFilter == null}
                      onClick={() => setProjectFilter(null)}
                      data-testid="public-features-project-all"
                    >
                      Semua proyek
                    </Pill>
                    {projectIds.map((pid) => (
                      <Pill
                        key={pid}
                        active={projectFilter === pid}
                        title={pid}
                        onClick={() => setProjectFilter(pid)}
                        data-testid="public-features-project-chip"
                        data-project-id={pid}
                      >
                        {humanProjectLabel(pid)}
                      </Pill>
                    ))}
                  </div>
                }
              />
            </div>

            {!loading && filtered.length === 0 ? (
              <div style={{ padding: 'var(--sp-4)' }}>
                <EmptyState
                  title="Tidak ada hasil"
                  description="Tidak ada fitur yang cocok dengan pencarian/filter."
                  data-testid="public-features-zero-filter"
                  action={
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        setQuery('')
                        setProjectFilter(null)
                      }}
                    >
                      Hapus filter
                    </Button>
                  }
                />
              </div>
            ) : (
              <Table
                columns={columns}
                rows={pageRows}
                rowKey={(r) => r.featureId}
                loading={loading && !snap}
                empty="Tidak ada fitur."
                caption="Daftar fitur publik"
                aria-label="Daftar fitur publik"
              />
            )}
          </Card>
        ) : null}

        <Disclosure summary="Detail teknis" data-testid="public-features-technical">
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 'var(--sp-2)',
              fontSize: 'var(--type-small-size)',
              color: 'var(--text-dim)',
            }}
          >
            <p style={{ margin: 0 }}>
              <span style={{ color: 'var(--text-faint)' }}>boardId </span>
              <MonoCell>{boardId}</MonoCell>
            </p>
            {pin ? (
              <>
                <p style={{ margin: 0 }} title={pin.canonicalSnapshotId}>
                  <span style={{ color: 'var(--text-faint)' }}>pin </span>
                  <MonoCell>{pin.canonicalSnapshotId}</MonoCell>
                </p>
                <p style={{ margin: 0 }}>
                  <span style={{ color: 'var(--text-faint)' }}>boardRev </span>
                  <MonoCell>{String(pin.boardRev)}</MonoCell>
                  {pin.lifecycleRev != null ? (
                    <>
                      {' · '}
                      <span style={{ color: 'var(--text-faint)' }}>lifecycleRev </span>
                      <MonoCell>{String(pin.lifecycleRev)}</MonoCell>
                    </>
                  ) : null}
                </p>
                {pin.stale ? (
                  <StatusChip variant="warn">{pin.staleReason ?? 'PUBLIC_SNAPSHOT_STALE'}</StatusChip>
                ) : null}
              </>
            ) : null}
            <p style={{ margin: 0 }} data-testid="public-features-note">
              Surface board lengkap memerlukan login. URL daftar publik:{' '}
              <MonoCell>{publicFeaturesListHref(boardId)}</MonoCell>
            </p>
          </div>
        </Disclosure>
      </div>
    </div>
  )
}
