/**
 * C3-W1: Authenticated server functions for control-center surfaces.
 * One load → one pin → surface projection. Client never recomputes truth.
 * Returns JSON-serializable wire envelopes (TanStack Start server-fn constraint).
 */

import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'

import { requireView, AuthError, currentUser } from '#/server/auth'
import { loadControlCenterAggregation } from '#/server/control-center-ui-adapter'
import {
  createPinnedEnvelope,
  envelopeError,
  envelopeForbidden,
  projectAgents,
  projectDecisions,
  projectEvidence,
  projectFeatures,
  projectOps,
  projectOverview,
  projectPriority,
  projectProjects,
  projectTaskDetail,
  projectWork,
  type ControlCenterAggregation,
  type ControlCenterSurface,
  type PinnedEnvelope,
  type UiSurfaceState,
} from '#/server/control-center-ui'
import {
  readOpsAccountSourceService,
} from '#/server/account-surface-readers'
import { peekControlPlaneRuntimeContext } from '#/server/control-plane-runtime-context'
import { getSharedAccountSyncStore } from '#/server/account-sync'
import type { PrimaryBucket, StaleOverlayKind } from '#/lib/control-plane-types'
import type { Json } from '#/lib/types'

const board = z.string().min(1)
const cursorSchema = z.string().nullable().optional()
const pageSizeSchema = z.number().int().min(1).max(200).nullable().optional()

const PRIMARY_BUCKETS = [
  'DONE',
  'RECONCILIATION_PENDING',
  'ONGOING',
  'NEXT',
  'QUEUED',
  'BLOCKED',
] as const

const workArgs = z.object({
  boardId: board,
  bucket: z.enum(PRIMARY_BUCKETS).nullable().optional(),
  overlay: z.string().nullable().optional(),
  staleFamily: z.boolean().nullable().optional(),
  cursor: cursorSchema,
  pageSize: pageSizeSchema,
})

const cursorArgs = z.object({
  boardId: board,
  cursor: cursorSchema,
  pageSize: pageSizeSchema,
})

const boardArgs = z.object({ boardId: board })

/**
 * Wire shape for server-fn transport.
 * Drops non-serializable `error.details` (`unknown` index signature fails Start ValidateSerializable).
 * Client query types still accept this as PinnedEnvelope structurally for data fields.
 */
export type ControlCenterWireEnvelope = {
  schemaVersion: 'TM_PINNED_ENVELOPE_V1'
  boardId: string
  canonicalSnapshotId: string
  canonicalHash: string
  boardRev: number
  lifecycleRev: number
  generatedAt: string
  freshnessAgeSeconds: number
  stale: boolean
  staleReason: string | null
  /** JSON-serializable surface payload (Start ValidateSerializable). */
  data: Json
  nextCursor: string | null
  surfaceState: UiSurfaceState
  surface: ControlCenterSurface | 'common' | null
  error: { code: string; message: string } | null
}

function toWireEnvelope(env: PinnedEnvelope<unknown>): ControlCenterWireEnvelope {
  // Round-trip guarantees JSON-serializable data for Start server-fn transport.
  const data = JSON.parse(JSON.stringify(env.data ?? null)) as Json
  return {
    schemaVersion: env.schemaVersion,
    boardId: env.boardId,
    canonicalSnapshotId: env.canonicalSnapshotId,
    canonicalHash: env.canonicalHash,
    boardRev: env.boardRev,
    lifecycleRev: env.lifecycleRev,
    generatedAt: env.generatedAt,
    freshnessAgeSeconds: env.freshnessAgeSeconds,
    stale: env.stale,
    staleReason: env.staleReason,
    data,
    nextCursor: env.nextCursor,
    surfaceState: env.surfaceState,
    surface: env.surface,
    error: env.error
      ? { code: env.error.code, message: env.error.message }
      : null,
  }
}

function mapAuthError(e: unknown, surface: ControlCenterSurface): ControlCenterWireEnvelope {
  if (e instanceof AuthError) {
    if (e.status === 401 || e.status === 403) {
      return toWireEnvelope(envelopeForbidden(null, surface))
    }
  }
  const message = e instanceof Error ? e.message : String(e)
  return toWireEnvelope(envelopeError(null, 'DATA_INTEGRITY', message, surface))
}

async function withBoardAgg(
  boardId: string,
  surface: ControlCenterSurface,
  project: (agg: Awaited<ReturnType<typeof loadControlCenterAggregation>>) => PinnedEnvelope<unknown>,
): Promise<ControlCenterWireEnvelope> {
  try {
    await requireView(boardId)
    const agg = await loadControlCenterAggregation(boardId)
    return toWireEnvelope(project(agg))
  } catch (e) {
    return mapAuthError(e, surface)
  }
}

export const getControlCenterOverviewFn = createServerFn({ method: 'GET' })
  .validator(boardArgs)
  .handler(async ({ data }): Promise<ControlCenterWireEnvelope> => {
    return withBoardAgg(data.boardId, 'overview', (agg) => projectOverview(agg))
  })

export const getControlCenterWorkFn = createServerFn({ method: 'GET' })
  .validator(workArgs)
  .handler(async ({ data }): Promise<ControlCenterWireEnvelope> => {
    return withBoardAgg(data.boardId, 'work', (agg) =>
      projectWork(agg, {
        bucket: (data.bucket as PrimaryBucket | null | undefined) ?? null,
        overlay: (data.overlay as StaleOverlayKind | null | undefined) ?? null,
        staleFamily: data.staleFamily ?? null,
        cursor: data.cursor ?? null,
        pageSize: data.pageSize ?? null,
      }),
    )
  })

export const getControlCenterPriorityFn = createServerFn({ method: 'GET' })
  .validator(boardArgs)
  .handler(async ({ data }): Promise<ControlCenterWireEnvelope> => {
    return withBoardAgg(data.boardId, 'priority', (agg) => projectPriority(agg))
  })

export const getControlCenterProjectsFn = createServerFn({ method: 'GET' })
  .validator(boardArgs)
  .handler(async ({ data }): Promise<ControlCenterWireEnvelope> => {
    return withBoardAgg(data.boardId, 'projects', (agg) => projectProjects(agg))
  })

export const getControlCenterFeaturesFn = createServerFn({ method: 'GET' })
  .validator(cursorArgs)
  .handler(async ({ data }): Promise<ControlCenterWireEnvelope> => {
    return withBoardAgg(data.boardId, 'features', (agg) =>
      projectFeatures(agg, {
        cursor: data.cursor ?? null,
        pageSize: data.pageSize ?? null,
      }),
    )
  })

export const getControlCenterAgentsFn = createServerFn({ method: 'GET' })
  .validator(cursorArgs)
  .handler(async ({ data }): Promise<ControlCenterWireEnvelope> => {
    return withBoardAgg(data.boardId, 'agents', (agg) =>
      projectAgents(agg, {
        cursor: data.cursor ?? null,
        pageSize: data.pageSize ?? null,
      }),
    )
  })

export const getControlCenterOpsFn = createServerFn({ method: 'GET' })
  .validator(boardArgs)
  .handler(async ({ data }): Promise<ControlCenterWireEnvelope> => {
    try {
      await requireView(data.boardId)
      const user = await currentUser()
      const ctx = peekControlPlaneRuntimeContext()
      const accounts = ctx?.runtime.accounts ?? getSharedAccountSyncStore()
      // Ops product account source service (real serializer + auth + schema identity).
      const opsAccount = await readOpsAccountSourceService({
        boardId: data.boardId,
        accounts,
        auth: {
          kind: 'session',
          user: user
            ? { id: user.id, role: user.role, boards: user.boards }
            : null,
        },
      })
      const agg = await loadControlCenterAggregation(data.boardId)
      const env = projectOps(agg)
      // Stamp ops account source identity onto wire data when present (same revision proof).
      if (opsAccount && env.data && typeof env.data === 'object') {
        const stamped = {
          ...env.data,
          sourceRevision: env.data.sourceRevision ?? opsAccount.sourceRevision,
          accountGeneratedAt: env.data.accountGeneratedAt ?? opsAccount.generatedAt,
          opsAccountSchema: opsAccount.schema,
        }
        return toWireEnvelope({ ...env, data: stamped })
      }
      return toWireEnvelope(env)
    } catch (e) {
      return mapAuthError(e, 'ops')
    }
  })

export const getControlCenterDecisionsFn = createServerFn({ method: 'GET' })
  .validator(cursorArgs)
  .handler(async ({ data }): Promise<ControlCenterWireEnvelope> => {
    return withBoardAgg(data.boardId, 'decisions', (agg) =>
      projectDecisions(agg, {
        cursor: data.cursor ?? null,
        pageSize: data.pageSize ?? null,
      }),
    )
  })

export const getControlCenterEvidenceFn = createServerFn({ method: 'GET' })
  .validator(cursorArgs)
  .handler(async ({ data }): Promise<ControlCenterWireEnvelope> => {
    return withBoardAgg(data.boardId, 'evidence', (agg) =>
      projectEvidence(agg, {
        cursor: data.cursor ?? null,
        pageSize: data.pageSize ?? null,
      }),
    )
  })

const taskArgs = z.object({
  boardId: board,
  taskId: z.string().min(1),
})

const decisionDetailArgs = z.object({
  boardId: board,
  decisionId: z.string().min(1),
  cursor: cursorSchema,
  pageSize: pageSizeSchema,
})

const domainArgs = z.object({
  boardId: board,
  domain: z.string().min(1),
})

const searchArgs = z.object({
  boardId: board,
  q: z.string().nullable().optional(),
})

/**
 * ART S09–S10: pinned task detail via projectTaskDetail (humanDisplay + technical demote).
 * Returns data:null + zero-results when task is absent from the pin set.
 */
export const getControlCenterTaskFn = createServerFn({ method: 'GET' })
  .validator(taskArgs)
  .handler(async ({ data }): Promise<ControlCenterWireEnvelope> => {
    return withBoardAgg(data.boardId, 'work', (agg) => {
      const detail = projectTaskDetail(agg, data.taskId)
      if (!detail) {
        return createPinnedEnvelope(agg.pin, null, {
          surface: 'work',
          surfaceState: 'zero-results',
          nextCursor: null,
          error: {
            code: 'NOT_FOUND',
            message: `Task ${data.taskId} not found in pinned control-center set`,
          },
        })
      }
      return createPinnedEnvelope(agg.pin, detail as unknown as Json, {
        surface: 'work',
        surfaceState: agg.pin.stale ? 'stale' : 'populated',
        nextCursor: null,
      })
    })
  })

/**
 * ART S12: decision detail from the same pinned decisions envelope (no dual truth).
 */
export const getControlCenterDecisionDetailFn = createServerFn({ method: 'GET' })
  .validator(decisionDetailArgs)
  .handler(async ({ data }): Promise<ControlCenterWireEnvelope> => {
    return withBoardAgg(data.boardId, 'decisions', (agg) => {
      const env = projectDecisions(agg, {
        cursor: data.cursor ?? null,
        pageSize: data.pageSize ?? null,
      })
      const rows = env.data?.items?.length ? env.data.items : env.data?.decisions ?? []
      const found = rows.find((r) => r.decisionId === data.decisionId) ?? null
      if (!found) {
        // Still return full list envelope so clients can show honest not-found against pin.
        return createPinnedEnvelope(agg.pin, env.data as unknown as Json, {
          surface: 'decisions',
          surfaceState: 'zero-results',
          nextCursor: env.nextCursor,
          error: {
            code: 'NOT_FOUND',
            message: `Decision ${data.decisionId} not found in pinned inbox`,
          },
        })
      }
      return env
    })
  })

/**
 * Honest domain hit detection over pin fields.
 * Matches full domain token (AFFILIATE) or a short stem (AFF) so task ids like
 * T-AFF-N16… surface without inventing readiness for empty domains.
 */
function domainTokenMatch(domain: string, ...fields: Array<string | null | undefined>): boolean {
  const d = domain.trim().toUpperCase()
  if (!d) return false
  const stems = new Set<string>([d])
  if (d.length >= 3) stems.add(d.slice(0, 3))
  for (const f of fields) {
    if (typeof f !== 'string' || f.length === 0) continue
    const u = f.toUpperCase()
    for (const s of stems) {
      if (u.includes(s) || (s.length >= 3 && s.includes(u))) return true
    }
  }
  return false
}

/**
 * Project knowledge domain from current pin only — never invent AFFILIATE readiness.
 * Unavailable/partial when no matching project/feature/task/evidence rows.
 */
export function projectKnowledgeDomainFromAgg(
  agg: ControlCenterAggregation,
  domain: string,
): PinnedEnvelope<Json> {
  const d = domain.trim()
  const projects = agg.projects
    .filter((p) => domainTokenMatch(d, p.id, p.name))
    .map((p) => ({ id: p.id, name: p.name, taskCount: p.taskCount }))
  const features = agg.features
    .filter((f) => domainTokenMatch(d, f.id, f.name ?? null))
    .map((f) => ({ id: f.id, name: f.name ?? null }))
  const tasks = agg.workRows
    .filter((t) =>
      domainTokenMatch(
        d,
        t.taskId,
        t.title,
        t.projectId,
        t.featureId,
        t.ownerHumanDisplay?.ownerPrimaryTitle,
      ),
    )
    .slice(0, 50)
    .map((t) => ({
      taskId: t.taskId,
      title: t.title,
      bucket: t.bucket,
      ownerPrimaryTitle: t.ownerHumanDisplay?.ownerPrimaryTitle ?? null,
    }))
  const decisions = agg.decisions
    .filter((dec) =>
      domainTokenMatch(d, dec.decisionId, dec.title, dec.projectId, dec.featureId, dec.taskId),
    )
    .slice(0, 30)
    .map((dec) => ({
      decisionId: dec.decisionId,
      title: dec.title,
      status: dec.status,
    }))
  const evidence = agg.auditEvents
    .filter((e) => domainTokenMatch(d, e.id, e.kind, e.summary))
    .slice(0, 30)
    .map((e) => ({ id: e.id, kind: e.kind, summary: e.summary ?? '' }))

  const hitCount =
    projects.length + features.length + tasks.length + decisions.length + evidence.length
  const gaps: string[] = []
  if (projects.length === 0) gaps.push('NO_MATCHING_PROJECTS')
  if (features.length === 0) gaps.push('NO_MATCHING_FEATURES')
  if (tasks.length === 0) gaps.push('NO_MATCHING_TASKS')
  if (decisions.length === 0) gaps.push('NO_MATCHING_DECISIONS')
  if (evidence.length === 0) gaps.push('NO_MATCHING_EVIDENCE')

  let availability: 'available' | 'partial' | 'unavailable' = 'unavailable'
  if (hitCount === 0) availability = 'unavailable'
  else if (gaps.length > 0) availability = 'partial'
  else availability = 'available'

  const surfaceState: UiSurfaceState =
    availability === 'unavailable'
      ? 'empty'
      : availability === 'partial'
        ? 'partial'
        : agg.pin.stale
          ? 'stale'
          : 'populated'

  const summary =
    availability === 'unavailable'
      ? `Domain ${d} tidak punya data ter-pin di board ${agg.pin.boardId}. Tidak ada kesiapan palsu.`
      : availability === 'partial'
        ? `Domain ${d}: data parsial dari pin saat ini (${hitCount} hit). Gap: ${gaps.join(', ')}.`
        : `Domain ${d}: data tersedia dari pin board/project/feature/task/evidence.`

  const data = {
    domain: d,
    title: d,
    summary,
    availability,
    surfaceState,
    projects,
    features,
    tasks,
    decisions,
    evidence,
    gaps,
  }

  return createPinnedEnvelope(agg.pin, data as unknown as Json, {
    surface: 'common',
    surfaceState,
    nextCursor: null,
  })
}

export const getControlCenterKnowledgeDomainFn = createServerFn({ method: 'GET' })
  .validator(domainArgs)
  .handler(async ({ data }): Promise<ControlCenterWireEnvelope> => {
    try {
      await requireView(data.boardId)
      const agg = await loadControlCenterAggregation(data.boardId)
      return toWireEnvelope(projectKnowledgeDomainFromAgg(agg, data.domain))
    } catch (e) {
      return mapAuthError(e, 'common' as ControlCenterSurface)
    }
  })

/**
 * ART S15–S16 search over pinned work/project/feature/decision/evidence.
 * Human title first; technical id as alias. Never invents hits.
 */
export function projectSearchFromAgg(
  agg: ControlCenterAggregation,
  qRaw: string | null | undefined,
): PinnedEnvelope<Json> {
  const q = (qRaw ?? '').trim()
  if (!q) {
    return createPinnedEnvelope(
      agg.pin,
      { query: '', results: [] } as unknown as Json,
      { surface: 'common', surfaceState: 'empty', nextCursor: null },
    )
  }
  const needle = q.toLowerCase()
  const results: Array<{
    kind: 'task' | 'project' | 'feature' | 'decision' | 'evidence'
    id: string
    title: string
    subtitle: string | null
    href: string
    technicalAlias: string | null
  }> = []

  for (const t of agg.workRows) {
    const owner = t.ownerHumanDisplay?.ownerPrimaryTitle ?? null
    const hay = [t.taskId, t.title, owner, t.projectId, t.featureId]
      .filter(Boolean)
      .join('\n')
      .toLowerCase()
    if (!hay.includes(needle)) continue
    results.push({
      kind: 'task',
      id: t.taskId,
      title: owner && owner.length > 0 ? owner : t.title,
      subtitle: t.bucket,
      href: `/work/${encodeURIComponent(t.taskId)}`,
      technicalAlias: t.taskId,
    })
  }
  for (const p of agg.projects) {
    const hay = [p.id, p.name].filter(Boolean).join('\n').toLowerCase()
    if (!hay.includes(needle)) continue
    results.push({
      kind: 'project',
      id: p.id,
      title: p.name ?? p.id,
      subtitle: `tasks:${p.taskCount}`,
      href: `/b/${encodeURIComponent(agg.pin.boardId)}/projects/${encodeURIComponent(p.id)}`,
      technicalAlias: p.id,
    })
  }
  for (const f of agg.features) {
    const hay = [f.id, f.name].filter(Boolean).join('\n').toLowerCase()
    if (!hay.includes(needle)) continue
    results.push({
      kind: 'feature',
      id: f.id,
      title: f.name ?? f.id,
      subtitle: null,
      href: `/b/${encodeURIComponent(agg.pin.boardId)}/features/${encodeURIComponent(f.id)}`,
      technicalAlias: f.id,
    })
  }
  for (const dec of agg.decisions) {
    const hay = [dec.decisionId, dec.title, dec.question].filter(Boolean).join('\n').toLowerCase()
    if (!hay.includes(needle)) continue
    results.push({
      kind: 'decision',
      id: dec.decisionId,
      title: dec.title,
      subtitle: dec.status,
      href: `/decisions/${encodeURIComponent(dec.decisionId)}`,
      technicalAlias: dec.decisionId,
    })
  }
  for (const e of agg.auditEvents) {
    const hay = [e.id, e.kind, e.summary].filter(Boolean).join('\n').toLowerCase()
    if (!hay.includes(needle)) continue
    results.push({
      kind: 'evidence',
      id: e.id,
      title: e.summary ?? e.kind,
      subtitle: e.kind,
      href: `/b/${encodeURIComponent(agg.pin.boardId)}/evidence`,
      technicalAlias: e.id,
    })
  }

  const surfaceState: UiSurfaceState =
    results.length === 0 ? 'zero-results' : agg.pin.stale ? 'stale' : 'populated'

  return createPinnedEnvelope(
    agg.pin,
    { query: q, results: results.slice(0, 100) } as unknown as Json,
    { surface: 'common', surfaceState, nextCursor: null },
  )
}

export const getControlCenterSearchFn = createServerFn({ method: 'GET' })
  .validator(searchArgs)
  .handler(async ({ data }): Promise<ControlCenterWireEnvelope> => {
    try {
      await requireView(data.boardId)
      const agg = await loadControlCenterAggregation(data.boardId)
      return toWireEnvelope(projectSearchFromAgg(agg, data.q ?? null))
    } catch (e) {
      return mapAuthError(e, 'common' as ControlCenterSurface)
    }
  })

/**
 * ART S17 documentation domain export preview — citations from humanDisplay only.
 * Honest unavailable when no domain hits in pin.
 */
export function projectDocumentationDomainFromAgg(
  agg: ControlCenterAggregation,
  domain: string,
): PinnedEnvelope<Json> {
  const knowledge = projectKnowledgeDomainFromAgg(agg, domain)
  const k = knowledge.data as {
    domain: string
    availability: string
    projects: Array<{ id: string; name: string | null }>
    features: Array<{ id: string; name: string | null }>
    tasks: Array<{ taskId: string; title: string; ownerPrimaryTitle: string | null }>
    decisions: Array<{ decisionId: string; title: string }>
    gaps: string[]
  } | null

  if (!k || k.availability === 'unavailable') {
    return createPinnedEnvelope(
      agg.pin,
      {
        domain: domain.trim(),
        title: domain.trim(),
        availability: 'unavailable',
        bodyMarkdown: '',
        citations: [],
        gaps: k?.gaps ?? ['NO_PINNED_DOCUMENTATION'],
      } as unknown as Json,
      { surface: 'common', surfaceState: 'empty', nextCursor: null },
    )
  }

  const lines: string[] = [
    `# Dokumentasi domain: ${k.domain}`,
    '',
    `_Pin: ${agg.pin.canonicalSnapshotId} · boardRev ${agg.pin.boardRev}_`,
    '',
  ]
  if (k.projects.length) {
    lines.push('## Proyek', ...k.projects.map((p) => `- ${p.name ?? p.id} (\`${p.id}\`)`), '')
  }
  if (k.features.length) {
    lines.push('## Fitur', ...k.features.map((f) => `- ${f.name ?? f.id} (\`${f.id}\`)`), '')
  }
  if (k.tasks.length) {
    lines.push(
      '## Tugas (owner-first)',
      ...k.tasks.map(
        (t) =>
          `- ${t.ownerPrimaryTitle && t.ownerPrimaryTitle.length > 0 ? t.ownerPrimaryTitle : t.title} (\`${t.taskId}\`)`,
      ),
      '',
    )
  }
  if (k.decisions.length) {
    lines.push(
      '## Keputusan',
      ...k.decisions.map((d) => `- ${d.title} (\`${d.decisionId}\`)`),
      '',
    )
  }
  if (k.gaps.length) {
    lines.push('## Gap jujur', ...k.gaps.map((g) => `- ${g}`), '')
  }

  const citations: Array<{ field: string; path: string; note?: string }> = []
  for (const t of k.tasks.slice(0, 20)) {
    citations.push({
      field: 'task',
      path: `workRows.${t.taskId}`,
      note: t.ownerPrimaryTitle ?? t.title,
    })
  }
  for (const p of k.projects.slice(0, 10)) {
    citations.push({ field: 'project', path: `projects.${p.id}`, note: p.name ?? p.id })
  }

  return createPinnedEnvelope(
    agg.pin,
    {
      domain: k.domain,
      title: k.domain,
      availability: k.availability,
      bodyMarkdown: lines.join('\n'),
      citations,
      gaps: k.gaps,
    } as unknown as Json,
    {
      surface: 'common',
      surfaceState: k.availability === 'partial' ? 'partial' : knowledge.surfaceState,
      nextCursor: null,
    },
  )
}

export const getControlCenterDocumentationDomainFn = createServerFn({ method: 'GET' })
  .validator(domainArgs)
  .handler(async ({ data }): Promise<ControlCenterWireEnvelope> => {
    try {
      await requireView(data.boardId)
      const agg = await loadControlCenterAggregation(data.boardId)
      return toWireEnvelope(projectDocumentationDomainFromAgg(agg, data.domain))
    } catch (e) {
      return mapAuthError(e, 'common' as ControlCenterSurface)
    }
  })
