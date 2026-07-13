/**
 * Decision inbox V3: exact schema/status/order, blocking/snooze/resurface,
 * reject-vs-declining-option, expiry, expectedRev+boardRev, scoped approval/audit.
 * Decisions never broaden production/HOLD/provider authority.
 */
import { randomUUID } from 'node:crypto'

import type { ControlPlaneAtomicStore, ControlPlaneClock } from './board-store'

export type DecisionV3Status =
  | 'OPEN'
  | 'ACKNOWLEDGED'
  | 'RESOLVED'
  | 'REJECTED'
  | 'EXPIRED'
  | 'CANCELLED'

export type DecisionSeverity = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW'

export const SEVERITY_ORDER: Record<DecisionSeverity, number> = {
  CRITICAL: 0,
  HIGH: 1,
  MEDIUM: 2,
  LOW: 3,
}

export interface DecisionOptionV3 {
  optionId: string
  label: string
  /** Declining option is still a RESOLVED request when selected — not REJECTED. */
  declining?: boolean
  tradeoffs?: string | null
  /** Forbidden: options must not claim production/HOLD/provider broadening. */
  requestsProductionAuthority?: boolean
  requestsHoldAuthority?: boolean
  requestsProviderAuthority?: boolean
}

export interface DecisionV3Record {
  decisionId: string
  boardId: string
  projectId: string | null
  featureId: string | null
  taskId: string | null
  runId: string | null
  type: string
  severity: DecisionSeverity
  title: string
  question: string
  evidence: Array<string>
  options: Array<DecisionOptionV3>
  agentRecommendation: string | null
  blocking: boolean
  dueAt: string | null
  dueAtMs: number | null
  createdAt: string
  createdAtMs: number
  snoozedUntil: string | null
  snoozedUntilMs: number | null
  status: DecisionV3Status
  ownerId: string | null
  resolverId: string | null
  selectedOptionId: string | null
  comment: string | null
  expectedRev: number
  boardRev: number
  entityRev: number
  scopedApprovalId: string | null
  auditIds: Array<string>
  expiresAt: string | null
  expiresAtMs: number | null
}

export type DecisionErrorCode =
  | 'STALE_REVISION'
  | 'INVALID_INPUT'
  | 'NOT_FOUND'
  | 'INVALID_STATE'
  | 'AUTHORITY_BROADENING_FORBIDDEN'
  | 'SNOOZE_BLOCKED'
  | 'AUTHORIZATION_REQUIRED'

export class DecisionV3Error extends Error {
  readonly code: DecisionErrorCode
  readonly details: Readonly<Record<string, unknown>>
  constructor(code: DecisionErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message)
    this.name = 'DecisionV3Error'
    this.code = code
    this.details = details
  }
}

export interface DecisionV3Store {
  get(boardId: string, decisionId: string): Promise<DecisionV3Record | null>
  put(rec: DecisionV3Record): Promise<void>
  list(boardId: string): Promise<Array<DecisionV3Record>>
  withBoardLock<T>(boardId: string, fn: () => Promise<T> | T): Promise<T>
}

export interface DecisionV3Deps {
  clock: ControlPlaneClock
  decisions: DecisionV3Store
  atomic: ControlPlaneAtomicStore
}

export interface OpenDecisionV3Request {
  boardId: string
  decisionId?: string
  projectId?: string | null
  featureId?: string | null
  taskId?: string | null
  runId?: string | null
  type: string
  severity: DecisionSeverity
  title: string
  question: string
  evidence?: Array<string>
  options: Array<DecisionOptionV3>
  agentRecommendation?: string | null
  blocking: boolean
  dueAt?: string | null
  expiresAt?: string | null
  expectedBoardRev: number
  actorId: string
}

/**
 * Ordering:
 *   blocking desc → severity CRITICAL>HIGH>MEDIUM>LOW → dueAt asc (null last)
 *   → createdAt asc → decisionId asc
 * Snoozed non-blocking items hidden until snoozedUntil; blocking cannot hide via snooze.
 */
export function compareDecisionsV3(a: DecisionV3Record, b: DecisionV3Record): number {
  if (a.blocking !== b.blocking) return a.blocking ? -1 : 1
  const sa = SEVERITY_ORDER[a.severity] ?? 99
  const sb = SEVERITY_ORDER[b.severity] ?? 99
  if (sa !== sb) return sa - sb
  const da = a.dueAtMs
  const db = b.dueAtMs
  if (da == null && db != null) return 1
  if (da != null && db == null) return -1
  if (da != null && db != null && da !== db) return da - db
  if (a.createdAtMs !== b.createdAtMs) return a.createdAtMs - b.createdAtMs
  return a.decisionId.localeCompare(b.decisionId)
}

export function isVisibleInInbox(
  rec: DecisionV3Record,
  nowMs: number,
  opts: { includeTerminal?: boolean } = {},
): boolean {
  if (!opts.includeTerminal) {
    if (
      rec.status === 'RESOLVED' ||
      rec.status === 'REJECTED' ||
      rec.status === 'CANCELLED' ||
      rec.status === 'EXPIRED'
    ) {
      return false
    }
  }
  // Blocking cannot be hidden by snooze
  if (rec.blocking) return true
  if (rec.snoozedUntilMs != null && rec.snoozedUntilMs > nowMs) return false
  return true
}

export async function listDecisionsV3(
  deps: DecisionV3Deps,
  boardId: string,
  opts: { includeTerminal?: boolean; includeSnoozedHidden?: boolean } = {},
): Promise<Array<DecisionV3Record>> {
  const now = deps.clock.nowMs()
  // Lazy-expire
  const all = await deps.decisions.list(boardId)
  for (const d of all) {
    if (
      (d.status === 'OPEN' || d.status === 'ACKNOWLEDGED') &&
      d.expiresAtMs != null &&
      d.expiresAtMs <= now
    ) {
      await deps.decisions.put({
        ...d,
        status: 'EXPIRED',
        entityRev: d.entityRev + 1,
      })
    }
  }
  const fresh = await deps.decisions.list(boardId)
  const filtered = fresh.filter((d) => {
    if (opts.includeSnoozedHidden) return opts.includeTerminal || !isTerminalStatus(d.status)
    return isVisibleInInbox(d, now, opts)
  })
  return filtered.sort(compareDecisionsV3)
}

function isTerminalStatus(s: DecisionV3Status): boolean {
  return s === 'RESOLVED' || s === 'REJECTED' || s === 'CANCELLED' || s === 'EXPIRED'
}

function assertNoAuthorityBroadening(options: Array<DecisionOptionV3>): void {
  for (const o of options) {
    if (o.requestsProductionAuthority || o.requestsHoldAuthority || o.requestsProviderAuthority) {
      throw new DecisionV3Error(
        'AUTHORITY_BROADENING_FORBIDDEN',
        'Decision does not broaden production/HOLD/provider authority',
        { optionId: o.optionId },
      )
    }
  }
}

export async function openDecisionV3(
  deps: DecisionV3Deps,
  req: OpenDecisionV3Request,
): Promise<DecisionV3Record> {
  if (!req.title || !req.question || !req.type) {
    throw new DecisionV3Error('INVALID_INPUT', 'title, question, type required')
  }
  if (!req.options?.length) {
    throw new DecisionV3Error('INVALID_INPUT', 'at least one option required')
  }
  assertNoAuthorityBroadening(req.options)

  const board = await deps.atomic.getBoardState(req.boardId)
  if (req.expectedBoardRev !== board.boardRev) {
    throw new DecisionV3Error('STALE_REVISION', 'board rev mismatch on open', {
      expectedBoardRev: req.expectedBoardRev,
      currentBoardRev: board.boardRev,
    })
  }

  return deps.decisions.withBoardLock(req.boardId, async () => {
    const now = deps.clock.nowMs()
    const decisionId = req.decisionId ?? `dec-${randomUUID()}`
    const existing = await deps.decisions.get(req.boardId, decisionId)
    if (existing) {
      throw new DecisionV3Error('INVALID_INPUT', `decision already exists: ${decisionId}`)
    }
    const boardRev = await deps.atomic.bumpBoardRev(req.boardId)
    const audit = await deps.atomic.appendAudit({
      boardId: req.boardId,
      kind: 'DECISION_OPENED',
      atMs: now,
      atISO: deps.clock.nowISO(),
      actorId: req.actorId,
      subjectType: 'decision',
      subjectId: decisionId,
      detail: { blocking: req.blocking, severity: req.severity, type: req.type },
      material: true,
    })

    const rec: DecisionV3Record = {
      decisionId,
      boardId: req.boardId,
      projectId: req.projectId ?? null,
      featureId: req.featureId ?? null,
      taskId: req.taskId ?? null,
      runId: req.runId ?? null,
      type: req.type,
      severity: req.severity,
      title: req.title,
      question: req.question,
      evidence: [...(req.evidence ?? [])],
      options: req.options.map((o) => ({ ...o })),
      agentRecommendation: req.agentRecommendation ?? null,
      blocking: req.blocking,
      dueAt: req.dueAt ?? null,
      dueAtMs: req.dueAt ? Date.parse(req.dueAt) : null,
      createdAt: deps.clock.nowISO(),
      createdAtMs: now,
      snoozedUntil: null,
      snoozedUntilMs: null,
      status: 'OPEN',
      ownerId: null,
      resolverId: null,
      selectedOptionId: null,
      comment: null,
      expectedRev: 0,
      boardRev,
      entityRev: 1,
      scopedApprovalId: null,
      auditIds: [audit.eventId],
      expiresAt: req.expiresAt ?? null,
      expiresAtMs: req.expiresAt ? Date.parse(req.expiresAt) : null,
    }
    await deps.decisions.put(rec)
    return rec
  })
}

export async function acknowledgeDecisionV3(
  deps: DecisionV3Deps,
  opts: {
    boardId: string
    decisionId: string
    actorId: string
    expectedRev: number
    expectedBoardRev: number
  },
): Promise<DecisionV3Record> {
  return mutateDecision(deps, opts, (rec) => {
    if (rec.status !== 'OPEN') {
      throw new DecisionV3Error('INVALID_STATE', `cannot acknowledge from ${rec.status}`)
    }
    return {
      ...rec,
      status: 'ACKNOWLEDGED',
      ownerId: opts.actorId,
    }
  })
}

export async function snoozeDecisionV3(
  deps: DecisionV3Deps,
  opts: {
    boardId: string
    decisionId: string
    actorId: string
    snoozedUntil: string
    expectedRev: number
    expectedBoardRev: number
  },
): Promise<DecisionV3Record> {
  const untilMs = Date.parse(opts.snoozedUntil)
  if (!Number.isFinite(untilMs)) {
    throw new DecisionV3Error('INVALID_INPUT', 'snoozedUntil must be ISO timestamp')
  }
  return mutateDecision(deps, opts, async (rec, now) => {
    if (rec.blocking) {
      throw new DecisionV3Error(
        'SNOOZE_BLOCKED',
        'blocking decisions cannot be hidden by snooze',
        { decisionId: rec.decisionId },
      )
    }
    if (rec.status !== 'OPEN' && rec.status !== 'ACKNOWLEDGED') {
      throw new DecisionV3Error('INVALID_STATE', `cannot snooze from ${rec.status}`)
    }
    const audit = await deps.atomic.appendAudit({
      boardId: opts.boardId,
      kind: 'DECISION_SNOOZED',
      atMs: now,
      atISO: deps.clock.nowISO(),
      actorId: opts.actorId,
      subjectType: 'decision',
      subjectId: rec.decisionId,
      detail: { snoozedUntil: opts.snoozedUntil },
      material: true,
    })
    return {
      ...rec,
      snoozedUntil: opts.snoozedUntil,
      snoozedUntilMs: untilMs,
      auditIds: [...rec.auditIds, audit.eventId],
    }
  })
}

/**
 * Resolve with selected option. Declining option → still RESOLVED (not REJECTED).
 */
export async function resolveDecisionV3(
  deps: DecisionV3Deps,
  opts: {
    boardId: string
    decisionId: string
    actorId: string
    selectedOptionId: string
    comment?: string | null
    scopedApprovalId?: string | null
    expectedRev: number
    expectedBoardRev: number
  },
): Promise<DecisionV3Record> {
  return mutateDecision(deps, opts, async (rec, now) => {
    if (rec.status !== 'OPEN' && rec.status !== 'ACKNOWLEDGED') {
      throw new DecisionV3Error('INVALID_STATE', `cannot resolve from ${rec.status}`)
    }
    const opt = rec.options.find((o) => o.optionId === opts.selectedOptionId)
    if (!opt) {
      throw new DecisionV3Error('INVALID_INPUT', `unknown option ${opts.selectedOptionId}`)
    }
    if (
      opt.requestsProductionAuthority ||
      opt.requestsHoldAuthority ||
      opt.requestsProviderAuthority
    ) {
      throw new DecisionV3Error(
        'AUTHORITY_BROADENING_FORBIDDEN',
        'Decision does not broaden production/HOLD/provider authority',
      )
    }
    const audit = await deps.atomic.appendAudit({
      boardId: opts.boardId,
      kind: 'DECISION_RESOLVED',
      atMs: now,
      atISO: deps.clock.nowISO(),
      actorId: opts.actorId,
      subjectType: 'decision',
      subjectId: rec.decisionId,
      detail: {
        selectedOptionId: opts.selectedOptionId,
        declining: !!opt.declining,
        scopedApprovalId: opts.scopedApprovalId ?? null,
      },
      material: true,
    })
    return {
      ...rec,
      status: 'RESOLVED',
      resolverId: opts.actorId,
      selectedOptionId: opts.selectedOptionId,
      comment: opts.comment ?? null,
      scopedApprovalId: opts.scopedApprovalId ?? null,
      snoozedUntil: null,
      snoozedUntilMs: null,
      auditIds: [...rec.auditIds, audit.eventId],
    }
  })
}

/**
 * REJECTED = the request itself was rejected (not a declining option).
 */
export async function rejectDecisionV3(
  deps: DecisionV3Deps,
  opts: {
    boardId: string
    decisionId: string
    actorId: string
    comment?: string | null
    expectedRev: number
    expectedBoardRev: number
  },
): Promise<DecisionV3Record> {
  return mutateDecision(deps, opts, async (rec, now) => {
    if (rec.status !== 'OPEN' && rec.status !== 'ACKNOWLEDGED') {
      throw new DecisionV3Error('INVALID_STATE', `cannot reject from ${rec.status}`)
    }
    const audit = await deps.atomic.appendAudit({
      boardId: opts.boardId,
      kind: 'DECISION_REJECTED',
      atMs: now,
      atISO: deps.clock.nowISO(),
      actorId: opts.actorId,
      subjectType: 'decision',
      subjectId: rec.decisionId,
      detail: { comment: opts.comment ?? null },
      material: true,
    })
    return {
      ...rec,
      status: 'REJECTED',
      resolverId: opts.actorId,
      selectedOptionId: null,
      comment: opts.comment ?? null,
      snoozedUntil: null,
      snoozedUntilMs: null,
      auditIds: [...rec.auditIds, audit.eventId],
    }
  })
}

async function mutateDecision(
  deps: DecisionV3Deps,
  opts: {
    boardId: string
    decisionId: string
    actorId: string
    expectedRev: number
    expectedBoardRev: number
  },
  fn: (
    rec: DecisionV3Record,
    nowMs: number,
  ) => DecisionV3Record | Promise<DecisionV3Record>,
): Promise<DecisionV3Record> {
  return deps.decisions.withBoardLock(opts.boardId, async () => {
    const board = await deps.atomic.getBoardState(opts.boardId)
    if (opts.expectedBoardRev !== board.boardRev) {
      throw new DecisionV3Error('STALE_REVISION', 'board rev mismatch', {
        expectedBoardRev: opts.expectedBoardRev,
        currentBoardRev: board.boardRev,
      })
    }
    const rec = await deps.decisions.get(opts.boardId, opts.decisionId)
    if (!rec) {
      throw new DecisionV3Error('NOT_FOUND', `decision not found: ${opts.decisionId}`)
    }
    if (rec.entityRev !== opts.expectedRev) {
      throw new DecisionV3Error('STALE_REVISION', 'entity rev mismatch', {
        expectedRev: opts.expectedRev,
        currentRev: rec.entityRev,
      })
    }
    const now = deps.clock.nowMs()
    const patched = await fn(rec, now)
    const boardRev = await deps.atomic.bumpBoardRev(opts.boardId)
    const next: DecisionV3Record = {
      ...patched,
      entityRev: rec.entityRev + 1,
      boardRev,
    }
    await deps.decisions.put(next)
    return next
  })
}

export function createMemoryDecisionV3Store(): DecisionV3Store & {
  snapshot(): Array<DecisionV3Record>
} {
  const map = new Map<string, DecisionV3Record>()
  const chains = new Map<string, Promise<unknown>>()
  const key = (b: string, id: string) => `${b}::${id}`
  return {
    snapshot() {
      return [...map.values()].map((d) => ({
        ...d,
        options: d.options.map((o) => ({ ...o })),
        evidence: [...d.evidence],
        auditIds: [...d.auditIds],
      }))
    },
    async get(boardId, decisionId) {
      const d = map.get(key(boardId, decisionId))
      return d
        ? {
            ...d,
            options: d.options.map((o) => ({ ...o })),
            evidence: [...d.evidence],
            auditIds: [...d.auditIds],
          }
        : null
    },
    async put(rec) {
      map.set(key(rec.boardId, rec.decisionId), {
        ...rec,
        options: rec.options.map((o) => ({ ...o })),
        evidence: [...rec.evidence],
        auditIds: [...rec.auditIds],
      })
    },
    async list(boardId) {
      return [...map.values()]
        .filter((d) => d.boardId === boardId)
        .map((d) => ({
          ...d,
          options: d.options.map((o) => ({ ...o })),
          evidence: [...d.evidence],
          auditIds: [...d.auditIds],
        }))
    },
    async withBoardLock(boardId, fn) {
      const prev = chains.get(boardId) ?? Promise.resolve()
      let release!: () => void
      const gate = new Promise<void>((r) => {
        release = r
      })
      chains.set(boardId, prev.then(() => gate))
      await prev
      try {
        return await fn()
      } finally {
        release()
      }
    },
  }
}
