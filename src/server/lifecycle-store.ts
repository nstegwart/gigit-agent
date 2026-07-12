// Generic lifecycle engine. Each board declares its OWN rail (stages + gate rules)
// in a `lifecycle` doc; nothing about any specific workflow is hardcoded here.
// advanceTask enforces the gates: gated stages need a program-emitted receipt, and
// a stage with a verifierRole cannot be passed by the task's implementer.
import { readDoc, writeDoc } from './db'
import { initLifecycle, readAudit, setTaskLifecycle, taskLifecycle, taskStageRows, writeAudit } from './tasks-store'
import type { GroupReadiness, LifecycleConfig, LifecycleHistoryEntry, LifecycleStage, Rollup, TaskLifecycle } from '#/lib/types'

const nowISO = () => new Date().toISOString()

/** Fallback rail for a board that hasn't configured its own. */
const DEFAULT_LIFECYCLE: LifecycleConfig = {
  stages: [
    { key: 'TODO', label: 'Todo', color: 'parked', gated: false },
    { key: 'DOING', label: 'Doing', color: 'indigo', gated: false },
    { key: 'REVIEW', label: 'Review', color: 'amber', gated: true, verifierRole: 'reviewer' },
    { key: 'DONE', label: 'Done', color: 'green', gated: true, requiresEvidence: ['evidence'] },
  ],
}

export async function readLifecycle(boardId: string): Promise<LifecycleConfig> {
  const c = await readDoc<LifecycleConfig>(boardId, 'lifecycle', DEFAULT_LIFECYCLE)
  return c?.stages?.length ? c : DEFAULT_LIFECYCLE
}
export async function writeLifecycle(
  boardId: string,
  stages: Array<LifecycleStage>,
  opts: { allowSkip?: boolean; allowRegression?: boolean; formulaVersion?: string } = {},
): Promise<LifecycleConfig> {
  if (!stages.length) throw new Error('lifecycle needs at least one stage')
  const keys = new Set<string>()
  for (const s of stages) {
    if (!s.key || !s.label) throw new Error('each stage needs a key + label')
    if (keys.has(s.key)) throw new Error(`duplicate stage key: ${s.key}`)
    keys.add(s.key)
  }
  const prev = await readLifecycle(boardId) // preserve flags not being changed
  const cfg: LifecycleConfig = {
    stages,
    allowSkip: opts.allowSkip ?? prev.allowSkip ?? false,
    allowRegression: opts.allowRegression ?? prev.allowRegression ?? true,
    formulaVersion: opts.formulaVersion ?? prev.formulaVersion ?? 'v1',
  }
  await writeDoc(boardId, 'lifecycle', cfg)
  await writeAudit(boardId, { ts: nowISO(), action: 'set_lifecycle', detail: { stages: stages.map((s) => s.key), allowSkip: cfg.allowSkip, allowRegression: cfg.allowRegression } })
  return cfg
}

export interface AdvanceInput {
  toStage: string
  byRunId?: string
  role?: string
  evidence?: Record<string, unknown>
  verdict?: string
  commitSha?: string
  deployReceipt?: string
  blocker?: string | null
  expectedRev?: number
}
export async function advanceTask(boardId: string, taskId: string, inp: AdvanceInput) {
  const cfg = await readLifecycle(boardId)
  const stage = cfg.stages.find((s) => s.key === inp.toStage)
  if (!stage) throw new Error(`unknown stage: ${inp.toStage}. Board ${boardId} rail: ${cfg.stages.map((s) => s.key).join(' → ')}`)
  const cur = await taskLifecycle(boardId, taskId)
  if (!cur) throw new Error(`task not found: ${taskId}`)
  const fromStage = cur.stage
  const implementer = cur.implementerRun
  if (!inp.byRunId) throw new Error('advance_task needs byRunId (which run/agent is performing this)')
  const order = cfg.stages.map((s) => s.key)
  const curIdx = cur.stage ? order.indexOf(cur.stage) : -1 // -1 = uninitialized (below the first stage)
  const toIdx = order.indexOf(inp.toStage)
  const forward = toIdx > curIdx
  const allowSkip = cfg.allowSkip ?? false
  const allowRegression = cfg.allowRegression ?? true
  const receipt: Record<string, unknown> = { ...(inp.evidence ?? {}) }
  if (inp.commitSha) receipt.commitSha = inp.commitSha
  if (inp.deployReceipt) receipt.deployReceipt = inp.deployReceipt

  if (forward) {
    // no stage-skipping on the way up
    if (!allowSkip && toIdx !== curIdx + 1) {
      throw new Error(`cannot skip stages: from ${cur.stage ?? '(uninitialized)'} the next stage is ${order[curIdx + 1]}, not ${inp.toStage}`)
    }
    // a gated stage can only be reached with a program-emitted receipt, never a bare manual set
    if (stage.gated) {
      for (const need of stage.requiresEvidence ?? []) {
        if (!(need in receipt)) throw new Error(`stage ${stage.key} is evidence-gated: missing "${need}" (pass it in evidence/commitSha/deployReceipt)`)
      }
      if (stage.verifierRole) {
        if (!inp.verdict) throw new Error(`stage ${stage.key} is verifier-gated: a verdict is required (the verifier's PASS)`)
        if (implementer && inp.byRunId === implementer) {
          throw new Error(`independent verification: ${stage.key} cannot be passed by the implementer (${implementer}). A different run must verify.`)
        }
      } else if (!(stage.requiresEvidence?.length) && !Object.keys(receipt).length) {
        throw new Error(`stage ${stage.key} is gated: attach a program-emitted receipt (evidence/commitSha/deployReceipt) — it cannot be hand-ticked`)
      }
    }
  } else {
    // same stage or earlier = repair / regression / recorded FAIL — gates do NOT apply going back
    if (!allowRegression) throw new Error(`regression not allowed on this board: ${inp.toStage} is not forward of ${cur.stage ?? '(uninitialized)'}`)
  }
  const prior = (cur.lifecycle as TaskLifecycle | null)?.history
  const history: Array<LifecycleHistoryEntry> = Array.isArray(prior) ? prior : []
  const entry: LifecycleHistoryEntry = {
    stage: inp.toStage, byRunId: inp.byRunId, role: inp.role, blocker: inp.blocker ?? null, ts: nowISO(),
    verdict: inp.verdict, evidence: inp.evidence as LifecycleHistoryEntry['evidence'], commitSha: inp.commitSha, deployReceipt: inp.deployReceipt,
  }
  history.push(entry)
  // first non-verifier run to touch the task becomes its implementer (for later verifier≠implementer checks)
  const newImplementer = !implementer && inp.byRunId && !stage.verifierRole ? inp.byRunId : undefined
  const rev = await setTaskLifecycle(boardId, taskId, { stage: inp.toStage, implementerRun: newImplementer, history: { history }, expectedRev: inp.expectedRev })
  await writeAudit(boardId, { ts: entry.ts, actor: inp.byRunId ?? null, action: 'advance', taskId, fromStage, toStage: inp.toStage, detail: { verdict: inp.verdict, receipt, blocker: inp.blocker } })
  return { ok: true as const, taskId, fromStage, stage: inp.toStage, rev, implementer: newImplementer ?? implementer ?? null }
}

export async function computeRollup(boardId: string): Promise<Rollup> {
  const cfg = await readLifecycle(boardId)
  const order = cfg.stages.map((s) => s.key)
  const n = order.length
  // readiness% per stage: explicit config wins; otherwise spread evenly (last = 100)
  const readiness: Record<string, number> = {}
  cfg.stages.forEach((s, i) => { readiness[s.key] = s.readiness ?? (n > 1 ? Math.round((i / (n - 1)) * 100) : 100) })
  // milestone = flagged stage, else first stage that means 100% ready, else the last stage
  const milestoneStage = cfg.stages.find((s) => s.milestone) ?? cfg.stages.find((s) => (readiness[s.key] ?? 0) >= 100) ?? cfg.stages[n - 1]
  const milestone = milestoneStage?.key ?? null
  const milestoneIdx = milestone ? order.indexOf(milestone) : -1

  const rows = await taskStageRows(boardId)
  const isHold = (scope: string | null) => (scope ?? '').toUpperCase() === 'HOLD'
  const idx = (k: string | null) => (k == null ? -1 : order.indexOf(k)) // -1 = uninitialized
  const readinessOf = (k: string | null) => (k && k in readiness ? readiness[k] : 0)
  // §1: while at the first (MAPPING) stage with readiness 0, derive 0–9 from M01–M20
  const firstKey = order[0]
  const rowReadiness = (r: { stage: string | null; ckDone: number; ckTotal: number }) =>
    r.stage === firstKey && (readiness[firstKey] ?? 0) === 0 && r.ckTotal
      ? Math.min(9, Math.round((r.ckDone / r.ckTotal) * 9))
      : readinessOf(r.stage)

  const counts: Record<string, number> = {}
  for (const k of order) counts[k] = 0
  let hold = 0
  let active = 0
  let uninitialized = 0
  let sumReadiness = 0
  let atMilestone = 0
  let liveVerified = 0
  for (const r of rows) {
    if (isHold(r.scope)) { hold++; continue }
    active++
    sumReadiness += rowReadiness(r)
    if (milestoneIdx >= 0 && idx(r.stage) >= milestoneIdx) atMilestone++
    if (milestoneIdx >= 0 && idx(r.stage) > milestoneIdx) liveVerified++
    if (idx(r.stage) < 0) uninitialized++
    else counts[r.stage as string] = (counts[r.stage as string] ?? 0) + 1
  }
  const readinessPercent = active ? Math.round(sumReadiness / active) : 0

  // per project / feature: avg readiness, most-behind floor, milestone + per-stage counts
  const roll = (keyOf: (r: (typeof rows)[number]) => string | null): Record<string, GroupReadiness> => {
    const g: Record<string, { sum: number; total: number; floorIdx: number; atMilestone: number; counts: Record<string, number>; uninitialized: number }> = {}
    for (const r of rows) {
      if (isHold(r.scope)) continue
      const key = keyOf(r)
      if (!key) continue
      const b = (g[key] ??= { sum: 0, total: 0, floorIdx: Infinity, atMilestone: 0, counts: {}, uninitialized: 0 })
      b.sum += rowReadiness(r)
      b.total++
      b.floorIdx = Math.min(b.floorIdx, idx(r.stage))
      if (milestoneIdx >= 0 && idx(r.stage) >= milestoneIdx) b.atMilestone++
      if (idx(r.stage) < 0) b.uninitialized++
      else b.counts[r.stage as string] = (b.counts[r.stage as string] ?? 0) + 1
    }
    return Object.fromEntries(Object.entries(g).map(([k, b]) => [k, {
      readinessPercent: b.total ? Math.round(b.sum / b.total) : 0,
      floor: b.floorIdx < 0 ? 'UNINITIALIZED' : (order[b.floorIdx] ?? null),
      total: b.total,
      atMilestone: b.atMilestone,
      counts: b.counts,
      uninitialized: b.uninitialized,
    }]))
  }
  return {
    formulaVersion: cfg.formulaVersion ?? 'v1',
    readyStage: milestone,
    stages: cfg.stages, counts, readiness, readinessPercent, milestone, atMilestone,
    prodReady: atMilestone, liveVerified,
    uninitialized, hold, active, byProject: roll((r) => r.project), byFeature: roll((r) => r.feature),
  }
}

/** Bulk-set the stage for a board's tasks (default = the first stage). Atomic UPDATE. */
export async function initLifecycleStage(boardId: string, stage?: string, onlyUninitialized = true): Promise<{ ok: true; stage: string; updated: number }> {
  const cfg = await readLifecycle(boardId)
  const target = stage ?? cfg.stages[0]?.key
  if (!target) throw new Error('board has no lifecycle stages')
  if (!cfg.stages.some((s) => s.key === target)) throw new Error(`unknown stage: ${target}. Rail: ${cfg.stages.map((s) => s.key).join(' → ')}`)
  const updated = await initLifecycle(boardId, target, onlyUninitialized)
  await writeAudit(boardId, { ts: nowISO(), action: 'init_lifecycle', toStage: target, detail: { updated, onlyUninitialized } })
  return { ok: true, stage: target, updated }
}

export { readAudit }
