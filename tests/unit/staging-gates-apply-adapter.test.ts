/**
 * Staging gate apply adapter — pure transforms + product engine binding for definition.
 * Status cap: LOCAL ONLY (unit/self-test; no staging mutation).
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'

import {
  produceCanonicalSnapshot,
  SnapshotValidationError,
  validateCanonicalSnapshot,
} from '#/server/canonical-snapshot'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '../..')
const ADAPTER_PATH = join(ROOT, 'qa/fixtures/staging/gates/apply-adapter.mjs')

async function loadAdapter() {
  return import(pathToFileURL(ADAPTER_PATH).href)
}

describe('staging-gates apply-adapter inventory', () => {
  it('adapter module exists and exports core API', async () => {
    const a = await loadAdapter()
    expect(a.ADAPTER_ID).toBe('staging-gates-apply-adapter-v1')
    expect(a.ID_PREFIX).toBe('synth-gate-')
    expect(a.G5_WRITE_UNSUPPORTED_CODE).toBe('G5_WRITE_UNSUPPORTED')
    expect(typeof a.distinctSeedToCanonicalInput).toBe('function')
    expect(typeof a.proveAdditivePrefixUnchanged).toBe('function')
    expect(typeof a.buildApplyStepPlan).toBe('function')
    expect(typeof a.buildG5WritePlan).toBe('function')
    expect(typeof a.runApplyAdapterSelfTests).toBe('function')
  })

  it('seed-policy still requires dual gates and adapter forbids seed-synthetic', async () => {
    const policy = JSON.parse(
      readFileSync(join(ROOT, 'qa/fixtures/staging/gates/seed-policy.json'), 'utf8'),
    ) as {
      requiredEnvForLiveApply: Record<string, string>
      dropDatabase: boolean
    }
    expect(policy.requiredEnvForLiveApply.CAIRN_GATES_APPLY).toBe('1')
    expect(policy.dropDatabase).toBe(false)
    const a = await loadAdapter()
    expect(a.FORBIDDEN_BYPASS_PATHS.some((p: string) => p.includes('seed-synthetic'))).toBe(
      true,
    )
  })
})

describe('apply gates + live pin', () => {
  it('refuses without dual gates + CAIRN_GATES_BIND_LIVE_PIN', async () => {
    const a = await loadAdapter()
    const r = a.checkApplyGates({})
    expect(r.ok).toBe(false)
    expect(r.missing.length).toBeGreaterThanOrEqual(5)
  })

  it('accepts exact dual gates + live pin bind', async () => {
    const a = await loadAdapter()
    const r = a.checkApplyGates({ ...a.REQUIRED_APPLY_ENV })
    expect(r.ok).toBe(true)
  })
})

describe('distinct → canonical + product validate', () => {
  it('maps valid-import seed to produceCanonicalSnapshot without lifecycle fields', async () => {
    const a = await loadAdapter()
    const seed = a.loadValidDistinctSeed()
    const input = a.distinctSeedToCanonicalInput(seed)
    const snap = produceCanonicalSnapshot(input)
    expect(() => validateCanonicalSnapshot(snap)).not.toThrow()
    expect(snap.payload.tasks.every((t: { id: string }) => t.id.startsWith('synth-gate-'))).toBe(
      true,
    )
    expect(
      snap.payload.tasks.every(
        (t: Record<string, unknown>) => t.g5Pass == null && t.lifecycleStage == null,
      ),
    ).toBe(true)
  })

  it('rejects non-prefix task ids', async () => {
    const a = await loadAdapter()
    expect(() =>
      a.distinctSeedToCanonicalInput({
        input: {
          boardId: 'mfs-rebuild',
          snapshotId: 'x',
          sourceRepoId: 'r',
          sourceCommitSha: 'abcdef0',
          projects: [{ id: 'synth-gate-p', name: 'p' }],
          tasks: [{ id: 'evil-task', title: 'nope' }],
        },
      }),
    ).toThrow(/prefix/)
  })
})

describe('additive prefix proof', () => {
  it('passes when non-prefix preserved and gate tasks added', async () => {
    const a = await loadAdapter()
    const before = {
      projects: [{ id: 'live-p', name: 'L' }],
      features: [{ id: 'live-f', projectId: 'live-p' }],
      tasks: [{ id: 'task-next-1', title: 'live' }],
    }
    const seed = {
      projects: [{ id: 'synth-gate-p-a', name: 'Gate A' }],
      features: [{ id: 'synth-gate-f-1', projectId: 'synth-gate-p-a' }],
      tasks: [
        { id: 'synth-gate-t-1', title: 'One' },
        { id: 'synth-gate-t-2', title: 'Two' },
      ],
    }
    const merged = a.mergeAdditiveDefinition(before, seed)
    const proof = a.proveAdditivePrefixUnchanged(before, merged)
    expect(proof.ok).toBe(true)
    expect(merged.tasks.some((t: { id: string }) => t.id === 'task-next-1')).toBe(true)
    expect(merged.tasks.some((t: { id: string }) => t.id === 'synth-gate-t-1')).toBe(true)
  })

  it('fails on board wipe of non-prefix tasks', async () => {
    const a = await loadAdapter()
    const before = {
      projects: [{ id: 'live-p', name: 'L' }],
      features: [],
      tasks: [{ id: 'task-next-1', title: 'live' }],
    }
    const wiped = {
      projects: [],
      features: [],
      tasks: [{ id: 'synth-gate-only', title: 'x' }],
    }
    const proof = a.proveAdditivePrefixUnchanged(before, wiped)
    expect(proof.ok).toBe(false)
    expect(proof.violations.some((v: { kind: string }) => v.kind === 'non_prefix_removed')).toBe(
      true,
    )
  })
})

describe('lifecycle rebind + no fabricated hashes', () => {
  it('rebinds boardRev from live pin and omits receiptHash', async () => {
    const a = await loadAdapter()
    const rebound = a.rebindLifecycleValidToLivePin(null, {
      boardRev: 150,
      lifecycleRev: 4,
      canonicalHash: 'c'.repeat(64),
      taskHash: 't'.repeat(64),
      canonicalSnapshotId: 'live-snap',
      source: 'live',
    })
    expect(rebound.task.boardRev).toBe(150)
    expect(rebound.task.lifecycleRev).toBe(4)
    expect(rebound.evidence.receiptHash).toBeUndefined()
  })

  it('advance_task refuses fabricated prefix/hand hashes', async () => {
    const a = await loadAdapter()
    const rebound = a.rebindLifecycleValidToLivePin(null, {
      boardRev: 10,
      lifecycleRev: 1,
      canonicalHash: 'c'.repeat(64),
      taskHash: 't'.repeat(64),
    })
    expect(() =>
      a.buildAdvanceTaskArgs(rebound, {
        receiptId: 'r1',
        receiptHash: 'synth-gate-handhash',
      }),
    ).toThrow(/fabricated/)
  })

  it('advance_task accepts server-shaped receipt and binds byRunId to author run', async () => {
    const a = await loadAdapter()
    const rebound = a.rebindLifecycleValidToLivePin(null, {
      boardRev: 10,
      lifecycleRev: 1,
      canonicalHash: 'c'.repeat(64),
      taskHash: 't'.repeat(64),
    })
    const args = a.buildAdvanceTaskArgs(rebound, {
      receiptId: 'rcpt-1',
      receiptHash: 'ab'.repeat(32),
    })
    expect(args.receipt.receiptId).toBe('rcpt-1')
    expect(args.receipt.receiptHash).toHaveLength(64)
    expect(args.byRunId).toBe(rebound.authorRun.runId)
    expect(args.byRunId).toMatch(/^synth-gate-/)
  })

  it('register_run includes required MCP targetGate', async () => {
    const a = await loadAdapter()
    const rebound = a.rebindLifecycleValidToLivePin(null, {
      boardRev: 10,
      lifecycleRev: 1,
      canonicalHash: 'c'.repeat(64),
      taskHash: 't'.repeat(64),
    })
    const args = a.buildRegisterRunArgs(rebound)
    expect(args.targetGate).toBe('MAPPING')
    expect(args.runId).toBe(rebound.authorRun.runId)
    expect(args.taskId).toBe(rebound.task.taskId)
    const compat = a.assertMcpDomainArgsCompatible(
      'register_run',
      args,
      a.MCP_REGISTER_RUN_REQUIRED_DOMAIN_KEYS,
    )
    expect(compat.ok).toBe(true)
  })
})

describe('healthz pin-shape fail-closed', () => {
  it('refuses empty / incomplete healthz bodies', async () => {
    const a = await loadAdapter()
    const empty = a.validateHealthzPinShape({})
    expect(empty.ok).toBe(false)
    expect(empty.code).toBe('HEALTHZ_PIN_SHAPE_INVALID')
    expect(empty.missing.length).toBeGreaterThan(0)
  })

  it('accepts minimal HealthzPayload pin fields', async () => {
    const a = await loadAdapter()
    const ok = a.validateHealthzPinShape({
      schemaVersion: 'MFS_HEALTHZ_V1',
      status: 'ok',
      deployedSha: 'd'.repeat(40),
      boardRev: 42,
      lifecycleRev: 7,
      schema: { version: '006', match: true },
      release: { sha: 'd'.repeat(40), match: true },
      canonicalSnapshotId: 'snap-x',
    })
    expect(ok.ok).toBe(true)
    expect(ok.pin.boardRev).toBe(42)
    expect(ok.pin.lifecycleRev).toBe(7)
  })

  it('mutation pin refuses missing canonicalHash', async () => {
    const a = await loadAdapter()
    const bad = a.validateLivePinForMutation({ boardRev: 1, lifecycleRev: 2 })
    expect(bad.ok).toBe(false)
    expect(bad.code).toBe('GATES_LIVE_PIN_INCOMPLETE')
    const good = a.validateLivePinForMutation({
      boardRev: 1,
      lifecycleRev: 2,
      canonicalHash: 'e'.repeat(64),
    })
    expect(good.ok).toBe(true)
  })
})

describe('MCP schema compatibility vs board-mcp.ts', () => {
  it('register_run / advance_task / submit_stage_evidence domain keys match product source', async () => {
    const a = await loadAdapter()
    const mcpSrc = readFileSync(join(ROOT, 'src/server/board-mcp.ts'), 'utf8')

    const regRequired = a.extractMcpToolRequiredKeysFromSource(mcpSrc, 'register_run')
    const advRequired = a.extractMcpToolRequiredKeysFromSource(mcpSrc, 'advance_task')
    const subRequired = a.extractMcpToolRequiredKeysFromSource(mcpSrc, 'submit_stage_evidence')

    // Product must still require the fields that failed prior verify residual
    expect(regRequired).toContain('targetGate')
    expect(regRequired).toContain('runId')
    expect(regRequired).toContain('taskId')
    expect(regRequired).toContain('agentId')
    expect(regRequired).toContain('model')
    expect(advRequired).toContain('byRunId')
    expect(advRequired).toContain('id')
    expect(advRequired).toContain('toStage')
    expect(subRequired).toContain('byRunId')
    expect(subRequired).toContain('taskId')

    // Adapter constants must not drift behind product domain requirements
    for (const k of a.MCP_REGISTER_RUN_REQUIRED_DOMAIN_KEYS) {
      expect(regRequired).toContain(k)
    }
    for (const k of a.MCP_ADVANCE_TASK_REQUIRED_DOMAIN_KEYS) {
      expect(advRequired).toContain(k)
    }
    for (const k of a.MCP_SUBMIT_STAGE_EVIDENCE_REQUIRED_DOMAIN_KEYS) {
      expect(subRequired).toContain(k)
    }

    // Built args must satisfy product required domain keys (excl. envelope)
    const rebound = a.rebindLifecycleValidToLivePin(null, {
      boardRev: 9,
      lifecycleRev: 2,
      canonicalHash: 'f'.repeat(64),
      taskHash: '1'.repeat(64),
    })
    const regArgs = a.buildRegisterRunArgs(rebound, { expectedEntityRev: 0 })
    const domainReg = a.MCP_REGISTER_RUN_REQUIRED_DOMAIN_KEYS
    expect(a.assertMcpDomainArgsCompatible('register_run', regArgs, domainReg).ok).toBe(true)
    // Every non-envelope required key from product must be present on built args
    // (envelope keys expectedEntityRev/expectedBoardRev/idempotencyKey filled by driver)
    const envelopeKeys = new Set([
      'expectedEntityRev',
      'entityExpectedRev',
      'expectedRev',
      'expectedBoardRev',
      'canonicalHash',
      'subjectHash',
      'idempotencyKey',
    ])
    for (const k of regRequired) {
      if (envelopeKeys.has(k)) continue
      expect(regArgs[k as keyof typeof regArgs]).toBeTruthy()
    }

    const advArgs = a.buildAdvanceTaskArgs(
      rebound,
      { receiptId: 'r-live', receiptHash: 'ab'.repeat(32) },
      { byRunId: rebound.authorRun.runId, registeredRunId: rebound.authorRun.runId },
    )
    expect(a.assertMcpDomainArgsCompatible('advance_task', advArgs, a.MCP_ADVANCE_TASK_REQUIRED_DOMAIN_KEYS).ok).toBe(
      true,
    )
    for (const k of advRequired) {
      if (envelopeKeys.has(k)) continue
      if (k === 'receipt' || k === 'evidence' || k === 'role' || k === 'verdict') continue
      if (k === 'expectedLifecycleRev' || k === 'expectedTaskHash') continue
      if (k === 'productionApprovalId' || k === 'authorRunId' || k === 'verifierRunId') continue
      if (k === 'requireOppositeModel' || k === 'commitSha' || k === 'deployReceipt' || k === 'blocker')
        continue
      // required non-optional product keys
      if (['boardId', 'id', 'toStage', 'byRunId'].includes(k)) {
        expect(advArgs[k as keyof typeof advArgs]).toBeTruthy()
      }
    }
    expect(advArgs.byRunId).toBe(rebound.authorRun.runId)

    const subArgs = a.buildSubmitStageEvidenceArgs(rebound, {
      byRunId: rebound.authorRun.runId,
    })
    expect(
      a.assertMcpDomainArgsCompatible(
        'submit_stage_evidence',
        subArgs,
        a.MCP_SUBMIT_STAGE_EVIDENCE_REQUIRED_DOMAIN_KEYS,
      ).ok,
    ).toBe(true)
    expect(subArgs).not.toHaveProperty('receiptHash')
  })
})

describe('G5 fail closed + reconciler bind + cleanup audit', () => {
  it('G5 write plan is unsupported and never PASS', async () => {
    const a = await loadAdapter()
    const g5 = a.buildG5WritePlan()
    expect(g5.supported).toBe(false)
    expect(g5.code).toBe('G5_WRITE_UNSUPPORTED')
    expect(g5.residual_gaps).toContain('g5_durable_write_surface_missing')
  })

  it('reconcileDryApplyBinding matches hashes', async () => {
    const a = await loadAdapter()
    const h = 'd'.repeat(64)
    expect(a.reconcileDryApplyBinding({ dryRunHash: h }, { dryRunHash: h }).ok).toBe(true)
    expect(
      a.reconcileDryApplyBinding({ dryRunHash: h }, { dryRunHash: 'e'.repeat(64) }).code,
    ).toBe('DRY_RUN_HASH_MISMATCH')
  })

  it('cleanup audit preserves non-prefix before/after', async () => {
    const a = await loadAdapter()
    const before = {
      projects: [{ id: 'live-p', name: 'L' }],
      features: [],
      tasks: [
        { id: 'task-next-1', title: 'live' },
        { id: 'synth-gate-t-1', title: 'gate' },
      ],
    }
    const after = {
      projects: [{ id: 'live-p', name: 'L' }],
      features: [],
      tasks: [{ id: 'task-next-1', title: 'live' }],
    }
    const audit = a.buildCleanupAuditReadback(before, after)
    expect(audit.nonPrefixPreserved).toBe(true)
    expect(audit.before.tasks).toEqual(['task-next-1'])
    expect(audit.after.tasks).toEqual(['task-next-1'])
  })
})

describe('apply step plan + self-tests', () => {
  it('buildApplyStepPlan is non-mutating and includes dryRun then apply + g5 fail closed', async () => {
    const a = await loadAdapter()
    const plan = a.buildApplyStepPlan({
      expectedSha: 'a'.repeat(40),
      packHash: 'b'.repeat(64),
    })
    expect(plan.stagingMutation).toBe(false)
    expect(plan.steps.some((s: { id: string }) => s.id === 'definition_dry_run')).toBe(true)
    expect(plan.steps.some((s: { id: string }) => s.id === 'definition_apply')).toBe(true)
    expect(
      plan.steps.some(
        (s: { id: string; failClosed?: boolean }) => s.id === 'g5_write' && s.failClosed,
      ),
    ).toBe(true)
    expect(plan.residual_gaps).toContain('g5_durable_write_unsupported')
    expect(plan.forbiddenBypass.some((p: string) => p.includes('seed-synthetic'))).toBe(true)
  })

  it('runApplyAdapterSelfTests passes', async () => {
    const a = await loadAdapter()
    const self = a.runApplyAdapterSelfTests()
    expect(self.ok).toBe(true)
    expect(self.passCount).toBe(self.checkCount)
    expect(self.failures).toEqual([])
  })

  it('idempotency keys unique per step', async () => {
    const a = await loadAdapter()
    const k1 = a.buildDeterministicIdempotencyKey({
      expectedSha: 'a'.repeat(40),
      packHash: 'p',
      step: 'definition_apply',
    })
    const k2 = a.buildDeterministicIdempotencyKey({
      expectedSha: 'a'.repeat(40),
      packHash: 'p',
      step: 'lifecycle_advance_task',
    })
    expect(k1).not.toBe(k2)
    expect(k1.startsWith('gates-apply:')).toBe(true)
  })
})

describe('classification drafts never carry fabricated receipt hashes', () => {
  it('drafts set durableReceipt null', async () => {
    const a = await loadAdapter()
    const drafts = a.classificationMatrixToTaskDrafts()
    expect(drafts.length).toBeGreaterThan(0)
    expect(drafts.every((d: { durableReceipt: unknown }) => d.durableReceipt === null)).toBe(
      true,
    )
  })
})

describe('dup seeds still reject via product snapshot', () => {
  it('dup-task-id seed fails validation when produced', async () => {
    const a = await loadAdapter()
    const dups = a.loadDistinctRejectSeeds()
    const dupTask = dups.find((d: { name: string }) => d.name === 'dup-task-id.seed.json')
    expect(dupTask).toBeTruthy()
    // Adapter maps as-is; product validator rejects duplicates
    let threw = false
    try {
      const input = a.distinctSeedToCanonicalInput(dupTask)
      const snap = produceCanonicalSnapshot(input)
      validateCanonicalSnapshot(snap)
    } catch (e) {
      threw = e instanceof SnapshotValidationError || Boolean((e as Error)?.message)
    }
    expect(threw).toBe(true)
  })
})
