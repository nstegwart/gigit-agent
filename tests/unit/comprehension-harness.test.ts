/**
 * Comprehension harness unit suite (LOCAL ONLY).
 * Proves sample coverage, scoring thresholds, owner-decision 100%,
 * zero stale-as-ongoing, and ban on hand-typed PASS.
 * Does NOT claim a staging owner-mode UI session PASS.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'

const ROOT = process.cwd()
const HARNESS = join(ROOT, 'qa/evidence/comprehension-harness.mjs')
const SAMPLE = join(ROOT, 'qa/evidence/comprehension-sample.json')
const FABLE_SUPPLY = join(
  ROOT,
  'qa/evidence/post-staging-fable-supply.example.json',
)
const FABLE_HARNESS = join(ROOT, 'qa/evidence/post-staging-fable-harness.mjs')
const DOC = join(ROOT, 'docs/control-center/POST_STAGING_FABLE_HARNESS.md')

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Harness = {
  SCHEMA_VERSION: string
  SAMPLE_SCHEMA: string
  ANSWER_KEYS: readonly string[]
  REQUIRED_COVERAGE: readonly string[]
  DEFAULT_THRESHOLDS: {
    minCorrectRatio: number
    ownerDecisionRequiredRatio: number
    maxStaleAsOngoing: number
  }
  validateSample: (sample: unknown) => {
    ok: boolean
    missingCoverage: string[]
    itemCount: number
    reasons: string[]
  }
  buildActualsFromExpected: (sample: Record<string, unknown>) => {
    items: Array<Record<string, unknown>>
  }
  scoreComprehension: (
    sample: Record<string, unknown>,
    actuals: Record<string, unknown>,
  ) => {
    verdict: string
    handTypedPassRejected: boolean
    cells: { pass: boolean; ratio: number; total: number; correct: number }
    ownerDecision: { pass: boolean; ratio: number }
    staleAsOngoing: { pass: boolean; count: number }
    failures: Array<{ code: string; itemId?: string }>
    programScored: boolean
  }
  scoreAnswerCell: (
    key: string,
    expected: unknown,
    actual: unknown,
  ) => { ok: boolean; method: string }
  runSelfTest: (opts?: { samplePath?: string }) => {
    ok: boolean
    report: { verdict: string; cases: Record<string, string>; failures: string[] }
  }
  main: (argv?: string[]) => number
  normalizeText: (v: unknown) => string
  tokenJaccard: (a: string, b: string) => number
}

async function loadHarness(): Promise<Harness> {
  return (await import(pathToFileURL(HARNESS).href)) as Harness
}

function loadSample(): Record<string, unknown> {
  return JSON.parse(readFileSync(SAMPLE, 'utf8')) as Record<string, unknown>
}

describe('comprehension harness presence', () => {
  it('ships harness, sample, fable supply example, and doc', () => {
    expect(existsSync(HARNESS)).toBe(true)
    expect(existsSync(SAMPLE)).toBe(true)
    expect(existsSync(FABLE_SUPPLY)).toBe(true)
    expect(existsSync(DOC)).toBe(true)
  })
})

describe('constants + thresholds (01A)', () => {
  it('exports schema, answer keys, required coverage, thresholds', async () => {
    const m = await loadHarness()
    expect(m.SCHEMA_VERSION).toBe('TM_COMPREHENSION_HARNESS_V1')
    expect(m.SAMPLE_SCHEMA).toBe('TM_COMPREHENSION_SAMPLE_V1')
    expect(m.ANSWER_KEYS).toEqual([
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
    expect(m.DEFAULT_THRESHOLDS.minCorrectRatio).toBe(0.9)
    expect(m.DEFAULT_THRESHOLDS.ownerDecisionRequiredRatio).toBe(1.0)
    expect(m.DEFAULT_THRESHOLDS.maxStaleAsOngoing).toBe(0)
    for (const tag of [
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
    ]) {
      expect(m.REQUIRED_COVERAGE).toContain(tag)
    }
  })
})

describe('sample validation (coverage spanning set)', () => {
  it('accepts shipped comprehension-sample.json', async () => {
    const m = await loadHarness()
    const sample = loadSample()
    const v = m.validateSample(sample)
    expect(v.ok).toBe(true)
    expect(v.missingCoverage).toEqual([])
    expect(v.itemCount).toBeGreaterThanOrEqual(8)
  })

  it('rejects incomplete coverage', async () => {
    const m = await loadHarness()
    const sample = loadSample()
    const items = (sample.items as unknown[]).slice(0, 1)
    const v = m.validateSample({ ...sample, items })
    expect(v.ok).toBe(false)
    expect(v.missingCoverage.length).toBeGreaterThan(0)
  })

  it('rejects wrong schema / raw-json mode', async () => {
    const m = await loadHarness()
    const sample = loadSample()
    expect(m.validateSample({ ...sample, schemaVersion: 'nope' }).ok).toBe(false)
    expect(m.validateSample({ ...sample, noRawJson: false }).ok).toBe(false)
    expect(m.validateSample({ ...sample, mode: 'agent' }).ok).toBe(false)
  })
})

describe('scoreAnswerCell matching', () => {
  it('matches exact, containment, status token, and rejects garbage', async () => {
    const m = await loadHarness()
    expect(m.scoreAnswerCell('outcome', 'hello world', 'hello world').ok).toBe(
      true,
    )
    expect(
      m.scoreAnswerCell('outcome', 'hello world', 'prefix hello world suffix').ok,
    ).toBe(true)
    expect(m.scoreAnswerCell('status', 'DONE', 'status is DONE now').ok).toBe(
      true,
    )
    expect(
      m.scoreAnswerCell('outcome', 'expected text', 'totally unrelated zz').ok,
    ).toBe(false)
  })
})

describe('scoreComprehension thresholds', () => {
  it('PASS on perfect actuals derived from expected', async () => {
    const m = await loadHarness()
    const sample = loadSample()
    const actuals = m.buildActualsFromExpected(sample)
    const r = m.scoreComprehension(sample, actuals)
    expect(r.programScored).toBe(true)
    expect(r.verdict).toBe('PASS')
    expect(r.cells.pass).toBe(true)
    expect(r.ownerDecision.pass).toBe(true)
    expect(r.staleAsOngoing.pass).toBe(true)
    expect(r.cells.ratio).toBeGreaterThanOrEqual(0.9)
    expect(r.ownerDecision.ratio).toBe(1)
    expect(r.staleAsOngoing.count).toBe(0)
  })

  it('FAIL when answers are all wrong (cell ratio)', async () => {
    const m = await loadHarness()
    const sample = loadSample()
    const actuals = m.buildActualsFromExpected(sample)
    for (const item of actuals.items) {
      const ans = item.answers as Record<string, unknown>
      for (const k of m.ANSWER_KEYS) ans[k] = 'zzz unrelated noise'
    }
    const r = m.scoreComprehension(sample, actuals)
    expect(r.verdict).toBe('FAIL')
    expect(r.cells.pass).toBe(false)
  })

  it('FAIL when owner-decision identification is wrong (100% gate)', async () => {
    const m = await loadHarness()
    const sample = loadSample()
    const actuals = m.buildActualsFromExpected(sample)
    for (const item of actuals.items) {
      if (item.id === 'cmp-blocked-owner-decision') {
        const ans = item.answers as Record<string, unknown>
        ans.ownerDecision = { isOwnerDecision: false, decisionId: null }
      }
    }
    const r = m.scoreComprehension(sample, actuals)
    expect(r.verdict).toBe('FAIL')
    expect(r.ownerDecision.pass).toBe(false)
    expect(r.failures.some((f) => f.code === 'OWNER_DECISION_MISIDENTIFIED')).toBe(
      true,
    )
  })

  it('FAIL when stale claim is shown as ongoing', async () => {
    const m = await loadHarness()
    const sample = loadSample()
    const actuals = m.buildActualsFromExpected(sample)
    for (const item of actuals.items) {
      if (item.id === 'cmp-recon-stale-lease') {
        const ans = item.answers as Record<string, unknown>
        ans.staleClaimShownAsOngoing = true
      }
    }
    const r = m.scoreComprehension(sample, actuals)
    expect(r.verdict).toBe('FAIL')
    expect(r.staleAsOngoing.pass).toBe(false)
    expect(
      r.failures.some((f) => f.code === 'STALE_CLAIM_SHOWN_AS_ONGOING'),
    ).toBe(true)
  })

  it('rejects hand-typed PASS without program scoring', async () => {
    const m = await loadHarness()
    const sample = loadSample()
    const perfect = m.buildActualsFromExpected(sample)
    const r = m.scoreComprehension(sample, {
      handTypedPass: true,
      items: perfect.items,
    })
    expect(r.verdict).toBe('FAIL')
    expect(r.handTypedPassRejected).toBe(true)
  })

  it('FAIL when actuals are missing', async () => {
    const m = await loadHarness()
    const sample = loadSample()
    const r = m.scoreComprehension(sample, { items: [] })
    expect(r.verdict).toBe('FAIL')
    expect(r.failures.some((f) => f.code === 'MISSING_ACTUAL')).toBe(true)
  })
})

describe('runSelfTest + CLI', () => {
  it('runSelfTest passes against shipped sample', async () => {
    const m = await loadHarness()
    const { ok, report } = m.runSelfTest({ samplePath: SAMPLE })
    expect(ok).toBe(true)
    expect(report.verdict).toBe('PASS')
    expect(report.cases.perfectActuals).toBe('PASS')
    expect(report.cases.wrongAnswers).toBe('FAIL')
    expect(report.cases.missedOwnerDecision).toBe('FAIL')
    expect(report.cases.staleAsOngoing).toBe('FAIL')
    expect(report.cases.handTypedPass).toBe('FAIL')
  })

  it('CLI --self-test exits 0', () => {
    const out = execFileSync(process.execPath, [HARNESS, '--self-test'], {
      encoding: 'utf8',
      cwd: ROOT,
    })
    const parsed = JSON.parse(out) as { verdict: string; mode: string }
    expect(parsed.mode).toBe('self-test')
    expect(parsed.verdict).toBe('PASS')
  })

  it('CLI --validate-sample exits 0', () => {
    const out = execFileSync(
      process.execPath,
      [HARNESS, '--validate-sample', '--sample', SAMPLE],
      { encoding: 'utf8', cwd: ROOT },
    )
    const parsed = JSON.parse(out) as { verdict: string; ok: boolean }
    expect(parsed.ok).toBe(true)
    expect(parsed.verdict).toBe('PASS')
  })
})

describe('post-staging FABLE example supply pack (LOCAL ONLY)', () => {
  it('example supply is complete for assembleEvidenceBundle / pack CLI', async () => {
    expect(existsSync(FABLE_SUPPLY)).toBe(true)
    const fable = await import(pathToFileURL(FABLE_HARNESS).href)
    const supply = JSON.parse(readFileSync(FABLE_SUPPLY, 'utf8')) as Record<
      string,
      unknown
    >
    const pack = fable.assembleEvidenceBundle(supply)
    expect(pack.ok).toBe(true)
    expect(pack.bundleSha256).toMatch(/^[0-9a-f]{64}$/)
    expect(pack.bundle?.supply?.missionEvidenceMap).toBeTruthy()
    for (const q of ['Q1', 'Q2', 'Q3', 'Q4', 'Q5', 'Q6', 'Q7', 'Q8']) {
      expect(pack.bundle.supply.missionEvidenceMap[q]).toBeTruthy()
    }
  })

  it('doc mentions example supply path', () => {
    const body = readFileSync(DOC, 'utf8')
    expect(body).toMatch(/post-staging-fable-supply\.example\.json/)
    expect(body).toMatch(/comprehension/i)
  })
})
