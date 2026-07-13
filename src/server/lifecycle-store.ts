// Generic lifecycle engine. Each board declares its OWN rail (stages + gate rules)
// in a `lifecycle` doc; nothing about any specific workflow is hardcoded here.
// advanceTask enforces the gates: gated stages need a program-emitted receipt, and
// a stage with a verifierRole cannot be passed by the task's implementer.
// V3 ordered rail (advanceTaskV3) is identity-mapped nine-stage with injectable storage.
import { createHash } from 'node:crypto'
import { readDoc, writeDoc } from './db'
import { initLifecycle, readAudit, setTaskLifecycle, taskLifecycle, taskStageRows, writeAudit } from './tasks-store'
import type { GroupReadiness, LifecycleConfig, LifecycleHistoryEntry, LifecycleStage, Rollup, TaskLifecycle } from '#/lib/types'
import {
  LIFECYCLE_STAGE_ORDER,
  type LifecycleStageKey,
  type PinnedRevisionTuple,
} from '#/lib/control-plane-types'

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
        if (!(need in receipt)) throw new Error(`stage ${stage.key} is evidence-gated: missing "${need}" — pass evidence:{"${need}": "..."} (commitSha/deployReceipt are shortcuts only for those exact keys)`)
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
  const rev = await setTaskLifecycle(boardId, taskId, { stage: inp.toStage, implementerRun: newImplementer, history: { history }, blockedReason: inp.blocker ?? null, lastReceiptAt: entry.ts, expectedRev: inp.expectedRev })
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
    const g: Record<string, { sum: number; total: number; floorIdx: number; atMilestone: number; counts: Record<string, number>; uninitialized: number; blocked: number }> = {}
    for (const r of rows) {
      if (isHold(r.scope)) continue
      const key = keyOf(r)
      if (!key) continue
      const b = (g[key] ??= { sum: 0, total: 0, floorIdx: Infinity, atMilestone: 0, counts: {}, uninitialized: 0, blocked: 0 })
      b.sum += rowReadiness(r)
      b.total++
      b.floorIdx = Math.min(b.floorIdx, idx(r.stage))
      if (milestoneIdx >= 0 && idx(r.stage) >= milestoneIdx) b.atMilestone++
      if (r.blocked) b.blocked++
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
      blocked: b.blocked,
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

// =============================================================================
// V3 ordered lifecycle evidence rail (C1C)
// Identity-mapped nine-stage rail; allowSkip=false; injectable storage for unit tests.
// Does not replace advanceTask (legacy per-board rail remains).
// =============================================================================

export const V3_LIFECYCLE_RAIL: ReadonlyArray<LifecycleStageKey> = LIFECYCLE_STAGE_ORDER

/** Live-compatible default config for the identity-mapped nine-stage rail. */
export const V3_IDENTITY_LIFECYCLE_CONFIG: LifecycleConfig = {
  stages: [
    { key: 'MAPPING', label: 'Mapping', color: 'parked', gated: false, readiness: 0 },
    { key: 'MAPPED', label: 'Mapped', color: 'indigo', gated: true, requiresEvidence: ['mappingStructuralReceipt'], readiness: 10 },
    { key: 'MAP_VERIFIED', label: 'Map verified', color: 'blue', gated: true, verifierRole: 'mapping-verifier', requiresEvidence: ['mappingReceipt'], readiness: 20 },
    { key: 'BUILT', label: 'Built', color: 'teal', gated: true, requiresEvidence: ['implementationReceipt', 'intendedChangedPaths'], readiness: 45 },
    { key: 'FUNCTIONAL', label: 'Functional', color: 'amber', gated: true, verifierRole: 'functional-verifier', requiresEvidence: ['runtimePositive', 'runtimeNegative', 'runtimeRegression'], readiness: 65 },
    { key: 'INTEGRATED', label: 'Integrated', color: 'indigo', gated: true, requiresEvidence: ['integrateReceipt'], readiness: 75 },
    { key: 'STAGING_PROVEN', label: 'Staging proven', color: 'amber', gated: true, verifierRole: 'staging-verifier', requiresEvidence: ['stagingApi', 'stagingUi', 'stagingDb', 'stagingReadback'], readiness: 90 },
    { key: 'PROD_READY', label: 'Prod ready', color: 'green', gated: true, verifierRole: 'product-readiness-verifier', requiresEvidence: ['g5EvidenceComplete'], readiness: 100, milestone: true },
    { key: 'LIVE_VERIFIED', label: 'Live verified', color: 'green', gated: true, verifierRole: 'live-verifier', requiresEvidence: ['productionApprovalId', 'deployReceipt', 'liveReadback'], readiness: 100 },
  ],
  allowSkip: false,
  allowRegression: true,
  formulaVersion: 'v3',
}

export type LifecycleV3ErrorCode =
  | 'INVALID_TRANSITION'
  | 'MISSING_EVIDENCE'
  | 'STALE_REVISION'
  | 'STALE_HASH'
  | 'SELF_VERIFICATION'
  | 'INVALID_VERIFIER_ROLE'
  | 'INVALID_MODEL_PAIRING'
  | 'INVALID_THREAD'
  | 'RUN_NOT_REGISTERED'
  | 'LEASE_EXPIRED'
  | 'FENCED'
  | 'AUTHORIZATION_REQUIRED'
  | 'UNKNOWN_STAGE'
  | 'TASK_NOT_FOUND'

export class LifecycleV3Error extends Error {
  readonly code: LifecycleV3ErrorCode
  readonly details: Readonly<Record<string, unknown>>
  constructor(code: LifecycleV3ErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message)
    this.name = 'LifecycleV3Error'
    this.code = code
    this.details = details
  }
}

export interface RegisteredRun {
  runId: string
  agentId: string
  model: string
  role: string
  threadId: string
  expiresAt: string
  fenced: boolean
  registered: boolean
}

export interface StageReceipt {
  receiptId: string
  receiptHash: string
  programmatic: boolean
  /** Bound hashes */
  taskHash: string
  canonicalHash: string
  boardRev: number
  lifecycleRev: number
  /** Stage-specific payload fields (validated per stage). */
  fields: Record<string, unknown>
  authorRunId?: string | null
  verifierRunId?: string | null
  verdict?: string | null
  issuedAt: string
}

export interface TaskLifecycleV3State {
  taskId: string
  stage: LifecycleStageKey | null
  entityRev: number
  boardRev: number
  lifecycleRev: number
  taskHash: string
  canonicalSnapshotId: string
  canonicalHash: string
  implementerRunId: string | null
  implementerAgentId: string | null
  implementerModel: string | null
  implementerThreadId: string | null
  history: Array<LifecycleV3HistoryEntry>
  stageReceipts: Partial<Record<LifecycleStageKey, StageReceipt>>
  blockedReason: string | null
}

export interface LifecycleV3HistoryEntry {
  fromStage: LifecycleStageKey | null
  toStage: LifecycleStageKey
  byRunId: string
  role: string
  ts: string
  receiptId: string
  receiptHash: string
  boardRev: number
  lifecycleRev: number
  entityRev: number
  taskHash: string
  canonicalHash: string
}

export interface LifecycleBoardPin {
  boardId: string
  boardRev: number
  lifecycleRev: number
  canonicalSnapshotId: string
  canonicalHash: string
}

export interface AdvanceV3Input {
  boardId: string
  taskId: string
  toStage: LifecycleStageKey
  byRunId: string
  /** Client-expected entity rev for the task. */
  entityExpectedRev: number
  expectedBoardRev: number
  expectedLifecycleRev: number
  expectedTaskHash: string
  expectedCanonicalHash: string
  receipt: StageReceipt
  /** Opposite-model requirement when stage needs independent verifier. */
  requireOppositeModel?: boolean
  /** Owner production approval — mandatory only for LIVE_VERIFIED. */
  productionApprovalId?: string | null
  now?: string
  scope?: string
}

export interface AdvanceV3Result {
  ok: true
  taskId: string
  fromStage: LifecycleStageKey | null
  stage: LifecycleStageKey
  entityRev: number
  boardRev: number
  lifecycleRev: number
  taskHash: string
  canonicalSnapshotId: string
  canonicalHash: string
  receipt: StageReceipt
  pin: PinnedRevisionTuple
  readback: LifecycleV3Readback
}

export interface LifecycleV3Readback {
  taskId: string
  stage: LifecycleStageKey | null
  canonicalSnapshotId: string
  canonicalHash: string
  taskHash: string
  boardRev: number
  lifecycleRev: number
  entityRev: number
  stageReceiptIds: Array<string>
}

/** Injected V3 lifecycle storage (unit tests — no real DB). */
export interface LifecycleV3Storage {
  getBoardPin(boardId: string): Promise<LifecycleBoardPin | null>
  getTask(boardId: string, taskId: string): Promise<TaskLifecycleV3State | null>
  getRun(boardId: string, runId: string): Promise<RegisteredRun | null>
  saveTask(
    boardId: string,
    state: TaskLifecycleV3State,
    nextBoard: { boardRev: number; lifecycleRev: number },
  ): Promise<void>
  appendAudit?(entry: Record<string, unknown>): Promise<void>
}

const VERIFIER_STAGES = new Set<LifecycleStageKey>([
  'MAP_VERIFIED',
  'FUNCTIONAL',
  'STAGING_PROVEN',
  'PROD_READY',
  'LIVE_VERIFIED',
])

const STAGE_REQUIRED_FIELDS: Record<LifecycleStageKey, Array<string>> = {
  MAPPING: [],
  MAPPED: ['mappingStructuralReceipt'],
  MAP_VERIFIED: ['mappingReceipt', 'verifierVerdict'],
  BUILT: ['implementationReceipt', 'intendedChangedPaths'],
  FUNCTIONAL: ['runtimePositive', 'runtimeNegative', 'runtimeRegression', 'verifierVerdict'],
  INTEGRATED: ['integrateReceipt', 'repo', 'trackingBranch', 'fullSha', 'shortSha', 'pathspecs', 'push'],
  STAGING_PROVEN: ['stagingApi', 'stagingUi', 'stagingDb', 'stagingReadback', 'deployedSha', 'verifierVerdict'],
  PROD_READY: ['g5EvidenceComplete', 'verifierVerdict'],
  LIVE_VERIFIED: ['productionApprovalId', 'deployReceipt', 'liveReadback', 'verifierVerdict'],
}

function isLifecycleStageKey(s: string): s is LifecycleStageKey {
  return (LIFECYCLE_STAGE_ORDER as ReadonlyArray<string>).includes(s)
}

function receiptHashOf(receipt: Omit<StageReceipt, 'receiptHash'> & { receiptHash?: string }): string {
  const body = {
    receiptId: receipt.receiptId,
    programmatic: receipt.programmatic,
    taskHash: receipt.taskHash,
    canonicalHash: receipt.canonicalHash,
    boardRev: receipt.boardRev,
    lifecycleRev: receipt.lifecycleRev,
    fields: receipt.fields,
    authorRunId: receipt.authorRunId ?? null,
    verifierRunId: receipt.verifierRunId ?? null,
    verdict: receipt.verdict ?? null,
    issuedAt: receipt.issuedAt,
  }
  return createHash('sha256').update(JSON.stringify(body)).digest('hex')
}

export function computeStageReceiptHash(
  receipt: Omit<StageReceipt, 'receiptHash'> & { receiptHash?: string },
): string {
  return receiptHashOf(receipt)
}

function assertRunValid(
  run: RegisteredRun | null,
  runId: string,
  now: string,
): asserts run is RegisteredRun {
  if (!run || !run.registered) {
    throw new LifecycleV3Error('RUN_NOT_REGISTERED', `run not registered: ${runId}`, { runId })
  }
  if (run.fenced) {
    throw new LifecycleV3Error('FENCED', `run is fenced: ${runId}`, { runId })
  }
  if (run.expiresAt <= now) {
    throw new LifecycleV3Error('LEASE_EXPIRED', `run lease expired: ${runId}`, {
      runId,
      expiresAt: run.expiresAt,
      now,
    })
  }
}

function validateStageEvidence(
  toStage: LifecycleStageKey,
  receipt: StageReceipt,
  inp: AdvanceV3Input,
): void {
  if (!receipt.programmatic) {
    throw new LifecycleV3Error('MISSING_EVIDENCE', 'receipt must be programmatic (not hand-typed)', {
      toStage,
    })
  }
  if (!receipt.receiptId || !receipt.receiptHash) {
    throw new LifecycleV3Error('MISSING_EVIDENCE', 'receiptId/receiptHash required', { toStage })
  }
  const expectedHash = receiptHashOf({ ...receipt, receiptHash: undefined })
  if (receipt.receiptHash !== expectedHash) {
    throw new LifecycleV3Error('STALE_HASH', 'receipt hash mismatch / tampered receipt', {
      expected: expectedHash,
      got: receipt.receiptHash,
    })
  }

  for (const field of STAGE_REQUIRED_FIELDS[toStage]) {
    if (field === 'productionApprovalId') {
      if (!inp.productionApprovalId && receipt.fields.productionApprovalId == null) {
        throw new LifecycleV3Error(
          'MISSING_EVIDENCE',
          'LIVE_VERIFIED requires owner productionApprovalId',
          { field },
        )
      }
      continue
    }
    if (!(field in receipt.fields) || receipt.fields[field] == null || receipt.fields[field] === '') {
      throw new LifecycleV3Error('MISSING_EVIDENCE', `stage ${toStage} missing evidence field: ${field}`, {
        field,
        toStage,
      })
    }
  }

  if (toStage === 'INTEGRATED') {
    if (receipt.fields.push !== 'OK' && receipt.fields.push !== true) {
      throw new LifecycleV3Error('MISSING_EVIDENCE', 'INTEGRATED requires push: OK', {
        push: receipt.fields.push,
      })
    }
  }

  if (toStage === 'LIVE_VERIFIED') {
    const approval = inp.productionApprovalId ?? receipt.fields.productionApprovalId
    if (!approval || typeof approval !== 'string') {
      throw new LifecycleV3Error(
        'MISSING_EVIDENCE',
        'LIVE_VERIFIED requires owner productionApprovalId',
      )
    }
  }
}

/**
 * Pure V3 advance evaluation + mutate via injected storage.
 * allowSkip is hard-false. Fresh revs/hashes + registered unexpired unfenced runs required.
 */
export async function advanceTaskV3(
  storage: LifecycleV3Storage,
  inp: AdvanceV3Input,
): Promise<AdvanceV3Result> {
  const now = inp.now ?? new Date().toISOString()
  if (!inp.byRunId) {
    throw new LifecycleV3Error('AUTHORIZATION_REQUIRED', 'byRunId required')
  }
  if (!isLifecycleStageKey(inp.toStage)) {
    throw new LifecycleV3Error('UNKNOWN_STAGE', `unknown stage: ${inp.toStage}`)
  }

  const pin = await storage.getBoardPin(inp.boardId)
  if (!pin) {
    throw new LifecycleV3Error('TASK_NOT_FOUND', `board not found: ${inp.boardId}`)
  }
  const task = await storage.getTask(inp.boardId, inp.taskId)
  if (!task) {
    throw new LifecycleV3Error('TASK_NOT_FOUND', `task not found: ${inp.taskId}`)
  }

  // Fresh entity + board + lifecycle revs
  if (task.entityRev !== inp.entityExpectedRev) {
    throw new LifecycleV3Error('STALE_REVISION', `entity rev mismatch: expected ${inp.entityExpectedRev}, current ${task.entityRev}`, {
      entityExpectedRev: inp.entityExpectedRev,
      current: task.entityRev,
    })
  }
  if (pin.boardRev !== inp.expectedBoardRev || task.boardRev !== inp.expectedBoardRev) {
    throw new LifecycleV3Error('STALE_REVISION', `board rev mismatch: expected ${inp.expectedBoardRev}, current ${pin.boardRev}`, {
      expectedBoardRev: inp.expectedBoardRev,
      current: pin.boardRev,
    })
  }
  if (pin.lifecycleRev !== inp.expectedLifecycleRev || task.lifecycleRev !== inp.expectedLifecycleRev) {
    throw new LifecycleV3Error('STALE_REVISION', `lifecycle rev mismatch: expected ${inp.expectedLifecycleRev}, current ${pin.lifecycleRev}`, {
      expectedLifecycleRev: inp.expectedLifecycleRev,
      current: pin.lifecycleRev,
    })
  }

  // Current hashes
  if (task.taskHash !== inp.expectedTaskHash || task.taskHash !== inp.receipt.taskHash) {
    throw new LifecycleV3Error('STALE_HASH', 'task hash mismatch', {
      expected: inp.expectedTaskHash,
      task: task.taskHash,
      receipt: inp.receipt.taskHash,
    })
  }
  if (
    pin.canonicalHash !== inp.expectedCanonicalHash ||
    task.canonicalHash !== inp.expectedCanonicalHash ||
    inp.receipt.canonicalHash !== pin.canonicalHash
  ) {
    throw new LifecycleV3Error('STALE_HASH', 'canonical hash mismatch', {
      expected: inp.expectedCanonicalHash,
      pin: pin.canonicalHash,
      receipt: inp.receipt.canonicalHash,
    })
  }
  if (inp.receipt.boardRev !== pin.boardRev || inp.receipt.lifecycleRev !== pin.lifecycleRev) {
    throw new LifecycleV3Error('STALE_REVISION', 'receipt bound to stale board/lifecycle rev', {
      receiptBoardRev: inp.receipt.boardRev,
      receiptLifecycleRev: inp.receipt.lifecycleRev,
      pin,
    })
  }

  const order = V3_LIFECYCLE_RAIL
  const curIdx = task.stage ? order.indexOf(task.stage) : -1
  const toIdx = order.indexOf(inp.toStage)
  if (toIdx < 0) {
    throw new LifecycleV3Error('UNKNOWN_STAGE', `unknown stage: ${inp.toStage}`)
  }

  // allowSkip = false always for V3
  if (toIdx !== curIdx + 1) {
    throw new LifecycleV3Error(
      'INVALID_TRANSITION',
      `cannot skip stages: from ${task.stage ?? '(uninitialized)'} next is ${order[curIdx + 1] ?? 'none'}, not ${inp.toStage}`,
      { from: task.stage, to: inp.toStage, allowSkip: false },
    )
  }

  validateStageEvidence(inp.toStage, inp.receipt, inp)

  const actorRun = await storage.getRun(inp.boardId, inp.byRunId)
  assertRunValid(actorRun, inp.byRunId, now)

  const needsVerifier = VERIFIER_STAGES.has(inp.toStage)
  if (needsVerifier) {
    const verifierRunId = inp.receipt.verifierRunId ?? inp.byRunId
    const verifierRun = await storage.getRun(inp.boardId, verifierRunId)
    assertRunValid(verifierRun, verifierRunId, now)

    // Self-verification: same run as implementer/author
    const authorRunId = inp.receipt.authorRunId ?? task.implementerRunId
    if (authorRunId && verifierRunId === authorRunId) {
      throw new LifecycleV3Error('SELF_VERIFICATION', 'verifier run cannot equal author run', {
        authorRunId,
        verifierRunId,
      })
    }
    if (task.implementerRunId && verifierRunId === task.implementerRunId) {
      throw new LifecycleV3Error('SELF_VERIFICATION', 'implementer cannot verify own work', {
        implementerRunId: task.implementerRunId,
      })
    }
    if (task.implementerAgentId && verifierRun.agentId === task.implementerAgentId) {
      throw new LifecycleV3Error('SELF_VERIFICATION', 'same agent cannot verify own work', {
        agentId: verifierRun.agentId,
      })
    }
    if (task.implementerThreadId && verifierRun.threadId === task.implementerThreadId) {
      throw new LifecycleV3Error('INVALID_THREAD', 'verifier thread must differ from author thread', {
        threadId: verifierRun.threadId,
      })
    }

    const expectedRole = V3_IDENTITY_LIFECYCLE_CONFIG.stages.find((s) => s.key === inp.toStage)?.verifierRole
    if (expectedRole && verifierRun.role !== expectedRole && verifierRun.role !== 'verifier') {
      throw new LifecycleV3Error(
        'INVALID_VERIFIER_ROLE',
        `role ${verifierRun.role} cannot verify stage ${inp.toStage} (need ${expectedRole})`,
        { role: verifierRun.role, expectedRole },
      )
    }

    if (inp.requireOppositeModel !== false && task.implementerModel) {
      if (verifierRun.model === task.implementerModel) {
        throw new LifecycleV3Error(
          'INVALID_MODEL_PAIRING',
          'verifier model must differ from author model for this lane',
          { model: verifierRun.model },
        )
      }
    }

    if (inp.receipt.verdict !== 'PASS' && inp.receipt.fields.verifierVerdict !== 'PASS') {
      throw new LifecycleV3Error('MISSING_EVIDENCE', 'verifier verdict PASS required', {
        verdict: inp.receipt.verdict,
      })
    }
  } else {
    // Author path for non-verifier stages
    if (actorRun.role === 'verifier' && inp.toStage !== 'MAPPING') {
      // allow but not required
    }
  }

  // Build next state (immutable history append)
  const entry: LifecycleV3HistoryEntry = {
    fromStage: task.stage,
    toStage: inp.toStage,
    byRunId: inp.byRunId,
    role: actorRun.role,
    ts: now,
    receiptId: inp.receipt.receiptId,
    receiptHash: inp.receipt.receiptHash,
    boardRev: pin.boardRev + 1,
    lifecycleRev: pin.lifecycleRev + 1,
    entityRev: task.entityRev + 1,
    taskHash: task.taskHash,
    canonicalHash: pin.canonicalHash,
  }

  const nextImplementerRun =
    task.implementerRunId ??
    (!needsVerifier ? inp.byRunId : task.implementerRunId)
  const nextImplementerAgent =
    task.implementerAgentId ?? (!needsVerifier ? actorRun.agentId : task.implementerAgentId)
  const nextImplementerModel =
    task.implementerModel ?? (!needsVerifier ? actorRun.model : task.implementerModel)
  const nextImplementerThread =
    task.implementerThreadId ?? (!needsVerifier ? actorRun.threadId : task.implementerThreadId)

  const next: TaskLifecycleV3State = {
    ...task,
    stage: inp.toStage,
    entityRev: task.entityRev + 1,
    boardRev: pin.boardRev + 1,
    lifecycleRev: pin.lifecycleRev + 1,
    implementerRunId: nextImplementerRun,
    implementerAgentId: nextImplementerAgent,
    implementerModel: nextImplementerModel,
    implementerThreadId: nextImplementerThread,
    history: [...task.history, entry],
    stageReceipts: { ...task.stageReceipts, [inp.toStage]: { ...inp.receipt } },
    blockedReason: null,
  }

  await storage.saveTask(inp.boardId, next, {
    boardRev: next.boardRev,
    lifecycleRev: next.lifecycleRev,
  })
  await storage.appendAudit?.({
    ts: now,
    actor: inp.byRunId,
    action: 'advance_v3',
    taskId: inp.taskId,
    fromStage: task.stage,
    toStage: inp.toStage,
    receiptId: inp.receipt.receiptId,
    boardRev: next.boardRev,
    lifecycleRev: next.lifecycleRev,
    entityRev: next.entityRev,
  })

  const pinTuple: PinnedRevisionTuple = {
    canonicalSnapshotId: pin.canonicalSnapshotId,
    canonicalHash: pin.canonicalHash,
    taskHash: next.taskHash,
    boardRev: next.boardRev,
    lifecycleRev: next.lifecycleRev,
  }

  return {
    ok: true,
    taskId: inp.taskId,
    fromStage: task.stage,
    stage: inp.toStage,
    entityRev: next.entityRev,
    boardRev: next.boardRev,
    lifecycleRev: next.lifecycleRev,
    taskHash: next.taskHash,
    canonicalSnapshotId: pin.canonicalSnapshotId,
    canonicalHash: pin.canonicalHash,
    receipt: inp.receipt,
    pin: pinTuple,
    readback: buildLifecycleReadback(next, pin.canonicalSnapshotId, pin.canonicalHash),
  }
}

export function buildLifecycleReadback(
  task: TaskLifecycleV3State,
  canonicalSnapshotId: string,
  canonicalHash: string,
): LifecycleV3Readback {
  return {
    taskId: task.taskId,
    stage: task.stage,
    canonicalSnapshotId,
    canonicalHash,
    taskHash: task.taskHash,
    boardRev: task.boardRev,
    lifecycleRev: task.lifecycleRev,
    entityRev: task.entityRev,
    stageReceiptIds: Object.values(task.stageReceipts)
      .filter(Boolean)
      .map((r) => (r as StageReceipt).receiptId)
      .sort(),
  }
}

// =============================================================================
// AC-LIFE-02 — lifecycle enum mapping pre-migration guard (pure, no DB)
// Mapping types: IDENTITY | RENAME | SPLIT | MERGE | LEGACY_ONLY | UNMAPPED
// SPLIT / MERGE / UNMAPPED → fail closed with blocking root Decision + state IDs.
// IDENTITY / RENAME / LEGACY_ONLY → deterministic approved plan (no ad-hoc rewrite).
// =============================================================================

export const LIFECYCLE_MAPPING_TYPES = [
  'IDENTITY',
  'RENAME',
  'SPLIT',
  'MERGE',
  'LEGACY_ONLY',
  'UNMAPPED',
] as const

export type LifecycleMappingType = (typeof LIFECYCLE_MAPPING_TYPES)[number]

/** Mapping types that block migration until a root Decision is recorded. */
export const LIFECYCLE_MAPPING_BLOCKING_TYPES = [
  'SPLIT',
  'MERGE',
  'UNMAPPED',
] as const satisfies ReadonlyArray<LifecycleMappingType>

/** Mapping types that may yield a deterministic approved plan. */
export const LIFECYCLE_MAPPING_APPROVABLE_TYPES = [
  'IDENTITY',
  'RENAME',
  'LEGACY_ONLY',
] as const satisfies ReadonlyArray<LifecycleMappingType>

export type LifecycleMappingDecisionCode =
  | 'DECISION_LIFECYCLE_SPLIT'
  | 'DECISION_LIFECYCLE_MERGE'
  | 'DECISION_LIFECYCLE_UNMAPPED'
  | 'DECISION_LIFECYCLE_MAPPING_AMBIGUITY'
  | 'DECISION_LIFECYCLE_MAPPING_MALFORMED'

export interface LifecycleMappingRow {
  /** Live enum value / state id (required). */
  live: string
  /** Canonical V3 target (null/absent for LEGACY_ONLY / UNMAPPED). */
  canonical?: string | null
  type: LifecycleMappingType
  meaning?: string | null
  currentEvidence?: string | null
  migration?: string | null
  rollback?: string | null
  ambiguity?: string | null
}

export interface LifecycleMappingDocument {
  schemaVersion?: string
  boardId?: string
  mapping: ReadonlyArray<LifecycleMappingRow>
  blockingDecisionRequired?: boolean
}

export interface LifecycleApprovedPlanStep {
  live: string
  canonical: string | null
  type: 'IDENTITY' | 'RENAME' | 'LEGACY_ONLY'
  /** Explicit action — never an ad-hoc rewrite of live values. */
  action: 'PRESERVE' | 'RENAME_DUAL_WRITE' | 'RETAIN_LEGACY_ONLY'
  migration: string
  rollback: string
}

export interface LifecycleMappingApprovedPlan {
  approved: true
  blockingDecisionRequired: false
  decisionCode: null
  /** Stable input order preserved (no reordering rewrite). */
  steps: ReadonlyArray<LifecycleApprovedPlanStep>
  identityCount: number
  renameCount: number
  legacyOnlyCount: number
}

export interface LifecycleMappingBlockedPlan {
  approved: false
  blockingDecisionRequired: true
  /** Primary root Decision code (first blocking type, or aggregate / malformed). */
  decisionCode: LifecycleMappingDecisionCode
  /** Exact ambiguous live state IDs (sorted unique for determinism of the set; source order also retained). */
  ambiguousStateIds: ReadonlyArray<string>
  /** Source-order list of blocking rows. */
  blockingRows: ReadonlyArray<{
    live: string
    type: LifecycleMappingType
    decisionCode: LifecycleMappingDecisionCode
    canonical: string | null
    ambiguity: string | null
  }>
  reasons: ReadonlyArray<string>
}

export type LifecycleMappingGuardResult =
  | ({ ok: true } & LifecycleMappingApprovedPlan)
  | ({ ok: false } & LifecycleMappingBlockedPlan)

function isLifecycleMappingType(v: unknown): v is LifecycleMappingType {
  return typeof v === 'string' && (LIFECYCLE_MAPPING_TYPES as ReadonlyArray<string>).includes(v)
}

function decisionCodeForBlockingType(
  type: 'SPLIT' | 'MERGE' | 'UNMAPPED',
): LifecycleMappingDecisionCode {
  if (type === 'SPLIT') return 'DECISION_LIFECYCLE_SPLIT'
  if (type === 'MERGE') return 'DECISION_LIFECYCLE_MERGE'
  return 'DECISION_LIFECYCLE_UNMAPPED'
}

function approvedActionFor(
  type: 'IDENTITY' | 'RENAME' | 'LEGACY_ONLY',
): LifecycleApprovedPlanStep['action'] {
  if (type === 'IDENTITY') return 'PRESERVE'
  if (type === 'RENAME') return 'RENAME_DUAL_WRITE'
  return 'RETAIN_LEGACY_ONLY'
}

function defaultMigrationText(type: LifecycleMappingType, live: string, canonical: string | null): string {
  if (type === 'IDENTITY') {
    return `preserve value ${live}; no rewrite`
  }
  if (type === 'RENAME') {
    return `explicit rename map ${live} → ${canonical ?? '(missing)'}; dual-write period; no ad-hoc rewrite`
  }
  if (type === 'LEGACY_ONLY') {
    return `retain legacy-only state ${live}; no ad-hoc canonical invent`
  }
  return `block migration for ${live} (${type}) until root Decision`
}

function defaultRollbackText(type: LifecycleMappingType, live: string): string {
  if (type === 'RENAME') return `roll dual-write back to live ${live}`
  return `retain original value ${live}`
}

/**
 * Pre-migration guard for lifecycle enum mapping (AC-LIFE-02).
 * Pure function — never mutates a DB. Accepts a document or raw row array.
 *
 * - IDENTITY / RENAME / LEGACY_ONLY → deterministic approved plan
 * - SPLIT / MERGE / UNMAPPED → fail closed with Decision code + exact state IDs
 * - duplicates / malformed / unknown types → fail closed (malformed Decision)
 * - never rewrites live values ad-hoc
 */
export function evaluateLifecycleEnumMapping(
  input: LifecycleMappingDocument | ReadonlyArray<LifecycleMappingRow> | null | undefined,
): LifecycleMappingGuardResult {
  const rowsRaw: ReadonlyArray<unknown> = Array.isArray(input)
    ? input
    : input && typeof input === 'object' && Array.isArray((input as LifecycleMappingDocument).mapping)
      ? (input as LifecycleMappingDocument).mapping
      : []

  if (!rowsRaw.length) {
    return {
      ok: false,
      approved: false,
      blockingDecisionRequired: true,
      decisionCode: 'DECISION_LIFECYCLE_MAPPING_MALFORMED',
      ambiguousStateIds: [],
      blockingRows: [],
      reasons: ['EMPTY_OR_MISSING_MAPPING'],
    }
  }

  const reasons: Array<string> = []
  const seenLive = new Set<string>()
  const normalized: Array<LifecycleMappingRow> = []

  for (let i = 0; i < rowsRaw.length; i++) {
    const raw = rowsRaw[i] as Partial<LifecycleMappingRow> | null | undefined
    if (!raw || typeof raw !== 'object') {
      reasons.push(`MALFORMED_ROW_AT_${i}`)
      continue
    }
    const live = typeof raw.live === 'string' ? raw.live.trim() : ''
    if (!live) {
      reasons.push(`MISSING_LIVE_AT_${i}`)
      continue
    }
    if (seenLive.has(live)) {
      reasons.push(`DUPLICATE_LIVE:${live}`)
      continue
    }
    seenLive.add(live)
    if (!isLifecycleMappingType(raw.type)) {
      reasons.push(`INVALID_MAPPING_TYPE:${live}:${String(raw.type)}`)
      continue
    }
    if (raw.type === 'RENAME' && (raw.canonical == null || String(raw.canonical).trim() === '')) {
      reasons.push(`RENAME_MISSING_CANONICAL:${live}`)
      continue
    }
    if (raw.type === 'IDENTITY' && raw.canonical != null && String(raw.canonical) !== live) {
      // IDENTITY must not silently rewrite to a different canonical.
      reasons.push(`IDENTITY_CANONICAL_MISMATCH:${live}!=${String(raw.canonical)}`)
      continue
    }
    normalized.push({
      live,
      canonical: raw.canonical ?? (raw.type === 'IDENTITY' ? live : null),
      type: raw.type,
      meaning: raw.meaning ?? null,
      currentEvidence: raw.currentEvidence ?? null,
      migration: raw.migration ?? null,
      rollback: raw.rollback ?? null,
      ambiguity: raw.ambiguity ?? null,
    })
  }

  if (reasons.length > 0) {
    // Malformed / duplicates: fail closed — do not invent a partial rewrite plan.
    const ambiguousFromMalformed = reasons
      .map((r) => {
        const m = r.match(/:(.+)$/)
        return m ? m[1].split(':')[0] : null
      })
      .filter((x): x is string => !!x && !x.startsWith('MALFORMED') && !x.startsWith('MISSING'))
    return {
      ok: false,
      approved: false,
      blockingDecisionRequired: true,
      decisionCode: 'DECISION_LIFECYCLE_MAPPING_MALFORMED',
      ambiguousStateIds: [...new Set(ambiguousFromMalformed)].sort(),
      blockingRows: [],
      reasons,
    }
  }

  const blockingRows = normalized
    .filter((r) =>
      (LIFECYCLE_MAPPING_BLOCKING_TYPES as ReadonlyArray<string>).includes(r.type),
    )
    .map((r) => {
      const t = r.type as 'SPLIT' | 'MERGE' | 'UNMAPPED'
      return {
        live: r.live,
        type: r.type,
        decisionCode: decisionCodeForBlockingType(t),
        canonical: r.canonical ?? null,
        ambiguity: r.ambiguity ?? null,
      }
    })

  if (blockingRows.length > 0) {
    const types = new Set(blockingRows.map((r) => r.type))
    const decisionCode: LifecycleMappingDecisionCode =
      types.size === 1
        ? decisionCodeForBlockingType(blockingRows[0].type as 'SPLIT' | 'MERGE' | 'UNMAPPED')
        : 'DECISION_LIFECYCLE_MAPPING_AMBIGUITY'
    // Exact ambiguous state IDs: unique sorted for set determinism; blockingRows keep source order.
    const ambiguousStateIds = [...new Set(blockingRows.map((r) => r.live))].sort()
    return {
      ok: false,
      approved: false,
      blockingDecisionRequired: true,
      decisionCode,
      ambiguousStateIds,
      blockingRows,
      reasons: blockingRows.map(
        (r) => `${r.type}_REQUIRES_ROOT_DECISION:${r.live}`,
      ),
    }
  }

  // All rows approvable — deterministic plan in source order (no ad-hoc rewrite).
  const steps: Array<LifecycleApprovedPlanStep> = normalized.map((r) => {
    const type = r.type as 'IDENTITY' | 'RENAME' | 'LEGACY_ONLY'
    const canonical =
      type === 'IDENTITY' ? r.live : type === 'RENAME' ? (r.canonical as string) : null
    return {
      live: r.live,
      canonical,
      type,
      action: approvedActionFor(type),
      migration: r.migration ?? defaultMigrationText(type, r.live, canonical),
      rollback: r.rollback ?? defaultRollbackText(type, r.live),
    }
  })

  return {
    ok: true,
    approved: true,
    blockingDecisionRequired: false,
    decisionCode: null,
    steps,
    identityCount: steps.filter((s) => s.type === 'IDENTITY').length,
    renameCount: steps.filter((s) => s.type === 'RENAME').length,
    legacyOnlyCount: steps.filter((s) => s.type === 'LEGACY_ONLY').length,
  }
}

/**
 * Alias for pre-migration call sites (plan-only; never mutates DB).
 */
export function planLifecycleEnumMigration(
  input: LifecycleMappingDocument | ReadonlyArray<LifecycleMappingRow> | null | undefined,
): LifecycleMappingGuardResult {
  return evaluateLifecycleEnumMapping(input)
}

/** In-memory V3 lifecycle storage for unit tests. */
export function createMemoryLifecycleV3Storage(seed: {
  pin: LifecycleBoardPin
  tasks: Array<TaskLifecycleV3State>
  runs: Array<RegisteredRun>
}): LifecycleV3Storage & {
  pin: () => LifecycleBoardPin
  tasks: () => Array<TaskLifecycleV3State>
  audits: () => Array<Record<string, unknown>>
} {
  let pin = { ...seed.pin }
  const tasks = new Map(seed.tasks.map((t) => [t.taskId, { ...t, history: [...t.history], stageReceipts: { ...t.stageReceipts } }]))
  const runs = new Map(seed.runs.map((r) => [r.runId, { ...r }]))
  const audits: Array<Record<string, unknown>> = []

  return {
    pin: () => ({ ...pin }),
    tasks: () => [...tasks.values()].map((t) => ({ ...t, history: [...t.history] })),
    audits: () => audits.map((a) => ({ ...a })),
    async getBoardPin(boardId) {
      return pin.boardId === boardId ? { ...pin } : null
    },
    async getTask(boardId, taskId) {
      if (pin.boardId !== boardId) return null
      const t = tasks.get(taskId)
      return t
        ? {
            ...t,
            history: [...t.history],
            stageReceipts: { ...t.stageReceipts },
          }
        : null
    },
    async getRun(boardId, runId) {
      if (pin.boardId !== boardId) return null
      const r = runs.get(runId)
      return r ? { ...r } : null
    },
    async saveTask(boardId, state, nextBoard) {
      if (pin.boardId !== boardId) throw new LifecycleV3Error('TASK_NOT_FOUND', 'board mismatch')
      tasks.set(state.taskId, {
        ...state,
        history: [...state.history],
        stageReceipts: { ...state.stageReceipts },
      })
      pin = {
        ...pin,
        boardRev: nextBoard.boardRev,
        lifecycleRev: nextBoard.lifecycleRev,
      }
      // Keep other tasks' pin revs in sync for readback consistency
      for (const [id, t] of tasks) {
        if (id === state.taskId) continue
        tasks.set(id, { ...t, boardRev: nextBoard.boardRev, lifecycleRev: nextBoard.lifecycleRev })
      }
    },
    async appendAudit(entry) {
      audits.push({ ...entry })
    },
  }
}
