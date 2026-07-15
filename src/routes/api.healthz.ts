/**
 * Authenticated /api/healthz route (AC-OPS-01 / R5-05).
 * Installs session/bearer auth guard + accurate release/schema/migration/
 * canonical snapshot / boardRev / lifecycleRev / dependency probes.
 * Unknown is explicit (null / UNKNOWN / dependency unknown) — never invented green.
 * Missing auth → 401. Release/schema mismatch → unhealthy 503 (via health core).
 * Responses never include secrets or raw handler error messages.
 * Reuses rbac principal resolvers + health core.
 */
import { createFileRoute } from '@tanstack/react-router'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  handleHealthz,
  healthzResultToResponse,
  type HealthAuthGuard,
  type HealthzDeps,
  type HealthExpected,
  type HealthObserved,
  type HealthzPayload,
  type MigrationHealthInfo,
  type DependencyHealth,
} from '#/server/health'
import { db, envVar } from '#/server/db'
import {
  extractBearerFromHeaders,
  principalFromSession,
  resolveBearerPrincipal,
} from '#/server/rbac'
import { sessionUser } from '#/server/auth-store'
import { SESSION_COOKIE } from '#/server/auth'
import { MIGRATION_MANIFEST, migrationStatus, type MigrationHistoryRow } from '#/server/migrations'
import {
  getSharedObservabilityIntegration,
  observationResultFromHttpStatus,
  resolveIncomingRequestId,
  withRequestIdResponse,
} from '#/server/observability-integration'
import {
  buildCp0SyncStatusReadback,
  type Cp0SyncStatusRow,
} from '#/server/cp0-sync-status'

function parseCookie(header: string | null, name: string): string | undefined {
  if (!header) return undefined
  for (const part of header.split(';')) {
    const [k, ...rest] = part.trim().split('=')
    if (k === name) return decodeURIComponent(rest.join('='))
  }
  return undefined
}

/** Stable unauthenticated failure — no secrets, no raw exception text. */
function authDenied(
  message: 'authentication required' | 'invalid bearer' | 'insufficient authority' = 'authentication required',
): { ok: false; status: number; code: string; message: string } {
  return {
    ok: false,
    status: 401,
    code: 'AUTHORIZATION_REQUIRED',
    message,
  }
}

/**
 * Health auth: bearer principal (MCP-style) OR session cookie human.
 * Unauthenticated / PUBLIC-only / invalid → 401 AUTHORIZATION_REQUIRED.
 * Requires real authority (non-PUBLIC bearer or mapped session principal).
 * Never logs credentials or token material; never echoes resolver errors.
 */
export async function healthzAuthGuard(request: Request): Promise<
  | { ok: true; actor: { actorId: string; role: string } }
  | { ok: false; status: number; code: string; message: string }
> {
  try {
    const raw = extractBearerFromHeaders(request.headers)
    if (raw) {
      const { principal } = await resolveBearerPrincipal(raw, {
        envWriteToken: envVar('CAIRN_WRITE_TOKEN') ?? null,
        envBearerJson: envVar('CAIRN_BEARER_PRINCIPALS_JSON') ?? null,
      })
      // PUBLIC / null principal is not health authority
      if (principal && principal.role !== 'PUBLIC') {
        return { ok: true, actor: { actorId: principal.actorId, role: principal.role } }
      }
      return authDenied('invalid bearer')
    }

    const token = parseCookie(request.headers.get('cookie'), SESSION_COOKIE)
    if (token) {
      try {
        const user = await sessionUser(token)
        const principal = principalFromSession(user)
        // Session principal required; PUBLIC-mapped session is not health authority
        if (principal && principal.role !== 'PUBLIC') {
          return { ok: true, actor: { actorId: principal.actorId, role: principal.role } }
        }
        if (principal && principal.role === 'PUBLIC') {
          return authDenied('insufficient authority')
        }
      } catch {
        /* fail closed — no cookie/token/error text in path */
        return authDenied('invalid bearer')
      }
    }

    return authDenied('authentication required')
  } catch {
    // Never echo raw resolver failures
    return authDenied('authentication required')
  }
}

/** Full git SHA from env (deploy) or local .git HEAD. Empty string = unknown (never invent). */
function readLocalSha(): string {
  const fromEnv = envVar('CAIRN_DEPLOYED_SHA') || envVar('CAIRN_EXPECTED_SHA')
  if (fromEnv && fromEnv.trim()) return fromEnv.trim()
  try {
    const head = readFileSync(join(process.cwd(), '.git/HEAD'), 'utf8').trim()
    if (head.startsWith('ref:')) {
      const ref = head.slice(4).trim()
      return readFileSync(join(process.cwd(), '.git', ref), 'utf8').trim()
    }
    return head
  } catch {
    return ''
  }
}

/** Latest version declared by the migration manifest (e.g. "005"). Empty if unreadable. */
function manifestLatestVersion(): string {
  try {
    const last = MIGRATION_MANIFEST[MIGRATION_MANIFEST.length - 1]
    return last?.version ?? ''
  } catch {
    return ''
  }
}

/**
 * Required CREATE TABLE objects introduced by migrations 004/005/006.
 * History claiming these versions is not healthy if the tables are absent
 * (partial apply / drift). ALTER-only expands are not listed here.
 * Exported for unit tests (table-probe contract).
 */
export const REQUIRED_TABLES_BY_MIGRATION: Readonly<Record<string, ReadonlyArray<string>>> = {
  '004': [
    'control_plane_classification_receipts',
    'control_plane_decisions',
  ],
  '005': [
    'control_plane_dispatch_plans',
    'control_plane_runs',
    'control_plane_collision_locks',
  ],
  '006': ['control_plane_stage_evidence_receipts'],
  '007': ['globals'],
  '008': [
    'control_plane_spawn_budgets',
    'control_plane_control_acks',
    'control_plane_account_probes',
    'control_plane_sync_status',
  ],
}

/** Tables required given applied migration versions (004/005/006 probes). */
export function requiredTablesForAppliedVersions(
  appliedVersions: ReadonlyArray<string>,
): Array<string> {
  const out: Array<string> = []
  const seen = new Set<string>()
  for (const v of appliedVersions) {
    const tables = REQUIRED_TABLES_BY_MIGRATION[v]
    if (!tables) continue
    for (const t of tables) {
      if (seen.has(t)) continue
      seen.add(t)
      out.push(t)
    }
  }
  return out
}

/**
 * Probe existence of required tables. Returns missing names (empty = all present).
 * Uses SELECT 1 LIMIT 0 — fails closed on missing/unreadable tables.
 */
async function probeRequiredTables(
  tables: ReadonlyArray<string>,
): Promise<Array<string>> {
  const missing: Array<string> = []
  for (const table of tables) {
    // Identifier from static allow-list only — never interpolate user input.
    if (!/^[a-z0-9_]+$/i.test(table)) {
      missing.push(table)
      continue
    }
    try {
      await db().query(`SELECT 1 AS ok FROM \`${table}\` LIMIT 0`)
    } catch {
      missing.push(table)
    }
  }
  return missing
}

/**
 * Expected release/schema for this process.
 * Prefer explicit deploy env; otherwise local SHA + manifest latest.
 * Empty values stay empty so health core treats them as mismatch (never green).
 */
function loadExpected(): HealthExpected {
  const sha = (envVar('CAIRN_EXPECTED_SHA') || envVar('CAIRN_DEPLOYED_SHA') || readLocalSha()).trim()
  const schemaVersion = (envVar('CAIRN_SCHEMA_VERSION') || manifestLatestVersion()).trim()
  return { deployedSha: sha, schemaVersion }
}

function parseAppliedEnv(): Array<string> {
  const appliedRaw = envVar('CAIRN_MIGRATION_APPLIED')
  if (!appliedRaw) return []
  return appliedRaw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

function versionOnlyMigrationStatus(
  appliedVersions: ReadonlyArray<string>,
  expectedLatest: string,
): MigrationHealthInfo['status'] {
  if (appliedVersions.length === 0) return 'UNKNOWN'
  if (!expectedLatest) return 'UNKNOWN'
  const latest = appliedVersions[appliedVersions.length - 1]!
  return latest === expectedLatest ? 'READY' : 'PENDING'
}

/** Revision pin row as loaded from board_revisions (nullable fields explicit). */
export type HealthzRevisionPinRow = {
  boardRev: number | null
  lifecycleRev: number | null
  canonicalSnapshotId: string | null
  subjectHash: string | null
}

/** Snapshot row candidate for pin fill (latest or id-scoped). */
export type HealthzSnapshotPinRow = {
  snapshotId: string
  payloadSha256: string | null
  boardRev: number | null
  lifecycleRev: number | null
}

/**
 * Resolve the board represented by the process-wide health endpoint.
 * Explicit health configuration wins, then the board binding already required
 * by the legacy write token. Database discovery is safe only when exactly one
 * board exists; multi-board ambiguity fails closed instead of selecting the
 * oldest unrelated board.
 */
export function resolveHealthBoardId(args: {
  configuredBoardId?: string | null
  writeTokenBoardId?: string | null
  discoveredBoardIds?: ReadonlyArray<string>
}): string {
  const configured = String(args.configuredBoardId ?? '').trim()
  if (configured) return configured
  const tokenBound = String(args.writeTokenBoardId ?? '').trim()
  if (tokenBound) return tokenBound
  const discovered = [...new Set(
    (args.discoveredBoardIds ?? []).map((id) => String(id).trim()).filter(Boolean),
  )]
  return discovered.length === 1 ? discovered[0]! : ''
}

/**
 * H2 security: resolve healthz pin after board_revisions + optional snapshot queries.
 *
 * Rules:
 * - When revision has a non-null canonical_snapshot_id, never take "latest" snapshot;
 *   hash may be filled only from the id-scoped snapshot row (pinnedSnapHash).
 * - When revision lacks snapshot id but has finite board/lifecycle revs: only accept
 *   latestSnap when snap.board_rev AND snap.lifecycle_rev exactly equal revision revs.
 *   Otherwise leave id (and hash, unless already from subject_hash) null — fail-closed.
 * - Never overwrite a non-null subject_hash with a different snapshot's payload_sha256.
 * - When no finite revs on revision (or no revision): latest snap may supply id/hash/revs.
 */
export function resolveHealthzSnapshotPin(args: {
  revision: HealthzRevisionPinRow | null
  /** Latest control_plane_snapshots row for board (ORDER BY generated_at DESC LIMIT 1). */
  latestSnap: HealthzSnapshotPinRow | null
  /**
   * payload_sha256 from id-scoped lookup when revision already has canonical_snapshot_id
   * but null subject_hash. null = missing row / empty / not queried.
   */
  pinnedSnapHash?: string | null
}): {
  boardRev: number | null
  lifecycleRev: number | null
  canonicalSnapshotId: string | null
  canonicalHash: string | null
} {
  const rev = args.revision
  let boardRev = rev?.boardRev ?? null
  let lifecycleRev = rev?.lifecycleRev ?? null
  let canonicalSnapshotId = rev?.canonicalSnapshotId ?? null
  let canonicalHash = rev?.subjectHash ?? null

  // Id present: never mix with latest; only fill hash from the pinned snapshot row.
  if (canonicalSnapshotId) {
    if (canonicalHash == null && args.pinnedSnapHash) {
      canonicalHash = args.pinnedSnapHash
    }
    return { boardRev, lifecycleRev, canonicalSnapshotId, canonicalHash }
  }

  // No snapshot id on revision — candidate is latest snap only.
  const snap = args.latestSnap
  if (!snap) {
    // Missing row: leave id null; keep subject_hash/revs if any (fail-closed incomplete pin).
    return { boardRev, lifecycleRev, canonicalSnapshotId: null, canonicalHash }
  }

  const hasFiniteRev = boardRev != null || lifecycleRev != null
  if (hasFiniteRev) {
    // Exact match required on both board_rev and lifecycle_rev — no partial mix.
    const revsMatch = boardRev === snap.boardRev && lifecycleRev === snap.lifecycleRev
    if (!revsMatch) {
      // Old rev vs newer latest snap (or any mismatch) → do not emit mixed pin.
      return { boardRev, lifecycleRev, canonicalSnapshotId: null, canonicalHash }
    }
  }

  // Accept latest snap for id; never overwrite non-null subject_hash.
  canonicalSnapshotId = snap.snapshotId
  if (canonicalHash == null && snap.payloadSha256) {
    canonicalHash = snap.payloadSha256
  }
  if (boardRev == null) {
    boardRev = snap.boardRev
  }
  if (lifecycleRev == null) {
    lifecycleRev = snap.lifecycleRev
  }
  return { boardRev, lifecycleRev, canonicalSnapshotId, canonicalHash }
}

/**
 * Observed local health.
 * Probes MySQL, schema_migrations, board_revisions / control_plane_snapshots when present.
 * Never invents boardRev=0 / lifecycleRev=0 / READY / dependency up without evidence.
 */
async function loadObserved(): Promise<HealthObserved> {
  const sha = readLocalSha()
  const expectedLatest =
    (envVar('CAIRN_MIGRATION_LATEST') || envVar('CAIRN_SCHEMA_VERSION') || manifestLatestVersion()).trim()

  let schemaVersion = ''
  let appliedVersions: Array<string> = parseAppliedEnv()
  let migStatus: MigrationHealthInfo['status'] = versionOnlyMigrationStatus(
    appliedVersions,
    expectedLatest,
  )
  if (appliedVersions.length > 0) {
    schemaVersion = appliedVersions[appliedVersions.length - 1]!
  }

  let boardRev: number | null = null
  let lifecycleRev: number | null = null
  let canonicalSnapshotId: string | null = null
  let canonicalHash: string | null = null

  let dbStatus: DependencyHealth['status'] = 'unknown'
  let controlPlaneStatus: DependencyHealth['status'] = 'unknown'
  let requiredTablesStatus: DependencyHealth['status'] = 'unknown'
  let missingRequiredTables: Array<string> = []
  let syncStatus: HealthObserved['sync'] = {
    status: 'UNKNOWN',
    effectiveBacklog: null,
    zeroBacklogProven: false,
    freshnessAt: null,
  }

  try {
    // Bounded connectivity probe — no credentials in result.
    await db().query('SELECT 1 AS ok')
    dbStatus = 'up'

    // schema_migrations (accurate applied list + checksum plan when rows present)
    try {
      const [rows] = await db().query(
        'SELECT version, filename, sha256, classification FROM schema_migrations ORDER BY version ASC',
      )
      const history = (rows as Array<{
        version: string
        filename: string
        sha256: string
        classification: string
      }>).map(
        (r): MigrationHistoryRow => ({
          version: String(r.version),
          filename: String(r.filename ?? ''),
          sha256: String(r.sha256 ?? ''),
          classification: String(r.classification ?? ''),
        }),
      )
      if (history.length > 0) {
        appliedVersions = history.map((h) => h.version)
        schemaVersion = appliedVersions[appliedVersions.length - 1] ?? ''
        const hasChecksums = history.every((h) => h.sha256 && h.sha256.length === 64)
        if (hasChecksums) {
          try {
            const plan = migrationStatus({ applied: history })
            migStatus = plan.status
          } catch {
            migStatus = versionOnlyMigrationStatus(appliedVersions, expectedLatest)
          }
        } else {
          migStatus = versionOnlyMigrationStatus(appliedVersions, expectedLatest)
        }
      } else if (appliedVersions.length === 0) {
        // Table exists but empty — applied history unknown/unproven
        migStatus = 'UNKNOWN'
        schemaVersion = ''
      }
    } catch {
      // Table missing or unreadable — keep env-derived applied if any, else UNKNOWN
      if (appliedVersions.length === 0) {
        migStatus = 'UNKNOWN'
        schemaVersion = ''
      }
    }

    // Required tables for applied 004/005/006 (history alone is not sufficient proof)
    const requiredTables = requiredTablesForAppliedVersions(appliedVersions)
    if (requiredTables.length > 0) {
      missingRequiredTables = await probeRequiredTables(requiredTables)
      if (missingRequiredTables.length > 0) {
        // Drift: history claims 004/005/006 but CREATE TABLE objects absent.
        // Clear observed schema so evaluateHealthStatus marks SCHEMA_VERSION_MISMATCH
        // (unhealthy). Dependency lists missing table names for operators.
        requiredTablesStatus = 'down'
        schemaVersion = ''
        migStatus = 'PENDING'
      } else {
        requiredTablesStatus = 'up'
      }
    } else if (appliedVersions.length > 0) {
      // Applied history does not yet include 004/005/006 — no table probe needed.
      requiredTablesStatus = 'up'
    }

    // board_revisions + optional latest snapshot (explicit null when absent)
    let boardId = resolveHealthBoardId({
      configuredBoardId: envVar('CAIRN_HEALTH_BOARD_ID'),
      writeTokenBoardId: envVar('CAIRN_WRITE_TOKEN_BOARD_ID'),
    })
    if (!boardId) {
      try {
        const [boards] = await db().query('SELECT id FROM boards ORDER BY created_at ASC LIMIT 2')
        boardId = resolveHealthBoardId({
          discoveredBoardIds: (boards as Array<{ id: string }>).map((board) => String(board.id)),
        })
      } catch {
        boardId = ''
      }
    }

    if (boardId) {
      let revisionPin: HealthzRevisionPinRow | null = null
      try {
        const [revRows] = await db().query(
          'SELECT board_rev, lifecycle_rev, canonical_snapshot_id, subject_hash FROM board_revisions WHERE board_id=? LIMIT 1',
          [boardId],
        )
        const rev = (revRows as Array<{
          board_rev: number | string
          lifecycle_rev: number | string
          canonical_snapshot_id: string | null
          subject_hash: string | null
        }>)[0]
        if (rev) {
          const br = Number(rev.board_rev)
          const lr = Number(rev.lifecycle_rev)
          revisionPin = {
            boardRev: Number.isFinite(br) ? br : null,
            lifecycleRev: Number.isFinite(lr) ? lr : null,
            canonicalSnapshotId: rev.canonical_snapshot_id ? String(rev.canonical_snapshot_id) : null,
            subjectHash: rev.subject_hash ? String(rev.subject_hash) : null,
          }
          controlPlaneStatus = 'up'
        } else {
          // Control-plane revision table reachable but no pin for board — explicit unknown revs
          revisionPin = null
          controlPlaneStatus = 'degraded'
        }
      } catch {
        // board_revisions missing → control plane not proven
        controlPlaneStatus = 'unknown'
        revisionPin = null
      }

      // H2: fill snapshot id/hash without mixing revs across pins.
      // - No canonical_snapshot_id → latest snap only when revs match (or revs unproven).
      // - Has canonical_snapshot_id but empty subject_hash → id-scoped payload_sha256 only.
      // - Never overwrite non-null subject_hash; mismatch / missing row → leave id/hash null.
      let latestSnap: HealthzSnapshotPinRow | null = null
      let pinnedSnapHash: string | null = null
      const revSnapshotId = revisionPin?.canonicalSnapshotId ?? null
      if (!revSnapshotId) {
        try {
          const [snapRows] = await db().query(
            `SELECT snapshot_id, payload_sha256, board_rev, lifecycle_rev
             FROM control_plane_snapshots
             WHERE board_id=?
             ORDER BY generated_at DESC
             LIMIT 1`,
            [boardId],
          )
          const snap = (snapRows as Array<{
            snapshot_id: string
            payload_sha256: string | null
            board_rev: number | string
            lifecycle_rev: number | string
          }>)[0]
          if (snap) {
            const sbr = Number(snap.board_rev)
            const slr = Number(snap.lifecycle_rev)
            latestSnap = {
              snapshotId: String(snap.snapshot_id),
              payloadSha256: snap.payload_sha256 ? String(snap.payload_sha256) : null,
              boardRev: Number.isFinite(sbr) ? sbr : null,
              lifecycleRev: Number.isFinite(slr) ? slr : null,
            }
            if (controlPlaneStatus === 'unknown') controlPlaneStatus = 'up'
          }
        } catch {
          /* snapshot table absent — leave null/unknown */
        }
      } else if (!(revisionPin?.subjectHash)) {
        try {
          const [snapRows] = await db().query(
            `SELECT payload_sha256
             FROM control_plane_snapshots
             WHERE board_id=? AND snapshot_id=?
             LIMIT 1`,
            [boardId, revSnapshotId],
          )
          const snap = (snapRows as Array<{ payload_sha256: string | null }>)[0]
          if (snap?.payload_sha256) {
            pinnedSnapHash = String(snap.payload_sha256)
          }
          // no matching row / empty hash → leave null (fail-closed incomplete pin)
        } catch {
          /* snapshot table absent — leave hash null */
        }
      }

      const pin = resolveHealthzSnapshotPin({
        revision: revisionPin,
        latestSnap,
        pinnedSnapHash,
      })
      boardRev = pin.boardRev
      lifecycleRev = pin.lifecycleRev
      canonicalSnapshotId = pin.canonicalSnapshotId
      canonicalHash = pin.canonicalHash
      try {
        const [syncRows] = await db().query(
          `SELECT status, outbox_pending, legacy_unreplayed, effective_backlog,
                  board_rev, lifecycle_rev, canonical_hash, last_ack_revision,
                  freshness_at, entity_rev
           FROM control_plane_sync_status WHERE board_id=? LIMIT 1`,
          [boardId],
        )
        const sync = (syncRows as Array<Cp0SyncStatusRow>)[0] ?? null
        if (sync) {
          const readback = buildCp0SyncStatusReadback(
            sync,
            {
              boardRev: boardRev ?? -1,
              lifecycleRev: lifecycleRev ?? -1,
              canonicalHash: canonicalHash ?? '',
            },
          )
          syncStatus = {
            status: readback.status,
            effectiveBacklog: readback.effectiveBacklog,
            zeroBacklogProven: readback.zeroBacklogProven,
            freshnessAt: readback.observedAt,
          }
        }
      } catch {
        /* schema 007 app-only compatibility: sync stays explicit UNKNOWN */
      }
    } else {
      // No board id — cannot assert control-plane pin identity
      controlPlaneStatus = 'unknown'
    }
  } catch {
    dbStatus = 'down'
    // Connectivity failed: control-plane pin cannot be proven — force explicit unknown.
    controlPlaneStatus = 'unknown'
    // When DB is down we cannot prove applied state unless env provided it.
    if (parseAppliedEnv().length === 0) {
      migStatus = 'UNKNOWN'
      schemaVersion = ''
      appliedVersions = []
    }
  }

  // Never invent green: when applied history is unproven, keep schemaVersion empty
  // and migration.status UNKNOWN — do not copy expectedLatest into observed fields.
  const observedSchemaVersion = schemaVersion
  const migrationSchemaVersion = schemaVersion // no expectedLatest fallback (would invent match-looking data)

  const dependencies: Array<DependencyHealth> = [
    { name: 'mysql', status: dbStatus }, // up only after SELECT 1; else down/unknown
    { name: 'control-plane', status: controlPlaneStatus }, // up only with proven pin row
  ]
  // Surface 004/005/006 required-table probe when we attempted it (or DB was up enough to classify).
  if (requiredTablesStatus !== 'unknown' || missingRequiredTables.length > 0) {
    dependencies.push({
      name: 'schema-required-tables',
      status: requiredTablesStatus === 'down' ? 'down' : requiredTablesStatus,
      detail:
        missingRequiredTables.length > 0
          ? `missing:${missingRequiredTables.join(',')}`
          : null,
    })
  }

  return {
    deployedSha: sha, // empty string when unknown — health core marks RELEASE_SHA_MISMATCH
    schemaVersion: observedSchemaVersion,
    migration: {
      status: migStatus,
      appliedVersions,
      expectedLatestVersion: expectedLatest || null,
      schemaVersion: migrationSchemaVersion,
    },
    snapshot: {
      canonicalSnapshotId, // null when unproven
      boardRev, // null when unproven — never invent 0
      lifecycleRev, // null when unproven — never invent 0
      canonicalHash, // null when unproven
    },
    dependencies,
    serviceName: 'cairn-task-manager',
    sync: syncStatus,
  }
}

/** Mutable deps slot for tests. Default: real auth guard + loaders installed. */
let healthzDeps: HealthzDeps = {
  authGuard: healthzAuthGuard as HealthAuthGuard,
  loadExpected,
  loadObserved,
}

/** Inject dependencies (tests). */
export function setHealthzDeps(deps: HealthzDeps): void {
  healthzDeps = deps
}

export function getHealthzDeps(): HealthzDeps {
  return healthzDeps
}

/** Stable fail-closed body when the handler itself throws (never raw Error.message). */
function healthUnavailableResponse(): Response {
  return new Response(
    JSON.stringify({
      error: 'health check failed',
      code: 'HEALTH_UNAVAILABLE',
    }),
    {
      status: 503,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
      },
    },
  )
}

export async function healthzGetHandler(request: Request): Promise<Response> {
  const requestId = resolveIncomingRequestId(request)
  const obs = getSharedObservabilityIntegration()
  const startedAt = Date.now()
  try {
    const result = await handleHealthz(request, healthzDeps)
    const payload = result.payload as HealthzPayload | { error: string; code: string }
    const isHealth = payload && typeof payload === 'object' && 'boardRev' in payload
    const healthPayload = isHealth ? (payload as HealthzPayload) : null
    const errorCode =
      !isHealth && payload && typeof payload === 'object' && 'code' in payload
        ? String((payload as { code: string }).code)
        : healthPayload?.status === 'unhealthy'
          ? (healthPayload.unhealthyReasons[0] ?? 'UNHEALTHY')
          : null
    const obsResult = observationResultFromHttpStatus(result.status)
    const latencyMs = Math.max(0, Date.now() - startedAt)
    // Safe release/schema alert evaluation (AC-OPS-03). Never throws into response path.
    // Only when authenticated health body is present — auth denials do not invent match signals.
    if (healthPayload) {
      try {
        obs.evaluateAlerts({
          nowIso: healthPayload.checkedAt || new Date().toISOString(),
          releaseMatch: healthPayload.release.match,
          schemaMatch: healthPayload.schema.match,
        })
      } catch {
        /* alert path must never fail healthz */
      }
    }
    obs
      .beginRequest({
        requestId,
        endpoint: '/api/healthz',
        method: 'GET',
        channel: 'http',
        boardRev: healthPayload?.boardRev ?? null,
        lifecycleRev: healthPayload?.lifecycleRev ?? null,
        actorRole: null,
        actorId: null,
        meta: {
          route: 'healthz',
          httpStatus: result.status,
          ...(healthPayload
            ? {
                healthStatus: healthPayload.status,
                releaseMatch: healthPayload.release.match,
                schemaMatch: healthPayload.schema.match,
                // Presence flag only — not the full hash (redaction defense)
                hasCanonicalHash: Boolean(healthPayload.canonicalHash),
              }
            : {}),
        },
      })
      .end({ result: obsResult, errorCode, latencyMs })
    return withRequestIdResponse(healthzResultToResponse(result), requestId)
  } catch {
    const latencyMs = Math.max(0, Date.now() - startedAt)
    obs
      .beginRequest({
        requestId,
        endpoint: '/api/healthz',
        method: 'GET',
        channel: 'http',
        meta: { route: 'healthz' },
      })
      .end({ result: 'error', errorCode: 'HEALTH_UNAVAILABLE', latencyMs })
    // Never echo raw handler errors / stacks / secret-bearing messages
    return withRequestIdResponse(healthUnavailableResponse(), requestId)
  }
}

export const Route = createFileRoute('/api/healthz')({
  server: {
    handlers: {
      GET: ({ request }) => healthzGetHandler(request),
    },
  },
})
