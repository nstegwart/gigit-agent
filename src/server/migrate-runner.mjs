/**
 * Thin Node entry for migrate-cli.ts via Vite SSR (no tsx dependency).
 * Usage: node src/server/migrate-runner.mjs <plan|dry-run|apply|status> [flags]
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
  resolve: {
    alias: [{ find: /^#\//, replacement: `${root}/src/` }],
  },
})

try {
  const mod = await server.ssrLoadModule('/src/server/migrate-cli.ts')
  const code = await mod.main(process.argv.slice(2))
  process.exitCode = typeof code === 'number' ? code : 0
} catch (e) {
  console.error(e instanceof Error ? e.stack || e.message : e)
  process.exitCode = 1
} finally {
  await server.close()
}
