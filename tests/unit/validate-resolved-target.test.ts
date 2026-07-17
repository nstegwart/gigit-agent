import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const ROOT = process.cwd()
const SCRIPT = join(ROOT, 'qa/evidence/validate-resolved-target.mjs')
const tempDirs: string[] = []

type Mod = {
  SCHEMA_VERSION: string
  PINNED_SPEC_HASHES: Record<string, { path: string; sha256: string }>
  sha256Hex: (value: string) => string
  pathPoliciesOverlap: (allowed: string, forbidden: string) => boolean
  buildResolvedTarget: (opts?: Record<string, unknown>) => {
    schemaVersion: string
    verdict: 'PASS' | 'FAIL'
    errors: string[]
    repo: {
      root: string
      branch: string
      head: string
      upstream: string
      upstreamCommit: string
      divergence: string
    }
    pathPolicy: {
      allowed: string[]
      forbidden: string[]
      changed: string[]
      outsideAllowed: string[]
      changedForbidden: string[]
    }
    specs: Array<{ class: string }>
    bindingSha256: string
  }
}

async function loadMod(): Promise<Mod> {
  return (await import(pathToFileURL(SCRIPT).href)) as Mod
}

afterEach(() => {
  while (tempDirs.length)
    rmSync(tempDirs.pop()!, { recursive: true, force: true })
})

function fixture(mod: Mod) {
  const root = mkdtempSync(join(tmpdir(), 'resolved-target-'))
  tempDirs.push(root)
  mkdirSync(join(root, 'qa/evidence'), { recursive: true })
  writeFileSync(join(root, 'ART.md'), 'art')
  writeFileSync(join(root, 'V3.md'), 'v3')
  const specs = {
    artUx: { path: 'ART.md', sha256: mod.sha256Hex('art') },
    v3Combined: { path: 'V3.md', sha256: mod.sha256Hex('v3') },
  }
  const head = 'a'.repeat(40)
  const git = (args: string[]) => {
    const joined = args.join(' ')
    if (joined === 'rev-parse --show-toplevel') return resolve(root)
    if (joined === 'rev-parse --abbrev-ref HEAD') return 'main'
    if (joined === 'rev-parse HEAD') return head
    if (joined === 'rev-parse --abbrev-ref --symbolic-full-name @{upstream}')
      return 'origin/main'
    if (joined === 'rev-parse @{upstream}') return head
    if (joined === 'rev-list --left-right --count HEAD...@{upstream}')
      return '0 0'
    if (joined === 'status --porcelain=v1 --untracked-files=all')
      return ' M qa/evidence/existing.mjs\n?? tests/unit/new.test.ts'
    throw new Error(`unexpected git call ${joined}`)
  }
  return { root, specs, git, head }
}

describe('validate-resolved-target', () => {
  it('emits a complete binding for repo, policies, host classes, and pinned specs', async () => {
    const mod = await loadMod()
    const fx = fixture(mod)
    const report = mod.buildResolvedTarget({
      ...fx,
      allowedPaths: ['qa/evidence/**', 'tests/unit/**'],
      forbiddenPaths: ['deploy/production/**', 'migrations/**'],
      observedAt: '2026-07-15T00:00:00.000Z',
    })
    expect(report.verdict).toBe('PASS')
    expect(report.errors).toEqual([])
    expect(report.repo).toMatchObject({
      root: resolve(fx.root),
      branch: 'main',
      head: fx.head,
      upstream: 'origin/main',
      upstreamCommit: fx.head,
      divergence: '0 0',
    })
    expect(report.pathPolicy.changed).toEqual([
      'qa/evidence/existing.mjs',
      'tests/unit/new.test.ts',
    ])
    expect(report.specs.every((spec) => spec.class === 'PIN_MATCH')).toBe(true)
    expect(report.bindingSha256).toMatch(/^[a-f0-9]{64}$/)
  })

  it('fails closed on detached HEAD', async () => {
    const mod = await loadMod()
    const fx = fixture(mod)
    const report = mod.buildResolvedTarget({
      ...fx,
      git: (args: string[]) =>
        args.join(' ') === 'rev-parse --abbrev-ref HEAD'
          ? 'HEAD'
          : fx.git(args),
    })
    expect(report.errors).toContain('DETACHED_HEAD')
  })

  it('fails closed when git top-level is a foreign path', async () => {
    const mod = await loadMod()
    const fx = fixture(mod)
    const report = mod.buildResolvedTarget({
      ...fx,
      git: (args: string[]) =>
        args.join(' ') === 'rev-parse --show-toplevel'
          ? '/tmp/foreign-repo'
          : fx.git(args),
    })
    expect(report.errors).toContain('FOREIGN_REPO_ROOT')
  })

  it('requires HEAD equality with the resolved upstream commit and zero divergence', async () => {
    const mod = await loadMod()
    const fx = fixture(mod)
    const report = mod.buildResolvedTarget({
      ...fx,
      git: (args: string[]) => {
        const joined = args.join(' ')
        if (joined === 'rev-parse @{upstream}') return 'b'.repeat(40)
        if (joined === 'rev-list --left-right --count HEAD...@{upstream}')
          return '1 2'
        return fx.git(args)
      },
    })
    expect(report.errors).toEqual(
      expect.arrayContaining([
        'HEAD_UPSTREAM_MISMATCH',
        'HEAD_UPSTREAM_DIVERGED',
      ]),
    )
  })

  it('enforces the actual changed-path fence including untracked paths', async () => {
    const mod = await loadMod()
    const fx = fixture(mod)
    const report = mod.buildResolvedTarget({
      ...fx,
      allowedPaths: ['qa/evidence/**'],
      forbiddenPaths: ['deploy/production/**'],
      changedPaths: [
        'qa/evidence/allowed.mjs',
        'deploy/production/release.sh',
        'other/untracked.txt',
      ],
    })
    expect(report.errors).toEqual(
      expect.arrayContaining([
        'CHANGED_PATH_OUTSIDE_ALLOWED',
        'CHANGED_PATH_FORBIDDEN',
      ]),
    )
    expect(report.pathPolicy.changedForbidden).toEqual([
      'deploy/production/release.sh',
    ])
    expect(report.pathPolicy.outsideAllowed).toEqual([
      'deploy/production/release.sh',
      'other/untracked.txt',
    ])
  })

  it('rejects calendar-invalid ISO timestamps instead of Date.parse normalization', async () => {
    const mod = await loadMod()
    const fx = fixture(mod)
    const report = mod.buildResolvedTarget({
      ...fx,
      observedAt: '2026-02-30T00:00:00.000Z',
    })
    expect(report.errors).toContain('OBSERVED_AT_INVALID')
  })

  it('rejects wrong pinned hashes and overlapping allowed/forbidden paths', async () => {
    const mod = await loadMod()
    const fx = fixture(mod)
    const report = mod.buildResolvedTarget({
      ...fx,
      specs: {
        ...fx.specs,
        artUx: { path: 'ART.md', sha256: '0'.repeat(64) },
      },
      allowedPaths: ['qa/evidence/**'],
      forbiddenPaths: ['qa/**'],
    })
    expect(report.errors).toEqual(
      expect.arrayContaining(['SPEC_HASH_MISMATCH', 'PATH_POLICY_OVERLAP']),
    )
  })

  it('rejects absolute and parent-traversal policy paths', async () => {
    const mod = await loadMod()
    const fx = fixture(mod)
    const report = mod.buildResolvedTarget({
      ...fx,
      allowedPaths: ['/etc/passwd'],
      forbiddenPaths: ['../other/**'],
    })
    expect(report.errors).toEqual(
      expect.arrayContaining([
        'ALLOWED_PATH_INVALID',
        'FORBIDDEN_PATH_INVALID',
      ]),
    )
  })

  it('hermetically classifies clean, dirty, stale, mismatched, and diverged targets', async () => {
    const mod = await loadMod()
    const fx = fixture(mod)
    const gitState =
      ({
        upstreamCommit = fx.head,
        divergence = '0 0',
        porcelain = '',
      }: {
        upstreamCommit?: string
        divergence?: string
        porcelain?: string
      }) =>
      (args: string[]) => {
        const joined = args.join(' ')
        if (joined === 'rev-parse @{upstream}') return upstreamCommit
        if (joined === 'rev-list --left-right --count HEAD...@{upstream}')
          return divergence
        if (joined === 'status --porcelain=v1 --untracked-files=all')
          return porcelain
        return fx.git(args)
      }

    const cases = [
      {
        id: 'clean-current',
        git: gitState({}),
        verdict: 'PASS',
        errors: [],
      },
      {
        id: 'dirty',
        git: gitState({ porcelain: '?? outside-candidate.txt' }),
        verdict: 'FAIL',
        errors: ['CHANGED_PATH_OUTSIDE_ALLOWED'],
      },
      {
        id: 'stale-behind',
        git: gitState({ upstreamCommit: 'b'.repeat(40), divergence: '0 1' }),
        verdict: 'FAIL',
        errors: ['HEAD_UPSTREAM_MISMATCH', 'HEAD_UPSTREAM_DIVERGED'],
      },
      {
        id: 'mismatched',
        git: gitState({ upstreamCommit: 'c'.repeat(40) }),
        verdict: 'FAIL',
        errors: ['HEAD_UPSTREAM_MISMATCH'],
      },
      {
        id: 'diverged',
        git: gitState({ divergence: '1 1' }),
        verdict: 'FAIL',
        errors: ['HEAD_UPSTREAM_DIVERGED'],
      },
    ] as const

    for (const candidate of cases) {
      const report = mod.buildResolvedTarget({
        ...fx,
        git: candidate.git,
        allowedPaths: ['qa/evidence/**'],
        forbiddenPaths: ['deploy/production/**'],
      })
      expect(report.schemaVersion, candidate.id).toBe('TM_RESOLVED_TARGET_V1')
      expect(report.repo.root, candidate.id).toBe(resolve(fx.root))
      expect(report.repo.branch, candidate.id).toBe('main')
      expect(report.repo.upstream, candidate.id).toBe('origin/main')
      expect(report.verdict, candidate.id).toBe(candidate.verdict)
      expect(report.errors, candidate.id).toEqual(
        expect.arrayContaining([...candidate.errors]),
      )
    }
  })

  it('is invoked by the real staging-gate preflight and blocks invalid target state', async () => {
    const mod = await loadMod()
    const fx = fixture(mod)
    const gate = (await import(
      pathToFileURL(join(ROOT, 'qa/cp0/staging-gate.mjs')).href
    )) as {
      validateGatePreflight: (opts: Record<string, unknown>) => {
        ok: boolean
        failures: string[]
        resolvedTarget: { verdict: string }
        environmentTable: { verdict: string }
        terminalReceipt: {
          verdict: string
          status: string | null
          claimsStagingPass: boolean
          terminalContractValid: boolean
          releaseSha: string | null
          releaseShaMatchesExpected: boolean | null
        } | null
      }
    }
    const terminal = (await import(
      pathToFileURL(join(ROOT, 'qa/evidence/validate-terminal-receipt.mjs'))
        .href
    )) as {
      buildFixtureReceipt: (opts?: Record<string, unknown>) => string
      sha256Hex: (value: string) => string
    }
    const targetOptions = {
      specs: fx.specs,
      git: fx.git,
      allowedPaths: ['qa/evidence/**', 'tests/unit/**'],
      forbiddenPaths: ['deploy/production/**'],
    }
    const environmentOptions = {
      observedAt: '2026-07-15T00:00:00.000Z',
    }
    const good = gate.validateGatePreflight({
      root: fx.root,
      resolvedTargetOptions: targetOptions,
      environmentOptions,
    })
    expect(good).toMatchObject({
      ok: true,
      failures: [],
      resolvedTarget: { verdict: 'PASS' },
      environmentTable: { verdict: 'PASS' },
      terminalReceipt: null,
    })

    const missingTerminal = gate.validateGatePreflight({
      root: fx.root,
      resolvedTargetOptions: targetOptions,
      environmentOptions,
      requireTerminalReceipt: true,
    })
    expect(missingTerminal.ok).toBe(false)
    expect(missingTerminal.failures).toContain('TERMINAL_RECEIPT_REQUIRED')

    const evidenceBody = '{"terminal":true}'
    const evidencePath = join(fx.root, 'terminal-evidence.json')
    writeFileSync(evidencePath, evidenceBody)
    const terminalBody = terminal.buildFixtureReceipt({
      status: 'DONE',
      claimStagingPass: true,
      releaseSha: fx.head,
      pointers: [
        { path: evidencePath, sha256: terminal.sha256Hex(evidenceBody) },
      ],
    })
    const releaseReady = gate.validateGatePreflight({
      root: fx.root,
      resolvedTargetOptions: targetOptions,
      environmentOptions,
      requireTerminalReceipt: true,
      terminalReceiptOptions: {
        body: terminalBody,
        requireFileExists: false,
      },
    })
    expect(releaseReady).toMatchObject({
      ok: true,
      failures: [],
      terminalReceipt: {
        verdict: 'PASS',
        status: 'DONE',
        claimsStagingPass: true,
        terminalContractValid: true,
        releaseSha: fx.head,
        releaseShaMatchesExpected: true,
      },
    })

    const replayed = gate.validateGatePreflight({
      root: fx.root,
      resolvedTargetOptions: targetOptions,
      environmentOptions,
      requireTerminalReceipt: true,
      terminalReceiptOptions: {
        body: terminalBody.replace(fx.head, 'b'.repeat(40)),
        requireFileExists: false,
      },
    })
    expect(replayed.ok).toBe(false)
    expect(replayed.failures).toContain('TERMINAL_RECEIPT_RELEASE_SHA_MISMATCH')

    const expectedShaDisagrees = gate.validateGatePreflight({
      root: fx.root,
      resolvedTargetOptions: targetOptions,
      environmentOptions,
      expectedReleaseSha: 'b'.repeat(40),
    })
    expect(expectedShaDisagrees.ok).toBe(false)
    expect(expectedShaDisagrees.failures).toContain(
      'EXPECTED_SHA_RESOLVED_HEAD_MISMATCH',
    )

    const invalidTerminal = gate.validateGatePreflight({
      root: fx.root,
      resolvedTargetOptions: targetOptions,
      environmentOptions,
      requireTerminalReceipt: true,
      terminalReceiptOptions: {
        body: terminalBody.replace(
          'WORKER_RESULT_END',
          'NOT_WORKER_RESULT_END',
        ),
        requireFileExists: false,
      },
    })
    expect(invalidTerminal.ok).toBe(false)
    expect(invalidTerminal.failures).toContain(
      'TERMINAL_RECEIPT_MISSING_WORKER_RESULT_END',
    )

    const localOnlyTerminal = gate.validateGatePreflight({
      root: fx.root,
      resolvedTargetOptions: targetOptions,
      environmentOptions,
      requireTerminalReceipt: true,
      terminalReceiptOptions: {
        body: terminal.buildFixtureReceipt(),
        requireFileExists: false,
      },
    })
    expect(localOnlyTerminal.failures).toEqual(
      expect.arrayContaining([
        'TERMINAL_RECEIPT_STATUS_NOT_DONE',
        'TERMINAL_RECEIPT_STAGING_PASS_REQUIRED',
      ]),
    )

    const blocked = gate.validateGatePreflight({
      root: fx.root,
      resolvedTargetOptions: {
        specs: fx.specs,
        git: fx.git,
        allowedPaths: ['qa/evidence/**'],
        forbiddenPaths: ['deploy/production/**'],
        changedPaths: ['deploy/production/release.sh'],
      },
      environmentOptions: { observedAt: '2026-07-15T00:00:00.000Z' },
    })
    expect(blocked.ok).toBe(false)
    expect(blocked.failures).toEqual(
      expect.arrayContaining([
        'RESOLVED_TARGET_CHANGED_PATH_OUTSIDE_ALLOWED',
        'RESOLVED_TARGET_CHANGED_PATH_FORBIDDEN',
      ]),
    )
  })
})
