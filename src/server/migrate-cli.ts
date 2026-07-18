/**
 * Migration CLI — plan / dry-run / apply / status for Control Plane V3 (TM-P0).
 * Authority: LOCAL|STAGING DB endpoints only; production-host apply is separately
 * gated by deploy/production/scripts/migrate-apply.sh before this runner executes.
 * Lifecycle mapping required for apply (g0 identity or JSON path).
 * No destructive down migration. Never guesses PRODUCT classification.
 *
 * Invoked via: node src/server/migrate-runner.mjs <command> [flags]
 * Or: pnpm migrate / migrate:plan / migrate:dry-run / migrate:apply / migrate:status
 */
import fs from 'node:fs'
import path from 'node:path'

import {
  applyMigrations,
  dryRunMigrations,
  g0IdentityLifecycleMappingRows,
  loadMigrationManifest,
  migrationStatusAsync,
  planMigrations,
  readMigrationSchemaState,
  sha256Hex,
  type MigrationMode,
  type MigrationPlanResult,
  type MigrationApplyResult,
  type MigrationSchemaReadback,
  type ProductionMigrationAuthority,
} from './migrations'
import {
  createMysqlMigrationExecutor,
  createMysqlMigrationReadOnlyExecutor,
  resolveMysqlMigrationConfig,
  type MysqlMigrationExecutor,
} from './mysql-migration-executor'
import type { LifecycleMappingDocument, LifecycleMappingRow } from './lifecycle-store'

export type MigrateCliCommand = 'plan' | 'dry-run' | 'apply' | 'status' | 'help'

export interface MigrateCliArgs {
  command: MigrateCliCommand
  cwd: string
  host?: string
  database?: string
  /** g0 | path/to/LIFECYCLE_MAPPING_V1.json */
  lifecycleMapping?: string
  json: boolean
  help: boolean
  /** When true, skip opening MySQL (plan-only offline). */
  offline: boolean
  /**
   * Apply only through this exact manifest version (inclusive).
   * Production one-step also derives this from MIGRATION_APPROVED_VERSION.
   */
  throughVersion?: string
}

export interface MigrateCliResult {
  exitCode: number
  command: MigrateCliCommand
  plan?: MigrationPlanResult
  apply?: MigrationApplyResult
  schema?: MigrationSchemaReadback
  error?: string
  stdout: string
}

const COMMANDS = new Set<MigrateCliCommand>(['plan', 'dry-run', 'apply', 'status', 'help'])

export function parseMigrateCliArgs(argv: ReadonlyArray<string>): MigrateCliArgs {
  const args: MigrateCliArgs = {
    command: 'help',
    cwd: process.cwd(),
    json: false,
    help: false,
    offline: false,
  }
  const positional: Array<string> = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a === '--help' || a === '-h') {
      args.help = true
      continue
    }
    if (a === '--json') {
      args.json = true
      continue
    }
    if (a === '--offline') {
      args.offline = true
      continue
    }
    if (a === '--cwd' && argv[i + 1]) {
      args.cwd = path.resolve(argv[++i]!)
      continue
    }
    if (a.startsWith('--cwd=')) {
      args.cwd = path.resolve(a.slice('--cwd='.length))
      continue
    }
    if (a === '--host' && argv[i + 1]) {
      args.host = argv[++i]
      continue
    }
    if (a.startsWith('--host=')) {
      args.host = a.slice('--host='.length)
      continue
    }
    if (a === '--database' && argv[i + 1]) {
      args.database = argv[++i]
      continue
    }
    if (a.startsWith('--database=')) {
      args.database = a.slice('--database='.length)
      continue
    }
    if ((a === '--lifecycle-mapping' || a === '--mapping') && argv[i + 1]) {
      args.lifecycleMapping = argv[++i]
      continue
    }
    if (a.startsWith('--lifecycle-mapping=')) {
      args.lifecycleMapping = a.slice('--lifecycle-mapping='.length)
      continue
    }
    if (a.startsWith('--mapping=')) {
      args.lifecycleMapping = a.slice('--mapping='.length)
      continue
    }
    if (a === '--through' && argv[i + 1]) {
      args.throughVersion = argv[++i]
      continue
    }
    if (a.startsWith('--through=')) {
      args.throughVersion = a.slice('--through='.length)
      continue
    }
    if (a.startsWith('-')) {
      throw new Error(`Unknown flag: ${a}`)
    }
    positional.push(a)
  }
  if (args.help || positional.length === 0) {
    args.command = 'help'
    return args
  }
  const cmd = positional[0]!.toLowerCase() as MigrateCliCommand
  if (!COMMANDS.has(cmd)) {
    throw new Error(`Unknown command: ${positional[0]}. Expected plan|dry-run|apply|status`)
  }
  args.command = cmd
  return args
}

export function loadLifecycleMappingFromSpec(
  spec: string | undefined,
  cwd: string,
): ReadonlyArray<LifecycleMappingRow> | LifecycleMappingDocument | undefined {
  if (!spec || spec.trim() === '') return undefined
  const s = spec.trim()
  if (s === 'g0' || s === 'G0' || s === 'identity') {
    return g0IdentityLifecycleMappingRows()
  }
  const abs = path.isAbsolute(s) ? s : path.join(cwd, s)
  if (!fs.existsSync(abs)) {
    throw new Error(`Lifecycle mapping file not found: ${abs}`)
  }
  const raw = JSON.parse(fs.readFileSync(abs, 'utf8')) as unknown
  if (Array.isArray(raw)) {
    return raw as ReadonlyArray<LifecycleMappingRow>
  }
  if (raw && typeof raw === 'object') {
    const doc = raw as LifecycleMappingDocument & { mapping?: unknown; rows?: unknown }
    if (Array.isArray(doc.mapping)) return doc
    if (Array.isArray(doc.rows)) {
      return { ...doc, mapping: doc.rows as LifecycleMappingRow[] }
    }
  }
  throw new Error(`Lifecycle mapping JSON must be an array or { mapping: [...] }: ${abs}`)
}

function helpText(): string {
  return `Usage: pnpm migrate <command> [options]

Commands:
  plan       Plan migrations 000..012 (no SQL)
  dry-run    Plan + parse statements; load history from MySQL; no apply
  apply      Apply pending migrations (LOCAL|STAGING; production only with exact authority)
  status     Report applied versions + plan status (schema readback for healthz)

Options:
  --cwd <path>                 Repo root containing migrations/
  --host <host>                Override CAIRN_DB_HOST
  --database <name>            Override CAIRN_DB_NAME
  --lifecycle-mapping <spec>   g0 | path/to/LIFECYCLE_MAPPING_V1.json (required for apply)
  --through <NNN>              Apply only through exact version NNN (inclusive); production one-step
  --offline                    plan only without opening MySQL
  --json                       Machine-readable JSON on stdout
  --help                       Show this help

Authority:
  Apply refused for PRODUCTION / UNKNOWN_REMOTE without exact ProductionMigrationAuthority.
  Production apply is one-step only: next pending must equal MIGRATION_APPROVED_VERSION.
  Remote hosts require CAIRN_ALLOW_REMOTE_DB=1.
  Staging hosts: CAIRN_STAGING_DB_HOSTS or known labels (tm-v3-staging, …).
  No down migration. No PRODUCT classification guess.
`
}

function exitForPlan(plan: MigrationPlanResult): number {
  if (plan.status === 'CHECKSUM_MISMATCH') return 2
  if (plan.status === 'BLOCKED') return 1
  return 0
}

/** Build the narrow production authority object; migrations.ts revalidates every field. */
export function productionMigrationAuthorityFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): ProductionMigrationAuthority | null {
  if (env.MIGRATE_APPLY_APPROVED !== '1') return null
  const backupReceiptPath = env.DB_DUMP_PATH || env.BACKUP_RECEIPT || ''
  let backupSha256 = ''
  try {
    backupSha256 = sha256Hex(fs.readFileSync(backupReceiptPath))
  } catch {
    return null
  }
  return {
    releaseSha: String(env.APPROVED_FULL_SHA || ''),
    approvalId: String(env.PRODUCTION_APPROVAL_ID || ''),
    migrationVersion: String(env.MIGRATION_APPROVED_VERSION || '').trim(),
    migrationSha256: String(env.MIGRATION_APPROVED_SHA256 || '').trim(),
    targetHost: String(env.MIGRATION_TARGET_HOST || ''),
    targetDatabase: String(env.MIGRATION_TARGET_DATABASE || ''),
    backupReceiptPath,
    backupSha256,
    approvalBinding: String(env.MIGRATION_APPROVAL_BINDING || ''),
    maxBackupAgeHours: Number(env.BACKUP_MAX_AGE_HOURS || 24),
  }
}

function formatHumanPlan(plan: MigrationPlanResult): string {
  const lines = [
    `mode=${plan.mode} host=${plan.host} hostClass=${plan.hostClass} applyAllowed=${plan.applyAllowed} status=${plan.status}`,
    plan.blockedReason ? `blockedReason=${plan.blockedReason}` : null,
    plan.mapping
      ? `mapping.approved=${plan.mapping.approved} decisionCode=${plan.mapping.decisionCode ?? 'null'} ambiguous=${plan.mapping.ambiguousStateIds.join(',') || '-'}`
      : 'mapping=null',
    'items:',
    ...plan.items.map(
      (i) =>
        `  ${i.version} ${i.filename} ${i.action}${i.reason ? ` (${i.reason})` : ''} sha256=${i.expectedSha256.slice(0, 12)}…`,
    ),
  ].filter(Boolean) as Array<string>
  return lines.join('\n')
}

function formatHumanSchema(schema: MigrationSchemaReadback): string {
  return [
    `host=${schema.host} hostClass=${schema.hostClass} applyAllowed=${schema.applyAllowed}`,
    `status=${schema.status} schemaVersion=${schema.schemaVersion || '(empty)'} expectedLatest=${schema.expectedLatestVersion}`,
    `appliedVersions=${schema.appliedVersions.join(',') || '(none)'}`,
  ].join('\n')
}

/**
 * Core CLI runner — injectable executor factory for tests.
 */
export async function runMigrateCli(
  argv: ReadonlyArray<string>,
  deps?: {
    createExecutor?: (opts: {
      host?: string
      database?: string
      readOnly: boolean
    }) => MysqlMigrationExecutor
    log?: (s: string) => void
    logErr?: (s: string) => void
  },
): Promise<MigrateCliResult> {
  const log = deps?.log ?? ((s: string) => console.log(s))
  const logErr = deps?.logErr ?? ((s: string) => console.error(s))

  let args: MigrateCliArgs
  try {
    args = parseMigrateCliArgs(argv)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    logErr(msg)
    return { exitCode: 1, command: 'help', error: msg, stdout: '' }
  }

  if (args.command === 'help') {
    const stdout = helpText()
    log(stdout)
    return { exitCode: 0, command: 'help', stdout }
  }

  // Ensure manifest loads before any DB work.
  try {
    loadMigrationManifest(args.cwd)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    logErr(msg)
    return { exitCode: 1, command: args.command, error: msg, stdout: '' }
  }

  let lifecycleMapping: ReturnType<typeof loadLifecycleMappingFromSpec>
  try {
    lifecycleMapping =
      loadLifecycleMappingFromSpec(args.lifecycleMapping, args.cwd) ??
      loadLifecycleMappingFromSpec(process.env.CAIRN_LIFECYCLE_MAPPING, args.cwd)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    logErr(msg)
    return { exitCode: 1, command: args.command, error: msg, stdout: '' }
  }

  let productionAuthority: ProductionMigrationAuthority | null = null

  if (args.command === 'apply' && lifecycleMapping === undefined) {
    const msg =
      'apply requires lifecycle mapping evidence: pass --lifecycle-mapping g0 (or path to JSON) or set CAIRN_LIFECYCLE_MAPPING'
    logErr(msg)
    return { exitCode: 1, command: 'apply', error: msg, stdout: '' }
  }

  // Offline plan: no MySQL
  if (args.offline || (args.command === 'plan' && args.offline)) {
    const plan = planMigrations({
      cwd: args.cwd,
      host: args.host,
      mode: args.command === 'plan' ? 'plan' : (args.command as MigrationMode),
      lifecycleMapping,
      applied: [],
    })
    const stdout = args.json ? JSON.stringify({ plan }, null, 2) : formatHumanPlan(plan)
    log(stdout)
    return { exitCode: exitForPlan(plan), command: args.command, plan, stdout }
  }

  // Preflight host authority for apply before opening a write executor.
  if (args.command === 'apply') {
    try {
      const cfg = resolveMysqlMigrationConfig({
        host: args.host,
        database: args.database,
      })
      productionAuthority = productionMigrationAuthorityFromEnv()
      const authorityPlan = planMigrations({
        cwd: args.cwd,
        host: cfg.host,
        hostClass: cfg.hostClass,
        database: cfg.database,
        mode: 'apply',
        lifecycleMapping,
        productionAuthority,
        applied: [],
      })
      if (!cfg.applyAllowed && !authorityPlan.applyAllowed) {
        const msg = `Migration apply refused for hostClass=${cfg.hostClass} host=${cfg.host}`
        logErr(msg)
        const plan = planMigrations({
          cwd: args.cwd,
          host: cfg.host,
          hostClass: cfg.hostClass,
          mode: 'apply',
          lifecycleMapping,
          database: cfg.database,
          productionAuthority,
          applied: [],
        })
        const stdout = args.json ? JSON.stringify({ plan, error: msg }, null, 2) : formatHumanPlan(plan)
        log(stdout)
        return { exitCode: 1, command: 'apply', plan, error: msg, stdout }
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      logErr(msg)
      return { exitCode: 1, command: 'apply', error: msg, stdout: '' }
    }
  }

  const readOnly = args.command !== 'apply'
  const create =
    deps?.createExecutor ??
    ((o: { host?: string; database?: string; readOnly: boolean }) =>
      o.readOnly
        ? createMysqlMigrationReadOnlyExecutor({ host: o.host, database: o.database })
        : createMysqlMigrationExecutor({ host: o.host, database: o.database }))

  let executor: MysqlMigrationExecutor | null = null
  try {
    executor = create({
      host: args.host,
      database: args.database,
      readOnly,
    })

    if (args.command === 'plan') {
      // Plan with live history when MySQL is reachable; empty history if table missing.
      const applied = executor.listApplied ? await executor.listApplied() : []
      const plan = planMigrations({
        cwd: args.cwd,
        host: executor.host,
        hostClass: executor.hostClass,
        applied,
        mode: 'plan',
        lifecycleMapping,
      })
      const stdout = args.json ? JSON.stringify({ plan }, null, 2) : formatHumanPlan(plan)
      log(stdout)
      return { exitCode: exitForPlan(plan), command: 'plan', plan, stdout }
    }

    if (args.command === 'dry-run') {
      // Read-only executor: listApplied only — no recordApplied, no SQL apply.
      const plan = await dryRunMigrations({
        cwd: args.cwd,
        host: executor.host,
        hostClass: executor.hostClass,
        database: executor.database,
        executor,
        lifecycleMapping,
        productionAuthority,
      })
      const stdout = args.json ? JSON.stringify({ plan }, null, 2) : formatHumanPlan(plan)
      log(stdout)
      return { exitCode: exitForPlan(plan), command: 'dry-run', plan, stdout }
    }

    if (args.command === 'status') {
      const plan = await migrationStatusAsync({
        cwd: args.cwd,
        host: executor.host,
        hostClass: executor.hostClass,
        executor,
        lifecycleMapping,
      })
      const schema = await readMigrationSchemaState({
        cwd: args.cwd,
        host: executor.host,
        hostClass: executor.hostClass,
        executor,
      })
      const stdout = args.json
        ? JSON.stringify({ plan, schema }, null, 2)
        : `${formatHumanPlan(plan)}\n--- schema readback ---\n${formatHumanSchema(schema)}`
      log(stdout)
      return { exitCode: exitForPlan(plan), command: 'status', plan, schema, stdout }
    }

    if (args.command === 'apply') {
      // Production authority always caps to the exact approved next version (one-step).
      // Explicit --through also bounds LOCAL/STAGING multi-pending apply.
      const throughVersion =
        args.throughVersion ??
        (productionAuthority ? productionAuthority.migrationVersion : undefined)
      const result = await applyMigrations({
        cwd: args.cwd,
        host: executor.host,
        hostClass: executor.hostClass,
        database: executor.database,
        executor,
        lifecycleMapping,
        productionAuthority,
        throughVersion,
      })
      const schema = result.ok
        ? await readMigrationSchemaState({
            cwd: args.cwd,
            host: executor.host,
            hostClass: executor.hostClass,
            executor,
          })
        : undefined
      const stdout = args.json
        ? JSON.stringify({ apply: result, schema: schema ?? null }, null, 2)
        : [
            result.ok ? 'APPLY ok' : `APPLY failed: ${result.error}`,
            `applied=[${result.applied.join(',')}] skipped=[${result.skipped.join(',')}]`,
            formatHumanPlan(result.plan),
            schema ? `--- schema readback ---\n${formatHumanSchema(schema)}` : null,
          ]
            .filter(Boolean)
            .join('\n')
      log(stdout)
      let exitCode = result.ok ? 0 : 1
      if (result.plan.status === 'CHECKSUM_MISMATCH') exitCode = 2
      return {
        exitCode,
        command: 'apply',
        plan: result.plan,
        apply: result,
        schema,
        error: result.error,
        stdout,
      }
    }

    return { exitCode: 1, command: args.command, error: 'unreachable', stdout: '' }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    logErr(msg)
    return { exitCode: 1, command: args.command, error: msg, stdout: '' }
  } finally {
    if (executor) {
      await executor.close()
    }
  }
}

/** Entry when loaded by migrate-runner.mjs */
export async function main(argv: ReadonlyArray<string> = process.argv.slice(2)): Promise<number> {
  const result = await runMigrateCli(argv)
  return result.exitCode
}
