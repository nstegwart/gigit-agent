#!/usr/bin/env node
/**
 * Thin Node entry for rebuild-lineage + product-features sync
 * (SPEC TM-KOMPAT-VISUAL V1 §2 + ADDENDUM V1.1 §B).
 *
 * Usage:
 *   node scripts/sync-rebuild-data.mjs              # --dry-run (default)
 *   node scripts/sync-rebuild-data.mjs --dry-run
 *   node scripts/sync-rebuild-data.mjs --apply      # LOCAL|STAGING only; fail-closed on production
 *   node scripts/sync-rebuild-data.mjs --json
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
const wantApply = args.includes('--apply')
const wantJson = args.includes('--json')
const mode = wantApply ? 'apply' : 'dry-run'

const server = await createServer({
  server: { middlewareMode: true },
  appType: 'custom',
  configFile: false,
  root,
  logLevel: 'error',
  resolve: {
    alias: [{ find: /^#\//, replacement: `${root}/src/` }],
  },
})

try {
  const store = await server.ssrLoadModule('/src/server/rebuild-lineage-store.ts')
  const pfStore = await server.ssrLoadModule('/src/server/product-features-store.ts')
  const dbMod = await server.ssrLoadModule('/src/server/db.ts')

  const paths = store.defaultSyncPaths('/opt/mfs/workspace')
  const t0 = Date.now()
  const plan = store.buildSyncPlan(paths, mode)
  const pfPlan = pfStore.buildProductFeatureSyncPlan({
    cwd: root,
    workspaceRoot: '/opt/mfs/workspace',
    syncPaths: paths,
    mode,
  })

  if (mode === 'apply') {
    const host = dbMod.configuredDbHost()
    const hostClass = dbMod.classifyDbHost(host)
    if (!dbMod.migrationApplyAllowed(hostClass)) {
      console.error(
        JSON.stringify({
          ok: false,
          error: `APPLY_REFUSED hostClass=${hostClass} host=${host} (LOCAL|STAGING only)`,
          mode: 'apply',
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
  await server.close()
}
