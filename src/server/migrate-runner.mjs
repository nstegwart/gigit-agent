/**
 * Thin Node entry for migrate-cli.ts via Vite SSR (no tsx dependency).
 * Usage: node src/server/migrate-runner.mjs <plan|dry-run|apply|status> [flags]
 *
 * Fail-closed: sets process.exitCode from CLI and exits after Vite teardown so
 * open handles cannot leave a non-zero/hanging post-JSON process.
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

const server = await createServer({
  server: { middlewareMode: true },
  appType: 'custom',
  configFile: false,
  root,
  logLevel: 'error',
  // Avoid Vite dep-optimizer scanning app/router graph (breaks offline plan in some trees).
  optimizeDeps: { noDiscovery: true, include: [] },
  ssr: {
    // Keep SSR resolution on-disk; do not prebundle tanstack start entry stubs.
    external: true,
  },
  resolve: {
    alias: [{ find: /^#\//, replacement: `${root}/src/` }],
  },
})

let code = 1
try {
  const mod = await server.ssrLoadModule('/src/server/migrate-cli.ts')
  const result = await mod.main(process.argv.slice(2))
  code = typeof result === 'number' ? result : 0
} catch (e) {
  console.error(e instanceof Error ? e.stack || e.message : e)
  code = 1
} finally {
  try {
    await server.close()
  } catch (teardownErr) {
    // Teardown failure must not exit 0 after a successful main, and must not
    // hide a prior load/main non-zero code (stay non-zero either way).
    console.error(
      teardownErr instanceof Error
        ? teardownErr.stack || teardownErr.message
        : teardownErr,
    )
    if (code === 0) code = 1
  }
}

process.exit(code)
