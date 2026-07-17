#!/usr/bin/env node
/**
 * Thin Node entry for rebuild-lineage + product-features sync
 * (SPEC TM-KOMPAT-VISUAL V1 §2 + ADDENDUM V1.1 §B).
 *
 * Usage:
 *   node scripts/sync-rebuild-data.mjs                   # --dry-run (default)
 *   node scripts/sync-rebuild-data.mjs --dry-run
 *   node scripts/sync-rebuild-data.mjs --apply           # LOCAL|STAGING only; fail-closed on production
 *   node scripts/sync-rebuild-data.mjs --apply-production # production only; full approval bundle required
 *   node scripts/sync-rebuild-data.mjs --json
 *
 * Production apply requires ALL of:
 *   PRODUCTION_MUTATION_APPROVED=1
 *   PRODUCTION_APPROVAL_ID
 *   BACKUP_RECEIPT          (path to existing non-empty file)
 *   SYNC_TARGET_HOST        (exact match CAIRN_DB_HOST)
 *   SYNC_TARGET_DATABASE    (exact match CAIRN_DB_NAME)
 *
 * Optional source path overrides (path-B remote bundle):
 *   SYNC_WORKSPACE_ROOT, SYNC_LINEAGE_JSONL, SYNC_VERDICTS_DIR,
 *   SYNC_LATEST_REPORT, SYNC_FEATURE_CONTRACTS_DIR, SYNC_RN_INVENTORY,
 *   SYNC_PRODUCT_FEATURES_SEED
 *
 * Inputs (never PARITY_LEDGER.json):
 *   REBUILD_LINEAGE.jsonl, l2verify/verdicts/*.json, reports/latest.txt,
 *   CONTRACT/feature-contracts/, SOL-COV rn_inventory.json,
 *   data/product-features.seed.json
 *
 * Does not touch pin/lifecycle/classification tables. Never prints secrets.
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const wantApplyProduction = args.includes('--apply-production')
const wantApply = args.includes('--apply')
const wantJson = args.includes('--json')

if (wantApply && wantApplyProduction) {
  console.error(
    JSON.stringify({
      ok: false,
      error: 'MUTUALLY_EXCLUSIVE: use either --apply (LOCAL|STAGING) or --apply-production, not both',
    }),
  )
  process.exit(2)
}

const mode = wantApply || wantApplyProduction ? 'apply' : 'dry-run'
const applyChannel = wantApplyProduction ? 'production' : wantApply ? 'local-staging' : 'none'

const server = await createServer({
  server: { middlewareMode: true, preTransformRequests: false },
  appType: 'custom',
  configFile: false,
  root,
  logLevel: 'error',
  // Fail-closed CLI path: never scan the TanStack Start app graph for dep-opt.
  // (Background optimizeDeps can race on long --apply/--apply-production runs.)
  optimizeDeps: {
    noDiscovery: true,
    include: [],
  },
  ssr: {
    // Load server modules as Node externals where possible; keep #/ alias only.
    external: true,
  },
  resolve: {
    alias: [{ find: /^#\//, replacement: `${root}/src/` }],
  },
})

try {
  const store = await server.ssrLoadModule('/src/server/rebuild-lineage-store.ts')
  const pfStore = await server.ssrLoadModule('/src/server/product-features-store.ts')
  const dbMod = await server.ssrLoadModule('/src/server/db.ts')

  const paths = store.resolveSyncPathsFromEnv(process.env, '/opt/mfs/workspace')
  const seedPath =
    process.env.SYNC_PRODUCT_FEATURES_SEED && String(process.env.SYNC_PRODUCT_FEATURES_SEED).trim()
      ? String(process.env.SYNC_PRODUCT_FEATURES_SEED).trim()
      : pfStore.defaultProductFeaturesSeedPath(root)

  const t0 = Date.now()
  const plan = store.buildSyncPlan(paths, mode)
  const pfPlan = pfStore.buildProductFeatureSyncPlan({
    cwd: root,
    workspaceRoot: paths.workspaceRoot,
    syncPaths: paths,
    seedPath,
    mode,
  })

  if (mode === 'apply') {
    const host = dbMod.configuredDbHost()
    const database =
      dbMod.envVar('CAIRN_DB_NAME') || process.env.CAIRN_DB_NAME || 'cairn_taskmanager'
    const hostClass = dbMod.classifyDbHost(host)

    if (wantApplyProduction) {
      const gate = store.assertProductionSyncAuthority({
        env: process.env,
        actualHost: host,
        actualDatabase: database,
      })
      if (!gate.ok) {
        console.error(
          JSON.stringify({
            ok: false,
            error: gate.message,
            code: gate.code,
            missing: gate.missing ?? [],
            mode: 'apply-production',
            hostClass,
          }),
        )
        process.exitCode = 2
      } else {
        const applied = await store.applySyncPlan(plan)
        const pfApplied = await pfStore.applyProductFeatureSyncPlan(pfPlan)
        const receipt = {
          ok: true,
          mode: 'apply-production',
          hostClass,
          approvalId: gate.approvalId,
          targetHostBound: true,
          targetDatabaseBound: true,
          counts: {
            ...applied.applied,
            product_features: pfApplied.applied.product_features,
            feature_task_map: pfApplied.applied.feature_task_map,
            feature_task_map_by_join_source: pfApplied.applied.feature_task_map_by_join_source,
            unmapped_tasks: pfApplied.applied.unmapped_tasks,
            meditation_check: pfApplied.applied.meditation_check,
          },
          plan_counts: {
            ...plan.counts,
            product_features: pfPlan.counts.product_features,
            feature_task_map: pfPlan.counts.feature_task_map,
            feature_task_map_by_join_source: pfPlan.counts.feature_task_map_by_join_source,
            unmapped_tasks: pfPlan.counts.unmapped_tasks,
            meditation_check: pfPlan.counts.meditation_check,
          },
          duration_ms: Date.now() - t0,
          apply_duration_ms: applied.durationMs + pfApplied.durationMs,
          plan_duration_ms: plan.durationMs + pfPlan.durationMs,
          sources: {
            lineage: paths.lineageJsonl,
            verdicts: paths.verdictsDir,
            report: paths.latestReport,
            feature_contracts: paths.featureContractsDir,
            rn_inventory: paths.rnInventory,
            product_features_seed: pfPlan.seedPath,
            parity_ledger: 'NOT_USED (stale)',
          },
        }
        console.log(JSON.stringify(receipt, null, wantJson ? 0 : 2))
        process.exitCode = 0
      }
    } else if (!dbMod.migrationApplyAllowed(hostClass)) {
      console.error(
        JSON.stringify({
          ok: false,
          error: `APPLY_REFUSED hostClass=${hostClass} host=${host} (LOCAL|STAGING only; use --apply-production with approval bundle for production)`,
          mode: 'apply',
          applyChannel,
        }),
      )
      process.exitCode = 2
    } else {
      const applied = await store.applySyncPlan(plan)
      const pfApplied = await pfStore.applyProductFeatureSyncPlan(pfPlan)
      const receipt = {
        ok: true,
        mode: 'apply',
        hostClass,
        counts: {
          ...applied.applied,
          product_features: pfApplied.applied.product_features,
          feature_task_map: pfApplied.applied.feature_task_map,
          feature_task_map_by_join_source: pfApplied.applied.feature_task_map_by_join_source,
          unmapped_tasks: pfApplied.applied.unmapped_tasks,
          meditation_check: pfApplied.applied.meditation_check,
        },
        plan_counts: {
          ...plan.counts,
          product_features: pfPlan.counts.product_features,
          feature_task_map: pfPlan.counts.feature_task_map,
          feature_task_map_by_join_source: pfPlan.counts.feature_task_map_by_join_source,
          unmapped_tasks: pfPlan.counts.unmapped_tasks,
          meditation_check: pfPlan.counts.meditation_check,
        },
        duration_ms: Date.now() - t0,
        apply_duration_ms: applied.durationMs + pfApplied.durationMs,
        plan_duration_ms: plan.durationMs + pfPlan.durationMs,
        sources: {
          lineage: paths.lineageJsonl,
          verdicts: paths.verdictsDir,
          report: paths.latestReport,
          feature_contracts: paths.featureContractsDir,
          rn_inventory: paths.rnInventory,
          product_features_seed: pfPlan.seedPath,
          parity_ledger: 'NOT_USED (stale)',
        },
      }
      console.log(JSON.stringify(receipt, null, wantJson ? 0 : 2))
      process.exitCode = 0
    }
  } else {
    const receipt = {
      ok: true,
      mode: 'dry-run',
      counts: {
        ...plan.counts,
        product_features: pfPlan.counts.product_features,
        feature_task_map: pfPlan.counts.feature_task_map,
        feature_task_map_by_join_source: pfPlan.counts.feature_task_map_by_join_source,
        unmapped_tasks: pfPlan.counts.unmapped_tasks,
        meditation_check: pfPlan.counts.meditation_check,
        fc_covered: pfPlan.counts.fc_covered,
        fc_total: pfPlan.counts.fc_total,
      },
      duration_ms: Date.now() - t0,
      plan_duration_ms: plan.durationMs + pfPlan.durationMs,
      would_upsert: {
        rebuild_lineage_records: plan.lineage.length,
        parity_rollups: plan.rollups.length,
        feature_units: plan.units.length,
        feature_directory: plan.directory.length,
        product_features: pfPlan.features.length,
        feature_task_map: pfPlan.maps.length,
      },
      sample_unclassified_task_ids: plan.lineage
        .filter((r) => !r.featureContractId)
        .slice(0, 5)
        .map((r) => r.taskId),
      sample_unmapped_task_ids: pfPlan.unmappedTaskIds.slice(0, 5),
      sources: {
        lineage: paths.lineageJsonl,
        verdicts: paths.verdictsDir,
        report: paths.latestReport,
        feature_contracts: paths.featureContractsDir,
        rn_inventory: paths.rnInventory,
        product_features_seed: pfPlan.seedPath,
        parity_ledger: 'NOT_USED (stale)',
      },
    }
    console.log(JSON.stringify(receipt, null, wantJson ? 0 : 2))
    process.exitCode = 0
  }
} catch (e) {
  console.error(e instanceof Error ? e.stack || e.message : e)
  process.exitCode = 1
} finally {
  // Drain MySQL pool so the CLI can exit (open pool handles keep the event loop alive).
  try {
    const dbMod = await server.ssrLoadModule('/src/server/db.ts').catch(() => null)
    if (dbMod && typeof dbMod.closeDbPool === 'function') {
      await dbMod.closeDbPool()
    }
  } catch {
    /* ignore pool close errors on teardown */
  }
  try {
    await server.close()
  } catch {
    /* ignore vite close errors on teardown */
  }
  // Hard exit: vite middleware mode + mysql keep-alives can otherwise hang indefinitely.
  process.exit(process.exitCode ?? 0)
}
