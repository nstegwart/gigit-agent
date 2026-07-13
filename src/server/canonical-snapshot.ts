/**
 * MFS_CANONICAL_TASK_SNAPSHOT_V1 — types, validator, producer.
 * Deterministic stable-sorted canonical JSON + SHA-256.
 * No secrets. DISTINCT counts. Same logical input in different order → identical payload/hash.
 */
import { createHash } from 'node:crypto'
import type {
  DependencyJoin,
  FeatureContractJoin,
  NodeJoin,
  PrimaryOwnership,
  TaskClass,
  TaskDisposition,
} from '#/lib/control-plane-types'
import { TASK_CLASSES, TASK_DISPOSITIONS } from '#/lib/control-plane-types'

export const CANONICAL_SNAPSHOT_SCHEMA = 'MFS_CANONICAL_TASK_SNAPSHOT_V1' as const
export const CANONICALIZATION_ALGORITHM = 'stable-sorted-json-sha256-v1' as const
export const DEFAULT_PRODUCER_VERSION = 'c1c-1.0.0' as const

// ---- payload element shapes (definition-only; no lifecycle evidence) ----

export interface CanonicalProject {
  id: string
  name?: string | null
  [k: string]: unknown
}

export interface CanonicalFlow {
  id: string
  projectId: string
  name?: string | null
  [k: string]: unknown
}

export interface CanonicalNode {
  id: string
  flowId: string
  projectId?: string | null
  name?: string | null
  [k: string]: unknown
}

export interface CanonicalTask {
  id: string
  projectId?: string | null
  featureContractId?: string | null
  title?: string | null
  /** Definition metadata only — never lifecycle stage/evidence. */
  objective?: string | null
  [k: string]: unknown
}

export interface CanonicalClassification {
  taskId: string
  taskClass: TaskClass
  disposition: TaskDisposition
  membershipPortfolioId?: string | null
  membershipProofHash?: string | null
  receiptId?: string | null
  receiptHash?: string | null
}

export interface CanonicalAnchor {
  id: string
  taskId: string
  repo?: string | null
  file?: string | null
  line?: string | number | null
  symbol?: string | null
  fact?: string | null
}

export interface CanonicalAcceptancePath {
  id: string
  taskId: string
  /** Path or fixture locator — evidence *paths*, not fabricated lifecycle receipts. */
  path: string
  kind?: string | null
}

export interface DistinctCounts {
  projects: number
  flows: number
  nodes: number
  tasks: number
  dependencies: number
  featureContractJoins: number
  nodeJoins: number
  classifications: number
  anchors: number
  acceptancePaths: number
  primaryOwnerships: number
}

export interface CanonicalSnapshotPayload {
  projects: Array<CanonicalProject>
  flows: Array<CanonicalFlow>
  nodes: Array<CanonicalNode>
  tasks: Array<CanonicalTask>
  dependencies: Array<DependencyJoin>
  featureContractJoins: Array<FeatureContractJoin>
  nodeJoins: Array<NodeJoin>
  primaryOwnerships: Array<PrimaryOwnership>
  classifications: Array<CanonicalClassification>
  anchors: Array<CanonicalAnchor>
  acceptancePaths: Array<CanonicalAcceptancePath>
}

export interface CanonicalSnapshotManifest {
  schemaVersion: typeof CANONICAL_SNAPSHOT_SCHEMA
  boardId: string
  snapshotId: string
  sourceRepoId: string
  sourceCommitSha: string
  generatedAt: string
  canonicalizationAlgorithm: typeof CANONICALIZATION_ALGORITHM
  payloadSha256: string
  distinctCounts: DistinctCounts
  producerVersion: string
}

export interface CanonicalSnapshot {
  manifest: CanonicalSnapshotManifest
  payload: CanonicalSnapshotPayload
}

export interface CanonicalSnapshotInput {
  boardId: string
  snapshotId: string
  sourceRepoId: string
  sourceCommitSha: string
  generatedAt?: string
  producerVersion?: string
  projects?: Array<CanonicalProject>
  flows?: Array<CanonicalFlow>
  nodes?: Array<CanonicalNode>
  tasks?: Array<CanonicalTask>
  dependencies?: Array<DependencyJoin>
  featureContractJoins?: Array<FeatureContractJoin>
  nodeJoins?: Array<NodeJoin>
  primaryOwnerships?: Array<PrimaryOwnership>
  classifications?: Array<CanonicalClassification>
  anchors?: Array<CanonicalAnchor>
  acceptancePaths?: Array<CanonicalAcceptancePath>
}

export type SnapshotValidationCode =
  | 'INVALID_SCHEMA'
  | 'INVALID_MANIFEST'
  | 'HASH_MISMATCH'
  | 'DUPLICATE_ID'
  | 'MISSING_REFERENCE'
  | 'DUPLICATE_FC_JOIN'
  | 'DUPLICATE_NODE_JOIN'
  | 'DUPLICATE_DEPENDENCY_JOIN'
  | 'CONFLICTING_PRIMARY_OWNERSHIP'
  | 'DEPENDENCY_CYCLE'
  | 'MALFORMED_CLASSIFICATION'
  | 'SECRET_FIELD'
  | 'DISTINCT_COUNT_MISMATCH'
  | 'LIFECYCLE_EVIDENCE_FABRICATED'

export class SnapshotValidationError extends Error {
  readonly code: SnapshotValidationCode
  readonly details: Readonly<Record<string, unknown>>
  constructor(code: SnapshotValidationCode, message: string, details: Record<string, unknown> = {}) {
    super(message)
    this.name = 'SnapshotValidationError'
    this.code = code
    this.details = details
  }
}

const SECRET_KEY_RE =
  /^(password|token|secret|authorization|cookie|api[_-]?key|private[_-]?key|access[_-]?token|refresh[_-]?token)$/i

/** Stable deterministic JSON stringify (sorted object keys; arrays preserve order after caller sort). */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map((v) => stableStringify(v)).join(',')}]`
  const obj = value as Record<string, unknown>
  const keys = Object.keys(obj).sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`
}

export function sha256Hex(canonicalJson: string): string {
  return createHash('sha256').update(canonicalJson).digest('hex')
}

function byId<T extends { id: string }>(a: T, b: T): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

function byTaskDep(a: DependencyJoin, b: DependencyJoin): number {
  const f = a.fromTaskId < b.fromTaskId ? -1 : a.fromTaskId > b.fromTaskId ? 1 : 0
  if (f !== 0) return f
  return a.toTaskId < b.toTaskId ? -1 : a.toTaskId > b.toTaskId ? 1 : 0
}

function byFc(a: FeatureContractJoin, b: FeatureContractJoin): number {
  const f =
    a.featureContractId < b.featureContractId ? -1 : a.featureContractId > b.featureContractId ? 1 : 0
  if (f !== 0) return f
  return a.taskId < b.taskId ? -1 : a.taskId > b.taskId ? 1 : 0
}

function byNode(a: NodeJoin, b: NodeJoin): number {
  const n = a.nodeId < b.nodeId ? -1 : a.nodeId > b.nodeId ? 1 : 0
  if (n !== 0) return n
  return a.taskId < b.taskId ? -1 : a.taskId > b.taskId ? 1 : 0
}

function byOwn(a: PrimaryOwnership, b: PrimaryOwnership): number {
  const t = a.taskId < b.taskId ? -1 : a.taskId > b.taskId ? 1 : 0
  if (t !== 0) return t
  return a.ownerId < b.ownerId ? -1 : a.ownerId > b.ownerId ? 1 : 0
}

function byClass(a: CanonicalClassification, b: CanonicalClassification): number {
  return a.taskId < b.taskId ? -1 : a.taskId > b.taskId ? 1 : 0
}

function stripSecretsDeep(value: unknown, path = ''): unknown {
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map((v, i) => stripSecretsDeep(v, `${path}[${i}]`))
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (SECRET_KEY_RE.test(k)) {
      throw new SnapshotValidationError('SECRET_FIELD', `secret field forbidden: ${path}.${k}`, {
        path: `${path}.${k}`,
        key: k,
      })
    }
    out[k] = stripSecretsDeep(v, path ? `${path}.${k}` : k)
  }
  return out
}

function assertNoLifecycleEvidence(task: CanonicalTask): void {
  const forbidden = [
    'lifecycleStage',
    'lifecycle_stage',
    'stageEvidence',
    'evidenceReceipt',
    'implementerRun',
    'lifecycleHistory',
    'g5Pass',
    'lifecycleRev',
  ]
  for (const k of forbidden) {
    if (k in task && task[k] != null) {
      throw new SnapshotValidationError(
        'LIFECYCLE_EVIDENCE_FABRICATED',
        `definition snapshot cannot carry lifecycle field ${k} on task ${task.id}`,
        { taskId: task.id, field: k },
      )
    }
  }
}

export function normalizePayload(input: CanonicalSnapshotInput): CanonicalSnapshotPayload {
  const projects = [...(input.projects ?? [])].map((p) => ({ ...p })).sort(byId)
  const flows = [...(input.flows ?? [])].map((f) => ({ ...f })).sort(byId)
  const nodes = [...(input.nodes ?? [])].map((n) => ({ ...n })).sort(byId)
  const tasks = [...(input.tasks ?? [])].map((t) => {
    assertNoLifecycleEvidence(t)
    return { ...t }
  }).sort(byId)
  const dependencies = [...(input.dependencies ?? [])].map((d) => ({ ...d })).sort(byTaskDep)
  const featureContractJoins = [...(input.featureContractJoins ?? [])]
    .map((j) => ({ ...j }))
    .sort(byFc)
  const nodeJoins = [...(input.nodeJoins ?? [])].map((j) => ({ ...j })).sort(byNode)
  const primaryOwnerships = [...(input.primaryOwnerships ?? [])].map((o) => ({ ...o })).sort(byOwn)
  const classifications = [...(input.classifications ?? [])].map((c) => ({ ...c })).sort(byClass)
  const anchors = [...(input.anchors ?? [])].map((a) => ({ ...a })).sort(byId)
  const acceptancePaths = [...(input.acceptancePaths ?? [])].map((a) => ({ ...a })).sort(byId)

  const payload: CanonicalSnapshotPayload = {
    projects,
    flows,
    nodes,
    tasks,
    dependencies,
    featureContractJoins,
    nodeJoins,
    primaryOwnerships,
    classifications,
    anchors,
    acceptancePaths,
  }
  return stripSecretsDeep(payload) as CanonicalSnapshotPayload
}

export function computeDistinctCounts(payload: CanonicalSnapshotPayload): DistinctCounts {
  return {
    projects: new Set(payload.projects.map((p) => p.id)).size,
    flows: new Set(payload.flows.map((f) => f.id)).size,
    nodes: new Set(payload.nodes.map((n) => n.id)).size,
    tasks: new Set(payload.tasks.map((t) => t.id)).size,
    dependencies: new Set(
      payload.dependencies.map((d) => `${d.fromTaskId}\0${d.toTaskId}`),
    ).size,
    featureContractJoins: new Set(
      payload.featureContractJoins.map((j) => `${j.featureContractId}\0${j.taskId}`),
    ).size,
    nodeJoins: new Set(payload.nodeJoins.map((j) => `${j.nodeId}\0${j.taskId}`)).size,
    classifications: new Set(payload.classifications.map((c) => c.taskId)).size,
    anchors: new Set(payload.anchors.map((a) => a.id)).size,
    acceptancePaths: new Set(payload.acceptancePaths.map((a) => a.id)).size,
    primaryOwnerships: new Set(payload.primaryOwnerships.map((o) => o.taskId)).size,
  }
}

export function payloadCanonicalJson(payload: CanonicalSnapshotPayload): string {
  return stableStringify(payload)
}

export function payloadSha256(payload: CanonicalSnapshotPayload): string {
  return sha256Hex(payloadCanonicalJson(payload))
}

/**
 * Produce a deterministic canonical snapshot. Order of input arrays does not affect hash.
 */
export function produceCanonicalSnapshot(input: CanonicalSnapshotInput): CanonicalSnapshot {
  if (!input.boardId || !input.snapshotId || !input.sourceRepoId || !input.sourceCommitSha) {
    throw new SnapshotValidationError(
      'INVALID_MANIFEST',
      'boardId, snapshotId, sourceRepoId, sourceCommitSha are required',
    )
  }
  if (!/^[a-f0-9]{7,64}$/i.test(input.sourceCommitSha)) {
    throw new SnapshotValidationError('INVALID_MANIFEST', 'sourceCommitSha must be hex SHA', {
      sourceCommitSha: input.sourceCommitSha,
    })
  }

  const payload = normalizePayload(input)
  // Structural validation before hashing (fail-closed producer).
  validatePayloadStructure(payload)

  const distinctCounts = computeDistinctCounts(payload)
  // Ensure DISTINCT equals array lengths for entity lists with unique IDs.
  if (distinctCounts.projects !== payload.projects.length) {
    throw new SnapshotValidationError('DUPLICATE_ID', 'duplicate project ids', {
      count: payload.projects.length,
      distinct: distinctCounts.projects,
    })
  }
  if (distinctCounts.flows !== payload.flows.length) {
    throw new SnapshotValidationError('DUPLICATE_ID', 'duplicate flow ids')
  }
  if (distinctCounts.nodes !== payload.nodes.length) {
    throw new SnapshotValidationError('DUPLICATE_ID', 'duplicate node ids')
  }
  if (distinctCounts.tasks !== payload.tasks.length) {
    throw new SnapshotValidationError('DUPLICATE_ID', 'duplicate task ids')
  }

  const hash = payloadSha256(payload)
  const manifest: CanonicalSnapshotManifest = {
    schemaVersion: CANONICAL_SNAPSHOT_SCHEMA,
    boardId: input.boardId,
    snapshotId: input.snapshotId,
    sourceRepoId: input.sourceRepoId,
    sourceCommitSha: input.sourceCommitSha.toLowerCase(),
    generatedAt: input.generatedAt ?? new Date(0).toISOString(),
    canonicalizationAlgorithm: CANONICALIZATION_ALGORITHM,
    payloadSha256: hash,
    distinctCounts,
    producerVersion: input.producerVersion ?? DEFAULT_PRODUCER_VERSION,
  }

  return { manifest, payload }
}

export function validatePayloadStructure(payload: CanonicalSnapshotPayload): void {
  const projectIds = new Set(payload.projects.map((p) => p.id))
  const flowIds = new Set(payload.flows.map((f) => f.id))
  const nodeIds = new Set(payload.nodes.map((n) => n.id))
  const taskIds = new Set(payload.tasks.map((t) => t.id))

  const dup = (ids: Array<string>, label: string) => {
    const seen = new Set<string>()
    for (const id of ids) {
      if (!id) {
        throw new SnapshotValidationError('INVALID_SCHEMA', `${label} missing id`)
      }
      if (seen.has(id)) {
        throw new SnapshotValidationError('DUPLICATE_ID', `duplicate ${label} id: ${id}`, {
          id,
          label,
        })
      }
      seen.add(id)
    }
  }
  dup(
    payload.projects.map((p) => p.id),
    'project',
  )
  dup(
    payload.flows.map((f) => f.id),
    'flow',
  )
  dup(
    payload.nodes.map((n) => n.id),
    'node',
  )
  dup(
    payload.tasks.map((t) => t.id),
    'task',
  )
  dup(
    payload.anchors.map((a) => a.id),
    'anchor',
  )
  dup(
    payload.acceptancePaths.map((a) => a.id),
    'acceptancePath',
  )

  for (const f of payload.flows) {
    if (!projectIds.has(f.projectId)) {
      throw new SnapshotValidationError('MISSING_REFERENCE', `flow ${f.id} → project ${f.projectId}`, {
        flowId: f.id,
        projectId: f.projectId,
      })
    }
  }
  for (const n of payload.nodes) {
    if (!flowIds.has(n.flowId)) {
      throw new SnapshotValidationError('MISSING_REFERENCE', `node ${n.id} → flow ${n.flowId}`, {
        nodeId: n.id,
        flowId: n.flowId,
      })
    }
  }
  for (const t of payload.tasks) {
    if (t.projectId && !projectIds.has(t.projectId)) {
      throw new SnapshotValidationError(
        'MISSING_REFERENCE',
        `task ${t.id} → project ${t.projectId}`,
        { taskId: t.id, projectId: t.projectId },
      )
    }
    assertNoLifecycleEvidence(t)
  }

  // FC joins
  const fcKeys = new Set<string>()
  for (const j of payload.featureContractJoins) {
    const k = `${j.featureContractId}\0${j.taskId}`
    if (fcKeys.has(k)) {
      throw new SnapshotValidationError(
        'DUPLICATE_FC_JOIN',
        `duplicate FC join ${j.featureContractId}+${j.taskId}`,
        { ...j },
      )
    }
    fcKeys.add(k)
    if (!taskIds.has(j.taskId)) {
      throw new SnapshotValidationError(
        'MISSING_REFERENCE',
        `FC join task missing: ${j.taskId}`,
        { ...j },
      )
    }
  }

  const nodeJoinKeys = new Set<string>()
  for (const j of payload.nodeJoins) {
    const k = `${j.nodeId}\0${j.taskId}`
    if (nodeJoinKeys.has(k)) {
      throw new SnapshotValidationError(
        'DUPLICATE_NODE_JOIN',
        `duplicate node join ${j.nodeId}+${j.taskId}`,
        { ...j },
      )
    }
    nodeJoinKeys.add(k)
    if (!taskIds.has(j.taskId)) {
      throw new SnapshotValidationError('MISSING_REFERENCE', `node join task missing: ${j.taskId}`, {
        ...j,
      })
    }
    if (!nodeIds.has(j.nodeId)) {
      throw new SnapshotValidationError('MISSING_REFERENCE', `node join node missing: ${j.nodeId}`, {
        ...j,
      })
    }
  }

  const depKeys = new Set<string>()
  for (const d of payload.dependencies) {
    const k = `${d.fromTaskId}\0${d.toTaskId}`
    if (depKeys.has(k)) {
      throw new SnapshotValidationError(
        'DUPLICATE_DEPENDENCY_JOIN',
        `duplicate dependency ${d.fromTaskId}→${d.toTaskId}`,
        { ...d },
      )
    }
    depKeys.add(k)
    if (!taskIds.has(d.fromTaskId) || !taskIds.has(d.toTaskId)) {
      throw new SnapshotValidationError('MISSING_REFERENCE', `dependency refs missing task`, {
        ...d,
      })
    }
  }

  // Conflicting primary ownership: one task → at most one owner
  const ownerByTask = new Map<string, string>()
  for (const o of payload.primaryOwnerships) {
    if (!taskIds.has(o.taskId)) {
      throw new SnapshotValidationError(
        'MISSING_REFERENCE',
        `ownership task missing: ${o.taskId}`,
        { ...o },
      )
    }
    const prev = ownerByTask.get(o.taskId)
    if (prev && prev !== o.ownerId) {
      throw new SnapshotValidationError(
        'CONFLICTING_PRIMARY_OWNERSHIP',
        `task ${o.taskId} has owners ${prev} and ${o.ownerId}`,
        { taskId: o.taskId, owners: [prev, o.ownerId] },
      )
    }
    ownerByTask.set(o.taskId, o.ownerId)
  }

  // Classifications
  const classTasks = new Set<string>()
  for (const c of payload.classifications) {
    if (classTasks.has(c.taskId)) {
      throw new SnapshotValidationError(
        'DUPLICATE_ID',
        `duplicate classification for task ${c.taskId}`,
        { taskId: c.taskId },
      )
    }
    classTasks.add(c.taskId)
    if (!taskIds.has(c.taskId)) {
      throw new SnapshotValidationError(
        'MISSING_REFERENCE',
        `classification task missing: ${c.taskId}`,
        { taskId: c.taskId },
      )
    }
    if (!(TASK_CLASSES as ReadonlyArray<string>).includes(c.taskClass)) {
      throw new SnapshotValidationError(
        'MALFORMED_CLASSIFICATION',
        `invalid taskClass ${String(c.taskClass)}`,
        { ...c },
      )
    }
    if (!(TASK_DISPOSITIONS as ReadonlyArray<string>).includes(c.disposition)) {
      throw new SnapshotValidationError(
        'MALFORMED_CLASSIFICATION',
        `invalid disposition ${String(c.disposition)}`,
        { ...c },
      )
    }
  }

  for (const a of payload.anchors) {
    if (!taskIds.has(a.taskId)) {
      throw new SnapshotValidationError('MISSING_REFERENCE', `anchor task missing: ${a.taskId}`, {
        ...a,
      })
    }
  }
  for (const a of payload.acceptancePaths) {
    if (!taskIds.has(a.taskId)) {
      throw new SnapshotValidationError(
        'MISSING_REFERENCE',
        `acceptance path task missing: ${a.taskId}`,
        { ...a },
      )
    }
    if (!a.path) {
      throw new SnapshotValidationError('INVALID_SCHEMA', `acceptance path missing path: ${a.id}`)
    }
  }

  detectCycles(payload.dependencies, taskIds)
}

function detectCycles(deps: Array<DependencyJoin>, taskIds: Set<string>): void {
  const adj = new Map<string, Array<string>>()
  for (const id of taskIds) adj.set(id, [])
  for (const d of deps) {
    adj.get(d.fromTaskId)?.push(d.toTaskId)
  }
  const WHITE = 0
  const GRAY = 1
  const BLACK = 2
  const color = new Map<string, number>()
  for (const id of taskIds) color.set(id, WHITE)

  const visit = (u: string): void => {
    color.set(u, GRAY)
    for (const v of adj.get(u) ?? []) {
      const c = color.get(v) ?? WHITE
      if (c === GRAY) {
        throw new SnapshotValidationError('DEPENDENCY_CYCLE', `dependency cycle involving ${u}→${v}`, {
          from: u,
          to: v,
        })
      }
      if (c === WHITE) visit(v)
    }
    color.set(u, BLACK)
  }

  for (const id of taskIds) {
    if (color.get(id) === WHITE) visit(id)
  }
}

/**
 * Validate a full snapshot envelope (manifest + payload) including hash and DISTINCT counts.
 */
export function validateCanonicalSnapshot(snapshot: CanonicalSnapshot): {
  ok: true
  payloadSha256: string
} {
  const { manifest, payload } = snapshot
  if (!manifest || manifest.schemaVersion !== CANONICAL_SNAPSHOT_SCHEMA) {
    throw new SnapshotValidationError(
      'INVALID_SCHEMA',
      `expected schemaVersion ${CANONICAL_SNAPSHOT_SCHEMA}`,
      { got: manifest?.schemaVersion },
    )
  }
  if (
    !manifest.boardId ||
    !manifest.snapshotId ||
    !manifest.sourceRepoId ||
    !manifest.sourceCommitSha ||
    !manifest.payloadSha256 ||
    !manifest.generatedAt ||
    manifest.canonicalizationAlgorithm !== CANONICALIZATION_ALGORITHM
  ) {
    throw new SnapshotValidationError('INVALID_MANIFEST', 'manifest missing required fields')
  }

  validatePayloadStructure(payload)
  const expected = payloadSha256(payload)
  if (manifest.payloadSha256 !== expected) {
    throw new SnapshotValidationError('HASH_MISMATCH', 'payloadSha256 does not match payload', {
      claimed: manifest.payloadSha256,
      expected,
    })
  }

  const counts = computeDistinctCounts(payload)
  for (const key of Object.keys(counts) as Array<keyof DistinctCounts>) {
    if (manifest.distinctCounts?.[key] !== counts[key]) {
      throw new SnapshotValidationError(
        'DISTINCT_COUNT_MISMATCH',
        `distinctCounts.${key} mismatch`,
        { claimed: manifest.distinctCounts?.[key], expected: counts[key] },
      )
    }
  }

  return { ok: true, payloadSha256: expected }
}

/** Hash of the full snapshot identity used as subject/canonical hash in revisions. */
export function canonicalSubjectHash(snapshot: CanonicalSnapshot): string {
  return sha256Hex(
    stableStringify({
      snapshotId: snapshot.manifest.snapshotId,
      payloadSha256: snapshot.manifest.payloadSha256,
      boardId: snapshot.manifest.boardId,
    }),
  )
}
