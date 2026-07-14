/**
 * Authenticated /healthz core handler (AC-OPS-01).
 * Returns service/deployed full SHA/schema/migration/canonical snapshot/
 * board+lifecycle revision/dependency health.
 * Fails unhealthy on release/schema mismatch.
 * Route must not leak secrets.
 * Auth enforcement is C2A — this module exposes a guard hook and defaults
 * fail-closed if the guard is absent.
 */

export const HEALTHZ_SCHEMA = 'MFS_HEALTHZ_V1' as const

export type HealthServiceStatus = 'ok' | 'degraded' | 'unhealthy'

export interface HealthAuthActor {
  actorId: string
  role: string
}

export type HealthAuthGuardResult =
  | { ok: true; actor?: HealthAuthActor }
  | { ok: false; status: number; code: string; message: string }

/**
 * Auth guard hook. C2A wires real session/token checks.
 * If absent (null/undefined), handler fails closed with 401.
 */
export type HealthAuthGuard = (request: Request) => Promise<HealthAuthGuardResult> | HealthAuthGuardResult

export interface DependencyHealth {
  name: string
  status: 'up' | 'down' | 'degraded' | 'unknown'
  detail?: string | null
}

export interface HealthSnapshotInfo {
  canonicalSnapshotId: string | null
  boardRev: number | null
  lifecycleRev: number | null
  /** Subject/payload hash for the pinned observation; null when unproven (never invent). */
  canonicalHash: string | null
}

export interface MigrationHealthInfo {
  status: 'READY' | 'IDEMPOTENT_NOOP' | 'BLOCKED' | 'CHECKSUM_MISMATCH' | 'UNKNOWN' | 'PENDING'
  appliedVersions: ReadonlyArray<string>
  expectedLatestVersion: string | null
  schemaVersion: string
}

export interface HealthExpected {
  /** Full deployed git SHA expected for this release. */
  deployedSha: string
  /** Schema / migration marker expected. */
  schemaVersion: string
}

export interface HealthObserved {
  deployedSha: string
  schemaVersion: string
  migration: MigrationHealthInfo
  snapshot: HealthSnapshotInfo
  dependencies: ReadonlyArray<DependencyHealth>
  serviceName?: string
}

export interface HealthzPayload {
  schemaVersion: typeof HEALTHZ_SCHEMA
  status: HealthServiceStatus
  service: string
  deployedSha: string
  schema: {
    version: string
    match: boolean
  }
  release: {
    sha: string
    match: boolean
  }
  migration: {
    status: MigrationHealthInfo['status']
    appliedVersions: Array<string>
    expectedLatestVersion: string | null
    schemaVersion: string
  }
  canonicalSnapshotId: string | null
  /**
   * Live pin hash for STAGING_BIND_LIVE_PIN / extractCompleteLivePin.
   * Same pinned observation as board_revisions.subject_hash or
   * control_plane_snapshots.payload_sha256 — null when unproven.
   */
  canonicalHash: string | null
  boardRev: number | null
  lifecycleRev: number | null
  dependencies: Array<{
    name: string
    status: DependencyHealth['status']
  }>
  unhealthyReasons: Array<string>
  checkedAt: string
}

export interface HealthzHandlerResult {
  status: number
  payload: HealthzPayload | { error: string; code: string }
  headers: Record<string, string>
}

const SECRET_KEY_RE =
  /password|token|secret|authorization|cookie|api[_-]?key|private|credential/i

/** Strip any secret-like keys from a plain object (defense in depth for health body). */
export function stripSecretsFromHealth(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(stripSecretsFromHealth)
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (SECRET_KEY_RE.test(k)) continue
    out[k] = stripSecretsFromHealth(v)
  }
  return out
}

export function evaluateHealthStatus(
  expected: HealthExpected,
  observed: HealthObserved,
): { status: HealthServiceStatus; unhealthyReasons: Array<string>; releaseMatch: boolean; schemaMatch: boolean } {
  const reasons: Array<string> = []
  const releaseMatch =
    Boolean(expected.deployedSha) &&
    Boolean(observed.deployedSha) &&
    expected.deployedSha.toLowerCase() === observed.deployedSha.toLowerCase()
  const schemaMatch =
    Boolean(expected.schemaVersion) &&
    Boolean(observed.schemaVersion) &&
    expected.schemaVersion === observed.schemaVersion

  if (!releaseMatch) {
    reasons.push('RELEASE_SHA_MISMATCH')
  }
  if (!schemaMatch) {
    reasons.push('SCHEMA_VERSION_MISMATCH')
  }
  if (
    observed.migration.status === 'BLOCKED' ||
    observed.migration.status === 'CHECKSUM_MISMATCH'
  ) {
    reasons.push(`MIGRATION_${observed.migration.status}`)
  }
  for (const d of observed.dependencies) {
    if (d.status === 'down') {
      reasons.push(`DEPENDENCY_DOWN:${d.name}`)
    }
  }

  let status: HealthServiceStatus = 'ok'
  if (reasons.some((r) => r === 'RELEASE_SHA_MISMATCH' || r === 'SCHEMA_VERSION_MISMATCH')) {
    status = 'unhealthy'
  } else if (reasons.length > 0) {
    status = 'degraded'
  } else if (observed.dependencies.some((d) => d.status === 'degraded')) {
    status = 'degraded'
  }

  return { status, unhealthyReasons: reasons, releaseMatch, schemaMatch }
}

export function buildHealthzPayload(
  expected: HealthExpected,
  observed: HealthObserved,
  checkedAt: string,
): HealthzPayload {
  const evaled = evaluateHealthStatus(expected, observed)
  const payload: HealthzPayload = {
    schemaVersion: HEALTHZ_SCHEMA,
    status: evaled.status,
    service: observed.serviceName ?? 'cairn-task-manager',
    deployedSha: observed.deployedSha,
    schema: {
      version: observed.schemaVersion,
      match: evaled.schemaMatch,
    },
    release: {
      sha: observed.deployedSha,
      match: evaled.releaseMatch,
    },
    migration: {
      status: observed.migration.status,
      appliedVersions: [...observed.migration.appliedVersions],
      expectedLatestVersion: observed.migration.expectedLatestVersion,
      schemaVersion: observed.migration.schemaVersion,
    },
    canonicalSnapshotId: observed.snapshot.canonicalSnapshotId,
    // Surface hash from the same pinned observation as boardRev/lifecycleRev/snapshotId.
    // Smoke STAGING_BIND_LIVE_PIN requires this top-level field (probeRuntimePin).
    canonicalHash:
      observed.snapshot.canonicalHash === undefined
        ? null
        : observed.snapshot.canonicalHash,
    boardRev: observed.snapshot.boardRev,
    lifecycleRev: observed.snapshot.lifecycleRev,
    dependencies: observed.dependencies.map((d) => ({
      name: d.name,
      status: d.status,
    })),
    unhealthyReasons: evaled.unhealthyReasons,
    checkedAt,
  }
  return stripSecretsFromHealth(payload) as HealthzPayload
}

export interface HealthzDeps {
  /**
   * Auth guard. REQUIRED for success path.
   * If omitted/undefined → fail-closed 401 AUTHORIZATION_REQUIRED.
   */
  authGuard?: HealthAuthGuard | null
  loadExpected: () => Promise<HealthExpected> | HealthExpected
  loadObserved: () => Promise<HealthObserved> | HealthObserved
  nowIso?: () => string
}

/**
 * Core healthz handler. Injectable. No secrets in body.
 * HTTP: 200 when status ok|degraded (authenticated), 503 when unhealthy,
 * 401 when guard absent or denies.
 */
export async function handleHealthz(
  request: Request,
  deps: HealthzDeps,
): Promise<HealthzHandlerResult> {
  const headers = {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  }

  // Fail-closed if guard hook is not wired (C2A owns real auth).
  if (deps.authGuard == null) {
    return {
      status: 401,
      payload: {
        error: 'authentication required',
        code: 'AUTHORIZATION_REQUIRED',
      },
      headers,
    }
  }

  const auth = await deps.authGuard(request)
  if (!auth.ok) {
    return {
      status: auth.status || 401,
      payload: {
        error: auth.message || 'unauthorized',
        code: auth.code || 'AUTHORIZATION_REQUIRED',
      },
      headers,
    }
  }

  try {
    const expected = await deps.loadExpected()
    const observed = await deps.loadObserved()
    const checkedAt = deps.nowIso ? deps.nowIso() : new Date().toISOString()
    const payload = buildHealthzPayload(expected, observed, checkedAt)
    const httpStatus = payload.status === 'unhealthy' ? 503 : 200
    return { status: httpStatus, payload, headers }
  } catch {
    // Fail-closed: do not leak error internals / secrets.
    return {
      status: 503,
      payload: {
        error: 'health check failed',
        code: 'HEALTH_UNAVAILABLE',
      },
      headers,
    }
  }
}

export function healthzResultToResponse(result: HealthzHandlerResult): Response {
  return new Response(JSON.stringify(result.payload), {
    status: result.status,
    headers: result.headers,
  })
}

/** Test helper: always-allow guard. */
export function allowAllHealthGuard(actor?: HealthAuthActor): HealthAuthGuard {
  return async () => ({ ok: true, actor: actor ?? { actorId: 'test', role: 'OWNER' } })
}

/** Test helper: always-deny guard. */
export function denyAllHealthGuard(
  status = 401,
  code = 'AUTHORIZATION_REQUIRED',
  message = 'unauthorized',
): HealthAuthGuard {
  return async () => ({ ok: false, status, code, message })
}
