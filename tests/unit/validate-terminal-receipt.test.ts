/**
 * Dedicated unit tests for TM-P0 terminal receipt/schema validator.
 * Non-mutating: uses in-memory bodies + temp files only.
 * Does NOT create the real terminal PASS receipt.
 */
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const ROOT = process.cwd()
const SCRIPT = join(ROOT, 'qa/evidence/validate-terminal-receipt.mjs')

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Mod = {
  SCHEMA_VERSION: string
  EXACT_TERMINAL_RECEIPT_REL: string
  REQUIRED_FIELDS: ReadonlyArray<{ id: string; patterns: RegExp[] }>
  STAGING_GATE: string
  LIVE_AWAITING: string
  STAGING_MACHINE_PAYLOAD_BEGIN: string
  STAGING_MACHINE_PAYLOAD_END: string
  CANONICAL_STAGING_MACHINE_RECORD: string
  normalizeStagingMachinePayload: (payload: string) => string
  extractStagingMachinePayloads: (body: string) => Array<{
    payload: string
    normalized: string
    valid: boolean
  }>
  sha256Hex: (data: string | Buffer) => string
  extractStatus: (body: string) => string | null
  claimsStagingVerifiedPass: (body: string, status: string | null) => boolean
  extractReleaseSha: (body: string) => {
    values: string[]
    validValues: string[]
    releaseSha: string | null
  }
  extractHashBoundPointers: (
    body: string,
  ) => Array<{ path: string; sha256: string; line: number }>
  extractClaimAudit: (body: string) => {
    mentioned: boolean
    hasProgramOutput: boolean
    hasSelfTest: boolean
    paths: string[]
  }
  extractIndependentVerifier: (body: string) => {
    mentioned: boolean
    paths: string[]
    models: string[]
  }
  checkNoProdSecretWorktree: (body: string) => {
    ok: boolean
    missing: string[]
  }
  checkRequiredFields: (body: string) => Array<{ id: string; present: boolean }>
  extractTerminalContract: (body: string) => {
    runIds: string[]
    runIdValid: boolean
    finalStatuses: string[]
    residual: string | null
    uncertainty: boolean
    evidenceSection: boolean
    commandEvidence: boolean
    exitCodeEvidence: boolean
    filesSection: boolean
    filesEvidence: boolean
    endExact: boolean
    manualPassHits: string[]
  }
  buildFixtureReceipt: (opts?: Record<string, unknown>) => string
  validateTerminalReceipt: (opts?: Record<string, unknown>) => {
    verdict: 'PASS' | 'FAIL'
    errors: string[]
    warnings: string[]
    status: string | null
    claimsStagingPass: boolean
    releaseSha: string | null
    expectedReleaseSha: string | null
    releaseShaMatchesExpected: boolean | null
    nonMutating: boolean
    doesNotEmitTerminalPassReceipt: boolean
    exactTerminalReceiptRel: string
    checks: Record<string, unknown>
    fields: Array<{ id: string; present: boolean }>
    terminalContract: { endExact: boolean; manualPassHits: string[] }
  }
  main: (argv?: string[], env?: { root?: string }) => number
  runSelfTest: (root: string) => number
}

async function loadMod(): Promise<Mod> {
  return (await import(pathToFileURL(SCRIPT).href)) as Mod
}

const tempDirs: string[] = []

afterEach(() => {
  while (tempDirs.length) {
    const d = tempDirs.pop()
    if (d) {
      try {
        rmSync(d, { recursive: true, force: true })
      } catch {
        /* ignore */
      }
    }
  }
})

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'vtr-test-'))
  tempDirs.push(d)
  return d
}

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex')
}

describe('qa/evidence/validate-terminal-receipt.mjs', () => {
  it('exports schema constants and exact receipt path from TM-P0 spec', async () => {
    const mod = await loadMod()
    expect(mod.SCHEMA_VERSION).toBe('TM_P0_TERMINAL_RECEIPT_SCHEMA_V1')
    expect(mod.EXACT_TERMINAL_RECEIPT_REL).toBe(
      '.artifact/evidence/TM-P0-ULTIMATE-CONTROL-CENTER-V3/WORKER_RESULT_TM_P0_ULTIMATE_CONTROL_CENTER_V3.md',
    )
    expect(mod.STAGING_GATE).toBe('TASK_MANAGER_STAGING_VERIFIED')
    expect(mod.LIVE_AWAITING).toBe(
      'AWAITING_PRODUCTION_APPROVAL_DEPLOY_READBACK',
    )
    expect(mod.REQUIRED_FIELDS.length).toBeGreaterThanOrEqual(20)
  })

  it('rejects missing exact terminal receipt path (PATH_MISSING)', async () => {
    const mod = await loadMod()
    const dir = tmp()
    const report = mod.validateTerminalReceipt({
      root: dir,
      requireFileExists: true,
      allowNonCanonicalPath: false,
    })
    expect(report.verdict).toBe('FAIL')
    expect(report.errors).toEqual(expect.arrayContaining(['PATH_MISSING']))
    expect(report.nonMutating).toBe(true)
    expect(report.doesNotEmitTerminalPassReceipt).toBe(true)
  })

  it('rejects non-canonical receipt path unless allowed', async () => {
    const mod = await loadMod()
    const dir = tmp()
    const body = mod.buildFixtureReceipt()
    const other = join(dir, 'other-receipt.md')
    writeFileSync(other, body)
    const denied = mod.validateTerminalReceipt({
      root: dir,
      receiptPath: other,
      allowNonCanonicalPath: false,
    })
    expect(denied.errors).toContain('PATH_NOT_EXACT')

    const allowed = mod.validateTerminalReceipt({
      root: dir,
      receiptPath: other,
      allowNonCanonicalPath: true,
    })
    expect(allowed.errors).not.toContain('PATH_NOT_EXACT')
  })

  it('accepts complete LOCAL ONLY fixture (not a live PASS claim)', async () => {
    const mod = await loadMod()
    const dir = tmp()
    const blob = join(dir, 'fixture-evidence.json')
    writeFileSync(blob, '{"ok":1}')
    const body = mod.buildFixtureReceipt({
      status: 'LOCAL ONLY',
      claimStagingPass: false,
      pointers: [{ path: blob, sha256: sha256('{"ok":1}') }],
    })
    const report = mod.validateTerminalReceipt({
      root: ROOT,
      body,
      allowNonCanonicalPath: true,
      requireFileExists: false,
    })
    expect(report.verdict).toBe('PASS')
    expect(report.status).toBe('LOCAL ONLY')
    expect(report.claimsStagingPass).toBe(false)
    expect(report.checks.terminal_contract).toMatchObject({ ok: true })
  })

  it('enforces exact run_id, final_status, residual_gaps, uncertainty, evidence, files, and end marker', async () => {
    const mod = await loadMod()
    const good = mod.buildFixtureReceipt()
    expect(mod.extractTerminalContract(good)).toMatchObject({
      runIds: ['fixture-validate-terminal-receipt'],
      finalStatuses: ['LOCAL ONLY'],
      residual: 'fixture only',
      uncertainty: true,
      evidenceSection: true,
      commandEvidence: true,
      exitCodeEvidence: true,
      filesSection: true,
      endExact: true,
    })

    const broken = good
      .replace('run_id: fixture-validate-terminal-receipt\n', '')
      .replace('final_status: LOCAL ONLY\n', '')
      .replace('residual_gaps: fixture only\n', '')
      .replace('UNCERTAINTY:\n', 'uncertainty omitted\n')
      .replace('evidence:\n', 'evidence omitted\n')
      .replace('files_touched:\n', 'files omitted\n')
      .replace('WORKER_RESULT_END\n', '')
    const report = mod.validateTerminalReceipt({
      root: ROOT,
      body: broken,
      allowNonCanonicalPath: true,
      requireFileExists: false,
    })
    expect(report.errors).toEqual(
      expect.arrayContaining([
        'RUN_ID_EXACTLY_ONE_REQUIRED',
        'FINAL_STATUS_EXACTLY_ONE_REQUIRED',
        'RESIDUAL_GAPS_MISSING',
        'UNCERTAINTY_SECTION_MISSING',
        'PROGRAM_EVIDENCE_MISSING',
        'FILES_TOUCHED_MISSING',
        'MISSING_WORKER_RESULT_END',
      ]),
    )
  })

  it('rejects duplicate run_id, invalid PASS final_status, and manual/fabricated PASS text', async () => {
    const mod = await loadMod()
    const body = mod
      .buildFixtureReceipt()
      .replace(
        'run_id: fixture-validate-terminal-receipt',
        'run_id: fixture-validate-terminal-receipt\nrun_id: duplicate',
      )
      .replace('final_status: LOCAL ONLY', 'final_status: PASS')
      .replace('WORKER_RESULT_END', 'manual hand-typed PASS\nWORKER_RESULT_END')
    const report = mod.validateTerminalReceipt({
      root: ROOT,
      body,
      allowNonCanonicalPath: true,
      requireFileExists: false,
    })
    expect(report.errors).toEqual(
      expect.arrayContaining([
        'RUN_ID_EXACTLY_ONE_REQUIRED',
        'FINAL_STATUS_EXACTLY_ONE_REQUIRED',
        'MANUAL_OR_FABRICATED_PASS',
      ]),
    )
  })

  it('requires literal WORKER_RESULT_END as the complete final line', async () => {
    const mod = await loadMod()
    const body = mod
      .buildFixtureReceipt()
      .replace('WORKER_RESULT_END', 'NOT_WORKER_RESULT_END')
    const report = mod.validateTerminalReceipt({
      root: ROOT,
      body,
      allowNonCanonicalPath: true,
      requireFileExists: false,
    })
    expect(report.errors).toContain('MISSING_WORKER_RESULT_END')
    expect(report.terminalContract.endExact).toBe(false)
  })

  it('rejects a standalone bare PASS line', async () => {
    const mod = await loadMod()
    const body = mod
      .buildFixtureReceipt()
      .replace('WORKER_RESULT_END', 'PASS\nWORKER_RESULT_END')
    const report = mod.validateTerminalReceipt({
      root: ROOT,
      body,
      allowNonCanonicalPath: true,
      requireFileExists: false,
    })
    expect(report.errors).toContain('MANUAL_OR_FABRICATED_PASS')
  })

  it('rejects free-form program-emitted PASS prose', async () => {
    const mod = await loadMod()
    const body = mod
      .buildFixtureReceipt()
      .replace(
        'WORKER_RESULT_END',
        'program-emitted PASS; manual review recorded\nWORKER_RESULT_END',
      )
    const report = mod.validateTerminalReceipt({
      root: ROOT,
      body,
      allowNonCanonicalPath: true,
      requireFileExists: false,
    })
    expect(report.errors).toContain('MANUAL_OR_FABRICATED_PASS')
    expect(report.verdict).toBe('FAIL')
  })

  it.each([
    'program emitted PASS',
    'program-output: PASS',
    'machine-emitted verdict: PASS',
    'tool-emitted result=PASS',
  ])('rejects free-form machine attribution: %s', async (claim) => {
    const mod = await loadMod()
    const body = mod
      .buildFixtureReceipt()
      .replace('WORKER_RESULT_END', `${claim}\nWORKER_RESULT_END`)
    const report = mod.validateTerminalReceipt({
      root: ROOT,
      body,
      allowNonCanonicalPath: true,
      requireFileExists: false,
    })
    expect(report.errors).toContain('MANUAL_OR_FABRICATED_PASS')
    expect(report.verdict).toBe('FAIL')
  })

  it('recognizes only a framed exact staging machine payload', async () => {
    const mod = await loadMod()
    const framed = [
      mod.STAGING_MACHINE_PAYLOAD_BEGIN,
      mod.CANONICAL_STAGING_MACHINE_RECORD,
      mod.STAGING_MACHINE_PAYLOAD_END,
      '',
    ].join('\n')
    expect(mod.claimsStagingVerifiedPass(framed, 'DONE')).toBe(true)
    expect(
      mod.claimsStagingVerifiedPass(
        `${mod.CANONICAL_STAGING_MACHINE_RECORD}\n`,
        'DONE',
      ),
    ).toBe(false)
    for (const prose of [
      'gate closed: TASK_MANAGER_STAGING_VERIFIED',
      'TASK_MANAGER_STAGING_VERIFIED: machine-emitted verdict: PASS',
      'manual assertion: TASK_MANAGER_STAGING_VERIFIED: program-emitted PASS',
      'TASK_MANAGER_STAGING_VERIFIED: program-emitted PASS was hand-typed',
      'TASK_MANAGER_STAGING_VERIFIED = program-emitted PASS',
    ]) {
      expect(mod.claimsStagingVerifiedPass(prose, 'DONE')).toBe(false)
    }
  })

  it.each([
    'no manual PASS exists',
    'not a fabricated PASS',
    'without operator-entered PASS',
    'no hand-typed PASS exists',
    'no manually asserted PASS exists',
    'no\nhand-typed\nPASS exists',
  ])('accepts explicit negated denial: %s', async (denial) => {
    const mod = await loadMod()
    const body = mod
      .buildFixtureReceipt()
      .replace(
        'WORKER_RESULT_END',
        `manual review confirms ${denial}\nWORKER_RESULT_END`,
      )
    const report = mod.validateTerminalReceipt({
      root: ROOT,
      body,
      allowNonCanonicalPath: true,
      requireFileExists: false,
    })
    expect(report.errors).not.toContain('MANUAL_OR_FABRICATED_PASS')
    expect(report.verdict).toBe('PASS')
  })

  it.each([
    [
      'same line',
      'program-emitted PASS; manual hand-typed PASS\nWORKER_RESULT_END',
    ],
    [
      'separate line',
      'program-emitted PASS\nmanual hand-typed PASS\nWORKER_RESULT_END',
    ],
  ])(
    'rejects mixed program evidence plus %s manual PASS',
    async (_label, terminalLines) => {
      const mod = await loadMod()
      const body = mod
        .buildFixtureReceipt()
        .replace('WORKER_RESULT_END', terminalLines)
      const report = mod.validateTerminalReceipt({
        root: ROOT,
        body,
        allowNonCanonicalPath: true,
        requireFileExists: false,
      })
      expect(report.errors).toContain('MANUAL_OR_FABRICATED_PASS')
      expect(report.verdict).toBe('FAIL')
    },
  )

  it('rejects manual PASS after arbitrary same-line padding', async () => {
    const mod = await loadMod()
    const body = mod
      .buildFixtureReceipt()
      .replace(
        'WORKER_RESULT_END',
        `program-emitted PASS; manual ${'x'.repeat(61)} PASS\nWORKER_RESULT_END`,
      )
    const report = mod.validateTerminalReceipt({
      root: ROOT,
      body,
      allowNonCanonicalPath: true,
      requireFileExists: false,
    })
    expect(report.errors).toContain('MANUAL_OR_FABRICATED_PASS')
    expect(report.verdict).toBe('FAIL')
  })

  it.each([
    ['manually asserted', 'program-emitted PASS; manually asserted PASS'],
    ['operator-entered', 'program-emitted PASS; operator-entered PASS'],
    ['verdict token', 'program-emitted PASS; verdict: PASS'],
    ['ordinary result', 'program-emitted PASS; tests passed'],
    [
      'cross-line manual verdict',
      `program-emitted PASS\nmanual assertion follows\n${'x'.repeat(10_000)}\nverdict: PASS`,
    ],
    [
      'cross-line manually padded',
      `program-emitted PASS; manually\n${'x'.repeat(10_000)}\nPASS`,
    ],
    [
      'negation does not mask a second claim',
      'program-emitted PASS; no hand-typed PASS exists; operator-entered PASS',
    ],
  ])('rejects every unattributed PASS variant: %s', async (_label, claim) => {
    const mod = await loadMod()
    const body = mod
      .buildFixtureReceipt()
      .replace('WORKER_RESULT_END', `${claim}\nWORKER_RESULT_END`)
    const report = mod.validateTerminalReceipt({
      root: ROOT,
      body,
      allowNonCanonicalPath: true,
      requireFileExists: false,
    })
    expect(report.errors).toContain('MANUAL_OR_FABRICATED_PASS')
    expect(report.verdict).toBe('FAIL')
  })

  it.each([
    ['operator wraps program', 'operator-entered program-emitted PASS'],
    ['manual wraps machine', 'manual assertion: machine-emitted verdict: PASS'],
    ['hand-typed wraps tool', 'hand-typed tool-emitted result=PASS'],
    [
      'fabricated quotes program output',
      'fabricated evidence quotes program-output: PASS',
    ],
    ['program suffix says hand-typed', 'program-emitted PASS was hand-typed'],
    [
      'cross-line manual wrapper with padding',
      `manual assertion:\nprogram-emitted${' '.repeat(10_000)}PASS`,
    ],
  ])('rejects R4 attribution spoof: %s', async (_label, claim) => {
    const mod = await loadMod()
    const body = mod
      .buildFixtureReceipt()
      .replace('WORKER_RESULT_END', `${claim}\nWORKER_RESULT_END`)
    const report = mod.validateTerminalReceipt({
      root: ROOT,
      body,
      allowNonCanonicalPath: true,
      requireFileExists: false,
    })
    expect(report.errors).toContain('MANUAL_OR_FABRICATED_PASS')
    expect(report.verdict).toBe('FAIL')
  })

  it.each([
    'production deploy: program-emitted PASS',
    'production deployment: machine-emitted verdict: PASS',
    'production deploy:\nprogram-emitted\nresult:\nPASS',
  ])('rejects attributed production authority claim: %s', async (claim) => {
    const mod = await loadMod()
    const body = mod
      .buildFixtureReceipt()
      .replace('WORKER_RESULT_END', `${claim}\nWORKER_RESULT_END`)
    const report = mod.validateTerminalReceipt({
      root: ROOT,
      body,
      allowNonCanonicalPath: true,
      requireFileExists: false,
    })
    expect(report.errors).toEqual(
      expect.arrayContaining([
        'LIVE_P0_PASS_FORBIDDEN',
        'MANUAL_OR_FABRICATED_PASS',
      ]),
    )
    expect(report.verdict).toBe('FAIL')
  })

  it.each([
    [
      'manual prefix on canonical-looking record',
      'manual assertion: TASK_MANAGER_STAGING_VERIFIED: program-emitted PASS',
    ],
    [
      'manual suffix on canonical-looking record',
      'TASK_MANAGER_STAGING_VERIFIED: program-emitted PASS was hand-typed',
    ],
    [
      'line break before free-form attribution',
      'operator-entered\nprogram-emitted PASS',
    ],
    [
      'denial cannot hide later free-form claim',
      'no hand-typed PASS exists; program-emitted PASS',
    ],
    [
      'canonical record cannot hide a second manual claim',
      'TASK_MANAGER_STAGING_VERIFIED: program-emitted PASS\nno hand-typed PASS exists; operator-entered PASS',
    ],
  ])(
    'rejects nearby attribution boundary variant: %s',
    async (_label, claim) => {
      const mod = await loadMod()
      const body = mod
        .buildFixtureReceipt()
        .replace('WORKER_RESULT_END', `${claim}\nWORKER_RESULT_END`)
      const report = mod.validateTerminalReceipt({
        root: ROOT,
        body,
        allowNonCanonicalPath: true,
        requireFileExists: false,
      })
      expect(report.errors).toContain('MANUAL_OR_FABRICATED_PASS')
      expect(report.verdict).toBe('FAIL')
    },
  )

  it('rejects missing required fields', async () => {
    const mod = await loadMod()
    const body = mod.buildFixtureReceipt({
      omitFields: ['claim_audit_output', 'independent_verifier_receipt'],
    })
    const report = mod.validateTerminalReceipt({
      root: ROOT,
      body,
      allowNonCanonicalPath: true,
      requireFileExists: false,
    })
    expect(report.verdict).toBe('FAIL')
    expect(
      report.errors.some((e) =>
        [
          'MISSING_REQUIRED_FIELDS',
          'CLAIM_AUDIT_MISSING',
          'INDEPENDENT_VERIFIER_MISSING',
        ].includes(e),
      ),
    ).toBe(true)
    const fieldMap = Object.fromEntries(
      report.fields.map((f) => [f.id, f.present]),
    )
    expect(fieldMap.claim_audit_output).toBe(false)
    expect(fieldMap.independent_verifier_receipt).toBe(false)
  })

  it('rejects live P0 PASS while staging terminal', async () => {
    const mod = await loadMod()
    const body = mod.buildFixtureReceipt({ liveP0Pass: true })
    const report = mod.validateTerminalReceipt({
      root: ROOT,
      body,
      allowNonCanonicalPath: true,
      requireFileExists: false,
    })
    expect(report.errors).toContain('LIVE_P0_PASS_FORBIDDEN')
  })

  it('rejects machine-attributed live P0 PASS while staging terminal', async () => {
    const mod = await loadMod()
    const body = mod
      .buildFixtureReceipt()
      .replace(
        'WORKER_RESULT_END',
        'live P0 program-emitted PASS\nWORKER_RESULT_END',
      )
    const report = mod.validateTerminalReceipt({
      root: ROOT,
      body,
      allowNonCanonicalPath: true,
      requireFileExists: false,
    })
    expect(report.errors).toContain('LIVE_P0_PASS_FORBIDDEN')
  })

  it('rejects fabricated staging PASS without claim-audit program output / hashes', async () => {
    const mod = await loadMod()
    const body = mod.buildFixtureReceipt({
      status: 'DONE',
      claimStagingPass: true,
      releaseSha: '1'.repeat(40),
      omitFields: ['claim_audit_output'],
      pointers: [],
    })
    const report = mod.validateTerminalReceipt({
      root: ROOT,
      body,
      allowNonCanonicalPath: true,
      requireFileExists: false,
    })
    expect(report.claimsStagingPass).toBe(true)
    expect(
      report.errors.some((e) =>
        [
          'FABRICATED_OR_INCOMPLETE_PASS',
          'CLAIM_AUDIT_PROGRAM_OUTPUT_MISSING',
          'HASH_BOUND_EVIDENCE_MISSING',
        ].includes(e),
      ),
    ).toBe(true)
  })

  it('rejects stale hash-bound evidence pointers', async () => {
    const mod = await loadMod()
    const dir = tmp()
    const target = join(dir, 'stale-target.json')
    writeFileSync(target, '{"v":1}')
    const body = mod.buildFixtureReceipt({
      pointers: [{ path: target, sha256: '0'.repeat(64) }],
    })
    const report = mod.validateTerminalReceipt({
      root: ROOT,
      body,
      allowNonCanonicalPath: true,
      requireFileExists: false,
    })
    expect(report.errors).toContain('STALE_HASH')
  })

  it('accepts full staging PASS fixture only with exact path + hash + claim-audit + verifier + live awaiting', async () => {
    const mod = await loadMod()
    const dir = tmp()
    mkdirSync(
      join(dir, '.artifact/evidence/TM-P0-ULTIMATE-CONTROL-CENTER-V3'),
      { recursive: true },
    )
    const blobRel = 'fixture-evidence.json'
    writeFileSync(join(dir, blobRel), '{"staging":true}')
    const blobHash = sha256('{"staging":true}')
    const body = mod.buildFixtureReceipt({
      status: 'DONE',
      claimStagingPass: true,
      releaseSha: '1'.repeat(40),
      pointers: [{ path: blobRel, sha256: blobHash }],
    })
    expect(body).toContain(
      'TASK_MANAGER_STAGING_VERIFIED: program-emitted PASS',
    )
    const receiptAbs = join(dir, mod.EXACT_TERMINAL_RECEIPT_REL)
    const report = mod.validateTerminalReceipt({
      root: dir,
      receiptPath: receiptAbs,
      body,
      allowNonCanonicalPath: false,
      requireFileExists: false,
      expectedReleaseSha: '1'.repeat(40),
    })
    expect(report.verdict).toBe('PASS')
    expect(report.claimsStagingPass).toBe(true)
    expect(report.checks.live_awaiting_present).toMatchObject({ ok: true })
    expect(report.checks.claim_audit).toMatchObject({
      mentioned: true,
      hasProgramOutput: true,
    })
    expect(report.checks.independent_verifier).toMatchObject({
      mentioned: true,
    })
    expect(report.checks.checkpoint_receipts).toMatchObject({ ok: true })
    expect(report.checks.no_production_no_secret_no_worktree).toMatchObject({
      ok: true,
    })
    expect(report).toMatchObject({
      releaseSha: '1'.repeat(40),
      expectedReleaseSha: '1'.repeat(40),
      releaseShaMatchesExpected: true,
    })
  })

  it('requires one lowercase full release SHA and rejects cross-release replay', async () => {
    const mod = await loadMod()
    const dir = tmp()
    const blob = join(dir, 'fixture-evidence.json')
    writeFileSync(blob, '{"release":true}')
    const base = {
      status: 'DONE',
      claimStagingPass: true,
      pointers: [{ path: blob, sha256: sha256('{"release":true}') }],
    }
    const validate = (body: string, expectedReleaseSha = '1'.repeat(40)) =>
      mod.validateTerminalReceipt({
        root: ROOT,
        body,
        allowNonCanonicalPath: true,
        requireFileExists: false,
        expectedReleaseSha,
      })

    const missing = validate(mod.buildFixtureReceipt(base))
    expect(missing.errors).toContain('RELEASE_SHA_MISSING')

    const malformed = validate(
      mod.buildFixtureReceipt({ ...base, releaseSha: 'ABC123' }),
    )
    expect(malformed.errors).toContain('RELEASE_SHA_INVALID')

    const validBody = mod.buildFixtureReceipt({
      ...base,
      releaseSha: '1'.repeat(40),
    })
    const unbound = mod.validateTerminalReceipt({
      root: ROOT,
      body: validBody,
      allowNonCanonicalPath: true,
      requireFileExists: false,
    })
    expect(unbound.errors).toContain('EXPECTED_RELEASE_SHA_REQUIRED')

    const framedMachineRecord = [
      mod.STAGING_MACHINE_PAYLOAD_BEGIN,
      mod.CANONICAL_STAGING_MACHINE_RECORD,
      mod.STAGING_MACHINE_PAYLOAD_END,
    ].join('\n')
    const duplicateMachineRecord = validate(
      validBody.replace(
        framedMachineRecord,
        `${framedMachineRecord}\n${framedMachineRecord}`,
      ),
    )
    expect(duplicateMachineRecord.errors).toContain(
      'STAGING_MACHINE_RECORD_DUPLICATE',
    )

    const duplicate = validate(
      validBody.replace(
        `release_sha: ${'1'.repeat(40)}`,
        `release_sha: ${'1'.repeat(40)}\nrelease_sha: ${'1'.repeat(40)}`,
      ),
    )
    expect(duplicate.errors).toContain('RELEASE_SHA_DUPLICATE')

    const mismatch = validate(validBody, '2'.repeat(40))
    expect(mismatch.errors).toContain('RELEASE_SHA_MISMATCH')
    expect(mismatch.releaseShaMatchesExpected).toBe(false)

    const matching = validate(validBody)
    expect(matching.verdict).toBe('PASS')
    expect(matching.releaseShaMatchesExpected).toBe(true)
    expect(mod.extractReleaseSha(validBody).releaseSha).toBe('1'.repeat(40))
  })

  it('requires an exact normalized payload inside the staging machine frame', async () => {
    const mod = await loadMod()
    const dir = tmp()
    const blob = join(dir, 'r6-evidence.json')
    const blobBody = '{"r6":true}'
    writeFileSync(blob, blobBody)
    const validBody = mod.buildFixtureReceipt({
      status: 'DONE',
      claimStagingPass: true,
      releaseSha: '1'.repeat(40),
      pointers: [{ path: blob, sha256: sha256(blobBody) }],
    })
    const canonicalBlock = [
      mod.STAGING_MACHINE_PAYLOAD_BEGIN,
      mod.CANONICAL_STAGING_MACHINE_RECORD,
      mod.STAGING_MACHINE_PAYLOAD_END,
    ].join('\n')
    const validate = (body: string) =>
      mod.validateTerminalReceipt({
        root: ROOT,
        body,
        allowNonCanonicalPath: true,
        requireFileExists: false,
        expectedReleaseSha: '1'.repeat(40),
      })
    const withPayload = (payload: string) =>
      validBody.replace(
        canonicalBlock,
        [
          mod.STAGING_MACHINE_PAYLOAD_BEGIN,
          payload,
          mod.STAGING_MACHINE_PAYLOAD_END,
        ].join('\n'),
      )

    for (const [payload, requiresLiveAuthorityError] of [
      [`manual assertion:\n${mod.CANONICAL_STAGING_MACHINE_RECORD}`, false],
      [`operator-entered:\n${mod.CANONICAL_STAGING_MACHINE_RECORD}`, false],
      [`fabricated evidence:\n${mod.CANONICAL_STAGING_MACHINE_RECORD}`, false],
      [`${mod.CANONICAL_STAGING_MACHINE_RECORD}\nwas hand-typed`, false],
      [`production deploy:\n${mod.CANONICAL_STAGING_MACHINE_RECORD}`, true],
      [`production deployment:\n${mod.CANONICAL_STAGING_MACHINE_RECORD}`, true],
      [`generic prose before\n${mod.CANONICAL_STAGING_MACHINE_RECORD}`, false],
      [`${mod.CANONICAL_STAGING_MACHINE_RECORD}\ngeneric prose after`, false],
      [
        `TASK_MANAGER_STAGING_VERIFIED:${' '.repeat(10_000)}program-emitted PASS`,
        false,
      ],
      ['TASK_MANAGER_STAGING_VERIFIED:\nprogram-emitted PASS', false],
      ['task_manager_staging_verified: program-emitted pass', false],
    ] as const) {
      const report = validate(withPayload(payload))
      expect(report.verdict, payload.slice(0, 80)).toBe('FAIL')
      expect(report.errors, payload.slice(0, 80)).toContain(
        'STAGING_MACHINE_PAYLOAD_INVALID',
      )
      if (requiresLiveAuthorityError) {
        expect(report.errors, payload.slice(0, 80)).toContain(
          'LIVE_P0_PASS_FORBIDDEN',
        )
      }
    }

    for (const payload of [
      mod.CANONICAL_STAGING_MACHINE_RECORD,
      `\n${mod.CANONICAL_STAGING_MACHINE_RECORD}\n`,
      ` \t\n  ${mod.CANONICAL_STAGING_MACHINE_RECORD} \t\n\t`,
    ]) {
      const report = validate(withPayload(payload))
      expect(report.errors, JSON.stringify(payload)).not.toContain(
        'STAGING_MACHINE_PAYLOAD_INVALID',
      )
      expect(report.verdict, JSON.stringify(payload)).toBe('PASS')
    }

    const crlfBody = validBody.replaceAll('\n', '\r\n')
    expect(validate(crlfBody).verdict).toBe('PASS')
    expect(mod.extractStagingMachinePayloads(crlfBody)).toEqual([
      expect.objectContaining({
        normalized: mod.CANONICAL_STAGING_MACHINE_RECORD,
        valid: true,
      }),
    ])

    const duplicate = validate(
      validBody.replace(canonicalBlock, `${canonicalBlock}\n${canonicalBlock}`),
    )
    expect(duplicate.errors).toContain('STAGING_MACHINE_RECORD_DUPLICATE')

    for (const malformed of [
      validBody.replace(mod.STAGING_MACHINE_PAYLOAD_END, 'END_WRONG_MARKER'),
      validBody.replace(mod.STAGING_MACHINE_PAYLOAD_END, ''),
      `${validBody}\n${mod.STAGING_MACHINE_PAYLOAD_BEGIN}`,
      `${validBody}\n${mod.STAGING_MACHINE_PAYLOAD_END}`,
    ]) {
      expect(validate(malformed).errors).toContain(
        'STAGING_MACHINE_PAYLOAD_INVALID',
      )
    }
  })

  it.each([
    `production deploy:\nBEGIN_TASK_MANAGER_STAGING_MACHINE_RECORD\nTASK_MANAGER_STAGING_VERIFIED: program-emitted PASS\nEND_TASK_MANAGER_STAGING_MACHINE_RECORD`,
    `production deployment:\nBEGIN_TASK_MANAGER_STAGING_MACHINE_RECORD\nTASK_MANAGER_STAGING_VERIFIED: program-emitted PASS\nEND_TASK_MANAGER_STAGING_MACHINE_RECORD`,
  ])(
    'rejects framed staging record used as production authority: %s',
    async (claim) => {
      const mod = await loadMod()
      const body = mod
        .buildFixtureReceipt()
        .replace('WORKER_RESULT_END', `${claim}\nWORKER_RESULT_END`)
      const report = mod.validateTerminalReceipt({
        root: ROOT,
        body,
        allowNonCanonicalPath: true,
        requireFileExists: false,
      })
      expect(report.errors).toContain('LIVE_P0_PASS_FORBIDDEN')
    },
  )

  it('rejects incomplete no-production/no-secret/no-worktree statement', async () => {
    const mod = await loadMod()
    const body = mod
      .buildFixtureReceipt()
      .replace(
        'no-production/no-secret/no-worktree statement: affirmed',
        'statement omitted',
      )
    const report = mod.validateTerminalReceipt({
      root: ROOT,
      body,
      allowNonCanonicalPath: true,
      requireFileExists: false,
    })
    expect(report.errors).toContain(
      'NO_PROD_SECRET_WORKTREE_STATEMENT_INCOMPLETE',
    )
  })

  it('extracts claim-audit / independent verifier / checkpoint signals', async () => {
    const mod = await loadMod()
    const body = mod.buildFixtureReceipt({
      claimStagingPass: true,
      releaseSha: '1'.repeat(40),
    })
    expect(mod.extractClaimAudit(body).mentioned).toBe(true)
    expect(mod.extractClaimAudit(body).hasProgramOutput).toBe(true)
    expect(mod.extractIndependentVerifier(body).mentioned).toBe(true)
    expect(mod.extractIndependentVerifier(body).models).toContain(
      'gpt-5.3-codex-spark',
    )
    expect(mod.claimsStagingVerifiedPass(body, 'DONE')).toBe(true)
  })

  it('CLI --self-test exits 0 and does not create real terminal PASS receipt', async () => {
    const mod = await loadMod()
    const before = existsSync(resolve(ROOT, mod.EXACT_TERMINAL_RECEIPT_REL))
    const code = mod.runSelfTest(ROOT)
    expect(code).toBe(0)
    const after = existsSync(resolve(ROOT, mod.EXACT_TERMINAL_RECEIPT_REL))
    // must not create the real terminal path if it was absent
    if (!before) {
      expect(after).toBe(false)
    } else {
      const body = readFileSync(
        resolve(ROOT, mod.EXACT_TERMINAL_RECEIPT_REL),
        'utf8',
      )
      expect(body).not.toContain('fixture-validate-terminal-receipt')
    }
  })
})

describe('CLI process exit codes', () => {
  it('default invocation fails closed when exact terminal receipt is missing', () => {
    let exitCode = 0
    let stdout = ''
    try {
      stdout = execFileSync(process.execPath, [SCRIPT], {
        cwd: ROOT,
        encoding: 'utf8',
      })
    } catch (err) {
      const e = err as {
        status?: number
        stdout?: string
      }
      exitCode = e.status ?? 1
      stdout = e.stdout ?? ''
    }
    // If the exact file somehow exists as a complete PASS, this could be 0 —
    // assert structured JSON either way.
    const report = JSON.parse(stdout)
    expect(report.schemaVersion).toBe('TM_P0_TERMINAL_RECEIPT_SCHEMA_V1')
    expect(report.nonMutating).toBe(true)
    expect(report.doesNotEmitTerminalPassReceipt).toBe(true)
    expect(report.exactTerminalReceiptRel).toContain(
      'WORKER_RESULT_TM_P0_ULTIMATE_CONTROL_CENTER_V3.md',
    )
    if (!existsSync(resolve(ROOT, report.exactTerminalReceiptRel))) {
      expect(exitCode).toBe(1)
      expect(report.errors).toContain('PATH_MISSING')
      expect(report.verdict).toBe('FAIL')
    }
  })

  it('CLI --self-test exits 0', () => {
    const stdout = execFileSync(process.execPath, [SCRIPT, '--self-test'], {
      cwd: ROOT,
      encoding: 'utf8',
    })
    const report = JSON.parse(stdout)
    expect(report.mode).toBe('self-test')
    expect(report.verdict).toBe('PASS')
    expect(report.failures).toEqual([])
  })
})
