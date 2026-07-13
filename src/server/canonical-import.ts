/**
 * Auth-bound canonical snapshot import (plan + apply).
 * Requires import:write, entityExpectedRev, expectedBoardRev, subject/canonical hash,
 * idempotency key. Injected transaction/storage — unit tests never touch a real DB.
 * Definition import cannot fabricate lifecycle evidence.
 * Uses C1B revisions + idempotency primitives.
 */
import {
  beginIdempotent,
  completeIdempotent,
  type IdempotencyStorage,
  IdempotencyError,
  IDEMPOTENCY_CONFLICT,
} from '#/server/idempotency'
import {
  evaluateCas,
  STALE_REVISION,
  type RevisionState,
  type RevisionStore,
  type StaleRevisionError,
} from '#/server/revisions'
import {
  type CanonicalSnapshot,
  type CanonicalSnapshotPayload,
  canonicalSubjectHash,
  produceCanonicalSnapshot,
  type CanonicalSnapshotInput,
  SnapshotValidationError,
  validateCanonicalSnapshot,
  CANONICAL_SNAPSHOT_SCHEMA,
} from '#/server/canonical-snapshot'

export const IMPORT_WRITE_SCOPE = 'import:write' as const
export const IMPORT_ENDPOINT = 'canonical_import_apply' as const

export type ImportErrorCode =
  | 'AUTHORIZATION_REQUIRED'
  | 'INVALID_SCHEMA'
  | 'HASH_MISMATCH'
  | 'DATA_INTEGRITY'
  | 'STALE_REVISION'
  | 'STALE_HASH'
  | 'OUT_OF_ORDER_SNAPSHOT'
  | 'IDEMPOTENCY_CONFLICT'
  | 'IDEMPOTENCY_KEY_REQUIRED'
  | 'LIFECYCLE_EVIDENCE_FABRICATED'
  | typeof STALE_REVISION
  | typeof IDEMPOTENCY_CONFLICT

export class ImportError extends Error {
  readonly code: ImportErrorCode
  readonly details: Readonly<Record<string, unknown>>
  readonly httpStatus: number

  constructor(
    code: ImportErrorCode,
    message: string,
    details: Record<string, unknown> = {},
    httpStatus = 400,
  ) {
    super(message)
    this.name = 'ImportError'
    this.code = code
    this.details = details
    this.httpStatus = httpStatus
  }
}

export interface ImportAuthContext {
  actorId: string
  /** Scopes granted to the actor. Must include import:write. */
  scopes: ReadonlyArray<string>
  role?: string | null
}

export interface ImportBoardState {
  boardId: string
  boardRev: number
  lifecycleRev: number
  /** Monotonic snapshot sequence / last accepted generatedAt ISO. */
  lastSnapshotGeneratedAt: string | null
  lastSnapshotId: string | null
  lastPayloadSha256: string | null
  canonicalSnapshotId: string | null
  canonicalHash: string | null
  /** Entity rev for board-level import subject. */
  entityRev: number
  subjectHash: string | null
  /** Lifecycle evidence store must remain untouched by definition import. */
  lifecycleEvidenceByTask: Record<string, unknown>
}

export interface ImportApplyResult {
  ok: true
  kind: 'APPLIED' | 'REPLAY'
  importId: string
  boardId: string
  snapshotId: string
  payloadSha256: string
  canonicalHash: string
  boardRev: number
  lifecycleRev: number
  entityRev: number
  provenance: ImportProvenance
  /** Explicit proof: no lifecycle evidence mutated. */
  lifecycleEvidenceUnchanged: true
  readback: ImportReadback
}

export interface ImportProvenance {
  actorId: string
  appliedAt: string
  sourceRepoId: string
  sourceCommitSha: string
  schemaVersion: typeof CANONICAL_SNAPSHOT_SCHEMA
  requestHash: string
  idempotencyKey: string
  dryRun: boolean
}

export interface ImportReadback {
  canonicalSnapshotId: string
  canonicalHash: string
  boardRev: number
  lifecycleRev: number
  taskCount: number
  distinctTaskIds: Array<string>
  payloadSha256: string
}

export interface ImportPlanResult {
  ok: true
  wouldApply: true
  boardId: string
  snapshotId: string
  payloadSha256: string
  canonicalHash: string
  entityExpectedRev: number
  expectedBoardRev: number
  nextEntityRev: number
  nextBoardRev: number
  validation: { schema: true; hash: true; graph: true }
}

/** Injected storage — no real DB. */
export interface ImportStorage {
  getBoardState(boardId: string): Promise<ImportBoardState | null>
  /**
   * Persist applied snapshot + advance revs. Must NOT write lifecycle evidence.
   * Returns post-apply board state.
   */
  applySnapshot(args: {
    boardId: string
    snapshot: CanonicalSnapshot
    nextEntityRev: number
    nextBoardRev: number
    canonicalHash: string
    actorId: string
    importId: string
    appliedAt: string
  }): Promise<ImportBoardState>
  /** Optional audit append (in-memory for tests). */
  appendAudit?(entry: Record<string, unknown>): Promise<void>
}

export interface PlanImportRequest {
  auth: ImportAuthContext
  snapshot: CanonicalSnapshot
  entityExpectedRev: number
  expectedBoardRev: number
  expectedSubjectHash: string
}

export interface ApplyImportRequest {
  auth: ImportAuthContext
  snapshot: CanonicalSnapshot
  entityExpectedRev: number
  expectedBoardRev: number
  expectedSubjectHash: string
  idempotencyKey: string
  importId?: string
  dryRun?: boolean
  now?: string
}

function requireImportWrite(auth: ImportAuthContext): void {
  if (!auth.actorId) {
    throw new ImportError('AUTHORIZATION_REQUIRED', 'actorId required', {}, 401)
  }
  if (!auth.scopes.includes(IMPORT_WRITE_SCOPE)) {
    throw new ImportError(
      'AUTHORIZATION_REQUIRED',
      `scope ${IMPORT_WRITE_SCOPE} required`,
      { scopes: auth.scopes },
      403,
    )
  }
}

function mapValidation(err: unknown): never {
  if (err instanceof SnapshotValidationError) {
    const code: ImportErrorCode =
      err.code === 'HASH_MISMATCH'
        ? 'HASH_MISMATCH'
        : err.code === 'LIFECYCLE_EVIDENCE_FABRICATED'
          ? 'LIFECYCLE_EVIDENCE_FABRICATED'
          : err.code === 'INVALID_SCHEMA' || err.code === 'INVALID_MANIFEST'
            ? 'INVALID_SCHEMA'
            : 'DATA_INTEGRITY'
    throw new ImportError(code, err.message, { ...err.details, snapshotCode: err.code })
  }
  throw err
}

function assertSnapshotFreshness(
  state: ImportBoardState,
  snapshot: CanonicalSnapshot,
): void {
  // Out-of-order / stale: same snapshotId already applied with different hash, or older generatedAt.
  if (state.lastSnapshotId === snapshot.manifest.snapshotId) {
    if (
      state.lastPayloadSha256 &&
      state.lastPayloadSha256 !== snapshot.manifest.payloadSha256
    ) {
      throw new ImportError(
        'OUT_OF_ORDER_SNAPSHOT',
        `snapshotId ${snapshot.manifest.snapshotId} already applied with different payload hash`,
        {
          lastPayloadSha256: state.lastPayloadSha256,
          incoming: snapshot.manifest.payloadSha256,
        },
      )
    }
  }
  if (
    state.lastSnapshotGeneratedAt &&
    snapshot.manifest.generatedAt < state.lastSnapshotGeneratedAt &&
    state.lastSnapshotId !== snapshot.manifest.snapshotId
  ) {
    throw new ImportError(
      'OUT_OF_ORDER_SNAPSHOT',
      `snapshot generatedAt ${snapshot.manifest.generatedAt} is older than last accepted ${state.lastSnapshotGeneratedAt}`,
      {
        lastSnapshotGeneratedAt: state.lastSnapshotGeneratedAt,
        incoming: snapshot.manifest.generatedAt,
      },
    )
  }
}

function assertNoLifecycleInPayload(payload: CanonicalSnapshotPayload): void {
  // Double-check: import path never accepts lifecycle evidence blobs.
  for (const t of payload.tasks) {
    for (const k of ['lifecycleStage', 'stageEvidence', 'g5Pass', 'lifecycleHistory'] as const) {
      if (k in t && (t as Record<string, unknown>)[k] != null) {
        throw new ImportError(
          'LIFECYCLE_EVIDENCE_FABRICATED',
          `import cannot fabricate lifecycle field ${k}`,
          { taskId: t.id, field: k },
        )
      }
    }
  }
}

function buildReadback(
  state: ImportBoardState,
  snapshot: CanonicalSnapshot,
  canonicalHash: string,
): ImportReadback {
  const ids = [...new Set(snapshot.payload.tasks.map((t) => t.id))].sort()
  return {
    canonicalSnapshotId: snapshot.manifest.snapshotId,
    canonicalHash,
    boardRev: state.boardRev,
    lifecycleRev: state.lifecycleRev,
    taskCount: ids.length,
    distinctTaskIds: ids,
    payloadSha256: snapshot.manifest.payloadSha256,
  }
}

/**
 * Plan-only: validate schema/hash/graph + CAS preconditions without mutating storage.
 * Board state is read exactly once; subject-hash / revision mismatch surfaces solely
 * through the deterministic CAS result (no dead pre-CAS branch, no plan side effects).
 */
export async function planImport(
  storage: ImportStorage,
  req: PlanImportRequest,
): Promise<ImportPlanResult> {
  requireImportWrite(req.auth)
  try {
    validateCanonicalSnapshot(req.snapshot)
  } catch (e) {
    mapValidation(e)
  }
  assertNoLifecycleInPayload(req.snapshot.payload)

  // Single board-state read for the entire plan path.
  const state = await ensureBoard(storage, req.snapshot)
  if (state.boardId !== req.snapshot.manifest.boardId) {
    throw new ImportError('DATA_INTEGRITY', 'boardId mismatch')
  }
  assertSnapshotFreshness(state, req.snapshot)

  const canonicalHash = canonicalSubjectHash(req.snapshot)

  const current: RevisionState = {
    boardId: state.boardId,
    entityType: 'canonical_import',
    entityId: state.boardId,
    entityRev: state.entityRev,
    boardRev: state.boardRev,
    subjectHash: state.subjectHash,
  }
  // One deterministic CAS: entity rev + board rev + subject hash (STALE_REVISION).
  const cas = evaluateCas(current, {
    boardId: state.boardId,
    entityType: 'canonical_import',
    entityId: state.boardId,
    entityExpectedRev: req.entityExpectedRev,
    expectedBoardRev: req.expectedBoardRev,
    expectedSubjectHash: req.expectedSubjectHash,
    nextSubjectHash: canonicalHash,
  })
  if (!cas.ok) {
    throw staleToImportError(cas)
  }

  return {
    ok: true,
    wouldApply: true,
    boardId: state.boardId,
    snapshotId: req.snapshot.manifest.snapshotId,
    payloadSha256: req.snapshot.manifest.payloadSha256,
    canonicalHash,
    entityExpectedRev: req.entityExpectedRev,
    expectedBoardRev: req.expectedBoardRev,
    nextEntityRev: cas.entityRev,
    nextBoardRev: cas.boardRev,
    validation: { schema: true, hash: true, graph: true },
  }
}

function staleToImportError(cas: StaleRevisionError): ImportError {
  return new ImportError(
    STALE_REVISION,
    cas.message,
    { current: cas.current },
    409,
  )
}

async function ensureBoard(
  storage: ImportStorage,
  snapshot: CanonicalSnapshot,
): Promise<ImportBoardState> {
  const state = await storage.getBoardState(snapshot.manifest.boardId)
  if (!state) {
    throw new ImportError(
      'DATA_INTEGRITY',
      `board not found: ${snapshot.manifest.boardId}`,
      { boardId: snapshot.manifest.boardId },
      404,
    )
  }
  return state
}

/**
 * Apply import with idempotency + CAS. Never mutates lifecycle evidence store.
 */
export async function applyImport(
  storage: ImportStorage,
  idem: IdempotencyStorage,
  revisionStore: RevisionStore | null,
  req: ApplyImportRequest,
): Promise<ImportApplyResult> {
  requireImportWrite(req.auth)
  if (!req.idempotencyKey) {
    throw new ImportError('IDEMPOTENCY_KEY_REQUIRED', 'idempotency key required', {}, 400)
  }

  try {
    validateCanonicalSnapshot(req.snapshot)
  } catch (e) {
    mapValidation(e)
  }
  assertNoLifecycleInPayload(req.snapshot.payload)

  const boardId = req.snapshot.manifest.boardId
  const canonicalHash = canonicalSubjectHash(req.snapshot)
  const requestBody = {
    boardId,
    snapshotId: req.snapshot.manifest.snapshotId,
    payloadSha256: req.snapshot.manifest.payloadSha256,
    entityExpectedRev: req.entityExpectedRev,
    expectedBoardRev: req.expectedBoardRev,
    expectedSubjectHash: req.expectedSubjectHash,
    dryRun: !!req.dryRun,
  }

  let begin
  try {
    begin = await beginIdempotent(idem, {
      scope: {
        actorId: req.auth.actorId,
        boardId,
        endpoint: IMPORT_ENDPOINT,
        key: req.idempotencyKey,
      },
      requestBody,
      runId: req.importId ?? null,
      nowMs: req.now ? Date.parse(req.now) : undefined,
    })
  } catch (e) {
    if (e instanceof IdempotencyError) {
      throw new ImportError(
        e.code === IDEMPOTENCY_CONFLICT ? IDEMPOTENCY_CONFLICT : 'IDEMPOTENCY_KEY_REQUIRED',
        e.message,
        { code: e.code },
        e.httpStatus,
      )
    }
    throw e
  }

  if (begin.kind === 'REPLAY' && begin.record) {
    const body = begin.record.responseBody as ImportApplyResult
    return { ...body, kind: 'REPLAY' }
  }

  try {
    const state = await ensureBoard(storage, req.snapshot)
    assertSnapshotFreshness(state, req.snapshot)

    // Capture lifecycle evidence fingerprint before apply
    const evidenceBefore = stableJson(state.lifecycleEvidenceByTask)

    const current: RevisionState = {
      boardId: state.boardId,
      entityType: 'canonical_import',
      entityId: state.boardId,
      entityRev: state.entityRev,
      boardRev: state.boardRev,
      subjectHash: state.subjectHash,
    }

    // Prefer injected revision store CAS when provided (C1B primitive).
    let nextEntityRev: number
    let nextBoardRev: number
    if (revisionStore) {
      const cas = await revisionStore.compareAndSwap({
        boardId: state.boardId,
        entityType: 'canonical_import',
        entityId: state.boardId,
        entityExpectedRev: req.entityExpectedRev,
        expectedBoardRev: req.expectedBoardRev,
        expectedSubjectHash: req.expectedSubjectHash,
        nextSubjectHash: canonicalHash,
      })
      if (!cas.ok) throw staleToImportError(cas)
      nextEntityRev = cas.entityRev
      nextBoardRev = cas.boardRev
    } else {
      const cas = evaluateCas(current, {
        boardId: state.boardId,
        entityType: 'canonical_import',
        entityId: state.boardId,
        entityExpectedRev: req.entityExpectedRev,
        expectedBoardRev: req.expectedBoardRev,
        expectedSubjectHash: req.expectedSubjectHash,
        nextSubjectHash: canonicalHash,
      })
      if (!cas.ok) throw staleToImportError(cas)
      nextEntityRev = cas.entityRev
      nextBoardRev = cas.boardRev
    }

    const appliedAt = req.now ?? new Date().toISOString()
    const importId = req.importId ?? `imp-${req.snapshot.manifest.snapshotId}-${nextEntityRev}`

    if (req.dryRun) {
      const dryResult: ImportApplyResult = {
        ok: true,
        kind: 'APPLIED',
        importId,
        boardId,
        snapshotId: req.snapshot.manifest.snapshotId,
        payloadSha256: req.snapshot.manifest.payloadSha256,
        canonicalHash,
        boardRev: state.boardRev,
        lifecycleRev: state.lifecycleRev,
        entityRev: state.entityRev,
        provenance: {
          actorId: req.auth.actorId,
          appliedAt,
          sourceRepoId: req.snapshot.manifest.sourceRepoId,
          sourceCommitSha: req.snapshot.manifest.sourceCommitSha,
          schemaVersion: CANONICAL_SNAPSHOT_SCHEMA,
          requestHash: begin.requestHash,
          idempotencyKey: req.idempotencyKey,
          dryRun: true,
        },
        lifecycleEvidenceUnchanged: true,
        readback: buildReadback(state, req.snapshot, canonicalHash),
      }
      await completeIdempotent(idem, begin.scopeHash, 200, dryResult, begin.requestHash)
      return dryResult
    }

    const after = await storage.applySnapshot({
      boardId,
      snapshot: req.snapshot,
      nextEntityRev,
      nextBoardRev,
      canonicalHash,
      actorId: req.auth.actorId,
      importId,
      appliedAt,
    })

    const evidenceAfter = stableJson(after.lifecycleEvidenceByTask)
    if (evidenceBefore !== evidenceAfter) {
      throw new ImportError(
        'LIFECYCLE_EVIDENCE_FABRICATED',
        'definition import mutated lifecycle evidence store',
        {},
        500,
      )
    }

    // lifecycleRev must not change on definition import
    if (after.lifecycleRev !== state.lifecycleRev) {
      throw new ImportError(
        'LIFECYCLE_EVIDENCE_FABRICATED',
        'definition import must not advance lifecycleRev',
        { before: state.lifecycleRev, after: after.lifecycleRev },
        500,
      )
    }

    await storage.appendAudit?.({
      ts: appliedAt,
      actor: req.auth.actorId,
      action: 'canonical_import',
      boardId,
      snapshotId: req.snapshot.manifest.snapshotId,
      payloadSha256: req.snapshot.manifest.payloadSha256,
      boardRev: after.boardRev,
      lifecycleRev: after.lifecycleRev,
    })

    const result: ImportApplyResult = {
      ok: true,
      kind: 'APPLIED',
      importId,
      boardId,
      snapshotId: req.snapshot.manifest.snapshotId,
      payloadSha256: req.snapshot.manifest.payloadSha256,
      canonicalHash,
      boardRev: after.boardRev,
      lifecycleRev: after.lifecycleRev,
      entityRev: after.entityRev,
      provenance: {
        actorId: req.auth.actorId,
        appliedAt,
        sourceRepoId: req.snapshot.manifest.sourceRepoId,
        sourceCommitSha: req.snapshot.manifest.sourceCommitSha,
        schemaVersion: CANONICAL_SNAPSHOT_SCHEMA,
        requestHash: begin.requestHash,
        idempotencyKey: req.idempotencyKey,
        dryRun: false,
      },
      lifecycleEvidenceUnchanged: true,
      readback: buildReadback(after, req.snapshot, canonicalHash),
    }

    await completeIdempotent(idem, begin.scopeHash, 200, result, begin.requestHash)
    return result
  } catch (e) {
    // Clear in-progress idempotency slot on failure so retries can proceed.
    try {
      await idem.delete(begin.scopeHash)
    } catch {
      /* ignore */
    }
    throw e
  }
}

function stableJson(v: unknown): string {
  return JSON.stringify(v ?? null)
}

/** Build snapshot from raw input (producer helper for tests/callers). */
export function buildSnapshotFromInput(input: CanonicalSnapshotInput): CanonicalSnapshot {
  return produceCanonicalSnapshot(input)
}

/** In-memory import storage for unit tests — never opens a real DB. */
export function createMemoryImportStorage(
  seed: ImportBoardState,
): ImportStorage & {
  state: () => ImportBoardState
  audits: () => Array<Record<string, unknown>>
} {
  let board: ImportBoardState = {
    ...seed,
    lifecycleEvidenceByTask: { ...seed.lifecycleEvidenceByTask },
  }
  const audits: Array<Record<string, unknown>> = []
  let lastSnapshot: CanonicalSnapshot | null = null

  return {
    state: () => ({
      ...board,
      lifecycleEvidenceByTask: { ...board.lifecycleEvidenceByTask },
    }),
    audits: () => audits.map((a) => ({ ...a })),
    async getBoardState(boardId: string) {
      if (board.boardId !== boardId) return null
      return {
        ...board,
        lifecycleEvidenceByTask: { ...board.lifecycleEvidenceByTask },
      }
    },
    async applySnapshot(args) {
      if (args.boardId !== board.boardId) {
        throw new ImportError('DATA_INTEGRITY', 'board mismatch')
      }
      // Preserve lifecycle evidence exactly
      const preservedEvidence = { ...board.lifecycleEvidenceByTask }
      lastSnapshot = args.snapshot
      board = {
        ...board,
        boardRev: args.nextBoardRev,
        entityRev: args.nextEntityRev,
        subjectHash: args.canonicalHash,
        canonicalSnapshotId: args.snapshot.manifest.snapshotId,
        canonicalHash: args.canonicalHash,
        lastSnapshotGeneratedAt: args.snapshot.manifest.generatedAt,
        lastSnapshotId: args.snapshot.manifest.snapshotId,
        lastPayloadSha256: args.snapshot.manifest.payloadSha256,
        lifecycleEvidenceByTask: preservedEvidence,
        // lifecycleRev unchanged
      }
      void lastSnapshot
      return {
        ...board,
        lifecycleEvidenceByTask: { ...board.lifecycleEvidenceByTask },
      }
    },
    async appendAudit(entry) {
      audits.push({ ...entry })
    },
  }
}
