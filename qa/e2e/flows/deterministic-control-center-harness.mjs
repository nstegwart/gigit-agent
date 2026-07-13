#!/usr/bin/env node
/**
 * C3-R2D / C3-R3H deterministic authenticated headed-browser proof harness.
 *
 * One bounded lifecycle: unique iso DB seed → start owned preview → bootstrap
 * login → capture matrix with auth asserts + guards → probes → cleanup.
 *
 * Modes:
 *   --self-test     pure contract checks (no MySQL / browser / server)
 *   --seed-only     create isolated DB + provenance, then exit (leaves DB)
 *   --full          full lifecycle (default when not --self-test)
 *   --no-browser    seed + server health only (no Playwright capture)
 *   --keep-db       skip DROP on cleanup (debug)
 *   --skip-axe-fail do not exit non-zero on axe critical/serious (still record)
 *
 * Env: WEB_BASE (overridden by owned server), HEADED, BOARD_ID, CAIRN_ISO_DB_NAME,
 *      CAIRN_DB_*, CAIRN_E2E_USERNAME/PASSWORD (optional; auto-synth if unset for bootstrap),
 *      FULL_SHA, CAIRN_HARNESS_PORT, CAIRN_HARNESS_OUT
 *
 * Fail-closed: route skip, login capture, blank shot, wrong dims, stale artifact,
 * missing pins for valid fixture, leftover owned process, public canary leak,
 * sticky Decision absence/obstruction, raw STALE failure, touch <44×44,
 * missing ONGOING zero-click fields, session-denial mismatch, focus/reduced-motion,
 * console/network app errors, axe critical/serious, overflow.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from '@playwright/test'

import { assertAuthenticatedOwnerShell } from '../lib/auth-assert.mjs'
import {
  loginAndSaveStorageState,
  requireExistingStorageState,
} from '../lib/auth.mjs'
import { runAxe } from '../lib/axe.mjs'
import {
  assertArtifactFresh,
  assertNotLoginCapture,
  assertScreenshotHealthy,
  clearDirContents,
} from '../lib/capture-guard.mjs'
import { dropIsolatedDatabase, databaseExists } from '../lib/db-iso.mjs'
import {
  assertFullSha,
  isFullSha,
  printOwnerTarget,
  resolveFullSha,
  resolveHeaded,
  resolveSchemaVersion,
} from '../lib/env.mjs'
import { assertFocusVisible, tabN } from '../lib/keyboard.mjs'
import { hasDocumentHorizontalOverflow } from '../lib/overflow.mjs'
import {
  accountCaptureCounts,
  assertPlannedCaptureContract,
  buildRouteMatrix,
  countPlannedCaptures,
  EXPECTED_PLANNED_CAPTURES_MFS,
  planCaptures,
  slugId,
  viewportsForRoute,
  VIEWPORTS,
  VIEWPORT_ORDER,
} from '../lib/routes-matrix.mjs'
import {
  ScreenshotManifestCollector,
  DEFAULT_MANIFEST_PATH,
  pinsFromProvenance,
  PIN_MISSING,
} from '../lib/screenshot-manifest.mjs'
import {
  pickFreePort,
  portIsFree,
  startOwnedPreviewServer,
} from '../lib/server-lifecycle.mjs'
import { resetPageZoom, setPageZoom } from '../lib/zoom.mjs'
import {
  validateFixtureContract,
  DEFAULT_BOARD_ID,
  HARNESS_PIN,
  REDACTION_CANARIES,
  SEEDED_ONGOING,
  buildHarnessPin,
  buildScenarioMatrix,
  buildDispatchPlanSeed,
  buildAccountSyncSeed,
  computeTaskHash,
  computePlanHash,
  computeLegacyAdHocPlanHash,
  CANONICAL_TASK_IDS,
} from '../fixtures/seed/control-center-fixture.mjs'
import { seedIsolatedControlCenter } from '../fixtures/seed/seed-isolated.mjs'
import {
  aggregateProbeVerdicts,
  assertProbesFailClosed,
  classifyNetworkFailure,
  evaluateConsoleNetwork,
  evaluatePublicRedaction,
  evaluateStickyDecision,
  evaluateRawStale,
  evaluateTouch,
  evaluateOngoingZeroClick,
  evaluateSessionDenial,
  evaluateFocus,
  evaluateReducedMotion,
  evaluateMobileShellContainment,
  listCanaryValues,
  partitionNetworkFailures,
} from '../lib/probe-fail-close.mjs'
import {
  bootstrapControlPlaneOnServer,
  buildChildBearerEnv,
  createSyntheticRootPrincipal,
  probeRuntimePin,
  redactSecretsDeep,
  runBootstrapContractSelfTests,
  ControlPlaneBootstrapError,
} from '../lib/control-plane-bootstrap.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '../../..')

const RUN_ID =
  process.env.CAIRN_HARNESS_RUN_ID?.trim() ||
  `c3-r2d-${new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14)}-${process.pid}`

const OUT_ROOT =
  process.env.CAIRN_HARNESS_OUT?.trim() ||
  path.join(ROOT, 'qa/e2e/out/runtime', RUN_ID)

function argFlag(name) {
  return process.argv.includes(name)
}

function ensureOutDirs() {
  for (const d of [
    '',
    'screenshots',
    'screenshots/fullpage',
    'axe',
    'logs',
    'auth',
    'probes',
  ]) {
    fs.mkdirSync(path.join(OUT_ROOT, d), { recursive: true })
  }
}

function writeJson(rel, data) {
  const p = path.join(OUT_ROOT, rel)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, JSON.stringify(data, null, 2), 'utf8')
  return p
}

/**
 * C3-C9: erase isolated harness auth material after the owned browser closes.
 * Summary contains booleans/counts only — never credentials/cookies/bearer.
 * Does NOT touch canonical qa/e2e/fixtures/storage/admin.json.
 * @param {string} authDir
 */
function eraseHarnessAuthArtifacts(authDir) {
  const summary = {
    authDirProvided: Boolean(authDir),
    erasedFileCount: 0,
    authDirAbsent: true,
    usernamePresentBefore: false,
    passwordPresentBefore: false,
    storageStatePresentBefore: false,
  }
  if (!authDir) return summary
  try {
    summary.usernamePresentBefore = fs.existsSync(path.join(authDir, 'username.txt'))
    summary.passwordPresentBefore = fs.existsSync(path.join(authDir, 'password.txt'))
    summary.storageStatePresentBefore = fs.existsSync(path.join(authDir, 'storageState.json'))
    if (fs.existsSync(authDir)) {
      for (const name of fs.readdirSync(authDir)) {
        try {
          fs.rmSync(path.join(authDir, name), { force: true })
          summary.erasedFileCount += 1
        } catch {
          /* best-effort erase */
        }
      }
      try {
        fs.rmSync(authDir, { recursive: true, force: true })
      } catch {
        /* best-effort */
      }
    }
    summary.authDirAbsent = !fs.existsSync(authDir)
  } catch {
    summary.authDirAbsent = !fs.existsSync(authDir)
  }
  return summary
}

function synthCredentials() {
  const username =
    process.env.CAIRN_E2E_USERNAME?.trim() || `synth_r2d_${crypto.randomBytes(3).toString('hex')}`
  const password =
    process.env.CAIRN_E2E_PASSWORD ||
    `Synth!${crypto.randomBytes(8).toString('base64url')}`
  return { username, password }
}

async function runSelfTest() {
  const results = []
  const ok = (name, pass, detail) => {
    results.push({ name, pass, detail })
    console.log(`${pass ? 'PASS' : 'FAIL'} self-test ${name}${detail ? ` — ${detail}` : ''}`)
  }

  const contract = validateFixtureContract()
  ok('fixture-contract', contract.ok, contract.errors?.join('; ') || `tasks=${contract.taskCount}`)
  ok(
    'fixture-classified-count',
    contract.classifiedCount === CANONICAL_TASK_IDS.length - 1,
    `classified=${contract.classifiedCount}`,
  )
  ok(
    'fixture-one-unclassified',
    contract.unclassifiedCount === 1,
    `unclassified=${contract.unclassifiedCount}`,
  )
  const expectedTaskHash = computeTaskHash(CANONICAL_TASK_IDS)
  ok(
    'fixture-taskHash-algorithm',
    contract.taskHash === expectedTaskHash && expectedTaskHash.length === 64,
    `taskHash=${String(contract.taskHash).slice(0, 16)}…`,
  )
  const pin = buildHarnessPin()
  ok(
    'fixture-pin-taskHash-parity',
    pin.taskHash === HARNESS_PIN.taskHash && pin.taskHash === expectedTaskHash,
  )
  const scenarios = buildScenarioMatrix(pin)
  ok('fixture-scenario-matrix-size', scenarios.length >= 9, `n=${scenarios.length}`)
  const scenarioIds = new Set(scenarios.map((s) => s.scenario))
  for (const need of [
    'DONE',
    'ONGOING',
    'NEXT',
    'QUEUED',
    'BLOCKED',
    'RECONCILIATION_PENDING',
    'STALE',
    'UNCLASSIFIED',
    'SALES_WEB_RELATED_BACKEND',
  ]) {
    ok(`fixture-scenario-${need}`, scenarioIds.has(need))
  }
  const dispatch = buildDispatchPlanSeed(undefined, pin)
  ok(
    'fixture-dispatch-next-item',
    dispatch.items?.[0]?.taskId === 'task-next-1' && dispatch.planHash?.length === 64,
    dispatch.planId,
  )
  // C3-R5H2: planHash must match server computePlanHash, not ad-hoc receipt string
  const expectedPlanHash = computePlanHash({
    boardId: dispatch.boardId ?? DEFAULT_BOARD_ID,
    planId: dispatch.planId,
    planVersion: dispatch.planVersion,
    canonicalSnapshotId: dispatch.canonicalSnapshotId,
    canonicalHash: dispatch.canonicalHash,
    items: dispatch.items,
  })
  ok(
    'fixture-planHash-matches-computePlanHash',
    dispatch.planHash === expectedPlanHash && /^[0-9a-f]{64}$/.test(dispatch.planHash),
    `planHash=${String(dispatch.planHash).slice(0, 16)}…`,
  )
  const legacyAdHoc = computeLegacyAdHocPlanHash(
    dispatch.planId,
    dispatch.planVersion,
    dispatch.items,
    pin.taskHash,
  )
  ok(
    'fixture-planHash-rejects-legacy-ad-hoc',
    legacyAdHoc.length === 64 && dispatch.planHash !== legacyAdHoc,
    `legacy=${legacyAdHoc.slice(0, 12)}… canonical=${dispatch.planHash.slice(0, 12)}…`,
  )
  // Normalization: rank sort + collisionScopeLockIds sort + missing portfolio → null
  const itemBase = {
    taskId: 't-norm',
    targetGate: 'G',
    role: 'Worker',
    selectionReason: 'norm',
    expectedEntityRev: 0,
    expectedBoardRev: pin.boardRev,
    dependencyProof: null,
  }
  const hashUnsorted = computePlanHash({
    boardId: DEFAULT_BOARD_ID,
    planId: 'plan-norm',
    planVersion: 1,
    canonicalSnapshotId: pin.canonicalSnapshotId,
    canonicalHash: pin.canonicalHash,
    items: [
      { ...itemBase, rank: 2, taskId: 't-b', collisionScopeLockIds: ['z', 'a'] },
      { ...itemBase, rank: 1, taskId: 't-a', collisionScopeLockIds: ['a', 'z'] },
    ],
  })
  const hashSorted = computePlanHash({
    boardId: DEFAULT_BOARD_ID,
    planId: 'plan-norm',
    planVersion: 1,
    canonicalSnapshotId: pin.canonicalSnapshotId,
    canonicalHash: pin.canonicalHash,
    items: [
      { ...itemBase, rank: 1, taskId: 't-a', collisionScopeLockIds: ['a', 'z'] },
      {
        ...itemBase,
        rank: 2,
        taskId: 't-b',
        collisionScopeLockIds: ['a', 'z'],
        priorityPortfolioId: null,
      },
    ],
  })
  ok(
    'fixture-planHash-canonical-sort-normalize',
    hashUnsorted === hashSorted && /^[0-9a-f]{64}$/.test(hashUnsorted),
    `h=${hashUnsorted.slice(0, 16)}…`,
  )
  const acc = buildAccountSyncSeed(undefined, pin)
  ok(
    'fixture-account-sync-usable-and-quarantine',
    acc.accounts.some((a) => a.status === 'ACTIVE') &&
      acc.accounts.some((a) => a.status === 'quarantine'),
    `n=${acc.accounts.length}`,
  )
  ok(
    'fixture-account-sync-readback-parity-shape',
    Boolean(acc.snapshotShape?.readbackSurfaces?.mcp?.sourceRevision),
  )

  const planned = countPlannedCaptures(DEFAULT_BOARD_ID)
  ok('route-matrix-count', planned >= 30, `plannedCaptures=${planned}`)
  try {
    const planContract = assertPlannedCaptureContract(DEFAULT_BOARD_ID)
    ok(
      'route-matrix-planned-exact',
      planContract.planned === EXPECTED_PLANNED_CAPTURES_MFS,
      `planned=${planContract.planned} expected=${EXPECTED_PLANNED_CAPTURES_MFS}`,
    )
  } catch (e) {
    ok('route-matrix-planned-exact', false, String(e?.message || e))
  }
  const bookOk = accountCaptureCounts({
    planned: EXPECTED_PLANNED_CAPTURES_MFS,
    captured: EXPECTED_PLANNED_CAPTURES_MFS,
    skipped: 0,
    error: 0,
  })
  ok('capture-bookkeeping-balanced', bookOk.consistent, JSON.stringify(bookOk))
  const bookBad = accountCaptureCounts({
    planned: 53,
    captured: 46,
    skipped: 0,
    error: 0,
  })
  ok('capture-bookkeeping-detects-mismatch', !bookBad.consistent, JSON.stringify(bookBad))

  // SHA fail-closed: full 40-char or throw — never UNKNOWN_SHA on claimed path
  try {
    const sha = assertFullSha({ cwd: ROOT })
    ok('full-sha-resolved', isFullSha(sha) && sha !== 'UNKNOWN_SHA', `sha=${sha}`)
  } catch (e) {
    ok('full-sha-resolved', false, String(e?.message || e))
  }
  const prevFull = process.env.FULL_SHA
  const prevGit = process.env.GIT_SHA
  try {
    process.env.FULL_SHA = 'deadbeef'
    process.env.GIT_SHA = ''
    let threw = false
    try {
      assertFullSha({ cwd: '/tmp' })
    } catch {
      threw = true
    }
    ok('full-sha-short-fail-closed', threw, 'short FULL_SHA must throw')
    process.env.FULL_SHA = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    const forced = resolveFullSha({ require: true })
    ok(
      'full-sha-env-accepted',
      forced === 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      forced,
    )
  } finally {
    if (prevFull === undefined) delete process.env.FULL_SHA
    else process.env.FULL_SHA = prevFull
    if (prevGit === undefined) delete process.env.GIT_SHA
    else process.env.GIT_SHA = prevGit
  }

  // Network allowlist: r5a-shaped serverFn aborts pass; API/MCP/health/document fail
  const r5aLike = [
    {
      url: 'http://127.0.0.1:64580/_serverFn/c56db81c8847ab3caaa1a44d7400eb5abcfa203694726b21774a1ab4423394d2?payload=%7B%7D',
      failure: 'net::ERR_ABORTED',
      page: 'http://127.0.0.1:64580/b/mfs-rebuild/work?bucket=ONGOING',
    },
    {
      url: 'http://127.0.0.1:64580/_serverFn/22b8e33ee1eb1d7fb9ca7998903c21024a8f5434122bdccc69a479bdeac0bc6a?payload=%7B%7D',
      failure: 'net::ERR_ABORTED',
      page: 'http://127.0.0.1:64580/b/mfs-rebuild/work?bucket=ONGOING',
    },
    {
      url: 'http://127.0.0.1:64580/_serverFn/aa54c77ee222c684de0504139dcbee93a0a2f7b4c5fa5f73d59b19d518a60546?payload=%7B%7D',
      failure: 'net::ERR_ABORTED',
      page: 'http://127.0.0.1:64580/b/mfs-rebuild/work?bucket=ONGOING',
    },
  ]
  const r5aEval = evaluateConsoleNetwork({ networkFailures: r5aLike })
  ok(
    'network-allowlist-r5a-serverFn-aborts',
    r5aEval.ok && r5aEval.networkCount === 0 && r5aEval.networkAllowlistedCount === 3,
    JSON.stringify({
      ok: r5aEval.ok,
      networkCount: r5aEval.networkCount,
      allow: r5aEval.networkAllowlistedCount,
    }),
  )
  for (const bad of [
    {
      name: 'api',
      row: {
        url: 'http://127.0.0.1:64580/api/public-snapshot?boardId=mfs-rebuild',
        failure: 'net::ERR_ABORTED',
        page: 'http://127.0.0.1:64580/b/mfs-rebuild/',
      },
    },
    {
      name: 'mcp',
      row: {
        url: 'http://127.0.0.1:64580/mcp',
        failure: 'net::ERR_ABORTED',
        page: 'http://127.0.0.1:64580/b/mfs-rebuild/',
      },
    },
    {
      name: 'health',
      row: {
        url: 'http://127.0.0.1:64580/healthz',
        failure: 'net::ERR_ABORTED',
        page: 'http://127.0.0.1:64580/b/mfs-rebuild/',
      },
    },
    {
      name: 'generic-abort',
      row: {
        url: 'http://127.0.0.1:64580/assets/app.js',
        failure: 'net::ERR_ABORTED',
        page: 'http://127.0.0.1:64580/b/mfs-rebuild/',
      },
    },
    {
      name: 'connection-refused',
      row: {
        url: 'http://127.0.0.1:64580/_serverFn/c56db81c8847ab3caaa1a44d7400eb5abcfa203694726b21774a1ab4423394d2',
        failure: 'net::ERR_CONNECTION_REFUSED',
        page: 'http://127.0.0.1:64580/b/mfs-rebuild/',
      },
    },
    {
      name: 'document',
      row: {
        url: 'http://127.0.0.1:64580/b/mfs-rebuild/work',
        failure: 'net::ERR_ABORTED',
        page: 'http://127.0.0.1:64580/b/mfs-rebuild/',
        resourceType: 'document',
      },
    },
    {
      name: 'cross-origin',
      row: {
        url: 'http://evil.example/_serverFn/c56db81c8847ab3caaa1a44d7400eb5abcfa203694726b21774a1ab4423394d2',
        failure: 'net::ERR_ABORTED',
        page: 'http://127.0.0.1:64580/b/mfs-rebuild/',
      },
    },
    {
      name: 'http-500',
      row: {
        url: 'http://127.0.0.1:64580/_serverFn/c56db81c8847ab3caaa1a44d7400eb5abcfa203694726b21774a1ab4423394d2',
        failure: 'net::ERR_ABORTED',
        page: 'http://127.0.0.1:64580/b/mfs-rebuild/',
        status: 500,
      },
    },
  ]) {
    const c = classifyNetworkFailure(bad.row)
    ok(
      `network-forbid-${bad.name}`,
      c.allowlisted === false && c.class === 'APP',
      c.reason,
    )
  }
  const mixed = evaluateConsoleNetwork({
    networkFailures: [
      ...r5aLike,
      {
        url: 'http://127.0.0.1:64580/api/healthz',
        failure: 'net::ERR_FAILED',
        page: 'http://127.0.0.1:64580/b/mfs-rebuild/',
      },
    ],
  })
  ok(
    'network-mixed-still-fails-app',
    !mixed.ok && mixed.networkCount === 1 && mixed.networkAllowlistedCount === 3,
    JSON.stringify({
      ok: mixed.ok,
      networkCount: mixed.networkCount,
      allow: mixed.networkAllowlistedCount,
    }),
  )

  const routes = buildRouteMatrix(DEFAULT_BOARD_ID)
  const labels = new Set(routes.map((r) => r.label))
  for (const need of [
    'Overview',
    'Work',
    'Work-DONE',
    'Work-ONGOING',
    'Work-NEXT',
    'Work-QUEUED',
    'Work-BLOCKED',
    'Work-RECON',
    'Work-STALE',
    'Work-STALE-RAW',
    'Priority',
    'Decisions',
    'Evidence',
  ]) {
    ok(`route-${need}`, labels.has(need))
  }

  ok(
    'viewports',
    VIEWPORT_ORDER.length === 4 && VIEWPORTS['1440x900']?.width === 1440,
    VIEWPORT_ORDER.join(','),
  )

  ok(
    'pin-defaults-present-shape',
    HARNESS_PIN.boardRev > 0 &&
      HARNESS_PIN.canonicalSnapshotId.startsWith('synth-') &&
      HARNESS_PIN.taskHash?.length === 64,
    JSON.stringify({ boardRev: HARNESS_PIN.boardRev, taskHashPrefix: HARNESS_PIN.taskHash?.slice(0, 12) }),
  )

  // Manifest: fresh clear + pin PRESENT when provenance supplied
  const c = new ScreenshotManifestCollector({ runId: RUN_ID })
  c.clear()
  c.add({
    route: `/b/${DEFAULT_BOARD_ID}/`,
    state: 'populated',
    viewport: '1440x900',
    browserTestId: 'self-test-row',
    accessibilityResult: 'qa/e2e/out/axe/self-test.json',
    missionQuestionLink: 'Q1',
    width: 1440,
    height: 900,
    pins: {
      canonicalSnapshotId: HARNESS_PIN.canonicalSnapshotId,
      canonicalHash: HARNESS_PIN.canonicalHash,
      boardRev: String(HARNESS_PIN.boardRev),
      lifecycleRev: String(HARNESS_PIN.lifecycleRev),
    },
  })
  ok('manifest-pin-PRESENT', c.rows[0].pinFields === 'PRESENT', c.rows[0].pinFields)
  ok('manifest-no-MISSING-pin', c.rows[0].boardRev !== PIN_MISSING)

  // auth classifier
  const { classifyAuthSurface } = await import('../lib/auth-assert.mjs')
  ok(
    'auth-reject-login',
    !classifyAuthSurface({
      url: 'http://127.0.0.1:1/login',
      hasLoginForm: true,
      hasSidebar: false,
      hasBrand: false,
      boardId: 'mfs-rebuild',
    }).ok,
  )
  ok(
    'auth-accept-shell',
    classifyAuthSurface({
      url: 'http://127.0.0.1:1/b/mfs-rebuild/',
      hasLoginForm: false,
      hasSidebar: true,
      hasBrand: true,
      boardId: 'mfs-rebuild',
    }).ok,
  )

  // capture guard pure
  try {
    assertNotLoginCapture({
      url: 'http://x/login',
      filename: 'Overview_1440.png',
    })
    ok('guard-login-url', false, 'should have thrown')
  } catch {
    ok('guard-login-url', true)
  }

  // --- C3-R3H fail-close pure contracts ---
  const canaries = listCanaryValues(REDACTION_CANARIES)
  ok('canaries-count', canaries.length >= 5, `n=${canaries.length}`)

  // Legitimate schema text must NOT fail public redaction (false-positive ban)
  const legitBody = JSON.stringify({
    boardId: 'mfs-rebuild',
    features: [{ checklist: [{ text: 'Password reset', done: true }] }],
    accounts: [{ accountIdMasked: 'acc_***-001', status: 'ACTIVE', usable: true }],
  })
  const legitEval = evaluatePublicRedaction({ status: 200, bodyText: legitBody })
  ok('public-legit-no-false-positive', legitEval.ok, legitEval.failures?.join('; '))

  // Canary leak must fail
  const leakEval = evaluatePublicRedaction({
    status: 200,
    bodyText: JSON.stringify({ note: REDACTION_CANARIES.decisionBody }),
  })
  ok('public-canary-leak-fails', !leakEval.ok && leakEval.failures.some((f) => f.includes('canary')))

  // Forbidden key must fail
  const keyEval = evaluatePublicRedaction({
    status: 200,
    body: { accounts: [{ password: 'x' }] },
  })
  ok('public-forbidden-key-fails', !keyEval.ok)

  // Non-200 fails
  ok('public-non-200-fails', !evaluatePublicRedaction({ status: 503, bodyText: '{}' }).ok)

  // C3-C12: shell width 424 at viewport 360 must fail (Spark false-green class)
  const shellWide = evaluateMobileShellContainment([
    {
      id: 'Overview_360x800',
      viewportWidth: 360,
      shells: {
        html: { clientWidth: 360, scrollWidth: 360, width: 360, left: 0, right: 360 },
        body: { clientWidth: 360, scrollWidth: 360, width: 360, left: 0, right: 360 },
        app: { clientWidth: 424, width: 424, left: 0, right: 424 },
        main: { clientWidth: 424, width: 424, left: 0, right: 424 },
        view: { clientWidth: 424, width: 424, left: 0, right: 424 },
      },
      elements: [],
    },
  ])
  ok(
    'mobile-shell-view-424-fails',
    !shellWide.ok && shellWide.failures.some((f) => f.includes('view') && f.includes('424')),
    shellWide.failures?.join('; '),
  )

  const shellOk = evaluateMobileShellContainment([
    {
      id: 'Overview_360x800',
      viewportWidth: 360,
      documentScrollWidth: 360,
      documentClientWidth: 360,
      shells: {
        html: { clientWidth: 360, scrollWidth: 360, width: 360, left: 0, right: 360 },
        body: { clientWidth: 360, scrollWidth: 360, width: 360, left: 0, right: 360 },
        app: { clientWidth: 360, width: 360, left: 0, right: 360 },
        main: { clientWidth: 360, width: 360, left: 0, right: 360 },
        view: { clientWidth: 360, width: 360, left: 0, right: 360 },
      },
      elements: [
        {
          name: 'nav_scrollport',
          present: true,
          namedScrollport: true,
          left: 0,
          right: 520,
          width: 520,
          height: 44,
        },
        {
          name: 'usermenu_btn',
          present: true,
          requireTouch: true,
          left: 280,
          right: 348,
          width: 68,
          height: 44,
        },
        {
          name: 'work_pagination',
          present: true,
          left: 12,
          right: 348,
          width: 336,
          height: 48,
        },
      ],
    },
  ])
  ok('mobile-shell-contained-passes', shellOk.ok, shellOk.failures?.join('; '))

  const shellClip = evaluateMobileShellContainment([
    {
      id: 'Work-ONGOING_390x844',
      viewportWidth: 390,
      shells: {
        html: { clientWidth: 390, scrollWidth: 390, width: 390, left: 0, right: 390 },
        body: { clientWidth: 390, scrollWidth: 390, width: 390, left: 0, right: 390 },
        app: { clientWidth: 390, width: 390, left: 0, right: 390 },
        main: { clientWidth: 390, width: 390, left: 0, right: 390 },
        view: { clientWidth: 390, width: 390, left: 0, right: 390 },
      },
      elements: [
        {
          name: 'work_card',
          present: true,
          left: 12,
          right: 430,
          width: 418,
          height: 120,
        },
      ],
    },
  ])
  ok(
    'mobile-shell-element-clip-fails',
    !shellClip.ok && shellClip.failures.some((f) => f.includes('work_card_clip_right')),
    shellClip.failures?.join('; '),
  )

  // Sticky: window.scrollY alone invalid
  const stickyBad = evaluateStickyDecision({
    usedWindowScrollYAlone: true,
    scrollContainerSelector: null,
    decisionCardPresent: true,
    postScroll: { pillPresent: true, pillCountPresent: true, pillSeverityPresent: true, pillExpandPresent: true },
  })
  ok('sticky-window-scrollY-alone-fails', !stickyBad.ok)

  // DOM-present-but-offscreen must fail (C3-C7 false-positive class)
  const stickyOffscreen = evaluateStickyDecision({
    usedWindowScrollYAlone: false,
    scrollContainerSelector: '#view',
    preScrollShotPath: '/tmp/pre.png',
    postScrollShotPath: '/tmp/post.png',
    decisionCardPresent: true,
    requiredScrollTopMin: 40,
    postScroll: {
      pillPresent: true,
      pillCountPresent: true,
      pillSeverityPresent: true,
      pillExpandPresent: true,
      coversNextContent: false,
      overlapsAppBar: false,
      appBarVisible: false,
      scrollTop: 1041,
      windowScrollY: 0,
      pillBounds: { top: -120, left: 12, bottom: -64, right: 378, width: 366, height: 56 },
      computed: { display: 'flex', visibility: 'visible', opacity: '1', position: 'sticky' },
      viewport: { width: 390, height: 844 },
      intersectionRatio: 0,
      visuallyVisible: false,
      zeroArea: false,
    },
  })
  ok(
    'sticky-dom-present-offscreen-fails',
    !stickyOffscreen.ok &&
      stickyOffscreen.failures.some(
        (f) =>
          f.includes('offscreen') ||
          f.includes('zero_intersection') ||
          f.includes('not_visually') ||
          f.includes('clip_'),
      ),
    stickyOffscreen.failures?.join('; '),
  )

  // C3-C9: partial intersection (0.945) must fail
  const stickyPartial = evaluateStickyDecision({
    usedWindowScrollYAlone: false,
    scrollContainerSelector: '#view',
    preScrollShotPath: '/tmp/pre.png',
    postScrollShotPath: '/tmp/post.png',
    decisionCardPresent: true,
    requiredScrollTopMin: 40,
    postScroll: {
      pillPresent: true,
      pillCountPresent: true,
      pillSeverityPresent: true,
      pillExpandPresent: true,
      coversNextContent: false,
      overlapsAppBar: false,
      appBarVisible: true,
      appBarBottom: 80,
      scrollTop: 200,
      windowScrollY: 0,
      pillBounds: { top: 0, left: 12, bottom: 60, right: 412, width: 400, height: 60 },
      computed: { display: 'flex', visibility: 'visible', opacity: '1', position: 'sticky' },
      viewport: {
        width: 390,
        height: 844,
        viewRect: { top: 0, left: 0, bottom: 685, right: 390, width: 390, height: 685 },
      },
      intersectionRatio: 0.945,
      visuallyVisible: true,
      zeroArea: false,
    },
  })
  ok(
    'sticky-partial-intersection-fails',
    !stickyPartial.ok &&
      stickyPartial.failures.some(
        (f) => f.includes('partial_intersection') || f.includes('clip_right'),
      ),
    stickyPartial.failures?.join('; '),
  )

  // C3-C9: window.scroll nudge when #view is container must fail
  const stickyNudge = evaluateStickyDecision({
    usedWindowScrollYAlone: false,
    scrollContainerSelector: '#view',
    preScrollShotPath: '/tmp/pre.png',
    postScrollShotPath: '/tmp/post.png',
    decisionCardPresent: true,
    requiredScrollTopMin: 40,
    postScroll: {
      pillPresent: true,
      pillCountPresent: true,
      pillSeverityPresent: true,
      pillExpandPresent: true,
      coversNextContent: false,
      overlapsAppBar: false,
      appBarVisible: false,
      scrollTop: 200,
      windowScrollY: 272,
      pillBounds: { top: 96, left: 12, bottom: 148, right: 378, width: 366, height: 52 },
      computed: { display: 'flex', visibility: 'visible', opacity: '1', position: 'sticky' },
      viewport: {
        width: 390,
        height: 844,
        viewRect: { top: -113, left: 0, bottom: 572, right: 390, width: 390, height: 685 },
      },
      intersectionRatio: 1,
      visuallyVisible: true,
      zeroArea: false,
    },
  })
  ok(
    'sticky-window-nudge-fails',
    !stickyNudge.ok &&
      stickyNudge.failures.some(
        (f) => f.includes('window_scroll_nudge') || f.includes('app_bar_not_visible'),
      ),
    stickyNudge.failures?.join('; '),
  )

  // C3-C9: nearest visible content overlap must fail
  const stickyOverlap = evaluateStickyDecision({
    usedWindowScrollYAlone: false,
    scrollContainerSelector: '#view',
    preScrollShotPath: '/tmp/pre.png',
    postScrollShotPath: '/tmp/post.png',
    decisionCardPresent: true,
    requiredScrollTopMin: 40,
    postScroll: {
      pillPresent: true,
      pillCountPresent: true,
      pillSeverityPresent: true,
      pillExpandPresent: true,
      coversNextContent: true,
      nextTestId: 'overview-ongoing',
      nearestContentTestId: 'overview-ongoing',
      overlapsAppBar: false,
      appBarVisible: true,
      appBarBottom: 80,
      scrollTop: 200,
      windowScrollY: 0,
      pillBounds: { top: 96, left: 12, bottom: 148, right: 378, width: 366, height: 52 },
      computed: { display: 'flex', visibility: 'visible', opacity: '1', position: 'sticky' },
      viewport: {
        width: 390,
        height: 844,
        viewRect: { top: 0, left: 0, bottom: 685, right: 390, width: 390, height: 685 },
      },
      intersectionRatio: 1,
      visuallyVisible: true,
      zeroArea: false,
    },
  })
  ok(
    'sticky-nearest-content-overlap-fails',
    !stickyOverlap.ok && stickyOverlap.failures.some((f) => f.includes('covers_next_content')),
    stickyOverlap.failures?.join('; '),
  )

  // C3-C10: multi-sample overlap must fail even if primary coversNextContent is false
  const stickyMultiFail = evaluateStickyDecision({
    usedWindowScrollYAlone: false,
    scrollContainerSelector: '[data-testid="overview-mission-scroll"]',
    preScrollShotPath: '/tmp/pre.png',
    postScrollShotPath: '/tmp/post.png',
    decisionCardPresent: true,
    requiredScrollTopMin: 40,
    scrollSamples: [
      { delta: 0, scrollTop: 100, coversNextContent: false, pillPresent: true },
      { delta: 90, scrollTop: 190, coversNextContent: true, nextTestId: 'overview-buckets', pillPresent: true },
    ],
    postScroll: {
      pillPresent: true,
      pillCountPresent: true,
      pillSeverityPresent: true,
      pillExpandPresent: true,
      coversNextContent: false,
      multiSampleCoversContent: true,
      nextTestId: 'overview-buckets',
      overlapsAppBar: false,
      appBarVisible: true,
      appBarBottom: 80,
      scrollTop: 100,
      windowScrollY: 0,
      pillBounds: { top: 96, left: 12, bottom: 148, right: 378, width: 366, height: 52 },
      computed: { display: 'flex', visibility: 'visible', opacity: '1', position: 'relative' },
      viewport: {
        width: 390,
        height: 844,
        viewRect: { top: 0, left: 0, bottom: 685, right: 390, width: 390, height: 685 },
      },
      intersectionRatio: 1,
      visuallyVisible: true,
      zeroArea: false,
    },
  })
  ok(
    'sticky-multi-sample-overlap-fails',
    !stickyMultiFail.ok &&
      stickyMultiFail.failures.some((f) => f.includes('covers_next_content')),
    stickyMultiFail.failures?.join('; '),
  )

  const stickyOk = evaluateStickyDecision({
    usedWindowScrollYAlone: false,
    scrollContainerSelector: '[data-testid="overview-mission-scroll"]',
    preScrollShotPath: '/tmp/pre.png',
    postScrollShotPath: '/tmp/post.png',
    decisionCardPresent: true,
    requiredScrollTopMin: 40,
    screenshotDims: {
      pre: { width: 390, height: 844 },
      post: { width: 390, height: 844 },
      expectedWidth: 390,
      expectedHeight: 844,
    },
    scrollSamples: [
      { delta: 0, scrollTop: 120, coversNextContent: false, pillPresent: true, appBarVisible: true },
      { delta: 90, scrollTop: 210, coversNextContent: false, pillPresent: true, appBarVisible: true },
      { delta: 180, scrollTop: 300, coversNextContent: false, pillPresent: true, appBarVisible: true },
    ],
    postScroll: {
      pillPresent: true,
      pillCountPresent: true,
      pillSeverityPresent: true,
      pillExpandPresent: true,
      coversNextContent: false,
      multiSampleCoversContent: false,
      overlapsAppBar: false,
      appBarVisible: true,
      appBarBottom: 80,
      nextTestId: 'overview-priority',
      nearestContentTestId: 'overview-priority',
      scrollTop: 120,
      windowScrollY: 0,
      pillBounds: { top: 96, left: 12, bottom: 148, right: 378, width: 366, height: 52 },
      computed: { display: 'flex', visibility: 'visible', opacity: '1', position: 'relative' },
      viewport: {
        width: 390,
        height: 844,
        viewRect: { top: 0, left: 0, bottom: 685, right: 390, width: 390, height: 685 },
      },
      intersectionRatio: 1,
      visuallyVisible: true,
      zeroArea: false,
    },
  })
  ok('sticky-valid-pass', stickyOk.ok, stickyOk.failures?.join('; '))

  // Auth cleanup contract (success path simulation)
  {
    const authDir = path.join(OUT_ROOT, 'auth-selftest-success')
    fs.mkdirSync(authDir, { recursive: true })
    fs.writeFileSync(path.join(authDir, 'username.txt'), 'u\n', { mode: 0o600 })
    fs.writeFileSync(path.join(authDir, 'password.txt'), 'p\n', { mode: 0o600 })
    fs.writeFileSync(path.join(authDir, 'storageState.json'), '{"cookies":[]}\n', {
      mode: 0o600,
    })
    const cleaned = eraseHarnessAuthArtifacts(authDir)
    ok('auth-cleanup-success-erases-files', cleaned.erasedFileCount === 3, JSON.stringify(cleaned))
    ok('auth-cleanup-success-dir-gone', cleaned.authDirAbsent === true, JSON.stringify(cleaned))
    // Summary is booleans/counts only — no credential *values* (field names like
    // passwordPresentBefore are ok; values must never be strings of secrets).
    const cleanedJson = JSON.stringify(cleaned)
    ok(
      'auth-cleanup-success-no-secrets-in-summary',
      cleaned.erasedFileCount === 3 &&
        cleaned.authDirAbsent === true &&
        typeof cleaned.passwordPresentBefore === 'boolean' &&
        typeof cleaned.usernamePresentBefore === 'boolean' &&
        !/"password"\s*:\s*"[^"]+"/i.test(cleanedJson) &&
        !/"username"\s*:\s*"[^"]+"/i.test(cleanedJson) &&
        !cleanedJson.includes('Synth!') &&
        !cleanedJson.includes('cookies'),
      cleanedJson,
    )
  }
  // Auth cleanup contract (failure path — dir already partial)
  {
    const authDir = path.join(OUT_ROOT, 'auth-selftest-fail')
    fs.mkdirSync(authDir, { recursive: true })
    fs.writeFileSync(path.join(authDir, 'storageState.json'), '{"cookies":[]}\n', {
      mode: 0o600,
    })
    const cleaned = eraseHarnessAuthArtifacts(authDir)
    ok('auth-cleanup-failure-erases-files', cleaned.erasedFileCount >= 1, JSON.stringify(cleaned))
    ok('auth-cleanup-failure-dir-gone', cleaned.authDirAbsent === true, JSON.stringify(cleaned))
  }

  // Raw STALE
  ok(
    'raw-stale-requires-active',
    !evaluateRawStale({
      literalPath: `/b/${DEFAULT_BOARD_ID}/work?stale=1`,
      navigationUsedRouterSerialize: false,
      authShellOk: true,
      workScreenPresent: true,
      staleActive: false,
      errorBoundaryPresent: false,
      consoleErrorDuringNav: false,
    }).ok,
  )
  ok(
    'raw-stale-pass-shape',
    evaluateRawStale({
      literalPath: `/b/${DEFAULT_BOARD_ID}/work?stale=1`,
      navigationUsedRouterSerialize: false,
      authShellOk: true,
      workScreenPresent: true,
      staleActive: true,
      errorBoundaryPresent: false,
      consoleErrorDuringNav: false,
    }).ok,
  )

  // Touch fail-close
  ok(
    'touch-below-44-fails',
    !evaluateTouch({
      total: 3,
      failing: 1,
      sampleFail: [{ testid: 'user-menu', w: 247, h: 37 }],
    }).ok,
  )
  ok('touch-all-ok-pass', evaluateTouch({ total: 5, failing: 0, sampleFail: [] }).ok)

  // ONGOING fields not just query
  ok(
    'ongoing-query-only-fails',
    !evaluateOngoingZeroClick({
      hasOngoingQuery: true,
      onlyQueryString: true,
      sectionPresent: false,
      visibleFields: {},
      seededTaskId: SEEDED_ONGOING.taskId,
    }).ok,
  )
  const ongoingFields = {
    taskId: true,
    title: true,
    targetGate: true,
    agentId: true,
    role: true,
    model: true,
    effort: true,
    maskedAccount: true,
    startedAge: true,
    heartbeatAge: true,
    materialProgressAge: true,
    evidence: true,
  }
  ok(
    'ongoing-fields-pass',
    evaluateOngoingZeroClick({
      hasOngoingQuery: true,
      onlyQueryString: false,
      sectionPresent: true,
      visibleFields: ongoingFields,
      seededTaskId: SEEDED_ONGOING.taskId,
      foundTaskId: SEEDED_ONGOING.taskId,
    }).ok,
  )

  // Aggregate fail-close
  const aggFail = aggregateProbeVerdicts({
    publicRedaction: { status: 200, bodyText: JSON.stringify({ x: REDACTION_CANARIES.commentText }) },
    touch: { total: 1, failing: 1, sampleFail: [{ testid: 'x', w: 10, h: 10 }] },
    sessionDenial: [{ path: '/b/x/', url: '/login', denied: true }],
    focus: { focusOk: true },
    reducedMotion: { matches: true },
  })
  ok('aggregate-fail-count', aggFail.failCount >= 2, `failCount=${aggFail.failCount}`)
  try {
    assertProbesFailClosed(aggFail)
    ok('assert-probes-throws', false, 'should throw')
  } catch (e) {
    ok('assert-probes-throws', /HARNESS FAIL/.test(String(e)))
  }

  // --- C3-R5H authorized MCP bootstrap contracts (mock network; no secret leak) ---
  const boot = await runBootstrapContractSelfTests()
  for (const r of boot.results) {
    ok(`bootstrap-${r.name}`, r.pass, r.detail ?? undefined)
  }
  ok('bootstrap-contract-suite', boot.ok === true, `failCount=${boot.failCount}`)

  const failCount = results.filter((r) => !r.pass).length
  writeJson('logs/self-test.json', { runId: RUN_ID, results, failCount })
  return { failCount, results }
}

async function bootstrapLogin(page, creds, storagePath) {
  process.env.CAIRN_E2E_USERNAME = creds.username
  process.env.CAIRN_E2E_PASSWORD = creds.password
  await loginAndSaveStorageState(page, storagePath)
  requireExistingStorageState(storagePath)
  // credentials only under ignored runtime auth (mode 600)
  const userFile = path.join(OUT_ROOT, 'auth/username.txt')
  const passFile = path.join(OUT_ROOT, 'auth/password.txt')
  fs.writeFileSync(userFile, `${creds.username}\n`, { mode: 0o600 })
  fs.writeFileSync(passFile, `${creds.password}\n`, { mode: 0o600 })
  fs.chmodSync(userFile, 0o600)
  fs.chmodSync(passFile, 0o600)
  return storagePath
}

/**
 * C3-C12: measure shell + representative element rects for mobile fail-close.
 * Horizontal nav is a named scrollport (allowed to extend scrollWidth, not clip shell).
 */
async function measureMobileShellContainmentRow(page, { id, route, vp, width, height }) {
  return page.evaluate(
    ({ id, route, vp, width, height }) => {
      const rectOf = (el) => {
        if (!el) return null
        const r = el.getBoundingClientRect()
        return {
          top: r.top,
          left: r.left,
          bottom: r.bottom,
          right: r.right,
          width: r.width,
          height: r.height,
          clientWidth: 'clientWidth' in el ? el.clientWidth : r.width,
          scrollWidth: 'scrollWidth' in el ? el.scrollWidth : r.width,
        }
      }
      const de = document.documentElement
      const body = document.body
      const app = document.querySelector('.app')
      const main = document.querySelector('.main')
      const view = document.querySelector('#view')
      const shells = {
        html: {
          clientWidth: de.clientWidth,
          scrollWidth: de.scrollWidth,
          width: de.clientWidth,
          left: 0,
          right: de.clientWidth,
        },
        body: body
          ? {
              clientWidth: body.clientWidth,
              scrollWidth: body.scrollWidth,
              width: body.clientWidth,
              left: 0,
              right: body.clientWidth,
            }
          : null,
        app: rectOf(app),
        main: rectOf(main),
        view: rectOf(view),
      }

      const pick = (sels) => {
        for (const s of sels) {
          const el = document.querySelector(s)
          if (el) return el
        }
        return null
      }

      const specs = [
        { name: 'topbar', sels: ['.topbar'], requireTouch: false },
        { name: 'usermenu', sels: ['[data-testid="user-menu"]', '.usermenu'], requireTouch: false },
        { name: 'usermenu_btn', sels: ['.usermenu-btn'], requireTouch: true },
        {
          name: 'nav_scrollport',
          sels: ['.nav'],
          requireTouch: false,
          namedScrollport: true,
        },
        {
          name: 'work_pin',
          sels: ['[data-testid="work-pinned-revision"]'],
          requireTouch: false,
        },
        {
          name: 'work_tabs',
          sels: ['[role="tablist"][aria-label*="bucket" i]', '[role="tablist"]'],
          requireTouch: false,
        },
        {
          name: 'work_tab_sample',
          sels: ['[data-testid^="work-tab-"]'],
          requireTouch: true,
        },
        {
          name: 'work_card',
          sels: ['[data-testid="work-card-list"] > *', '[data-testid="work-card-list"] button'],
          requireTouch: false,
        },
        {
          name: 'work_pagination',
          sels: ['[data-testid="work-pagination"]'],
          requireTouch: false,
        },
        {
          name: 'work_page_prev',
          sels: ['[data-testid="work-page-prev"]'],
          requireTouch: true,
        },
        {
          name: 'work_page_next',
          sels: ['[data-testid="work-page-next"]'],
          requireTouch: true,
        },
        {
          name: 'decision_card',
          sels: ['[data-testid="decision-card"]'],
          requireTouch: false,
        },
        {
          name: 'decision_actions',
          sels: ['[data-testid="decision-card"] [class*="actions"]', '[data-testid="decision-card"] button'],
          requireTouch: false,
        },
        {
          name: 'overview_buckets',
          sels: ['[data-testid="overview-buckets"]'],
          requireTouch: false,
        },
        {
          name: 'overview_ongoing',
          sels: ['[data-testid="overview-ongoing"]'],
          requireTouch: false,
        },
        {
          name: 'overview_ongoing_chip',
          sels: [
            '[data-testid="overview-ongoing"] [class*="chip"]',
            '[data-testid="overview-ongoing"] [class*="Chip"]',
          ],
          requireTouch: false,
        },
      ]

      const elements = specs.map((spec) => {
        const el = pick(spec.sels)
        if (!el) {
          return {
            name: spec.name,
            present: false,
            namedScrollport: !!spec.namedScrollport,
            requireTouch: !!spec.requireTouch,
          }
        }
        const r = el.getBoundingClientRect()
        return {
          name: spec.name,
          present: true,
          namedScrollport: !!spec.namedScrollport,
          requireTouch: !!spec.requireTouch,
          top: r.top,
          left: r.left,
          bottom: r.bottom,
          right: r.right,
          width: r.width,
          height: r.height,
        }
      })

      return {
        id,
        route,
        vp,
        viewportWidth: window.innerWidth || width,
        viewportHeight: window.innerHeight || height,
        documentScrollWidth: Math.max(de.scrollWidth, body?.scrollWidth ?? 0),
        documentClientWidth: de.clientWidth,
        shells,
        elements,
      }
    },
    { id, route, vp, width, height },
  )
}

async function captureMatrix({ page, boardId, pins, runStartedMs, collector, failHardAxe, fullSha }) {
  const routes = buildRouteMatrix(boardId)
  const plan = planCaptures(boardId)
  const plannedCount = plan.length
  const skipped = []
  const errors = []
  const captured = []
  const axeSummary = []
  const overflowSummary = []
  const mobileShellSummary = []
  const consoleErrors = []
  const networkFailures = []
  const sha = fullSha || assertFullSha({ cwd: ROOT })

  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      consoleErrors.push({ text: msg.text(), url: page.url(), t: new Date().toISOString() })
    }
  })
  page.on('pageerror', (err) => {
    consoleErrors.push({
      text: String(err),
      url: page.url(),
      t: new Date().toISOString(),
      kind: 'pageerror',
    })
  })
  page.on('requestfailed', (req) => {
    networkFailures.push({
      url: req.url(),
      failure: req.failure()?.errorText || null,
      page: page.url(),
      resourceType: req.resourceType?.() ?? null,
      method: req.method?.() ?? null,
    })
  })

  const viewportPlan = plan.filter((p) => p.kind === 'viewport')
  const zoomPlan = plan.filter((p) => p.kind === 'zoom200')

  for (const item of viewportPlan) {
    const r = item.route
    const vp = item.vp
    const size = VIEWPORTS[vp]
    const id = item.id
    try {
      await page.setViewportSize(size)
      // Transient navigation retry (documented): once only
      let lastErr = null
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          await page.goto(r.path, { waitUntil: 'domcontentloaded', timeout: 60_000 })
          await page.waitForTimeout(500)
          lastErr = null
          break
        } catch (e) {
          lastErr = e
          if (attempt === 0) {
            console.log(`RETRY nav route=${r.label} vp=${vp} err=${String(e).slice(0, 120)}`)
            await page.waitForTimeout(800)
          }
        }
      }
      if (lastErr) throw lastErr

      const auth = await assertAuthenticatedOwnerShell(page, { boardId })
      assertNotLoginCapture({
        url: auth.url,
        filename: id,
        loginFormPresent: false,
      })

      const shotPath = path.join(OUT_ROOT, 'screenshots', `${id}.png`)
      const fullPath = path.join(OUT_ROOT, 'screenshots/fullpage', `${id}.full.png`)
      // Viewport-only proof (accurate dims)
      await page.screenshot({ path: shotPath, fullPage: false })
      await page.screenshot({ path: fullPath, fullPage: true })
      assertScreenshotHealthy(shotPath, {
        width: size.width,
        height: size.height,
        exactHeight: true,
        fullPage: false,
      })
      assertArtifactFresh(shotPath, runStartedMs)

      const overflow = await hasDocumentHorizontalOverflow(page)
      overflowSummary.push({ id, route: r.path, vp, overflow })

      // C3-C12: fail-closed shell + element containment at 360/390 (not document scroll alone).
      if (size.width <= 420) {
        const shellRow = await measureMobileShellContainmentRow(page, {
          id,
          route: r.path,
          vp,
          width: size.width,
          height: size.height,
        })
        mobileShellSummary.push(shellRow)
        const shellEval = evaluateMobileShellContainment([shellRow])
        if (!shellEval.ok) {
          throw new Error(
            `HARNESS FAIL mobile shell containment ${id}: ${shellEval.failures.slice(0, 4).join(' | ')}`,
          )
        }
      }

      const axe = await runAxe(page, {
        outPath: path.join(OUT_ROOT, 'axe', `${id}.json`),
        browserTestId: id,
      })
      axeSummary.push({
        id,
        route: r.path,
        vp,
        ok: axe.ok,
        criticalSerious: axe.criticalSerious.map((v) => ({ id: v.id, impact: v.impact })),
        rawPath: axe.rawPath,
      })
      if (failHardAxe && !axe.ok) {
        // record then continue matrix; final exit code aggregates
      }

      collector.add({
        route: r.path,
        state: r.state,
        viewport: vp,
        browserTestId: id,
        serverTestId: RUN_ID,
        runId: RUN_ID,
        accessibilityResult: axe.rawPath || path.join(OUT_ROOT, 'axe', `${id}.json`),
        missionQuestionLink: r.mission,
        screenshotPath: shotPath,
        fullPageScreenshotPath: fullPath,
        width: size.width,
        height: size.height,
        captureMode: 'viewport',
        stagingUrl: process.env.WEB_BASE,
        fullSha: sha,
        pins,
      })

      captured.push({ id, kind: 'viewport', route: r.path, vp, authUrl: auth.url, axeOk: axe.ok })
      console.log(
        `OK capture ${id} axeOk=${axe.ok} overflow=${overflow} url=${auth.url}`,
      )
    } catch (e) {
      const row = { id, kind: 'viewport', route: r.path, vp, error: String(e?.stack || e) }
      // Failures count as `error` only (not also skipped) so planned === captured+skipped+error.
      errors.push(row)
      console.error(`SKIP/FAIL ${id}: ${String(e?.message || e)}`)
    }
  }

  if (errors.length) {
    const counts = accountCaptureCounts({
      planned: plannedCount,
      captured,
      skipped,
      error: errors,
    })
    throw new Error(
      `HARNESS FAIL: ${errors.length} route(s) failed — refusing incomplete matrix. bookkeeping=${JSON.stringify(counts)} First: ${errors[0].id}: ${String(errors[0].error).slice(0, 200)}`,
    )
  }

  // 200% core flows (planned zoom200 rows — counted in captured for bookkeeping honesty)
  const zoomRows = []
  await page.setViewportSize(VIEWPORTS['1440x900'])
  for (const item of zoomPlan) {
    const r = item.route
    const id = item.id
    try {
      await page.goto(r.path, { waitUntil: 'domcontentloaded', timeout: 60_000 })
      await page.waitForTimeout(400)
      await assertAuthenticatedOwnerShell(page, { boardId })
      await setPageZoom(page, 2)
      await page.waitForTimeout(200)
      const shotPath = path.join(OUT_ROOT, 'screenshots', `${id}.png`)
      await page.screenshot({ path: shotPath, fullPage: false })
      assertArtifactFresh(shotPath, runStartedMs)
      const overflow = await hasDocumentHorizontalOverflow(page)
      zoomRows.push({ id, route: r.path, overflow, shotPath })
      collector.add({
        route: r.path,
        state: r.state,
        zoom: '200%',
        browserTestId: id,
        serverTestId: RUN_ID,
        runId: RUN_ID,
        accessibilityResult: path.join(OUT_ROOT, 'axe', `${id}-zoom-note.json`),
        missionQuestionLink: r.mission,
        screenshotPath: shotPath,
        width: 1440,
        height: 900,
        captureMode: 'zoom-200',
        stagingUrl: process.env.WEB_BASE,
        fullSha: sha,
        pins,
      })
      fs.writeFileSync(
        path.join(OUT_ROOT, 'axe', `${id}-zoom-note.json`),
        JSON.stringify({ note: 'axe not re-run at zoom; overflow-only', route: r.path }, null, 2),
      )
      await resetPageZoom(page)
      captured.push({ id, kind: 'zoom200', route: r.path, vp: '1440x900', overflow })
      console.log(`OK zoom200 ${r.label} overflow=${overflow}`)
    } catch (e) {
      try {
        await resetPageZoom(page)
      } catch {
        /* ignore */
      }
      const row = {
        id,
        kind: 'zoom200',
        route: r.path,
        vp: '1440x900',
        error: String(e?.stack || e),
      }
      errors.push(row)
      console.error(`SKIP/FAIL ${id}: ${String(e?.message || e)}`)
    }
  }

  if (errors.length) {
    const counts = accountCaptureCounts({
      planned: plannedCount,
      captured,
      skipped,
      error: errors,
    })
    throw new Error(
      `HARNESS FAIL: ${errors.length} capture(s) failed — refusing incomplete matrix. bookkeeping=${JSON.stringify(counts)} First: ${errors[0].id}: ${String(errors[0].error).slice(0, 200)}`,
    )
  }

  const bookkeeping = accountCaptureCounts({
    planned: plannedCount,
    captured,
    skipped,
    error: errors,
  })
  if (!bookkeeping.consistent) {
    throw new Error(
      `HARNESS FAIL: capture count bookkeeping inconsistent: ${JSON.stringify(bookkeeping)}`,
    )
  }
  if (boardId === 'mfs-rebuild' && plannedCount !== EXPECTED_PLANNED_CAPTURES_MFS) {
    throw new Error(
      `HARNESS FAIL: plannedCount=${plannedCount} != EXPECTED_PLANNED_CAPTURES_MFS=${EXPECTED_PLANNED_CAPTURES_MFS}`,
    )
  }

  return {
    captured,
    skipped,
    errors,
    axeSummary,
    overflowSummary,
    mobileShellSummary,
    zoomRows,
    consoleErrors,
    networkFailures,
    plannedCount,
    bookkeeping,
    fullSha: sha,
  }
}

/**
 * In-scope interactive controls for touch probe (selectors + testids, not text alone).
 */
const TOUCH_SELECTORS = [
  '.sidebar a.nav-item',
  'button',
  'a[href]',
  '[role="button"]',
  '[role="tab"]',
  '[role="switch"]',
  'input[type="submit"]',
  'input[type="button"]',
].join(', ')

async function runProbes(page, boardId, _storagePath) {
  const probes = {
    // Evaluated verdicts attached after measurement
    verdicts: {},
  }
  const probeConsole = []
  const onConsole = (msg) => {
    if (msg.type() === 'error') probeConsole.push({ text: msg.text(), t: new Date().toISOString() })
  }
  const onPageError = (err) => {
    probeConsole.push({ text: String(err), kind: 'pageerror', t: new Date().toISOString() })
  }
  page.on('console', onConsole)
  page.on('pageerror', onPageError)

  try {
    // --- Keyboard / focus ---
    await page.goto(`/b/${boardId}/`, { waitUntil: 'domcontentloaded' })
    await assertAuthenticatedOwnerShell(page, { boardId })
    await page.locator('body').click({ position: { x: 2, y: 2 } }).catch(() => {})
    await tabN(page, 5)
    let focusOk = false
    let focusErr = null
    try {
      await assertFocusVisible(page)
      focusOk = true
    } catch (e) {
      focusErr = String(e?.message || e)
    }
    probes.focus = { focusOk, focusErr }
    probes.verdicts.focus = evaluateFocus(probes.focus)

    // --- Reduced motion ---
    await page.emulateMedia({ reducedMotion: 'reduce' })
    probes.reducedMotion = await page.evaluate(() => ({
      matches: window.matchMedia('(prefers-reduced-motion: reduce)').matches,
    }))
    await page.emulateMedia({ reducedMotion: 'no-preference' })
    probes.verdicts.reducedMotion = evaluateReducedMotion(probes.reducedMotion)

    // --- Sticky Decision (mobile viewport; scroll #view/.content — NOT window.scrollY alone) ---
    await page.setViewportSize(VIEWPORTS['390x844'])
    await page.goto(`/b/${boardId}/`, { waitUntil: 'domcontentloaded', timeout: 60_000 })
    await page.waitForTimeout(500)
    await assertAuthenticatedOwnerShell(page, { boardId })

    const stickyPrePath = path.join(OUT_ROOT, 'probes/sticky-decision-pre.png')
    const stickyPostPath = path.join(OUT_ROOT, 'probes/sticky-decision-post.png')

    const stickyMeta = await page.evaluate(() => {
      const card = document.querySelector('[data-testid="overview-decision-card"]')
      const stack = document.querySelector('[data-testid="overview-decision-stack"]')
      const mission = document.querySelector('[data-testid="overview-mission-scroll"]')
      const view =
        document.querySelector('#view') ||
        document.querySelector('.content') ||
        document.scrollingElement
      // Prefer mission scrollport (C3-C10 shelf layout) when it actually scrolls.
      let selector = 'document.scrollingElement'
      let scroller = view
      if (
        mission instanceof HTMLElement &&
        mission.scrollHeight > mission.clientHeight + 20
      ) {
        selector = '[data-testid="overview-mission-scroll"]'
        scroller = mission
      } else if (document.querySelector('#view')) {
        selector = '#view'
        scroller = document.querySelector('#view')
      } else if (document.querySelector('.content')) {
        selector = '.content'
        scroller = document.querySelector('.content')
      }
      return {
        decisionCardPresent: !!card,
        stackPresent: !!stack,
        scrollContainerSelector: selector,
        shelfLayout: !!document.querySelector('[data-testid="overview-sticky-chrome"]'),
        scrollTopBefore: scroller ? scroller.scrollTop : 0,
        canScroll:
          !!scroller &&
          scroller.scrollHeight > scroller.clientHeight + 20,
        viewScrollTop: view ? view.scrollTop : 0,
      }
    })

    await page.screenshot({ path: stickyPrePath, fullPage: false })

    // Scroll ONLY the real content container. Never window.scrollTo when #view
    // is the scrollport (C3-C9: window nudge made viewRect.top negative and
    // hid the app shell, vacating app-bar overlap checks).
    // C3-C10: prefer overview-mission-scroll when shelf layout owns overflow.
    const scrollResult = await page.evaluate(async () => {
      // Force window to top — dual-scroll is invalid for this probe.
      window.scrollTo(0, 0)
      const mission = document.querySelector('[data-testid="overview-mission-scroll"]')
      const view =
        document.querySelector('#view') ||
        document.querySelector('.content') ||
        document.scrollingElement
      let scroller = view
      let selector = view
        ? document.querySelector('#view')
          ? '#view'
          : document.querySelector('.content')
            ? '.content'
            : 'document.scrollingElement'
        : null
      if (
        mission instanceof HTMLElement &&
        mission.scrollHeight > mission.clientHeight + 20
      ) {
        scroller = mission
        selector = '[data-testid="overview-mission-scroll"]'
      }
      if (!scroller) return { ok: false, reason: 'no_scroll_container' }
      const card = document.querySelector('[data-testid="overview-decision-card"]')
      // Scroll just far enough that the decision card leaves the scrollport
      // (triggers sticky pill) while app summary + nearest content stay visible.
      let target = Math.min(
        Math.max(scroller.clientHeight * 0.55, 180),
        scroller.scrollHeight,
      )
      if (card && scroller.contains(card)) {
        const cardBottom = card.offsetTop + card.offsetHeight
        target = Math.max(cardBottom - 24, 80)
      }
      scroller.scrollTop = Math.min(
        target,
        Math.max(0, scroller.scrollHeight - scroller.clientHeight),
      )
      window.scrollTo(0, 0)

      // Wait briefly for IntersectionObserver → pill mount + card collapse.
      await new Promise((r) => setTimeout(r, 350))

      // If shelf layout is active, content cannot sit under the chrome band;
      // still run a bounded overlap nudge for fallback sticky path.
      const candidateSels = [
        '[data-testid="overview-priority"]',
        '[data-testid="overview-global"]',
        '[data-testid="overview-buckets"]',
        '[data-testid="overview-ongoing"]',
        '[data-testid="overview-lower"]',
      ]
      let adjustments = 0
      for (let i = 0; i < 6; i++) {
        window.scrollTo(0, 0)
        const pill = document.querySelector('[data-testid="overview-decision-pill"]')
        if (!pill) break
        const pr = pill.getBoundingClientRect()
        let worst = 0
        for (const sel of candidateSels) {
          const el = document.querySelector(sel)
          if (!el) continue
          const r = el.getBoundingClientRect()
          const vis =
            Math.min(r.bottom, window.innerHeight) - Math.max(r.top, 0) > 4 &&
            r.width > 0
          if (!vis) continue
          const overlap = Math.min(pr.bottom, r.bottom) - Math.max(pr.top, r.top)
          if (overlap > 8) worst = Math.max(worst, overlap)
        }
        if (worst <= 8) break
        scroller.scrollTop = Math.min(
          scroller.scrollTop + worst + 12,
          Math.max(0, scroller.scrollHeight - scroller.clientHeight),
        )
        adjustments += 1
        await new Promise((r) => setTimeout(r, 80))
      }
      window.scrollTo(0, 0)
      return {
        ok: true,
        scrollTop: scroller.scrollTop,
        scrollHeight: scroller.scrollHeight,
        clientHeight: scroller.clientHeight,
        windowScrollY: window.scrollY,
        usedWindowScrollTo: false,
        overlapAdjustments: adjustments,
        scrollContainerSelector: selector,
        viewScrollTop: view ? view.scrollTop : 0,
      }
    })
    await page.waitForTimeout(200)

    // Shared in-page overlap + geometry measurement (primary + multi-sample).
    async function measureStickyAtCurrentScroll() {
      return page.evaluate(() => {
        if (window.scrollY !== 0) window.scrollTo(0, 0)

        const pill = document.querySelector('[data-testid="overview-decision-pill"]')
        const count = document.querySelector('[data-testid="overview-decision-pill-count"]')
        const sev = document.querySelector('[data-testid="overview-decision-pill-severity"]')
        const expandBtn = pill
          ? [...pill.querySelectorAll('button')].find((b) =>
              /expand/i.test((b.textContent || '') + (b.getAttribute('aria-label') || '')),
            )
          : null
        const stack = document.querySelector('[data-testid="overview-decision-stack"]')
        const appBar = document.querySelector('[data-testid="overview-app-summary"]')
        const mission = document.querySelector('[data-testid="overview-mission-scroll"]')
        const view =
          document.querySelector('#view') ||
          document.querySelector('.content') ||
          document.scrollingElement
        let scroller = view
        if (
          mission instanceof HTMLElement &&
          mission.scrollHeight > mission.clientHeight + 8
        ) {
          scroller = mission
        }
        const vh = window.innerHeight
        const vw = window.innerWidth
        // Containment uses outer #view visible rect (pill must stay inside shell).
        const viewRect = view
          ? view.getBoundingClientRect()
          : { top: 0, left: 0, bottom: vh, right: vw, width: vw, height: vh }

        // Mission scrollport clip: overflow-clipped layout boxes above the
        // scrollport must not count as "covering" the shelf pill (C3-C10).
        // getBoundingClientRect ignores overflow clipping — use the visible
        // intersection with the mission (or #view) paint region.
        const missionRect =
          mission instanceof HTMLElement ? mission.getBoundingClientRect() : null
        const clipTop = Math.max(
          missionRect && missionRect.height > 8 ? missionRect.top : viewRect.top,
          viewRect.top,
          0,
        )
        const clipBottom = Math.min(
          missionRect && missionRect.height > 8 ? missionRect.bottom : viewRect.bottom,
          viewRect.bottom,
          vh,
        )
        const clipLeft = Math.max(
          missionRect && missionRect.width > 8 ? missionRect.left : viewRect.left,
          viewRect.left,
          0,
        )
        const clipRight = Math.min(
          missionRect && missionRect.width > 8 ? missionRect.right : viewRect.right,
          viewRect.right,
          vw,
        )

        const candidateSelectors = [
          '[data-testid="overview-priority"]',
          '[data-testid="overview-global"]',
          '[data-testid="overview-buckets"]',
          '[data-testid="overview-ongoing"]',
          '[data-testid="overview-lower"]',
          '[data-testid="overview-projects"]',
          '[data-testid="overview-lifecycle"]',
          '[data-testid="overview-priority-global"]',
        ]
        const candidates = []
        for (const sel of candidateSelectors) {
          const el = document.querySelector(sel)
          if (!el) continue
          const r = el.getBoundingClientRect()
          // Visible (painted) portion inside mission/#view clip ∩ viewport
          const vTop = Math.max(r.top, clipTop)
          const vBottom = Math.min(r.bottom, clipBottom)
          const vLeft = Math.max(r.left, clipLeft)
          const vRight = Math.min(r.right, clipRight)
          const visH = vBottom - vTop
          const visW = vRight - vLeft
          const visible = visH > 4 && visW > 4 && r.width > 0 && r.height > 0
          candidates.push({
            testId: el.getAttribute('data-testid') || sel,
            top: r.top,
            bottom: r.bottom,
            left: r.left,
            right: r.right,
            // Painted box used for obscure checks (overflow-clipped)
            paintTop: vTop,
            paintBottom: vBottom,
            paintLeft: vLeft,
            paintRight: vRight,
            visible,
            visH,
          })
        }
        const visibleCands = candidates.filter((c) => c.visible)
        visibleCands.sort((a, b) => a.paintTop - b.paintTop)

        let coversNextContent = false
        let overlapsAppBar = false
        let pillBounds = null
        let computed = null
        let intersectionRatio = 0
        let zeroArea = true
        let visuallyVisible = false
        let nextTestId = null
        let nearestContentTestId = null
        let appBarVisible = false
        let appBarBottom = null
        let worstOverlap = 0
        const candidateOverlaps = []

        if (pill) {
          const pr = pill.getBoundingClientRect()
          pillBounds = {
            top: pr.top,
            left: pr.left,
            bottom: pr.bottom,
            right: pr.right,
            width: pr.width,
            height: pr.height,
          }
          zeroArea = pr.width < 1 || pr.height < 1
          const cs = window.getComputedStyle(pill)
          computed = {
            display: cs.display,
            visibility: cs.visibility,
            opacity: cs.opacity,
            position: cs.position,
          }
          const top = Math.max(pr.top, viewRect.top, 0)
          const bottom = Math.min(pr.bottom, viewRect.bottom, vh)
          const left = Math.max(pr.left, viewRect.left, 0)
          const right = Math.min(pr.right, viewRect.right, vw)
          const iw = Math.max(0, right - left)
          const ih = Math.max(0, bottom - top)
          const area = Math.max(0, pr.width * pr.height)
          intersectionRatio = area > 0 ? (iw * ih) / area : 0
          const op = Number(cs.opacity)
          visuallyVisible =
            cs.display !== 'none' &&
            cs.visibility !== 'hidden' &&
            !(Number.isFinite(op) && op <= 0.05) &&
            !zeroArea &&
            intersectionRatio >= 0.999 &&
            ih >= 8

          let worstId = null
          for (const c of visibleCands) {
            // Overlap of pill vs PAINTED candidate rect only (not overflow-hidden tails).
            const overlap =
              Math.min(pr.bottom, c.paintBottom) - Math.max(pr.top, c.paintTop)
            const hit =
              overlap > 8 && pr.bottom > c.paintTop && pr.top < c.paintBottom
            candidateOverlaps.push({
              testId: c.testId,
              visible: true,
              top: c.top,
              bottom: c.bottom,
              paintTop: c.paintTop,
              paintBottom: c.paintBottom,
              overlapPx: Math.max(0, overlap),
              exceeds8: hit,
            })
            if (hit && overlap > worstOverlap) {
              worstOverlap = overlap
              worstId = c.testId
            }
          }
          if (worstId) {
            coversNextContent = true
            nextTestId = worstId
            nearestContentTestId = worstId
          } else {
            const below = visibleCands
              .filter((c) => c.paintTop >= pr.bottom - 8)
              .sort((a, b) => a.paintTop - b.paintTop)
            const nearest = below[0] || visibleCands[0] || null
            if (nearest) {
              nextTestId = nearest.testId
              nearestContentTestId = nearest.testId
            }
            coversNextContent = false
          }

          if (appBar) {
            const ar = appBar.getBoundingClientRect()
            const aTop = Math.max(ar.top, viewRect.top, 0)
            const aBottom = Math.min(ar.bottom, viewRect.bottom, vh)
            const aH = Math.max(0, aBottom - aTop)
            appBarVisible = aH >= 8 && ar.width > 0
            appBarBottom = ar.bottom
            const aOverlap = Math.min(pr.bottom, ar.bottom) - Math.max(pr.top, ar.top)
            overlapsAppBar = aOverlap > 8 && pr.bottom > ar.top && pr.top < ar.bottom
          }
        } else if (appBar) {
          const ar = appBar.getBoundingClientRect()
          const aTop = Math.max(ar.top, viewRect.top, 0)
          const aBottom = Math.min(ar.bottom, viewRect.bottom, vh)
          appBarVisible = Math.max(0, aBottom - aTop) >= 8
          appBarBottom = ar.bottom
        }

        return {
          pillPresent: !!pill,
          pillCountPresent: !!count && (count.textContent || '').trim().length > 0,
          pillSeverityPresent: !!sev && (sev.textContent || '').trim().length > 0,
          pillExpandPresent: !!expandBtn || !!(pill && pill.querySelector('button')),
          dataPillCollapsed: stack?.getAttribute('data-pill-collapsed') ?? null,
          coversNextContent,
          overlapsAppBar,
          appBarVisible,
          appBarBottom,
          scrollTop: scroller ? scroller.scrollTop : 0,
          viewScrollTop: view ? view.scrollTop : 0,
          nextTestId,
          nearestContentTestId,
          worstOverlapPx: worstOverlap,
          candidateOverlaps,
          candidateTestIds: candidates.map((c) => ({
            testId: c.testId,
            visible: c.visible,
            top: c.top,
          })),
          windowScrollY: window.scrollY,
          pillBounds,
          computed,
          viewport: {
            width: vw,
            height: vh,
            viewClientWidth: view && 'clientWidth' in view ? view.clientWidth : null,
            viewClientHeight: view && 'clientHeight' in view ? view.clientHeight : null,
            viewRect: {
              top: viewRect.top,
              left: viewRect.left,
              bottom: viewRect.bottom,
              right: viewRect.right,
              width: viewRect.width,
              height: viewRect.height,
            },
          },
          intersectionRatio,
          zeroArea,
          visuallyVisible,
        }
      })
    }

    const stickyPost = await measureStickyAtCurrentScroll()

    // C3-C10: multi-sample post-collapse scroll positions — cannot pass at one gap.
    const multiSamples = []
    const baseTop = stickyPost.scrollTop || 0
    const sampleDeltas = [0, 90, 180, 300]
    for (const delta of sampleDeltas) {
      await page.evaluate((d) => {
        window.scrollTo(0, 0)
        const mission = document.querySelector('[data-testid="overview-mission-scroll"]')
        const view =
          document.querySelector('#view') ||
          document.querySelector('.content') ||
          document.scrollingElement
        let scroller = view
        if (
          mission instanceof HTMLElement &&
          mission.scrollHeight > mission.clientHeight + 8
        ) {
          scroller = mission
        }
        if (!scroller) return
        const max = Math.max(0, scroller.scrollHeight - scroller.clientHeight)
        const base = Number(d.base) || 0
        const delta = Number(d.delta) || 0
        scroller.scrollTop = Math.min(base + delta, max)
        window.scrollTo(0, 0)
      }, { base: baseTop, delta })
      await page.waitForTimeout(120)
      const sample = await measureStickyAtCurrentScroll()
      multiSamples.push({
        delta,
        scrollTop: sample.scrollTop,
        coversNextContent: sample.coversNextContent === true,
        worstOverlapPx: sample.worstOverlapPx ?? 0,
        nextTestId: sample.nextTestId ?? null,
        pillPresent: sample.pillPresent === true,
        appBarVisible: sample.appBarVisible === true,
        windowScrollY: sample.windowScrollY,
      })
    }
    // Restore primary scroll position for the post screenshot.
    await page.evaluate((top) => {
      window.scrollTo(0, 0)
      const mission = document.querySelector('[data-testid="overview-mission-scroll"]')
      const view =
        document.querySelector('#view') ||
        document.querySelector('.content') ||
        document.scrollingElement
      let scroller = view
      if (
        mission instanceof HTMLElement &&
        mission.scrollHeight > mission.clientHeight + 8
      ) {
        scroller = mission
      }
      if (scroller) scroller.scrollTop = top
      window.scrollTo(0, 0)
    }, baseTop)
    await page.waitForTimeout(100)
    const stickyPostFinal = await measureStickyAtCurrentScroll()
    stickyPostFinal.scrollSamples = multiSamples
    stickyPostFinal.multiSampleCoversContent = multiSamples.some((s) => s.coversNextContent)
    // If any sample covers content, fail closed on the primary measurement too.
    if (stickyPostFinal.multiSampleCoversContent) {
      stickyPostFinal.coversNextContent = true
      const bad = multiSamples.find((s) => s.coversNextContent)
      if (bad?.nextTestId) stickyPostFinal.nextTestId = bad.nextTestId
    }

    await page.screenshot({ path: stickyPostPath, fullPage: false })

    // Program-emitted PNG dimension check (390×844 sticky pair)
    function readPngSize(filePath) {
      try {
        const fd = fs.openSync(filePath, 'r')
        const buf = Buffer.alloc(24)
        fs.readSync(fd, buf, 0, 24, 0)
        fs.closeSync(fd)
        // PNG IHDR: width @8, height @12 after 8-byte signature
        if (buf.toString('ascii', 1, 4) !== 'PNG') return null
        return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
      } catch {
        return null
      }
    }
    const preDims = readPngSize(stickyPrePath)
    const postDims = readPngSize(stickyPostPath)

    const stickyInput = {
      usedWindowScrollYAlone: false,
      scrollContainerSelector:
        scrollResult?.scrollContainerSelector || stickyMeta.scrollContainerSelector,
      preScrollShotPath: stickyPrePath,
      postScrollShotPath: stickyPostPath,
      decisionCardPresent: stickyMeta.decisionCardPresent,
      requiredScrollTopMin: stickyMeta.canScroll ? 40 : 0,
      screenshotDims: {
        pre: preDims,
        post: postDims,
        expectedWidth: 390,
        expectedHeight: 844,
      },
      postScroll: stickyPostFinal,
      scrollResult,
      scrollSamples: multiSamples,
      shelfLayout: stickyMeta.shelfLayout === true,
    }
    // If decision card never rendered, sticky is still a fail (product/fixture gap)
    probes.stickyDecision = stickyInput
    probes.verdicts.stickyDecision = evaluateStickyDecision(stickyInput)

    // --- Public redaction (canary-based; no broad legit-schema false positives) ---
    try {
      const base = process.env.WEB_BASE
      const res = await fetch(
        `${base}/api/public-snapshot?boardId=${encodeURIComponent(boardId)}`,
      )
      const text = await res.text()
      let body = null
      try {
        body = JSON.parse(text)
      } catch {
        body = null
      }
      // Sanitized proof only — never store credential/canary values
      const redaction = evaluatePublicRedaction({
        status: res.status,
        bodyText: text,
        body,
        canaries: REDACTION_CANARIES,
      })
      probes.publicSnapshot = {
        status: res.status,
        sample: text.slice(0, 280).replace(
          new RegExp(listCanaryValues().map((c) => c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'g'),
          '[CANARY_REDACTED]',
        ),
        bodyByteLength: text.length,
        canaryLeakCount: redaction.canaryHits?.length ?? 0,
        forbiddenKeyHits: redaction.forbiddenKeyHits ?? [],
        // Explicit: do not report broad hasSecret boolean
      }
      probes.verdicts.publicRedaction = redaction
    } catch (e) {
      probes.publicSnapshot = { error: String(e) }
      probes.verdicts.publicRedaction = evaluatePublicRedaction({ error: String(e) })
    }

    // --- Session denial (separate context, no storage) ---
    const browser = page.context().browser()
    const bare = await browser.newContext({
      baseURL: process.env.WEB_BASE,
      ignoreHTTPSErrors: true,
    })
    const barePage = await bare.newPage()
    const denials = []
    for (const pth of [`/b/${boardId}/`, `/b/${boardId}/work`, `/b/${boardId}/priority`]) {
      await barePage.goto(pth, { waitUntil: 'domcontentloaded' })
      await barePage.waitForTimeout(300)
      denials.push({
        path: pth,
        url: barePage.url(),
        denied: barePage.url().includes('/login'),
      })
    }
    probes.sessionDenial = denials
    probes.verdicts.sessionDenial = evaluateSessionDenial(denials)
    await bare.close()

    // --- Raw STALE: literal path without router serialization ---
    const stalePath = `/b/${boardId}/work?stale=1`
    const consoleBeforeStale = probeConsole.length
    // page.goto with literal string — not router.navigate / search-param builder
    await page.goto(stalePath, { waitUntil: 'domcontentloaded', timeout: 60_000 })
    await page.waitForTimeout(500)
    let authShellOk = false
    let authErr = null
    try {
      await assertAuthenticatedOwnerShell(page, { boardId })
      authShellOk = true
    } catch (e) {
      authErr = String(e?.message || e)
    }
    const staleDom = await page.evaluate(() => {
      const screen = document.querySelector('[data-testid="work-screen"]')
      const staleBtn = document.querySelector('[data-testid="work-stale-overlay"]')
      const errBoundary =
        !!document.querySelector('[data-testid="error-boundary"]') ||
        !!document.querySelector('#error-page') ||
        /something went wrong|application error/i.test(document.body?.innerText || '')
      return {
        workScreenPresent: !!screen,
        staleActive:
          screen?.getAttribute('data-stale-overlay') === '1' ||
          staleBtn?.getAttribute('aria-checked') === 'true',
        staleBtnPresent: !!staleBtn,
        errorBoundaryPresent: errBoundary,
        url: location.pathname + location.search,
      }
    })
    const rawStaleInput = {
      literalPath: stalePath,
      navigationUsedRouterSerialize: false,
      authShellOk,
      authErr,
      workScreenPresent: staleDom.workScreenPresent,
      staleActive: staleDom.staleActive,
      errorBoundaryPresent: staleDom.errorBoundaryPresent,
      consoleErrorDuringNav: probeConsole.length > consoleBeforeStale,
      finalUrl: staleDom.url,
    }
    probes.rawStale = rawStaleInput
    probes.verdicts.rawStale = evaluateRawStale(rawStaleInput)

    // --- ONGOING zero-click fields (Overview surface, not query-string alone) ---
    await page.setViewportSize(VIEWPORTS['1440x900'])
    await page.goto(`/b/${boardId}/`, { waitUntil: 'domcontentloaded', timeout: 60_000 })
    await page.waitForTimeout(500)
    await assertAuthenticatedOwnerShell(page, { boardId })
    const ongoingDom = await page.evaluate((seededTaskId) => {
      const section = document.querySelector('[data-testid="overview-ongoing"]')
      const cards = [...document.querySelectorAll('[data-testid="overview-ongoing-card"]')]
      const card =
        cards.find((c) => c.getAttribute('data-task-id') === seededTaskId) || cards[0] || null
      const textOf = (el) => (el?.textContent || '').trim()
      const field = (root, name) => root?.querySelector(`[data-field="${name}"]`)
      if (!card) {
        return {
          sectionPresent: !!section,
          foundTaskId: null,
          visibleFields: {},
        }
      }
      const taskIdEl = card.querySelector('.taskId, [data-field="task-id"]')
      const titleEl = card.querySelector('h3, .ongoingTitle, [data-field="title"]')
      const chips = [...card.querySelectorAll('.chip, [class*="chip"]')].map((c) => textOf(c))
      const chipBlob = chips.join(' | ')
      const visibleFields = {
        taskId:
          !!taskIdEl ||
          card.getAttribute('data-task-id') === seededTaskId ||
          chipBlob.includes(seededTaskId),
        title: !!titleEl && textOf(titleEl).length > 0,
        targetGate: /gate/i.test(chipBlob),
        agentId: /agent/i.test(chipBlob),
        role: /role/i.test(chipBlob),
        model: /grok|gpt|claude|model/i.test(chipBlob) || chips.some((c) => /4\.|3\./.test(c)),
        effort: /effort/i.test(chipBlob),
        maskedAccount: !!field(card, 'masked-account') || /\*{2,}|masked|acc_/i.test(chipBlob),
        startedAge: !!field(card, 'started-age') || /started/i.test(card.innerText || ''),
        heartbeatAge: !!field(card, 'heartbeat-age') || /heartbeat/i.test(card.innerText || ''),
        materialProgressAge:
          !!field(card, 'material-age') || /material progress/i.test(card.innerText || ''),
        evidence: !!field(card, 'evidence'),
      }
      return {
        sectionPresent: !!section,
        foundTaskId: card.getAttribute('data-task-id'),
        cardCount: cards.length,
        visibleFields,
      }
    }, SEEDED_ONGOING.taskId)

    // Also record work deep-link query presence (supplementary, not sufficient)
    await page.goto(`/b/${boardId}/work?bucket=ONGOING`, { waitUntil: 'domcontentloaded' })
    const hasOngoingQuery = page.url().includes('ONGOING')
    const ongoingInput = {
      hasOngoingQuery,
      onlyQueryString: false,
      sectionPresent: ongoingDom.sectionPresent,
      visibleFields: ongoingDom.visibleFields || {},
      seededTaskId: SEEDED_ONGOING.taskId,
      foundTaskId: ongoingDom.foundTaskId,
    }
    probes.ongoingZeroClick = {
      ...ongoingInput,
      overviewCardCount: ongoingDom.cardCount ?? 0,
      workUrl: page.url(),
    }
    probes.verdicts.ongoingZeroClick = evaluateOngoingZeroClick(ongoingInput)

    // --- Touch targets @ 390 — fail if any visible in-scope control < 44×44 ---
    await page.setViewportSize(VIEWPORTS['390x844'])
    await page.goto(`/b/${boardId}/`, { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(400)
    probes.touch = await page.evaluate((sel) => {
      const nodes = [...document.querySelectorAll(sel)]
        .map((el) => {
          const r = el.getBoundingClientRect()
          const style = getComputedStyle(el)
          const hidden =
            style.visibility === 'hidden' ||
            style.display === 'none' ||
            r.width === 0 ||
            r.height === 0
          if (hidden) return null
          // Skip pure text links that are inline body content outside chrome
          const testid = el.getAttribute('data-testid') || null
          const id = el.id || null
          let selector = el.tagName.toLowerCase()
          if (testid) selector = `[data-testid="${testid}"]`
          else if (id) selector = `#${id}`
          else if (el.className && typeof el.className === 'string') {
            const c = el.className.trim().split(/\s+/).slice(0, 2).join('.')
            if (c) selector = `${el.tagName.toLowerCase()}.${c}`
          }
          return {
            w: Math.round(r.width),
            h: Math.round(r.height),
            ok44: r.width >= 44 && r.height >= 44,
            testid,
            selector,
            text: (el.textContent || '').trim().slice(0, 40),
          }
        })
        .filter(Boolean)
      const failing = nodes.filter((n) => !n.ok44)
      return {
        total: nodes.length,
        failing: failing.length,
        sampleFail: failing.slice(0, 12).map(({ w, h, testid, selector, text }) => ({
          w,
          h,
          testid,
          selector,
          text,
        })),
      }
    }, TOUCH_SELECTORS)
    probes.verdicts.touch = evaluateTouch(probes.touch)

    probes.probeConsoleErrors = probeConsole
  } finally {
    page.off('console', onConsole)
    page.off('pageerror', onPageError)
  }

  writeJson('probes/probes.json', probes)
  return probes
}

async function runFull() {
  ensureOutDirs()
  const runStartedMs = Date.now()
  const boardId = process.env.BOARD_ID?.trim() || DEFAULT_BOARD_ID
  const headed = resolveHeaded()
  const preferPort = process.env.CAIRN_HARNESS_PORT
    ? Number(process.env.CAIRN_HARNESS_PORT)
    : undefined
  const failHardAxe = !argFlag('--skip-axe-fail')
  const keepDb = argFlag('--keep-db')
  const noBrowser = argFlag('--no-browser')
  // Fail-closed SHA before any claimed capture (never UNKNOWN_SHA on summary/manifest).
  const fullSha = assertFullSha({ cwd: ROOT })
  console.log(`HARNESS_FULL_SHA: ${fullSha}`)
  assertPlannedCaptureContract(boardId)

  let server = null
  let dbName = null
  let syntheticPrincipal = null
  let parentEnvSnapshot = {}
  let cleanup = {
    portFree: null,
    dbDropped: null,
    serverStop: null,
    parentEnvRestored: null,
    authCleanup: null,
  }

  try {
    // 1) Seed isolated DB
    const provenancePath = path.join(OUT_ROOT, 'SYNTHETIC_PROVENANCE.json')
    const seedResult = await seedIsolatedControlCenter({
      boardId,
      provenancePath,
      slug: 'r4f',
    })
    dbName = seedResult.isoDb
    const pins = pinsFromProvenance(seedResult)
    if (Object.values(pins).some((v) => v === PIN_MISSING)) {
      throw new Error(`HARNESS FAIL: seed pins MISSING after valid fixture: ${JSON.stringify(pins)}`)
    }
    writeJson('logs/seed.json', seedResult)

    // 1b) Per-run synthetic ROOT principal (memory only — never written to disk/logs)
    syntheticPrincipal = createSyntheticRootPrincipal({ boardId })
    const childBearerEnv = buildChildBearerEnv(syntheticPrincipal)

    // 2) Start owned server bound to iso DB + child-only CAIRN_BEARER_PRINCIPALS_JSON
    const port = preferPort && Number.isFinite(preferPort) ? preferPort : await pickFreePort(0)
    // Parent process: only set non-secret DB name for seed helpers; never set bearer env on parent.
    parentEnvSnapshot.CAIRN_DB_NAME = process.env.CAIRN_DB_NAME
    parentEnvSnapshot.BOARD_ID = process.env.BOARD_ID
    parentEnvSnapshot.WEB_BASE = process.env.WEB_BASE
    parentEnvSnapshot.CAIRN_E2E_USERNAME = process.env.CAIRN_E2E_USERNAME
    parentEnvSnapshot.CAIRN_E2E_PASSWORD = process.env.CAIRN_E2E_PASSWORD
    process.env.CAIRN_DB_NAME = dbName
    process.env.BOARD_ID = boardId
    server = await startOwnedPreviewServer({
      port,
      preferredPort: port,
      env: {
        CAIRN_DB_NAME: dbName,
        CAIRN_DB_HOST: seedResult.mysql.host,
        CAIRN_DB_PORT: String(seedResult.mysql.port),
        CAIRN_DB_USER: seedResult.mysql.user,
        // password from process env / .env already in child env via spread
        // Synthetic ROOT principals JSON — child process only (MCP auth boundary)
        ...childBearerEnv,
      },
      logDir: path.join(OUT_ROOT, 'logs'),
      healthTimeoutMs: 120_000,
    })
    process.env.WEB_BASE = server.baseUrl
    printOwnerTarget({
      flow: 'deterministic-control-center-harness',
      board: boardId,
      account: 'synthetic-isolated-OWNER',
      device: 'playwright-chromium',
      port: server.port,
      isoDb: dbName,
      runId: RUN_ID,
    })
    writeJson('logs/server.json', {
      pid: server.pid,
      port: server.port,
      baseUrl: server.baseUrl,
      health: server.health,
      logPath: server.logPath,
      // names only — never values of bearer env
      injectedEnvKeys: server.injectedEnvKeys ?? Object.keys(childBearerEnv),
      syntheticRootPrincipal: syntheticPrincipal.principalMeta,
    })

    // 2b) Authorized control-plane bootstrap (dispatch plan + account-sync via real /mcp).
    // Fail-closed: pin mismatch / MCP auth / readback failure throws → non-zero exit.
    // In-memory stores live only in the preview process — seed alone cannot fill them.
    const authorityPin = buildHarnessPin()
    const runtimePinProbe = await probeRuntimePin(server.baseUrl, {
      bearer: syntheticPrincipal.bearer,
      secrets: [syntheticPrincipal.bearer],
    })
    // Receipt must never contain bearer
    writeJson(
      'logs/runtime-pin-probe.json',
      redactSecretsDeep(runtimePinProbe, [syntheticPrincipal.bearer]),
    )
    let cpBootstrap
    try {
      cpBootstrap = await bootstrapControlPlaneOnServer({
        baseUrl: server.baseUrl,
        boardId,
        pin: authorityPin,
        authorityPin,
        runtimePin: runtimePinProbe,
        bearer: syntheticPrincipal.bearer,
        requireBearer: true,
        failClosed: true,
        principalMeta: syntheticPrincipal.principalMeta,
        dispatchSeed: buildDispatchPlanSeed(undefined, authorityPin),
        accountSyncSeed: buildAccountSyncSeed(undefined, authorityPin),
      })
    } catch (e) {
      const detail =
        e instanceof ControlPlaneBootstrapError
          ? redactSecretsDeep(
              { name: e.name, code: e.code, message: e.message, detail: e.detail },
              [syntheticPrincipal.bearer],
            )
          : { message: String(e?.message || e) }
      writeJson('logs/control-plane-bootstrap.json', {
        ok: false,
        failClosed: true,
        error: detail,
      })
      throw e
    }
    writeJson(
      'logs/control-plane-bootstrap.json',
      redactSecretsDeep(cpBootstrap, [syntheticPrincipal.bearer]),
    )
    if (!cpBootstrap.ok) {
      throw new ControlPlaneBootstrapError(
        'HARNESS FAIL: control-plane bootstrap returned ok:false (fail-closed)',
        { code: 'CONTROL_PLANE_BOOTSTRAP_FAIL', result: cpBootstrap },
      )
    }

    if (noBrowser) {
      const out = {
        mode: 'no-browser',
        server: server.baseUrl,
        dbName,
        pins,
        authorityPin: {
          taskHash: authorityPin.taskHash,
          boardRev: authorityPin.boardRev,
          lifecycleRev: authorityPin.lifecycleRev,
          canonicalSnapshotId: authorityPin.canonicalSnapshotId,
        },
        controlPlaneBootstrapOk: cpBootstrap.ok,
        controlPlaneResiduals: cpBootstrap.residuals,
        planReadback: cpBootstrap.planReadback ?? null,
        accountReadback: cpBootstrap.accountReadback ?? null,
        syntheticRootPrincipal: syntheticPrincipal.principalMeta,
        seedProof: seedResult.seedProof ?? null,
      }
      console.log(JSON.stringify(redactSecretsDeep(out, [syntheticPrincipal.bearer]), null, 2))
      return out
    }

    // 3) Bootstrap login (zero users → create first OWNER)
    // C3-C9: isolated auth ONLY under OUT_ROOT/auth — never write canonical
    // qa/e2e/fixtures/storage/admin.json (AUTH_STORAGE_STATE_PATH).
    const creds = synthCredentials()
    const authDir = path.join(OUT_ROOT, 'auth')
    const storagePath = path.join(authDir, 'storageState.json')
    fs.mkdirSync(authDir, { recursive: true })

    const browser = await chromium.launch({ headless: !headed })
    try {
      try {
        const bootCtx = await browser.newContext({
          baseURL: server.baseUrl,
          viewport: { width: 1440, height: 900 },
        })
        const bootPage = await bootCtx.newPage()
        await bootstrapLogin(bootPage, creds, storagePath)
        // Intentionally do NOT write AUTH_STORAGE_STATE_PATH / fixtures/storage/admin.json
        await bootCtx.close()

        const ctx = await browser.newContext({
          baseURL: server.baseUrl,
          viewport: { width: 1440, height: 900 },
          storageState: requireExistingStorageState(storagePath),
          ignoreHTTPSErrors: true,
        })
        const page = await ctx.newPage()

        // Clear prior global manifest for this run version
        clearDirContents(path.join(OUT_ROOT, 'screenshots'), { keepGitkeep: false })
        fs.mkdirSync(path.join(OUT_ROOT, 'screenshots/fullpage'), { recursive: true })
        const collector = new ScreenshotManifestCollector({ runId: RUN_ID, version: 1 })
        collector.clear()

        const matrix = await captureMatrix({
          page,
          boardId,
          pins,
          runStartedMs,
          collector,
          failHardAxe,
          fullSha,
        })
        const probes = await runProbes(page, boardId, storagePath)

        const manifestPath = path.join(OUT_ROOT, 'SCREENSHOT_MANIFEST.json')
        collector.write(manifestPath)
        // Also publish to qa/e2e/manifests/screenshot-manifest.latest.json (fresh overwrite)
        collector.write(DEFAULT_MANIFEST_PATH)

        const axeFail = matrix.axeSummary.filter((a) => !a.ok).length
        const overflowFail = matrix.overflowSummary.filter((o) => o.overflow).length

        // Partition network: only APP failures fail-close; serverFn SPA aborts are allowlisted
        const networkPartition = partitionNetworkFailures(matrix.networkFailures || [])
        const consoleNetworkVerdict = evaluateConsoleNetwork({
          consoleErrors: [
            ...(matrix.consoleErrors || []),
            ...(probes.probeConsoleErrors || []),
          ],
          networkFailures: matrix.networkFailures || [],
        })

        // C3-R3H: aggregate every probe + matrix signal; fail-close on any required failure
        const agg = aggregateProbeVerdicts({
          publicRedaction: probes.verdicts?.publicRedaction,
          stickyDecision: probes.verdicts?.stickyDecision,
          rawStale: probes.verdicts?.rawStale,
          touch: probes.verdicts?.touch,
          ongoingZeroClick: probes.verdicts?.ongoingZeroClick,
          sessionDenial: probes.verdicts?.sessionDenial,
          focus: probes.verdicts?.focus,
          reducedMotion: probes.verdicts?.reducedMotion,
          consoleErrors: [
            ...(matrix.consoleErrors || []),
            ...(probes.probeConsoleErrors || []),
          ],
          // Pass only APP-class failures into aggregate (allowlisted aborts already filtered
          // inside evaluateConsoleNetwork; pass raw so classification is recorded once).
          networkFailures: matrix.networkFailures || [],
          overflowSummary: matrix.overflowSummary,
          mobileShellSummary: matrix.mobileShellSummary,
          axeSummary: matrix.axeSummary,
          skipAxeFail: !failHardAxe,
        })
        writeJson('probes/verdicts.json', {
          failCount: agg.failCount,
          ok: agg.ok,
          summaryLines: agg.summaryLines,
          failureMessages: agg.failureMessages,
          verdicts: agg.verdicts.map((v) => ({
            name: v.name,
            ok: v.ok,
            failures: v.failures,
            ...(v.name === 'consoleNetwork'
              ? {
                  networkCount: v.networkCount,
                  networkAllowlistedCount: v.networkAllowlistedCount,
                  networkClassifications: v.networkClassifications,
                }
              : {}),
          })),
        })

        const bookkeeping =
          matrix.bookkeeping ||
          accountCaptureCounts({
            planned: matrix.plannedCount,
            captured: matrix.captured,
            skipped: matrix.skipped || [],
            error: matrix.errors || [],
          })
        if (!bookkeeping.consistent) {
          throw new Error(
            `HARNESS FAIL: capture bookkeeping inconsistent at summary: ${JSON.stringify(bookkeeping)}`,
          )
        }
        if (!isFullSha(fullSha) || fullSha === 'UNKNOWN_SHA') {
          throw new Error(`HARNESS FAIL: fullSha not a real 40-char SHA: ${fullSha}`)
        }

        const summary = {
          runId: RUN_ID,
          mode: 'full',
          boardId,
          isoDb: dbName,
          baseUrl: server.baseUrl,
          schemaVersion: resolveSchemaVersion(),
          fullSha,
          pins,
          pinFields: 'PRESENT',
          captured: bookkeeping.captured,
          planned: bookkeeping.planned,
          skipped: bookkeeping.skipped,
          errors: bookkeeping.error,
          captureBookkeeping: bookkeeping,
          axeFail,
          overflowFail,
          mobileShellRows: (matrix.mobileShellSummary || []).length,
          mobileShellOk: agg.verdicts.find((v) => v.name === 'mobileShellContainment')?.ok ?? null,
          consoleErrors: matrix.consoleErrors.length,
          /** APP-class only (fail-close signal). */
          networkFailures: networkPartition.appFailures.length,
          /** Raw requestfailed count before allowlist. */
          networkFailuresRaw: (matrix.networkFailures || []).length,
          networkAllowlisted: networkPartition.allowlisted.length,
          networkClassifications: networkPartition.classifications,
          consoleNetwork: {
            ok: consoleNetworkVerdict.ok,
            networkCount: consoleNetworkVerdict.networkCount,
            networkAllowlistedCount: consoleNetworkVerdict.networkAllowlistedCount,
          },
          focusOk: probes.focus?.focusOk,
          sessionDenial: probes.sessionDenial,
          publicSnapshot: probes.publicSnapshot,
          probeFailCount: agg.failCount,
          probeVerdicts: agg.summaryLines,
          probeFailures: agg.failureMessages,
          stickyDecision: {
            ok: probes.verdicts?.stickyDecision?.ok ?? null,
            scrollContainer: probes.stickyDecision?.scrollContainerSelector ?? null,
          },
          rawStale: {
            ok: probes.verdicts?.rawStale?.ok ?? null,
            path: probes.rawStale?.literalPath ?? null,
          },
          touch: {
            ok: probes.verdicts?.touch?.ok ?? null,
            failing: probes.touch?.failing ?? null,
            total: probes.touch?.total ?? null,
          },
          ongoingZeroClick: {
            ok: probes.verdicts?.ongoingZeroClick?.ok ?? null,
            foundTaskId: probes.ongoingZeroClick?.foundTaskId ?? null,
          },
          publicRedaction: {
            ok: probes.verdicts?.publicRedaction?.ok ?? null,
            status: probes.publicSnapshot?.status ?? null,
            canaryLeakCount: probes.publicSnapshot?.canaryLeakCount ?? null,
          },
          manifestPath,
          outRoot: OUT_ROOT,
        }
        writeJson('logs/summary.json', summary)
        writeJson('logs/axe-summary.json', matrix.axeSummary)
        writeJson('logs/overflow-summary.json', matrix.overflowSummary)
        writeJson('logs/mobile-shell-summary.json', matrix.mobileShellSummary || [])
        writeJson('logs/console-errors.json', matrix.consoleErrors)
        writeJson('logs/network-failures.json', {
          raw: matrix.networkFailures,
          appFailures: networkPartition.appFailures,
          allowlisted: networkPartition.allowlisted,
          classifications: networkPartition.classifications,
        })
        writeJson('logs/capture-bookkeeping.json', bookkeeping)

        await ctx.close()

        // Fail-close: any required probe / matrix failure ends the run non-zero
        assertProbesFailClosed(agg)

        console.log(JSON.stringify({ ok: true, ...summary }, null, 2))
        return summary
      } finally {
        // Erase auth while browser is closing — success AND thrown failure.
        cleanup.authCleanup = eraseHarnessAuthArtifacts(authDir)
      }
    } finally {
      await browser.close()
      // Second-chance erase if first finally raced with open handles
      if (!cleanup.authCleanup || cleanup.authCleanup.authDirAbsent !== true) {
        cleanup.authCleanup = eraseHarnessAuthArtifacts(authDir)
      }
    }
  } finally {
    // 4) Cleanup: only owned process + unique DB + drop synthetic principal refs
    // Always erase auth (covers early throws before browser launch)
    if (!cleanup.authCleanup) {
      cleanup.authCleanup = eraseHarnessAuthArtifacts(path.join(OUT_ROOT, 'auth'))
    }
    if (server?.stop) {
      cleanup.serverStop = await server.stop()
      cleanup.portFree = await portIsFree(server.port)
    }
    if (dbName && !keepDb) {
      const drop = await dropIsolatedDatabase(dbName)
      cleanup.dbDropped = drop
      cleanup.dbStillPresent = await databaseExists(dbName)
    } else if (dbName && keepDb) {
      cleanup.dbDropped = { skipped: true, dbName }
    }
    // Restore parent env mutations (never leave CAIRN_BEARER_* on parent — we never set them)
    for (const key of ['CAIRN_DB_NAME', 'BOARD_ID', 'WEB_BASE', 'CAIRN_E2E_USERNAME', 'CAIRN_E2E_PASSWORD']) {
      if (parentEnvSnapshot[key] === undefined) delete process.env[key]
      else process.env[key] = parentEnvSnapshot[key]
    }
    // Defense: if anything set bearer env on parent, delete it
    delete process.env.CAIRN_BEARER_PRINCIPALS_JSON
    delete process.env.CAIRN_MCP_BEARER
    cleanup.parentEnvRestored = true
    // Drop in-memory principal (GC); do not log bearer
    if (syntheticPrincipal) {
      syntheticPrincipal.bearer = ''
      syntheticPrincipal.principalsJson = ''
      syntheticPrincipal = null
    }
    writeJson('logs/cleanup.json', cleanup)
    console.log(JSON.stringify({ cleanup }, null, 2))
    if (server && cleanup.portFree === false) {
      console.error('WARN: owned port still busy after stop')
    }
    if (dbName && !keepDb && cleanup.dbStillPresent) {
      console.error(`WARN: iso DB still present: ${dbName}`)
    }
  }
}

async function main() {
  ensureOutDirs()
  printOwnerTarget({ flow: 'deterministic-control-center-harness', runId: RUN_ID })

  if (argFlag('--self-test')) {
    const r = await runSelfTest()
    process.exitCode = r.failCount === 0 ? 0 : 1
    return
  }

  if (argFlag('--seed-only')) {
    const provenancePath = path.join(OUT_ROOT, 'SYNTHETIC_PROVENANCE.json')
    const seedResult = await seedIsolatedControlCenter({
      boardId: process.env.BOARD_ID?.trim() || DEFAULT_BOARD_ID,
      provenancePath,
      slug: 'r4f',
    })
    console.log(JSON.stringify(seedResult, null, 2))
    process.exitCode = 0
    return
  }

  try {
    await runFull()
    process.exitCode = 0
  } catch (e) {
    console.error(String(e?.stack || e))
    writeJson('logs/fatal.json', { error: String(e?.stack || e), runId: RUN_ID })
    process.exitCode = 1
  }
}

main()
