import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const src = fileURLToPath(new URL('./src', import.meta.url))

export default defineConfig({
  resolve: {
    alias: [{ find: /^#\//, replacement: `${src}/` }],
  },
  test: {
    environment: 'jsdom',
    globals: true,
    include: [
      'src/**/*.{test,spec}.{ts,tsx}',
      'tests/unit/**/*.{test,spec}.{ts,tsx}',
      // F2-WF-0 data-foundation specs live at tests/*.spec.ts (not under unit/)
      'tests/*.spec.ts',
    ],
    exclude: ['tests/e2e/**', 'node_modules/**', 'dist/**'],
  },
})
