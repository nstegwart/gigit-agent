import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

/**
 * Integration harness (real disposable MySQL, node env).
 * Default vitest.config.ts stays unit-only (src + tests/unit).
 * Run: pnpm test:integration
 */
const src = fileURLToPath(new URL('./src', import.meta.url))

export default defineConfig({
  resolve: {
    alias: [{ find: /^#\//, replacement: `${src}/` }],
  },
  test: {
    environment: 'node',
    globals: true,
    include: ['tests/integration/**/*.{test,spec}.{ts,tsx}'],
    exclude: ['node_modules/**', 'dist/**', 'tests/e2e/**', 'tests/unit/**'],
    // Integration suites own long-lived pools / disposable DBs; keep sequential by default.
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
})
