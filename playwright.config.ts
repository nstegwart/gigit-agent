import { defineConfig, devices } from '@playwright/test'
import path from 'node:path'

import { ensureAuthSecretsInEnv, mcpAuthHeaders } from './qa/e2e/lib/auth-fixture.mjs'

/**
 * C3-F5 harness + IBILS auth fixture (AC-IBILS-01 green path).
 * - WEB_BASE: browser base URL (default http://127.0.0.1:3210)
 * - HEADED=1|true: headed Chromium
 * - CAIRN_E2E_USERNAME / CAIRN_E2E_PASSWORD: process-local synthetics via ensureAuthSecretsInEnv
 * - CAIRN_MCP_BEARER + CAIRN_BEARER_PRINCIPALS_JSON: process-local MCP ROOT for /mcp 401s
 * - globalSetup: clone ambient boards → iso DB (zero users) for product first-admin bootstrap
 * - chromium: depends on setup-auth storageState + MCP Authorization header
 *
 * Contract harness (no auth file): *.contract.harness.spec.ts
 * Authenticated multi-viewport: *.auth.harness.spec.ts + setup-auth dependency
 *
 * Escape: CAIRN_E2E_SKIP_ISO_AUTH=1 skips iso clone (requires external bootstrapped user).
 */

// Config-load: pin run-scoped meta/secrets paths + materialise process-local secrets
// so project.use headers resolve now. Run id propagates to webServer/globalSetup/teardown.
// DB clone remains async in start-auth-preview / globalSetup.
const authSecrets = ensureAuthSecretsInEnv()
// Export path pins into env for child processes (webServer inherits process.env).
process.env.CAIRN_E2E_AUTH_RUN_ID = authSecrets.runId
process.env.CAIRN_E2E_AUTH_RUNTIME_META_PATH = authSecrets.runtimeMetaPath
process.env.CAIRN_E2E_AUTH_SECRETS_PATH = authSecrets.secretsSidecarPath

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

/** MCP Authorization for Playwright request fixture (product specs post /mcp without headers). */
function resolveMcpExtraHeaders(): Record<string, string> {
  try {
    if (process.env.CAIRN_MCP_BEARER?.trim()) {
      return mcpAuthHeaders()
    }
  } catch {
    /* leave empty — MCP-only tests will surface 401 honestly */
  }
  return {}
}

const MCP_EXTRA_HEADERS = resolveMcpExtraHeaders()

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
    extraHTTPHeaders: { ...MCP_EXTRA_HEADERS },
  },
})

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: process.env.CI ? 2 : undefined,
  reporter: [['list']],
  globalSetup: './tests/e2e/fixtures/global-setup.ts',
  globalTeardown: './tests/e2e/fixtures/global-teardown.ts',
  use: {
    baseURL: WEB_BASE,
    headless: !HEADED,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: useLocalWebServer
    ? {
        // Prepare iso DB + secrets in the preview child (webServer may start before globalSetup).
        // Never reuse ambient preview — it lacks iso DB + synthetic principals.
        command: `node qa/e2e/lib/start-auth-preview.mjs --host 127.0.0.1 --port ${PORT}`,
        url: WEB_BASE,
        reuseExistingServer:
          process.env.CAIRN_E2E_REUSE_SERVER === '1' ||
          process.env.CAIRN_E2E_REUSE_SERVER === 'true',
        timeout: 180_000,
      }
    : undefined,
  projects: [
    {
      name: 'setup-auth',
      testMatch: /fixtures\/auth\.setup\.ts/,
    },
    {
      // Authoritative IBILS product surface (21 specs). Auth fixture wired:
      // setup-auth storageState for browser; MCP bearer for request.post('/mcp').
      name: 'chromium',
      dependencies: ['setup-auth'],
      testIgnore: [/fixtures\//],
      use: {
        ...devices['Desktop Chrome'],
        storageState: AUTH_STORAGE_STATE,
        extraHTTPHeaders: { ...MCP_EXTRA_HEADERS },
      },
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
