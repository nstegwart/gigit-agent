/**
 * Board-scoped adaptive mapping version + live progress loader (addendum B / Req #2).
 * Read-only — never mutates pin/import; degrades when runtime/import storage unavailable.
 */
import {
  loadAdaptiveMappingVersion
  
} from '#/server/canonical-read-model'
import type {PinnedSnapshotReader} from '#/server/canonical-read-model';
import {
  mappingLiveProgress,
  mappingVersionToWire
  
  
} from '#/server/adaptive-mapping'
import type {MappingVersionInfo, MappingVersionWirePayload} from '#/server/adaptive-mapping';
import { getControlPlaneRuntimeContext } from '#/server/control-plane-runtime-context'
import { taskStageRows } from '#/server/tasks-store'

/** Lifecycle stages that count toward mapping progress (not delivery readiness). */
export const MAPPING_PROGRESS_STAGE_KEYS = [
  'MAPPED',
  'MAP_VERIFIED',
  'BUILT',
  'FUNCTIONAL',
  'INTEGRATED',
  'STAGING_PROVEN',
  'PROD_READY',
  'LIVE_VERIFIED',
] as const

const MAPPING_PROGRESS_STAGE_SET = new Set<string>(MAPPING_PROGRESS_STAGE_KEYS)

export type MappingProgressWire = ReturnType<typeof mappingLiveProgress>

/** Board surface wire: version + optional nested progress (TanStack-serializable). */
export type AdaptiveMappingVersionSurface = MappingVersionWirePayload & {
  mappingProgress: MappingProgressWire | null
}

export interface AdaptiveMappingSurfaceWire {
  mappingVersion: AdaptiveMappingVersionSurface
  mappingProgress: MappingProgressWire | null
}

function tryImportStorage(): PinnedSnapshotReader | null {
  try {
    const ctx = getControlPlaneRuntimeContext()
    return ctx.controlData.imports
  } catch {
    return null
  }
}

/**
 * Count tasks at or beyond mapping stages from durable lifecycle rows.
 * Honest zero when rows unavailable — never invents MAP_VERIFIED counts.
 */
export async function countMappingProgressTasks(boardId: string): Promise<number> {
  try {
    const rows = await taskStageRows(boardId)
    let n = 0
    for (const row of rows) {
      const stage = row.stage?.trim()
      if (stage && MAPPING_PROGRESS_STAGE_SET.has(stage)) n += 1
    }
    return n
  } catch {
    return 0
  }
}

export async function loadBoardAdaptiveMappingSurface(
  boardId: string,
  opts: { now?: Date | number; staleAfterSeconds?: number } = {},
): Promise<AdaptiveMappingSurfaceWire> {
  const storage = tryImportStorage()
  let version: MappingVersionInfo
  if (storage) {
    const loaded = await loadAdaptiveMappingVersion(storage, boardId, opts)
    version = loaded.version
  } else {
    const { ingestMappingSnapshot } = await import('#/server/adaptive-mapping')
    version = ingestMappingSnapshot(null, { now: opts.now }).version
    version = {
      ...version,
      warnings: [...version.warnings, 'RUNTIME_IMPORT_STORAGE_UNAVAILABLE'],
      mode: 'ADAPTIVE_DEGRADED',
      stale: true,
      staleReason: version.staleReason ?? 'RUNTIME_UNAVAILABLE',
    }
  }

  const completed = await countMappingProgressTasks(boardId)
  const mappingProgress =
    version.dynamicDenominator > 0 || completed > 0
      ? mappingLiveProgress(version, completed)
      : null

  const mappingVersion: AdaptiveMappingVersionSurface = {
    ...mappingVersionToWire(version),
    mappingProgress,
  }

  return { mappingVersion, mappingProgress }
}