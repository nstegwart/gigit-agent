/**
 * Single-authority pinned canonical definition read model.
 *
 * Authority:
 * - Pin identity: board_revisions (via ImportStorage.getPinnedSnapshot)
 * - Definition graph: control_plane_snapshots.payload_json for pin.canonical_snapshot_id
 *
 * Fail-closed on synthetic / missing / mismatched / out-of-order pins.
 * Projects DISTINCT definition rows only — never fabricates lifecycle or readiness.
 * No dual join with legacy board_docs / tasks table.
 *
 * Minimal typed adapter for future MCP/UI consumers. Does not wire board-mcp or UI.
 */
import type {
  ImportBoardState,
  ImportStorage,
  PinnedSnapshotBundle,
} from '#/server/canonical-import'
import {
  CANONICAL_SNAPSHOT_SCHEMA,
  canonicalSubjectHash,
  computeDistinctCounts,
  payloadSha256,
  validateCanonicalSnapshot,
  type CanonicalAcceptancePath,
  type CanonicalAnchor,
  type CanonicalClassification,
  type CanonicalFlow,
  type CanonicalNode,
  type CanonicalProject,
  type CanonicalSnapshot,
  type CanonicalSnapshotPayload,
  type CanonicalTask,
  type DistinctCounts,
  SnapshotValidationError,
} from '#/server/canonical-snapshot'
import type {
  DependencyJoin,
  FeatureContractJoin,
  NodeJoin,
  PrimaryOwnership,
} from '#/lib/control-plane-types'

// ---------------------------------------------------------------------------
// Error codes / types
// ---------------------------------------------------------------------------

export type CanonicalReadModelErrorCode =
  | 'PIN_MISSING'
  | 'PIN_INCOMPLETE'
  | 'PIN_SYNTHETIC'
  | 'SNAPSHOT_MISSING'
  | 'HASH_MISMATCH'
  | 'SNAPSHOT_ID_MISMATCH'
  | 'REV_MISMATCH'
  | 'LIFECYCLE_REV_MISMATCH'
  | 'SCHEMA_INVALID'
  | 'PAYLOAD_INVALID'
  | 'DUPLICATE_ID'
  | 'OUT_OF_ORDER_PIN'
  | 'BOARD_MISMATCH'

export class CanonicalReadModelError extends Error {
  readonly code: CanonicalReadModelErrorCode
  readonly details: Readonly<Record<string, unknown>>
  readonly httpStatus: number

  constructor(
    code: CanonicalReadModelErrorCode,
    message: string,
    details: Record<string, unknown> = {},
    httpStatus = 409,
  ) {
    super(message)
    this.name = 'CanonicalReadModelError'
    this.code = code
    this.details = details
    this.httpStatus = httpStatus
  }
}

/** Pin fields exposed to MCP/UI envelopes (definition authority only). */
export interface CanonicalDefinitionPin {
  boardId: string
  boardRev: number
  lifecycleRev: number
  canonicalSnapshotId: string
  canonicalHash: string
  entityRev: number
  subjectHash: string | null
  payloadSha256: string
  lastSnapshotGeneratedAt: string | null
  lastSnapshotId: string | null
}

/**
 * Deterministic DISTINCT projection of the pinned snapshot payload.
 * Arrays are stable-sorted by natural key; no duplicates; no lifecycle/readiness.
 */
export interface CanonicalDefinitionProjection {
  projects: Array<CanonicalProject>
  /** Snapshot uses flows; UI/MCP list_features maps from this set. */
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
  distinctCounts: DistinctCounts
  /** Sorted unique task ids (definition membership only). */
  distinctTaskIds: Array<string>
  /** Sorted unique project ids. */
  distinctProjectIds: Array<string>
  /** Sorted unique flow ids (feature contracts). */
  distinctFlowIds: Array<string>
}

export interface CanonicalDefinitionReadModel {
  pin: CanonicalDefinitionPin
  snapshot: CanonicalSnapshot
  payload: CanonicalSnapshotPayload
  projection: CanonicalDefinitionProjection
  /** Always null on success — fail-closed load never returns a soft mismatch. */
  mismatch: null
}

export interface LoadPinnedDefinitionOptions {
  /** When set, pin.boardRev must equal this (cursor / CAS freshness). */
  expectedBoardRev?: number
  /** When set, pin.canonicalHash must equal this. */
  expectedCanonicalHash?: string
  /** When set, pin.lifecycleRev must equal this. */
  expectedLifecycleRev?: number
  /** When set, pin.canonicalSnapshotId must equal this. */
  expectedSnapshotId?: string
}

export type PinnedSnapshotReader = Pick<ImportStorage, 'getPinnedSnapshot' | 'getBoardState'>

// ---------------------------------------------------------------------------
// Synthetic pin detection (resolveBoardPin fallback shape)
// ---------------------------------------------------------------------------

/**
 * True when snapshotId matches the synthetic form invented by resolveBoardPin
 * when durable canonical_snapshot_id is absent: `pin-${boardId}-${hash.slice(0,16)}`.
 * Synthetic pins are never loadable from control_plane_snapshots.
 */
export function isSyntheticCanonicalSnapshotId(
  boardId: string,
  snapshotId: string | null | undefined,
): boolean {
  if (snapshotId == null) return false
  const id = String(snapshotId).trim()
  if (!id) return false
  if (id.startsWith(`pin-${boardId}-`)) return true
  // Broad guard: any pin- prefix without a real import snapshot id shape.
  if (/^pin-[a-zA-Z0-9._:-]+-[a-f0-9]{8,64}$/i.test(id)) return true
  return false
}

export function isPinComplete(pin: ImportBoardState): boolean {
  const snapId =
    pin.canonicalSnapshotId != null && String(pin.canonicalSnapshotId).trim()
      ? String(pin.canonicalSnapshotId).trim()
      : ''
  const hash =
    (pin.canonicalHash != null && String(pin.canonicalHash).trim()) ||
    (pin.subjectHash != null && String(pin.subjectHash).trim()) ||
    ''
  if (!snapId || !hash) return false
  if (!Number.isFinite(pin.boardRev) || pin.boardRev < 0) return false
  if (!Number.isFinite(pin.lifecycleRev) || pin.lifecycleRev < 0) return false
  if (isSyntheticCanonicalSnapshotId(pin.boardId, snapId)) return false
  return true
}

// ---------------------------------------------------------------------------
// Projection (pure, deterministic)
// ---------------------------------------------------------------------------

function byId<T extends { id: string }>(a: T, b: T): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

function byTaskId<T extends { taskId: string }>(a: T, b: T): number {
  return a.taskId < b.taskId ? -1 : a.taskId > b.taskId ? 1 : 0
}

function byDep(a: DependencyJoin, b: DependencyJoin): number {
  const f = a.fromTaskId < b.fromTaskId ? -1 : a.fromTaskId > b.fromTaskId ? 1 : 0
  if (f !== 0) return f
  return a.toTaskId < b.toTaskId ? -1 : a.toTaskId > b.toTaskId ? 1 : 0
}

function byFc(a: FeatureContractJoin, b: FeatureContractJoin): number {
  const f =
    a.featureContractId < b.featureContractId
      ? -1
      : a.featureContractId > b.featureContractId
        ? 1
        : 0
  if (f !== 0) return f
  return a.taskId < b.taskId ? -1 : a.taskId > b.taskId ? 1 : 0
}

function byNodeJoin(a: NodeJoin, b: NodeJoin): number {
  const n = a.nodeId < b.nodeId ? -1 : a.nodeId > b.nodeId ? 1 : 0
  if (n !== 0) return n
  return a.taskId < b.taskId ? -1 : a.taskId > b.taskId ? 1 : 0
}

function dedupeByKey<T>(items: Array<T>, keyOf: (item: T) => string): Array<T> {
  const seen = new Set<string>()
  const out: Array<T> = []
  for (const item of items) {
    const k = keyOf(item)
    if (seen.has(k)) continue
    seen.add(k)
    out.push(item)
  }
  return out
}

/**
 * Project payload into stable-sorted DISTINCT definition rows.
 * Does not invent lifecycle stage, readiness, G5, or rollup.
 */
export function projectCanonicalDefinition(
  payload: CanonicalSnapshotPayload,
): CanonicalDefinitionProjection {
  const projects = dedupeByKey([...payload.projects], (p) => p.id).sort(byId)
  const flows = dedupeByKey([...payload.flows], (f) => f.id).sort(byId)
  const nodes = dedupeByKey([...payload.nodes], (n) => n.id).sort(byId)
  const tasks = dedupeByKey([...payload.tasks], (t) => t.id).sort(byId)
  const dependencies = dedupeByKey(
    [...payload.dependencies],
    (d) => `${d.fromTaskId}\0${d.toTaskId}`,
  ).sort(byDep)
  const featureContractJoins = dedupeByKey(
    [...payload.featureContractJoins],
    (j) => `${j.featureContractId}\0${j.taskId}`,
  ).sort(byFc)
  const nodeJoins = dedupeByKey(
    [...payload.nodeJoins],
    (j) => `${j.nodeId}\0${j.taskId}`,
  ).sort(byNodeJoin)
  const primaryOwnerships = dedupeByKey(
    [...payload.primaryOwnerships],
    (o) => o.taskId,
  ).sort(byTaskId)
  const classifications = dedupeByKey(
    [...payload.classifications],
    (c) => c.taskId,
  ).sort(byTaskId)
  const anchors = dedupeByKey([...payload.anchors], (a) => a.id).sort(byId)
  const acceptancePaths = dedupeByKey(
    [...payload.acceptancePaths],
    (a) => a.id,
  ).sort(byId)

  const projectedPayload: CanonicalSnapshotPayload = {
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
  const distinctCounts = computeDistinctCounts(projectedPayload)

  // Integrity: array lengths must equal DISTINCT after dedupe.
  if (distinctCounts.projects !== projects.length) {
    throw new CanonicalReadModelError('DUPLICATE_ID', 'duplicate project ids after projection', {
      count: projects.length,
      distinct: distinctCounts.projects,
    })
  }
  if (distinctCounts.tasks !== tasks.length) {
    throw new CanonicalReadModelError('DUPLICATE_ID', 'duplicate task ids after projection', {
      count: tasks.length,
      distinct: distinctCounts.tasks,
    })
  }

  return {
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
    distinctCounts,
    distinctTaskIds: tasks.map((t) => t.id),
    distinctProjectIds: projects.map((p) => p.id),
    distinctFlowIds: flows.map((f) => f.id),
  }
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

function requireCompletePin(pin: ImportBoardState): {
  snapshotId: string
  canonicalHash: string
} {
  if (isSyntheticCanonicalSnapshotId(pin.boardId, pin.canonicalSnapshotId)) {
    throw new CanonicalReadModelError(
      'PIN_SYNTHETIC',
      `canonical_snapshot_id ${pin.canonicalSnapshotId} is synthetic (not a durable import pin)`,
      {
        boardId: pin.boardId,
        canonicalSnapshotId: pin.canonicalSnapshotId,
      },
      409,
    )
  }
  if (!isPinComplete(pin)) {
    throw new CanonicalReadModelError(
      'PIN_INCOMPLETE',
      'board pin missing canonical_snapshot_id and/or canonical_hash (or revs invalid)',
      {
        boardId: pin.boardId,
        canonicalSnapshotId: pin.canonicalSnapshotId,
        canonicalHash: pin.canonicalHash,
        subjectHash: pin.subjectHash,
        boardRev: pin.boardRev,
        lifecycleRev: pin.lifecycleRev,
      },
      409,
    )
  }
  const snapshotId = String(pin.canonicalSnapshotId).trim()
  const canonicalHash =
    (pin.canonicalHash && String(pin.canonicalHash).trim()) ||
    (pin.subjectHash && String(pin.subjectHash).trim()) ||
    ''
  return { snapshotId, canonicalHash }
}

function assertExpectedPins(
  pin: ImportBoardState,
  snapshotId: string,
  canonicalHash: string,
  opts: LoadPinnedDefinitionOptions,
): void {
  if (opts.expectedBoardRev != null && pin.boardRev !== opts.expectedBoardRev) {
    throw new CanonicalReadModelError(
      'OUT_OF_ORDER_PIN',
      `pin boardRev ${pin.boardRev} !== expectedBoardRev ${opts.expectedBoardRev}`,
      { boardRev: pin.boardRev, expectedBoardRev: opts.expectedBoardRev },
    )
  }
  if (
    opts.expectedLifecycleRev != null &&
    pin.lifecycleRev !== opts.expectedLifecycleRev
  ) {
    throw new CanonicalReadModelError(
      'OUT_OF_ORDER_PIN',
      `pin lifecycleRev ${pin.lifecycleRev} !== expectedLifecycleRev ${opts.expectedLifecycleRev}`,
      {
        lifecycleRev: pin.lifecycleRev,
        expectedLifecycleRev: opts.expectedLifecycleRev,
      },
    )
  }
  if (
    opts.expectedCanonicalHash != null &&
    opts.expectedCanonicalHash !== canonicalHash
  ) {
    throw new CanonicalReadModelError(
      'HASH_MISMATCH',
      'pin canonicalHash does not match expectedCanonicalHash',
      {
        pinCanonicalHash: canonicalHash,
        expectedCanonicalHash: opts.expectedCanonicalHash,
      },
    )
  }
  if (opts.expectedSnapshotId != null && opts.expectedSnapshotId !== snapshotId) {
    throw new CanonicalReadModelError(
      'SNAPSHOT_ID_MISMATCH',
      'pin canonicalSnapshotId does not match expectedSnapshotId',
      {
        pinSnapshotId: snapshotId,
        expectedSnapshotId: opts.expectedSnapshotId,
      },
    )
  }
}

function validatePinnedBundle(
  boardId: string,
  bundle: PinnedSnapshotBundle,
  opts: LoadPinnedDefinitionOptions,
): {
  pin: CanonicalDefinitionPin
  snapshot: CanonicalSnapshot
  projection: CanonicalDefinitionProjection
} {
  const { pin: rawPin, snapshot, snapshotBoardRev, snapshotLifecycleRev } = bundle

  if (rawPin.boardId !== boardId) {
    throw new CanonicalReadModelError(
      'BOARD_MISMATCH',
      `pin boardId ${rawPin.boardId} !== requested ${boardId}`,
      { pinBoardId: rawPin.boardId, boardId },
    )
  }

  const { snapshotId, canonicalHash } = requireCompletePin(rawPin)
  assertExpectedPins(rawPin, snapshotId, canonicalHash, opts)

  if (!snapshot) {
    throw new CanonicalReadModelError(
      'SNAPSHOT_MISSING',
      `control_plane_snapshots row missing for pin snapshot_id ${snapshotId}`,
      { boardId, snapshotId },
      409,
    )
  }

  // Snapshot identity vs pin
  if (snapshot.manifest.snapshotId !== snapshotId) {
    throw new CanonicalReadModelError(
      'SNAPSHOT_ID_MISMATCH',
      `snapshot.manifest.snapshotId ${snapshot.manifest.snapshotId} !== pin ${snapshotId}`,
      {
        pinSnapshotId: snapshotId,
        snapshotId: snapshot.manifest.snapshotId,
      },
    )
  }
  if (snapshot.manifest.boardId !== boardId) {
    throw new CanonicalReadModelError(
      'BOARD_MISMATCH',
      `snapshot.manifest.boardId ${snapshot.manifest.boardId} !== ${boardId}`,
      {
        snapshotBoardId: snapshot.manifest.boardId,
        boardId,
      },
    )
  }
  if (snapshot.manifest.schemaVersion !== CANONICAL_SNAPSHOT_SCHEMA) {
    throw new CanonicalReadModelError(
      'SCHEMA_INVALID',
      `schemaVersion ${snapshot.manifest.schemaVersion} !== ${CANONICAL_SNAPSHOT_SCHEMA}`,
      { schemaVersion: snapshot.manifest.schemaVersion },
    )
  }

  // Full structural + payload hash validation
  try {
    validateCanonicalSnapshot(snapshot)
  } catch (e) {
    if (e instanceof SnapshotValidationError) {
      const code: CanonicalReadModelErrorCode =
        e.code === 'HASH_MISMATCH'
          ? 'HASH_MISMATCH'
          : e.code === 'DUPLICATE_ID' ||
              e.code === 'DUPLICATE_FC_JOIN' ||
              e.code === 'DUPLICATE_NODE_JOIN' ||
              e.code === 'DUPLICATE_DEPENDENCY_JOIN'
            ? 'DUPLICATE_ID'
            : e.code === 'INVALID_SCHEMA' || e.code === 'INVALID_MANIFEST'
              ? 'SCHEMA_INVALID'
              : 'PAYLOAD_INVALID'
      throw new CanonicalReadModelError(code, e.message, {
        ...e.details,
        snapshotCode: e.code,
      })
    }
    throw e
  }

  // Recomputed payload hash must match pin lastPayloadSha256 when present
  const recomputedPayloadHash = payloadSha256(snapshot.payload)
  if (snapshot.manifest.payloadSha256 !== recomputedPayloadHash) {
    throw new CanonicalReadModelError(
      'HASH_MISMATCH',
      'manifest.payloadSha256 does not match recomputed payload hash',
      {
        claimed: snapshot.manifest.payloadSha256,
        expected: recomputedPayloadHash,
      },
    )
  }
  if (
    rawPin.lastPayloadSha256 &&
    rawPin.lastPayloadSha256 !== recomputedPayloadHash
  ) {
    throw new CanonicalReadModelError(
      'HASH_MISMATCH',
      'pin.lastPayloadSha256 does not match snapshot payload hash',
      {
        pinLastPayloadSha256: rawPin.lastPayloadSha256,
        payloadSha256: recomputedPayloadHash,
      },
    )
  }

  // canonicalHash = subject hash over {snapshotId, payloadSha256, boardId}
  const expectedCanonical = canonicalSubjectHash(snapshot)
  if (canonicalHash !== expectedCanonical) {
    throw new CanonicalReadModelError(
      'HASH_MISMATCH',
      'pin canonicalHash does not match canonicalSubjectHash(snapshot)',
      {
        pinCanonicalHash: canonicalHash,
        expectedCanonicalHash: expectedCanonical,
      },
    )
  }

  // Registry revs are freeze-at-first-insert provenance (immutable snapshot row).
  // Pin boardRev/lifecycleRev are mutable CAS targets and MAY advance after import
  // (lifecycle evidence, other CAS) without rewriting the snapshot row.
  // Authority for current revs is the pin; registry revs are informational only.
  // Callers enforce freshness via expectedBoardRev / expectedLifecycleRev opts.
  void snapshotBoardRev
  void snapshotLifecycleRev

  const projection = projectCanonicalDefinition(snapshot.payload)

  const definitionPin: CanonicalDefinitionPin = {
    boardId: rawPin.boardId,
    boardRev: rawPin.boardRev,
    lifecycleRev: rawPin.lifecycleRev,
    canonicalSnapshotId: snapshotId,
    canonicalHash,
    entityRev: rawPin.entityRev,
    subjectHash: rawPin.subjectHash,
    payloadSha256: recomputedPayloadHash,
    lastSnapshotGeneratedAt: rawPin.lastSnapshotGeneratedAt,
    lastSnapshotId: rawPin.lastSnapshotId,
  }

  return { pin: definitionPin, snapshot, projection }
}

// ---------------------------------------------------------------------------
// Public load API
// ---------------------------------------------------------------------------

/**
 * Load the pinned definition read model for a board.
 * Fail-closed: throws CanonicalReadModelError — never falls back to legacy board_docs/tasks.
 */
export async function loadPinnedDefinitionReadModel(
  storage: PinnedSnapshotReader,
  boardId: string,
  opts: LoadPinnedDefinitionOptions = {},
): Promise<CanonicalDefinitionReadModel> {
  if (!boardId || !String(boardId).trim()) {
    throw new CanonicalReadModelError(
      'PIN_MISSING',
      'boardId required',
      { boardId },
      400,
    )
  }
  const id = String(boardId).trim()

  const bundle = await storage.getPinnedSnapshot(id)
  if (!bundle) {
    throw new CanonicalReadModelError(
      'PIN_MISSING',
      `board_revisions row missing for boardId ${id}`,
      { boardId: id },
      404,
    )
  }

  const validated = validatePinnedBundle(id, bundle, opts)
  return {
    pin: validated.pin,
    snapshot: validated.snapshot,
    payload: validated.snapshot.payload,
    projection: validated.projection,
    mismatch: null,
  }
}

export type TryLoadPinnedDefinitionResult =
  | { ok: true; model: CanonicalDefinitionReadModel }
  | {
      ok: false
      code: CanonicalReadModelErrorCode
      message: string
      details: Readonly<Record<string, unknown>>
      mismatch: {
        code: CanonicalReadModelErrorCode
        message: string
        details: Readonly<Record<string, unknown>>
      }
    }

/**
 * Non-throwing variant for UI sectionErrors / soft fail-closed surfaces.
 * Still never merges legacy definition sources.
 */
export async function tryLoadPinnedDefinitionReadModel(
  storage: PinnedSnapshotReader,
  boardId: string,
  opts: LoadPinnedDefinitionOptions = {},
): Promise<TryLoadPinnedDefinitionResult> {
  try {
    const model = await loadPinnedDefinitionReadModel(storage, boardId, opts)
    return { ok: true, model }
  } catch (e) {
    if (e instanceof CanonicalReadModelError) {
      return {
        ok: false,
        code: e.code,
        message: e.message,
        details: e.details,
        mismatch: {
          code: e.code,
          message: e.message,
          details: e.details,
        },
      }
    }
    throw e
  }
}

/**
 * Minimal typed read adapter surface for MCP/UI.
 * Definition lists only — inject lifecycle overlays at call site by task id intersection.
 */
export interface CanonicalDefinitionReadAdapter {
  loadPinnedDefinition(
    boardId: string,
    opts?: LoadPinnedDefinitionOptions,
  ): Promise<CanonicalDefinitionReadModel>
  tryLoadPinnedDefinition(
    boardId: string,
    opts?: LoadPinnedDefinitionOptions,
  ): Promise<TryLoadPinnedDefinitionResult>
}

export function createCanonicalDefinitionReadAdapter(
  storage: PinnedSnapshotReader,
): CanonicalDefinitionReadAdapter {
  return {
    loadPinnedDefinition(boardId, opts) {
      return loadPinnedDefinitionReadModel(storage, boardId, opts)
    },
    tryLoadPinnedDefinition(boardId, opts) {
      return tryLoadPinnedDefinitionReadModel(storage, boardId, opts)
    },
  }
}
