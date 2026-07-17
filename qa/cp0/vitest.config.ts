import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const here = fileURLToPath(new URL('.', import.meta.url))

export default defineConfig({
  resolve: {
    alias: {
      '#': resolve(here, '../../src'),
    },
  },
  test: {
    include: ['qa/cp0/**/*.test.ts'],
    environment: 'node',
  },
})
