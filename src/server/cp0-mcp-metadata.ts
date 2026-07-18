/**
 * CP0 MCP metadata helpers.
 * Sync/backlog projection is canonical in cp0-sync-status.ts (re-exported here
 * so health and MCP share one implementation — no dual-copy drift).
 */
export {
  buildCp0SyncStatusReadback,
  toHealthzSyncPayload,
  type Cp0SyncStatusRow,
  type Cp0SyncStatusPin,
  type Cp0SyncStatusReadback,
  type Cp0HealthzSyncPayload,
} from '#/server/cp0-sync-status'

export type Cp0MetadataPin = {
  boardRev: number
  lifecycleRev: number
  canonicalHash: string
}

export function resolveCp0ReadBoardId(
  requestedBoardId: unknown,
  principal:
    | { boardId?: string | null; boards?: ReadonlyArray<string> | null }
    | null
    | undefined,
): string {
  const requested = typeof requestedBoardId === 'string' ? requestedBoardId.trim() : ''
  if (requested) return requested
  const bound = String(principal?.boardId ?? '').trim()
  if (bound) return bound
  const allowed = [
    ...new Set(
      (principal?.boards ?? [])
        .map((boardId) => String(boardId).trim())
        .filter(Boolean),
    ),
  ]
  return allowed.length === 1 ? allowed[0]! : ''
}

export function buildCp0CapabilitiesReadback(input: {
  principal: { role?: string } | null | undefined
  capabilities: ReadonlyArray<string>
  pin: Cp0MetadataPin & { generatedAt: string; stale: boolean }
}) {
  return {
    ok: true,
    authenticated: input.principal != null,
    role: input.principal?.role ?? null,
    capabilities: [...input.capabilities],
    boardRev: input.pin.boardRev,
    lifecycleRev: input.pin.lifecycleRev,
    canonicalHash: input.pin.canonicalHash,
    observedAt: input.pin.generatedAt,
    stale: input.pin.stale,
  }
}
