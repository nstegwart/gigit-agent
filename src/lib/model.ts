// buildModel — the adapter. Turns the raw plan.json + runs.json shape into a typed,
// UI-ready Model. Pure (no fs, no DOM) so it runs on server, client, and in tests.
// This is the canonical spec of the board's derived data.
import { ACTIVE_PHASES, PALETTE, PHASE_CLS } from './format'
import type { ActivityEvent, Feature, Model, Project, RawBoard, Run } from './types'

export function buildModel(raw: RawBoard): Model {
  const faseLabel = raw.fase_label ?? {}
  const fasePersen = raw.fase_persen ?? {}
  const design = raw.design ?? { projects: {}, features: {} }
  const collab = raw.collab ?? { comments: {}, activity: [] }

  const projects: Array<Project> = (raw.projects ?? []).map((p, i) => ({
    ...p,
    color: p.color ?? PALETTE[i % PALETTE.length],
    features: [],
    progress: 0,
    activeAgents: 0,
    design: [],
  }))

  // track -> project id
  const track2proj: Record<string, string> = {}
  for (const p of projects) for (const t of p.tracks ?? []) track2proj[t] = p.id

  const runs: Array<Run> = (raw.runs ?? []).map((r) => ({ ...r }))
  const runsByFeature: Record<string, Array<Run>> = {}
  const runsByTask: Record<string, Array<Run>> = {}
  for (const r of runs) {
    if (r.feature) (runsByFeature[r.feature] ??= []).push(r)
    if (r.taskId) (runsByTask[r.taskId] ??= []).push(r)
  }

  const features: Array<Feature> = (raw.features ?? []).map((f) => {
    const checklist = f.checklist ?? []
    const total = checklist.length
    const done = checklist.filter((c) => c.done).length
    const parked = f.bucket === 'nanti'
    return {
      ...f,
      projectId: f.track ? (track2proj[f.track] ?? null) : null,
      taskTotal: total,
      taskDone: done,
      parked,
      isBlocked: Boolean(f.blocked),
      isDone: f.fase === 'done',
      pct: parked ? null : (fasePersen[f.fase] ?? 0),
      phaseLabel: faseLabel[f.fase] ?? String(f.fase),
      phaseCls: PHASE_CLS[f.fase] ?? 'ph-backlog',
      runs: runsByFeature[f.id] ?? [],
      design: design.features[f.id] ?? [],
      comments: collab.comments[f.id] ?? [],
      depth: 0,
    }
  })

  const featById: Record<string, Feature> = {}
  for (const f of features) featById[f.id] = f

  // dependency depth (longest chain from a root) for the wire graph layout
  const depthCache: Record<string, number> = {}
  const seen = new Set<string>()
  const depthOf = (id: string): number => {
    if (depthCache[id] != null) return depthCache[id]
    if (seen.has(id)) return 0 // cycle guard
    seen.add(id)
    const f = featById[id]
    const deps = (f?.deps ?? []).filter((d) => featById[d])
    const d = deps.length ? 1 + Math.max(...deps.map(depthOf)) : 0
    seen.delete(id)
    depthCache[id] = d
    return d
  }
  for (const f of features) f.depth = depthOf(f.id)

  const projById: Record<string, Project> = {}
  for (const p of projects) {
    projById[p.id] = p
    p.features = features.filter((f) => f.projectId === p.id)
    const live = p.features.filter((f) => !f.parked)
    p.progress = live.length
      ? Math.round(live.reduce((s, f) => s + (f.pct ?? 0), 0) / live.length)
      : 0
    p.activeAgents = runs.filter((r) => r.project === p.id && r.status === 'running').length
    p.design = design.projects[p.id] ?? []
  }

  // activity feed = plan.log[] + collab.activity[], newest first
  const activity: Array<ActivityEvent> = [
    ...(raw.log ?? []).map((l) => ({ ts: l.tanggal, actor: 'log', kind: 'log', text: l.teks })),
    ...(collab.activity ?? []),
  ].sort((a, b) => (b.ts > a.ts ? 1 : b.ts < a.ts ? -1 : 0))

  const q = raw.queue ?? { now: [], next: [] }
  const now = (q.now ?? []).map((id) => featById[id]).filter(Boolean) as Array<Feature>
  const next = (q.next ?? []).map((id) => featById[id]).filter(Boolean) as Array<Feature>

  return {
    projects,
    projById,
    features,
    featById,
    runs,
    runsByTask,
    queue: { now, next, catatan: q.catatan },
    blocked: features.filter((f) => f.isBlocked),
    active: features.filter(
      (f) => !f.parked && !f.isBlocked && ACTIVE_PHASES.includes(String(f.fase)),
    ),
    parked: features.filter((f) => f.parked),
    runningAgents: runs.filter((r) => r.status === 'running'),
    decisions: raw.decisions ?? [],
    openDecisions: (raw.decisions ?? []).filter((d) => d.status === 'open'),
    log: raw.log ?? [],
    docs: raw.docs ?? [],
    updated: raw.updated,
    conventions: raw.conventions,
    activity,
  }
}
