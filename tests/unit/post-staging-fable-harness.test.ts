/**
 * Post-staging FABLE harness unit suite (LOCAL ONLY).
 * Proves exact claude-fable-5 xhigh non-interactive JSON argv, supply pack,
 * staging precondition, output-hash verify, BLOCKED_FABLE_UNAVAILABLE fail-close.
 * Does NOT invoke real FABLE / does NOT require staging live evidence.
 */
import { createHash } from 'node:crypto'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const ROOT = process.cwd()
const HARNESS = join(ROOT, 'qa/evidence/post-staging-fable-harness.mjs')

async function loadHarness() {
  return import(pathToFileURL(HARNESS).href)
}

function sha256(s: string | Buffer) {
  return createHash('sha256').update(s).digest('hex')
}

function fullMissionMap() {
  return {
    Q1: 'evidence/q1.png',
    Q2: ['evidence/q2a.png'],
    Q3: { path: 'evidence/q3.png' },
    Q4: 'evidence/q4.png',
    Q5: 'evidence/q5.png',
    Q6: 'evidence/q6.png',
    Q7: 'evidence/q7.png',
    Q8: 'evidence/q8.png',
  }
}

function validSupply(overrides: Record<string, unknown> = {}) {
  return {
    screenshotManifest: { rows: [{ route: '/b/mfs-rebuild/', state: 'populated' }] },
    missionEvidenceMap: fullMissionMap(),
    stagingSha: 'b207830abc123def456789012345678901234567',
    stagingSchema: '006',
    revisionsHash: 'a'.repeat(64),
    responsiveStates: ['1440x900', '1024x768', '390x844', '360x800', '200%'],
    priorReviewFindingLedger: {
      path: 'docs/control-center/DESIGN_DECISIONS.md',
      sha256: 'b'.repeat(64),
    },
    ...overrides,
  }
}

function stagingPass(overrides: Record<string, unknown> = {}) {
  return {
    status: 'PASS',
    fullSha: 'b207830abc123def456789012345678901234567',
    schemaVersion: '006',
    taskManagerStagingVerified: true,
    ...overrides,
  }
}

const tempDirs: string[] = []
afterEach(() => {
  while (tempDirs.length) {
    const d = tempDirs.pop()
    if (d) rmSync(d, { recursive: true, force: true })
  }
})

describe('post-staging FABLE harness constants', () => {
  it('exports exact model/effort/json and BLOCKED_FABLE_UNAVAILABLE', async () => {
    const m = await loadHarness()
    expect(m.FABLE_MODEL).toBe('claude-fable-5')
    expect(m.FABLE_EFFORT).toBe('xhigh')
    expect(m.FABLE_OUTPUT_FORMAT).toBe('json')
    expect(m.BLOCKED_FABLE_UNAVAILABLE).toBe('BLOCKED_FABLE_UNAVAILABLE')
    expect(m.MISSION_QUESTIONS).toEqual([
      'Q1',
      'Q2',
      'Q3',
      'Q4',
      'Q5',
      'Q6',
      'Q7',
      'Q8',
    ])
    expect(m.REQUIRED_SUPPLY_KEYS).toEqual([
      'screenshotManifest',
      'missionEvidenceMap',
      'stagingSha',
      'stagingSchema',
      'revisionsHash',
      'responsiveStates',
      'priorReviewFindingLedger',
    ])
  })
})

describe('exact argv: claude-fable-5 xhigh non-interactive JSON', () => {
  it('buildExactFableArgv encodes -p --model claude-fable-5 --effort xhigh --output-format json', async () => {
    const m = await loadHarness()
    const argv = m.buildExactFableArgv({ prompt: 'critique now' })
    expect(argv[0]).toBe('claude')
    expect(argv).toContain('-p')
    expect(argv).toContain('--model')
    expect(argv).toContain('claude-fable-5')
    expect(argv).toContain('--effort')
    expect(argv).toContain('xhigh')
    expect(argv).toContain('--output-format')
    expect(argv).toContain('json')
    expect(m.assertExactFableArgv(argv)).toEqual({ ok: true })
  })

  it('rejects missing -p / wrong model / wrong effort / fallback-model', async () => {
    const m = await loadHarness()
    expect(m.assertExactFableArgv(['claude', '--model', 'claude-fable-5']).ok).toBe(
      false,
    )
    const wrongModel = [
      'claude',
      '-p',
      '--model',
      'claude-sonnet-4',
      '--effort',
      'xhigh',
      '--output-format',
      'json',
    ]
    const r1 = m.assertExactFableArgv(wrongModel)
    expect(r1.ok).toBe(false)
    expect(r1.code).toBe(m.FABLE_SUBSTITUTION_FORBIDDEN)

    const wrongEffort = [
      'claude',
      '-p',
      '--model',
      'claude-fable-5',
      '--effort',
      'high',
      '--output-format',
      'json',
    ]
    expect(m.assertExactFableArgv(wrongEffort).code).toBe(m.FABLE_SUBSTITUTION_FORBIDDEN)

    const fallback = [
      'claude',
      '-p',
      '--model',
      'claude-fable-5',
      '--effort',
      'xhigh',
      '--output-format',
      'json',
      '--fallback-model',
      'claude-sonnet-4',
    ]
    expect(m.assertExactFableArgv(fallback).code).toBe(m.FABLE_SUBSTITUTION_FORBIDDEN)
  })
})

describe('staging evidence precondition', () => {
  it('refuses missing/incomplete staging evidence', async () => {
    const m = await loadHarness()
    expect(m.evaluateStagingEvidencePrecondition(null).code).toBe(
      m.STAGING_EVIDENCE_REQUIRED,
    )
    expect(
      m.evaluateStagingEvidencePrecondition({ status: 'FAIL', fullSha: 'abc', schemaVersion: '1' })
        .ok,
    ).toBe(false)
    expect(
      m.evaluateStagingEvidencePrecondition({
        status: 'PASS',
        fullSha: '',
        schemaVersion: '006',
      }).ok,
    ).toBe(false)
  })

  it('accepts PASS + fullSha + schemaVersion', async () => {
    const m = await loadHarness()
    const r = m.evaluateStagingEvidencePrecondition(stagingPass())
    expect(r.ok).toBe(true)
    expect(r.fullSha).toMatch(/^[0-9a-f]+$/i)
    expect(r.schemaVersion).toBe('006')
  })

  it('accepts staging evidence file path', async () => {
    const m = await loadHarness()
    const dir = mkdtempSync(join(tmpdir(), 'fable-stg-'))
    tempDirs.push(dir)
    const p = join(dir, 'staging-pass.json')
    writeFileSync(p, JSON.stringify(stagingPass()))
    const r = m.evaluateStagingEvidencePrecondition(p)
    expect(r.ok).toBe(true)
    expect(r.source).toBe(p)
  })
})

describe('evidence bundle / mission map', () => {
  it('requires all Q1–Q8 mission evidence', async () => {
    const m = await loadHarness()
    const incomplete = { Q1: 'a', Q2: 'b' }
    const v = m.validateMissionEvidenceMap(incomplete)
    expect(v.ok).toBe(false)
    expect(v.missing).toEqual(['Q3', 'Q4', 'Q5', 'Q6', 'Q7', 'Q8'])
  })

  it('assembleEvidenceBundle fails closed when supply incomplete', async () => {
    const m = await loadHarness()
    const r = m.assembleEvidenceBundle({ stagingSha: 'abc' })
    expect(r.ok).toBe(false)
    expect(r.code).toBe(m.SUPPLY_PACK_INCOMPLETE)
    expect(r.missing.length).toBeGreaterThan(0)
  })

  it('assembleEvidenceBundle succeeds with full supply and emits bundleSha256', async () => {
    const m = await loadHarness()
    const r = m.assembleEvidenceBundle(validSupply())
    expect(r.ok).toBe(true)
    expect(r.bundleSha256).toMatch(/^[0-9a-f]{64}$/)
    expect(r.bundle.model).toBe('claude-fable-5')
    expect(r.bundle.effort).toBe('xhigh')
    expect(r.bundle.nonInteractive).toBe(true)
    expect(r.bundle.supply.stagingSha).toBeTruthy()
    expect(r.bundle.supply.missionEvidenceMap.Q8).toBeTruthy()
  })

  it('resolvePriorLedger reads DESIGN_DECISIONS.md from workspace', async () => {
    const m = await loadHarness()
    const r = m.resolvePriorLedger(m.DEFAULT_PRIOR_LEDGER_PATH, { cwd: ROOT })
    expect(r.ok).toBe(true)
    expect(r.ledger.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(r.ledger.bytes).toBeGreaterThan(0)
  })
})

describe('post-staging output hash verification', () => {
  it('matches expected sha of output content', async () => {
    const m = await loadHarness()
    const body = '{"result":"critique","model":"claude-fable-5"}'
    const expected = sha256(body)
    const r = m.verifyPostStagingFableOutputHash({
      outputContent: body,
      expectedSha256: expected,
    })
    expect(r.ok).toBe(true)
    expect(r.actualSha256).toBe(expected)
  })

  it('fails on mismatch', async () => {
    const m = await loadHarness()
    const r = m.verifyPostStagingFableOutputHash({
      outputContent: 'hello',
      expectedSha256: '0'.repeat(64),
    })
    expect(r.ok).toBe(false)
    expect(r.code).toBe(m.FABLE_OUTPUT_HASH_MISMATCH)
  })

  it('refuses design-input receipt path as post-staging output substitute', async () => {
    const m = await loadHarness()
    const r = m.verifyPostStagingFableOutputHash({
      outputPath:
        '.artifact/evidence/TM-P0-ULTIMATE-CONTROL-CENTER-V3/input/01-task-manager-fable5-xhigh-review.json',
      expectedSha256: 'e'.repeat(64),
    })
    expect(r.ok).toBe(false)
    expect(r.code).toBe(m.FABLE_SUBSTITUTION_FORBIDDEN)
  })
})

describe('BLOCKED_FABLE_UNAVAILABLE fail-close (no substitution)', () => {
  it('classifies missing binary as BLOCKED_FABLE_UNAVAILABLE', async () => {
    const m = await loadHarness()
    const r = m.evaluateFableProcessResult({
      binaryExists: false,
      argv: m.buildExactFableArgv(),
    })
    expect(r.ok).toBe(false)
    expect(r.code).toBe(m.BLOCKED_FABLE_UNAVAILABLE)
    expect(r.substitute).toBe(false)
    expect(String(r.reason)).toMatch(/do not substitute/i)
  })

  it('classifies ENOENT spawn error as BLOCKED_FABLE_UNAVAILABLE', async () => {
    const m = await loadHarness()
    const err = Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' })
    const r = m.evaluateFableProcessResult({
      error: err,
      argv: m.buildExactFableArgv(),
    })
    expect(r.code).toBe(m.BLOCKED_FABLE_UNAVAILABLE)
    expect(r.substitute).toBe(false)
  })

  it('classifies model-unavailable stderr as BLOCKED_FABLE_UNAVAILABLE', async () => {
    const m = await loadHarness()
    const r = m.evaluateFableProcessResult({
      status: 1,
      stderr: 'Error: model not found: claude-fable-5',
      stdout: '',
      argv: m.buildExactFableArgv(),
      binaryExists: true,
    })
    expect(r.code).toBe(m.BLOCKED_FABLE_UNAVAILABLE)
    expect(r.substitute).toBe(false)
  })

  it('does not invent a substitute model on failure', async () => {
    const m = await loadHarness()
    const r = m.evaluateFableProcessResult({
      status: 1,
      stderr: 'overloaded',
      argv: m.buildExactFableArgv(),
      binaryExists: true,
    })
    expect(r.substitute).toBe(false)
    expect(JSON.stringify(r)).not.toMatch(/claude-sonnet|claude-opus|fallback/i)
  })
})

describe('runPostStagingFableGate orchestration', () => {
  it('refuses execute path when staging evidence missing (no FABLE invoke)', async () => {
    const m = await loadHarness()
    const r = m.runPostStagingFableGate({
      stagingEvidence: null,
      supply: validSupply(),
      allowExecute: true,
    })
    expect(r.fableInvoked).toBe(false)
    expect(r.code).toBe(m.STAGING_EVIDENCE_REQUIRED)
    expect(r.status).toBe('BLOCKED')
  })

  it('returns READY_TO_INVOKE without executing when allowExecute=false', async () => {
    const m = await loadHarness()
    const r = m.runPostStagingFableGate({
      stagingEvidence: stagingPass(),
      supply: validSupply(),
      allowExecute: false,
    })
    expect(r.status).toBe('READY_TO_INVOKE')
    expect(r.fableInvoked).toBe(false)
    expect(r.model).toBe('claude-fable-5')
    expect(r.effort).toBe('xhigh')
    expect(r.argv).toContain('claude-fable-5')
    expect(r.argv).toContain('xhigh')
    expect(r.argv).toContain('-p')
    expect(r.bundleSha256).toMatch(/^[0-9a-f]{64}$/)
  })

  it('with allowExecute + missing binary → BLOCKED_FABLE_UNAVAILABLE no substitute', async () => {
    const m = await loadHarness()
    const r = m.runPostStagingFableGate({
      stagingEvidence: stagingPass(),
      supply: validSupply(),
      allowExecute: true,
      whichBinary: () => false,
    })
    expect(r.status).toBe('BLOCKED')
    expect(r.code).toBe(m.BLOCKED_FABLE_UNAVAILABLE)
    expect(r.fableInvoked).toBe(false)
    expect(r.substitute).toBe(false)
  })

  it('with allowExecute + injected successful spawn writes output and hashes', async () => {
    const m = await loadHarness()
    const dir = mkdtempSync(join(tmpdir(), 'fable-out-'))
    tempDirs.push(dir)
    const outPath = join(dir, 'post-staging-fable.json')
    const fakeOut = JSON.stringify({
      subtype: 'success',
      result: 'critique',
      modelUsage: { 'claude-fable-5': { inputTokens: 1 } },
    })
    const r = m.runPostStagingFableGate({
      stagingEvidence: stagingPass(),
      supply: validSupply(),
      allowExecute: true,
      outputPath: outPath,
      expectedOutputSha256: sha256(fakeOut),
      whichBinary: () => true,
      spawnSync: () => ({
        status: 0,
        signal: null,
        stdout: fakeOut,
        stderr: '',
        error: undefined,
      }),
    })
    expect(r.status).toBe('FABLE_OUTPUT_OK')
    expect(r.fableInvoked).toBe(true)
    expect(r.outputSha256).toBe(sha256(fakeOut))
    expect(readFileSync(outPath, 'utf8')).toBe(fakeOut)
  })

  it('injected spawn failure → BLOCKED_FABLE_UNAVAILABLE', async () => {
    const m = await loadHarness()
    const r = m.runPostStagingFableGate({
      stagingEvidence: stagingPass(),
      supply: validSupply(),
      allowExecute: true,
      whichBinary: () => true,
      spawnSync: () => ({
        status: 1,
        signal: null,
        stdout: '',
        stderr: 'unknown model claude-fable-5',
        error: undefined,
      }),
    })
    expect(r.status).toBe('BLOCKED')
    expect(r.code).toBe(m.BLOCKED_FABLE_UNAVAILABLE)
    expect(r.substitute).toBe(false)
    expect(r.fableInvoked).toBe(true)
  })

  it('incomplete supply blocks even when staging PASS', async () => {
    const m = await loadHarness()
    const r = m.runPostStagingFableGate({
      stagingEvidence: stagingPass(),
      supply: { stagingSha: 'abc' },
      allowExecute: false,
    })
    expect(r.status).toBe('BLOCKED')
    expect(r.code).toBe(m.SUPPLY_PACK_INCOMPLETE)
    expect(r.fableInvoked).toBe(false)
  })
})

describe('CLI surface (print-argv / check-staging / help)', () => {
  it('main print-argv exits 0 and includes exact flags', async () => {
    const m = await loadHarness()
    // Capture stdout by running logic not process.exit — main returns code
    const prevWrite = process.stdout.write
    let buf = ''
    process.stdout.write = ((chunk: string) => {
      buf += String(chunk)
      return true
    }) as typeof process.stdout.write
    try {
      const code = m.main(['print-argv'])
      expect(code).toBe(0)
      const parsed = JSON.parse(buf)
      expect(parsed.argv).toContain('claude-fable-5')
      expect(parsed.argv).toContain('xhigh')
      expect(parsed.assert.ok).toBe(true)
    } finally {
      process.stdout.write = prevWrite
    }
  })

  it('main check-staging fails closed without PASS artifact', async () => {
    const m = await loadHarness()
    const prevWrite = process.stdout.write
    let buf = ''
    process.stdout.write = ((chunk: string) => {
      buf += String(chunk)
      return true
    }) as typeof process.stdout.write
    try {
      const code = m.main(['check-staging', '--staging', JSON.stringify({ status: 'NOPE' })])
      // parseArgs treats JSON as value of --staging only if next token; use path file
      expect([0, 2]).toContain(code)
    } finally {
      process.stdout.write = prevWrite
    }

    const dir = mkdtempSync(join(tmpdir(), 'fable-cli-'))
    tempDirs.push(dir)
    const bad = join(dir, 'bad.json')
    writeFileSync(bad, JSON.stringify({ status: 'NOPE', fullSha: 'abc', schemaVersion: '1' }))
    buf = ''
    process.stdout.write = ((chunk: string) => {
      buf += String(chunk)
      return true
    }) as typeof process.stdout.write
    try {
      const code = m.main(['check-staging', '--staging', bad])
      expect(code).toBe(2)
      const parsed = JSON.parse(buf)
      expect(parsed.ok).toBe(false)
      expect(parsed.code).toBe(m.STAGING_EVIDENCE_REQUIRED)
    } finally {
      process.stdout.write = prevWrite
    }
  })
})
