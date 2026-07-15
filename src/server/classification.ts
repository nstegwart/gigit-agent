// Pure classification domain (C1). No I/O / DB.
// contributesToProductReadiness is ALWAYS server-derived — never trust caller write.

import type {
  ClassificationEvaluation,
  ClassificationInvalidReason,
  ClassificationReceipt,
  DependencyJoin,
  MembershipProductLine,
  PinnedRevisionTuple,
  TaskClass,
  TaskClassificationRecord,
  TaskDisposition,
} from '#/lib/control-plane-types'
import {
  TASK_CLASSES,
  TASK_DISPOSITIONS,
} from '#/lib/control-plane-types'

const RECEIPT_HASH_RE = /^[a-f0-9]{16,128}$/i

/** Portfolio id for SALES_WEB_RELATED_BACKEND priority membership. */
export const PRIORITY_PORTFOLIO_ID = 'SALES_WEB_RELATED_BACKEND' as const

const MEMBERSHIP_PRODUCT_LINES = new Set<string>([
  'sales-rebuild',
  'mfs-web-original-upgrade',
  'backend',
])

const BACKEND_DEP_OUTCOMES = new Set<string>([
  'sales-rebuild',
  'mfs-web-original-upgrade',
])

/**
 * Receipt-valid outcome membership map bound to a pin
 * (canonicalSnapshotId / canonicalHash / boardRev / lifecycleRev).
 * Built only from current receipt-valid sales-rebuild | mfs-web-original-upgrade
 * classification product-lines at that pin. Absent/empty/stale → backend fails closed.
 */
export interface ReceiptValidOutcomeMembershipMap {
  canonicalSnapshotId: string
  canonicalHash: string
  boardRev: number
  lifecycleRev: number
  /** taskId → sales-rebuild | mfs-web-original-upgrade */
  byTaskId: ReadonlyMap<string, string>
}

/**
 * Pin-bound direct product-line membership allowlist (security R2).
 * Built server-side from current canonical snapshot project/repo/feature identities
 * only. Caller `membershipProductLine` / arbitrary hex `membershipProofHash` are
 * NEVER authority for sales-rebuild | mfs-web-original-upgrade.
 */
export interface DirectMembershipAllowlist {
  canonicalSnapshotId: string
  canonicalHash: string
  taskHash: string
  boardRev: number
  lifecycleRev: number
  /**
   * taskId → sales-rebuild | mfs-web-original-upgrade
   * Derived only from project/repo/feature identity allowlist at this pin.
   */
  byTaskId: ReadonlyMap<string, string>
}

/**
 * Context for portfolio membership validation.
 * - Backend (M1/r3): pin match + non-empty graph refs + pin-bound outcome map.
 * - Direct sales/mfs (R2): pin match + pin-bound DirectMembershipAllowlist hit.
 * No structural ROOT authority bypass; no self-asserted product-line/hex mint.
 */
export interface PriorityMembershipContext {
  /**
   * Current evaluation pin — REQUIRED for backend and direct sales/mfs membership.
   * Receipt pin fields must match (stale/absent → false).
   */
  pin?: PinnedRevisionTuple | null
  /**
   * Canonical dependency edges at the same pin
   * (`fromTaskId` depends on `toTaskId`).
   */
  dependencyJoins?: ReadonlyArray<DependencyJoin> | null
  /**
   * Direct dependency target task IDs for `receipt.taskId` from the pin graph.
   * Equivalent to joins where fromTaskId === receipt.taskId → toTaskId.
   */
  directDependencyTargets?: ReadonlyArray<string> | null
  /**
   * Pin-bound receipt-valid outcome membership map (preferred).
   * Must match evaluation pin + receipt on snapshot/hash/boardRev/lifecycleRev.
   */
  outcomeMembershipMap?: ReceiptValidOutcomeMembershipMap | null
  /**
   * Unbound convenience map. Accepted ONLY together with `pin` that matches the
   * receipt (map is treated as bound to that pin). Prefer `outcomeMembershipMap`.
   * Absent/empty still fails closed for backend.
   */
  outcomeProductLinesByTaskId?: ReadonlyMap<string, string> | null
  /**
   * Pin-bound direct membership allowlist (sales-rebuild | mfs-web-original-upgrade).
   * REQUIRED for direct product-line membership. Absent/stale/empty → fail closed
   * for those lines (caller product-line/hex alone never grants).
   */
  directMembershipAllowlist?: DirectMembershipAllowlist | null
}

/** Direct product lines granted only via pin-bound project/repo/feature allowlist. */
export const DIRECT_MEMBERSHIP_PRODUCT_LINES = [
  'sales-rebuild',
  'mfs-web-original-upgrade',
] as const

export type DirectMembershipProductLine =
  (typeof DIRECT_MEMBERSHIP_PRODUCT_LINES)[number]

/**
 * Match a project / feature / repo identity token to a direct product line.
 * Exact id match only — no free-form substring mint (security R2).
 */
export function matchDirectMembershipProductLine(
  identity: string | null | undefined,
): DirectMembershipProductLine | null {
  if (typeof identity !== 'string') return null
  const t = identity.trim()
  if (t === 'sales-rebuild' || t === 'mfs-web-original-upgrade') return t
  return null
}

/**
 * Build pin-bound direct membership allowlist from current snapshot entities + tasks.
 * Product line is derived ONLY from project id/name, feature id/name, or repository
 * identity equaling a direct product-line token — never from receipt fields.
 */
export function buildDirectMembershipAllowlist(
  pin: PinnedRevisionTuple,
  tasks: ReadonlyArray<{
    id: string
    projectId?: string | null
    featureContractId?: string | null
    featureId?: string | null
    repository?: string | null
    sourceRepoId?: string | null
  }>,
  entities: {
    projects?: ReadonlyArray<{
      id: string
      nama?: string | null
      name?: string | null
    }> | null
    features?: ReadonlyArray<{
      id: string
      nama?: string | null
      name?: string | null
      projectId?: string | null
    }> | null
  } = {},
): DirectMembershipAllowlist {
  /** identity key → product line (project:<id> | feature:<id> | repo:<id>) */
  const identityToLine = new Map<string, DirectMembershipProductLine>()

  for (const p of entities.projects ?? []) {
    if (!p || typeof p.id !== 'string' || !p.id.trim()) continue
    const line =
      matchDirectMembershipProductLine(p.id) ??
      matchDirectMembershipProductLine(p.nama ?? null) ??
      matchDirectMembershipProductLine(p.name ?? null)
    if (line) identityToLine.set(`project:${p.id.trim()}`, line)
  }
  for (const f of entities.features ?? []) {
    if (!f || typeof f.id !== 'string' || !f.id.trim()) continue
    const line =
      matchDirectMembershipProductLine(f.id) ??
      matchDirectMembershipProductLine(f.nama ?? null) ??
      matchDirectMembershipProductLine(f.name ?? null)
    if (line) identityToLine.set(`feature:${f.id.trim()}`, line)
    // Feature inherits project allowlist when feature itself is not a line token.
    if (!line && f.projectId && identityToLine.has(`project:${f.projectId}`)) {
      const pl = identityToLine.get(`project:${f.projectId}`)
      if (pl) identityToLine.set(`feature:${f.id.trim()}`, pl)
    }
  }

  const byTaskId = new Map<string, string>()
  for (const t of tasks) {
    if (!t || typeof t.id !== 'string' || !t.id.trim()) continue
    const projectId =
      typeof t.projectId === 'string' && t.projectId.trim() ? t.projectId.trim() : null
    const featureId =
      (typeof t.featureContractId === 'string' && t.featureContractId.trim()
        ? t.featureContractId.trim()
        : null) ??
      (typeof t.featureId === 'string' && t.featureId.trim() ? t.featureId.trim() : null)
    const repo =
      (typeof t.repository === 'string' && t.repository.trim()
        ? t.repository.trim()
        : null) ??
      (typeof t.sourceRepoId === 'string' && t.sourceRepoId.trim()
        ? t.sourceRepoId.trim()
        : null)

    const derived =
      (projectId ? identityToLine.get(`project:${projectId}`) : undefined) ??
      matchDirectMembershipProductLine(projectId) ??
      (featureId ? identityToLine.get(`feature:${featureId}`) : undefined) ??
      matchDirectMembershipProductLine(featureId) ??
      matchDirectMembershipProductLine(repo)
    if (derived) byTaskId.set(t.id.trim(), derived)
  }

  return {
    canonicalSnapshotId: pin.canonicalSnapshotId,
    canonicalHash: pin.canonicalHash,
    taskHash: pin.taskHash,
    boardRev: pin.boardRev,
    lifecycleRev: pin.lifecycleRev,
    byTaskId,
  }
}

/**
 * Strip self-asserted direct membership fields from a receipt before persistence.
 * sales-rebuild / mfs-web-original-upgrade product lines and their hex proofs are
 * never stored as authority (server derives at evaluation). Backend graph proof
 * fields are retained for graph validation. membershipRootAuthority is always stripped.
 */
export function stripSelfAssertedMembershipFields(
  receipt: ClassificationReceipt,
): ClassificationReceipt {
  const next: ClassificationReceipt = { ...receipt }
  // Always drop forgeable structural ROOT authority.
  if ('membershipRootAuthority' in next) {
    delete next.membershipRootAuthority
  }
  const line = next.membershipProductLine
  const isDirectLine =
    line === 'sales-rebuild' || line === 'mfs-web-original-upgrade'
  // Direct product-line self-assert: strip line + hex proof + portfolio claim.
  if (isDirectLine) {
    delete next.membershipProductLine
    delete next.membershipProofHash
    delete next.membershipPortfolioId
    return next
  }
  // Portfolio + hex without backend product-line is a hex-only mint attempt — strip.
  if (
    next.membershipPortfolioId === PRIORITY_PORTFOLIO_ID &&
    line !== 'backend'
  ) {
    delete next.membershipProductLine
    delete next.membershipProofHash
    delete next.membershipPortfolioId
  }
  return next
}

/**
 * Sanitize a classification record for persistence/import/upsert boundaries.
 * Strips self-asserted direct membership from nested receipt when present.
 */
export function sanitizeClassificationRecordForPersistence(
  record: TaskClassificationRecord,
): TaskClassificationRecord {
  if (!record.receipt) return record
  return {
    ...record,
    receipt: stripSelfAssertedMembershipFields(record.receipt),
  }
}

function pinMatchesReceipt(
  receipt: ClassificationReceipt,
  pin: PinnedRevisionTuple,
): boolean {
  return (
    receipt.canonicalSnapshotId === pin.canonicalSnapshotId &&
    receipt.canonicalHash === pin.canonicalHash &&
    receipt.taskHash === pin.taskHash &&
    receipt.boardRev === pin.boardRev &&
    receipt.lifecycleRev === pin.lifecycleRev
  )
}

/** Pin tuple fields used to bind the outcome membership map (no taskHash). */
function outcomeMapPinMatches(
  map: Pick<
    ReceiptValidOutcomeMembershipMap,
    'canonicalSnapshotId' | 'canonicalHash' | 'boardRev' | 'lifecycleRev'
  >,
  pin: PinnedRevisionTuple,
  receipt: ClassificationReceipt,
): boolean {
  return (
    map.canonicalSnapshotId === pin.canonicalSnapshotId &&
    map.canonicalHash === pin.canonicalHash &&
    map.boardRev === pin.boardRev &&
    map.lifecycleRev === pin.lifecycleRev &&
    map.canonicalSnapshotId === receipt.canonicalSnapshotId &&
    map.canonicalHash === receipt.canonicalHash &&
    map.boardRev === receipt.boardRev &&
    map.lifecycleRev === receipt.lifecycleRev
  )
}

/** Full pin bind for direct membership allowlist (includes taskHash). */
function directAllowlistPinMatches(
  allow: DirectMembershipAllowlist,
  pin: PinnedRevisionTuple,
  receipt: ClassificationReceipt,
): boolean {
  return (
    allow.canonicalSnapshotId === pin.canonicalSnapshotId &&
    allow.canonicalHash === pin.canonicalHash &&
    allow.taskHash === pin.taskHash &&
    allow.boardRev === pin.boardRev &&
    allow.lifecycleRev === pin.lifecycleRev &&
    allow.canonicalSnapshotId === receipt.canonicalSnapshotId &&
    allow.canonicalHash === receipt.canonicalHash &&
    allow.taskHash === receipt.taskHash &&
    allow.boardRev === receipt.boardRev &&
    allow.lifecycleRev === receipt.lifecycleRev
  )
}

/**
 * Direct sales-rebuild | mfs-web-original-upgrade membership (security R2).
 * - NEVER trusts caller membershipProductLine alone
 * - NEVER trusts arbitrary membershipProofHash hex alone
 * - REQUIRES current pin match (snapshot/hash/taskHash/boardRev/lifecycleRev)
 * - REQUIRES pin-bound DirectMembershipAllowlist with taskId → product line
 * - If caller asserted a product line, it must match derived (defense in depth)
 */
function isDirectMembershipProven(
  receipt: ClassificationReceipt,
  ctx: PriorityMembershipContext | null | undefined,
): boolean {
  const pin = ctx?.pin
  if (!pin || !pinMatchesReceipt(receipt, pin)) return false

  const allow = ctx?.directMembershipAllowlist
  if (!allow || !directAllowlistPinMatches(allow, pin, receipt)) return false
  if (!allow.byTaskId || allow.byTaskId.size === 0) return false

  const derived = allow.byTaskId.get(receipt.taskId)
  if (derived !== 'sales-rebuild' && derived !== 'mfs-web-original-upgrade') {
    return false
  }

  // Defense in depth: self-asserted product line must not disagree with derived.
  const claimed = receipt.membershipProductLine
  if (
    typeof claimed === 'string' &&
    claimed.trim() !== '' &&
    claimed !== derived
  ) {
    return false
  }

  return true
}

/**
 * Resolve current pin-bound outcome membership lines for backend validation.
 * Fail-closed when map absent, empty, or pin-binding stale.
 */
function resolveOutcomeMembershipLines(
  receipt: ClassificationReceipt,
  pin: PinnedRevisionTuple,
  ctx: PriorityMembershipContext,
): ReadonlyMap<string, string> | null {
  const bound = ctx.outcomeMembershipMap
  if (bound) {
    if (!outcomeMapPinMatches(bound, pin, receipt)) return null
    if (!bound.byTaskId || bound.byTaskId.size === 0) return null
    return bound.byTaskId
  }
  // Convenience path: unbound map is only accepted when evaluation pin matches receipt
  // (caller asserts the map is for this pin). Still require non-empty.
  const loose = ctx.outcomeProductLinesByTaskId
  if (!loose || loose.size === 0) return null
  return loose
}

function normalizeRefTokens(refs: ReadonlyArray<string> | null | undefined): string[] {
  if (!refs || !Array.isArray(refs)) return []
  const out: string[] = []
  for (const r of refs) {
    if (typeof r !== 'string') continue
    const s = r.trim()
    if (!s) continue
    out.push(s)
  }
  return out
}

/**
 * Build allowed direct dependency targets for a backend task from graph material.
 * Fail-closed when no graph material is available.
 */
function resolveDirectTargets(
  taskId: string,
  ctx: PriorityMembershipContext | null | undefined,
): { targets: Set<string>; hasGraphMaterial: boolean } {
  const targets = new Set<string>()
  let hasGraphMaterial = false

  const joins = ctx?.dependencyJoins
  if (joins && Array.isArray(joins) && joins.length > 0) {
    hasGraphMaterial = true
    for (const j of joins) {
      if (!j || typeof j.fromTaskId !== 'string' || typeof j.toTaskId !== 'string') continue
      if (j.fromTaskId === taskId && j.toTaskId) {
        targets.add(j.toTaskId)
      }
    }
  }

  const direct = ctx?.directDependencyTargets
  if (direct && Array.isArray(direct) && direct.length > 0) {
    hasGraphMaterial = true
    for (const t of direct) {
      if (typeof t === 'string' && t.trim()) targets.add(t.trim())
    }
  }

  return { targets, hasGraphMaterial }
}

/**
 * Resolve a ref token to a dependency target task id, or null if invalid.
 * Accepts bare toTaskId or "fromTaskId->toTaskId" / "fromTaskId→toTaskId" edge keys
 * where from must equal the backend task.
 */
function resolveRefToTarget(
  ref: string,
  taskId: string,
  allowedTargets: Set<string>,
  joins: ReadonlyArray<DependencyJoin> | null | undefined,
): string | null {
  if (allowedTargets.has(ref)) return ref

  const edgeMatch = /^(.+?)(?:->|→|\u2192)(.+)$/.exec(ref)
  if (edgeMatch) {
    const from = edgeMatch[1]!.trim()
    const to = edgeMatch[2]!.trim()
    if (from !== taskId || !to) return null
    if (allowedTargets.has(to)) return to
    // Edge key may appear in joins even if targets set was built differently.
    if (joins) {
      for (const j of joins) {
        if (j.fromTaskId === from && j.toTaskId === to) return to
      }
    }
    return null
  }

  return null
}

/**
 * Backend membership (strict direct dependency):
 * - NEVER trusts satisfied:true / membershipProofHash alone
 * - NEVER accepts forgeable structural membershipRootAuthority (removed)
 * - REQUIRES current pin match (snapshot/hash/taskHash/boardRev/lifecycleRev)
 * - REQUIRES non-empty refs validated against current pin canonical graph
 * - REQUIRES current receipt-valid outcome membership map bound to pin
 *   (snapshot/hash/boardRev/lifecycleRev); absent/stale/empty → fail closed
 * - Every resolved ref target must appear in the outcome map with targetOutcome
 */
function isBackendMembershipProven(
  receipt: ClassificationReceipt,
  ctx: PriorityMembershipContext | null | undefined,
): boolean {
  const dep = receipt.membershipDirectDependencyProof
  if (!dep || dep.satisfied !== true) return false

  // membershipRootAuthority is intentionally ignored — structural ROOT fields are
  // forgeable without cryptographic verification and are not membership authority.

  // Pin REQUIRED + must match receipt (absent/stale → fail closed).
  const pin = ctx?.pin
  if (!pin || !pinMatchesReceipt(receipt, pin)) return false

  const refs = normalizeRefTokens(dep.refs)
  if (refs.length === 0) return false

  const outcome = dep.targetOutcome
  if (typeof outcome !== 'string' || !BACKEND_DEP_OUTCOMES.has(outcome)) {
    return false
  }

  const { targets: allowedTargets, hasGraphMaterial } = resolveDirectTargets(
    receipt.taskId,
    ctx,
  )
  // Graph/refs absent or empty at evaluation → fail closed (cannot self-assert).
  if (!hasGraphMaterial || allowedTargets.size === 0) return false

  // Receipt-valid outcome membership map bound to pin — REQUIRED.
  const lines = resolveOutcomeMembershipLines(receipt, pin, ctx)
  if (!lines) return false

  const joins = ctx?.dependencyJoins ?? null
  const resolvedTargets: string[] = []
  for (const ref of refs) {
    const target = resolveRefToTarget(ref, receipt.taskId, allowedTargets, joins)
    if (target == null) return false
    resolvedTargets.push(target)
  }
  if (resolvedTargets.length === 0) return false

  // Every ref target must be present on the pin-bound outcome map with targetOutcome.
  for (const t of resolvedTargets) {
    const line = lines.get(t)
    if (line !== outcome) return false
  }

  return true
}

/**
 * Source-ground portfolio membership gate (PRIORITY ALLOCATION / AC-PRIORITY-01 /
 * security M1 backend + R2 direct membership).
 *
 * Direct sales-rebuild | mfs-web-original-upgrade:
 * - NEVER trusts caller membershipProductLine or arbitrary hex membershipProofHash
 * - REQUIRES pin-bound DirectMembershipAllowlist derived from project/repo/feature
 *   identities at canonicalSnapshotId/hash/taskHash/boardRev/lifecycleRev
 * - REQUIRES receipt pin match (stale → false)
 *
 * Backend:
 * - membershipPortfolioId === SALES_WEB_RELATED_BACKEND
 * - membershipProofHash hex shape (format only; not authority alone)
 * - membershipProductLine === 'backend'
 * - NEVER trust satisfied:true/hash alone; NEVER trust structural ROOT authority —
 *   non-empty refs validated against current pin dependency graph PLUS current
 *   receipt-valid outcome membership map bound to snapshot/hash/boardRev/lifecycleRev.
 *   Fail closed when pin/graph/map/refs absent or stale.
 */
export function isPriorityPortfolioMembership(
  receipt: ClassificationReceipt | null | undefined,
  ctx?: PriorityMembershipContext | null,
): boolean {
  if (!receipt) return false

  // R2: direct product-line path — allowlist authority (before self-asserted fields).
  // Caller product-line/hex alone never grants; allowlist miss falls through.
  if (isDirectMembershipProven(receipt, ctx)) {
    return true
  }

  // Backend path still requires portfolio id + hex shape + product-line backend.
  if (receipt.membershipPortfolioId !== PRIORITY_PORTFOLIO_ID) return false
  const proof = receipt.membershipProofHash
  if (typeof proof !== 'string' || !RECEIPT_HASH_RE.test(proof)) return false
  const line = receipt.membershipProductLine
  if (line === 'backend') {
    return isBackendMembershipProven(receipt, ctx)
  }
  // sales-rebuild | mfs-web-original-upgrade self-assert (product line + hex, no allowlist)
  // MUST fail closed — never grant from caller fields alone.
  return false
}

export function isMembershipProductLine(value: unknown): value is MembershipProductLine {
  return typeof value === 'string' && MEMBERSHIP_PRODUCT_LINES.has(value)
}

export function isTaskClass(value: unknown): value is TaskClass {
  return typeof value === 'string' && (TASK_CLASSES as ReadonlyArray<string>).includes(value)
}

export function isTaskDisposition(value: unknown): value is TaskDisposition {
  return (
    typeof value === 'string' &&
    (TASK_DISPOSITIONS as ReadonlyArray<string>).includes(value)
  )
}

function pinMatches(
  receipt: ClassificationReceipt,
  pin: PinnedRevisionTuple,
  reasons: Array<ClassificationInvalidReason>,
): void {
  if (receipt.canonicalSnapshotId !== pin.canonicalSnapshotId) {
    reasons.push('STALE_CANONICAL_SNAPSHOT')
  }
  if (receipt.canonicalHash !== pin.canonicalHash) {
    reasons.push('STALE_CANONICAL_HASH')
  }
  if (receipt.taskHash !== pin.taskHash) {
    reasons.push('STALE_TASK_HASH')
  }
  if (receipt.bindingMode === 'CANONICAL_PIN') {
    const canonicalBoardRev = receipt.canonicalBoardRev
    // Canonical-bound receipts are valid across later volatile board mutations,
    // but never before their atomic publication and never with malformed lineage.
    if (
      !Number.isSafeInteger(canonicalBoardRev) ||
      Number(canonicalBoardRev) < 0 ||
      receipt.boardRev !== Number(canonicalBoardRev) + 1 ||
      pin.boardRev < receipt.boardRev
    ) {
      reasons.push('STALE_BOARD_REV')
    }
  } else if (receipt.boardRev !== pin.boardRev) {
    reasons.push('STALE_BOARD_REV')
  }
  if (receipt.lifecycleRev !== pin.lifecycleRev) {
    reasons.push('STALE_LIFECYCLE_REV')
  }
}

/**
 * Resolve evaluation clock.
 * - Default: real current server time (epoch / disable-expiry is forbidden).
 * - Deterministic tests may inject `opts.now` as an ISO timestamp.
 * - Invalid injected time → null (caller must fail closed).
 */
function resolveEvaluationNow(opts: { now?: string } = {}): string | null {
  if (opts.now !== undefined) {
    if (typeof opts.now !== 'string' || opts.now.trim() === '') return null
    const ms = Date.parse(opts.now)
    if (Number.isNaN(ms)) return null
    return new Date(ms).toISOString()
  }
  return new Date().toISOString()
}

/**
 * Fail-closed classification evaluation (AC-CLASS-01..05).
 * Missing/stale/invalid receipt → repair row, tracked once as BLOCKED:DATA_INTEGRITY.
 * Only fully valid classified HOLD/EXCLUDE is outside tracked work.
 * Receipt expiry is checked against real server time by default.
 */
export function evaluateClassification(
  record: TaskClassificationRecord | null | undefined,
  pin: PinnedRevisionTuple,
  opts: { now?: string } = {},
): ClassificationEvaluation {
  const now = resolveEvaluationNow(opts)
  const clockInvalid = now === null

  if (!record) {
    return {
      taskId: '',
      taskClass: 'UNCLASSIFIED',
      disposition: 'UNCLASSIFIED',
      contributesToProductReadiness: false,
      isFullyClassifiedValid: false,
      isClassificationRepair: true,
      isOutsideTrackedWork: false,
      valid: false,
      reasons: ['MISSING_RECORD'],
      blockReason: 'DATA_INTEGRITY',
    }
  }

  const taskId = record.taskId
  const reasons: Array<ClassificationInvalidReason> = []

  // Invalid injected clock fails closed (no silent epoch / open window).
  if (clockInvalid) {
    reasons.push('STALE_RECEIPT_EXPIRED')
  }

  if (!isTaskClass(record.taskClass)) {
    reasons.push('INVALID_TASK_CLASS')
  }
  if (!isTaskDisposition(record.disposition)) {
    reasons.push('INVALID_DISPOSITION')
  }

  const taskClass: TaskClass = isTaskClass(record.taskClass)
    ? record.taskClass
    : 'UNCLASSIFIED'
  const disposition: TaskDisposition = isTaskDisposition(record.disposition)
    ? record.disposition
    : 'UNCLASSIFIED'

  if (taskClass === 'UNCLASSIFIED') reasons.push('UNCLASSIFIED_TASK_CLASS')
  if (disposition === 'UNCLASSIFIED') reasons.push('UNCLASSIFIED_DISPOSITION')

  const receipt = record.receipt
  if (!receipt) {
    reasons.push('MISSING_RECEIPT')
  } else {
    if (!receipt.receiptId || !receipt.receiptHash) {
      reasons.push('INVALID_RECEIPT_HASH')
    } else if (!RECEIPT_HASH_RE.test(receipt.receiptHash)) {
      reasons.push('INVALID_RECEIPT_HASH')
    }
    if (receipt.taskId !== taskId) reasons.push('RECEIPT_TASK_MISMATCH')
    if (receipt.taskClass !== taskClass) reasons.push('RECEIPT_CLASS_MISMATCH')
    if (receipt.disposition !== disposition) reasons.push('RECEIPT_DISPOSITION_MISMATCH')
    pinMatches(receipt, pin, reasons)
    // Compare against real (or injected-valid) server time — never epoch-disable.
    if (!clockInvalid && receipt.expiresAt) {
      const expMs = Date.parse(receipt.expiresAt)
      if (Number.isNaN(expMs) || expMs < Date.parse(now!)) {
        reasons.push('STALE_RECEIPT_EXPIRED')
      }
    }
  }

  // Deduplicate reasons while preserving order
  const uniqReasons = [...new Set(reasons)]
  const valid = uniqReasons.length === 0

  const isFullyClassifiedValid =
    valid && taskClass !== 'UNCLASSIFIED' && disposition !== 'UNCLASSIFIED'

  // AC-CLASS-05: any UNCLASSIFIED or invalid receipt is classification repair
  // even when disposition is HOLD/EXCLUDE.
  const isClassificationRepair = !isFullyClassifiedValid

  const isOutsideTrackedWork =
    isFullyClassifiedValid && (disposition === 'HOLD' || disposition === 'EXCLUDE')

  // Membership proof required for product contribution (AC-CLASS-03 / PRIORITY-01).
  // PRODUCT+ACTIVE needs valid receipt; membership hash optional unless portfolio-bound.
  // contributesToProductReadiness NEVER accepts caller-written value.
  const contributesToProductReadiness =
    isFullyClassifiedValid &&
    taskClass === 'PRODUCT' &&
    disposition === 'ACTIVE'

  return {
    taskId,
    taskClass,
    disposition,
    contributesToProductReadiness,
    isFullyClassifiedValid,
    isClassificationRepair,
    isOutsideTrackedWork,
    valid,
    reasons: uniqReasons,
    blockReason: isClassificationRepair ? 'DATA_INTEGRITY' : null,
  }
}

/**
 * Server-derived contribution flag (AC-CLASS-03).
 * Explicitly ignores any caller-supplied contributesToProductReadiness.
 */
export function contributesToProductReadiness(
  record: TaskClassificationRecord | null | undefined,
  pin: PinnedRevisionTuple,
  opts: { now?: string } = {},
): boolean {
  // Strip caller write before evaluation — contribution is read-only derived.
  if (record && 'contributesToProductReadiness' in record) {
    const { contributesToProductReadiness: _ignored, ...rest } = record
    return evaluateClassification(rest, pin, opts).contributesToProductReadiness
  }
  return evaluateClassification(record, pin, opts).contributesToProductReadiness
}

/**
 * Whether a task enters trackedWorkDenominator (AC-BUCKET-06 / AC-CLASS-05).
 * ACTIVE dispositions + classification-repair rows once; valid HOLD/EXCLUDE out.
 */
export function isTrackedWork(
  evaluation: ClassificationEvaluation,
): boolean {
  if (evaluation.isOutsideTrackedWork) return false
  if (evaluation.isClassificationRepair) return true
  return evaluation.disposition === 'ACTIVE'
}

/**
 * productDenominator membership (AC-CLASS-04).
 */
export function isProductDenominatorMember(
  evaluation: ClassificationEvaluation,
): boolean {
  return evaluation.contributesToProductReadiness
}
