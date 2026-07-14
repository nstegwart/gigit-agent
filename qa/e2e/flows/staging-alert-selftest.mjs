/**
 * Staging alert / observability self-test harness (AC-OPS-03 drill).
 *
 * Run: node qa/e2e/flows/staging-alert-selftest.mjs [--self-test|--real]
 * (no shebang — keeps vitest/vite transform from choking on #! after inject)
 *
 * Default: --self-test (in-process memory registry only; no live mutation).
 * Exercises sanctioned product hooks:
 *   createObservabilityIntegration / evaluateAlerts / alerts registry /
 *   setSharedObservabilityIntegrationForTests / selfTest / V3_ALERT_IDS / STAGING_RUNBOOKS
 *
 * Fail-closed when authorized hooks are missing or incomplete.
 *
 * Modes:
 *   --self-test | --contract | (default)  pure in-process alert activation drill
 *   --real                               optional read-only signal harvest from
 *                                        STAGING_URL healthz/public-snapshot →
 *                                        evaluate in-process only (never mutates remote)
 *
 * Env (self-test hook load):
 *   STAGING_ALERT_HOOKS_MODULE   optional absolute path to a module exporting hooks
 *                                (tests inject hooks directly; CLI may use vite SSR)
 *
 * Env (--real, optional, read-only):
 *   WEB_BASE / STAGING_URL
 *   BOARD_ID                     default mfs-rebuild
 *   STAGING_BEARER_TOKEN | STAGING_BEARER | CAIRN_MCP_BEARER  auth healthz only
 *   PUBLICATION_INTERVAL_MS      default 60000 (for freshness eval when age known)
 *
 * Never prints credentials. Exit 0 only when selected mode fully passes.
 *
 * Usage:
 *   node qa/e2e/flows/staging-alert-selftest.mjs
 *   node qa/e2e/flows/staging-alert-selftest.mjs --self-test
 *   WEB_BASE=http://127.0.0.1:33211 node qa/e2e/flows/staging-alert-selftest.mjs --real
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve as pathResolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '../../..')

/** Alert drills required by AC-OPS-03 / observability receipt (w60_26). */
export const REQUIRED_ALERT_DRILLS = Object.freeze([
  {
    id: 'UNHEALTHY_RELEASE_SCHEMA_MISMATCH',
    runbookId: 'rb-release-schema-mismatch',
    description: 'healthz release/schema mismatch',
  },
  {
    id: 'PUBLIC_FRESHNESS_STALE',
    runbookId: 'rb-public-freshness-stale',
    description: 'public freshness > 2 publication intervals',
  },
  {
    id: 'REPEATED_IMPORT_RECONCILE_FAILURE',
    runbookId: 'rb-import-reconcile-failure',
    description: 'import/reconcile failure threshold',
  },
  {
    id: 'LIVE_MCP_UNAUTHORIZED_EXPOSURE',
    runbookId: 'rb-mcp-unauthorized',
    description: 'live MCP unauthorized exposure',
  },
  {
    id: 'ACCOUNT_SYNC_STALE',
    runbookId: 'rb-account-sync-stale',
    description: 'account sync stale',
  },
  {
    id: 'CLAIM_LOCK_ANOMALY',
    runbookId: 'rb-claim-lock-anomaly',
    description: 'claim/lock anomaly',
  },
  {
    id: 'ERROR_LATENCY_BUDGET_BREACH',
    runbookId: 'rb-latency-budget',
    description: 'latency/error budget breach',
  },
])

export const HOOK_REQUIRED_KEYS = Object.freeze([
  'createObservabilityIntegration',
  'V3_ALERT_IDS',
  'STAGING_RUNBOOKS',
])

/** Optional sanctioned test hooks (not required for evaluate path). */
export const HOOK_OPTIONAL_KEYS = Object.freeze([
  'setSharedObservabilityIntegrationForTests',
  'resetSharedObservabilityIntegration',
  'createMemoryLogSink',
  'runbookForAlert',
])

const NOW_ISO = '2026-07-14T04:00:00.000Z'
const PUBLICATION_INTERVAL_MS = 60_000
/** age > 2 * interval → PUBLIC_FRESHNESS_STALE */
const STALE_PUBLIC_AGE_MS = 2 * PUBLICATION_INTERVAL_MS + 1
const ACCOUNT_SYNC_STALE_MS = 15 * 60 * 1000 + 1
const IMPORT_FAIL_THRESHOLD = 3

export function parseArgs(argv = process.argv.slice(2)) {
  const flags = new Set(argv.filter((a) => a.startsWith('--')))
  const real = flags.has('--real')
  const selfTest =
    flags.has('--self-test') ||
    flags.has('--contract') ||
    (!real && !flags.has('--help') && !flags.has('-h'))
  return {
    selfTest: selfTest && !real,
    real,
    help: flags.has('--help') || flags.has('-h'),
  }
}

export function printHelp() {
  console.log(`Usage:
  node qa/e2e/flows/staging-alert-selftest.mjs --self-test
  node qa/e2e/flows/staging-alert-selftest.mjs --contract
  node qa/e2e/flows/staging-alert-selftest.mjs --real   # read-only signals; in-process eval

Default is --self-test (memory registry only; no live mutation).
Fail-closed when authorized observability hooks are unavailable.
`)
}

/**
 * Validate and normalize authorized hooks. Fail-closed if incomplete.
 * @param {unknown} raw
 * @returns {{ ok: true, hooks: object } | { ok: false, code: string, missing: string[], detail: string }}
 */
export function resolveAuthorizedHooks(raw) {
  if (raw == null || typeof raw !== 'object') {
    return {
      ok: false,
      code: 'NO_AUTHORIZED_HOOK',
      missing: [...HOOK_REQUIRED_KEYS],
      detail: 'hooks object is null/undefined — refuse open self-test without product integration',
    }
  }
  const missing = []
  for (const k of HOOK_REQUIRED_KEYS) {
    if (!(k in raw) || raw[k] == null) missing.push(k)
  }
  if (typeof raw.createObservabilityIntegration !== 'function') {
    if (!missing.includes('createObservabilityIntegration')) {
      missing.push('createObservabilityIntegration')
    }
  }
  if (!Array.isArray(raw.V3_ALERT_IDS) || raw.V3_ALERT_IDS.length === 0) {
    if (!missing.includes('V3_ALERT_IDS')) missing.push('V3_ALERT_IDS')
  }
  if (!Array.isArray(raw.STAGING_RUNBOOKS) || raw.STAGING_RUNBOOKS.length === 0) {
    if (!missing.includes('STAGING_RUNBOOKS')) missing.push('STAGING_RUNBOOKS')
  }
  if (missing.length > 0) {
    return {
      ok: false,
      code: 'NO_AUTHORIZED_HOOK',
      missing,
      detail: `authorized observability hooks incomplete: missing ${missing.join(',')}`,
    }
  }
  return { ok: true, hooks: raw }
}

export function checkResult(name, pass, detail = {}) {
  return { name, pass: Boolean(pass), detail }
}

/**
 * Signal payloads that MUST activate each required alert (in-process only).
 */
export function buildBreachSignals(nowIso = NOW_ISO) {
  return {
    nowIso,
    releaseMatch: false,
    schemaMatch: false,
    publicSnapshotAgeMs: STALE_PUBLIC_AGE_MS,
    publicationIntervalMs: PUBLICATION_INTERVAL_MS,
    p95LatencyMs: 900,
    errorRate: 0.05,
    repeatedImportReconcileFailures: IMPORT_FAIL_THRESHOLD,
    liveMcpUnauthorizedExposure: true,
    accountSyncAgeMs: ACCOUNT_SYNC_STALE_MS,
    claimLockAnomaly: true,
  }
}

/**
 * Signal payloads that MUST clear all alerts to inactive.
 */
export function buildHealthySignals(nowIso = NOW_ISO) {
  return {
    nowIso,
    releaseMatch: true,
    schemaMatch: true,
    publicSnapshotAgeMs: 1_000,
    publicationIntervalMs: PUBLICATION_INTERVAL_MS,
    p95LatencyMs: 40,
    errorRate: 0,
    repeatedImportReconcileFailures: 0,
    liveMcpUnauthorizedExposure: false,
    accountSyncAgeMs: 1_000,
    claimLockAnomaly: false,
  }
}

/**
 * Single-axis breach signals for targeted drills (one alert family active).
 */
export function buildTargetedBreachSignals(alertId, nowIso = NOW_ISO) {
  const base = buildHealthySignals(nowIso)
  switch (alertId) {
    case 'UNHEALTHY_RELEASE_SCHEMA_MISMATCH':
      return { ...base, releaseMatch: false, schemaMatch: true }
    case 'PUBLIC_FRESHNESS_STALE':
      return {
        ...base,
        publicSnapshotAgeMs: STALE_PUBLIC_AGE_MS,
        publicationIntervalMs: PUBLICATION_INTERVAL_MS,
      }
    case 'REPEATED_IMPORT_RECONCILE_FAILURE':
      return { ...base, repeatedImportReconcileFailures: IMPORT_FAIL_THRESHOLD }
    case 'LIVE_MCP_UNAUTHORIZED_EXPOSURE':
      return { ...base, liveMcpUnauthorizedExposure: true }
    case 'ACCOUNT_SYNC_STALE':
      return { ...base, accountSyncAgeMs: ACCOUNT_SYNC_STALE_MS }
    case 'CLAIM_LOCK_ANOMALY':
      return { ...base, claimLockAnomaly: true }
    case 'ERROR_LATENCY_BUDGET_BREACH':
      return { ...base, p95LatencyMs: 900, errorRate: 0.05 }
    default:
      return base
  }
}

/**
 * Core self-test: uses memory-only integration + read-only registry assertions.
 * Never mutates remote staging.
 *
 * @param {object} hooks authorized product hooks
 * @returns {{ ok: boolean, results: Array, residualGaps: string[], summary: object }}
 */
export function runAlertSelfTest(hooks) {
  const gate = resolveAuthorizedHooks(hooks)
  if (!gate.ok) {
    return {
      ok: false,
      code: gate.code,
      results: [
        checkResult('authorized-hooks', false, {
          code: gate.code,
          missing: gate.missing,
          detail: gate.detail,
        }),
      ],
      residualGaps: [gate.detail],
      summary: { passCount: 0, failCount: 1, total: 1 },
    }
  }

  const {
    createObservabilityIntegration,
    V3_ALERT_IDS,
    STAGING_RUNBOOKS,
    setSharedObservabilityIntegrationForTests,
    resetSharedObservabilityIntegration,
    createMemoryLogSink,
    runbookForAlert,
  } = gate.hooks

  const results = []
  const residualGaps = []

  // --- Catalog parity ---
  const alertIdSet = new Set(V3_ALERT_IDS)
  const drillIds = REQUIRED_ALERT_DRILLS.map((d) => d.id)
  const missingDrills = drillIds.filter((id) => !alertIdSet.has(id))
  results.push(
    checkResult('catalog-v3-alert-ids', missingDrills.length === 0, {
      expected: drillIds,
      present: [...V3_ALERT_IDS],
      missing: missingDrills,
    }),
  )

  const runbookByAlert = new Map(STAGING_RUNBOOKS.map((r) => [r.alertId, r]))
  const missingRunbooks = drillIds.filter((id) => !runbookByAlert.has(id))
  results.push(
    checkResult('catalog-runbooks-1to1', missingRunbooks.length === 0, {
      runbookCount: STAGING_RUNBOOKS.length,
      missing: missingRunbooks,
    }),
  )

  // --- Foundation selfTest() if available ---
  {
    const obsProbe = createObservabilityIntegration({
      nowIso: () => NOW_ISO,
      nowMs: () => 1_000_000,
    })
    if (typeof obsProbe.selfTest === 'function') {
      const st = obsProbe.selfTest()
      results.push(
        checkResult('integration-selfTest', st.ok === true, {
          metricCategoriesCovered: st.metricCategoriesCovered,
          alertsWithRunbooks: st.alertsWithRunbooks,
          residualGaps: st.residualGaps,
        }),
      )
      if (Array.isArray(st.residualGaps)) {
        for (const g of st.residualGaps) residualGaps.push(g)
      }
    } else {
      results.push(
        checkResult('integration-selfTest', false, {
          detail: 'selfTest method missing on integration instance',
        }),
      )
    }
  }

  // --- Full breach: all 7 active + runbook linked + registry readback ---
  {
    const sink = typeof createMemoryLogSink === 'function' ? createMemoryLogSink() : undefined
    const obs = createObservabilityIntegration({
      ...(sink ? { sink } : {}),
      nowIso: () => NOW_ISO,
      nowMs: () => 2_000_000,
    })

    // Sanctioned shared-hook install (test-only API) when present
    if (typeof setSharedObservabilityIntegrationForTests === 'function') {
      setSharedObservabilityIntegrationForTests(obs)
    }

    try {
      if (typeof obs.evaluateAlerts !== 'function') {
        results.push(
          checkResult('evaluateAlerts-present', false, {
            detail: 'integration.evaluateAlerts is not a function',
          }),
        )
      } else {
        results.push(checkResult('evaluateAlerts-present', true, {}))

        const breachEvals = obs.evaluateAlerts(buildBreachSignals(NOW_ISO))
        const byId = new Map(breachEvals.map((e) => [e.alertId, e]))

        for (const drill of REQUIRED_ALERT_DRILLS) {
          const e = byId.get(drill.id)
          const reg = obs.alerts?.get?.(drill.id) ?? null
          const active =
            e?.state?.active === true &&
            reg?.active === true &&
            e?.runbookId === drill.runbookId &&
            e?.runbook != null &&
            e.runbook.runbookId === drill.runbookId &&
            Array.isArray(e.runbook.steps) &&
            e.runbook.steps.length > 0
          results.push(
            checkResult(`breach-${drill.id}`, active, {
              description: drill.description,
              evalActive: e?.state?.active ?? null,
              registryActive: reg?.active ?? null,
              runbookId: e?.runbookId ?? null,
              expectedRunbookId: drill.runbookId,
              hasRunbookSteps: Array.isArray(e?.runbook?.steps)
                ? e.runbook.steps.length
                : 0,
            }),
          )
        }

        const activeList =
          typeof obs.alerts?.listActive === 'function' ? obs.alerts.listActive() : []
        results.push(
          checkResult('registry-listActive-breach', activeList.length === V3_ALERT_IDS.length, {
            activeCount: activeList.length,
            expected: V3_ALERT_IDS.length,
          }),
        )

        // Healthy clear — read-only registry must show no actives
        const healthyEvals = obs.evaluateAlerts(buildHealthySignals(NOW_ISO))
        const allInactive = healthyEvals.every((e) => e.state.active === false)
        const activeAfter =
          typeof obs.alerts?.listActive === 'function' ? obs.alerts.listActive() : []
        results.push(
          checkResult('clear-all-healthy', allInactive && activeAfter.length === 0, {
            evalCount: healthyEvals.length,
            activeAfter: activeAfter.length,
          }),
        )
      }
    } finally {
      if (typeof setSharedObservabilityIntegrationForTests === 'function') {
        setSharedObservabilityIntegrationForTests(null)
      }
      if (typeof resetSharedObservabilityIntegration === 'function') {
        resetSharedObservabilityIntegration()
      }
    }
  }

  // --- Targeted single-alert drills (isolation) ---
  {
    const obs = createObservabilityIntegration({
      nowIso: () => NOW_ISO,
      nowMs: () => 3_000_000,
    })
    for (const drill of REQUIRED_ALERT_DRILLS) {
      const evals = obs.evaluateAlerts(buildTargetedBreachSignals(drill.id, NOW_ISO))
      const byId = new Map(evals.map((e) => [e.alertId, e]))
      const target = byId.get(drill.id)
      const othersActive = evals.filter(
        (e) => e.alertId !== drill.id && e.state.active === true,
      )
      // evaluateAlerts only emits evaluators for provided signal keys; targeted payload
      // still supplies full signal set (healthy + one breach). Expect only target active.
      const pass =
        target?.state?.active === true &&
        target.runbookId === drill.runbookId &&
        othersActive.length === 0
      results.push(
        checkResult(`targeted-${drill.id}`, pass, {
          targetActive: target?.state?.active ?? null,
          othersActive: othersActive.map((e) => e.alertId),
          runbookId: target?.runbookId ?? null,
        }),
      )
    }
  }

  // Optional runbookForAlert parity
  if (typeof runbookForAlert === 'function') {
    const bad = []
    for (const drill of REQUIRED_ALERT_DRILLS) {
      const rb = runbookForAlert(drill.id)
      if (!rb || rb.runbookId !== drill.runbookId || rb.alertId !== drill.id) {
        bad.push(drill.id)
      }
    }
    results.push(
      checkResult('runbookForAlert-parity', bad.length === 0, { bad }),
    )
  }

  // Document residual: product path still does not auto-call evaluateAlerts on routes
  residualGaps.push(
    'product routes (healthz/public-snapshot/mcp) do not auto-call evaluateAlerts — this harness drills in-process registry only',
  )
  residualGaps.push(
    'no live staging alert activation on remote process without product wire (see w60_26 residual)',
  )

  const failCount = results.filter((r) => !r.pass).length
  const passCount = results.filter((r) => r.pass).length
  return {
    ok: failCount === 0,
    code: failCount === 0 ? 'SELF_TEST_PASS' : 'SELF_TEST_FAIL',
    results,
    residualGaps,
    summary: {
      passCount,
      failCount,
      total: results.length,
      alertDrills: REQUIRED_ALERT_DRILLS.length,
    },
  }
}

/**
 * Fail-closed probe: calling without hooks must not soft-pass.
 */
export function runFailClosedNoHookProbe() {
  const r = runAlertSelfTest(null)
  const authorized = r.results.find((x) => x.name === 'authorized-hooks')
  const pass =
    r.ok === false &&
    r.code === 'NO_AUTHORIZED_HOOK' &&
    authorized?.pass === false
  return {
    ok: pass,
    results: [
      checkResult('fail-closed-no-hook', pass, {
        code: r.code,
        authorizedPass: authorized?.pass ?? null,
      }),
    ],
    summary: { passCount: pass ? 1 : 0, failCount: pass ? 0 : 1, total: 1 },
  }
}

/**
 * Dynamic import that avoids static `import('vite')` so vitest transform
 * does not inject /@vite/client into this pure harness module.
 */
function dynamicImport(specifier) {
  // eslint-disable-next-line no-new-func
  return new Function('s', 'return import(s)')(specifier)
}

/**
 * Load product observability hooks via vite SSR (CLI path).
 * Read-only import of sanctioned module; no product source mutation.
 */
export async function loadProductHooksViaVite(root = ROOT) {
  const { createServer } = await dynamicImport('vite')
  const server = await createServer({
    root,
    logLevel: 'error',
    server: { middlewareMode: true },
    appType: 'custom',
    resolve: {
      alias: [{ find: /^#\//, replacement: `${join(root, 'src')}/` }],
    },
  })
  try {
    const mod = await server.ssrLoadModule('/src/server/observability-integration.ts')
    return {
      createObservabilityIntegration: mod.createObservabilityIntegration,
      V3_ALERT_IDS: mod.V3_ALERT_IDS,
      STAGING_RUNBOOKS: mod.STAGING_RUNBOOKS,
      setSharedObservabilityIntegrationForTests: mod.setSharedObservabilityIntegrationForTests,
      resetSharedObservabilityIntegration: mod.resetSharedObservabilityIntegration,
      createMemoryLogSink: mod.createMemoryLogSink,
      runbookForAlert: mod.runbookForAlert,
      _viteServer: server,
    }
  } catch (e) {
    await server.close().catch(() => {})
    throw e
  }
}

export async function loadHooksFromModulePath(modulePath) {
  const mod = await import(pathToFileURL(modulePath).href)
  return {
    createObservabilityIntegration: mod.createObservabilityIntegration,
    V3_ALERT_IDS: mod.V3_ALERT_IDS,
    STAGING_RUNBOOKS: mod.STAGING_RUNBOOKS,
    setSharedObservabilityIntegrationForTests: mod.setSharedObservabilityIntegrationForTests,
    resetSharedObservabilityIntegration: mod.resetSharedObservabilityIntegration,
    createMemoryLogSink: mod.createMemoryLogSink,
    runbookForAlert: mod.runbookForAlert,
  }
}

/**
 * Resolve hooks: injected > STAGING_ALERT_HOOKS_MODULE > vite SSR product path.
 * Fail-closed if none succeed.
 */
export async function resolveHooksForCli(injected = null) {
  if (injected != null) {
    const g = resolveAuthorizedHooks(injected)
    if (!g.ok) return { ...g, hooks: null, source: 'injected' }
    return { ok: true, hooks: g.hooks, source: 'injected' }
  }

  const envPath = process.env.STAGING_ALERT_HOOKS_MODULE
  if (envPath && String(envPath).trim()) {
    try {
      const h = await loadHooksFromModulePath(String(envPath).trim())
      const g = resolveAuthorizedHooks(h)
      if (!g.ok) return { ...g, hooks: null, source: 'STAGING_ALERT_HOOKS_MODULE' }
      return { ok: true, hooks: g.hooks, source: 'STAGING_ALERT_HOOKS_MODULE' }
    } catch (e) {
      return {
        ok: false,
        code: 'NO_AUTHORIZED_HOOK',
        missing: [...HOOK_REQUIRED_KEYS],
        detail: `STAGING_ALERT_HOOKS_MODULE load failed: ${String(e?.message || e)}`,
        hooks: null,
        source: 'STAGING_ALERT_HOOKS_MODULE',
      }
    }
  }

  try {
    const h = await loadProductHooksViaVite(ROOT)
    const g = resolveAuthorizedHooks(h)
    if (!g.ok) {
      if (h._viteServer) await h._viteServer.close().catch(() => {})
      return { ...g, hooks: null, source: 'vite-ssr' }
    }
    return {
      ok: true,
      hooks: g.hooks,
      source: 'vite-ssr',
      cleanup: async () => {
        if (h._viteServer) await h._viteServer.close().catch(() => {})
      },
    }
  } catch (e) {
    return {
      ok: false,
      code: 'NO_AUTHORIZED_HOOK',
      missing: [...HOOK_REQUIRED_KEYS],
      detail: `vite SSR load of observability-integration failed: ${String(e?.message || e)}`,
      hooks: null,
      source: 'vite-ssr',
    }
  }
}

function resolveBearer() {
  for (const k of ['STAGING_BEARER_TOKEN', 'STAGING_BEARER', 'CAIRN_MCP_BEARER']) {
    const v = process.env[k]
    if (v && String(v).trim()) return String(v).trim()
  }
  return null
}

function resolveBaseUrl() {
  return (
    process.env.WEB_BASE ||
    process.env.STAGING_URL ||
    'http://127.0.0.1:33211'
  )
}

async function fetchJson(url, init = {}) {
  const res = await fetch(url, {
    ...init,
    headers: {
      accept: 'application/json',
      ...(init.headers || {}),
    },
    redirect: 'manual',
  })
  const text = await res.text()
  let body = null
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    body = null
  }
  return { status: res.status, body, text, headers: res.headers }
}

/**
 * Read-only real probe: harvest healthz/public signals → evaluateAlerts in-process.
 * Never mutates remote; never writes alert state to staging.
 */
export async function runRealReadOnlyAlertProbe(hooks, opts = {}) {
  const gate = resolveAuthorizedHooks(hooks)
  if (!gate.ok) {
    return {
      ok: false,
      code: gate.code,
      results: [
        checkResult('authorized-hooks', false, {
          code: gate.code,
          missing: gate.missing,
          detail: gate.detail,
        }),
      ],
      residualGaps: [gate.detail],
      summary: { passCount: 0, failCount: 1, total: 1 },
    }
  }

  const base = opts.baseUrl || resolveBaseUrl()
  const boardId = opts.boardId || process.env.BOARD_ID || 'mfs-rebuild'
  const bearer = opts.bearer !== undefined ? opts.bearer : resolveBearer()
  const results = []
  const residualGaps = []

  // Unauth healthz should be 401 (listen proof) — not an alert activation
  {
    const r = await fetchJson(`${base}/api/healthz`)
    results.push(
      checkResult('real-healthz-unauth', r.status === 401, {
        status: r.status,
        code: r.body?.code ?? null,
      }),
    )
  }

  let releaseMatch
  let schemaMatch
  let publicSnapshotAgeMs
  let publicationIntervalMs = Number(process.env.PUBLICATION_INTERVAL_MS) || 60_000

  if (bearer) {
    const r = await fetchJson(`${base}/api/healthz`, {
      headers: { authorization: `Bearer ${bearer}` },
    })
    const body = r.body || {}
    releaseMatch =
      body.release?.match === true ||
      body.releaseMatch === true ||
      (body.release?.match === false ? false : undefined)
    schemaMatch =
      body.schema?.match === true ||
      body.schemaMatch === true ||
      (body.schema?.match === false ? false : undefined)
    // Prefer explicit booleans; also derive from nested when present
    if (typeof body.release?.match === 'boolean') releaseMatch = body.release.match
    if (typeof body.schema?.match === 'boolean') schemaMatch = body.schema.match

    results.push(
      checkResult(
        'real-healthz-auth',
        r.status === 200 || r.status === 503,
        {
          status: r.status,
          hasDeployedSha: Boolean(body.deployedSha),
          releaseMatch: releaseMatch ?? null,
          schemaMatch: schemaMatch ?? null,
          schemaVersion: body.schema?.version ?? body.schemaVersion ?? null,
        },
      ),
    )
  } else {
    results.push(
      checkResult('real-healthz-auth', false, {
        skipped: false,
        detail: 'no bearer env — cannot read auth healthz release/schema for live signals',
        code: 'MISSING_BEARER',
      }),
    )
    residualGaps.push('real mode missing bearer; auth healthz release/schema not harvested')
  }

  {
    const r = await fetchJson(
      `${base}/api/public-snapshot?boardId=${encodeURIComponent(boardId)}`,
    )
    const body = r.body || {}
    const freshness = body.freshness || body.pin?.freshness || null
    if (freshness && typeof freshness.ageMs === 'number') {
      publicSnapshotAgeMs = freshness.ageMs
    } else if (typeof body.ageMs === 'number') {
      publicSnapshotAgeMs = body.ageMs
    }
    if (typeof body.publicationIntervalMs === 'number') {
      publicationIntervalMs = body.publicationIntervalMs
    } else if (typeof freshness?.publicationIntervalMs === 'number') {
      publicationIntervalMs = freshness.publicationIntervalMs
    }
    results.push(
      checkResult('real-public-snapshot', r.status === 200 || r.status === 503, {
        status: r.status,
        publicSnapshotAgeMs: publicSnapshotAgeMs ?? null,
        publicationIntervalMs,
        stale: freshness?.stale ?? body.stale ?? null,
      }),
    )
  }

  // In-process evaluate from harvested signals only (memory registry)
  const { createObservabilityIntegration } = gate.hooks
  const obs = createObservabilityIntegration({
    nowIso: () => new Date().toISOString(),
    nowMs: () => Date.now(),
  })
  const input = { nowIso: new Date().toISOString() }
  if (typeof releaseMatch === 'boolean') input.releaseMatch = releaseMatch
  if (typeof schemaMatch === 'boolean') input.schemaMatch = schemaMatch
  if (typeof publicSnapshotAgeMs === 'number') {
    input.publicSnapshotAgeMs = publicSnapshotAgeMs
    input.publicationIntervalMs = publicationIntervalMs
  }

  const signalKeys = Object.keys(input).filter((k) => k !== 'nowIso')
  if (signalKeys.length === 0) {
    results.push(
      checkResult('real-evaluate-from-signals', false, {
        detail: 'no harvestable release/schema/freshness signals for evaluateAlerts',
      }),
    )
  } else {
    const evals = obs.evaluateAlerts(input)
    const active = evals.filter((e) => e.state.active)
    results.push(
      checkResult('real-evaluate-from-signals', true, {
        signalKeys,
        evalCount: evals.length,
        activeAlertIds: active.map((e) => e.alertId),
        // Informational — live may be healthy (active empty) or firing
        note: 'read-only harvest; in-process registry only; remote not mutated',
      }),
    )
  }

  residualGaps.push(
    'real mode is signal harvest + in-process evaluate only; does not prove remote alert wire',
  )

  const failCount = results.filter((r) => !r.pass).length
  return {
    ok: failCount === 0,
    code: failCount === 0 ? 'REAL_READONLY_PASS' : 'REAL_READONLY_FAIL',
    results,
    residualGaps,
    summary: {
      passCount: results.filter((r) => r.pass).length,
      failCount,
      total: results.length,
    },
  }
}

export function writeReceipt(payload) {
  const outDir = join(ROOT, 'qa/e2e/out/runtime')
  try {
    mkdirSync(outDir, { recursive: true })
    const name = `staging-alert-selftest-${payload.mode}-${Date.now()}.json`
    const path = join(outDir, name)
    const text = JSON.stringify(payload, null, 2)
    if (/Bearer\s+[A-Za-z0-9._\-+/=]{20,}/i.test(text)) {
      throw new Error('REFUSING to write receipt: bearer-like material detected')
    }
    writeFileSync(path, text, { mode: 0o600 })
    return path
  } catch (e) {
    console.error('receipt write skipped:', String(e?.message || e))
    return null
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    printHelp()
    process.exit(0)
  }

  const mode = args.real ? 'real' : 'self-test'
  console.log(
    `OWNER_TARGET: ${JSON.stringify({
      base_url: mode === 'real' ? resolveBaseUrl() : 'mock://self-test',
      port:
        mode === 'real'
          ? (() => {
              try {
                return new URL(resolveBaseUrl()).port || null
              } catch {
                return null
              }
            })()
          : null,
      account: mode === 'real' ? (resolveBearer() ? 'bearer=set' : 'bearer=UNSET') : 'SYNTH_SELF_TEST',
      device: 'n/a-alert-selftest',
      mode,
    })}`,
  )

  // Always prove fail-closed path first
  const failClosed = runFailClosedNoHookProbe()
  if (!failClosed.ok) {
    const receiptPath = writeReceipt({
      mode,
      ok: false,
      code: 'FAIL_CLOSED_PROBE_BROKEN',
      failClosed,
      at: new Date().toISOString(),
    })
    console.log(
      JSON.stringify(
        { mode, ok: false, code: 'FAIL_CLOSED_PROBE_BROKEN', failClosed, receiptPath },
        null,
        2,
      ),
    )
    process.exit(1)
  }

  const resolved = await resolveHooksForCli(null)
  if (!resolved.ok) {
    const payload = {
      mode,
      ok: false,
      code: 'NO_AUTHORIZED_HOOK',
      detail: resolved.detail,
      missing: resolved.missing,
      source: resolved.source,
      failClosedOk: true,
      at: new Date().toISOString(),
    }
    const receiptPath = writeReceipt(payload)
    console.log(JSON.stringify({ ...payload, receiptPath }, null, 2))
    process.exit(1)
  }

  try {
    let result
    if (mode === 'self-test') {
      result = runAlertSelfTest(resolved.hooks)
    } else {
      // real: still run full self-test first (in-process), then optional read-only harvest
      const self = runAlertSelfTest(resolved.hooks)
      const live = await runRealReadOnlyAlertProbe(resolved.hooks)
      result = {
        ok: self.ok && live.ok,
        code: self.ok && live.ok ? 'REAL_PASS' : 'REAL_FAIL',
        results: [
          ...self.results.map((r) => ({ ...r, name: `self:${r.name}` })),
          ...live.results.map((r) => ({ ...r, name: `real:${r.name}` })),
        ],
        residualGaps: [...(self.residualGaps || []), ...(live.residualGaps || [])],
        summary: {
          passCount:
            self.results.filter((r) => r.pass).length +
            live.results.filter((r) => r.pass).length,
          failCount:
            self.results.filter((r) => !r.pass).length +
            live.results.filter((r) => !r.pass).length,
          total: self.results.length + live.results.length,
        },
      }
    }

    const receiptPath = writeReceipt({
      mode,
      ok: result.ok,
      code: result.code,
      summary: result.summary,
      residualGaps: result.residualGaps,
      failed: result.results.filter((r) => !r.pass).map((r) => r.name),
      results: result.results,
      hookSource: resolved.source,
      failClosedOk: true,
      at: new Date().toISOString(),
    })

    console.log(
      JSON.stringify(
        {
          mode,
          ok: result.ok,
          code: result.code,
          summary: result.summary,
          residualGaps: result.residualGaps,
          failed: result.results.filter((r) => !r.pass).map((r) => r.name),
          hookSource: resolved.source,
          failClosedOk: true,
          receiptPath,
        },
        null,
        2,
      ),
    )
    process.exit(result.ok ? 0 : 1)
  } finally {
    if (typeof resolved.cleanup === 'function') {
      await resolved.cleanup()
    }
  }
}

function isMainModule() {
  if (!process.argv[1]) return false
  try {
    const self = fileURLToPath(import.meta.url)
    const arg = pathResolve(process.argv[1])
    return self === arg
  } catch {
    return false
  }
}

if (isMainModule()) {
  main().catch((e) => {
    console.error(
      JSON.stringify({
        ok: false,
        error: String(e?.message || e),
        class: 'STACK_OR_SCRIPT',
      }),
    )
    process.exit(1)
  })
}
