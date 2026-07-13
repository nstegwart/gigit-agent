/**
 * Idempotency: scope = actor + board + endpoint + key.
 * Canonical request hash, 24h TTL, exact replay for same hash,
 * 409 IDEMPOTENCY_CONFLICT for different hash, unique runId support.
 * Storage interface + concurrency-safe in-memory reference implementation.
 * Never stores secrets/private payloads — only status + redacted body envelope.
 */
import { createHash } from 'node:crypto'

export const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000
export const IDEMPOTENCY_CONFLICT = 'IDEMPOTENCY_CONFLICT' as const
export const IDEMPOTENCY_IN_PROGRESS = 'IDEMPOTENCY_IN_PROGRESS' as const

export type IdempotencyErrorCode =
  | typeof IDEMPOTENCY_CONFLICT
  | typeof IDEMPOTENCY_IN_PROGRESS
  | 'IDEMPOTENCY_KEY_REQUIRED'
  | 'IDEMPOTENCY_EXPIRED'

export class IdempotencyError extends Error {
  readonly code: IdempotencyErrorCode
  readonly httpStatus: number
  constructor(code: IdempotencyErrorCode, message: string, httpStatus = 409) {
    super(message)
    this.name = 'IdempotencyError'
    this.code = code
    this.httpStatus = httpStatus
  }
}

export interface IdempotencyScope {
  actorId: string
  boardId: string
  endpoint: string
  key: string
}

export interface IdempotencyRecord {
  scopeHash: string
  actorId: string
  boardId: string
  endpoint: string
  key: string
  requestHash: string
  responseStatus: number
  /** Redacted response body — never tokens/passwords/private decision text. */
  responseBody: unknown
  runId?: string | null
  createdAtMs: number
  expiresAtMs: number
  inProgress?: boolean
}

export interface IdempotencyBeginResult {
  kind: 'EXECUTE' | 'REPLAY'
  record?: IdempotencyRecord
  scopeHash: string
  requestHash: string
}

export interface IdempotencyStorage {
  get(scopeHash: string): Promise<IdempotencyRecord | null>
  getByRunId(boardId: string, runId: string): Promise<IdempotencyRecord | null>
  /**
   * Atomically insert in-progress or return existing. Concurrency-safe.
   * Returns existing if scope already present.
   */
  putIfAbsent(record: IdempotencyRecord): Promise<{ inserted: boolean; record: IdempotencyRecord }>
  complete(scopeHash: string, patch: Pick<IdempotencyRecord, 'responseStatus' | 'responseBody' | 'requestHash'> & { inProgress?: boolean }): Promise<void>
  delete(scopeHash: string): Promise<void>
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map((v) => stableStringify(v)).join(',')}]`
  const obj = value as Record<string, unknown>
  const keys = Object.keys(obj).sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`
}

export function scopeHashOf(scope: IdempotencyScope): string {
  const raw = `${scope.actorId}\n${scope.boardId}\n${scope.endpoint}\n${scope.key}`
  return createHash('sha256').update(raw).digest('hex')
}

/** Canonical request hash — redacts secrets by default. */
export function requestHashOf(body: unknown, redactor: (b: unknown) => unknown = redactSecrets): string {
  const safe = redactor(body)
  return createHash('sha256').update(stableStringify(safe)).digest('hex')
}

/** Default redactor: strip common secret field names recursively. */
export function redactSecrets(value: unknown): unknown {
  const SECRET_KEYS = new Set([
    'password',
    'token',
    'secret',
    'authorization',
    'cookie',
    'apiKey',
    'api_key',
    'privateKey',
    'private_key',
    'accessToken',
    'refreshToken',
  ])
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map((v) => redactSecrets(v))
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (SECRET_KEYS.has(k)) {
      out[k] = '[REDACTED]'
      continue
    }
    out[k] = redactSecrets(v)
  }
  return out
}

export function assertIdempotencyKey(key: unknown): string {
  if (typeof key !== 'string' || key.trim().length === 0) {
    throw new IdempotencyError('IDEMPOTENCY_KEY_REQUIRED', 'idempotency key required', 400)
  }
  if (key.length > 191) {
    throw new IdempotencyError('IDEMPOTENCY_KEY_REQUIRED', 'idempotency key too long', 400)
  }
  return key
}

export interface BeginOptions {
  scope: IdempotencyScope
  requestBody: unknown
  runId?: string | null
  nowMs?: number
  redactor?: (b: unknown) => unknown
}

/**
 * Begin an idempotent operation against storage.
 * Same scope+hash → REPLAY. Same scope+different hash → 409.
 * Unique runId: collision with different scope/hash → conflict.
 */
export async function beginIdempotent(
  storage: IdempotencyStorage,
  opts: BeginOptions,
): Promise<IdempotencyBeginResult> {
  const key = assertIdempotencyKey(opts.scope.key)
  const scope: IdempotencyScope = { ...opts.scope, key }
  const scopeHash = scopeHashOf(scope)
  const requestHash = requestHashOf(opts.requestBody, opts.redactor ?? redactSecrets)
  const now = opts.nowMs ?? Date.now()

  if (opts.runId) {
    const byRun = await storage.getByRunId(scope.boardId, opts.runId)
    if (byRun && byRun.scopeHash !== scopeHash) {
      throw new IdempotencyError(
        IDEMPOTENCY_CONFLICT,
        `runId ${opts.runId} already bound to a different idempotency scope`,
        409,
      )
    }
    if (byRun && byRun.requestHash !== requestHash && !byRun.inProgress) {
      throw new IdempotencyError(
        IDEMPOTENCY_CONFLICT,
        `runId ${opts.runId} request hash conflict`,
        409,
      )
    }
  }

  const existing = await storage.get(scopeHash)
  if (existing) {
    if (existing.expiresAtMs <= now) {
      await storage.delete(scopeHash)
    } else if (existing.inProgress) {
      if (existing.requestHash !== requestHash) {
        throw new IdempotencyError(
          IDEMPOTENCY_CONFLICT,
          'in-progress idempotency key with different request hash',
          409,
        )
      }
      throw new IdempotencyError(
        IDEMPOTENCY_IN_PROGRESS,
        'idempotent request already in progress',
        409,
      )
    } else if (existing.requestHash === requestHash) {
      return { kind: 'REPLAY', record: existing, scopeHash, requestHash }
    } else {
      throw new IdempotencyError(
        IDEMPOTENCY_CONFLICT,
        'idempotency key reused with different request hash',
        409,
      )
    }
  }

  const record: IdempotencyRecord = {
    scopeHash,
    actorId: scope.actorId,
    boardId: scope.boardId,
    endpoint: scope.endpoint,
    key: scope.key,
    requestHash,
    responseStatus: 0,
    responseBody: null,
    runId: opts.runId ?? null,
    createdAtMs: now,
    expiresAtMs: now + IDEMPOTENCY_TTL_MS,
    inProgress: true,
  }

  const put = await storage.putIfAbsent(record)
  if (!put.inserted) {
    const cur = put.record
    if (cur.expiresAtMs <= now) {
      await storage.delete(scopeHash)
      const retry = await storage.putIfAbsent(record)
      if (!retry.inserted) {
        // concurrent winner
        return beginIdempotent(storage, opts)
      }
      return { kind: 'EXECUTE', scopeHash, requestHash }
    }
    if (cur.requestHash === requestHash) {
      if (cur.inProgress) {
        throw new IdempotencyError(
          IDEMPOTENCY_IN_PROGRESS,
          'idempotent request already in progress',
          409,
        )
      }
      return { kind: 'REPLAY', record: cur, scopeHash, requestHash }
    }
    throw new IdempotencyError(
      IDEMPOTENCY_CONFLICT,
      'idempotency key reused with different request hash',
      409,
    )
  }

  return { kind: 'EXECUTE', scopeHash, requestHash }
}

export async function completeIdempotent(
  storage: IdempotencyStorage,
  scopeHash: string,
  responseStatus: number,
  responseBody: unknown,
  requestHash: string,
  redactor?: (b: unknown) => unknown,
): Promise<void> {
  const safeBody = (redactor ?? redactSecrets)(responseBody)
  await storage.complete(scopeHash, {
    responseStatus,
    responseBody: safeBody,
    requestHash,
    inProgress: false,
  })
}

/** Concurrency-safe in-memory storage (reference for later DB wiring). */
export function createMemoryIdempotencyStorage(): IdempotencyStorage & {
  all(): Array<IdempotencyRecord>
} {
  const byScope = new Map<string, IdempotencyRecord>()
  const runIndex = new Map<string, string>() // boardId::runId -> scopeHash
  let chain: Promise<unknown> = Promise.resolve()

  const withLock = async <T>(fn: () => T | Promise<T>): Promise<T> => {
    const run = chain.then(fn, fn)
    chain = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  return {
    all() {
      return [...byScope.values()].map((r) => ({ ...r }))
    },
    async get(scopeHash: string) {
      const r = byScope.get(scopeHash)
      return r ? { ...r } : null
    },
    async getByRunId(boardId: string, runId: string) {
      const scopeHash = runIndex.get(`${boardId}::${runId}`)
      if (!scopeHash) return null
      const r = byScope.get(scopeHash)
      return r ? { ...r } : null
    },
    async putIfAbsent(record: IdempotencyRecord) {
      return withLock(() => {
        const existing = byScope.get(record.scopeHash)
        if (existing) return { inserted: false, record: { ...existing } }
        if (record.runId) {
          const rk = `${record.boardId}::${record.runId}`
          if (runIndex.has(rk)) {
            const other = byScope.get(runIndex.get(rk)!)!
            return { inserted: false, record: { ...other } }
          }
          runIndex.set(rk, record.scopeHash)
        }
        byScope.set(record.scopeHash, { ...record })
        return { inserted: true, record: { ...record } }
      })
    },
    async complete(scopeHash, patch) {
      return withLock(() => {
        const cur = byScope.get(scopeHash)
        if (!cur) return
        byScope.set(scopeHash, {
          ...cur,
          responseStatus: patch.responseStatus,
          responseBody: patch.responseBody,
          requestHash: patch.requestHash,
          inProgress: patch.inProgress ?? false,
        })
      })
    },
    async delete(scopeHash: string) {
      return withLock(() => {
        const cur = byScope.get(scopeHash)
        if (cur?.runId) runIndex.delete(`${cur.boardId}::${cur.runId}`)
        byScope.delete(scopeHash)
      })
    },
  }
}
