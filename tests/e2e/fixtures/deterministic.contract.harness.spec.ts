/**
 * C3-R2D deterministic harness contract self-checks (no server / no MySQL / no browser).
 * Matched by project harness-contract (*.contract.harness.spec.ts).
 *
 * Full lifecycle execution: node qa/e2e/flows/deterministic-control-center-harness.mjs
 */
import { expect, test } from '@playwright/test'
import path from 'node:path'

import {
  ScreenshotManifestCollector,
  buildManifestRow,
  classifyAuthSurface,
  assertNotLoginCapture,
  probeAuthDomSignals,
  validateManifestRow,
  PIN_MISSING,
  HARNESS_VIEWPORTS,
} from './index'

const ROOT = process.cwd()

test.describe('C3-R2D deterministic harness contract (no server)', () => {
  test('viewport table 1440/1024/390/360 present', () => {
    expect(HARNESS_VIEWPORTS['chromium-1440']).toEqual({ width: 1440, height: 900 })
    expect(HARNESS_VIEWPORTS['chromium-1024']).toEqual({ width: 1024, height: 768 })
    expect(HARNESS_VIEWPORTS['chromium-390']).toEqual({ width: 390, height: 844 })
    expect(HARNESS_VIEWPORTS['chromium-360']).toEqual({ width: 360, height: 800 })
  })

  test('auth surface classifier rejects login / accepts OWNER shell', () => {
    expect(
      classifyAuthSurface({
        url: 'http://127.0.0.1:3210/login',
        hasLoginForm: true,
        hasSidebar: false,
        hasBrand: false,
        boardId: 'mfs-rebuild',
      }).ok,
    ).toBe(false)
    expect(
      classifyAuthSurface({
        url: 'http://127.0.0.1:3210/b/mfs-rebuild/work',
        hasLoginForm: false,
        hasSidebar: true,
        hasBrand: true,
        boardId: 'mfs-rebuild',
      }).ok,
    ).toBe(true)
    expect(
      classifyAuthSurface({
        url: 'http://127.0.0.1:3210/b/other/work',
        hasLoginForm: false,
        hasSidebar: true,
        hasBrand: true,
        boardId: 'mfs-rebuild',
      }).reason,
    ).toBe('board_mismatch')
  })

  test('C3-R5A auth guards are false-positive-free for bootstrap prose and setup-copy', () => {
    // Evidence/Log fixtures may contain "bootstrap" body text; only real auth surfaces should fail.
    const evidenceBodyProbe = probeAuthDomSignals({
      hasAuthCard: false,
      hasAuthPage: false,
      hasAuthForm: false,
      hasUsernameInput: false,
      bodyText:
        'Evidence: system bootstrap summary includes bootstrapped tasks and lifecycle checkpoints.',
      hasSidebar: true,
      brand: 'MFS',
    })
    expect(evidenceBodyProbe.loginForm).toBe(false)
    expect(evidenceBodyProbe.setupCopy).toBe(false)

    expect(
      classifyAuthSurface({
        url: 'http://127.0.0.1:3210/b/mfs-rebuild/evidence',
        hasLoginForm: false,
        hasSidebar: true,
        hasBrand: true,
        boardId: 'mfs-rebuild',
      }).ok,
    ).toBe(true)

    // Actual setup UI is deterministic on auth surface title, not body-only prose.
    expect(
      probeAuthDomSignals({
        hasAuthCard: true,
        authTitle: 'Create the first admin',
      }).setupCopy,
    ).toBe(true)
    expect(
      classifyAuthSurface({
        url: 'http://127.0.0.1:3210/b/mfs-rebuild/setup',
        hasLoginForm: false,
        hasSetupUi: true,
        hasSidebar: false,
        hasBrand: false,
        boardId: 'mfs-rebuild',
      }).reason,
    ).toBe('setup_ui')

    // Existing deny-closed boundaries still fail.
    expect(
      classifyAuthSurface({
        url: 'http://127.0.0.1:3210/login',
        hasLoginForm: false,
        hasSidebar: false,
        hasBrand: false,
        boardId: 'mfs-rebuild',
      }).reason,
    ).toBe('auth_route')
    expect(
      classifyAuthSurface({
        url: 'http://127.0.0.1:3210/b/mfs-rebuild/overview',
        hasLoginForm: true,
        hasSidebar: true,
        hasBrand: true,
        boardId: 'mfs-rebuild',
      }).reason,
    ).toBe('login_form')
    expect(
      classifyAuthSurface({
        url: 'http://127.0.0.1:3210/b/mfs-rebuild/overview',
        hasLoginForm: false,
        hasSidebar: false,
        hasBrand: true,
        boardId: 'mfs-rebuild',
      }).reason,
    ).toBe('no_sidebar')
    expect(
      classifyAuthSurface({
        url: 'http://127.0.0.1:3210/b/mfs-rebuild/overview',
        hasLoginForm: false,
        hasSidebar: true,
        hasBrand: false,
        boardId: 'mfs-rebuild',
      }).reason,
    ).toBe('no_brand')
  })

  test('capture guard rejects login URL as authenticated proof', () => {
    expect(() =>
      assertNotLoginCapture({ url: 'http://x/login', filename: 'Overview_1440.png' }),
    ).toThrow(/CAPTURE_GUARD FAIL/)
    expect(() =>
      assertNotLoginCapture({
        url: 'http://x/b/mfs-rebuild/',
        filename: 'Overview_1440.png',
        loginFormPresent: false,
      }),
    ).not.toThrow()
  })

  test('manifest fresh clear + PRESENT pins for valid fixture (no MISSING)', () => {
    const c = new ScreenshotManifestCollector({ runId: 'contract-run' })
    c.clear()
    c.add({
      route: '/b/mfs-rebuild/',
      state: 'populated',
      viewport: '1440x900',
      browserTestId: 'contract-present-pins',
      accessibilityResult: 'qa/e2e/out/axe/placeholder.json',
      missionQuestionLink: 'Q1',
      pins: {
        canonicalSnapshotId: 'synth-c3-r2d-snap-001',
        canonicalHash: 'a1b2c3d4e5f60718293a4b5c6d7e8f901234567890abcdef1234567890ab',
        boardRev: '7',
        lifecycleRev: '3',
      },
    })
    expect(c.rows).toHaveLength(1)
    expect(c.rows[0].pinFields).toBe('PRESENT')
    expect(c.rows[0].boardRev).not.toBe(PIN_MISSING)
    expect(validateManifestRow(c.rows[0])).toEqual([])
    const m = c.toManifest()
    expect(m.runId).toBe('contract-run')
    expect(m.rowCount).toBe(1)
  })

  test('manifest without pins stays MISSING (honest, no fabrication)', () => {
    const row = buildManifestRow({
      route: '/b/mfs-rebuild/',
      state: 'populated',
      viewport: '1440x900',
      browserTestId: 'missing-pins',
      accessibilityResult: 'none',
      missionQuestionLink: null,
    })
    expect(row.pinFields).toBe('MISSING')
  })

  test('promoted pure fixture contract module validates overlays', async () => {
    // Dynamic import of promoted ESM fixture (no MySQL)
    const mod = await import(
      pathToFileUrl(path.join(ROOT, 'qa/e2e/fixtures/seed/control-center-fixture.mjs'))
    )
    const v = mod.validateFixtureContract()
    expect(v.ok).toBe(true)
    expect(v.taskCount).toBeGreaterThanOrEqual(8)
    expect(v.decisionCount).toBeGreaterThanOrEqual(3)
    expect(mod.listRequiredOverlayTaskIds()).toEqual(
      expect.arrayContaining([
        'task-done-1',
        'task-ongoing-1',
        'task-next-1',
        'task-queued-1',
        'task-blocked-1',
        'task-recon-1',
        'task-stale-1',
      ]),
    )
  })

  test('route matrix plans all viewports for core + secondary coverage', async () => {
    const mod = await import(
      pathToFileUrl(path.join(ROOT, 'qa/e2e/lib/routes-matrix.mjs'))
    )
    const n = mod.countPlannedCaptures('mfs-rebuild')
    expect(n).toBeGreaterThanOrEqual(30)
    const routes = mod.buildRouteMatrix('mfs-rebuild')
    const core = routes.filter((r: { core: boolean }) => r.core)
    for (const r of core) {
      expect(mod.viewportsForRoute(r)).toHaveLength(4)
    }
  })

  test('C3-C6 planned capture count is exact 53 and bookkeeping balances', async () => {
    const mod = await import(
      pathToFileUrl(path.join(ROOT, 'qa/e2e/lib/routes-matrix.mjs'))
    )
    expect(mod.EXPECTED_PLANNED_CAPTURES_MFS).toBe(53)
    expect(mod.countPlannedCaptures('mfs-rebuild')).toBe(53)
    expect(mod.planCaptures('mfs-rebuild')).toHaveLength(53)
    expect(mod.assertPlannedCaptureContract('mfs-rebuild')).toEqual({
      planned: 53,
      planLen: 53,
      expected: 53,
    })

    const balanced = mod.accountCaptureCounts({
      planned: 53,
      captured: 53,
      skipped: 0,
      error: 0,
    })
    expect(balanced.consistent).toBe(true)
    expect(balanced.accounted).toBe(53)
    expect(balanced.residual).toBe(0)

    // r5a-shaped dishonest count (viewport-only captured, zoom omitted) must fail
    const dishonest = mod.accountCaptureCounts({
      planned: 51,
      captured: 46,
      skipped: 0,
      error: 0,
    })
    expect(dishonest.consistent).toBe(false)
    expect(dishonest.residual).toBe(5)

    const withErrors = mod.accountCaptureCounts({
      planned: 53,
      captured: 50,
      skipped: 1,
      error: 2,
    })
    expect(withErrors.consistent).toBe(true)
    expect(withErrors.accounted).toBe(53)
  })

  test('C3-C6 full SHA fail-closed: 40-char or throw, never UNKNOWN on require', async () => {
    const mod = await import(pathToFileUrl(path.join(ROOT, 'qa/e2e/lib/env.mjs')))
    const prevFull = process.env.FULL_SHA
    const prevGit = process.env.GIT_SHA
    try {
      process.env.FULL_SHA = 'b9c86c2d1ef6c26d4436d4ffd434642421f847bd'
      process.env.GIT_SHA = ''
      expect(mod.resolveFullSha({ require: true })).toBe(
        'b9c86c2d1ef6c26d4436d4ffd434642421f847bd',
      )
      expect(mod.isFullSha(mod.assertFullSha())).toBe(true)

      process.env.FULL_SHA = 'deadbeef'
      expect(() => mod.assertFullSha()).toThrow(/FULL_SHA is set but not a full 40-character/)
      expect(() => mod.resolveFullSha({ require: true })).toThrow(/FULL_SHA/)

      process.env.FULL_SHA = 'UNKNOWN_SHA'
      expect(() => mod.assertFullSha()).toThrow(/FULL_SHA/)

      delete process.env.FULL_SHA
      delete process.env.GIT_SHA
      // git HEAD fallback from workspace
      const fromGit = mod.resolveFullSha({ require: true, cwd: ROOT })
      expect(mod.isFullSha(fromGit)).toBe(true)
      expect(fromGit).not.toBe('UNKNOWN_SHA')
      expect(fromGit).toMatch(/^[0-9a-f]{40}$/)
    } finally {
      if (prevFull === undefined) delete process.env.FULL_SHA
      else process.env.FULL_SHA = prevFull
      if (prevGit === undefined) delete process.env.GIT_SHA
      else process.env.GIT_SHA = prevGit
    }
  })

  test('C3-C6 network allowlist: serverFn ERR_ABORTED expected; API/MCP/health/document forbidden', async () => {
    const mod = await import(
      pathToFileUrl(path.join(ROOT, 'qa/e2e/lib/probe-fail-close.mjs'))
    )
    const {
      classifyNetworkFailure,
      partitionNetworkFailures,
      evaluateConsoleNetwork,
    } = mod

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
    for (const row of r5aLike) {
      const c = classifyNetworkFailure(row)
      expect(c.allowlisted, c.reason).toBe(true)
      expect(c.class).toBe('EXPECTED_ABORT')
    }
    const part = partitionNetworkFailures(r5aLike)
    expect(part.appFailures).toHaveLength(0)
    expect(part.allowlisted).toHaveLength(3)
    const okEval = evaluateConsoleNetwork({ networkFailures: r5aLike })
    expect(okEval.ok).toBe(true)
    expect(okEval.networkCount).toBe(0)
    expect(okEval.networkAllowlistedCount).toBe(3)

    const forbidden: Array<{ name: string; row: Record<string, unknown> }> = [
      {
        name: 'api-public-snapshot',
        row: {
          url: 'http://127.0.0.1:64580/api/public-snapshot?boardId=x',
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
        name: 'healthz',
        row: {
          url: 'http://127.0.0.1:64580/healthz',
          failure: 'net::ERR_ABORTED',
          page: 'http://127.0.0.1:64580/b/mfs-rebuild/',
        },
      },
      {
        name: 'generic-abort-asset',
        row: {
          url: 'http://127.0.0.1:64580/assets/app.js',
          failure: 'net::ERR_ABORTED',
          page: 'http://127.0.0.1:64580/b/mfs-rebuild/',
        },
      },
      {
        name: 'connection-refused-serverFn',
        row: {
          url: 'http://127.0.0.1:64580/_serverFn/c56db81c8847ab3caaa1a44d7400eb5abcfa203694726b21774a1ab4423394d2',
          failure: 'net::ERR_CONNECTION_REFUSED',
          page: 'http://127.0.0.1:64580/b/mfs-rebuild/',
        },
      },
      {
        name: 'document-navigation',
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
        name: 'http-status-500',
        row: {
          url: 'http://127.0.0.1:64580/_serverFn/c56db81c8847ab3caaa1a44d7400eb5abcfa203694726b21774a1ab4423394d2',
          failure: 'net::ERR_ABORTED',
          page: 'http://127.0.0.1:64580/b/mfs-rebuild/',
          status: 500,
        },
      },
    ]
    for (const f of forbidden) {
      const c = classifyNetworkFailure(f.row)
      expect(c.allowlisted, `${f.name}: ${c.reason}`).toBe(false)
      expect(c.class, f.name).toBe('APP')
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
    expect(mixed.ok).toBe(false)
    expect(mixed.networkCount).toBe(1)
    expect(mixed.networkAllowlistedCount).toBe(3)
  })

  test('iso-db name guard rejects ambient database names', async () => {
    const mod = await import(pathToFileUrl(path.join(ROOT, 'qa/e2e/lib/db-iso.mjs')))
    expect(() => mod.assertSafeIsoDbName('cairn_taskmanager')).toThrow(/refusing ambient/)
    expect(() => mod.assertSafeIsoDbName('mysql')).toThrow(/refusing ambient/)
    expect(() => mod.assertSafeIsoDbName('cairn_tm_e2e_r2d_demo')).not.toThrow()
  })

  test('C3-R3H public redaction: canary leak + forbidden keys fail; legit Password text does not', async () => {
    const mod = await import(pathToFileUrl(path.join(ROOT, 'qa/e2e/lib/probe-fail-close.mjs')))
    const { REDACTION_CANARIES, evaluatePublicRedaction, listCanaryValues } = mod
    expect(listCanaryValues().length).toBeGreaterThanOrEqual(5)

    const legit = evaluatePublicRedaction({
      status: 200,
      bodyText: JSON.stringify({
        features: [{ checklist: [{ text: 'Password reset', done: true }] }],
        accounts: [{ accountIdMasked: 'acc_***-001', status: 'ACTIVE' }],
      }),
    })
    expect(legit.ok).toBe(true)

    const leak = evaluatePublicRedaction({
      status: 200,
      bodyText: JSON.stringify({ body: REDACTION_CANARIES.decisionBody }),
    })
    expect(leak.ok).toBe(false)
    expect(leak.failures.some((f: string) => f.includes('canary'))).toBe(true)

    const keys = evaluatePublicRedaction({
      status: 200,
      body: { accounts: [{ password: 'x', token: 'y' }] },
    })
    expect(keys.ok).toBe(false)
    expect(keys.forbiddenKeyHits.length).toBeGreaterThan(0)

    expect(evaluatePublicRedaction({ status: 503, bodyText: '{}' }).ok).toBe(false)
  })

  test('C3-R3H sticky/touch/ongoing/rawStale fail-close shapes', async () => {
    const mod = await import(pathToFileUrl(path.join(ROOT, 'qa/e2e/lib/probe-fail-close.mjs')))
    const {
      evaluateStickyDecision,
      evaluateTouch,
      evaluateOngoingZeroClick,
      evaluateRawStale,
      evaluateMobileShellContainment,
      aggregateProbeVerdicts,
      assertProbesFailClosed,
    } = mod

    expect(
      evaluateStickyDecision({
        usedWindowScrollYAlone: true,
        scrollContainerSelector: null,
        decisionCardPresent: true,
        postScroll: {
          pillPresent: true,
          pillCountPresent: true,
          pillSeverityPresent: true,
          pillExpandPresent: true,
        },
      }).ok,
    ).toBe(false)

    // C3-C7: DOM-present-but-offscreen must fail (geometry, not mere presence)
    const offscreen = evaluateStickyDecision({
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
    expect(offscreen.ok).toBe(false)
    expect(
      offscreen.failures.some(
        (f: string) =>
          f.includes('offscreen') ||
          f.includes('zero_intersection') ||
          f.includes('not_visually') ||
          f.includes('clip_'),
      ),
    ).toBe(true)

    // C3-C9: partial intersection + right-edge clip (pill 412 > vw 390) must fail
    const partial = evaluateStickyDecision({
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
    expect(partial.ok).toBe(false)
    expect(
      partial.failures.some(
        (f: string) => f.includes('partial_intersection') || f.includes('clip_right'),
      ),
    ).toBe(true)

    // C3-C9: window.scroll nudge when #view is the container must fail
    const nudge = evaluateStickyDecision({
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
    expect(nudge.ok).toBe(false)
    expect(
      nudge.failures.some(
        (f: string) =>
          f.includes('window_scroll_nudge') || f.includes('app_bar_not_visible'),
      ),
    ).toBe(true)

    // C3-C9: nearest visible content overlap (e.g. ONGOING under pill) must fail
    const nearest = evaluateStickyDecision({
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
    expect(nearest.ok).toBe(false)
    expect(nearest.failures.some((f: string) => f.includes('covers_next_content'))).toBe(true)

    // C3-C9 success shape: full containment, windowScrollY≤1, app bar visible, no overlap
    const stickyOk = evaluateStickyDecision({
      usedWindowScrollYAlone: false,
      scrollContainerSelector: '#view',
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
      postScroll: {
        pillPresent: true,
        pillCountPresent: true,
        pillSeverityPresent: true,
        pillExpandPresent: true,
        coversNextContent: false,
        overlapsAppBar: false,
        appBarVisible: true,
        appBarBottom: 80,
        nextTestId: 'overview-priority',
        nearestContentTestId: 'overview-priority',
        scrollTop: 120,
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
    expect(stickyOk.ok).toBe(true)

    // C3-C12: #view 424px at viewport 360 must fail (document overflow alone is not enough)
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
    expect(shellWide.ok).toBe(false)
    expect(shellWide.failures.some((f: string) => f.includes('view') && f.includes('424'))).toBe(
      true,
    )

    const shellOk = evaluateMobileShellContainment([
      {
        id: 'Overview_390x844',
        viewportWidth: 390,
        documentScrollWidth: 390,
        documentClientWidth: 390,
        shells: {
          html: { clientWidth: 390, scrollWidth: 390, width: 390, left: 0, right: 390 },
          body: { clientWidth: 390, scrollWidth: 390, width: 390, left: 0, right: 390 },
          app: { clientWidth: 390, width: 390, left: 0, right: 390 },
          main: { clientWidth: 390, width: 390, left: 0, right: 390 },
          view: { clientWidth: 390, width: 390, left: 0, right: 390 },
        },
        elements: [
          {
            name: 'nav_scrollport',
            present: true,
            namedScrollport: true,
            left: 0,
            right: 540,
            width: 540,
            height: 44,
          },
          {
            name: 'work_page_next',
            present: true,
            requireTouch: true,
            left: 300,
            right: 360,
            width: 60,
            height: 44,
          },
        ],
      },
    ])
    expect(shellOk.ok).toBe(true)

    const shellClip = evaluateMobileShellContainment([
      {
        id: 'Decisions_360x800',
        viewportWidth: 360,
        shells: {
          html: { clientWidth: 360, scrollWidth: 360, width: 360, left: 0, right: 360 },
          body: { clientWidth: 360, scrollWidth: 360, width: 360, left: 0, right: 360 },
          app: { clientWidth: 360, width: 360, left: 0, right: 360 },
          main: { clientWidth: 360, width: 360, left: 0, right: 360 },
          view: { clientWidth: 360, width: 360, left: 0, right: 360 },
        },
        elements: [
          {
            name: 'decision_card',
            present: true,
            left: 12,
            right: 410,
            width: 398,
            height: 200,
          },
        ],
      },
    ])
    expect(shellClip.ok).toBe(false)
    expect(shellClip.failures.some((f: string) => f.includes('decision_card_clip_right'))).toBe(
      true,
    )

    expect(
      evaluateTouch({
        total: 2,
        failing: 1,
        sampleFail: [{ testid: 'user-menu', w: 247, h: 37, selector: '[data-testid=user-menu]' }],
      }).ok,
    ).toBe(false)
    expect(evaluateTouch({ total: 2, failing: 0, sampleFail: [] }).ok).toBe(true)

    expect(
      evaluateOngoingZeroClick({
        hasOngoingQuery: true,
        onlyQueryString: true,
        sectionPresent: false,
        visibleFields: {},
        seededTaskId: 'task-ongoing-1',
      }).ok,
    ).toBe(false)

    expect(
      evaluateRawStale({
        literalPath: '/b/mfs-rebuild/work?stale=1',
        navigationUsedRouterSerialize: false,
        authShellOk: true,
        workScreenPresent: true,
        staleActive: false,
        errorBoundaryPresent: false,
        consoleErrorDuringNav: false,
      }).ok,
    ).toBe(false)

    const agg = aggregateProbeVerdicts({
      touch: { total: 1, failing: 1, sampleFail: [{ testid: 'x', w: 10, h: 10 }] },
      sessionDenial: [{ path: '/b/x/', url: '/login', denied: true }],
      focus: { focusOk: true },
      reducedMotion: { matches: true },
    })
    expect(agg.failCount).toBeGreaterThanOrEqual(1)
    expect(() => assertProbesFailClosed(agg)).toThrow(/HARNESS FAIL/)
  })

  test('fixture plants redaction canaries in private decision/comment/account fields', async () => {
    const mod = await import(
      pathToFileUrl(path.join(ROOT, 'qa/e2e/fixtures/seed/control-center-fixture.mjs'))
    )
    const docs = mod.buildBoardDocs()
    const blob = JSON.stringify(docs)
    expect(blob).toContain(mod.REDACTION_CANARIES.decisionBody)
    expect(blob).toContain(mod.REDACTION_CANARIES.commentText)
    expect(blob).toContain(mod.REDACTION_CANARIES.accountPassword)
    expect(blob).toContain(mod.REDACTION_CANARIES.accountToken)
    expect(blob).toContain(mod.REDACTION_CANARIES.accountRawIdentity)
    const v = mod.validateFixtureContract()
    expect(v.ok).toBe(true)
  })

  test('C3-R5H authorized bootstrap: redaction, deny, pin fail-close, happy sanitized shape', async () => {
    const mod = await import(
      pathToFileUrl(path.join(ROOT, 'qa/e2e/lib/control-plane-bootstrap.mjs'))
    )
    const suite = await mod.runBootstrapContractSelfTests()
    expect(suite.ok, JSON.stringify(suite.results.filter((r: { pass: boolean }) => !r.pass))).toBe(
      true,
    )
    expect(suite.failCount).toBe(0)
    const names = suite.results.map((r: { name: string }) => r.name)
    for (const need of [
      'synth-principal-role-root',
      'redact-bearer-absent',
      'sanitize-no-bearer',
      'pin-mismatch-throws',
      'missing-bearer-fail-close',
      'wrong-bearer-denied-fail-close',
      'happy-bootstrap-ok',
      'happy-sanitized-no-bearer',
      'pin-mismatch-no-publish',
    ]) {
      expect(names, need).toContain(need)
      const row = suite.results.find((r: { name: string }) => r.name === need)
      expect(row?.pass, need).toBe(true)
    }
  })
})

function pathToFileUrl(p: string): string {
  const abs = path.resolve(p)
  // file URL for dynamic import on macOS
  return `file://${abs}`
}
