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
  sha256Hex: (data: string | Buffer) => string
  extractStatus: (body: string) => string | null
  claimsStagingVerifiedPass: (body: string, status: string | null) => boolean
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
  buildFixtureReceipt: (opts?: Record<string, unknown>) => string
  validateTerminalReceipt: (opts?: Record<string, unknown>) => {
    verdict: 'PASS' | 'FAIL'
    errors: string[]
    warnings: string[]
    status: string | null
    claimsStagingPass: boolean
    nonMutating: boolean
    doesNotEmitTerminalPassReceipt: boolean
    exactTerminalReceiptRel: string
    checks: Record<string, unknown>
    fields: Array<{ id: string; present: boolean }>
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
    expect(report.errors).toEqual(
      expect.arrayContaining(['PATH_MISSING']),
    )
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
  })

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

  it('rejects fabricated staging PASS without claim-audit program output / hashes', async () => {
    const mod = await loadMod()
    const body = mod.buildFixtureReceipt({
      status: 'DONE',
      claimStagingPass: true,
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
      pointers: [{ path: blobRel, sha256: blobHash }],
    })
    const receiptAbs = join(dir, mod.EXACT_TERMINAL_RECEIPT_REL)
    const report = mod.validateTerminalReceipt({
      root: dir,
      receiptPath: receiptAbs,
      body,
      allowNonCanonicalPath: false,
      requireFileExists: false,
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
  })

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
    const body = mod.buildFixtureReceipt({ claimStagingPass: true })
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
    const stdout = execFileSync(
      process.execPath,
      [SCRIPT, '--self-test'],
      { cwd: ROOT, encoding: 'utf8' },
    )
    const report = JSON.parse(stdout)
    expect(report.mode).toBe('self-test')
    expect(report.verdict).toBe('PASS')
    expect(report.failures).toEqual([])
  })
})
