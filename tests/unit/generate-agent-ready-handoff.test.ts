/**
 * Dedicated contract tests for qa/e2e/flows/generate-agent-ready-handoff.mjs
 * LOCAL ONLY — pure evaluation + self-test; no Downloads write, no live mutation.
 */
import { createRequire } from 'node:module'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const ROOT = process.cwd()

function pathToFileUrl(p: string) {
  const { pathToFileURL } = require('node:url') as typeof import('node:url')
  return pathToFileURL(p)
}

async function loadGenerator() {
  const url = pathToFileUrl(
    path.join(ROOT, 'qa/e2e/flows/generate-agent-ready-handoff.mjs'),
  )
  return import(url.href)
}

describe('generate-agent-ready-handoff (fail-closed)', () => {
  it('self-test suite passes (embedded fixtures)', async () => {
    const g = await loadGenerator()
    const suite = g.runSelfTests()
    const failed = suite.results.filter((r: { ok: boolean }) => !r.ok)
    expect(failed, JSON.stringify(failed)).toEqual([])
    expect(suite.ok).toBe(true)
  })

  it('refuses productDenominator=0 even with PRODUCT next', async () => {
    const g = await loadGenerator()
    const fx = g.buildSelfTestFixtures()
    const e = g.evaluateAgentReadySurfaces(fx.productDenominator0)
    expect(e.ready).toBe(false)
    expect(e.status).toBe('NOT READY')
    expect(e.refuseCodes).toContain(g.REFUSE_CODE.PRODUCT_DENOMINATOR_ZERO)
  })

  it('refuses SYNTH task-next-1 / synth plan / synth pin', async () => {
    const g = await loadGenerator()
    const fx = g.buildSelfTestFixtures()
    const e = g.evaluateAgentReadySurfaces(fx.synthNext)
    expect(e.ready).toBe(false)
    expect(e.refuseCodes).toContain(g.REFUSE_CODE.SYNTH_PLAN_OR_TASK)
    expect(e.refuseCodes).toContain(g.REFUSE_CODE.PIN_SYNTHETIC)
    const text = g.renderHandoffText(e, { mode: 'unit' })
    expect(text).toContain('STATUS: NOT READY')
    expect(text).not.toMatch(/^STATUS: READY$/m)
  })

  it('refuses UNCLASSIFIED selected task', async () => {
    const g = await loadGenerator()
    const fx = g.buildSelfTestFixtures()
    const e = g.evaluateAgentReadySurfaces(fx.unclassified)
    expect(e.ready).toBe(false)
    expect(e.refuseCodes).toContain(g.REFUSE_CODE.UNCLASSIFIED)
  })

  it('refuses empty NEXT / NO_ACTIVE_PLAN', async () => {
    const g = await loadGenerator()
    const fx = g.buildSelfTestFixtures()
    const e = g.evaluateAgentReadySurfaces(fx.noNext)
    expect(e.ready).toBe(false)
    expect(e.refuseCodes).toContain(g.REFUSE_CODE.NO_REAL_NEXT)
  })

  it('refuses stale plan expectedBoardRev vs live pin', async () => {
    const g = await loadGenerator()
    const fx = g.buildSelfTestFixtures()
    const e = g.evaluateAgentReadySurfaces(fx.stale)
    expect(e.ready).toBe(false)
    expect(e.refuseCodes).toContain(g.REFUSE_CODE.STALE_PIN)
  })

  it('emits real start packet only when authorized non-SYNTH plan exists', async () => {
    const g = await loadGenerator()
    const fx = g.buildSelfTestFixtures()
    const e = g.evaluateAgentReadySurfaces(fx.ready)
    expect(e.ready).toBe(true)
    expect(e.status).toBe('READY')
    expect(e.refuseCodes).toEqual([])
    expect(e.agentContract?.taskId).toBe('T-AFF-001')
    expect(e.agentContract?.targetGate).toBe('SPEC_READY')
    expect(e.agentContract?.soleSource).toBe('active_dispatch_plan')
    expect(e.agentContract?.collisionScopeLockIds).toEqual(['scope:T-AFF-001'])
    const text = g.renderHandoffText(e, { mode: 'unit' })
    expect(text).toContain('STATUS: READY')
    expect(text).toContain('T-AFF-001')
    expect(text).toContain('SPEC_READY')
    expect(text).toContain('plan-mfs-real-001')
    expect(text).not.toMatch(/Bearer\s+[A-Za-z0-9]/i)
  })

  it('external Downloads write is fail-closed without dual approval', async () => {
    const g = await loadGenerator()
    const denied = g.assertExternalWriteAllowed({
      write: true,
      approve: false,
      outPath: g.DEFAULT_EXTERNAL_HANDOFF_PATH,
      env: {},
    })
    expect(denied.ok).toBe(false)
    expect(denied.code).toBe(g.REFUSE_CODE.EXTERNAL_WRITE_DENIED)

    const noWriteFlag = g.assertExternalWriteAllowed({
      write: false,
      approve: true,
      outPath: g.DEFAULT_EXTERNAL_HANDOFF_PATH,
      env: {},
    })
    expect(noWriteFlag.ok).toBe(false)

    const envApprove = g.assertExternalWriteAllowed({
      write: true,
      approve: false,
      outPath: g.DEFAULT_EXTERNAL_HANDOFF_PATH,
      env: { HANDOFF_EXTERNAL_WRITE_APPROVED: '1' },
    })
    expect(envApprove.ok).toBe(true)

    const badPath = g.assertExternalWriteAllowed({
      write: true,
      approve: true,
      outPath: '/tmp/evil-handoff.txt',
      env: {},
    })
    expect(badPath.ok).toBe(false)
  })

  it('isSyntheticIdentity detects task-next and synth ids only', async () => {
    const g = await loadGenerator()
    expect(g.isSyntheticIdentity('task-next-1')).toBe(true)
    expect(g.isSyntheticIdentity('synth-c3-r2d-snap-001')).toBe(true)
    expect(g.isSyntheticIdentity('T-AFF-001')).toBe(false)
    expect(g.isSyntheticIdentity('plan-mfs-real-001')).toBe(false)
  })

  it('CLI main --self-test exits 0', async () => {
    const g = await loadGenerator()
    const result = await g.main(['--self-test'], {})
    expect(result.exitCode).toBe(0)
    expect(result.mode).toBe('self-test')
    expect(result.suite?.ok).toBe(true)
  })
})
