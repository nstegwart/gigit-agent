/**
 * Monotonic integer entity + board revisions with atomic compare-and-swap.
 * Every mutation validates entityExpectedRev + expectedBoardRev + subject hash.
 * Mismatch → typed STALE_REVISION with safe current metadata. No last-write-wins.
 */
import { createHash } from 'node:crypto'

export const STALE_REVISION = 'STALE_REVISION' as const
export type RevisionErrorCode = typeof STALE_REVISION

export interface RevisionIdentity {
  boardId: string
  entityType: string
  entityId: string
}

export interface RevisionState {
  boardId: string
  entityType: string
  entityId: string
  entityRev: number
  boardRev: number
  subjectHash: string | null
}

export interface CasMutationRequest {
  boardId: string
  entityType: string
  entityId: string
  entityExpectedRev: number
  expectedBoardRev: number
  /** Canonical subject hash the client believes is current. */
  expectedSubjectHash: string
  /** New subject hash after successful mutation (precomputed by caller). */
  nextSubjectHash: string
}

export interface CasSuccess {
  ok: true
  entityRev: number
  boardRev: number
  subjectHash: string
}

export interface StaleRevisionError {
  ok: false
  code: typeof STALE_REVISION
  message: string
  current: {
    boardId: string
    entityType: string
    entityId: string
    entityRev: number
    boardRev: number
    subjectHash: string | null
  }
}

export type CasResult = CasSuccess | StaleRevisionError

export interface RevisionStore {
  getBoardRev(boardId: string): Promise<{ boardRev: number; subjectHash: string | null }>
  getEntity(id: RevisionIdentity): Promise<RevisionState | null>
  /**
   * Atomically apply CAS. Implementations MUST be concurrency-safe
   * (single-flight lock, SERIALIZABLE tx, or equivalent).
   */
  compareAndSwap(req: CasMutationRequest): Promise<CasResult>
}

export function assertMonotonicInt(n: unknown, label: string): number {
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 0 || !Number.isFinite(n)) {
    throw new Error(`Invalid ${label}: expected non-negative integer, got ${String(n)}`)
  }
  return n
}

export function subjectHashOf(payload: unknown): string {
  const canonical = stableStringify(payload)
  return createHash('sha256').update(canonical).digest('hex')
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => stableStringify(v)).join(',')}]`
  }
  const obj = value as Record<string, unknown>
  const keys = Object.keys(obj).sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`
}

export function staleRevision(
  current: RevisionState,
  reason: string,
): StaleRevisionError {
  return {
    ok: false,
    code: STALE_REVISION,
    message: reason,
    current: {
      boardId: current.boardId,
      entityType: current.entityType,
      entityId: current.entityId,
      entityRev: current.entityRev,
      boardRev: current.boardRev,
      subjectHash: current.subjectHash,
    },
  }
}

/**
 * Pure CAS check used by stores (and unit tests) after loading current state
 * under a lock. Does not mutate; returns the next revs on success.
 */
export function evaluateCas(
  current: RevisionState,
  req: CasMutationRequest,
): CasResult {
  assertMonotonicInt(req.entityExpectedRev, 'entityExpectedRev')
  assertMonotonicInt(req.expectedBoardRev, 'expectedBoardRev')
  assertMonotonicInt(current.entityRev, 'current.entityRev')
  assertMonotonicInt(current.boardRev, 'current.boardRev')

  if (current.boardId !== req.boardId || current.entityId !== req.entityId || current.entityType !== req.entityType) {
    return staleRevision(current, 'subject identity mismatch')
  }
  if (current.entityRev !== req.entityExpectedRev) {
    return staleRevision(
      current,
      `entity rev mismatch: expected ${req.entityExpectedRev}, current ${current.entityRev}`,
    )
  }
  if (current.boardRev !== req.expectedBoardRev) {
    return staleRevision(
      current,
      `board rev mismatch: expected ${req.expectedBoardRev}, current ${current.boardRev}`,
    )
  }
  const currentHash = current.subjectHash ?? ''
  if (currentHash !== req.expectedSubjectHash) {
    return staleRevision(
      current,
      `subject hash mismatch: expected ${req.expectedSubjectHash}, current ${currentHash || 'null'}`,
    )
  }
  if (!req.nextSubjectHash || typeof req.nextSubjectHash !== 'string') {
    throw new Error('nextSubjectHash required')
  }

  return {
    ok: true,
    entityRev: current.entityRev + 1,
    boardRev: current.boardRev + 1,
    subjectHash: req.nextSubjectHash,
  }
}

/** In-memory concurrency-safe revision store (reference implementation for later DB wiring). */
export function createMemoryRevisionStore(
  seed: Array<RevisionState> = [],
): RevisionStore & {
  snapshot(): Array<RevisionState>
} {
  const boards = new Map<string, { boardRev: number; subjectHash: string | null }>()
  const entities = new Map<string, RevisionState>()
  let chain: Promise<unknown> = Promise.resolve()

  const keyOf = (id: RevisionIdentity) => `${id.boardId}::${id.entityType}::${id.entityId}`

  for (const s of seed) {
    entities.set(keyOf(s), { ...s })
    const b = boards.get(s.boardId)
    if (!b || s.boardRev > b.boardRev) {
      boards.set(s.boardId, { boardRev: s.boardRev, subjectHash: s.subjectHash })
    }
  }

  const withLock = async <T>(fn: () => T | Promise<T>): Promise<T> => {
    const run = chain.then(fn, fn)
    chain = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  return {
    snapshot() {
      return [...entities.values()].map((e) => ({ ...e }))
    },
    async getBoardRev(boardId: string) {
      return boards.get(boardId) ?? { boardRev: 0, subjectHash: null }
    },
    async getEntity(id: RevisionIdentity) {
      return entities.get(keyOf(id)) ?? null
    },
    async compareAndSwap(req: CasMutationRequest) {
      return withLock(() => {
        const k = keyOf(req)
        let current = entities.get(k)
        if (!current) {
          // First write: only allowed when expected revs are 0 and hash is empty
          current = {
            boardId: req.boardId,
            entityType: req.entityType,
            entityId: req.entityId,
            entityRev: 0,
            boardRev: boards.get(req.boardId)?.boardRev ?? 0,
            subjectHash: null,
          }
        }
        // Align board rev from board map (board is source of truth for boardRev)
        const board = boards.get(req.boardId) ?? { boardRev: current.boardRev, subjectHash: null }
        current = { ...current, boardRev: board.boardRev }

        const result = evaluateCas(current, req)
        if (!result.ok) return result

        const next: RevisionState = {
          boardId: req.boardId,
          entityType: req.entityType,
          entityId: req.entityId,
          entityRev: result.entityRev,
          boardRev: result.boardRev,
          subjectHash: result.subjectHash,
        }
        entities.set(k, next)
        boards.set(req.boardId, { boardRev: result.boardRev, subjectHash: result.subjectHash })
        return result
      })
    },
  }
}
