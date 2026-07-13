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
    const preferredBoard = (envVar('CAIRN_HEALTH_BOARD_ID') || '').trim()
    let boardId = preferredBoard
    if (!boardId) {
      try {
        const [boards] = await db().query('SELECT id FROM boards ORDER BY created_at ASC LIMIT 1')
        const first = (boards as Array<{ id: string }>)[0]
        boardId = first?.id ? String(first.id) : ''
      } catch {
        boardId = ''
      }
    }

    if (boardId) {
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
          boardRev = Number.isFinite(br) ? br : null
          lifecycleRev = Number.isFinite(lr) ? lr : null
          canonicalSnapshotId = rev.canonical_snapshot_id ? String(rev.canonical_snapshot_id) : null
          canonicalHash = rev.subject_hash ? String(rev.subject_hash) : null
          controlPlaneStatus = 'up'
        } else {
          // Control-plane revision table reachable but no pin for board — explicit unknown revs
          boardRev = null
          lifecycleRev = null
          controlPlaneStatus = 'degraded'
        }
      } catch {
        // board_revisions missing → control plane not proven
        controlPlaneStatus = 'unknown'
        boardRev = null
        lifecycleRev = null
      }

      // Fill snapshot id from registry when revision row lacks it
      if (!canonicalSnapshotId) {
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
            payload_sha256: string
            board_rev: number | string
            lifecycle_rev: number | string
          }>)[0]
          if (snap) {
            canonicalSnapshotId = String(snap.snapshot_id)
            canonicalHash = snap.payload_sha256 ? String(snap.payload_sha256) : canonicalHash
            if (boardRev == null) {
              const br = Number(snap.board_rev)
              boardRev = Number.isFinite(br) ? br : null
            }
            if (lifecycleRev == null) {
              const lr = Number(snap.lifecycle_rev)
              lifecycleRev = Number.isFinite(lr) ? lr : null
            }
            if (controlPlaneStatus === 'unknown') controlPlaneStatus = 'up'
          }
        } catch {
          /* snapshot table absent — leave null/unknown */
        }
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
  try {
    const result = await handleHealthz(request, healthzDeps)
    return healthzResultToResponse(result)
  } catch {
    // Never echo raw handler errors / stacks / secret-bearing messages
    return healthUnavailableResponse()
  }
}

export const Route = createFileRoute('/api/healthz')({
  server: {
    handlers: {
      GET: ({ request }) => healthzGetHandler(request),
    },
  },
})
