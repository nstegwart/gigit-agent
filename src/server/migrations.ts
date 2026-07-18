/**
 * Deterministic versioned migration manifest/runner for Control Plane V3.
 * Plan/dry-run by default. Apply is authority-gated (LOCAL|STAGING only).
 * Lifecycle enum mapping guard (AC-LIFE-02) is wired via evaluateLifecycleEnumMapping —
 * this module does not reimplement mapping rules.
 * Never auto-applies on import. No production connection from this module.
 */
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import {
  classifyDbHost,
  configuredDbHost,
  migrationApplyAllowed,
  type DbHostClass,
} from './db'
import {
  evaluateLifecycleEnumMapping,
  V3_LIFECYCLE_RAIL,
  type LifecycleApprovedPlanStep,
  type LifecycleMappingDecisionCode,
  type LifecycleMappingDocument,
  type LifecycleMappingRow,
  type LifecycleMappingBlockedPlan,
} from './lifecycle-store'

export type MigrationClassification =
  | 'REVERSIBLE'
  | 'EXPAND_CONTRACT_BACKWARD_COMPATIBLE'
  | 'FORWARD_FIX_ONLY'

export type MigrationMode = 'plan' | 'dry-run' | 'apply' | 'status'

/** Root Decision codes surfaced by the migration runner (guard codes + apply-missing). */
export type MigrationLifecycleMappingDecisionCode =
  | LifecycleMappingDecisionCode
  | 'DECISION_LIFECYCLE_MAPPING_REQUIRED'

/**
 * Deterministic mapping approval/block record attached to plan/apply output.
 * Built only by calling evaluateLifecycleEnumMapping (or the missing-evidence short-circuit).
 */
export interface MigrationLifecycleMappingResult {
  approved: boolean
  blockingDecisionRequired: boolean
  decisionCode: MigrationLifecycleMappingDecisionCode | null
  ambiguousStateIds: ReadonlyArray<string>
  reasons: ReadonlyArray<string>
  identityCount?: number
  renameCount?: number
  legacyOnlyCount?: number
  steps?: ReadonlyArray<LifecycleApprovedPlanStep>
  blockingRows?: LifecycleMappingBlockedPlan['blockingRows']
}

export interface MigrationEntry {
  version: string
  filename: string
  relativePath: string
  classification: MigrationClassification
  description: string
}

export interface MigrationManifestEntry extends MigrationEntry {
  sha256: string
  sql: string
  statements: Array<string>
}

export interface MigrationHistoryRow {
  version: string
  filename: string
  sha256: string
  classification: string
  appliedAt?: string
  dryRun?: boolean
}

export type MigrationPlanAction = 'APPLY' | 'SKIP_ALREADY_APPLIED' | 'CHECKSUM_MISMATCH' | 'BLOCKED'

export interface MigrationPlanItem {
  version: string
  filename: string
  classification: MigrationClassification
  expectedSha256: string
  action: MigrationPlanAction
  reason?: string
}

export interface MigrationPlanResult {
  mode: MigrationMode
  host: string
  hostClass: DbHostClass
  applyAllowed: boolean
  items: Array<MigrationPlanItem>
  orderedVersions: Array<string>
  status: 'READY' | 'IDEMPOTENT_NOOP' | 'BLOCKED' | 'CHECKSUM_MISMATCH'
  blockedReason?: string
  /**
   * Mapping guard program output.
   * - null: mapping not supplied and not required for this mode (plan/dry-run/status inspect)
   * - approved true: IDENTITY/RENAME/LEGACY_ONLY plan only
   * - approved false: blocking Decision code + exact ambiguous state IDs
   */
  mapping: MigrationLifecycleMappingResult | null
}

export interface MigrationApplyResult {
  ok: boolean
  applied: Array<string>
  skipped: Array<string>
  plan: MigrationPlanResult
  error?: string
  /** Same mapping record as plan.mapping (always set for apply path). */
  mapping?: MigrationLifecycleMappingResult | null
}

export interface BackfillIntegrityIssue {
  code:
    | 'DUPLICATE_FC_JOIN'
    | 'DUPLICATE_NODE_JOIN'
    | 'DUPLICATE_DEPENDENCY_JOIN'
    | 'CONFLICTING_OWNERSHIP'
    | 'DEPENDENCY_CYCLE'
    | 'STALE_DATA'
    | 'MISSING_PROOF'
  taskId?: string
  detail: string
}

export interface BackfillTaskRow {
  taskId: string
  featureContractId?: string | null
  nodeId?: string | null
  dependencies?: Array<string>
  ownerId?: string | null
  /** When false/undefined, task stays UNCLASSIFIED (never guessed PRODUCT). */
  classificationProofValid?: boolean
  taskClass?: 'PRODUCT' | 'CONTROL_PLANE' | 'UNCLASSIFIED'
  disposition?: 'ACTIVE' | 'HOLD' | 'EXCLUDE' | 'UNCLASSIFIED'
  stale?: boolean
}

export interface BackfillDryRunResult {
  ok: boolean
  wouldWrite: Array<{
    taskId: string
    taskClass: 'PRODUCT' | 'CONTROL_PLANE' | 'UNCLASSIFIED'
    disposition: 'ACTIVE' | 'HOLD' | 'EXCLUDE' | 'UNCLASSIFIED'
    reason: string
  }>
  issues: Array<BackfillIntegrityIssue>
  rejected: boolean
}

/** Injectable SQL executor — production wiring later; unit tests use fakes. Never required for plan. */
export interface MigrationSqlExecutor {
  query(sql: string, params?: Array<unknown>): Promise<unknown>
  listApplied?(): Promise<Array<MigrationHistoryRow>>
  recordApplied?(row: MigrationHistoryRow): Promise<void>
}

const MIGRATIONS_DIR_NAME = 'migrations'

/** Ordered, deterministic manifest (SHA computed from on-disk SQL). Starts at 000 baseline. */
export const MIGRATION_MANIFEST: ReadonlyArray<MigrationEntry> = [
  {
    version: '000',
    filename: '000_baseline_core.sql',
    relativePath: path.join(MIGRATIONS_DIR_NAME, '000_baseline_core.sql'),
    classification: 'REVERSIBLE',
    description:
      'Greenfield baseline core tables (boards/tasks/board_docs/audit_log + schema_migrations) before control-plane expand',
  },
  {
    version: '001',
    filename: '001_control_plane_expand.sql',
    relativePath: path.join(MIGRATIONS_DIR_NAME, '001_control_plane_expand.sql'),
    classification: 'REVERSIBLE',
    description: 'Expand control-plane tables/columns; defaults UNCLASSIFIED; revision/snapshot/idempotency/evidence/G5/run-plan',
  },
  {
    version: '002',
    filename: '002_control_plane_indexes.sql',
    relativePath: path.join(MIGRATIONS_DIR_NAME, '002_control_plane_indexes.sql'),
    classification: 'EXPAND_CONTRACT_BACKWARD_COMPATIBLE',
    description: 'Indexes/constraints for board isolation, revisions, cursor, idempotency',
  },
  {
    version: '003',
    filename: '003_control_plane_backfill.sql',
    relativePath: path.join(MIGRATIONS_DIR_NAME, '003_control_plane_backfill.sql'),
    classification: 'FORWARD_FIX_ONLY',
    description: 'Source-grounded backfill; missing proof remains UNCLASSIFIED; no PRODUCT guess',
  },
  {
    version: '004',
    filename: '004_control_data_persistence.sql',
    relativePath: path.join(MIGRATIONS_DIR_NAME, '004_control_data_persistence.sql'),
    classification: 'REVERSIBLE',
    description:
      'Control-data persistence expand: board revision/import pins, G5/classification/DecisionV3 payloads, receipt archive; additive columns/tables only',
  },
  {
    version: '005',
    filename: '005_control_plane_runtime_persistence.sql',
    relativePath: path.join(MIGRATIONS_DIR_NAME, '005_control_plane_runtime_persistence.sql'),
    classification: 'REVERSIBLE',
    description:
      'Control-plane runtime persistence: dispatch plans, V3 runs, locks, account sync, reconciler, retention; additive tables only',
  },
  {
    version: '006',
    filename: '006_stage_evidence_receipts.sql',
    relativePath: path.join(MIGRATIONS_DIR_NAME, '006_stage_evidence_receipts.sql'),
    classification: 'REVERSIBLE',
    description:
      'Immutable programmatic stage-evidence receipt registry (control_plane_stage_evidence_receipts); additive table only',
  },
  {
    version: '007',
    filename: '007_globals_table.sql',
    relativePath: path.join(MIGRATIONS_DIR_NAME, '007_globals_table.sql'),
    classification: 'REVERSIBLE',
    description:
      'Greenfield/DR gap fix: create globals key-value table (readGlobal/readConventions) if absent; no-op where it already exists',
  },
  {
    version: '008',
    filename: '008_cp0_control_plane.sql',
    relativePath: path.join(MIGRATIONS_DIR_NAME, '008_cp0_control_plane.sql'),
    classification: 'REVERSIBLE',
    description:
      'CP0 additive hierarchy budgets, versioned ACKs, masked account probes, and fail-closed sync status; production apply remains wrapper-authority gated',
  },
  {
    version: '009',
    filename: '009_rebuild_lineage.sql',
    relativePath: path.join(MIGRATIONS_DIR_NAME, '009_rebuild_lineage.sql'),
    classification: 'REVERSIBLE',
    description:
      'Additive rebuild lineage layer: rebuild_lineage_records, parity_rollups, feature_units, feature_directory; no pin/lifecycle/classification table changes',
  },
  {
    version: '010',
    filename: '010_product_features.sql',
    relativePath: path.join(MIGRATIONS_DIR_NAME, '010_product_features.sql'),
    classification: 'REVERSIBLE',
    description:
      'Additive product-feature taxonomy FEAT-*: product_features + feature_task_map; no pin/lifecycle/classification table changes',
  },
  {
    version: '011',
    filename: '011_feature_flow_edges.sql',
    relativePath: path.join(MIGRATIONS_DIR_NAME, '011_feature_flow_edges.sql'),
    classification: 'REVERSIBLE',
    description:
      'Additive app-flow nav graph: app_flow_nodes + app_flow_edges; soft feature_id refs only; no pin/lifecycle/classification table changes',
  },
  {
    version: '012',
    filename: '012_ultimate_map.sql',
    relativePath: path.join(MIGRATIONS_DIR_NAME, '012_ultimate_map.sql'),
    classification: 'REVERSIBLE',
    description:
      'Additive ultimate map layer: app_pages, api_endpoints, page_api_calls, nav_edges, knowledge_aliases (+ idempotent 011 flow tables); no pin/lifecycle changes',
  },
  {
    version: '013',
    filename: '013_classification_task_id_case_sensitive.sql',
    relativePath: path.join(
      MIGRATIONS_DIR_NAME,
      '013_classification_task_id_case_sensitive.sql',
    ),
    classification: 'FORWARD_FIX_ONLY',
    description:
      'Case-sensitive classification task identity: utf8mb4_bin on control_plane_classification.task_id (PK) and receipts.task_id; no canonical ID rewrite; no complete-set/CAS weaken',
  },
] as const

export function sha256Hex(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex')
}

/** Split SQL file into executable statements; strips full-line `--` comments. */
export function splitSqlStatements(sql: string): Array<string> {
  const withoutBlock = sql.replace(/\/\*[\s\S]*?\*\//g, '')
  const lines = withoutBlock.split('\n').filter((line) => {
    const t = line.trim()
    return t.length > 0 && !t.startsWith('--')
  })
  const joined = lines.join('\n')
  return joined
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

export function resolveMigrationsRoot(cwd: string = process.cwd()): string {
  return path.join(cwd, MIGRATIONS_DIR_NAME)
}

export function loadMigrationManifest(cwd: string = process.cwd()): Array<MigrationManifestEntry> {
  return MIGRATION_MANIFEST.map((entry) => {
    const abs = path.join(cwd, entry.relativePath)
    if (!fs.existsSync(abs)) {
      throw new Error(`Migration file missing: ${entry.relativePath}`)
    }
    const sql = fs.readFileSync(abs, 'utf8')
    return {
      ...entry,
      sha256: sha256Hex(sql),
      sql,
      statements: splitSqlStatements(sql),
    }
  })
}

/**
 * Versions are zero-padded 3-digit strings starting at 000 (baseline), then 001…
 * Index i must equal version number i (not i+1).
 */
export function assertManifestOrder(entries: ReadonlyArray<MigrationEntry>): void {
  for (let i = 0; i < entries.length; i++) {
    const expected = String(i).padStart(3, '0')
    if (entries[i]!.version !== expected) {
      throw new Error(`Migration order broken: expected version ${expected}, got ${entries[i]!.version}`)
    }
    if (i > 0 && entries[i]!.version <= entries[i - 1]!.version) {
      throw new Error(`Migration versions not strictly increasing at ${entries[i]!.filename}`)
    }
  }
}

export interface PlanOptions {
  host?: string
  hostClass?: DbHostClass
  applied?: Array<MigrationHistoryRow>
  cwd?: string
  mode?: MigrationMode
  /** When true, treat unknown remote/production as blocked even for plan inspection of apply path. */
  requireApplyAuthority?: boolean
  /**
   * Lifecycle enum mapping evidence (AC-LIFE-02).
   * - Required for mode=apply (missing → DECISION_LIFECYCLE_MAPPING_REQUIRED, no SQL).
   * - Optional for plan/dry-run/status; when supplied, SPLIT/MERGE/UNMAPPED/malformed/duplicate block.
   */
  lifecycleMapping?: LifecycleMappingDocument | ReadonlyArray<LifecycleMappingRow> | null
  /** Exact owner-approved production override; invalid/drifted evidence is ignored. */
  productionAuthority?: ProductionMigrationAuthority | null
  /** DB name bound by productionAuthority. */
  database?: string
  /**
   * Apply only through this version (inclusive). Production one-step sets this to the
   * exact approved next version so later pending migrations are never auto-applied.
   */
  throughVersion?: string
}

/**
 * Exact owner-approved production migration binding.
 * `migrationVersion` must be an exact manifest NNN (not hard-coded to a single cutover).
 * Production apply still requires one-step progression to that version only.
 */
export interface ProductionMigrationAuthority {
  releaseSha: string
  approvalId: string
  migrationVersion: string
  migrationSha256: string
  targetHost: string
  targetDatabase: string
  backupReceiptPath: string
  backupSha256: string
  approvalBinding: string
  maxBackupAgeHours: number
}

/** Narrow production/unknown-remote override. Every bound input is re-proven locally. */
export function validateProductionMigrationAuthority(
  authority: ProductionMigrationAuthority | null | undefined,
  input: {
    host: string
    database: string
    migration: MigrationManifestEntry | undefined
    nowMs?: number
  },
): boolean {
  if (!authority || !/^\d{3}$/.test(authority.migrationVersion)) return false
  if (!/^[0-9a-f]{40}$/.test(authority.releaseSha)) return false
  if (!authority.approvalId.trim()) return false
  if (!/^[0-9a-f]{64}$/.test(authority.migrationSha256)) return false
  if (!/^[0-9a-f]{64}$/.test(authority.backupSha256)) return false
  if (authority.targetHost !== input.host || authority.targetDatabase !== input.database) return false
  if (
    input.migration?.version !== authority.migrationVersion ||
    input.migration.sha256 !== authority.migrationSha256
  ) return false
  try {
    const stat = fs.statSync(authority.backupReceiptPath)
    const maxAgeMs = authority.maxBackupAgeHours * 3_600_000
    if (!stat.isFile() || stat.size <= 0 || maxAgeMs <= 0) return false
    const ageMs = (input.nowMs ?? Date.now()) - stat.mtimeMs
    if (ageMs < -5_000 || ageMs > maxAgeMs) return false
    const backupSha = sha256Hex(fs.readFileSync(authority.backupReceiptPath))
    if (backupSha !== authority.backupSha256) return false
  } catch {
    return false
  }
  const binding = sha256Hex([
    authority.releaseSha,
    authority.approvalId,
    authority.migrationVersion,
    authority.migrationSha256,
    authority.targetHost,
    authority.targetDatabase,
    authority.backupSha256,
  ].join('\0'))
  return binding === authority.approvalBinding
}

/**
 * G0 identity mapping rows (nine live stages, all IDENTITY) — representable for safe apply.
 * Source: V3_LIFECYCLE_RAIL / LIFECYCLE_MAPPING_V1 identity evidence.
 */
export function g0IdentityLifecycleMappingRows(): ReadonlyArray<LifecycleMappingRow> {
  return V3_LIFECYCLE_RAIL.map((live) => ({
    live,
    canonical: live,
    type: 'IDENTITY' as const,
  }))
}

/**
 * Resolve lifecycle mapping for plan/apply output without reimplementing the guard.
 * Apply mode with missing/null mapping → fail closed DECISION_LIFECYCLE_MAPPING_REQUIRED.
 * Supplied rows always go through evaluateLifecycleEnumMapping.
 */
export function resolveMigrationLifecycleMapping(
  lifecycleMapping: PlanOptions['lifecycleMapping'],
  mode: MigrationMode,
): { blocked: boolean; mapping: MigrationLifecycleMappingResult | null; blockedReason?: string } {
  const missing = lifecycleMapping === undefined || lifecycleMapping === null

  if (missing) {
    if (mode === 'apply') {
      return {
        blocked: true,
        mapping: {
          approved: false,
          blockingDecisionRequired: true,
          decisionCode: 'DECISION_LIFECYCLE_MAPPING_REQUIRED',
          ambiguousStateIds: [],
          reasons: ['MISSING_LIFECYCLE_MAPPING_EVIDENCE'],
        },
        blockedReason:
          'Lifecycle mapping evidence required before migration apply (DECISION_LIFECYCLE_MAPPING_REQUIRED)',
      }
    }
    return { blocked: false, mapping: null }
  }

  // Established pure guard — never rewrite mapping rules here.
  const guard = evaluateLifecycleEnumMapping(lifecycleMapping)
  if (!guard.ok) {
    return {
      blocked: true,
      mapping: {
        approved: false,
        blockingDecisionRequired: true,
        decisionCode: guard.decisionCode,
        ambiguousStateIds: guard.ambiguousStateIds,
        reasons: [...guard.reasons],
        blockingRows: guard.blockingRows,
      },
      blockedReason: `Lifecycle mapping blocked: ${guard.decisionCode}`,
    }
  }

  return {
    blocked: false,
    mapping: {
      approved: true,
      blockingDecisionRequired: false,
      decisionCode: null,
      ambiguousStateIds: [],
      reasons: [],
      identityCount: guard.identityCount,
      renameCount: guard.renameCount,
      legacyOnlyCount: guard.legacyOnlyCount,
      steps: guard.steps,
    },
  }
}

function blockedItemsFromManifest(
  loaded: ReadonlyArray<MigrationManifestEntry>,
  reason: string,
): Array<MigrationPlanItem> {
  return loaded.map((m) => ({
    version: m.version,
    filename: m.filename,
    classification: m.classification,
    expectedSha256: m.sha256,
    action: 'BLOCKED' as const,
    reason,
  }))
}

export function planMigrations(opts: PlanOptions = {}): MigrationPlanResult {
  const cwd = opts.cwd ?? process.cwd()
  const host = opts.host ?? configuredDbHost()
  const hostClass = opts.hostClass ?? classifyDbHost(host)
  const mode = opts.mode ?? 'plan'
  const loaded = loadMigrationManifest(cwd)
  assertManifestOrder(loaded)
  const authorityVersion = opts.productionAuthority?.migrationVersion
  const authorityMigration = authorityVersion
    ? loaded.find((entry) => entry.version === authorityVersion)
    : undefined
  const applyAllowed =
    migrationApplyAllowed(hostClass) ||
    validateProductionMigrationAuthority(opts.productionAuthority, {
      host,
      database: opts.database ?? '',
      migration: authorityMigration,
    })

  const appliedMap = new Map((opts.applied ?? []).map((r) => [r.version, r]))
  const orderedVersions = loaded.map((m) => m.version)

  if (mode === 'apply' && !applyAllowed) {
    // Host authority fail-closed (before SQL). Mapping not required to refuse remote apply.
    return {
      mode,
      host,
      hostClass,
      applyAllowed,
      items: blockedItemsFromManifest(loaded, `hostClass=${hostClass} refuses migration apply`),
      orderedVersions,
      status: 'BLOCKED',
      blockedReason: `Migration apply refused for hostClass=${hostClass} host=${host}`,
      mapping: null,
    }
  }

  // AC-LIFE-02: mapping guard before checksum plan / any apply SQL path.
  const mappingResolved = resolveMigrationLifecycleMapping(opts.lifecycleMapping, mode)
  if (mappingResolved.blocked) {
    return {
      mode,
      host,
      hostClass,
      applyAllowed,
      items: blockedItemsFromManifest(
        loaded,
        mappingResolved.blockedReason ?? 'lifecycle mapping blocked',
      ),
      orderedVersions,
      status: 'BLOCKED',
      blockedReason: mappingResolved.blockedReason,
      mapping: mappingResolved.mapping,
    }
  }

  const items: Array<MigrationPlanItem> = []
  let checksumMismatch = false
  for (const m of loaded) {
    const prev = appliedMap.get(m.version)
    if (!prev) {
      items.push({
        version: m.version,
        filename: m.filename,
        classification: m.classification,
        expectedSha256: m.sha256,
        action: 'APPLY',
      })
      continue
    }
    if (prev.sha256 !== m.sha256) {
      checksumMismatch = true
      items.push({
        version: m.version,
        filename: m.filename,
        classification: m.classification,
        expectedSha256: m.sha256,
        action: 'CHECKSUM_MISMATCH',
        reason: `history sha256=${prev.sha256} != file sha256=${m.sha256}`,
      })
      continue
    }
    items.push({
      version: m.version,
      filename: m.filename,
      classification: m.classification,
      expectedSha256: m.sha256,
      action: 'SKIP_ALREADY_APPLIED',
      reason: 'identical checksum in migration history',
    })
  }

  if (checksumMismatch) {
    return {
      mode,
      host,
      hostClass,
      applyAllowed,
      items,
      orderedVersions,
      status: 'CHECKSUM_MISMATCH',
      blockedReason: 'One or more applied migrations have checksum mismatches',
      mapping: mappingResolved.mapping,
    }
  }

  const needsApply = items.some((i) => i.action === 'APPLY')
  return {
    mode,
    host,
    hostClass,
    applyAllowed,
    items,
    orderedVersions,
    status: needsApply ? 'READY' : 'IDEMPOTENT_NOOP',
    mapping: mappingResolved.mapping,
  }
}

/**
 * Resolve applied history: explicit `applied` wins; else `executor.listApplied()`; else [].
 * Keeps planMigrations sync while allowing real MySQL executors to supply checksum history.
 */
export async function resolveAppliedHistory(
  opts: PlanOptions & { executor?: MigrationSqlExecutor } = {},
): Promise<Array<MigrationHistoryRow>> {
  if (opts.applied !== undefined) return opts.applied
  if (opts.executor?.listApplied) return opts.executor.listApplied()
  return []
}

/** Latest version declared by the on-disk manifest (e.g. "003"). Empty if none. */
export function manifestLatestVersion(): string {
  const last = MIGRATION_MANIFEST[MIGRATION_MANIFEST.length - 1]
  return last?.version ?? ''
}

/**
 * Schema/version readback suitable for /api/healthz (applied list + plan status + schemaVersion).
 * Never invents READY/schema when history is empty — returns UNKNOWN + empty schemaVersion.
 */
export interface MigrationSchemaReadback {
  host: string
  hostClass: DbHostClass
  applyAllowed: boolean
  appliedVersions: Array<string>
  /** Latest applied version string, or "" when unproven. */
  schemaVersion: string
  expectedLatestVersion: string
  status: MigrationPlanResult['status'] | 'UNKNOWN'
  history: Array<MigrationHistoryRow>
  plan: MigrationPlanResult | null
}

export async function readMigrationSchemaState(
  opts: PlanOptions & { executor: MigrationSqlExecutor },
): Promise<MigrationSchemaReadback> {
  const host = opts.host ?? configuredDbHost()
  const hostClass = opts.hostClass ?? classifyDbHost(host)
  const applyAllowed = migrationApplyAllowed(hostClass)
  const expectedLatestVersion = manifestLatestVersion()
  let history: Array<MigrationHistoryRow> = []
  try {
    history = await resolveAppliedHistory(opts)
  } catch {
    return {
      host,
      hostClass,
      applyAllowed,
      appliedVersions: [],
      schemaVersion: '',
      expectedLatestVersion,
      status: 'UNKNOWN',
      history: [],
      plan: null,
    }
  }
  if (history.length === 0) {
    return {
      host,
      hostClass,
      applyAllowed,
      appliedVersions: [],
      schemaVersion: '',
      expectedLatestVersion,
      status: 'UNKNOWN',
      history: [],
      plan: null,
    }
  }
  const plan = planMigrations({
    ...opts,
    host,
    hostClass,
    applied: history,
    mode: opts.mode ?? 'status',
  })
  const appliedVersions = history.map((h) => h.version)
  return {
    host,
    hostClass,
    applyAllowed,
    appliedVersions,
    schemaVersion: appliedVersions[appliedVersions.length - 1] ?? '',
    expectedLatestVersion,
    status: plan.status,
    history,
    plan,
  }
}

/**
 * Dry-run: plan + statement parse only. Does not execute migration SQL.
 * Loads applied history from executor.listApplied when `applied` omitted.
 * When executor.recordApplied provided, optionally records dry_run history rows (test/staging).
 * Real MySQL CLI dry-run should pass a read-only executor (no recordApplied) so history is not written.
 */
export async function dryRunMigrations(opts: PlanOptions & { executor?: MigrationSqlExecutor } = {}): Promise<MigrationPlanResult> {
  const applied = await resolveAppliedHistory(opts)
  const plan = planMigrations({ ...opts, applied, mode: 'dry-run' })
  if (plan.status === 'BLOCKED' || plan.status === 'CHECKSUM_MISMATCH') return plan
  // Validate every statement is non-empty after parse (already done in load)
  const loaded = loadMigrationManifest(opts.cwd ?? process.cwd())
  for (const m of loaded) {
    if (m.statements.length === 0) {
      return {
        ...plan,
        status: 'BLOCKED',
        blockedReason: `Migration ${m.filename} has zero executable statements`,
      }
    }
  }
  if (opts.executor?.recordApplied) {
    for (const m of loaded) {
      const item = plan.items.find((i) => i.version === m.version)
      if (item?.action === 'APPLY') {
        await opts.executor.recordApplied({
          version: m.version,
          filename: m.filename,
          sha256: m.sha256,
          classification: m.classification,
          dryRun: true,
          appliedAt: new Date().toISOString(),
        })
      }
    }
  }
  return plan
}

/**
 * Apply migrations through an injected executor. Refuses PRODUCTION / UNKNOWN_REMOTE
 * unless a fully re-proven ProductionMigrationAuthority is supplied.
 * Loads applied history from executor.listApplied when `applied` omitted (real MySQL path).
 * Requires approved lifecycle mapping (IDENTITY/RENAME/LEGACY_ONLY only) before any SQL/history write.
 * Production authority + optional throughVersion enforce exact one-step next-version apply
 * (never all remaining migrations, never skip).
 * Tolerates MySQL errno 1060 (duplicate column) and 1061 (duplicate key) for idempotent expand.
 * No destructive down migration path exists.
 */
export async function applyMigrations(opts: PlanOptions & { executor: MigrationSqlExecutor }): Promise<MigrationApplyResult> {
  const appliedHistory = await resolveAppliedHistory(opts)
  const plan = planMigrations({ ...opts, applied: appliedHistory, mode: 'apply' })
  if (plan.status === 'BLOCKED') {
    return {
      ok: false,
      applied: [],
      skipped: [],
      plan,
      error: plan.blockedReason,
      mapping: plan.mapping,
    }
  }
  if (plan.status === 'CHECKSUM_MISMATCH') {
    return {
      ok: false,
      applied: [],
      skipped: [],
      plan,
      error: plan.blockedReason,
      mapping: plan.mapping,
    }
  }
  if (!plan.applyAllowed) {
    return {
      ok: false,
      applied: [],
      skipped: [],
      plan,
      error: `Migration apply refused for hostClass=${plan.hostClass}`,
      mapping: plan.mapping,
    }
  }
  // Fail-closed: only approved non-blocked mapping may reach SQL / history writes.
  if (!plan.mapping || !plan.mapping.approved || plan.mapping.blockingDecisionRequired) {
    return {
      ok: false,
      applied: [],
      skipped: [],
      plan,
      error:
        plan.mapping?.decisionCode === 'DECISION_LIFECYCLE_MAPPING_REQUIRED'
          ? plan.blockedReason ?? 'DECISION_LIFECYCLE_MAPPING_REQUIRED'
          : plan.blockedReason ??
            `Lifecycle mapping not approved (${plan.mapping?.decisionCode ?? 'DECISION_LIFECYCLE_MAPPING_REQUIRED'})`,
      mapping: plan.mapping,
    }
  }

  // Production one-step: approved version must be the exact next pending APPLY item.
  // throughVersion (or authority.migrationVersion) caps apply so later pendings never run.
  const throughVersion =
    opts.throughVersion ??
    (opts.productionAuthority ? opts.productionAuthority.migrationVersion : undefined)
  if (opts.productionAuthority) {
    const approved = opts.productionAuthority.migrationVersion
    if (throughVersion !== approved) {
      return {
        ok: false,
        applied: [],
        skipped: [],
        plan,
        error: `Production apply throughVersion=${throughVersion ?? '(none)'} must equal approved ${approved}`,
        mapping: plan.mapping,
      }
    }
    const pending = plan.items.filter((i) => i.action === 'APPLY')
    if (pending.length === 0) {
      return {
        ok: false,
        applied: [],
        skipped: [],
        plan,
        error: `Production one-step: no pending APPLY; approved ${approved} is not the next migration`,
        mapping: plan.mapping,
      }
    }
    if (pending[0]!.version !== approved) {
      return {
        ok: false,
        applied: [],
        skipped: [],
        plan,
        error: `Production one-step refuses skip/arbitrary version: next pending=${pending[0]!.version} approved=${approved}`,
        mapping: plan.mapping,
      }
    }
    if (pending[0]!.expectedSha256 !== opts.productionAuthority.migrationSha256) {
      return {
        ok: false,
        applied: [],
        skipped: [],
        plan,
        error: `Production one-step: next pending sha256 does not match MIGRATION_APPROVED_SHA256 for ${approved}`,
        mapping: plan.mapping,
      }
    }
  } else if (throughVersion) {
    if (!/^\d{3}$/.test(throughVersion)) {
      return {
        ok: false,
        applied: [],
        skipped: [],
        plan,
        error: `Invalid throughVersion=${throughVersion} (expected NNN)`,
        mapping: plan.mapping,
      }
    }
    if (!plan.orderedVersions.includes(throughVersion)) {
      return {
        ok: false,
        applied: [],
        skipped: [],
        plan,
        error: `throughVersion=${throughVersion} is not in the migration manifest`,
        mapping: plan.mapping,
      }
    }
    const pending = plan.items.filter((i) => i.action === 'APPLY')
    if (pending.length > 0 && pending[0]!.version > throughVersion) {
      return {
        ok: false,
        applied: [],
        skipped: [],
        plan,
        error: `throughVersion=${throughVersion} is behind next pending ${pending[0]!.version}`,
        mapping: plan.mapping,
      }
    }
  }

  const loaded = loadMigrationManifest(opts.cwd ?? process.cwd())
  const applied: Array<string> = []
  const skipped: Array<string> = []

  for (const m of loaded) {
    if (throughVersion && m.version > throughVersion) {
      // Bounded apply: leave later pending versions unapplied (require separate approval).
      break
    }
    const item = plan.items.find((i) => i.version === m.version)!
    if (item.action === 'SKIP_ALREADY_APPLIED') {
      skipped.push(m.version)
      continue
    }
    if (item.action !== 'APPLY') {
      return {
        ok: false,
        applied,
        skipped,
        plan,
        error: `Cannot apply ${m.version}: ${item.action}`,
        mapping: plan.mapping,
      }
    }
    for (const stmt of m.statements) {
      try {
        await opts.executor.query(stmt)
      } catch (e) {
        const errno = (e as { errno?: number }).errno
        // Idempotent expand: duplicate column / key
        if (errno === 1060 || errno === 1061) continue
        const msg = e instanceof Error ? e.message : String(e)
        return {
          ok: false,
          applied,
          skipped,
          plan,
          error: `Failed ${m.filename}: ${msg}`,
          mapping: plan.mapping,
        }
      }
    }
    if (opts.executor.recordApplied) {
      await opts.executor.recordApplied({
        version: m.version,
        filename: m.filename,
        sha256: m.sha256,
        classification: m.classification,
        dryRun: false,
        appliedAt: new Date().toISOString(),
      })
    }
    applied.push(m.version)
  }

  return { ok: true, applied, skipped, plan, mapping: plan.mapping }
}

export function migrationStatus(opts: PlanOptions = {}): MigrationPlanResult {
  return planMigrations({ ...opts, mode: 'status' })
}

/**
 * Async status that loads checksum history from executor when present.
 * Prefer this for MySQL CLI / health-adjacent callers.
 */
export async function migrationStatusAsync(
  opts: PlanOptions & { executor?: MigrationSqlExecutor } = {},
): Promise<MigrationPlanResult> {
  const applied = await resolveAppliedHistory(opts)
  return planMigrations({ ...opts, applied, mode: 'status' })
}

/**
 * Source-grounded backfill dry-run contract.
 * Missing proof → UNCLASSIFIED. Integrity issues → rejected, not silently repaired.
 * Never invents PRODUCT classification.
 */
export function dryRunClassificationBackfill(rows: Array<BackfillTaskRow>): BackfillDryRunResult {
  const issues: Array<BackfillIntegrityIssue> = []
  const wouldWrite: BackfillDryRunResult['wouldWrite'] = []

  const fcSeen = new Map<string, string>()
  const nodeSeen = new Map<string, string>()
  const depJoinSeen = new Set<string>()
  const owners = new Map<string, string>()

  for (const row of rows) {
    if (row.stale) {
      issues.push({ code: 'STALE_DATA', taskId: row.taskId, detail: 'stale row rejected' })
    }
    if (row.featureContractId) {
      const prev = fcSeen.get(row.featureContractId)
      if (prev && prev !== row.taskId) {
        issues.push({
          code: 'DUPLICATE_FC_JOIN',
          taskId: row.taskId,
          detail: `featureContractId=${row.featureContractId} also on ${prev}`,
        })
      } else {
        fcSeen.set(row.featureContractId, row.taskId)
      }
    }
    if (row.nodeId) {
      const prev = nodeSeen.get(row.nodeId)
      if (prev && prev !== row.taskId) {
        issues.push({
          code: 'DUPLICATE_NODE_JOIN',
          taskId: row.taskId,
          detail: `nodeId=${row.nodeId} also on ${prev}`,
        })
      } else {
        nodeSeen.set(row.nodeId, row.taskId)
      }
    }
    for (const dep of row.dependencies ?? []) {
      const key = `${row.taskId}->${dep}`
      const rev = `${dep}->${row.taskId}`
      if (depJoinSeen.has(key)) {
        issues.push({ code: 'DUPLICATE_DEPENDENCY_JOIN', taskId: row.taskId, detail: key })
      }
      depJoinSeen.add(key)
      if (depJoinSeen.has(rev) && dep !== row.taskId) {
        // direct mutual edge is not necessarily a multi-node cycle; full cycle check below
      }
    }
    if (row.ownerId) {
      const prev = owners.get(row.taskId)
      if (prev && prev !== row.ownerId) {
        issues.push({
          code: 'CONFLICTING_OWNERSHIP',
          taskId: row.taskId,
          detail: `owners ${prev} vs ${row.ownerId}`,
        })
      } else {
        owners.set(row.taskId, row.ownerId)
      }
    }

    // Classification: never guess PRODUCT
    if (row.taskClass === 'PRODUCT' && !row.classificationProofValid) {
      issues.push({
        code: 'MISSING_PROOF',
        taskId: row.taskId,
        detail: 'PRODUCT claimed without valid classification proof — refused',
      })
      wouldWrite.push({
        taskId: row.taskId,
        taskClass: 'UNCLASSIFIED',
        disposition: row.disposition && row.disposition !== 'UNCLASSIFIED' && row.classificationProofValid
          ? row.disposition
          : 'UNCLASSIFIED',
        reason: 'PRODUCT without proof → UNCLASSIFIED',
      })
      continue
    }

    if (!row.classificationProofValid) {
      wouldWrite.push({
        taskId: row.taskId,
        taskClass: 'UNCLASSIFIED',
        disposition: 'UNCLASSIFIED',
        reason: 'missing proof remains UNCLASSIFIED',
      })
      continue
    }

    wouldWrite.push({
      taskId: row.taskId,
      taskClass: row.taskClass ?? 'UNCLASSIFIED',
      disposition: row.disposition ?? 'UNCLASSIFIED',
      reason: 'proof-valid classification retained',
    })
  }

  // Cycle detection on dependency graph (DFS)
  const graph = new Map<string, Array<string>>()
  for (const row of rows) {
    graph.set(row.taskId, [...(row.dependencies ?? [])])
  }
  const WHITE = 0
  const GRAY = 1
  const BLACK = 2
  const color = new Map<string, number>()
  for (const id of graph.keys()) color.set(id, WHITE)

  const visit = (id: string): boolean => {
    color.set(id, GRAY)
    for (const next of graph.get(id) ?? []) {
      if (!graph.has(next)) continue
      const c = color.get(next) ?? WHITE
      if (c === GRAY) {
        issues.push({ code: 'DEPENDENCY_CYCLE', taskId: id, detail: `cycle involving ${id} -> ${next}` })
        return true
      }
      if (c === WHITE && visit(next)) return true
    }
    color.set(id, BLACK)
    return false
  }
  for (const id of graph.keys()) {
    if ((color.get(id) ?? WHITE) === WHITE) visit(id)
  }

  const rejected = issues.some((i) => i.code !== 'MISSING_PROOF')
  // MISSING_PROOF alone is handled by UNCLASSIFIED write; structural issues reject the batch
  return {
    ok: !rejected,
    wouldWrite,
    issues,
    rejected,
  }
}

/** In-memory executor for unit tests (no real MySQL). */
export function createMemoryMigrationExecutor(
  initial: Array<MigrationHistoryRow> = [],
): MigrationSqlExecutor & {
  history: Array<MigrationHistoryRow>
  statements: Array<string>
} {
  const history = [...initial]
  const statements: Array<string> = []
  return {
    history,
    statements,
    async query(sql: string) {
      statements.push(sql)
      return { ok: true }
    },
    async listApplied() {
      return [...history]
    },
    async recordApplied(row: MigrationHistoryRow) {
      const idx = history.findIndex((h) => h.version === row.version)
      if (idx >= 0) history[idx] = row
      else history.push(row)
    },
  }
}
