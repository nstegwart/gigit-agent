// Task detail (board-scoped /tasks/$taskId) — Direction B design system.
// Data loaders + existing functional panels preserved; chrome via UI kit + design-system.
import { createFileRoute, useNavigate } from '@tanstack/react-router'

import { BoardLink as Link } from '#/components/BoardLink'
import { resolveTaskDisplayTitle } from '#/components/TasksTable'
import { LifecycleRail } from '#/components/LifecycleRail'
import { RunCard } from '#/components/RunCard'
import { TaskMapping } from '#/components/TaskMapping'
import { TaskSections } from '#/components/TaskSections'
import {
  Badge,
  Breadcrumb,
  Button,
  Card,
  Disclosure,
  EmptyState,
  PageHeader,
  ProgressBar,
  StatusChip,
  type StatusChipVariant,
} from '#/components/ui'
import {
  BodyText,
  ChipRow,
  DetailCol,
  DetailGrid,
  MetaRow,
  MonoCode,
  PageStack,
  ShellPageTitle,
  Stack,
  SubtitleRow,
  TechDl,
  depLinkClassName,
} from '#/design-system'
import {
  boardQueryOptions,
  lifecycleQueryOptions,
  taskLifecycleQueryOptions,
  tasksQueryOptions,
  useBoard,
  useBoardId,
  useLifecycle,
  useTaskLazy,
  useTaskLifecycle,
  useTasks,
} from '#/lib/board-query'
import { formatLifecycleStageLabel } from '#/lib/display-label'
import { fmtDate } from '#/lib/format'
import { stageReadiness } from '#/lib/readiness'

export const Route = createFileRoute('/b/$boardId/tasks/$taskId')({
  loader: async ({ context, params }) => {
    await Promise.all([
      context.queryClient.ensureQueryData(tasksQueryOptions(params.boardId)),
      context.queryClient.ensureQueryData(boardQueryOptions(params.boardId)),
      context.queryClient.ensureQueryData(lifecycleQueryOptions(params.boardId)),
      context.queryClient.ensureQueryData(
        taskLifecycleQueryOptions(params.boardId, params.taskId),
      ),
    ])
  },
  component: View,
})

function stageVariant(stage: string | null | undefined): StatusChipVariant {
  if (!stage) return 'pending'
  const s = stage.toUpperCase()
  if (/PROD_READY|LIVE_VERIFIED|DONE|SELESAI|PASS/.test(s)) return 'done'
  if (/BLOCK|HOLD|STOP|FAIL/.test(s)) return 'blocked'
  if (/MAP|DRAFT|QUEUED|PENDING|INIT/.test(s)) return 'pending'
  if (/WARN|REVIEW|CONTENT/.test(s)) return 'warn'
  if (/NEXT|READY_FOR/.test(s)) return 'next'
  return 'ongoing'
}

function View() {
  const { byId } = useTasks()
  const m = useBoard()
  const cfg = useLifecycle()
  const boardId = useBoardId()
  const navigate = useNavigate()
  const { taskId } = Route.useParams()
  const { data: lc } = useTaskLifecycle(taskId)
  const { data: full, isLoading: loadingFull } = useTaskLazy(taskId)
  const agents = m.runsByTask[taskId] ?? []
  const tasksHref = `/b/${boardId}/tasks`
  const goList = () =>
    navigate({ to: '/b/$boardId/tasks', params: { boardId } })

  const base = full ?? byId[taskId]
  if (!base) {
    return (
      <PageStack data-testid="task-detail-missing">
        <ShellPageTitle
          title="Tasks · Tugas"
          subtitle="Tugas tidak ditemukan pada board ini."
        />
        <PageHeader
          eyebrow="Detail tugas"
          title="Tugas tidak ditemukan"
          breadcrumb={
            <Breadcrumb
              items={[
                { label: 'Tugas', href: tasksHref },
                { label: taskId },
              ]}
            />
          }
          actions={
            <Button variant="secondary" size="sm" onClick={goList}>
              Kembali ke daftar
            </Button>
          }
        />
        {loadingFull ? (
          <EmptyState title="Memuat…" description="Menarik ringkasan tugas." />
        ) : (
          <EmptyState
            title="Tugas tidak ditemukan"
            description={`ID ${taskId} tidak ada di board ini.`}
            action={
              <Button variant="primary" size="sm" onClick={goList}>
                Ke daftar tugas
              </Button>
            }
          />
        )}
      </PageStack>
    )
  }

  const total = base.checkpoints.length
  const done = base.checkpoints.filter((c) => c.done).length
  const t = { ...base, total, done, pct: total ? Math.round((done / total) * 100) : 0 }
  const stage = lc?.stage ?? base.lifecycleStage ?? null
  const readyPct = stageReadiness(cfg, stage)
  const humanTitle = resolveTaskDisplayTitle(t)

  const story = full?.story
  const hasStory = !!(story && (story.userStory || story.currentGap || story.targetScope))
  const refs = full?.refs
  const api = refs?.api ?? []
  const pages = refs?.pages ?? []
  const hasRefs = !!(refs && (refs.evidence || api.length || pages.length))

  const sourceHash = (() => {
    const f = (full ?? {}) as Record<string, unknown>
    return (f.canonicalSha ??
      f.sourceSha ??
      f.canonicalHash ??
      f.sourceHash ??
      f.sha) as string | undefined
  })()

  return (
    <PageStack data-testid="task-detail-route">
      <ShellPageTitle
        title={`Tasks · Tugas / ${humanTitle}`}
        subtitle="Detail tugas, kesiapan, dan peta checkpoint."
      />
      <PageHeader
        eyebrow="Detail tugas"
        title={humanTitle}
        subtitle={
          <SubtitleRow>
            <Badge mono variant="neutral">
              {t.id}
            </Badge>
            {stage ? (
              <StatusChip variant={stageVariant(stage)} showDot>
                {formatLifecycleStageLabel(stage) || stage}
              </StatusChip>
            ) : t.phase ? (
              <StatusChip variant="pending" showDot>
                {t.phase}
              </StatusChip>
            ) : null}
            {t.projectId ? (
              <Badge mono variant="neutral">
                {t.projectId}
              </Badge>
            ) : null}
            {t.scope ? <Badge variant="neutral">{t.scope}</Badge> : null}
          </SubtitleRow>
        }
        breadcrumb={
          <Breadcrumb
            items={[
              { label: 'Tugas', href: tasksHref },
              { label: humanTitle },
            ]}
          />
        }
        actions={
          <Button variant="secondary" size="sm" onClick={goList}>
            ← Daftar tugas
          </Button>
        }
      />

      <Card title="Kesiapan produksi" subtitle="Dari rel lifecycle board">
        <ProgressBar
          value={readyPct}
          max={100}
          ok={readyPct >= 100}
          label={`${readyPct}% siap produksi`}
        />
      </Card>

      <LifecycleRail taskId={taskId} checkpoints={t.checkpoints} fallbackStage={stage} />

      <TaskSections sections={full?.sections} />

      <DetailGrid>
        <DetailCol>
          {agents.length > 0 ? (
            <Card
              title="Agen pada tugas ini"
              headerActions={<Badge variant="neutral">{agents.length}</Badge>}
            >
              <Stack>
                {agents.map((r) => (
                  <RunCard key={r.id} run={r} model={m} taskTitle={humanTitle} />
                ))}
              </Stack>
            </Card>
          ) : null}

          {t.objective || t.next ? (
            <Card title="Tujuan">
              {t.objective ? <BodyText>{t.objective}</BodyText> : null}
              {t.next ? (
                <MetaRow label="Berikutnya">{t.next}</MetaRow>
              ) : null}
            </Card>
          ) : null}

          {hasStory ? (
            <Card title="Cerita">
              {story?.userStory ? (
                <MetaRow label="User story">{story.userStory}</MetaRow>
              ) : null}
              {story?.currentGap ? (
                <MetaRow label="Kesenjangan saat ini">{story.currentGap}</MetaRow>
              ) : null}
              {story?.targetScope ? (
                <MetaRow label="Cakupan target">{story.targetScope}</MetaRow>
              ) : null}
            </Card>
          ) : null}
        </DetailCol>

        <DetailCol>
          <Card title="Ringkasan">
            <MetaRow label="Progress checkpoint">
              <ProgressBar
                value={t.done}
                max={t.total || 1}
                ok={t.pct === 100}
                label={`${t.done}/${t.total} (${t.pct}%)`}
              />
            </MetaRow>
            {t.group ? (
              <MetaRow label="Grup">
                <Badge variant="neutral">{t.group}</Badge>
              </MetaRow>
            ) : null}
            {t.status ? <MetaRow label="Status">{t.status}</MetaRow> : null}
            {typeof t.mappingPct === 'number' ? (
              <MetaRow label="Pemetaan">{t.mappingPct}%</MetaRow>
            ) : null}
            {t.updated ? (
              <MetaRow label="Diperbarui">{fmtDate(t.updated)}</MetaRow>
            ) : null}
          </Card>

          {t.dependencies.length ? (
            <Card
              title="Dependensi"
              headerActions={<Badge variant="neutral">{t.dependencies.length}</Badge>}
            >
              <ChipRow>
                {t.dependencies.map((d) => (
                  <Link
                    key={d}
                    to="/tasks/$taskId"
                    params={{ taskId: d }}
                    className={depLinkClassName}
                  >
                    <StatusChip variant="warn" showDot>
                      {byId[d] ? resolveTaskDisplayTitle(byId[d]) : d}
                    </StatusChip>
                  </Link>
                ))}
              </ChipRow>
            </Card>
          ) : null}

          {t.impacts.length ? (
            <Card
              title="Dampak"
              headerActions={<Badge variant="neutral">{t.impacts.length}</Badge>}
            >
              <ChipRow>
                {t.impacts.map((x) => (
                  <Badge key={x} variant="neutral">
                    {x}
                  </Badge>
                ))}
              </ChipRow>
            </Card>
          ) : null}

          {hasRefs ? (
            <Card title="Referensi">
              {api.length ? (
                <MetaRow label="API">
                  <ChipRow>
                    {api.map((x) => (
                      <Badge key={x} mono variant="neutral">
                        {x}
                      </Badge>
                    ))}
                  </ChipRow>
                </MetaRow>
              ) : null}
              {pages.length ? (
                <MetaRow label="Halaman">
                  <ChipRow>
                    {pages.map((x) => (
                      <Badge key={x} mono variant="neutral">
                        {x}
                      </Badge>
                    ))}
                  </ChipRow>
                </MetaRow>
              ) : null}
              {refs?.evidence ? (
                <MetaRow label="Bukti">{refs.evidence}</MetaRow>
              ) : null}
            </Card>
          ) : null}

          <Disclosure summary="Detail teknis" data-testid="task-detail-technical-disclosure">
            <TechDl>
              <dt>taskId</dt>
              <dd>
                <MonoCode>{t.id}</MonoCode>
              </dd>
              <dt>technicalTitle</dt>
              <dd>{t.title || '—'}</dd>
              {t.featureContractId ? (
                <>
                  <dt>featureContractId</dt>
                  <dd>
                    <MonoCode>{t.featureContractId}</MonoCode>
                  </dd>
                </>
              ) : null}
              {sourceHash ? (
                <>
                  <dt>sourceHash</dt>
                  <dd>
                    <MonoCode>{sourceHash}</MonoCode>
                  </dd>
                </>
              ) : null}
              {lc?.rev != null ? (
                <>
                  <dt>revision</dt>
                  <dd>
                    <MonoCode>{lc.rev}</MonoCode>
                  </dd>
                </>
              ) : null}
              {lc?.implementerRun ? (
                <>
                  <dt>implementerRun</dt>
                  <dd>
                    <MonoCode>{lc.implementerRun}</MonoCode>
                  </dd>
                </>
              ) : null}
              {stage ? (
                <>
                  <dt>lifecycleStage</dt>
                  <dd>
                    <MonoCode>{stage}</MonoCode>
                  </dd>
                </>
              ) : null}
            </TechDl>
          </Disclosure>
        </DetailCol>
      </DetailGrid>

      {full ? (
        <TaskMapping task={t} />
      ) : loadingFull ? (
        <Card title="Pemetaan rebuild" subtitle="Memuat…">
          <EmptyState
            title="Memuat pemetaan"
            description="Menarik pemetaan 20 poin untuk tugas ini."
          />
        </Card>
      ) : null}
    </PageStack>
  )
}
