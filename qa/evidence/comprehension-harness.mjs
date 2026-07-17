#!/usr/bin/env node
/**
 * Comprehension acceptance harness (01A §COMPREHENSION ACCEPTANCE; 01B 5-second scan).
 *
 * Predefines a source-grounded sample + expected cited answers, scores actual
 * answers programmatically, and emits a verdict. Does NOT hand-type PASS.
 *
 * Thresholds (spec):
 *   - >= 90% correct on scored answer cells
 *   - 100% owner-decision identification
 *   - zero stale claims shown as ongoing
 *
 * Usage:
 *   node qa/evidence/comprehension-harness.mjs --self-test
 *   node qa/evidence/comprehension-harness.mjs --validate-sample
 *   node qa/evidence/comprehension-harness.mjs --sample <path> --actuals <path>
 *   node qa/evidence/comprehension-harness.mjs --sample <path> --actuals <path> --json
 *   node qa/evidence/comprehension-harness.mjs --help
 *
 * Exit 0 = program PASS (or self-test ok). Exit 1 = FAIL. Exit 2 = usage/load error.
 */

import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

export const REPO_ROOT = resolve(__dirname, '../..')
export const SCHEMA_VERSION = 'TM_COMPREHENSION_HARNESS_V1'
export const SAMPLE_SCHEMA = 'TM_COMPREHENSION_SAMPLE_V1'
export const DEFAULT_SAMPLE_REL = 'qa/evidence/comprehension-sample.json'
export const EVIDENCE_DIR_REL = '.artifact/evidence/comprehension-harness'

/** Answer keys scored under the 90% cell ratio. */
export const ANSWER_KEYS = Object.freeze([
  'outcome',
  'why',
  'status',
  'actorHeartbeat',
  'remainingWork',
  'nextAction',
  'blockerUnblockOwner',
  'ownerAction',
  'readinessDistinction',
  'completionEvidence',
])

/** Coverage tags the sample must include (01A spanning set). */
export const REQUIRED_COVERAGE = Object.freeze([
  'workBucket:DONE',
  'workBucket:ONGOING',
  'workBucket:NEXT',
  'workBucket:QUEUED',
  'workBucket:BLOCKED',
  'workBucket:RECONCILIATION_PENDING',
  'workBucket:HOLD',
  'workBucket:EXCLUDE',
  'priority:P0',
  'priority:non-P0',
  'readiness:mapping',
  'readiness:product',
  'ownerDecision',
  'reconciliation',
  'staleClaimTrap',
])

export const DEFAULT_THRESHOLDS = Object.freeze({
  minCorrectRatio: 0.9,
  ownerDecisionRequiredRatio: 1.0,
  maxStaleAsOngoing: 0,
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * @param {string | Buffer | Uint8Array} data
 * @returns {string}
 */
export function sha256Of(data) {
  return createHash('sha256').update(data).digest('hex')
}

/**
 * @param {string} filePath
 * @returns {unknown}
 */
export function loadJson(filePath) {
  const abs = resolve(filePath)
  if (!existsSync(abs)) {
    throw new Error(`file not found: ${abs}`)
  }
  return JSON.parse(readFileSync(abs, 'utf8'))
}

/**
 * @param {unknown} value
 * @returns {string}
 */
export function normalizeText(value) {
  if (value == null) return ''
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number') return String(value)
  return String(value)
    .toLowerCase()
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N}\s/_+-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Token Jaccard similarity in [0,1].
 * @param {string} a
 * @param {string} b
 */
export function tokenJaccard(a, b) {
  const ta = new Set(normalizeText(a).split(' ').filter(Boolean))
  const tb = new Set(normalizeText(b).split(' ').filter(Boolean))
  if (ta.size === 0 && tb.size === 0) return 1
  if (ta.size === 0 || tb.size === 0) return 0
  let inter = 0
  for (const t of ta) if (tb.has(t)) inter++
  const union = ta.size + tb.size - inter
  return union === 0 ? 0 : inter / union
}

/**
 * Score one free-text answer cell. Status keys also accept exact bucket match.
 * @param {string} key
 * @param {unknown} expectedValue
 * @param {unknown} actualValue
 * @returns {{ ok: boolean, method: string, score: number }}
 */
export function scoreAnswerCell(key, expectedValue, actualValue) {
  const exp = normalizeText(expectedValue)
  const act = normalizeText(actualValue)

  if (exp === '' && act === '') {
    return { ok: true, method: 'both-empty', score: 1 }
  }
  if (exp === '' || act === '') {
    return { ok: false, method: 'one-empty', score: 0 }
  }
  if (exp === act) {
    return { ok: true, method: 'exact', score: 1 }
  }
  // Containment (either direction) for short/long paraphrases.
  if (act.includes(exp) || exp.includes(act)) {
    return { ok: true, method: 'containment', score: 1 }
  }
  // Status bucket: allow bare bucket token when expected mentions it.
  if (key === 'status') {
    const buckets = [
      'done',
      'ongoing',
      'next',
      'queued',
      'blocked',
      'reconciliation_pending',
      'reconciliation',
      'hold',
      'exclude',
    ]
    for (const b of buckets) {
      if (exp.includes(b) && act.includes(b)) {
        return { ok: true, method: 'status-token', score: 1 }
      }
    }
  }
  const j = tokenJaccard(exp, act)
  if (j >= 0.55) {
    return { ok: true, method: 'jaccard', score: j }
  }
  return { ok: false, method: 'mismatch', score: j }
}

/**
 * @param {unknown} sample
 * @returns {{
 *   ok: boolean,
 *   missingCoverage: string[],
 *   missingAnswerKeys: Array<{ id: string, keys: string[] }>,
 *   itemCount: number,
 *   reasons: string[],
 * }}
 */
export function validateSample(sample) {
  const reasons = []
  if (sample == null || typeof sample !== 'object' || Array.isArray(sample)) {
    return {
      ok: false,
      missingCoverage: [...REQUIRED_COVERAGE],
      missingAnswerKeys: [],
      itemCount: 0,
      reasons: ['sample must be a non-null object'],
    }
  }
  const s = /** @type {Record<string, unknown>} */ (sample)
  if (s.schemaVersion !== SAMPLE_SCHEMA) {
    reasons.push(
      `schemaVersion must be ${SAMPLE_SCHEMA}; got ${String(s.schemaVersion)}`,
    )
  }
  if (s.noRawJson !== true) {
    reasons.push('noRawJson must be true (owner mode without raw JSON)')
  }
  if (s.mode !== 'owner') {
    reasons.push(`mode must be "owner"; got ${String(s.mode)}`)
  }
  if (!Array.isArray(s.items) || s.items.length === 0) {
    reasons.push('items must be a non-empty array')
    return {
      ok: false,
      missingCoverage: [...REQUIRED_COVERAGE],
      missingAnswerKeys: [],
      itemCount: 0,
      reasons,
    }
  }

  /** @type {Set<string>} */
  const seen = new Set()
  /** @type {Array<{ id: string, keys: string[] }>} */
  const missingAnswerKeys = []

  for (const raw of s.items) {
    if (raw == null || typeof raw !== 'object') {
      reasons.push('item must be object')
      continue
    }
    const item = /** @type {Record<string, unknown>} */ (raw)
    const id = String(item.id ?? '?')
    if (Array.isArray(item.coverage)) {
      for (const c of item.coverage) seen.add(String(c))
    }
    const exp = item.expectedAnswers
    if (exp == null || typeof exp !== 'object') {
      missingAnswerKeys.push({ id, keys: [...ANSWER_KEYS] })
      reasons.push(`item ${id}: missing expectedAnswers`)
      continue
    }
    const e = /** @type {Record<string, unknown>} */ (exp)
    const miss = []
    for (const k of ANSWER_KEYS) {
      const cell = e[k]
      if (cell == null || typeof cell !== 'object') {
        miss.push(k)
        continue
      }
      const cellObj = /** @type {Record<string, unknown>} */ (cell)
      if (cellObj.value == null || String(cellObj.value).trim() === '') {
        miss.push(k)
      }
      if (!Array.isArray(cellObj.citations) || cellObj.citations.length === 0) {
        reasons.push(`item ${id}: ${k} missing citations`)
      }
    }
    if (e.ownerDecision == null || typeof e.ownerDecision !== 'object') {
      reasons.push(`item ${id}: missing ownerDecision expected`)
    } else {
      const od = /** @type {Record<string, unknown>} */ (e.ownerDecision)
      if (typeof od.isOwnerDecision !== 'boolean') {
        reasons.push(`item ${id}: ownerDecision.isOwnerDecision must be boolean`)
      }
    }
    if (typeof e.staleClaimShownAsOngoing !== 'boolean') {
      reasons.push(`item ${id}: staleClaimShownAsOngoing must be boolean`)
    }
    if (miss.length) missingAnswerKeys.push({ id, keys: miss })
  }

  const missingCoverage = REQUIRED_COVERAGE.filter((c) => !seen.has(c))
  if (missingCoverage.length) {
    reasons.push(`missing coverage: ${missingCoverage.join(', ')}`)
  }
  if (missingAnswerKeys.length) {
    reasons.push(
      `missing answer keys on items: ${missingAnswerKeys.map((m) => m.id).join(', ')}`,
    )
  }

  return {
    ok: reasons.length === 0 && missingCoverage.length === 0 && missingAnswerKeys.length === 0,
    missingCoverage,
    missingAnswerKeys,
    itemCount: s.items.length,
    reasons,
  }
}

/**
 * Build perfect actuals from sample expectedAnswers (for self-test / golden path).
 * @param {Record<string, unknown>} sample
 * @returns {{ items: Array<Record<string, unknown>> }}
 */
export function buildActualsFromExpected(sample) {
  const items = []
  for (const raw of /** @type {Array<Record<string, unknown>>} */ (sample.items ?? [])) {
    const exp = /** @type {Record<string, unknown>} */ (raw.expectedAnswers ?? {})
    /** @type {Record<string, unknown>} */
    const answers = {}
    for (const k of ANSWER_KEYS) {
      const cell = /** @type {Record<string, unknown>} */ (exp[k] ?? {})
      answers[k] = cell.value ?? ''
    }
    const od = /** @type {Record<string, unknown>} */ (exp.ownerDecision ?? {})
    answers.ownerDecision = {
      isOwnerDecision: od.isOwnerDecision === true,
      decisionId: od.decisionId ?? null,
    }
    answers.staleClaimShownAsOngoing = exp.staleClaimShownAsOngoing === true
    items.push({
      id: raw.id,
      answers,
      timingMs: 0,
    })
  }
  return { items }
}

/**
 * Score actual answers against sample expected answers.
 *
 * @param {Record<string, unknown>} sample
 * @param {{ items?: Array<Record<string, unknown>>, handTypedPass?: boolean }} actuals
 * @param {{ now?: () => number }} [opts]
 * @returns {Record<string, unknown>}
 */
export function scoreComprehension(sample, actuals, opts = {}) {
  const started = (opts.now ?? Date.now)()
  const validation = validateSample(sample)
  const thresholds = {
    ...DEFAULT_THRESHOLDS,
    ...(typeof sample.thresholds === 'object' && sample.thresholds
      ? /** @type {Record<string, number>} */ (sample.thresholds)
      : {}),
  }

  if (!validation.ok) {
    return {
      schemaVersion: SCHEMA_VERSION,
      gate: 'COMPREHENSION_ACCEPTANCE',
      verdict: 'FAIL',
      reason: 'sample invalid',
      validation,
      thresholds,
      scoredAt: new Date().toISOString(),
      handTypedPassRejected: false,
      cells: { total: 0, correct: 0, ratio: 0 },
      ownerDecision: { total: 0, correct: 0, ratio: 0 },
      staleAsOngoing: { count: 0, maxAllowed: thresholds.maxStaleAsOngoing },
      failures: [{ code: 'SAMPLE_INVALID', reasons: validation.reasons }],
      repairs: [],
      itemResults: [],
      timingMs: (opts.now ?? Date.now)() - started,
    }
  }

  // Explicit ban: hand-typed PASS without scoring is always FAIL.
  if (actuals && actuals.handTypedPass === true) {
    return {
      schemaVersion: SCHEMA_VERSION,
      gate: 'COMPREHENSION_ACCEPTANCE',
      verdict: 'FAIL',
      reason: 'hand-typed PASS forbidden — answers must be scored programmatically',
      validation,
      thresholds,
      scoredAt: new Date().toISOString(),
      handTypedPassRejected: true,
      cells: { total: 0, correct: 0, ratio: 0 },
      ownerDecision: { total: 0, correct: 0, ratio: 0 },
      staleAsOngoing: { count: 0, maxAllowed: thresholds.maxStaleAsOngoing },
      failures: [{ code: 'HAND_TYPED_PASS_FORBIDDEN' }],
      repairs: ['Provide --actuals JSON with per-item answers; never set handTypedPass'],
      itemResults: [],
      timingMs: (opts.now ?? Date.now)() - started,
    }
  }

  const actualList = Array.isArray(actuals?.items) ? actuals.items : []
  /** @type {Map<string, Record<string, unknown>>} */
  const byId = new Map()
  for (const a of actualList) {
    if (a && typeof a === 'object' && a.id != null) {
      byId.set(String(a.id), /** @type {Record<string, unknown>} */ (a))
    }
  }

  let cellTotal = 0
  let cellCorrect = 0
  let odTotal = 0
  let odCorrect = 0
  let staleAsOngoingCount = 0
  /** @type {Array<Record<string, unknown>>} */
  const failures = []
  /** @type {Array<Record<string, unknown>>} */
  const itemResults = []
  /** @type {string[]} */
  const repairs = []

  for (const raw of /** @type {Array<Record<string, unknown>>} */ (sample.items)) {
    const id = String(raw.id)
    const exp = /** @type {Record<string, unknown>} */ (raw.expectedAnswers)
    const actualItem = byId.get(id)
    const answers = /** @type {Record<string, unknown>} */ (
      actualItem?.answers ?? actualItem ?? {}
    )

    /** @type {Array<Record<string, unknown>>} */
    const cellScores = []
    let itemCellsOk = 0

    for (const k of ANSWER_KEYS) {
      cellTotal++
      const expCell = /** @type {Record<string, unknown>} */ (exp[k] ?? {})
      const expectedValue = expCell.value
      const actualValue = answers[k]
      const scored = scoreAnswerCell(k, expectedValue, actualValue)
      if (scored.ok) {
        cellCorrect++
        itemCellsOk++
      } else {
        failures.push({
          code: 'ANSWER_MISMATCH',
          itemId: id,
          key: k,
          expected: expectedValue,
          actual: actualValue ?? null,
          method: scored.method,
          score: scored.score,
          citations: expCell.citations ?? [],
        })
        repairs.push(
          `Repair item ${id} key ${k}: align UI copy or retrain verifier on cited surface`,
        )
      }
      cellScores.push({
        key: k,
        ok: scored.ok,
        method: scored.method,
        score: scored.score,
        expected: expectedValue,
        actual: actualValue ?? null,
        citations: expCell.citations ?? [],
      })
    }

    // Owner decision identification (hard 100% gate)
    odTotal++
    const expOd = /** @type {Record<string, unknown>} */ (exp.ownerDecision ?? {})
    const expIsOd = expOd.isOwnerDecision === true
    const actOdRaw = answers.ownerDecision
    let actIsOd = false
    let actDecisionId = null
    if (typeof actOdRaw === 'boolean') {
      actIsOd = actOdRaw
    } else if (actOdRaw && typeof actOdRaw === 'object') {
      actIsOd = /** @type {Record<string, unknown>} */ (actOdRaw).isOwnerDecision === true
      actDecisionId = /** @type {Record<string, unknown>} */ (actOdRaw).decisionId ?? null
    } else if (typeof answers.isOwnerDecision === 'boolean') {
      actIsOd = answers.isOwnerDecision === true
      actDecisionId = answers.decisionId ?? null
    }
    const odOk = actIsOd === expIsOd
    // When expected is owner decision, also require decisionId match when both present.
    let decisionIdOk = true
    if (expIsOd && expOd.decisionId != null && actDecisionId != null) {
      decisionIdOk = String(actDecisionId) === String(expOd.decisionId)
    }
    if (odOk && decisionIdOk) {
      odCorrect++
    } else {
      failures.push({
        code: 'OWNER_DECISION_MISIDENTIFIED',
        itemId: id,
        expected: { isOwnerDecision: expIsOd, decisionId: expOd.decisionId ?? null },
        actual: { isOwnerDecision: actIsOd, decisionId: actDecisionId },
      })
      repairs.push(
        `Repair item ${id}: owner-decision identification must be 100% (expected isOwnerDecision=${expIsOd})`,
      )
    }

    // Stale-as-ongoing hard gate
    const expStale = exp.staleClaimShownAsOngoing === true
    const actStale = answers.staleClaimShownAsOngoing === true
    // Spec: zero stale claims shown as ongoing. If actual marks stale-as-ongoing true
    // when expected is false, that is a release-blocking failure.
    if (actStale && !expStale) {
      staleAsOngoingCount++
      failures.push({
        code: 'STALE_CLAIM_SHOWN_AS_ONGOING',
        itemId: id,
        expected: false,
        actual: true,
      })
      repairs.push(
        `Repair item ${id}: demote stale claim/lease to RECONCILIATION — never show as ONGOING`,
      )
    } else if (actStale !== expStale) {
      // expected true is unusual (trap items set expected false); still flag mismatch
      failures.push({
        code: 'STALE_FLAG_MISMATCH',
        itemId: id,
        expected: expStale,
        actual: actStale,
      })
    }

    const missingActual = !actualItem
    if (missingActual) {
      failures.push({ code: 'MISSING_ACTUAL', itemId: id })
      repairs.push(`Provide actual answers for sample item ${id}`)
    }

    itemResults.push({
      id,
      coverage: raw.coverage ?? [],
      cellsCorrect: itemCellsOk,
      cellsTotal: ANSWER_KEYS.length,
      ownerDecisionOk: odOk && decisionIdOk,
      staleAsOngoingViolation: actStale && !expStale,
      missingActual,
      timingMs: typeof actualItem?.timingMs === 'number' ? actualItem.timingMs : null,
      cellScores,
    })
  }

  const cellRatio = cellTotal === 0 ? 0 : cellCorrect / cellTotal
  const odRatio = odTotal === 0 ? 0 : odCorrect / odTotal
  const cellsPass = cellRatio >= thresholds.minCorrectRatio
  const odPass = odRatio >= thresholds.ownerDecisionRequiredRatio
  const stalePass = staleAsOngoingCount <= thresholds.maxStaleAsOngoing
  const verdict = cellsPass && odPass && stalePass ? 'PASS' : 'FAIL'

  return {
    schemaVersion: SCHEMA_VERSION,
    gate: 'COMPREHENSION_ACCEPTANCE',
    verdict,
    reason: verdict === 'PASS'
      ? 'program-scored thresholds met'
      : 'one or more thresholds failed',
    validation,
    thresholds,
    scoredAt: new Date().toISOString(),
    handTypedPassRejected: false,
    sample: {
      path: null,
      itemCount: validation.itemCount,
      schemaVersion: sample.schemaVersion,
      pin: sample.pin ?? null,
    },
    cells: {
      total: cellTotal,
      correct: cellCorrect,
      ratio: Number(cellRatio.toFixed(4)),
      minRequired: thresholds.minCorrectRatio,
      pass: cellsPass,
    },
    ownerDecision: {
      total: odTotal,
      correct: odCorrect,
      ratio: Number(odRatio.toFixed(4)),
      minRequired: thresholds.ownerDecisionRequiredRatio,
      pass: odPass,
    },
    staleAsOngoing: {
      count: staleAsOngoingCount,
      maxAllowed: thresholds.maxStaleAsOngoing,
      pass: stalePass,
    },
    failures,
    repairs: [...new Set(repairs)],
    itemResults,
    timingMs: (opts.now ?? Date.now)() - started,
    // Explicit: never invent PASS outside this function's thresholds.
    programScored: true,
  }
}

/**
 * Write optional evidence JSON under .artifact/.
 * @param {Record<string, unknown>} report
 * @param {{ outDir?: string, outPath?: string }} [opts]
 * @returns {string}
 */
export function writeEvidenceReport(report, opts = {}) {
  if (opts.outPath) {
    const abs = resolve(opts.outPath)
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
    return abs
  }
  const outDir = opts.outDir
    ? resolve(opts.outDir)
    : join(REPO_ROOT, EVIDENCE_DIR_REL)
  mkdirSync(outDir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const path = join(outDir, `comprehension-${stamp}.json`)
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  writeFileSync(
    join(outDir, 'latest.json'),
    `${JSON.stringify(report, null, 2)}\n`,
    'utf8',
  )
  return path
}

/**
 * Built-in self-test: sample coverage, perfect PASS, imperfect FAIL, gates.
 * @param {{ samplePath?: string }} [opts]
 * @returns {{ ok: boolean, report: Record<string, unknown> }}
 */
export function runSelfTest(opts = {}) {
  const samplePath = resolve(opts.samplePath ?? join(REPO_ROOT, DEFAULT_SAMPLE_REL))
  /** @type {string[]} */
  const failures = []
  /** @type {Record<string, unknown>} */
  const cases = {}

  let sample
  try {
    sample = /** @type {Record<string, unknown>} */ (loadJson(samplePath))
  } catch (err) {
    return {
      ok: false,
      report: {
        schemaVersion: SCHEMA_VERSION,
        mode: 'self-test',
        verdict: 'FAIL',
        failures: [`load sample: ${String(/** @type {Error} */ (err).message ?? err)}`],
        cases: {},
      },
    }
  }

  const v = validateSample(sample)
  cases.validateSample = v.ok ? 'PASS' : 'FAIL'
  if (!v.ok) failures.push(`validateSample: ${v.reasons.join('; ')}`)

  const perfect = buildActualsFromExpected(sample)
  const rPerfect = scoreComprehension(sample, perfect)
  cases.perfectActuals = rPerfect.verdict
  if (rPerfect.verdict !== 'PASS') {
    failures.push(`perfectActuals expected PASS, got ${rPerfect.verdict}`)
  }
  if (rPerfect.handTypedPassRejected) {
    failures.push('perfectActuals unexpectedly rejected hand-typed pass')
  }

  // Wrong answers → cell ratio collapse → FAIL
  const wrong = buildActualsFromExpected(sample)
  for (const item of wrong.items) {
    const ans = /** @type {Record<string, unknown>} */ (item.answers)
    for (const k of ANSWER_KEYS) {
      ans[k] = 'jawaban salah sama sekali tidak relevan xyz'
    }
  }
  const rWrong = scoreComprehension(sample, wrong)
  cases.wrongAnswers = rWrong.verdict
  if (rWrong.verdict !== 'FAIL') {
    failures.push(`wrongAnswers expected FAIL, got ${rWrong.verdict}`)
  }
  if (/** @type {{ pass?: boolean }} */ (rWrong.cells).pass !== false) {
    failures.push('wrongAnswers should fail cells threshold')
  }

  // Miss owner decision on the known owner-decision item → FAIL even if cells perfect
  const missOd = buildActualsFromExpected(sample)
  for (const item of missOd.items) {
    if (item.id === 'cmp-blocked-owner-decision') {
      const ans = /** @type {Record<string, unknown>} */ (item.answers)
      ans.ownerDecision = { isOwnerDecision: false, decisionId: null }
    }
  }
  const rMissOd = scoreComprehension(sample, missOd)
  cases.missedOwnerDecision = rMissOd.verdict
  if (rMissOd.verdict !== 'FAIL') {
    failures.push(`missedOwnerDecision expected FAIL, got ${rMissOd.verdict}`)
  }
  if (/** @type {{ pass?: boolean }} */ (rMissOd.ownerDecision).pass !== false) {
    failures.push('missedOwnerDecision should fail ownerDecision threshold')
  }

  // Stale claim shown as ongoing → FAIL
  const stale = buildActualsFromExpected(sample)
  for (const item of stale.items) {
    if (item.id === 'cmp-recon-stale-lease') {
      const ans = /** @type {Record<string, unknown>} */ (item.answers)
      ans.staleClaimShownAsOngoing = true
    }
  }
  const rStale = scoreComprehension(sample, stale)
  cases.staleAsOngoing = rStale.verdict
  if (rStale.verdict !== 'FAIL') {
    failures.push(`staleAsOngoing expected FAIL, got ${rStale.verdict}`)
  }
  if (/** @type {{ pass?: boolean }} */ (rStale.staleAsOngoing).pass !== false) {
    failures.push('staleAsOngoing should fail stale gate')
  }

  // Hand-typed PASS forbidden
  const rHand = scoreComprehension(sample, { handTypedPass: true, items: perfect.items })
  cases.handTypedPass = rHand.verdict
  if (rHand.verdict !== 'FAIL' || !rHand.handTypedPassRejected) {
    failures.push('handTypedPass must be rejected with FAIL')
  }

  // Incomplete sample coverage → validate fails
  const incomplete = {
    ...sample,
    items: (/** @type {unknown[]} */ (sample.items)).slice(0, 2),
  }
  const vInc = validateSample(incomplete)
  cases.incompleteCoverage = vInc.ok ? 'FAIL_UNEXPECTED' : 'PASS'
  if (vInc.ok) failures.push('incomplete sample should fail validateSample')
  if (!vInc.missingCoverage.length) {
    failures.push('incomplete sample should report missingCoverage')
  }

  // Missing actuals entirely → FAIL
  const rMissing = scoreComprehension(sample, { items: [] })
  cases.missingActuals = rMissing.verdict
  if (rMissing.verdict !== 'FAIL') {
    failures.push(`missingActuals expected FAIL, got ${rMissing.verdict}`)
  }

  const sampleBody = readFileSync(samplePath, 'utf8')
  const report = {
    schemaVersion: SCHEMA_VERSION,
    mode: 'self-test',
    samplePath,
    sampleSha256: sha256Of(sampleBody),
    nonMutating: true,
    verdict: failures.length ? 'FAIL' : 'PASS',
    failures,
    cases,
    thresholds: DEFAULT_THRESHOLDS,
    note: 'Self-test proves scoring + gates. Not a staging owner-mode UI session PASS.',
  }

  return { ok: failures.length === 0, report }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

/**
 * @param {string[]} [argv]
 * @returns {number}
 */
export function main(argv = process.argv.slice(2)) {
  if (argv.includes('-h') || argv.includes('--help')) {
    process.stdout.write(
      [
        'Usage: node qa/evidence/comprehension-harness.mjs [options]',
        '',
        '  --self-test                 Built-in positive/negative scoring checks',
        '  --validate-sample           Validate sample coverage + expected answers',
        '  --sample <path>             Sample JSON (default: qa/evidence/comprehension-sample.json)',
        '  --actuals <path>            Actual answers JSON ({ items: [...] })',
        '  --json                      Always print full JSON report',
        '  --write-evidence            Write report under .artifact/evidence/comprehension-harness/',
        '  --out <path>                Write report to exact path',
        '  --help                      This help',
        '',
        'Spec: 01A COMPREHENSION ACCEPTANCE — program-scored only; no hand-typed PASS.',
        'Thresholds: >=90% cells, 100% owner-decision ID, zero stale-as-ongoing.',
        '',
      ].join('\n'),
    )
    return 0
  }

  const sampleIdx = argv.indexOf('--sample')
  const samplePath = resolve(
    sampleIdx >= 0 && argv[sampleIdx + 1]
      ? argv[sampleIdx + 1]
      : join(REPO_ROOT, DEFAULT_SAMPLE_REL),
  )

  if (argv.includes('--self-test')) {
    const { ok, report } = runSelfTest({ samplePath })
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
    if (argv.includes('--write-evidence') || argv.includes('--out')) {
      const outIdx = argv.indexOf('--out')
      writeEvidenceReport(report, {
        outPath: outIdx >= 0 ? argv[outIdx + 1] : undefined,
      })
    }
    return ok ? 0 : 1
  }

  let sample
  try {
    sample = /** @type {Record<string, unknown>} */ (loadJson(samplePath))
  } catch (err) {
    process.stderr.write(`load sample failed: ${String(/** @type {Error} */ (err).message ?? err)}\n`)
    return 2
  }

  if (argv.includes('--validate-sample')) {
    const v = validateSample(sample)
    const report = {
      schemaVersion: SCHEMA_VERSION,
      mode: 'validate-sample',
      samplePath,
      sampleSha256: sha256Of(readFileSync(samplePath)),
      ...v,
      verdict: v.ok ? 'PASS' : 'FAIL',
    }
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
    return v.ok ? 0 : 1
  }

  const actualsIdx = argv.indexOf('--actuals')
  if (actualsIdx < 0 || !argv[actualsIdx + 1]) {
    process.stderr.write(
      'error: --actuals <path> required (or use --self-test / --validate-sample)\n',
    )
    return 2
  }

  let actuals
  try {
    actuals = /** @type {Record<string, unknown>} */ (loadJson(argv[actualsIdx + 1]))
  } catch (err) {
    process.stderr.write(`load actuals failed: ${String(/** @type {Error} */ (err).message ?? err)}\n`)
    return 2
  }

  const report = scoreComprehension(sample, actuals)
  report.sample = {
    ...(typeof report.sample === 'object' && report.sample ? report.sample : {}),
    path: samplePath,
    sha256: sha256Of(readFileSync(samplePath)),
  }

  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)

  if (argv.includes('--write-evidence') || argv.includes('--out')) {
    const outIdx = argv.indexOf('--out')
    writeEvidenceReport(report, {
      outPath: outIdx >= 0 ? argv[outIdx + 1] : undefined,
    })
  }

  return report.verdict === 'PASS' ? 0 : 1
}

const isMain =
  process.argv[1] &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1])

if (isMain) {
  process.exit(main())
}

export default {
  SCHEMA_VERSION,
  SAMPLE_SCHEMA,
  ANSWER_KEYS,
  REQUIRED_COVERAGE,
  DEFAULT_THRESHOLDS,
  DEFAULT_SAMPLE_REL,
  sha256Of,
  loadJson,
  normalizeText,
  tokenJaccard,
  scoreAnswerCell,
  validateSample,
  buildActualsFromExpected,
  scoreComprehension,
  writeEvidenceReport,
  runSelfTest,
  main,
}
