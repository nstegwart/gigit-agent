/**
 * Public unauthenticated feature detail with real progress nodes.
 * Source: allowlisted /api/public-snapshot only — no board session.
 * FAN-PUBLIC: Direction B presentation via #/components/ui kit only.
 * Pin/boardRev/STALE live under Disclosure "Detail teknis".
 */
import { Link, createFileRoute } from '@tanstack/react-router'
import { useCallback, useEffect, useMemo, useState } from 'react'

import type {
  FeatureProgressNodeView,
  FeatureRowView,
  FeaturesPinView,
} from '#/components/control-center/features/types'
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
  ProgressBar,
  StatusChip,
  Table,
  Toolbar,
  type StatusChipVariant,
  type TableColumn,
} from '#/components/ui'
import { formatLifecycleStageLabel, formatOperationalLabel } from '#/lib/display-label'
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

/** Server placeholder — never render as primary owner title. */
const OWNER_CONTENT_PLACEHOLDER = 'Konten pemilik memerlukan peninjauan'

const DONE_STAGES = new Set(['PROD_READY', 'LIVE_VERIFIED', 'DONE', 'COMPLETED'])
const MAPPED_STAGES = new Set([
  'MAPPING',
  'MAPPED',
  'MAP_VERIFIED',
  'BUILT',
  'FUNCTIONAL',
  'INTEGRATED',
  'STAGING_PROVEN',
])

function cleanTechnicalTitle(raw: string): string {
  let s = raw.trim()
  if (!s) return s
  s = s.replace(/\[[^\]]*\]\s*/g, '')
  s = s.replace(/\b(?:T|FC|BE|WEB|RN|AFF|SALES)-[A-Z0-9._-]+\b/gi, '')
  s = s.replace(/[_/]+/g, ' ')
  s = s.replace(/\s+/g, ' ').trim()
  if (!s) return raw.trim()
  return s.charAt(0).toUpperCase() + s.slice(1)
}

function humanFeatureTitle(feature: FeatureRowView): string {
  const name = typeof feature.name === 'string' ? feature.name.trim() : ''
  if (name && name !== feature.featureId) return name
  return cleanTechnicalTitle(name || feature.featureId) || feature.featureId
}

function ownerFacingNodeTitle(n: FeatureProgressNodeView): {
  title: string
  needsReview: boolean
} {
  const rawTitle = typeof n.title === 'string' ? n.title.trim() : ''
  const isPlaceholder =
    !rawTitle ||
    rawTitle === OWNER_CONTENT_PLACEHOLDER ||
    rawTitle.toLowerCase() === OWNER_CONTENT_PLACEHOLDER.toLowerCase()

  if (!isPlaceholder && !n.contentReviewRequired) {
    return { title: rawTitle, needsReview: false }
  }
  if (!isPlaceholder && rawTitle) {
    return { title: rawTitle, needsReview: n.contentReviewRequired === true }
  }
  const tech =
    typeof n.technicalTitle === 'string' && n.technicalTitle.trim()
      ? n.technicalTitle.trim()
      : ''
  if (tech && tech !== OWNER_CONTENT_PLACEHOLDER) {
    return { title: cleanTechnicalTitle(tech), needsReview: true }
  }
  return { title: cleanTechnicalTitle(n.taskId) || n.taskId, needsReview: true }
}

function isUnknownStage(stage: string | null | undefined): boolean {
  if (stage == null) return true
  const s = stage.trim()
  if (!s) return true
  const u = s.toUpperCase()
  return u === 'UNKNOWN' || u === 'N/A' || u === 'NULL' || u === 'NONE'
}

function statusLabel(status: string | null): string {
  if (!status) return '—'
  const u = status.toLowerCase().replace(/_/g, ' ').trim()
  if (u === 'blocked') return 'Terhambat'
  if (u === 'done' || u === 'completed') return 'Selesai'
  if (u === 'running' || u === 'in progress' || u === 'active') return 'Berjalan'
  if (u === 'queued' || u === 'pending') return 'Antri'
  if (u === 'failed' || u === 'fail') return 'Gagal'
  if (u === 'expired') return 'Kedaluwarsa'
  if (u === 'not started' || u === 'notstarted' || u === 'todo' || u === 'idle') {
    return 'Belum mulai'
  }
  return formatOperationalLabel(status)
}

function statusVariant(status: string | null): StatusChipVariant {
  if (!status) return 'pending'
  const u = status.toLowerCase().replace(/_/g, ' ').trim()
  if (u === 'blocked' || u === 'failed' || u === 'fail') return 'blocked'
  if (u === 'done' || u === 'completed') return 'done'
  if (u === 'running' || u === 'in progress' || u === 'active') return 'ongoing'
  if (u === 'queued' || u === 'pending') return 'pending'
  if (u === 'expired') return 'warn'
  return 'pending'
}

function stageVariant(stage: string | null): StatusChipVariant {
  if (!stage || isUnknownStage(stage)) return 'pending'
  const u = stage.toUpperCase()
  if (DONE_STAGES.has(u)) return 'done'
  if (MAPPED_STAGES.has(u)) return 'ongoing'
  if (/BLOCK|FAIL|HOLD/.test(u)) return 'blocked'
  return 'next'
}

function ownerProgressSummary(nodes: readonly FeatureProgressNodeView[]): {
  selesai: number
  terpetakan: number
  terhambat: number
  perluTinjauan: number
  unknownStageCount: number
  total: number
  allStagesUnprojected: boolean
  stageEntries: Array<[string, number]>
} {
  let selesai = 0
  let terpetakan = 0
  let terhambat = 0
  let perluTinjauan = 0
  let unknownStageCount = 0
  const stageCounts: Record<string, number> = {}

  for (const n of nodes) {
    const stage = n.lifecycleStage
    const status = (n.status ?? '').toLowerCase().replace(/_/g, ' ').trim()
    const stageKey = stage && stage.trim() ? stage.trim() : null
    const stageUpper = stageKey ? stageKey.toUpperCase() : ''

    if (isUnknownStage(stageKey)) {
      unknownStageCount += 1
    } else if (stageKey) {
      stageCounts[stageKey] = (stageCounts[stageKey] ?? 0) + 1
    }

    if (DONE_STAGES.has(stageUpper) || status === 'done' || status === 'completed') {
      selesai += 1
    }
    if (MAPPED_STAGES.has(stageUpper)) {
      terpetakan += 1
    }
    if (status === 'blocked' || (n.blockedReason && n.blockedReason.trim())) {
      terhambat += 1
    }
    const facing = ownerFacingNodeTitle(n)
    if (facing.needsReview || n.contentReviewRequired === true) {
      perluTinjauan += 1
    }
  }

  const total = nodes.length
  const allStagesUnprojected = total > 0 && unknownStageCount === total
  const stageEntries = Object.entries(stageCounts).sort((a, b) => b[1] - a[1])

  return {
    selesai,
    terpetakan,
    terhambat,
    perluTinjauan,
    unknownStageCount,
    total,
    allStagesUnprojected,
    stageEntries,
  }
}

function branchLabel(branch: FeatureRowView['flowBranch']): string {
  if (!branch) return '—'
  if (branch === 'success') return 'Sukses'
  if (branch === 'fail') return 'Gagal'
  if (branch === 'expired') return 'Kedaluwarsa'
  if (branch === 'open') return 'Terbuka'
  return branch
}

export const Route = createFileRoute('/public/features/$featureId')({
  validateSearch: (raw: Record<string, unknown>): Search => {
    const boardId =
      typeof raw.boardId === 'string' && raw.boardId.trim().length > 0
        ? raw.boardId.trim()
        : DEFAULT_PUBLIC_BOARD_ID
    return { boardId }
  },
  component: PublicFeatureDetailPage,
  head: () => ({
    meta: [
      { title: 'Detail fitur publik — Cairn' },
      {
        name: 'description',
        content: 'Node progres tugas nyata per fitur dari snapshot publik (tanpa login).',
      },
    ],
  }),
})

function PublicFeatureDetailPage() {
  const { featureId } = Route.useParams()
  const { boardId = DEFAULT_PUBLIC_BOARD_ID } = Route.useSearch()
  const [snap, setSnap] = useState<PublicSnapshotPayload | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [nodeQuery, setNodeQuery] = useState('')
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
  const feature = useMemo(
    () => rows.find((r) => r.featureId === featureId) ?? null,
    [rows, featureId],
  )
  const pin = useMemo(() => pinViewFromPublicSnapshot(snap, boardId), [snap, boardId])
  const listHref = publicFeaturesListHref(boardId)

  const allNodes = feature?.progressNodes ?? []
  const summary = useMemo(() => ownerProgressSummary(allNodes), [allNodes])

  const filteredNodes = useMemo(() => {
    const q = nodeQuery.trim().toLowerCase()
    if (!q) return allNodes
    return allNodes.filter((n) => {
      const facing = ownerFacingNodeTitle(n)
      const title = facing.title.toLowerCase()
      const tech = (n.technicalTitle ?? '').toLowerCase()
      const taskId = n.taskId.toLowerCase()
      return title.includes(q) || tech.includes(q) || taskId.includes(q)
    })
  }, [allNodes, nodeQuery])

  useEffect(() => {
    setPage(1)
  }, [featureId, nodeQuery, pageSize])

  const totalFiltered = filteredNodes.length
  const pageCount = Math.max(1, Math.ceil(totalFiltered / pageSize))
  const safePage = Math.min(Math.max(1, page), pageCount)
  const pageStart = totalFiltered === 0 ? 0 : (safePage - 1) * pageSize
  const pageNodes = filteredNodes.slice(pageStart, pageStart + pageSize)

  const columns: Array<TableColumn<FeatureProgressNodeView>> = useMemo(
    () => [
      {
        id: 'title',
        header: 'Node progres',
        cell: (n) => {
          const facing = ownerFacingNodeTitle(n)
          return (
            <div
              data-testid="feature-progress-node"
              data-task-id={n.taskId}
              data-stage={n.lifecycleStage ?? undefined}
              style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-1)', minWidth: 0 }}
            >
              <a
                href={n.detailHref}
                style={{
                  color: 'var(--text)',
                  fontWeight: 600,
                  textDecoration: 'none',
                  fontSize: 'var(--type-body-size)',
                }}
              >
                {facing.title}
              </a>
              <span
                style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: 'var(--type-caption-size)',
                  color: 'var(--text-faint)',
                }}
                title={n.taskId}
              >
                {n.taskId}
              </span>
              {facing.needsReview ? (
                <Badge
                  variant="neutral"
                  data-testid="feature-progress-content-review"
                  title={n.technicalTitle ?? OWNER_CONTENT_PLACEHOLDER}
                >
                  perlu tinjauan
                </Badge>
              ) : null}
            </div>
          )
        },
      },
      {
        id: 'stage',
        header: 'Tahap',
        cell: (n) => {
          const label =
            n.lifecycleStage && !isUnknownStage(n.lifecycleStage)
              ? formatLifecycleStageLabel(n.lifecycleStage)
              : 'Tahap belum terproyeksi'
          return (
            <StatusChip
              variant={stageVariant(n.lifecycleStage)}
              data-testid="feature-progress-stage"
              title={n.lifecycleStage ?? ''}
            >
              {label}
            </StatusChip>
          )
        },
      },
      {
        id: 'status',
        header: 'Status',
        cell: (n) => (
          <StatusChip variant={statusVariant(n.status)} data-testid="feature-progress-status">
            {statusLabel(n.status)}
          </StatusChip>
        ),
      },
      {
        id: 'blocker',
        header: 'Hambatan',
        cell: (n) =>
          n.blockedReason ? (
            <span data-testid="feature-progress-blocker" style={{ color: 'var(--text-dim)' }}>
              {n.blockedReason}
            </span>
          ) : (
            <span style={{ color: 'var(--text-faint)' }}>—</span>
          ),
      },
      {
        id: 'tech',
        header: 'Teknis',
        cell: (n) => (
          <Disclosure summary="Detail teknis" data-testid="feature-progress-technical">
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 'var(--sp-1)',
                fontSize: 'var(--type-caption-size)',
                color: 'var(--text-dim)',
              }}
            >
              <p style={{ margin: 0 }}>
                <span style={{ color: 'var(--text-faint)' }}>taskId </span>
                <MonoCell>{n.taskId}</MonoCell>
              </p>
              {n.technicalTitle ? (
                <p style={{ margin: 0 }}>
                  <span style={{ color: 'var(--text-faint)' }}>Judul sumber </span>
                  <MonoCell>{n.technicalTitle}</MonoCell>
                </p>
              ) : null}
              {n.contentReviewRequired ? (
                <p style={{ margin: 0 }}>{OWNER_CONTENT_PLACEHOLDER}</p>
              ) : null}
            </div>
          </Disclosure>
        ),
      },
    ],
    [],
  )

  const title = feature ? humanFeatureTitle(feature) : featureId

  return (
    <div
      data-testid="public-feature-detail-page"
      data-board-id={boardId}
      data-feature-id={featureId}
      style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-5)' }}
    >
      <PageHeader
        eyebrow="Publik · Detail fitur"
        title={<span data-testid="feature-detail-title">{title}</span>}
        subtitle={
          feature ? (
            <>
              {feature.taskCount} tugas terhubung
              {feature.phase ? ` · Fase ${feature.phase}` : ''}
              {feature.flowBranch ? ` · Alur ${branchLabel(feature.flowBranch)}` : ''}
              {feature.projectId ? ` · Proyek ${feature.projectId}` : ''}.
            </>
          ) : loading ? (
            'Memuat snapshot publik…'
          ) : (
            'Fitur tidak ditemukan pada snapshot publik.'
          )
        }
        breadcrumb={
          <Breadcrumb
            items={[
              { label: 'Publik', href: listHref },
              { label: 'Fitur', href: listHref },
              { label: title },
            ]}
          />
        }
        actions={
          <div style={{ display: 'flex', gap: 'var(--sp-2)', flexWrap: 'wrap', alignItems: 'center' }}>
            <Link
              to="/public/features"
              search={{ boardId }}
              data-testid="public-feature-back-nav"
              style={{
                color: 'var(--text-dim)',
                fontSize: 'var(--type-small-size)',
                textDecoration: 'none',
                padding: 'var(--sp-2) var(--sp-3)',
                border: '1px solid var(--border)',
                borderRadius: 'var(--r-sm)',
                background: 'var(--surface)',
              }}
            >
              ← Daftar fitur
            </Link>
            <Button variant="secondary" size="sm" onClick={() => void load()} disabled={loading}>
              Muat ulang
            </Button>
          </div>
        }
      />

      {loading && !snap ? (
        <Card>
          <EmptyState
            title="Memuat detail fitur…"
            description="Mengambil snapshot publik."
            data-testid="feature-detail-skeleton"
          />
        </Card>
      ) : null}

      {error && !feature ? (
        <Card data-testid="feature-detail-not-found">
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

      {!loading && !error && !feature ? (
        <Card data-testid="feature-detail-not-found">
          <EmptyState
            title="Fitur tidak ditemukan"
            description={`Fitur ${featureId} tidak ada di snapshot publik board ${boardId}.`}
            action={
              <Link to="/public/features" search={{ boardId }} style={{ textDecoration: 'none' }}>
                <Button variant="secondary" size="sm">
                  Kembali ke daftar
                </Button>
              </Link>
            }
          />
        </Card>
      ) : null}

      {feature ? (
        <>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))',
              gap: 'var(--sp-3)',
            }}
            data-testid="feature-detail-owner-summary"
            aria-label="Ringkasan progres pemilik"
          >
            <Card>
              <KpiStat
                size="sm"
                value={<span data-testid="feature-detail-tasks">{feature.taskCount}</span>}
                label="Tugas"
              />
            </Card>
            <Card>
              <KpiStat
                size="sm"
                value={<span data-testid="feature-summary-selesai">{summary.selesai}</span>}
                label="Selesai"
              />
            </Card>
            <Card>
              <KpiStat
                size="sm"
                value={<span data-testid="feature-summary-terpetakan">{summary.terpetakan}</span>}
                label="Terpetakan"
              />
            </Card>
            <Card>
              <KpiStat
                size="sm"
                value={<span data-testid="feature-summary-terhambat">{summary.terhambat}</span>}
                label="Terhambat"
                hint={summary.terhambat > 0 ? 'Ada node terhambat' : undefined}
              />
            </Card>
            <Card>
              <KpiStat
                size="sm"
                value={
                  <span data-testid="feature-summary-perlu-tinjauan">{summary.perluTinjauan}</span>
                }
                label="Perlu tinjauan"
              />
            </Card>
            <Card>
              <KpiStat
                size="sm"
                value={
                  summary.total > 0 ? (
                    <ProgressBar
                      value={summary.selesai}
                      max={summary.total}
                      ok={summary.selesai >= summary.total}
                    />
                  ) : (
                    '—'
                  )
                }
                label="Progres selesai"
              />
            </Card>
          </div>

          <div
            style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--sp-2)' }}
            data-testid="feature-detail-stage-chips"
            aria-label="Ringkasan tahap lifecycle"
          >
            <Badge variant="neutral" data-testid="feature-detail-phase">
              Fase {feature.phase ?? '—'}
            </Badge>
            <Badge variant="neutral" data-testid="feature-detail-flow">
              Alur {branchLabel(feature.flowBranch)}
            </Badge>
            {summary.allStagesUnprojected ? (
              <StatusChip
                variant="warn"
                data-stage="UNPROJECTED"
                data-testid="feature-stage-unprojected"
                title="Data lifecycle stage belum terproyeksi dari server"
              >
                Tahap belum terproyeksi ({summary.total})
              </StatusChip>
            ) : (
              <>
                {summary.stageEntries.map(([stage, count]) => (
                  <StatusChip key={stage} variant={stageVariant(stage)} data-stage={stage} title={stage}>
                    {formatLifecycleStageLabel(stage)} · {count}
                  </StatusChip>
                ))}
                {summary.unknownStageCount > 0 ? (
                  <StatusChip
                    variant="warn"
                    data-stage="UNPROJECTED"
                    data-testid="feature-stage-unprojected-partial"
                    title="Sebagian node tanpa lifecycle stage terproyeksi"
                  >
                    Tahap belum terproyeksi ({summary.unknownStageCount})
                  </StatusChip>
                ) : null}
              </>
            )}
          </div>

          {summary.allStagesUnprojected && summary.total > 0 ? (
            <p
              data-testid="feature-stage-data-limitation"
              style={{
                margin: 0,
                fontSize: 'var(--type-small-size)',
                color: 'var(--text-dim)',
              }}
            >
              Keterbatasan data: seluruh {summary.total} node belum punya tahap lifecycle terproyeksi
              dari pin — ditampilkan jujur, bukan sebagai tahap &quot;UNKNOWN&quot;.
            </p>
          ) : null}

          <Card
            title="Node progres tugas"
            subtitle="Node di bawah berasal dari tugas yang terhubung ke fitur ini pada pin saat ini — bukan tebakan klien."
            flush
            data-testid="feature-detail-progress"
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
            {allNodes.length === 0 ? (
              <div style={{ padding: 'var(--sp-4)' }}>
                <EmptyState
                  title="Tidak ada node progres"
                  description="Tidak ada tugas terhubung pada pin ini (jujur kosong — tidak diisi tebakan)."
                  data-testid="feature-detail-progress-empty"
                />
              </div>
            ) : (
              <>
                <div
                  data-testid="feature-progress-toolbar"
                  style={{ padding: 'var(--sp-3) var(--sp-4) 0' }}
                >
                  <Toolbar
                    searchProps={{
                      id: 'feature-progress-search',
                      value: nodeQuery,
                      onChange: (e) => setNodeQuery(e.currentTarget.value),
                      placeholder: 'Cari judul node…',
                      'aria-label': 'Cari node progres',
                      autoComplete: 'off',
                      name: 'feature-progress-search',
                    }}
                  />
                  <p
                    data-testid="feature-progress-page-meta"
                    style={{
                      margin: 'var(--sp-2) 0 0',
                      fontSize: 'var(--type-caption-size)',
                      color: 'var(--text-faint)',
                    }}
                  >
                    {totalFiltered === 0
                      ? '0 node cocok'
                      : `Menampilkan ${pageStart + 1}–${Math.min(pageStart + pageSize, totalFiltered)} dari ${totalFiltered} node`}
                    {nodeQuery.trim() && totalFiltered !== allNodes.length
                      ? ` (filter dari ${allNodes.length})`
                      : ''}
                    {` · ${pageSize} per halaman`}
                  </p>
                </div>

                {totalFiltered === 0 ? (
                  <div style={{ padding: 'var(--sp-4)' }}>
                    <EmptyState
                      title="Tidak ada node yang cocok"
                      description="Tidak ada node yang cocok dengan pencarian."
                      data-testid="feature-progress-search-empty"
                      action={
                        <Button variant="ghost" size="sm" onClick={() => setNodeQuery('')}>
                          Hapus pencarian
                        </Button>
                      }
                    />
                  </div>
                ) : (
                  <div
                    data-testid="feature-detail-progress-list"
                    data-page-size={pageSize}
                    data-page-index={safePage - 1}
                    data-mounted-count={pageNodes.length}
                  >
                    <Table
                      columns={columns}
                      rows={pageNodes}
                      rowKey={(n) => n.taskId}
                      empty="Tidak ada node."
                      caption="Node progres tugas fitur"
                      aria-label="Node progres tugas fitur"
                    />
                  </div>
                )}
              </>
            )}
          </Card>

          <TechnicalDisclosure feature={feature} pin={pin} />
        </>
      ) : null}
    </div>
  )
}

function TechnicalDisclosure({
  feature,
  pin,
}: {
  feature: FeatureRowView
  pin: FeaturesPinView | null
}) {
  return (
    <Disclosure summary="Detail teknis" data-testid="feature-detail-technical">
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 'var(--sp-2)',
          fontSize: 'var(--type-small-size)',
          color: 'var(--text-dim)',
        }}
      >
        <p style={{ margin: 0 }} data-testid="feature-detail-id">
          <span style={{ color: 'var(--text-faint)' }}>featureId </span>
          <MonoCell>{feature.featureId}</MonoCell>
        </p>
        {feature.projectId ? (
          <p style={{ margin: 0 }} data-testid="feature-detail-project-id">
            <span style={{ color: 'var(--text-faint)' }}>projectId </span>
            <MonoCell>{feature.projectId}</MonoCell>
          </p>
        ) : null}
        {pin ? (
          <div data-testid="feature-detail-pin">
            <p style={{ margin: 0 }}>
              <span style={{ color: 'var(--text-faint)' }}>pin </span>
              <MonoCell>{pin.canonicalSnapshotId}</MonoCell>
            </p>
            <p style={{ margin: 0 }}>
              <span style={{ color: 'var(--text-faint)' }}>boardRev </span>
              <MonoCell>{String(pin.boardRev)}</MonoCell>
            </p>
            {pin.lifecycleRev != null ? (
              <p style={{ margin: 0 }}>
                <span style={{ color: 'var(--text-faint)' }}>lifecycleRev </span>
                <MonoCell>{String(pin.lifecycleRev)}</MonoCell>
              </p>
            ) : null}
            {pin.stale ? (
              <StatusChip variant="warn">{pin.staleReason ?? 'snapshot usang'}</StatusChip>
            ) : null}
          </div>
        ) : null}
      </div>
    </Disclosure>
  )
}
