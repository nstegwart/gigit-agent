/**
 * Decision inbox V3: exact schema/status/order, blocking/snooze/resurface,
 * reject-vs-declining-option, expiry, expectedRev+boardRev, scoped approval/audit.
 * Decisions never broaden production/HOLD/provider authority.
 */
import { randomUUID } from 'node:crypto'

import type { ControlPlaneAtomicStore, ControlPlaneClock } from './board-store'
import {
  beginIdempotent,
  completeIdempotent,
  type IdempotencyStorage,
  IdempotencyError,
} from './idempotency'

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
  | 'IDEMPOTENCY_CONFLICT'

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
  idempotency: IdempotencyStorage
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
  /** Create requires 0. */
  entityExpectedRev: number
  expectedBoardRev: number
  canonicalHash: string
  currentPinHash?: string | null
  idempotencyKey: string
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

/**
 * Normalize a single option for open_decision_v3 idempotency hashing.
 * Order of the options array is preserved (caller maps in request order).
 * tradeoffs + declining + authority flags are material.
 */
export function normalizeOpenDecisionOptionForHash(
  o: DecisionOptionV3,
): Record<string, unknown> {
  return {
    optionId: o.optionId,
    label: o.label,
    declining: !!o.declining,
    tradeoffs: o.tradeoffs == null || o.tradeoffs === '' ? null : String(o.tradeoffs),
    requestsProductionAuthority: !!o.requestsProductionAuthority,
    requestsHoldAuthority: !!o.requestsHoldAuthority,
    requestsProviderAuthority: !!o.requestsProviderAuthority,
  }
}

/**
 * Canonical material request body for open_decision_v3 idempotency.
 * Independent of transport: every material field that defines open intent.
 * Covers severity, ordered options/tradeoffs, blocking, taskId, runId, links
 * (project/feature), evidence, actor, revs, pin hash — not only title/type.
 * currentPinHash is CAS-only (not body-hashed); idempotencyKey is scope-only.
 */
export function openDecisionV3IdempotencyBody(
  req: OpenDecisionV3Request,
): Record<string, unknown> {
  return {
    actorId: req.actorId,
    boardId: req.boardId,
    decisionId: req.decisionId ?? null,
    projectId: req.projectId ?? null,
    featureId: req.featureId ?? null,
    taskId: req.taskId ?? null,
    runId: req.runId ?? null,
    type: req.type,
    severity: req.severity,
    title: req.title,
    question: req.question,
    evidence: [...(req.evidence ?? [])],
    options: (req.options ?? []).map(normalizeOpenDecisionOptionForHash),
    agentRecommendation: req.agentRecommendation ?? null,
    blocking: !!req.blocking,
    dueAt: req.dueAt ?? null,
    expiresAt: req.expiresAt ?? null,
    entityExpectedRev: req.entityExpectedRev,
    expectedBoardRev: req.expectedBoardRev,
    canonicalHash: String(req.canonicalHash ?? '').trim(),
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
  if (typeof req.entityExpectedRev !== 'number' || !Number.isInteger(req.entityExpectedRev)) {
    throw new DecisionV3Error(
      'INVALID_INPUT',
      'entityExpectedRev is required (create=0) — no silent default',
    )
  }
  if (typeof req.expectedBoardRev !== 'number' || !Number.isInteger(req.expectedBoardRev)) {
    throw new DecisionV3Error('INVALID_INPUT', 'expectedBoardRev is required — no silent default')
  }
  if (!req.canonicalHash || !String(req.canonicalHash).trim()) {
    throw new DecisionV3Error('INVALID_INPUT', 'canonicalHash is required (current pin hash)')
  }
  if (!req.idempotencyKey || !String(req.idempotencyKey).trim()) {
    throw new DecisionV3Error('INVALID_INPUT', 'idempotencyKey is required')
  }
  if (
    req.currentPinHash != null &&
    req.currentPinHash !== '' &&
    req.currentPinHash !== req.canonicalHash
  ) {
    throw new DecisionV3Error('STALE_REVISION', 'canonical hash mismatch vs current pin', {
      expectedCanonicalHash: req.canonicalHash,
      currentPinHash: req.currentPinHash,
    })
  }
  if (req.entityExpectedRev !== 0) {
    throw new DecisionV3Error(
      'STALE_REVISION',
      'open_decision_v3 create requires entityExpectedRev 0',
      { entityExpectedRev: req.entityExpectedRev, currentEntityRev: 0 },
    )
  }
  assertNoAuthorityBroadening(req.options)

  let begin
  try {
    begin = await beginIdempotent(deps.idempotency, {
      scope: {
        actorId: req.actorId,
        boardId: req.boardId,
        endpoint: 'open_decision_v3',
        key: req.idempotencyKey.trim(),
      },
      requestBody: openDecisionV3IdempotencyBody(req),
      nowMs: deps.clock.nowMs(),
    })
  } catch (e) {
    if (e instanceof IdempotencyError) {
      throw new DecisionV3Error('IDEMPOTENCY_CONFLICT', e.message)
    }
    throw e
  }
  if (begin.kind === 'REPLAY' && begin.record) {
    return begin.record.responseBody as DecisionV3Record
  }

  try {
    const board = await deps.atomic.getBoardState(req.boardId)
    if (req.expectedBoardRev !== board.boardRev) {
      throw new DecisionV3Error('STALE_REVISION', 'board rev mismatch on open', {
        expectedBoardRev: req.expectedBoardRev,
        currentBoardRev: board.boardRev,
      })
    }

    const rec = await deps.decisions.withBoardLock(req.boardId, async () => {
      const now = deps.clock.nowMs()
      const decisionId = req.decisionId ?? `dec-${randomUUID()}`
      const existing = await deps.decisions.get(req.boardId, decisionId)
      if (existing) {
        throw new DecisionV3Error('INVALID_INPUT', `decision already exists: ${decisionId}`)
      }
      // Single board-rev bump per successful open.
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

      const next: DecisionV3Record = {
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
      await deps.decisions.put(next)
      return next
    })
    await completeIdempotent(deps.idempotency, begin.scopeHash, 200, rec, begin.requestHash)
    return rec
  } catch (e) {
    try {
      await deps.idempotency.delete(begin.scopeHash)
    } catch {
      /* ignore */
    }
    if (e instanceof IdempotencyError) {
      throw new DecisionV3Error('IDEMPOTENCY_CONFLICT', e.message)
    }
    throw e
  }
}

/**
 * Full owner-mutation envelope shared by acknowledge / resolve / reject / snooze.
 * entityExpectedRev is accepted as alias of expectedRev (CAS on decision.entityRev).
 * 24h idempotency + pin-hash CAS; single board-rev bump inside mutateDecision only.
 */
export interface DecisionOwnerMutationEnvelope {
  boardId: string
  decisionId: string
  actorId: string
  /** CAS on decision.entityRev. Alias: entityExpectedRev. */
  expectedRev: number
  expectedBoardRev: number
  /** Client/route pin hash at act time. */
  canonicalHash: string
  /** Server-resolved current pin hash when available. */
  currentPinHash?: string | null
  /** 24h idempotency key (unique+stable per action intent). */
  idempotencyKey: string
  /**
   * Alias for expectedRev (MCP / envelope parity). When both set, must match.
   * Prefer expectedRev; entityExpectedRev is accepted for callers that use the
   * open_decision_v3 field name.
   */
  entityExpectedRev?: number
}

function resolveEntityExpectedRev(opts: {
  expectedRev?: number
  entityExpectedRev?: number
}): number {
  if (
    typeof opts.entityExpectedRev === 'number' &&
    typeof opts.expectedRev === 'number' &&
    opts.entityExpectedRev !== opts.expectedRev
  ) {
    throw new DecisionV3Error(
      'INVALID_INPUT',
      'entityExpectedRev and expectedRev disagree',
      { entityExpectedRev: opts.entityExpectedRev, expectedRev: opts.expectedRev },
    )
  }
  const rev =
    typeof opts.expectedRev === 'number'
      ? opts.expectedRev
      : typeof opts.entityExpectedRev === 'number'
        ? opts.entityExpectedRev
        : NaN
  if (!Number.isInteger(rev)) {
    throw new DecisionV3Error(
      'INVALID_INPUT',
      'expectedRev/entityExpectedRev is required — no silent default',
    )
  }
  return rev
}

export function assertDecisionOwnerEnvelope(
  opts: DecisionOwnerMutationEnvelope,
  endpoint: string,
): { expectedRev: number; idempotencyKey: string; canonicalHash: string } {
  const expectedRev = resolveEntityExpectedRev(opts)
  if (typeof opts.expectedBoardRev !== 'number' || !Number.isInteger(opts.expectedBoardRev)) {
    throw new DecisionV3Error('INVALID_INPUT', 'expectedBoardRev is required — no silent default')
  }
  if (!opts.canonicalHash || !String(opts.canonicalHash).trim()) {
    throw new DecisionV3Error('INVALID_INPUT', 'canonicalHash is required (current pin hash)')
  }
  if (!opts.idempotencyKey || !String(opts.idempotencyKey).trim()) {
    throw new DecisionV3Error(
      'INVALID_INPUT',
      `idempotencyKey is required for ${endpoint}`,
    )
  }
  if (
    opts.currentPinHash != null &&
    opts.currentPinHash !== '' &&
    opts.currentPinHash !== opts.canonicalHash
  ) {
    throw new DecisionV3Error('STALE_REVISION', 'canonical hash mismatch vs current pin', {
      expectedCanonicalHash: opts.canonicalHash,
      currentPinHash: opts.currentPinHash,
      endpoint,
    })
  }
  return {
    expectedRev,
    idempotencyKey: opts.idempotencyKey.trim(),
    canonicalHash: String(opts.canonicalHash).trim(),
  }
}

/**
 * Idempotent owner mutation wrapper: REPLAY skips mutate (no double board bump).
 * Conflict → DecisionV3Error IDEMPOTENCY_CONFLICT. Failure cleans in-progress key.
 */
async function withIdempotentOwnerMutation(
  deps: DecisionV3Deps,
  endpoint: string,
  opts: DecisionOwnerMutationEnvelope,
  requestBody: Record<string, unknown>,
  fn: (
    rec: DecisionV3Record,
    nowMs: number,
  ) => DecisionV3Record | Promise<DecisionV3Record>,
): Promise<DecisionV3Record> {
  const env = assertDecisionOwnerEnvelope(opts, endpoint)
  const casOpts = {
    boardId: opts.boardId,
    decisionId: opts.decisionId,
    actorId: opts.actorId,
    expectedRev: env.expectedRev,
    expectedBoardRev: opts.expectedBoardRev,
  }

  let begin
  try {
    begin = await beginIdempotent(deps.idempotency, {
      scope: {
        actorId: opts.actorId,
        boardId: opts.boardId,
        endpoint,
        key: env.idempotencyKey,
      },
      requestBody: {
        ...requestBody,
        decisionId: opts.decisionId,
        expectedRev: env.expectedRev,
        expectedBoardRev: opts.expectedBoardRev,
        canonicalHash: env.canonicalHash,
      },
      nowMs: deps.clock.nowMs(),
    })
  } catch (e) {
    if (e instanceof IdempotencyError) {
      throw new DecisionV3Error('IDEMPOTENCY_CONFLICT', e.message)
    }
    throw e
  }

  if (begin.kind === 'REPLAY' && begin.record) {
    return begin.record.responseBody as DecisionV3Record
  }

  try {
    // Single board-rev bump lives inside mutateDecision only.
    const result = await mutateDecision(deps, casOpts, fn)
    await completeIdempotent(deps.idempotency, begin.scopeHash, 200, result, begin.requestHash)
    return result
  } catch (e) {
    try {
      await deps.idempotency.delete(begin.scopeHash)
    } catch {
      /* ignore */
    }
    if (e instanceof IdempotencyError) {
      throw new DecisionV3Error('IDEMPOTENCY_CONFLICT', e.message)
    }
    throw e
  }
}

export async function acknowledgeDecisionV3(
  deps: DecisionV3Deps,
  opts: DecisionOwnerMutationEnvelope,
): Promise<DecisionV3Record> {
  return withIdempotentOwnerMutation(
    deps,
    'acknowledge_decision_v3',
    opts,
    {},
    (rec) => {
      if (rec.status !== 'OPEN') {
        throw new DecisionV3Error('INVALID_STATE', `cannot acknowledge from ${rec.status}`)
      }
      return {
        ...rec,
        status: 'ACKNOWLEDGED',
        ownerId: opts.actorId,
      }
    },
  )
}

export async function snoozeDecisionV3(
  deps: DecisionV3Deps,
  opts: DecisionOwnerMutationEnvelope & { snoozedUntil: string },
): Promise<DecisionV3Record> {
  const untilMs = Date.parse(opts.snoozedUntil)
  if (!Number.isFinite(untilMs)) {
    throw new DecisionV3Error('INVALID_INPUT', 'snoozedUntil must be ISO timestamp')
  }
  return withIdempotentOwnerMutation(
    deps,
    'snooze_decision_v3',
    opts,
    { snoozedUntil: opts.snoozedUntil },
    async (rec, now) => {
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
    },
  )
}

/**
 * Resolve with selected option. Declining option → still RESOLVED (not REJECTED).
 */
export async function resolveDecisionV3(
  deps: DecisionV3Deps,
  opts: DecisionOwnerMutationEnvelope & {
    selectedOptionId: string
    comment?: string | null
    scopedApprovalId?: string | null
  },
): Promise<DecisionV3Record> {
  return withIdempotentOwnerMutation(
    deps,
    'resolve_decision_v3',
    opts,
    {
      selectedOptionId: opts.selectedOptionId,
      comment: opts.comment ?? null,
      scopedApprovalId: opts.scopedApprovalId ?? null,
    },
    async (rec, now) => {
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
    },
  )
}

/**
 * REJECTED = the request itself was rejected (not a declining option).
 */
export async function rejectDecisionV3(
  deps: DecisionV3Deps,
  opts: DecisionOwnerMutationEnvelope & { comment?: string | null },
): Promise<DecisionV3Record> {
  return withIdempotentOwnerMutation(
    deps,
    'reject_decision_v3',
    opts,
    { comment: opts.comment ?? null },
    async (rec, now) => {
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
    },
  )
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
    // Exactly one board-rev bump per successful mutation (not on idempotent REPLAY).
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
