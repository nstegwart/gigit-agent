#!/usr/bin/env node
/**
 * Thin Node entry for human-display-backfill.ts via Vite SSR (no tsx dependency).
 *
 * Usage:
 *   node scripts/human-display-backfill.mjs --dry-run --fixture qa/fixtures/staging
 *   node scripts/human-display-backfill.mjs --dry-run --fixture qa/fixtures/staging --json
 *   node scripts/human-display-backfill.mjs --dry-run --fixture qa/fixtures/staging --write-coverage path.json
 *
 * Dry-run only: plans source-grounded humanDisplay backfill + emits coverage
 * (byReviewStatus + contentDebt). Does not write to MySQL or restart services.
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

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
  const mod = await server.ssrLoadModule('/src/server/human-display-backfill.ts')
  if (typeof mod.main !== 'function') {
    console.error('human-display-backfill: main() not exported')
    process.exitCode = 1
  } else {
    const code = await mod.main(process.argv.slice(2))
    process.exitCode = typeof code === 'number' ? code : 0
  }
} catch (e) {
  console.error(e instanceof Error ? e.stack || e.message : e)
  process.exitCode = 1
} finally {
  await server.close()
}
