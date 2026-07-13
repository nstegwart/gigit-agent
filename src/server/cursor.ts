/**
 * Stable opaque cursor for (createdAt, id) descending pagination.
 * Pins query/snapshot revision. Default page size 50, maximum 200.
 * Strict validation + typed failures. Deterministic encode/decode/compare.
 */
import { createHash } from 'node:crypto'

export const DEFAULT_PAGE_SIZE = 50
export const MAX_PAGE_SIZE = 200

export type CursorErrorCode =
  | 'CURSOR_INVALID'
  | 'CURSOR_TAMPERED'
  | 'CURSOR_REVISION_MISMATCH'
  | 'PAGE_SIZE_INVALID'

export class CursorError extends Error {
  readonly code: CursorErrorCode
  constructor(code: CursorErrorCode, message: string) {
    super(message)
    this.name = 'CursorError'
    this.code = code
  }
}

export interface CursorPayload {
  /** ISO-8601 or sortable createdAt string of the last seen row. */
  createdAt: string
  id: string
  /** Pinned board/query revision at first page. */
  boardRev: number
  /** Optional pinned snapshot/query revision id. */
  snapshotRev?: string | null
  /** Sort direction — only DESC is supported for list contracts. */
  order: 'DESC'
}

export interface PageParams {
  cursor?: string | null
  pageSize?: number | null
  /** Required when decoding a cursor; must match the pinned revision. */
  expectedBoardRev: number
  expectedSnapshotRev?: string | null
}

export interface ResolvedPage {
  pageSize: number
  cursor: CursorPayload | null
  boardRev: number
  snapshotRev: string | null
}

const CURSOR_PREFIX = 'v1'

function b64urlEncode(raw: string): string {
  return Buffer.from(raw, 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '')
}

function b64urlDecode(raw: string): string {
  const pad = raw.length % 4 === 0 ? '' : '='.repeat(4 - (raw.length % 4))
  const b64 = raw.replace(/-/g, '+').replace(/_/g, '/') + pad
  return Buffer.from(b64, 'base64').toString('utf8')
}

function macOf(body: string): string {
  // Deterministic integrity tag without external secrets (opaque + tamper-evident for client).
  // Not a server HMAC secret — prevents casual mutation of cursor fields.
  return createHash('sha256').update(`cairn-cursor|${body}`).digest('hex').slice(0, 16)
}

/** Encode cursor payload to stable opaque string. */
export function encodeCursor(payload: CursorPayload): string {
  if (payload.order !== 'DESC') {
    throw new CursorError('CURSOR_INVALID', 'only DESC order is supported')
  }
  if (!payload.createdAt || !payload.id) {
    throw new CursorError('CURSOR_INVALID', 'createdAt and id are required')
  }
  if (!Number.isInteger(payload.boardRev) || payload.boardRev < 0) {
    throw new CursorError('CURSOR_INVALID', 'boardRev must be a non-negative integer')
  }
  const body = JSON.stringify({
    createdAt: payload.createdAt,
    id: payload.id,
    boardRev: payload.boardRev,
    snapshotRev: payload.snapshotRev ?? null,
    order: 'DESC' as const,
  })
  const mac = macOf(body)
  return `${CURSOR_PREFIX}.${b64urlEncode(body)}.${mac}`
}

/** Decode + verify opaque cursor. Throws CursorError on tamper/invalid. */
export function decodeCursor(token: string): CursorPayload {
  if (typeof token !== 'string' || !token.startsWith(`${CURSOR_PREFIX}.`)) {
    throw new CursorError('CURSOR_INVALID', 'cursor must be a v1 opaque token')
  }
  const parts = token.split('.')
  if (parts.length !== 3) {
    throw new CursorError('CURSOR_INVALID', 'cursor format invalid')
  }
  const [, encoded, mac] = parts
  let body: string
  try {
    body = b64urlDecode(encoded!)
  } catch {
    throw new CursorError('CURSOR_INVALID', 'cursor body is not valid base64url')
  }
  if (macOf(body) !== mac) {
    throw new CursorError('CURSOR_TAMPERED', 'cursor integrity check failed')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    throw new CursorError('CURSOR_INVALID', 'cursor body is not JSON')
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new CursorError('CURSOR_INVALID', 'cursor payload must be an object')
  }
  const p = parsed as Record<string, unknown>
  if (p.order !== 'DESC') {
    throw new CursorError('CURSOR_INVALID', 'cursor order must be DESC')
  }
  if (typeof p.createdAt !== 'string' || typeof p.id !== 'string') {
    throw new CursorError('CURSOR_INVALID', 'cursor createdAt/id required')
  }
  if (typeof p.boardRev !== 'number' || !Number.isInteger(p.boardRev) || p.boardRev < 0) {
    throw new CursorError('CURSOR_INVALID', 'cursor boardRev invalid')
  }
  const snapshotRev =
    p.snapshotRev === null || p.snapshotRev === undefined
      ? null
      : typeof p.snapshotRev === 'string'
        ? p.snapshotRev
        : (() => {
            throw new CursorError('CURSOR_INVALID', 'cursor snapshotRev invalid')
          })()

  return {
    createdAt: p.createdAt,
    id: p.id,
    boardRev: p.boardRev,
    snapshotRev,
    order: 'DESC',
  }
}

/** Fail-closed page size: default 50, max 200; reject oversized / non-positive. */
export function resolvePageSize(pageSize?: number | null): number {
  if (pageSize === undefined || pageSize === null) return DEFAULT_PAGE_SIZE
  if (typeof pageSize !== 'number' || !Number.isInteger(pageSize) || pageSize < 1) {
    throw new CursorError('PAGE_SIZE_INVALID', `pageSize must be integer 1..${MAX_PAGE_SIZE}`)
  }
  if (pageSize > MAX_PAGE_SIZE) {
    throw new CursorError(
      'PAGE_SIZE_INVALID',
      `pageSize ${pageSize} exceeds maximum ${MAX_PAGE_SIZE}`,
    )
  }
  return pageSize
}

/**
 * Resolve page params with revision pin enforcement.
 * Cursor boardRev/snapshotRev must match the query pin.
 */
export function resolvePage(params: PageParams): ResolvedPage {
  const pageSize = resolvePageSize(params.pageSize)
  const boardRev = params.expectedBoardRev
  if (typeof boardRev !== 'number' || !Number.isInteger(boardRev) || boardRev < 0) {
    throw new CursorError('CURSOR_INVALID', 'expectedBoardRev must be a non-negative integer')
  }
  const snapshotRev = params.expectedSnapshotRev ?? null

  if (!params.cursor) {
    return { pageSize, cursor: null, boardRev, snapshotRev }
  }

  const cursor = decodeCursor(params.cursor)
  if (cursor.boardRev !== boardRev) {
    throw new CursorError(
      'CURSOR_REVISION_MISMATCH',
      `cursor boardRev ${cursor.boardRev} != pinned ${boardRev}`,
    )
  }
  const curSnap = cursor.snapshotRev ?? null
  if (curSnap !== snapshotRev) {
    throw new CursorError(
      'CURSOR_REVISION_MISMATCH',
      `cursor snapshotRev ${String(curSnap)} != pinned ${String(snapshotRev)}`,
    )
  }
  return { pageSize, cursor, boardRev, snapshotRev }
}

/**
 * Compare two (createdAt, id) keys for DESC order.
 * Returns <0 if a should appear before b in DESC (a is newer / higher).
 */
export function compareCreatedAtIdDesc(
  a: { createdAt: string; id: string },
  b: { createdAt: string; id: string },
): number {
  if (a.createdAt > b.createdAt) return -1
  if (a.createdAt < b.createdAt) return 1
  if (a.id > b.id) return -1
  if (a.id < b.id) return 1
  return 0
}

/** True if row is strictly after the cursor position in DESC order (i.e. older / lower). */
export function isAfterCursorDesc(
  row: { createdAt: string; id: string },
  cursor: { createdAt: string; id: string },
): boolean {
  return compareCreatedAtIdDesc(row, cursor) > 0
}

/**
 * Paginate an already-sorted DESC list using cursor boundaries.
 * Deterministic; does not mutate input.
 */
export function paginateDesc<T extends { createdAt: string; id: string }>(
  rows: ReadonlyArray<T>,
  params: PageParams,
): { items: Array<T>; nextCursor: string | null; pageSize: number } {
  const page = resolvePage(params)
  let start = 0
  if (page.cursor) {
    start = rows.findIndex((r) => isAfterCursorDesc(r, page.cursor!))
    if (start < 0) start = rows.length
  }
  const slice = rows.slice(start, start + page.pageSize)
  let nextCursor: string | null = null
  if (slice.length === page.pageSize && start + page.pageSize < rows.length) {
    const last = slice[slice.length - 1]!
    nextCursor = encodeCursor({
      createdAt: last.createdAt,
      id: last.id,
      boardRev: page.boardRev,
      snapshotRev: page.snapshotRev,
      order: 'DESC',
    })
  }
  return { items: slice, nextCursor, pageSize: page.pageSize }
}
