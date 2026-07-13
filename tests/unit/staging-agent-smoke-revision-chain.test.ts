/**
 * Direct unit coverage for staging smoke board-rev chaining helpers
 * (STALE_REVISION recovery + post-mutation expectedBoardRev rebinding).
 * No server / no tunnel.
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

async function loadSmokeLib() {
  const libUrl = pathToFileUrl(path.join(ROOT, 'qa/e2e/lib/staging-agent-smoke.mjs'))
  return import(libUrl.href)
}

async function loadContract() {
  const fixtureUrl = pathToFileUrl(path.join(ROOT, 'qa/fixtures/staging/contract.mjs'))
  return import(fixtureUrl.href)
}

describe('staging-agent-smoke revision chain (direct)', () => {
  it('extracts currentBoardRev only from safe STALE metadata', async () => {
    const s = await loadSmokeLib()
    expect(
      s.extractStaleCurrentBoardRev({
        ok: false,
        code: 'STALE_REVISION',
        details: { expectedBoardRev: 3, currentBoardRev: 8 },
      }),
    ).toBe(8)
    expect(
      s.extractStaleCurrentBoardRev({
        code: 'STALE_REVISION',
        currentBoardRev: 4,
      }),
    ).toBe(4)
    expect(s.extractStaleCurrentBoardRev({ code: 'STALE_REVISION' })).toBeNull()
    expect(s.extractStaleCurrentBoardRev(null)).toBeNull()
  })

  it('rebinds dispatch expectedBoardRev + recomputes planHash', async () => {
    const s = await loadSmokeLib()
    const c = await loadContract()
    const pin = c.loadStagingPin()
    const ids = c.buildSyntheticSmokeIds({ smokeRunId: 'unit-rev', boardId: 'mfs-rebuild' })
    const plan = c.buildDispatchPlanArgs({
      pin,
      ids,
      now: '2026-07-13T00:00:00.000Z',
    })
    const prev = plan.planHash
    s.rebindDispatchExpectedBoardRev(plan, 42)
    expect(plan.expectedBoardRev).toBe(42)
    for (const it of plan.items) {
      expect(it.expectedBoardRev).toBe(42)
    }
    expect(plan.planHash).not.toBe(prev)
    expect(plan.planHash).toBe(
      c.computePlanHash({
        boardId: plan.boardId,
        planId: plan.planId,
        planVersion: plan.planVersion,
        canonicalSnapshotId: plan.canonicalSnapshotId,
        canonicalHash: plan.canonicalHash,
        items: plan.items,
      }),
    )
  })

  it('mock lifecycle: stale publish recovers once; sync bump feeds register', async () => {
    const s = await loadSmokeLib()
    const c = await loadContract()
    const pin = c.loadStagingPin()
    const ids = c.buildSyntheticSmokeIds({ smokeRunId: 'unit-chain', boardId: 'mfs-rebuild' })
    const root = s.createSyntheticRootPrincipal
      ? null
      : null
    // createSyntheticRootPrincipal lives on control-plane-bootstrap; use smoke self-test path
    const { createSyntheticRootPrincipal } = await import(
      pathToFileUrl(path.join(ROOT, 'qa/e2e/lib/control-plane-bootstrap.mjs')).href
    )
    const principal = createSyntheticRootPrincipal({ boardId: 'mfs-rebuild' })
    const liveMemory = Number(pin.boardRev) + 3
    const { fetchImpl, calls } = s.createStagingSmokeMockFetch({
      pin,
      ids,
      expectedSha: 'e'.repeat(40),
      initialMemoryBoardRev: liveMemory,
    })
    const receipt = await s.runStagingAgentLifecycleSmoke({
      baseUrl: 'http://127.0.0.1:9',
      mode: 'self-test',
      boardId: 'mfs-rebuild',
      pin,
      ids,
      bearer: principal.bearer,
      expectedSha: 'e'.repeat(40),
      fetchImpl,
      runtimePin: {
        ok: true,
        httpStatus: 200,
        canonicalSnapshotId: pin.canonicalSnapshotId,
        canonicalHash: pin.canonicalHash,
        boardRev: pin.boardRev,
        lifecycleRev: pin.lifecycleRev,
        taskHash: pin.taskHash,
      },
      skipPinCheck: false,
      bindLiveBoardRev: false,
      now: '2026-07-13T00:00:00.000Z',
      failClosed: true,
      initialize: false,
    })
    expect(receipt.ok).toBe(true)
    const pubs = calls.filter(
      (x: { name: string | null; hasAuth: boolean }) =>
        x.name === 'publish_dispatch_plan' && x.hasAuth,
    )
    expect(pubs).toHaveLength(2)
    expect(pubs[0].expectedBoardRev).toBe(Number(pin.boardRev))
    expect(pubs[1].expectedBoardRev).toBe(liveMemory)
    const reg = calls.find(
      (x: { name: string | null; hasAuth: boolean }) => x.name === 'register_run' && x.hasAuth,
    )
    // publish bumps liveMemory→+1, sync bumps →+2
    expect(reg?.expectedBoardRev).toBe(liveMemory + 2)
    principal.bearer = ''
    void root
  })
})
