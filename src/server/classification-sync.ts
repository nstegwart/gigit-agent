import { createHash } from 'node:crypto'

import type {
  ClassificationReceipt,
  TaskClass,
  TaskClassificationRecord,
  TaskDisposition,
} from '#/lib/control-plane-types'

export const CLASSIFICATION_SYNC_SCHEMA =
  'TM_CLASSIFICATION_SYNC_SCHEMA_007_V1' as const

export type ClassificationSyncItem = {
  taskId: string
  taskClass: TaskClass
  disposition: TaskDisposition
  controlPlaneTargetGate?: string | null
}

export type ClassificationSyncPin = {
  canonicalSnapshotId: string
  canonicalHash: string
  boardRev: number
  lifecycleRev: number
}

export type ClassificationSyncPlan = {
  schemaVersion: typeof CLASSIFICATION_SYNC_SCHEMA
  inputBoardRev: number
  outputBoardRev: number
  canonicalSnapshotId: string
  canonicalHash: string
  lifecycleRev: number
  counts: {
    total: number
    product: number
    controlPlane: number
    active: number
    hold: number
    exclude: number
  }
  records: TaskClassificationRecord[]
}

export class ClassificationSyncError extends Error {
  constructor(
    readonly code:
      | 'EMPTY_CANONICAL_TASK_SET'
      | 'DUPLICATE_TASK_ID'
      | 'TASK_SET_MISMATCH'
      | 'UNCLASSIFIED_FORBIDDEN'
      | 'CONTROL_PLANE_HOLD_FORBIDDEN'
      | 'PIN_INVALID',
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message)
    this.name = 'ClassificationSyncError'
  }
}

export function projectClassificationSyncAuditActivity(
  rows: ReadonlyArray<Record<string, unknown>>,
  fallbackTs: string,
): Array<{
  ts: string
  kind: 'classification_sync'
  message: string
  auditId: string | null
  boardRev: number
  taskCount: number
}> {
  return rows
    .filter((row) => String(row.action ?? '') === 'CLASSIFICATION_SYNC')
    .map((row) => {
      let detail: Record<string, unknown> = {}
      if (
        row.detail &&
        typeof row.detail === 'object' &&
        !Array.isArray(row.detail)
      ) {
        detail = row.detail as Record<string, unknown>
      } else if (typeof row.detail === 'string') {
        try {
          const parsed = JSON.parse(row.detail)
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
            detail = parsed
        } catch {
          detail = {}
        }
      }
      const taskCount = Number(detail.taskCount ?? 0)
      return {
        ts: typeof row.ts === 'string' && row.ts ? row.ts : fallbackTs,
        kind: 'classification_sync' as const,
        message: `Published ${Number.isFinite(taskCount) ? taskCount : 0} task classifications`,
        auditId: typeof detail.eventId === 'string' ? detail.eventId : null,
        boardRev: Number.isFinite(Number(detail.outputBoardRev))
          ? Number(detail.outputBoardRev)
          : 0,
        taskCount: Number.isFinite(taskCount) ? taskCount : 0,
      }
    })
}

function stable(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stable(record[key])}`)
    .join(',')}}`
}

function sha256(value: unknown): string {
  return createHash('sha256').update(stable(value)).digest('hex')
}

function cleanId(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function assertPin(pin: ClassificationSyncPin): void {
  if (
    !cleanId(pin.canonicalSnapshotId) ||
    !/^[a-f0-9]{32,128}$/i.test(cleanId(pin.canonicalHash)) ||
    !Number.isSafeInteger(pin.boardRev) ||
    pin.boardRev < 0 ||
    !Number.isSafeInteger(pin.lifecycleRev) ||
    pin.lifecycleRev < 0
  ) {
    throw new ClassificationSyncError(
      'PIN_INVALID',
      'classification sync pin is invalid',
    )
  }
}

/**
 * Build a complete classification replacement bound to the post-mutation board rev.
 *
 * This is intentionally all-or-nothing at the definition-set level: a partial batch
 * would leave valid-looking gaps and keep `/work` in DATA_INTEGRITY. Persistence may
 * still fail mid-flight, but those rows are bound to the not-yet-published output rev,
 * so they remain invalid until the same idempotent batch completes and the rev advances.
 */
export function buildClassificationSyncPlan(input: {
  items: ReadonlyArray<ClassificationSyncItem>
  canonicalTaskIds: ReadonlyArray<string>
  pin: ClassificationSyncPin
  issuedAt: string
}): ClassificationSyncPlan {
  assertPin(input.pin)
  const issuedMs = Date.parse(input.issuedAt)
  if (Number.isNaN(issuedMs)) {
    throw new ClassificationSyncError(
      'PIN_INVALID',
      'issuedAt must be valid ISO time',
    )
  }

  const canonicalTaskIds = input.canonicalTaskIds
    .map(cleanId)
    .filter(Boolean)
    .sort()
  if (canonicalTaskIds.length === 0) {
    throw new ClassificationSyncError(
      'EMPTY_CANONICAL_TASK_SET',
      'canonical task set must not be empty',
    )
  }
  const canonicalSet = new Set(canonicalTaskIds)
  if (canonicalSet.size !== canonicalTaskIds.length) {
    throw new ClassificationSyncError(
      'DUPLICATE_TASK_ID',
      'canonical task set contains duplicate ids',
    )
  }

  const items = input.items
    .map((item) => ({ ...item, taskId: cleanId(item.taskId) }))
    .sort((a, b) => a.taskId.localeCompare(b.taskId))
  const itemIds = items.map((item) => item.taskId)
  const itemSet = new Set(itemIds)
  if (itemSet.size !== itemIds.length) {
    throw new ClassificationSyncError(
      'DUPLICATE_TASK_ID',
      'classification batch contains duplicate task ids',
    )
  }

  const missing = canonicalTaskIds.filter((id) => !itemSet.has(id))
  const extra = itemIds.filter((id) => !canonicalSet.has(id))
  if (missing.length > 0 || extra.length > 0) {
    throw new ClassificationSyncError(
      'TASK_SET_MISMATCH',
      'classification batch must exactly cover the canonical task set',
      { missing, extra },
    )
  }

  for (const item of items) {
    if (
      item.taskClass === 'UNCLASSIFIED' ||
      item.disposition === 'UNCLASSIFIED'
    ) {
      throw new ClassificationSyncError(
        'UNCLASSIFIED_FORBIDDEN',
        `classification sync refuses UNCLASSIFIED for ${item.taskId}`,
        { taskId: item.taskId },
      )
    }
    if (item.taskClass === 'CONTROL_PLANE' && item.disposition !== 'ACTIVE') {
      throw new ClassificationSyncError(
        'CONTROL_PLANE_HOLD_FORBIDDEN',
        `CONTROL_PLANE task ${item.taskId} must remain ACTIVE`,
        { taskId: item.taskId, disposition: item.disposition },
      )
    }
  }

  const outputBoardRev = input.pin.boardRev + 1
  const issuedAt = new Date(issuedMs).toISOString()
  const records = items.map((item): TaskClassificationRecord => {
    const receiptBody = {
      schemaVersion: CLASSIFICATION_SYNC_SCHEMA,
      taskId: item.taskId,
      taskClass: item.taskClass,
      disposition: item.disposition,
      canonicalSnapshotId: input.pin.canonicalSnapshotId,
      canonicalHash: input.pin.canonicalHash,
      taskHash: input.pin.canonicalHash,
      boardRev: outputBoardRev,
      lifecycleRev: input.pin.lifecycleRev,
      issuedAt,
      bindingMode: 'CANONICAL_PIN' as const,
      canonicalBoardRev: input.pin.boardRev,
    }
    const receiptHash = sha256(receiptBody)
    const receipt: ClassificationReceipt = {
      receiptId: `class-v3-${receiptHash.slice(0, 32)}`,
      receiptHash,
      taskId: item.taskId,
      taskClass: item.taskClass,
      disposition: item.disposition,
      canonicalSnapshotId: input.pin.canonicalSnapshotId,
      canonicalHash: input.pin.canonicalHash,
      taskHash: input.pin.canonicalHash,
      boardRev: outputBoardRev,
      lifecycleRev: input.pin.lifecycleRev,
      issuedAt,
      bindingMode: 'CANONICAL_PIN',
      canonicalBoardRev: input.pin.boardRev,
    }
    return {
      taskId: item.taskId,
      taskClass: item.taskClass,
      disposition: item.disposition,
      receipt,
      controlPlaneTargetGate:
        item.taskClass === 'CONTROL_PLANE'
          ? cleanId(item.controlPlaneTargetGate) || 'CONTROL_PLANE_WORK_PENDING'
          : null,
      controlPlaneGateVerifiedPass: false,
      controlPlaneRootAccepted: false,
    }
  })

  return {
    schemaVersion: CLASSIFICATION_SYNC_SCHEMA,
    inputBoardRev: input.pin.boardRev,
    outputBoardRev,
    canonicalSnapshotId: input.pin.canonicalSnapshotId,
    canonicalHash: input.pin.canonicalHash,
    lifecycleRev: input.pin.lifecycleRev,
    counts: {
      total: records.length,
      product: records.filter((record) => record.taskClass === 'PRODUCT')
        .length,
      controlPlane: records.filter(
        (record) => record.taskClass === 'CONTROL_PLANE',
      ).length,
      active: records.filter((record) => record.disposition === 'ACTIVE')
        .length,
      hold: records.filter((record) => record.disposition === 'HOLD').length,
      exclude: records.filter((record) => record.disposition === 'EXCLUDE')
        .length,
    },
    records,
  }
}
