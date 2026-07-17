#!/usr/bin/env node
/**
 * Visual-regression baseline harness for ART S01–S24 (01B RELEASE-BLOCKING).
 *
 * Gate: unexpected maxDiffPixelRatio > 0.002 fails.
 * Baselines + receipts are bound to a full 40-char release SHA.
 * Baseline replace only with reviewer-approved receipt — never automatic.
 *
 * Modes:
 *   --self-test   (default) pure matrix + gate contract — no browser / no network
 *   --plan        emit planned baseline matrix JSON
 *   --compare     compare candidate PNGs vs SHA-bound baselines (requires files on disk)
 *   --run         live Playwright capture+compare (requires WEB_BASE + auth)
 *
 * Usage:
 *   node qa/e2e/flows/visual-regression-sids.mjs --self-test
 *   FULL_SHA=… node qa/e2e/flows/visual-regression-sids.mjs --plan
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  printOwnerTarget,
  resolveBoardId,
  resolveFullSha,
  resolveHeaded,
  resolveWebBase,
  isFullSha,
  FULL_SHA_RE,
} from '../lib/env.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '../../..')
const FLOW_NAME = 'visual-regression-sids'
const OUT_BASELINES = path.resolve(__dirname, '../out/baselines')
const OUT_SHOTS = path.resolve(__dirname, '../out/screenshots')
const DEFAULT_BOARD = 'mfs-rebuild'

/** 01B / ART-UX-DIRECTION visual regression threshold. */
export const MAX_DIFF_PIXEL_RATIO = 0.002

/** Visual claim tokens — PASS only with on-disk shot + SHA-bound baseline + ratio ≤ gate. */
export const VISUAL_CLAIMS = Object.freeze({
  NOT_RUN: 'NOT_RUN',
  PENDING_CAPTURE: 'PENDING_CAPTURE',
  PENDING_BASELINE: 'PENDING_BASELINE',
  DIFF_FAIL: 'DIFF_FAIL',
  FAIL: 'FAIL',
  PASS: 'PASS',
})

/**
 * ART S01–S24 matrix (ART-UX-DIRECTION EXACT STAGING SCREENSHOT MATRIX + product board map).
 * Placeholders: {board}, {taskId}, {decisionId}
 */
export const ART_VISUAL_SIDS = Object.freeze([
  {
    id: 'S01',
    artUrl: '/',
    productPath: '/b/{board}/',
    viewport: '1440x900',
    state: 'populated',
    intent: 'Overview / fresh populated',
  },
  {
    id: 'S02',
    artUrl: '/',
    productPath: '/b/{board}/',
    viewport: '390x844',
    state: 'populated',
    intent: 'Overview mobile',
  },
  {
    id: 'S03',
    artUrl: '/work?bucket=DONE',
    productPath: '/b/{board}/work?bucket=DONE',
    viewport: '1280x800',
    state: 'populated',
    intent: 'Selesai / evidence summary',
  },
  {
    id: 'S04',
    artUrl: '/work?bucket=ONGOING',
    productPath: '/b/{board}/work?bucket=ONGOING',
    viewport: '1280x800',
    state: 'populated',
    intent: 'Active owner + heartbeat',
  },
  {
    id: 'S05',
    artUrl: '/work?bucket=NEXT',
    productPath: '/b/{board}/work?bucket=NEXT',
    viewport: '1280x800',
    state: 'populated',
    intent: 'Next + ordering reason',
  },
  {
    id: 'S06',
    artUrl: '/work?bucket=QUEUED',
    productPath: '/b/{board}/work?bucket=QUEUED',
    viewport: '1280x800',
    state: 'populated',
    intent: 'Queue + wait reason',
  },
  {
    id: 'S07',
    artUrl: '/work?bucket=BLOCKED',
    productPath: '/b/{board}/work?bucket=BLOCKED',
    viewport: '1280x800',
    state: 'needs-human',
    intent: 'Blocker + displace owner',
  },
  {
    id: 'S08',
    artUrl: '/work?bucket=RECONCILIATION',
    productPath: '/b/{board}/work?bucket=RECONCILIATION_PENDING',
    viewport: '390x844',
    state: 'partial',
    intent: 'Stale/orphan reconciliation',
  },
  {
    id: 'S09',
    artUrl: '/work/<taskId>',
    productPath: '/b/{board}/work/{taskId}',
    viewport: '1280x800',
    state: 'populated',
    intent: 'Human-first task detail',
  },
  {
    id: 'S10',
    artUrl: '/work/<taskId>?mode=technical',
    productPath: '/b/{board}/work/{taskId}?mode=technical',
    viewport: '1280x800',
    state: 'populated',
    intent: 'Expanded technical detail',
  },
  {
    id: 'S11',
    artUrl: '/decisions',
    productPath: '/b/{board}/decisions',
    viewport: '1280x800',
    state: 'needs-human',
    intent: 'Decision Inbox populated',
  },
  {
    id: 'S12',
    artUrl: '/decisions/<decisionId>',
    productPath: '/b/{board}/decisions/{decisionId}',
    viewport: '390x844',
    state: 'needs-human',
    intent: 'Decision detail/actions',
  },
  {
    id: 'S13',
    artUrl: '/knowledge/domains/AFFILIATE',
    productPath: '/b/{board}/knowledge/domains/AFFILIATE',
    viewport: '1440x900',
    state: 'populated',
    intent: 'Cross-project domain',
  },
  {
    id: 'S14',
    artUrl: '/knowledge/domains/AFFILIATE',
    productPath: '/b/{board}/knowledge/domains/AFFILIATE',
    viewport: '390x844',
    state: 'populated',
    intent: 'Cross-project domain mobile',
  },
  {
    id: 'S15',
    artUrl: '/search?q=pembayaran%20affiliate',
    productPath: '/b/{board}/search?q=pembayaran%20affiliate',
    viewport: '1280x800',
    state: 'populated',
    intent: 'Human semantic result',
  },
  {
    id: 'S16',
    artUrl: '/search?q=T-AFF-N16-MONEY-EXPIRED-UNPAID',
    productPath: '/b/{board}/search?q=T-AFF-N16-MONEY-EXPIRED-UNPAID',
    viewport: '1280x800',
    state: 'populated',
    intent: 'Technical alias result',
  },
  {
    id: 'S17',
    artUrl: '/documentation/domains/AFFILIATE',
    productPath: '/b/{board}/documentation/domains/AFFILIATE',
    viewport: '1280x800',
    state: 'populated',
    intent: 'Export preview/citations',
  },
  {
    id: 'S18',
    artUrl: '/',
    productPath: '/b/{board}/',
    viewport: '1280x800',
    state: 'stale',
    intent: 'Persistent stale-data banner',
  },
  {
    id: 'S19',
    artUrl: '/work',
    productPath: '/b/{board}/work',
    viewport: '1280x800',
    state: 'loading',
    intent: 'Loading skeleton',
  },
  {
    id: 'S20',
    artUrl: '/work',
    productPath: '/b/{board}/work',
    viewport: '1280x800',
    state: 'error',
    intent: 'Safe API error and recovery',
  },
  {
    id: 'S21',
    artUrl: '/knowledge/domains/AFFILIATE',
    productPath: '/b/{board}/knowledge/domains/AFFILIATE',
    viewport: '1280x800',
    state: 'partial',
    intent: 'Knowledge conflict/redaction',
  },
  {
    id: 'S22',
    artUrl: '/work/<taskId>',
    productPath: '/b/{board}/work/{taskId}',
    viewport: '1280x800',
    state: 'populated',
    intent: 'Keyboard focus sequence',
  },
  {
    id: 'S23',
    artUrl: '/work/<taskId>',
    productPath: '/b/{board}/work/{taskId}',
    viewport: '1280x800',
    state: 'populated',
    intent: 'Browser zoom 200%',
    zoom: '200%',
  },
  {
    id: 'S24',
    artUrl: '/work?query=<zero-result>',
    productPath: '/b/{board}/work?query=zero-result-xyz',
    viewport: '320x568',
    state: 'zero-results',
    intent: 'Honest empty result',
  },
])

export const EXPECTED_SID_COUNT = 24

function hasFlag(name) {
  return process.argv.includes(name)
}

function arg(name, fallback = null) {
  const i = process.argv.indexOf(name)
  if (i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')) {
    return process.argv[i + 1]
  }
  return fallback
}

/**
 * @param {string} token
 */
export function parseViewport(token) {
  const m = String(token).match(/^(\d+)x(\d+)$/i)
  if (!m) throw new Error(`invalid viewport token: ${token}`)
  return { width: Number(m[1]), height: Number(m[2]) }
}

/**
 * @param {string} template
 * @param {{ boardId?: string, taskId?: string, decisionId?: string }} [pins]
 */
export function resolveProductPath(template, pins = {}) {
  const board = pins.boardId ?? DEFAULT_BOARD
  const taskId = pins.taskId ?? 'task-ongoing-1'
  const decisionId = pins.decisionId ?? 'dec-v3-001'
  return String(template)
    .replaceAll('{board}', board)
    .replaceAll('{taskId}', taskId)
    .replaceAll('{decisionId}', decisionId)
}

/**
 * SHA-bound baseline directory: qa/e2e/out/baselines/<fullSha>/
 * @param {string} fullSha
 * @param {string} [baselinesRoot]
 */
export function baselineDirForSha(fullSha, baselinesRoot = OUT_BASELINES) {
  if (!isFullSha(fullSha)) {
    throw new Error(
      `BASELINE FAIL: fullSha must be 40-char hex for SHA-bound baselines (got ${fullSha})`,
    )
  }
  return path.join(baselinesRoot, fullSha.toLowerCase())
}

/**
 * Paths for one SID under a release SHA.
 * @param {{ artSid: string, fullSha: string, baselinesRoot?: string, shotsRoot?: string }} args
 */
export function baselinePathsForSid(args) {
  const dir = baselineDirForSha(args.fullSha, args.baselinesRoot ?? OUT_BASELINES)
  const sid = args.artSid
  return {
    baselineDir: dir,
    baselinePng: path.join(dir, `${sid}.png`),
    receiptPath: path.join(dir, `${sid}.receipt.json`),
    candidatePng: path.join(args.shotsRoot ?? OUT_SHOTS, `visual-${sid}.png`),
  }
}

/**
 * Build a baseline receipt object (not written).
 * @param {{
 *   artSid: string,
 *   fullSha: string,
 *   route: string,
 *   viewport: string,
 *   zoom?: string|null,
 *   state: string,
 *   intent: string,
 *   maxDiffPixelRatio?: number,
 *   reviewerApproved?: boolean,
 *   reviewerId?: string|null,
 *   baselinePng?: string,
 *   note?: string,
 * }} input
 */
export function buildBaselineReceipt(input) {
  if (!isFullSha(input.fullSha)) {
    throw new Error('BASELINE_RECEIPT FAIL: fullSha must be 40-char hex')
  }
  if (!/^S\d{2}$/.test(input.artSid)) {
    throw new Error(`BASELINE_RECEIPT FAIL: invalid artSid ${input.artSid}`)
  }
  const ratio = input.maxDiffPixelRatio ?? MAX_DIFF_PIXEL_RATIO
  if (ratio !== MAX_DIFF_PIXEL_RATIO) {
    throw new Error(
      `BASELINE_RECEIPT FAIL: maxDiffPixelRatio must be ${MAX_DIFF_PIXEL_RATIO} (got ${ratio})`,
    )
  }
  return {
    schemaVersion: 'TM_VISUAL_BASELINE_V1',
    artSid: input.artSid,
    fullSha: input.fullSha.toLowerCase(),
    route: input.route,
    viewport: input.viewport,
    zoom: input.zoom ?? null,
    state: input.state,
    intent: input.intent,
    maxDiffPixelRatio: MAX_DIFF_PIXEL_RATIO,
    baselinePng: input.baselinePng ?? null,
    reviewerApproved: Boolean(input.reviewerApproved),
    reviewerId: input.reviewerId ?? null,
    autoReplaceForbidden: true,
    createdAt: new Date().toISOString(),
    note:
      input.note ||
      'Baseline bound to release SHA; replace only with reviewer-approved receipt',
  }
}

/**
 * Refuse automatic baseline replacement without reviewer receipt.
 * @param {{
 *   existingBaselinePath?: string|null,
 *   reviewerApproved?: boolean,
 *   reviewerId?: string|null,
 *   fsExists?: (p: string) => boolean,
 * }} input
 */
export function assertBaselineReplaceAllowed(input = {}) {
  const exists = input.fsExists ?? ((p) => fs.existsSync(p))
  const pathToCheck = input.existingBaselinePath
  if (!pathToCheck || !exists(pathToCheck)) {
    return { ok: true, reason: 'no existing baseline — initial write allowed' }
  }
  if (input.reviewerApproved === true && input.reviewerId) {
    return { ok: true, reason: 'reviewer-approved baseline replace' }
  }
  throw new Error(
    'BASELINE_REPLACE FAIL: automatic baseline replacement forbidden; require reviewerApproved + reviewerId receipt (01B visual regression)',
  )
}

/**
 * Pure pixel-ratio gate evaluator (does not open images).
 * @param {{ diffPixelRatio: number, maxDiffPixelRatio?: number }} input
 */
export function evaluateDiffRatio(input) {
  const max = input.maxDiffPixelRatio ?? MAX_DIFF_PIXEL_RATIO
  if (typeof input.diffPixelRatio !== 'number' || Number.isNaN(input.diffPixelRatio)) {
    return {
      ok: false,
      claim: VISUAL_CLAIMS.FAIL,
      reason: 'diffPixelRatio missing or not a number',
    }
  }
  if (input.diffPixelRatio > max) {
    return {
      ok: false,
      claim: VISUAL_CLAIMS.DIFF_FAIL,
      reason: `maxDiffPixelRatio gate fail: ${input.diffPixelRatio} > ${max}`,
      diffPixelRatio: input.diffPixelRatio,
      maxDiffPixelRatio: max,
    }
  }
  return {
    ok: true,
    claim: VISUAL_CLAIMS.PASS,
    reason: `diff within gate (${input.diffPixelRatio} ≤ ${max})`,
    diffPixelRatio: input.diffPixelRatio,
    maxDiffPixelRatio: max,
  }
}

/**
 * Build visual-diff metadata. PASS requires on-disk screenshot + SHA-bound baseline + ratio ≤ 0.002.
 * @param {{
 *   claim?: string,
 *   artSid?: string,
 *   fullSha?: string|null,
 *   screenshotPath?: string|null,
 *   baselinePath?: string|null,
 *   receiptPath?: string|null,
 *   diffPixelRatio?: number|null,
 *   maxDiffPixelRatio?: number,
 *   fsExists?: (p: string) => boolean,
 *   fsRead?: (p: string) => string,
 *   note?: string,
 * }} input
 */
export function buildVisualDiffMetadata(input = {}) {
  const exists = input.fsExists ?? ((p) => fs.existsSync(p))
  const read = input.fsRead ?? ((p) => fs.readFileSync(p, 'utf8'))
  const screenshotPath = input.screenshotPath || null
  const baselinePath = input.baselinePath || null
  const receiptPath = input.receiptPath || null
  const max = input.maxDiffPixelRatio ?? MAX_DIFF_PIXEL_RATIO
  let claim = input.claim || VISUAL_CLAIMS.NOT_RUN

  if (max !== MAX_DIFF_PIXEL_RATIO) {
    throw new Error(
      `VISUAL_CLAIM FAIL: maxDiffPixelRatio must be ${MAX_DIFF_PIXEL_RATIO} (got ${max})`,
    )
  }

  if (claim === VISUAL_CLAIMS.PASS) {
    if (!screenshotPath || !exists(screenshotPath)) {
      throw new Error(
        'VISUAL_CLAIM FAIL: cannot claim visual PASS without an on-disk screenshotPath',
      )
    }
    if (!baselinePath || !exists(baselinePath)) {
      throw new Error(
        'VISUAL_CLAIM FAIL: cannot claim visual PASS without an on-disk baselinePath',
      )
    }
    if (!input.fullSha || !isFullSha(input.fullSha)) {
      throw new Error(
        'VISUAL_CLAIM FAIL: cannot claim visual PASS without release fullSha bound to baseline',
      )
    }
    // baseline path must live under .../baselines/<fullSha>/
    const normBase = baselinePath.replace(/\\/g, '/')
    if (!normBase.includes(`/baselines/${input.fullSha.toLowerCase()}/`)) {
      throw new Error(
        `VISUAL_CLAIM FAIL: baselinePath not bound to fullSha ${input.fullSha}`,
      )
    }
    if (receiptPath && exists(receiptPath)) {
      try {
        const receipt = JSON.parse(read(receiptPath))
        if (receipt.fullSha && receipt.fullSha !== input.fullSha.toLowerCase()) {
          throw new Error(
            `VISUAL_CLAIM FAIL: receipt fullSha ${receipt.fullSha} != ${input.fullSha}`,
          )
        }
        if (
          receipt.maxDiffPixelRatio != null &&
          receipt.maxDiffPixelRatio !== MAX_DIFF_PIXEL_RATIO
        ) {
          throw new Error(
            `VISUAL_CLAIM FAIL: receipt maxDiffPixelRatio ${receipt.maxDiffPixelRatio} != ${MAX_DIFF_PIXEL_RATIO}`,
          )
        }
      } catch (e) {
        if (String(e.message).startsWith('VISUAL_CLAIM FAIL:')) throw e
        throw new Error(
          `VISUAL_CLAIM FAIL: receipt unreadable at ${receiptPath}: ${String(e?.message || e)}`,
        )
      }
    }
    if (typeof input.diffPixelRatio === 'number') {
      const evaled = evaluateDiffRatio({
        diffPixelRatio: input.diffPixelRatio,
        maxDiffPixelRatio: max,
      })
      if (!evaled.ok) {
        throw new Error(`VISUAL_CLAIM FAIL: ${evaled.reason}`)
      }
    }
  }

  const shotOk = Boolean(screenshotPath && exists(screenshotPath))
  if (!shotOk && (claim === VISUAL_CLAIMS.PASS || claim === VISUAL_CLAIMS.DIFF_FAIL)) {
    claim = VISUAL_CLAIMS.PENDING_CAPTURE
  } else if (
    shotOk &&
    (!baselinePath || !exists(baselinePath)) &&
    claim === VISUAL_CLAIMS.PASS
  ) {
    claim = VISUAL_CLAIMS.PENDING_BASELINE
  }

  return {
    claim,
    artSid: input.artSid ?? null,
    fullSha: input.fullSha ?? null,
    screenshotPath,
    baselinePath,
    receiptPath,
    maxDiffPixelRatio: MAX_DIFF_PIXEL_RATIO,
    diffPixelRatio:
      typeof input.diffPixelRatio === 'number' ? input.diffPixelRatio : null,
    note:
      input.note ||
      (claim === VISUAL_CLAIMS.PASS
        ? 'pixel diff accepted against SHA-bound baseline'
        : claim === VISUAL_CLAIMS.PENDING_CAPTURE
          ? 'NOT_CLAIMED: no screenshot'
          : claim === VISUAL_CLAIMS.PENDING_BASELINE
            ? 'NOT_CLAIMED: no SHA-bound baseline'
            : claim === VISUAL_CLAIMS.NOT_RUN
              ? 'visual comparison not executed'
              : 'visual claim recorded'),
    shippableVisual: claim === VISUAL_CLAIMS.PASS,
    autoReplaceForbidden: true,
  }
}

/**
 * Plan full S01–S24 visual matrix (no I/O).
 * @param {{
 *   boardId?: string,
 *   taskId?: string,
 *   decisionId?: string,
 *   fullSha?: string,
 *   baselinesRoot?: string,
 *   shotsRoot?: string,
 * }} [opts]
 */
export function planVisualMatrix(opts = {}) {
  const boardId = opts.boardId ?? resolveBoardId(DEFAULT_BOARD)
  const fullShaRaw = opts.fullSha ?? resolveFullSha({ cwd: ROOT })
  const fullSha = isFullSha(fullShaRaw)
    ? fullShaRaw.toLowerCase()
    : fullShaRaw
  const rows = ART_VISUAL_SIDS.map((sid) => {
    const route = resolveProductPath(sid.productPath, {
      boardId,
      taskId: opts.taskId,
      decisionId: opts.decisionId,
    })
    const paths = isFullSha(fullSha)
      ? baselinePathsForSid({
          artSid: sid.id,
          fullSha,
          baselinesRoot: opts.baselinesRoot,
          shotsRoot: opts.shotsRoot,
        })
      : {
          baselineDir: null,
          baselinePng: null,
          receiptPath: null,
          candidatePng: path.join(
            opts.shotsRoot ?? OUT_SHOTS,
            `visual-${sid.id}.png`,
          ),
        }
    return {
      artSid: sid.id,
      artUrl: sid.artUrl,
      route,
      viewport: sid.viewport,
      zoom: sid.zoom ?? null,
      state: sid.state,
      intent: sid.intent,
      fullSha,
      maxDiffPixelRatio: MAX_DIFF_PIXEL_RATIO,
      baselinePng: paths.baselinePng,
      receiptPath: paths.receiptPath,
      candidatePng: paths.candidatePng,
      claim: VISUAL_CLAIMS.PENDING_CAPTURE,
      browserTestId: `visual-${sid.id}`,
    }
  })
  return {
    flow: FLOW_NAME,
    boardId,
    fullSha,
    maxDiffPixelRatio: MAX_DIFF_PIXEL_RATIO,
    plannedCount: rows.length,
    baselinesRoot: opts.baselinesRoot ?? OUT_BASELINES,
    rows,
  }
}

/**
 * Pure self-test — no browser, no network.
 */
export function selfTest() {
  const checks = {}
  const detail = {}

  checks.sidCount24 = ART_VISUAL_SIDS.length === EXPECTED_SID_COUNT
  checks.sidIdsSequential = ART_VISUAL_SIDS.every(
    (s, i) => s.id === `S${String(i + 1).padStart(2, '0')}`,
  )
  checks.maxDiffExact =
    MAX_DIFF_PIXEL_RATIO === 0.002 && Object.is(MAX_DIFF_PIXEL_RATIO, 0.002)

  const fixtureSha = 'b9c86c2d1ef6c26d4436d4ffd434642421f847bd'
  const planned = planVisualMatrix({
    boardId: DEFAULT_BOARD,
    fullSha: fixtureSha,
  })
  checks.plannedCount24 = planned.plannedCount === 24
  checks.rows24 = planned.rows.length === 24
  detail.plannedCount = planned.plannedCount

  checks.allHaveShaBoundBaseline = planned.rows.every(
    (r) =>
      typeof r.baselinePng === 'string' &&
      r.baselinePng.includes(`/baselines/${fixtureSha}/`) &&
      r.baselinePng.endsWith(`${r.artSid}.png`),
  )
  checks.allHaveReceiptPath = planned.rows.every(
    (r) =>
      typeof r.receiptPath === 'string' &&
      r.receiptPath.includes(`/baselines/${fixtureSha}/`) &&
      r.receiptPath.endsWith(`${r.artSid}.receipt.json`),
  )
  checks.allHaveRatio = planned.rows.every(
    (r) => r.maxDiffPixelRatio === MAX_DIFF_PIXEL_RATIO,
  )
  checks.uniqueSids = new Set(planned.rows.map((r) => r.artSid)).size === 24
  checks.routesBoardScoped = planned.rows.every((r) =>
    r.route.startsWith(`/b/${DEFAULT_BOARD}/`),
  )

  // baselineDirForSha rejects non-full SHA
  let rejectShortSha = false
  try {
    baselineDirForSha('abc123')
  } catch (e) {
    rejectShortSha = String(e.message).includes('40-char hex')
  }
  checks.rejectShortSha = rejectShortSha

  // receipt requires fullSha + ratio
  const receipt = buildBaselineReceipt({
    artSid: 'S01',
    fullSha: fixtureSha,
    route: planned.rows[0].route,
    viewport: '1440x900',
    state: 'populated',
    intent: 'Overview',
    baselinePng: planned.rows[0].baselinePng,
  })
  checks.receiptSchema =
    receipt.schemaVersion === 'TM_VISUAL_BASELINE_V1' &&
    receipt.maxDiffPixelRatio === 0.002 &&
    receipt.fullSha === fixtureSha &&
    receipt.autoReplaceForbidden === true

  let receiptBadRatio = false
  try {
    buildBaselineReceipt({
      artSid: 'S01',
      fullSha: fixtureSha,
      route: '/',
      viewport: '1440x900',
      state: 'populated',
      intent: 'x',
      maxDiffPixelRatio: 0.05,
    })
  } catch (e) {
    receiptBadRatio = String(e.message).includes('maxDiffPixelRatio')
  }
  checks.receiptRejectsWrongRatio = receiptBadRatio

  // auto-replace forbidden when baseline exists without reviewer
  let replaceBlocked = false
  try {
    assertBaselineReplaceAllowed({
      existingBaselinePath: '/mock/baselines/S01.png',
      reviewerApproved: false,
      fsExists: () => true,
    })
  } catch (e) {
    replaceBlocked = String(e.message).includes('automatic baseline replacement forbidden')
  }
  checks.autoReplaceBlocked = replaceBlocked

  const replaceOk = assertBaselineReplaceAllowed({
    existingBaselinePath: '/mock/baselines/S01.png',
    reviewerApproved: true,
    reviewerId: 'reviewer-visual-1',
    fsExists: () => true,
  })
  checks.reviewerReplaceAllowed = replaceOk.ok === true

  // evaluateDiffRatio gate
  checks.diffPass =
    evaluateDiffRatio({ diffPixelRatio: 0.001 }).ok === true &&
    evaluateDiffRatio({ diffPixelRatio: 0.002 }).ok === true
  checks.diffFail =
    evaluateDiffRatio({ diffPixelRatio: 0.0021 }).ok === false &&
    evaluateDiffRatio({ diffPixelRatio: 0.01 }).claim === VISUAL_CLAIMS.DIFF_FAIL

  // PASS without files throws
  let passBlockedNoShot = false
  try {
    buildVisualDiffMetadata({
      claim: VISUAL_CLAIMS.PASS,
      fullSha: fixtureSha,
      screenshotPath: null,
      baselinePath: `/mock/baselines/${fixtureSha}/S01.png`,
    })
  } catch (e) {
    passBlockedNoShot = String(e.message).includes('screenshotPath')
  }
  checks.passBlockedNoShot = passBlockedNoShot

  let passBlockedNoBase = false
  try {
    buildVisualDiffMetadata({
      claim: VISUAL_CLAIMS.PASS,
      fullSha: fixtureSha,
      screenshotPath: '/mock/shot.png',
      baselinePath: null,
      fsExists: (p) => p === '/mock/shot.png',
    })
  } catch (e) {
    passBlockedNoBase = String(e.message).includes('baselinePath')
  }
  checks.passBlockedNoBase = passBlockedNoBase

  let passBlockedNoSha = false
  try {
    buildVisualDiffMetadata({
      claim: VISUAL_CLAIMS.PASS,
      screenshotPath: '/mock/shot.png',
      baselinePath: `/mock/baselines/${fixtureSha}/S01.png`,
      fsExists: () => true,
    })
  } catch (e) {
    passBlockedNoSha = String(e.message).includes('fullSha')
  }
  checks.passBlockedNoSha = passBlockedNoSha

  // PASS with files + ratio under gate
  const okMeta = buildVisualDiffMetadata({
    claim: VISUAL_CLAIMS.PASS,
    artSid: 'S01',
    fullSha: fixtureSha,
    screenshotPath: '/mock/shot.png',
    baselinePath: `/opt/mfs/workspace/task-manager/qa/e2e/out/baselines/${fixtureSha}/S01.png`,
    receiptPath: `/opt/mfs/workspace/task-manager/qa/e2e/out/baselines/${fixtureSha}/S01.receipt.json`,
    diffPixelRatio: 0.001,
    fsExists: () => true,
    fsRead: () =>
      JSON.stringify({
        fullSha: fixtureSha,
        maxDiffPixelRatio: 0.002,
        artSid: 'S01',
      }),
  })
  checks.passAllowedWithProof =
    okMeta.claim === VISUAL_CLAIMS.PASS &&
    okMeta.shippableVisual === true &&
    okMeta.maxDiffPixelRatio === 0.002

  // PASS fails when ratio over gate
  let passOverRatio = false
  try {
    buildVisualDiffMetadata({
      claim: VISUAL_CLAIMS.PASS,
      artSid: 'S01',
      fullSha: fixtureSha,
      screenshotPath: '/mock/shot.png',
      baselinePath: `/x/baselines/${fixtureSha}/S01.png`,
      diffPixelRatio: 0.01,
      fsExists: () => true,
    })
  } catch (e) {
    passOverRatio = String(e.message).includes('maxDiffPixelRatio gate fail')
  }
  checks.passBlockedOverRatio = passOverRatio

  // baselines README expected path (file may be written by this packet)
  const readmePath = path.join(OUT_BASELINES, 'README.md')
  checks.baselinesRootDefined =
    OUT_BASELINES.includes(`${path.sep}out${path.sep}baselines`) ||
    OUT_BASELINES.endsWith('/out/baselines')
  detail.baselinesReadmePath = readmePath
  detail.baselinesReadmeExists = fs.existsSync(readmePath)

  // FULL_SHA_RE available for consumers
  checks.fullShaRe = FULL_SHA_RE.test(fixtureSha)

  const ok = Object.values(checks).every(Boolean)
  return {
    ok,
    mode: 'self-test',
    flow: FLOW_NAME,
    checks,
    detail,
    residual_gaps: ok
      ? 'none for pure contract; live --run/--compare not exercised this session; no SHA-bound PNG baselines committed'
      : Object.entries(checks)
          .filter(([, v]) => !v)
          .map(([k]) => k)
          .join(','),
    NOT_SHIPPABLE: 'no live visual proof (self-test only)',
  }
}

/**
 * Plan-only CLI.
 */
export function runPlan(opts = {}) {
  const planned = planVisualMatrix(opts)
  const runId =
    opts.runId ??
    `visual-sids-plan-${new Date().toISOString().replace(/[:.]/g, '').slice(0, 15)}`
  const outPath =
    opts.outPath ||
    arg('--out', path.join(ROOT, 'qa/e2e/out/runtime', runId, 'VISUAL_SID_PLAN.json'))
  fs.mkdirSync(path.dirname(outPath), { recursive: true })
  fs.writeFileSync(
    outPath,
    JSON.stringify({ ...planned, runId, mode: 'plan' }, null, 2),
    'utf8',
  )
  return {
    mode: 'plan',
    flow: FLOW_NAME,
    plan: outPath,
    plannedCount: planned.plannedCount,
    fullSha: planned.fullSha,
    maxDiffPixelRatio: MAX_DIFF_PIXEL_RATIO,
    note: 'Plan-only: claim=PENDING_CAPTURE; no screenshots or baselines written',
    NOT_SHIPPABLE: 'no live visual proof',
  }
}

/**
 * Compare pre-existing candidate PNGs against SHA-bound baselines using provided
 * diffPixelRatio map (image-diff engine is external; this gate only applies the ratio).
 *
 * @param {{
 *   fullSha?: string,
 *   ratios?: Record<string, number>,
 *   fsExists?: (p: string) => boolean,
 * }} [opts]
 */
export function runCompare(opts = {}) {
  const fullSha = (opts.fullSha ?? resolveFullSha({ cwd: ROOT })).toLowerCase()
  if (!isFullSha(fullSha)) {
    throw new Error('COMPARE FAIL: FULL_SHA / git HEAD must be 40-char hex')
  }
  const planned = planVisualMatrix({ fullSha })
  const exists = opts.fsExists ?? ((p) => fs.existsSync(p))
  const ratios = opts.ratios ?? {}
  const results = []

  for (const row of planned.rows) {
    const shotOk = row.candidatePng && exists(row.candidatePng)
    const baseOk = row.baselinePng && exists(row.baselinePng)
    if (!shotOk || !baseOk) {
      results.push({
        artSid: row.artSid,
        ok: false,
        claim: !shotOk ? VISUAL_CLAIMS.PENDING_CAPTURE : VISUAL_CLAIMS.PENDING_BASELINE,
        reason: !shotOk
          ? `missing candidate ${row.candidatePng}`
          : `missing baseline ${row.baselinePng}`,
      })
      continue
    }
    const ratio = ratios[row.artSid]
    if (typeof ratio !== 'number') {
      results.push({
        artSid: row.artSid,
        ok: false,
        claim: VISUAL_CLAIMS.NOT_RUN,
        reason: 'diffPixelRatio not supplied for SID (external image-diff required)',
      })
      continue
    }
    try {
      const meta = buildVisualDiffMetadata({
        claim: VISUAL_CLAIMS.PASS,
        artSid: row.artSid,
        fullSha,
        screenshotPath: row.candidatePng,
        baselinePath: row.baselinePng,
        receiptPath: row.receiptPath,
        diffPixelRatio: ratio,
        fsExists: exists,
      })
      results.push({
        artSid: row.artSid,
        ok: true,
        claim: meta.claim,
        diffPixelRatio: ratio,
        maxDiffPixelRatio: MAX_DIFF_PIXEL_RATIO,
      })
    } catch (e) {
      results.push({
        artSid: row.artSid,
        ok: false,
        claim: VISUAL_CLAIMS.DIFF_FAIL,
        reason: String(e?.message || e),
        diffPixelRatio: ratio,
      })
    }
  }

  const failed = results.filter((r) => !r.ok)
  return {
    mode: 'compare',
    flow: FLOW_NAME,
    fullSha,
    maxDiffPixelRatio: MAX_DIFF_PIXEL_RATIO,
    plannedCount: planned.plannedCount,
    passed: results.filter((r) => r.ok).length,
    failed: failed.length,
    results,
    ok: failed.length === 0,
    residual_gaps:
      failed.length === 0
        ? 'none'
        : failed.map((f) => `${f.artSid}:${f.claim}`).join(','),
  }
}

/**
 * Live capture path — captures candidates only; does NOT auto-write baselines.
 * Baseline promotion requires separate reviewer-approved receipt flow.
 */
export async function runLive(opts = {}) {
  const boardId = opts.boardId ?? resolveBoardId(DEFAULT_BOARD)
  const headed = resolveHeaded()
  const webBase = resolveWebBase()
  const fullSha = resolveFullSha({ cwd: ROOT, require: true }).toLowerCase()
  const planned = planVisualMatrix({ boardId, fullSha })

  printOwnerTarget({
    flow: FLOW_NAME,
    mode: 'run',
    base_url: webBase,
    boardId,
    fullSha,
  })

  fs.mkdirSync(OUT_SHOTS, { recursive: true })
  fs.mkdirSync(baselineDirForSha(fullSha), { recursive: true })

  const { chromium } = await import('@playwright/test')
  const { requireExistingStorageState, AUTH_STORAGE_STATE_PATH } = await import(
    '../lib/auth.mjs'
  )

  const browser = await chromium.launch({ headless: !headed })
  const captured = []
  try {
    const context = await browser.newContext({
      baseURL: webBase,
      viewport: { width: 1440, height: 900 },
      storageState: requireExistingStorageState(
        opts.storageStatePath ?? AUTH_STORAGE_STATE_PATH,
      ),
      ignoreHTTPSErrors: true,
    })
    const page = await context.newPage()
    for (const row of planned.rows) {
      const vp = parseViewport(row.viewport)
      await page.setViewportSize(vp)
      await page.goto(row.route, { waitUntil: 'domcontentloaded' })
      if (row.zoom === '200%') {
        await page.evaluate(() => {
          document.documentElement.style.zoom = '2'
        })
      }
      await page.screenshot({ path: row.candidatePng, fullPage: false })
      captured.push({
        artSid: row.artSid,
        candidatePng: row.candidatePng,
        baselinePng: row.baselinePng,
        claim: VISUAL_CLAIMS.PENDING_BASELINE,
        note: 'candidate captured; baseline auto-replace forbidden',
      })
      if (row.zoom === '200%') {
        await page.evaluate(() => {
          document.documentElement.style.zoom = ''
        })
      }
    }
    await context.close()
  } finally {
    await browser.close()
  }

  return {
    mode: 'run',
    flow: FLOW_NAME,
    fullSha,
    maxDiffPixelRatio: MAX_DIFF_PIXEL_RATIO,
    capturedCount: captured.length,
    captured,
    ok: captured.length === planned.plannedCount,
    residual_gaps:
      'candidates may exist; visual PASS not claimed without SHA-bound baseline + reviewer receipt + ratio ≤ 0.002',
    NOT_SHIPPABLE: 'capture without compare/baseline proof',
  }
}

function printHelp() {
  console.log(`Usage:
  node qa/e2e/flows/visual-regression-sids.mjs --self-test
  node qa/e2e/flows/visual-regression-sids.mjs --plan
  node qa/e2e/flows/visual-regression-sids.mjs --compare
  node qa/e2e/flows/visual-regression-sids.mjs --run
Env: WEB_BASE, BOARD_ID, HEADED, FULL_SHA, CAIRN_E2E_* (for --run)
Gate: maxDiffPixelRatio=${MAX_DIFF_PIXEL_RATIO}; baselines under qa/e2e/out/baselines/<fullSha>/
`)
}

async function main() {
  if (hasFlag('--help') || hasFlag('-h')) {
    printHelp()
    process.exitCode = 0
    return
  }

  const wantRun = hasFlag('--run')
  const wantPlan = hasFlag('--plan')
  const wantCompare = hasFlag('--compare')
  const wantSelf =
    hasFlag('--self-test') || (!wantRun && !wantPlan && !wantCompare)

  if (wantSelf) {
    const r = selfTest()
    console.log(JSON.stringify(r, null, 2))
    process.exitCode = r.ok ? 0 : 1
    return
  }

  if (wantPlan) {
    const r = runPlan()
    console.log(JSON.stringify(r, null, 2))
    process.exitCode = 0
    return
  }

  if (wantCompare) {
    try {
      const r = runCompare()
      console.log(JSON.stringify(r, null, 2))
      process.exitCode = r.ok ? 0 : 1
    } catch (e) {
      console.error(String(e?.stack || e))
      process.exitCode = 1
    }
    return
  }

  if (wantRun) {
    try {
      const r = await runLive()
      console.log(JSON.stringify(r, null, 2))
      process.exitCode = r.ok ? 0 : 1
    } catch (e) {
      console.error(String(e?.stack || e))
      process.exitCode = 1
    }
  }
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (isMain) {
  main()
}
