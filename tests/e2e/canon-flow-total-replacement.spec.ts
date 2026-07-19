/**
 * TM-IMPL-CANON-V3-BROWSER-GATES — Playwright entry for canon-v3 total-replacement
 * browser acceptance (oracle: DESIGN-CANON-V3/flow/gate-simple.mjs).
 *
 * Layers covered (when live WEB_BASE + auth available):
 *   A* static fidelity, B* functional, C* data honesty seam, D* a11y probes, E* visual plan
 *   S* semantic criterion 3 (graph/layer + Navigasi terkait; Fitur sama excluded)
 *
 * Offline / list-safe: pure contract tests always run.
 * Live: residual LOCAL_ONLY when unauthenticated or static data — never invent functional PASS.
 * Repair R1: F1 residual ok:false; F2 hardFails include A5+B/D; F3/F6 related honest;
 *   F4 D2–D4/D6 real; F5 canvas edge pixels.
 * Semantic R2/R3: S1/S2/S3 hardFails; no sequential list-order; af:|pn: journey contracts.
 * Cross S1 always requires REQUIRED_CROSS_PROJECTS (5 UI keys) — never tautological multi auto-detect.
 *
 * Run:
 *   pnpm exec playwright test tests/e2e/canon-flow-total-replacement.spec.ts --list
 *   CAIRN_E2E_SKIP_WEBSERVER=1 WEB_BASE=… FULL_SHA=$(git rev-parse HEAD) \
 *     pnpm exec playwright test tests/e2e/canon-flow-total-replacement.spec.ts
 *
 * Companion Node harnesses (no Playwright project required):
 *   node qa/e2e/flows/canon-flow-static-fidelity.mjs --self-test
 *   node qa/e2e/flows/canon-flow-functional.mjs --self-test
 *   node qa/e2e/flows/canon-flow-visual.mjs --self-test
 */
import { expect, test } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'

import {
  ALL_SEMANTIC_FIXTURE_SCENARIOS,
  DEFAULT_BOARD,
  FLOW_MODES,
  FORBIDDEN_CHROME_SELECTORS,
  PROJECT_MODE_KEYS,
  REQUIRED_CROSS_PROJECTS,
  REQUIRED_SELECTORS,
  STORAGE_KEY,
  TARGET_GATE,
  TECH_ID_PATTERNS,
  VIEWPORTS,
  VISUAL_STATES,
  buildSemanticFixture,
  classifyDataHonesty,
  classifyDomHonestyState,
  classifySemanticNodeId,
  collectHardFails,
  evaluateDragMovement,
  evaluateEdgeEndpointRedraw,
  evaluateFocusReturn,
  evaluateIndonesianChromeLabels,
  evaluateKeyboardNodeOpen,
  evaluateLiveAuthResidual,
  evaluateNaturalSheetFocus,
  evaluatePanDelta,
  evaluateReducedMotionDurations,
  evaluateRelatedNavigation,
  evaluateRequiredProjectsCoverage,
  evaluateSemanticFixture,
  evaluateSemanticLayerContract,
  evaluateSemanticRelatedNavigation,
  evaluateTouchTargets,
  findTechIdHits,
  flowRoute,
  isFullSha,
  offlineHarnessStatus,
  planVisualCaptures,
  requireFullSha,
  runSemanticFixtureSelfTest,
  summarizeChecks,
  toSemanticLayerPublicDetail,
  type CheckRow,
} from './helpers/canon-flow-gate'

const BOARD = process.env.BOARD_ID?.trim() || DEFAULT_BOARD
const ROUTE = flowRoute(BOARD)

test.describe('canon-flow total replacement — pure contract (no server)', () => {
  test('target gate + mode table + storage key + required cross portfolio', () => {
    expect(TARGET_GATE).toBe('TM_CANON_V3_BROWSER_HARNESS_READY')
    expect(FLOW_MODES).toEqual([
      'cross',
      'rn',
      'web-member',
      'panel-sales',
      'affiliate',
      'backend',
    ])
    expect(REQUIRED_CROSS_PROJECTS).toEqual([
      'rn',
      'web-member',
      'panel-sales',
      'affiliate',
      'backend',
    ])
    expect(REQUIRED_CROSS_PROJECTS).toEqual([...PROJECT_MODE_KEYS])
    expect(REQUIRED_CROSS_PROJECTS).toHaveLength(5)
    expect(STORAGE_KEY).toBe('cairn-flow-pos-v1')
    expect(ROUTE).toBe(`/b/${BOARD}/alur`)
  })

  test('required selectors and forbidden chrome inventory', () => {
    expect(REQUIRED_SELECTORS.length).toBeGreaterThanOrEqual(10)
    expect(FORBIDDEN_CHROME_SELECTORS.length).toBeGreaterThanOrEqual(3)
    expect(TECH_ID_PATTERNS.length).toBeGreaterThanOrEqual(5)
  })

  test('tech-id scanner allows API METHOD+path, flags FEAT-*', () => {
    expect(findTechIdHits('Status Verified GET /api/admin/x').length).toBe(0)
    const hits = findTechIdHits('leak FEAT-CHECKOUT-WEB visible')
    expect(hits.some((h) => h.match.startsWith('FEAT-'))).toBe(true)
  })

  test('pan/drag/touch pure evaluators match oracle tolerances', () => {
    expect(evaluatePanDelta(300).ok).toBe(true)
    expect(evaluatePanDelta(10).ok).toBe(false)
    expect(
      evaluateDragMovement(
        { x: 0, y: 0, cx: 100, cy: 50 },
        { x: 120, y: 0, cx: 220, cy: 50 },
      ).ok,
    ).toBe(true)
    expect(
      evaluateTouchTargets([
        { selector: '.flow-zoom button', w: 44, h: 44 },
        { selector: '.flow-pill', w: 48, h: 36 },
      ]).ok,
    ).toBe(false)
    expect(
      evaluateTouchTargets([
        { selector: '.flow-zoom button', w: 44, h: 44 },
        { selector: '.flow-pill', w: 48, h: 48 },
      ]).ok,
    ).toBe(true)
  })

  test('data honesty marks static source LOCAL_ONLY (not false PASS)', () => {
    const r = classifyDataHonesty({
      source: 'file',
      pinFieldsPresent: false,
      visibleNodeIds: ['n1', 'n2'],
    })
    expect(r.claim).toBe('LOCAL_ONLY')
  })

  test('visual plan fail-closed without FULL_SHA; matrix has 390/1440/2560 + dpr2', () => {
    expect(() => planVisualCaptures({ fullSha: 'short', route: ROUTE })).toThrow(
      /FULL_SHA|40-char/,
    )
    const sha = 'd'.repeat(40)
    const plan = planVisualCaptures({ fullSha: sha, route: ROUTE })
    expect(plan.fullSha).toBe(sha)
    expect(plan.baselineBlessForbidden).toBe(true)
    expect(plan.rows.some((r) => r.viewport === '390x844')).toBe(true)
    expect(plan.rows.some((r) => r.viewport === '1440x900')).toBe(true)
    expect(plan.rows.some((r) => r.viewport === '2560x1300')).toBe(true)
    expect(plan.rows.some((r) => r.deviceScaleFactor === 2)).toBe(true)
    for (const st of VISUAL_STATES) {
      expect(plan.rows.some((r) => r.state === st)).toBe(true)
    }
    expect(VIEWPORTS.ultrawide.width).toBe(2560)
  })

  test('offline harness status is HARNESS_READY not functional PASS', () => {
    const s = offlineHarnessStatus({ selfTestOk: true, planOk: true })
    expect(s.status).toBe('HARNESS_READY')
    expect(s.note).toMatch(/not a functional PASS/i)
  })

  test('requireFullSha rejects UNKNOWN_SHA', () => {
    expect(isFullSha('UNKNOWN_SHA')).toBe(false)
    expect(() => requireFullSha('UNKNOWN_SHA')).toThrow()
  })

  // ── Adversarial pure contracts for F1–F6 (fail before soft repairs) ──

  test('F1 residual auth is explicit failure not green PASS', () => {
    const residual = evaluateLiveAuthResidual({ onAlur: false, onLogin: true })
    expect(residual.residual).toBe(true)
    expect(residual.checkOk).toBe(false)
    expect(residual.harnessStatus).toBe('LOCAL_ONLY')
    const live = evaluateLiveAuthResidual({ onAlur: true, onLogin: false })
    expect(live.residual).toBe(false)
    expect(live.checkOk).toBe(true)
  })

  test('F2 hardFails include A5 forbidden chrome and B/D layers', () => {
    const checks: CheckRow[] = [
      { name: 'forbidden_absent:nav', ok: false, layer: 'A5' },
      { name: 'pan_empty_300px', ok: false, layer: 'B3' },
      { name: 'touch_44', ok: false, layer: 'D7' },
      { name: 'default_mode_cross', ok: true, layer: 'B1' },
    ]
    const hard = collectHardFails(checks)
    expect(hard.map((h) => h.layer).sort()).toEqual(['A5', 'B3', 'D7'])
    expect(hard.some((h) => h.layer === 'A5')).toBe(true)
  })

  test('F3 related tautology fails; F6 absence is residual fail', () => {
    // Pre-repair tautology always-true OR must be rejected by evaluator
    const taut = evaluateRelatedNavigation({
      hasRelatedControl: true,
      titleBefore: 'Same',
      titleAfter: 'Same',
      hlId: null,
      gotoId: 'x',
      sheetOpen: true,
    })
    expect(taut.ok).toBe(false)
    const absent = evaluateRelatedNavigation({ hasRelatedControl: false })
    expect(absent.ok).toBe(false)
    expect(absent.residual).toBe(true)
    const good = evaluateRelatedNavigation({
      hasRelatedControl: true,
      titleBefore: 'A',
      titleAfter: 'B',
      hlId: 'n2',
      gotoId: 'n2',
      sheetOpen: true,
    })
    expect(good.ok).toBe(true)
  })

  test('F4 D2/D3/D4/D6 pure honesty contracts', () => {
    expect(
      evaluateKeyboardNodeOpen({
        nodeKeyboardFocusable: false,
        openedViaKeyboard: false,
      }).ok,
    ).toBe(false)
    expect(
      evaluateNaturalSheetFocus({
        sheetOpen: true,
        activeInSheet: true,
        forceFocused: true,
      }).ok,
    ).toBe(false)
    expect(
      evaluateFocusReturn({ sheetClosed: true, focusOnOpener: false }).ok,
    ).toBe(false)
    expect(
      evaluateReducedMotionDurations([{ selector: '.x', durationMs: 300 }]).ok,
    ).toBe(false)
    expect(evaluateReducedMotionDurations([]).ok).toBe(false)
    expect(
      evaluateReducedMotionDurations([{ selector: '.x', durationMs: 0 }]).ok,
    ).toBe(true)
  })

  test('F5 edge redraw rejects center-delta proxy without canvas ink', () => {
    expect(
      evaluateEdgeEndpointRedraw({
        canvasChanged: false,
        beforeInkNearOldCenter: 10,
        afterInkNearOldCenter: 10,
        afterInkNearNewCenter: 0,
        nodeCenterDelta: 120,
      }).ok,
    ).toBe(false)
    expect(
      evaluateEdgeEndpointRedraw({
        canvasChanged: true,
        beforeInkNearOldCenter: 20,
        afterInkNearOldCenter: 2,
        afterInkNearNewCenter: 15,
        nodeCenterDelta: 120,
      }).ok,
    ).toBe(true)
  })

  // ── Criterion 3 semantic pure contracts (R2) ──

  test('S1/S2 semantic fixture matrix all scenarios match expectations', () => {
    const r = runSemanticFixtureSelfTest()
    expect(r.failures, r.failures.join('; ')).toEqual([])
    expect(r.ok).toBe(true)
    for (const scenario of ALL_SEMANTIC_FIXTURE_SCENARIOS) {
      expect(r.cases[scenario]).toBe('PASS')
      const fx = buildSemanticFixture(scenario)
      const ev = evaluateSemanticFixture(fx)
      expect(ev.matchesExpectation).toBe(true)
    }
  })

  test('S2 Fitur sama cannot satisfy related-nav even with data-goto + highlight', () => {
    const r = evaluateSemanticRelatedNavigation({
      hasRelatedControl: true,
      controlKind: 'same-feature',
      gotoId: 'af:rn:home',
      targetPresentAsJourney: true,
      titleBefore: 'A',
      titleAfter: 'B',
      hlId: 'af:rn:home',
      sheetOpen: true,
      mode: 'rn',
      layer: 'app_flow',
      routePathBefore: '/b/x/alur',
      routePathAfter: '/b/x/alur',
    })
    expect(r.ok).toBe(false)
    expect(r.hardFail).toBe(true)
    expect(r.reason).toMatch(/Fitur sama/i)
  })

  test('S1 inventory-only and synthetic premium/auth fail closed', () => {
    expect(
      evaluateSemanticLayerContract({
        mode: 'rn',
        rootLayer: 'app_flow',
        layerTablistPresent: true,
        nodes: [
          { id: 'inv:rn:FEAT-X', kind: 'inventory', className: 'fnode is-inventory' },
        ],
        honestyState: 'ok',
      }).ok,
    ).toBe(false)
    expect(
      evaluateSemanticLayerContract({
        mode: 'cross',
        rootLayer: 'app_flow',
        nodes: [
          { id: 'premium:step-1', kind: 'journey_app' },
          { id: 'auth:login', kind: 'journey_app' },
        ],
        honestyState: 'ok',
      }).ok,
    ).toBe(false)
    expect(classifySemanticNodeId('premium:x').isForbiddenSynthetic).toBe(true)
    expect(classifySemanticNodeId('af:rn:login').isJourney).toBe(true)
    expect(classifySemanticNodeId('inv:rn:f').isInventory).toBe(true)
  })

  test('S1 R3 five-project portfolio: full PASS; undercover/alias/dup/extra hardFail', () => {
    const fiveNodes = [
      { id: 'af:rn:a', kind: 'journey_app' },
      { id: 'af:web-member:b', kind: 'journey_app' },
      { id: 'af:panel-sales:c', kind: 'journey_app' },
      { id: 'af:affiliate:d', kind: 'journey_app' },
      { id: 'af:backend:e', kind: 'journey_app' },
    ]
    const full = evaluateSemanticLayerContract({
      mode: 'cross',
      rootLayer: 'app_flow',
      nodes: fiveNodes,
      honestyState: 'ok',
      requiredProjects: [...REQUIRED_CROSS_PROJECTS],
    })
    expect(full.ok).toBe(true)
    expect(full.hardFail).toBe(false)
    expect(full.projects).toEqual([...REQUIRED_CROSS_PROJECTS].sort())
    expect(full.details.requiredCrossProjects).toBe(5)

    const under1 = evaluateSemanticLayerContract({
      mode: 'cross',
      rootLayer: 'app_flow',
      nodes: [{ id: 'af:rn:a', kind: 'journey_app' }],
      honestyState: 'ok',
      requiredProjects: [...REQUIRED_CROSS_PROJECTS],
    })
    expect(under1.ok).toBe(false)
    expect(under1.hardFail).toBe(true)
    expect(under1.reason).toMatch(/missing=\[/)
    expect(under1.reason).not.toMatch(/af:rn:/)
    expect(under1.details.missingProjects).toEqual(
      expect.arrayContaining(['web-member', 'panel-sales', 'affiliate', 'backend']),
    )

    const under4 = evaluateSemanticLayerContract({
      mode: 'cross',
      rootLayer: 'app_flow',
      nodes: fiveNodes.slice(0, 4),
      honestyState: 'ok',
      requiredProjects: [...REQUIRED_CROSS_PROJECTS],
    })
    expect(under4.ok).toBe(false)
    expect(under4.details.missingProjects).toEqual(['backend'])

    const wrongAlias = evaluateSemanticLayerContract({
      mode: 'cross',
      rootLayer: 'app_flow',
      nodes: [
        { id: 'af:rn:a', kind: 'journey_app' },
        { id: 'af:web:b', kind: 'journey_app' },
        { id: 'af:sales:c', kind: 'journey_app' },
        { id: 'af:affiliate:d', kind: 'journey_app' },
        { id: 'af:backend:e', kind: 'journey_app' },
      ],
      honestyState: 'ok',
      requiredProjects: [...REQUIRED_CROSS_PROJECTS],
    })
    expect(wrongAlias.ok).toBe(false)
    expect(wrongAlias.details.missingProjects).toEqual(
      expect.arrayContaining(['web-member', 'panel-sales']),
    )
    expect(wrongAlias.details.unexpectedProjects).toEqual(
      expect.arrayContaining(['web', 'sales']),
    )

    const dups = evaluateSemanticLayerContract({
      mode: 'cross',
      rootLayer: 'app_flow',
      nodes: [
        { id: 'af:rn:a', kind: 'journey_app' },
        { id: 'af:rn:b', kind: 'journey_app' },
        { id: 'af:rn:c', kind: 'journey_app' },
        { id: 'af:rn:d', kind: 'journey_app' },
        { id: 'af:rn:e', kind: 'journey_app' },
      ],
      honestyState: 'ok',
      requiredProjects: [...REQUIRED_CROSS_PROJECTS],
    })
    expect(dups.ok).toBe(false)
    expect(dups.projects).toEqual(['rn'])
    expect(dups.journeyIds.length).toBe(5)

    const extra = evaluateSemanticLayerContract({
      mode: 'cross',
      rootLayer: 'app_flow',
      nodes: [...fiveNodes, { id: 'af:unknown-proj:x', kind: 'journey_app' }],
      honestyState: 'ok',
      requiredProjects: [...REQUIRED_CROSS_PROJECTS],
    })
    expect(extra.ok).toBe(false)
    expect(extra.details.unexpectedProjects).toContain('unknown-proj')

    // Public detail never leaks raw node IDs
    const pub = toSemanticLayerPublicDetail(under1)
    expect(JSON.stringify(pub)).not.toMatch(/af:rn:/)
    expect(pub.details).toMatchObject({
      missingProjects: expect.any(Array),
      requiredCrossProjects: 5,
    })

    // Coverage helper unit
    const cov = evaluateRequiredProjectsCoverage({
      journeyProjects: ['rn'],
      requiredProjects: [...REQUIRED_CROSS_PROJECTS],
    })
    expect(cov.ok).toBe(false)
    expect(cov.missing).toHaveLength(4)
  })

  test('S2 inv: and dangling targets hard-fail related nav', () => {
    expect(
      evaluateSemanticRelatedNavigation({
        hasRelatedControl: true,
        controlKind: 'related',
        isSemanticRelatedTestId: true,
        sectionIsRelatedNav: true,
        gotoId: 'inv:rn:FEAT-X',
        targetPresentAsJourney: true,
        targetIsInventory: true,
        titleBefore: 'A',
        titleAfter: 'B',
        hlId: 'inv:rn:FEAT-X',
        sheetOpen: true,
        mode: 'rn',
        layer: 'app_flow',
        routePathBefore: '/b/x/alur',
        routePathAfter: '/b/x/alur',
      }).ok,
    ).toBe(false)
    expect(
      evaluateSemanticRelatedNavigation({
        hasRelatedControl: true,
        controlKind: 'related',
        isSemanticRelatedTestId: true,
        sectionIsRelatedNav: true,
        gotoId: 'af:rn:missing',
        targetPresentAsJourney: false,
        titleBefore: 'A',
        titleAfter: 'B',
        hlId: 'af:rn:missing',
        sheetOpen: true,
        mode: 'rn',
        layer: 'app_flow',
        routePathBefore: '/b/x/alur',
        routePathAfter: '/b/x/alur',
      }).ok,
    ).toBe(false)
  })

  test('S3 id-ID labels and node-id leak detection', () => {
    expect(
      evaluateIndonesianChromeLabels({
        visibleText: 'Alur Lintas Proyek Navigasi terkait Alur aplikasi Navigasi laman',
        requireLayers: true,
        requireRelatedSection: true,
      }).ok,
    ).toBe(true)
    expect(
      evaluateIndonesianChromeLabels({
        visibleText: 'Alur card af:rn:login leaked',
        requireRelatedSection: false,
      }).ok,
    ).toBe(false)
  })

  test('S1/S2 hardFails included in collectHardFails (no soft-green)', () => {
    const hard = collectHardFails([
      { name: 'S1_semantic_layer', ok: false, layer: 'S1' },
      { name: 'S2_semantic_related_nav', ok: false, layer: 'S2' },
      { name: 'S3_id_id_chrome', ok: false, layer: 'S3' },
      { name: 'B9_related_nav', ok: false, layer: 'B9' },
      { name: 'default_mode_cross', ok: true, layer: 'B1' },
    ])
    expect(hard.map((h) => h.layer).sort()).toEqual(['B9', 'S1', 'S2', 'S3'])
  })
})

test.describe('canon-flow total replacement — live browser (residual-safe)', () => {
  test('authenticated flow gates or honest residual LOCAL_ONLY', async ({ page }) => {
    const checks: CheckRow[] = []
    const consoleErrors: string[] = []
    const pageErrors: string[] = []
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text())
    })
    page.on('pageerror', (err) => pageErrors.push(String(err.message || err)))

    const push = (name: string, ok: boolean, detail?: unknown, layer?: string) => {
      checks.push({ name, ok, detail, layer })
    }

    await page.setViewportSize({ width: 1440, height: 900 })
    const resp = await page.goto(ROUTE, {
      waitUntil: 'domcontentloaded',
      timeout: 45_000,
    })
    const url = page.url()
    const onAlur = /\/alur/.test(url)
    const onLogin = /\/login/.test(url)

    // F1 — missing auth/non-alur is explicit residual FAILURE (never green PASS)
    const residualAuth = evaluateLiveAuthResidual({ onAlur, onLogin })
    if (residualAuth.residual) {
      push(
        'live_residual_auth',
        residualAuth.checkOk,
        {
          residual: 'AUTH_OR_ROUTE',
          url,
          status: resp?.status() ?? null,
          harnessStatus: residualAuth.harnessStatus,
          note: residualAuth.reason,
        },
        'B0',
      )
      const summary = summarizeChecks(checks)
      // Write residual report
      try {
        const outDir = path.join(process.cwd(), '.artifact')
        fs.mkdirSync(outDir, { recursive: true })
        fs.writeFileSync(
          path.join(outDir, 'canon-flow-total-replacement-live.json'),
          JSON.stringify(
            {
              targetGate: TARGET_GATE,
              route: ROUTE,
              status: 'LOCAL_ONLY',
              functionalPass: false,
              residual: true,
              summary,
              checks,
              note: 'Explicit residual failure — not functional PASS',
            },
            null,
            2,
          ),
        )
      } catch {
        /* non-fatal */
      }
      // Residual check must be recorded as failure
      expect(checks.some((c) => c.name === 'live_residual_auth' && !c.ok)).toBe(
        true,
      )
      expect(summary.ok).toBe(false)
      // Fail the Playwright test — never silent green residual
      throw new Error(
        `LOCAL_ONLY residual AUTH_OR_ROUTE at ${url} — harness ready offline, not functional PASS`,
      )
    }

    await page
      .locator('[data-testid="flow-ultimate"], [data-testid="flow-stage"], .flow-stage')
      .first()
      .waitFor({ timeout: 30_000 })
    await page.waitForTimeout(400)

    // A1 skeleton
    for (const sel of REQUIRED_SELECTORS) {
      const count = await page.locator(sel).count()
      push(`selector:${sel}`, count > 0, { count }, 'A1')
    }

    // A5 forbidden chrome (total replace claim) — hard-fail surface (F2)
    for (const sel of FORBIDDEN_CHROME_SELECTORS) {
      const loc = page.locator(sel)
      const count = await loc.count()
      let visible = 0
      for (let i = 0; i < count; i++) {
        if (await loc.nth(i).isVisible().catch(() => false)) visible++
      }
      push(`forbidden_absent:${sel}`, visible === 0, { count, visible }, 'A5')
    }

    // B1 default cross
    const mode =
      (await page.locator('[data-testid="flow-ultimate"]').getAttribute('data-mode')) ||
      (await page.locator('.flow-pill.on').getAttribute('data-mode'))
    push('default_mode_cross', mode === 'cross', { mode }, 'B1')

    // B2 five project switches
    for (const m of FLOW_MODES.filter((x) => x !== 'cross')) {
      await page.locator(`.flow-pill[data-mode="${m}"]`).click()
      await page.waitForTimeout(300)
      const got = await page.locator('[data-testid="flow-ultimate"]').getAttribute('data-mode')
      const nodes = await page.locator('[data-testid="flow-node"], .fnode').count()
      push(`switch_${m}`, got === m && nodes > 0, { got, nodes }, 'B2')
    }
    await page.locator('.flow-pill[data-mode="cross"]').click()
    await page.waitForTimeout(300)

    // B3 pan
    const stage = page.locator('[data-testid="flow-stage"], .flow-stage')
    const stageBox = await stage.boundingBox()
    const readTx = async () =>
      page.evaluate(() => {
        const w = document.querySelector('[data-testid="flow-world"], .flow-world')
        const t = w ? getComputedStyle(w).transform : 'none'
        if (!t || t === 'none') return 0
        const m = t.match(/matrix\(([^)]+)\)/)
        if (!m) return 0
        return Number(m[1].split(',')[4]) || 0
      })
    const panBefore = await readTx()
    if (stageBox) {
      const s = { x: stageBox.x + stageBox.width - 80, y: stageBox.y + 40 }
      await page.mouse.move(s.x, s.y)
      await page.mouse.down()
      await page.mouse.move(s.x + 300, s.y, { steps: 12 })
      await page.mouse.up()
      await page.waitForTimeout(100)
    }
    const panDx = (await readTx()) - panBefore
    push('pan_empty_300px', evaluatePanDelta(panDx).ok, { panDx }, 'B3')

    // B4 zoom
    const readScale = async () =>
      page.evaluate(() => {
        const w = document.querySelector('[data-testid="flow-world"], .flow-world')
        const t = w ? getComputedStyle(w).transform : 'none'
        if (!t || t === 'none') return 1
        const m = t.match(/matrix\(([^)]+)\)/)
        return m ? Math.abs(Number(m[1].split(',')[0])) || 1 : 1
      })
    const s0 = await readScale()
    await page.locator('.flow-zoom button').nth(0).click()
    await page.waitForTimeout(80)
    const s1 = await readScale()
    await page.locator('.flow-zoom button').nth(1).click()
    await page.waitForTimeout(80)
    const s2 = await readScale()
    await page.locator('.flow-zoom button').nth(2).click()
    push('zoom_plus_minus_fit', s1 > s0 && s2 < s1, { s0, s1, s2 }, 'B4')

    // B5/B6 drag + canvas edge endpoint proof (F5)
    await page.evaluate((key) => localStorage.removeItem(key), STORAGE_KEY)
    const node = page.locator('[data-testid="flow-node"], .fnode').first()
    const box = await node.boundingBox()
    const before = await page.evaluate(() => {
      const n = document.querySelector('[data-testid="flow-node"], .fnode') as HTMLElement | null
      if (!n) return null
      const r = n.getBoundingClientRect()
      return {
        id: n.getAttribute('data-node-id') || '',
        x: parseFloat(n.style.left) || 0,
        y: parseFloat(n.style.top) || 0,
        cx: r.left + r.width / 2,
        cy: r.top + r.height / 2,
      }
    })
    const edgeBefore = await page.evaluate(() => {
      const CARD_H = 64
      const canvas = document.querySelector(
        'canvas.flow-edges, [data-testid="flow-edges"]',
      ) as HTMLCanvasElement | null
      const n = document.querySelector(
        '[data-testid="flow-node"], .fnode',
      ) as HTMLElement | null
      if (!canvas || !n) return null
      const ctx = canvas.getContext('2d', { willReadFrequently: true })
      if (!ctx) return null
      const dpr = window.devicePixelRatio || 1
      const wx = (parseFloat(n.style.left) || 0) + 17
      const wy = (parseFloat(n.style.top) || 0) + CARD_H / 2
      const digest = () => {
        const { width, height } = canvas
        if (!width || !height) return '0x0:0'
        const data = ctx.getImageData(0, 0, width, height).data
        let h = 2166136261
        for (let i = 0; i < data.length; i += 97) {
          h ^= data[i]
          h = Math.imul(h, 16777619)
        }
        let ink = 0
        for (let i = 3; i < data.length; i += 16) {
          if (data[i] > 8) ink++
        }
        return `${width}x${height}:${h >>> 0}:${ink}`
      }
      const inkNear = (x: number, y: number, radius = 10) => {
        const cx = Math.round(x * dpr)
        const cy = Math.round(y * dpr)
        const r = Math.round(radius * dpr)
        const x0 = Math.max(0, cx - r)
        const y0 = Math.max(0, cy - r)
        const w = Math.min(canvas.width - x0, r * 2 + 1)
        const h = Math.min(canvas.height - y0, r * 2 + 1)
        if (w <= 0 || h <= 0) return 0
        const data = ctx.getImageData(x0, y0, w, h).data
        let ink = 0
        for (let i = 3; i < data.length; i += 4) {
          if (data[i] > 10) ink++
        }
        return ink
      }
      return { digest: digest(), wx, wy, ink: inkNear(wx, wy) }
    })
    if (box && before) {
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
      await page.mouse.down()
      await page.mouse.move(box.x + box.width / 2 + 120, box.y + box.height / 2, {
        steps: 12,
      })
      await page.mouse.up()
      await page.waitForTimeout(200)
      const after = await page.evaluate((id) => {
        const n = (document.querySelector(
          `[data-node-id="${CSS.escape(id)}"]`,
        ) || document.querySelector('[data-testid="flow-node"], .fnode')) as HTMLElement | null
        if (!n) return null
        const r = n.getBoundingClientRect()
        return {
          id: n.getAttribute('data-node-id') || '',
          x: parseFloat(n.style.left) || 0,
          y: parseFloat(n.style.top) || 0,
          cx: r.left + r.width / 2,
          cy: r.top + r.height / 2,
        }
      }, before.id)
      const edgeAfter = await page.evaluate(
        (old: { id?: string; wx: number; wy: number } | null) => {
          const CARD_H = 64
          const canvas = document.querySelector(
            'canvas.flow-edges, [data-testid="flow-edges"]',
          ) as HTMLCanvasElement | null
          const n = (
            old?.id
              ? document.querySelector(`[data-node-id="${CSS.escape(old.id)}"]`)
              : document.querySelector('[data-testid="flow-node"], .fnode')
          ) as HTMLElement | null
          if (!canvas || !n) return null
          const ctx = canvas.getContext('2d', { willReadFrequently: true })
          if (!ctx) return null
          const dpr = window.devicePixelRatio || 1
          const wx = (parseFloat(n.style.left) || 0) + 17
          const wy = (parseFloat(n.style.top) || 0) + CARD_H / 2
          const digest = () => {
            const { width, height } = canvas
            if (!width || !height) return '0x0:0'
            const data = ctx.getImageData(0, 0, width, height).data
            let h = 2166136261
            for (let i = 0; i < data.length; i += 97) {
              h ^= data[i]
              h = Math.imul(h, 16777619)
            }
            let ink = 0
            for (let i = 3; i < data.length; i += 16) {
              if (data[i] > 8) ink++
            }
            return `${width}x${height}:${h >>> 0}:${ink}`
          }
          const inkNear = (x: number, y: number, radius = 10) => {
            const cx = Math.round(x * dpr)
            const cy = Math.round(y * dpr)
            const r = Math.round(radius * dpr)
            const x0 = Math.max(0, cx - r)
            const y0 = Math.max(0, cy - r)
            const w = Math.min(canvas.width - x0, r * 2 + 1)
            const h = Math.min(canvas.height - y0, r * 2 + 1)
            if (w <= 0 || h <= 0) return 0
            const data = ctx.getImageData(x0, y0, w, h).data
            let ink = 0
            for (let i = 3; i < data.length; i += 4) {
              if (data[i] > 10) ink++
            }
            return ink
          }
          return {
            digest: digest(),
            wx,
            wy,
            inkNew: inkNear(wx, wy),
            inkOld: old ? inkNear(old.wx, old.wy) : 0,
          }
        },
        edgeBefore,
      )
      const drag = evaluateDragMovement(before, after!)
      push('drag_node_120px', drag.ok, drag, 'B5')
      const centerDelta = Math.hypot(after!.cx - before.cx, after!.cy - before.cy)
      const edgeEval = evaluateEdgeEndpointRedraw({
        canvasChanged: Boolean(
          edgeBefore && edgeAfter && edgeBefore.digest !== edgeAfter.digest,
        ),
        beforeInkNearOldCenter: edgeBefore?.ink ?? 0,
        afterInkNearOldCenter: edgeAfter?.inkOld ?? 0,
        afterInkNearNewCenter: edgeAfter?.inkNew ?? 0,
        nodeCenterDelta: centerDelta,
      })
      push('edge_endpoint_follows', edgeEval.ok, { edgeEval, edgeBefore, edgeAfter, centerDelta }, 'B6')
      const stored = await page.evaluate((key) => localStorage.getItem(key), STORAGE_KEY)
      push('localStorage_written', Boolean(stored), { key: STORAGE_KEY }, 'B7')
      const pathBefore = new URL(page.url()).pathname
      await page.reload({ waitUntil: 'domcontentloaded' })
      await page
        .locator('[data-testid="flow-node"], .fnode')
        .first()
        .waitFor({ timeout: 30_000 })
        .catch(() => null)
      const stored2 = await page.evaluate((key) => localStorage.getItem(key), STORAGE_KEY)
      push('localStorage_survives_reload', Boolean(stored2), { key: STORAGE_KEY }, 'B7')
      push(
        'path_stable_after_reload',
        new URL(page.url()).pathname === pathBefore,
        { path: new URL(page.url()).pathname },
        'B11',
      )
    } else {
      push('drag_node_120px', false, { reason: 'no node' }, 'B5')
      push('edge_endpoint_follows', false, { reason: 'no node' }, 'B6')
    }

    // B8 sheet + Escape
    const urlBefore = page.url()
    await page.locator('[data-testid="flow-node"], .fnode').nth(1).click()
    await page.waitForTimeout(300)
    const sheetOpen = await page
      .locator('[data-testid="flow-sheet"], .flow-sheet')
      .evaluate((el) => el.classList.contains('is-open'))
    push('click_node_sheet', sheetOpen, {}, 'B8')
    push('url_unchanged_sheet', page.url() === urlBefore, { url: page.url() }, 'B11')

    // S1 semantic graph/layer from durable DOM attributes (criterion 3A)
    const semanticDom = await page.evaluate(() => {
      const root = document.querySelector('[data-testid="flow-ultimate"]')
      return {
        mode:
          root?.getAttribute('data-mode') ||
          document.querySelector('.flow-pill.on')?.getAttribute('data-mode') ||
          null,
        rootLayer: root?.getAttribute('data-layer') || null,
        layerTablistPresent: Boolean(
          document.querySelector('[data-testid="flow-layer-toggle"]'),
        ),
        honestyPinText:
          document.querySelector('[data-testid="flow-honesty-pin"]')?.textContent ||
          null,
        nodes: [...document.querySelectorAll('[data-testid="flow-node"], .fnode')].map(
          (el) => ({
            id: el.getAttribute('data-node-id') || '',
            kind: el.getAttribute('data-node-kind'),
            className: el.className || '',
          }),
        ),
        hasFlowRoot: Boolean(root),
      }
    })
    const journeyCount = semanticDom.nodes.filter(
      (n) => classifySemanticNodeId(n.id).isJourney,
    ).length
    const honestyState = classifyDomHonestyState({
      honestyPinText: semanticDom.honestyPinText,
      journeyNodeCount: journeyCount,
      hasFlowRoot: semanticDom.hasFlowRoot,
    })
    // Live cross: ALWAYS pass exact five-project portfolio — never tautological auto-detect
    const layerEval = evaluateSemanticLayerContract({
      mode: semanticDom.mode || '',
      rootLayer: semanticDom.rootLayer,
      layerTablistPresent: semanticDom.layerTablistPresent,
      nodes: semanticDom.nodes,
      honestyState,
      requiredProjects:
        semanticDom.mode === 'cross' ? [...REQUIRED_CROSS_PROJECTS] : undefined,
    })
    // Public detail: missing project keys only — never raw internal node IDs
    push('semantic_layer', layerEval.ok, toSemanticLayerPublicDetail(layerEval), 'S1')
    if (semanticDom.mode === 'cross') {
      push(
        'semantic_layer_cross_portfolio_five',
        layerEval.ok &&
          layerEval.details?.requiredCrossProjects === REQUIRED_CROSS_PROJECTS.length,
        {
          requiredCrossProjects: REQUIRED_CROSS_PROJECTS.length,
          requiredCrossProjectsList: [...REQUIRED_CROSS_PROJECTS],
          presentProjects: layerEval.projects,
          missingProjects: layerEval.details?.missingProjects,
          reason: layerEval.reason,
        },
        'S1',
      )
    }

    // Sample one project mode for layer tablist + prefix (deterministic)
    await page.locator('.flow-pill[data-mode="rn"]').click()
    await page.waitForTimeout(280)
    const rnLayer = await page.evaluate(() => {
      const root = document.querySelector('[data-testid="flow-ultimate"]')
      return {
        mode: root?.getAttribute('data-mode'),
        rootLayer: root?.getAttribute('data-layer'),
        layerTablistPresent: Boolean(
          document.querySelector('[data-testid="flow-layer-toggle"]'),
        ),
        nodes: [...document.querySelectorAll('[data-testid="flow-node"], .fnode')].map(
          (el) => ({
            id: el.getAttribute('data-node-id') || '',
            kind: el.getAttribute('data-node-kind'),
            className: el.className || '',
          }),
        ),
      }
    })
    const rnEval = evaluateSemanticLayerContract({
      mode: rnLayer.mode || 'rn',
      rootLayer: rnLayer.rootLayer,
      layerTablistPresent: rnLayer.layerTablistPresent,
      nodes: rnLayer.nodes,
      honestyState: classifyDomHonestyState({
        honestyPinText: null,
        journeyNodeCount: rnLayer.nodes.filter((n) =>
          classifySemanticNodeId(n.id).isJourney,
        ).length,
        hasFlowRoot: true,
      }),
    })
    push(
      'semantic_layer_rn_sample',
      rnEval.ok,
      toSemanticLayerPublicDetail(rnEval),
      'S1',
    )
    await page.locator('.flow-pill[data-mode="cross"]').click()
    await page.waitForTimeout(250)

    // B9/S2 related — ONLY data-testid=flow-related (Navigasi terkait).
    // Fitur sama / flow-same-feature-item cannot satisfy PASS (criterion 3B).
    let relatedFound = false
    const pathBeforeRelated = new URL(page.url()).pathname
    const nodeCountForRelated = await page.locator('[data-testid="flow-node"], .fnode').count()
    const scanLimit = Math.min(nodeCountForRelated, 10)
    for (let i = 0; i < scanLimit; i++) {
      await page.locator('[data-testid="flow-node"], .fnode').nth(i).click()
      await page.waitForTimeout(280)
      const sameFeat = page.locator('[data-testid="flow-same-feature-item"]')
      if ((await sameFeat.count()) > 0) {
        const sameGoto = await sameFeat.first().getAttribute('data-goto')
        const sameEval = evaluateSemanticRelatedNavigation({
          hasRelatedControl: true,
          controlKind: 'same-feature',
          gotoId: sameGoto,
          targetPresentAsJourney: true,
          titleBefore: 'x',
          titleAfter: 'y',
          hlId: sameGoto,
          sheetOpen: true,
          mode: semanticDom.mode || 'cross',
          layer: semanticDom.rootLayer || 'app_flow',
          routePathBefore: pathBeforeRelated,
          routePathAfter: pathBeforeRelated,
        })
        push('same_feature_cannot_pass', !sameEval.ok, sameEval, 'S2')
      }
      const related = page.locator('[data-testid="flow-related"]').first()
      if ((await related.count()) === 0) continue
      relatedFound = true
      const t0 = await page.locator('#sheet-title').innerText()
      const body0 = await page
        .locator('#sheet-body, [data-testid="flow-sheet"]')
        .innerText()
        .catch(() => '')
      const gotoId = await related.getAttribute('data-goto')
      const sectionText = await page
        .locator('[data-testid="flow-sheet"], .flow-sheet')
        .innerText()
        .catch(() => '')
      const journeyIds = new Set(
        (
          await page.evaluate(() =>
            [...document.querySelectorAll('[data-testid="flow-node"], .fnode')]
              .map((el) => el.getAttribute('data-node-id') || '')
              .filter(Boolean),
          )
        ).filter((id) => classifySemanticNodeId(id).isJourney),
      )
      await related.click()
      await page.waitForTimeout(300)
      const afterNav = await page.evaluate(() => {
        const title = document.getElementById('sheet-title')?.textContent || ''
        const body =
          document.getElementById('sheet-body')?.innerText ||
          document.querySelector('[data-testid="flow-sheet"]')?.textContent ||
          ''
        const hl = document.querySelector(
          '.fnode.is-hl, .fnode.on, [data-testid="flow-node"].is-hl, [data-testid="flow-node"].on',
        )
        return {
          title,
          body,
          hlId: hl?.getAttribute('data-node-id') || null,
          open: document
            .querySelector('[data-testid="flow-sheet"], .flow-sheet')
            ?.classList.contains('is-open'),
        }
      })
      const pathAfter = new URL(page.url()).pathname
      const rel = evaluateSemanticRelatedNavigation({
        hasRelatedControl: true,
        controlKind: 'related',
        isSemanticRelatedTestId: true,
        sectionIsRelatedNav: /Navigasi terkait/i.test(sectionText),
        titleBefore: t0,
        titleAfter: afterNav.title,
        bodyBefore: body0,
        bodyAfter: afterNav.body,
        hlId: afterNav.hlId,
        gotoId,
        sheetOpen: afterNav.open,
        targetPresentAsJourney: Boolean(gotoId && journeyIds.has(gotoId)),
        targetIsInventory: Boolean(
          gotoId && classifySemanticNodeId(gotoId).isInventory,
        ),
        mode: semanticDom.mode || 'cross',
        layer: semanticDom.rootLayer || 'app_flow',
        routePathBefore: pathBeforeRelated,
        routePathAfter: pathAfter,
      })
      push(
        'related_changes',
        rel.ok,
        { t0, t1: afterNav.title, gotoId, hlId: afterNav.hlId, rel },
        'B9',
      )
      push('semantic_related_nav', rel.ok, rel, 'S2')
      push(
        'related_keeps_alur',
        pathAfter === pathBeforeRelated && /\/alur/.test(pathAfter),
        { pathBeforeRelated, pathAfter },
        'S2',
      )
      break
    }
    if (!relatedFound) {
      const rel = evaluateSemanticRelatedNavigation({
        hasRelatedControl: false,
        controlKind: 'absent',
      })
      push('related_changes', false, { ...rel, residual: true }, 'B9')
      push('semantic_related_nav', false, { ...rel, residual: true }, 'S2')
    }

    // S3 id-ID chrome + tech-id scrub (METHOD+path allowed)
    const visibleChrome = await page.evaluate(() => document.body?.innerText || '')
    const idId = evaluateIndonesianChromeLabels({
      visibleText: visibleChrome,
      requireRelatedSection: relatedFound,
    })
    push('id_id_chrome', idId.ok, idId, 'S3')

    await page.keyboard.press('Escape')
    await page.waitForTimeout(200)
    const closed = await page
      .locator('[data-testid="flow-sheet"], .flow-sheet')
      .evaluate((el) => !el.classList.contains('is-open'))
    push('escape_closes', closed, {}, 'B10')

    // D2 keyboard node open (real; not zoom soft-pass)
    const kbdMeta = await page.evaluate(() => {
      const n = document.querySelector(
        '[data-testid="flow-node"], .fnode',
      ) as HTMLElement | null
      if (!n) return { nodeKeyboardFocusable: false }
      const ti = n.getAttribute('tabindex')
      const focusable =
        n.tabIndex >= 0 ||
        (ti != null && ti !== '-1') ||
        n.getAttribute('role') === 'button'
      return { nodeKeyboardFocusable: focusable, tabIndex: n.tabIndex }
    })
    let openedViaKeyboard = false
    if (kbdMeta.nodeKeyboardFocusable) {
      await page.locator('[data-testid="flow-node"], .fnode').first().focus()
      await page.keyboard.press('Enter')
      await page.waitForTimeout(250)
      openedViaKeyboard = await page
        .locator('[data-testid="flow-sheet"], .flow-sheet')
        .evaluate((el) => el.classList.contains('is-open'))
    }
    const d2 = evaluateKeyboardNodeOpen({
      nodeKeyboardFocusable: Boolean(kbdMeta.nodeKeyboardFocusable),
      openedViaKeyboard,
    })
    push('D2_keyboard_node_open', d2.ok, { ...kbdMeta, openedViaKeyboard, d2 }, 'D2')

    // D3 natural focus (no force-focus)
    await page.keyboard.press('Escape').catch(() => null)
    await page.waitForTimeout(100)
    await page.locator('[data-testid="flow-node"], .fnode').first().click()
    await page.waitForTimeout(300)
    const focusInSheet = await page.evaluate(() => {
      const sheet = document.querySelector(
        '[data-testid="flow-sheet"], .flow-sheet',
      ) as HTMLElement | null
      const ae = document.activeElement
      return {
        sheetOpen: Boolean(sheet?.classList.contains('is-open')),
        activeInSheet: Boolean(sheet && ae && sheet.contains(ae)),
        forceFocused: false,
      }
    })
    const d3 = evaluateNaturalSheetFocus(focusInSheet)
    push('D3_focus_into_sheet', d3.ok, { ...focusInSheet, d3 }, 'D3')

    // D4 focus return to opener
    const openerId = await page
      .locator('[data-testid="flow-node"], .fnode')
      .first()
      .getAttribute('data-node-id')
    await page.evaluate((id) => {
      const el = id
        ? document.querySelector(`[data-node-id="${CSS.escape(id)}"]`)
        : document.querySelector('[data-testid="flow-node"], .fnode')
      if (el) el.setAttribute('data-flow-opener', '1')
    }, openerId)
    await page.keyboard.press('Escape')
    await page.waitForTimeout(200)
    const afterEsc = await page.evaluate(() => {
      const sheet = document.querySelector(
        '[data-testid="flow-sheet"], .flow-sheet',
      ) as HTMLElement | null
      const ae = document.activeElement
      const opener = document.querySelector('[data-flow-opener="1"]')
      return {
        sheetClosed: !sheet?.classList.contains('is-open'),
        focusOnOpener: Boolean(opener && ae && (ae === opener || opener.contains(ae))),
      }
    })
    const d4 = evaluateFocusReturn(afterEsc)
    push('D4_focus_return', d4.ok, { ...afterEsc, d4 }, 'D4')

    // D7 touch
    const touchSamples = await page.evaluate(() => {
      const out: Array<{ selector: string; w: number; h: number }> = []
      for (const sel of ['.flow-pill', '.flow-zoom button', '.flow-sheet-close']) {
        const el = document.querySelector(sel)
        if (!el) continue
        const r = el.getBoundingClientRect()
        out.push({ selector: sel, w: Math.round(r.width), h: Math.round(r.height) })
      }
      return out
    })
    const touch = evaluateTouchTargets(touchSamples)
    push('touch_44', touch.ok, touch, 'D7')

    // D6 reduced motion — fail on non-compliant durations (F4)
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.waitForTimeout(80)
    const rm = await page.evaluate(() => {
      const samples: Array<{ selector: string; durationMs: number }> = []
      for (const sel of ['.flow-sheet', '.flow-backdrop', '.fnode', '.flow-pill']) {
        const el = document.querySelector(sel)
        if (!el) continue
        const st = getComputedStyle(el)
        const parseList = (raw: string) =>
          (raw || '0s')
            .split(',')
            .map((x) => x.trim())
            .map((x) => {
              if (!x || x === '0') return 0
              return x.endsWith('ms') ? parseFloat(x) : parseFloat(x) * 1000
            })
            .filter((n) => Number.isFinite(n))
        const durs = [
          ...parseList(st.transitionDuration),
          ...parseList(st.animationDuration),
        ]
        samples.push({
          selector: sel,
          durationMs: durs.length ? Math.max(0, ...durs) : 0,
        })
      }
      return {
        matches: window.matchMedia('(prefers-reduced-motion: reduce)').matches,
        samples,
      }
    })
    push('reduced_motion_matches', rm.matches, rm, 'D6')
    const rmDur = evaluateReducedMotionDurations(rm.samples)
    push(
      'reduced_motion_durations',
      rm.matches && rmDur.ok,
      { ...rm, rmDur },
      'D6',
    )

    // C3 tech ids
    const bodyText = await page.evaluate(() => document.body?.innerText || '')
    const techHits = findTechIdHits(bodyText)
    push('no_tech_ids', techHits.length === 0, { techHits }, 'C3')

    // C1 data honesty
    const nodeIds = await page.evaluate(() =>
      [...document.querySelectorAll('[data-node-id]')]
        .map((el) => el.getAttribute('data-node-id'))
        .filter((x): x is string => Boolean(x)),
    )
    const honesty = classifyDataHonesty({
      source: 'file',
      pinFieldsPresent: false,
      visibleNodeIds: nodeIds,
    })
    push('data_honesty_local_only', honesty.claim === 'LOCAL_ONLY', honesty, 'C1')
    push('emit_node_ids', nodeIds.length > 0, { count: nodeIds.length, sample: nodeIds.slice(0, 5) }, 'C1')

    push('console_error_0', consoleErrors.length === 0, { consoleErrors: consoleErrors.slice(0, 5) }, 'A6')
    push('pageerror_0', pageErrors.length === 0, { pageErrors: pageErrors.slice(0, 5) }, 'A6')

    // Visual plan binding when FULL_SHA present
    const envSha = process.env.FULL_SHA?.trim() || process.env.GIT_SHA?.trim()
    if (envSha && isFullSha(envSha)) {
      const plan = planVisualCaptures({ fullSha: envSha, route: ROUTE })
      push('visual_plan_bound', plan.rows.length >= 13, { rowCount: plan.rows.length }, 'E')
    } else {
      push(
        'visual_plan_sha',
        true,
        {
          note: 'FULL_SHA unset — visual evidence fail-closed at capture harness; not a PASS',
        },
        'E',
      )
    }

    // Write residual report under .artifact if present
    const outDir = path.join(process.cwd(), '.artifact')
    try {
      fs.mkdirSync(outDir, { recursive: true })
      const summary = summarizeChecks(checks)
      fs.writeFileSync(
        path.join(outDir, 'canon-flow-total-replacement-live.json'),
        JSON.stringify(
          {
            targetGate: TARGET_GATE,
            route: ROUTE,
            status: 'LOCAL_ONLY',
            functionalPass: false,
            summary,
            checks,
            note: 'Author harness live probe — LOCAL_ONLY (static data / not independent verifier PASS)',
          },
          null,
          2,
        ),
      )
    } catch {
      /* non-fatal */
    }

    // F2 — any recorded false check fails the test (includes A5 + all B/D)
    const hardFails = collectHardFails(checks)
    expect(
      hardFails,
      hardFails.map((f) => `${f.layer ?? '?'}:${f.name}`).join(', '),
    ).toEqual([])
  })
})
