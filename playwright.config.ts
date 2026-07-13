import { defineConfig, devices } from '@playwright/test'
import path from 'node:path'

/**
 * C3-F5 harness foundation.
 * - WEB_BASE: browser base URL (default http://127.0.0.1:3210)
 * - HEADED=1|true: headed Chromium
 * - CAIRN_E2E_USERNAME / CAIRN_E2E_PASSWORD: fail-closed auth for setup-auth + viewport projects
 *
 * Existing 21 specs run under project `chromium` without forced storageState (not rewritten).
 * Contract harness (no auth file): *.contract.harness.spec.ts
 * Authenticated multi-viewport: *.auth.harness.spec.ts + setup-auth dependency
 */

const PORT = Number(process.env.PORT || 3210)
const WEB_BASE = (process.env.WEB_BASE?.trim() || `http://127.0.0.1:${PORT}`).replace(
  /\/$/,
  '',
)
const HEADED =
  process.env.HEADED === '1' ||
  process.env.HEADED === 'true' ||
  process.env.HEADED === 'yes'

const AUTH_STORAGE_STATE = path.join('qa/e2e/fixtures/storage/admin.json')

// E2E runs against the PRODUCTION build served by `vite preview` (not the dev
// watcher). Build first (`pnpm build`), then `pnpm test:e2e`.
// When WEB_BASE points at an already-running server (e.g. staging tunnel), skip webServer.
// CAIRN_E2E_SKIP_WEBSERVER=1 skips auto-preview (harness-contract / external base).
const skipWebServer =
  process.env.CAIRN_E2E_SKIP_WEBSERVER === '1' ||
  process.env.CAIRN_E2E_SKIP_WEBSERVER === 'true'
const useLocalWebServer =
  !skipWebServer &&
  (!process.env.WEB_BASE ||
    WEB_BASE === `http://127.0.0.1:${PORT}` ||
    WEB_BASE === `http://localhost:${PORT}`)

const viewportProject = (
  name: string,
  viewport: { width: number; height: number },
) => ({
  name,
  dependencies: ['setup-auth'],
  testMatch: /fixtures\/.*\.auth\.harness\.spec\.ts/,
  use: {
    browserName: 'chromium' as const,
    viewport,
    storageState: AUTH_STORAGE_STATE,
  },
})

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: process.env.CI ? 2 : undefined,
  reporter: [['list']],
  use: {
    baseURL: WEB_BASE,
    headless: !HEADED,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: useLocalWebServer
    ? {
        command: `pnpm preview --port ${PORT} --strictPort`,
        url: WEB_BASE,
        reuseExistingServer: true,
        timeout: 120_000,
      }
    : undefined,
  projects: [
    {
      name: 'setup-auth',
      testMatch: /fixtures\/auth\.setup\.ts/,
    },
    {
      // Existing 21 product specs — unchanged imports; no storageState forced.
      name: 'chromium',
      testIgnore: [/fixtures\//],
      use: { ...devices['Desktop Chrome'] },
    },
    {
      // Foundation contract checks — no credentials / no storageState required.
      name: 'harness-contract',
      testMatch: /fixtures\/.*\.contract\.harness\.spec\.ts/,
      use: {
        browserName: 'chromium',
        viewport: { width: 1440, height: 900 },
      },
    },
    viewportProject('chromium-1440', { width: 1440, height: 900 }),
    viewportProject('chromium-1024', { width: 1024, height: 768 }),
    viewportProject('chromium-390', { width: 390, height: 844 }),
    viewportProject('chromium-360', { width: 360, height: 800 }),
  ],
})
