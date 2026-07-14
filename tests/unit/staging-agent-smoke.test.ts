/**
 * Unit / contract coverage for staging-agent-smoke live-pin bind.
 * LOCAL ONLY — no --real, no staging mutation, no token output.
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

async function loadBootstrap() {
  const url = pathToFileUrl(path.join(ROOT, 'qa/e2e/lib/control-plane-bootstrap.mjs'))
  return import(url.href)
}

describe('staging-agent-smoke live-pin bind (contract)', () => {
  it('extractCompleteLivePin fails closed when required fields missing', async () => {
    const s = await loadSmokeLib()
    const r = s.extractCompleteLivePin({
      canonicalSnapshotId: 'snap',
      boardRev: 10,
      lifecycleRev: 2,
      // canonicalHash absent
    })
    expect(r.ok).toBe(false)
    expect(r.code).toBe('INCOMPLETE_LIVE_PIN')
    expect(r.missing).toContain('canonicalHash')
  })

  it('extractCompleteLivePin never invents taskHash when runtime omits it', async () => {
    const s = await loadSmokeLib()
    const r = s.extractCompleteLivePin({
      canonicalSnapshotId: 'snap',
      canonicalHash: 'h'.repeat(64),
      boardRev: 172,
      lifecycleRev: 40,
    })
    expect(r.ok).toBe(true)
    expect(r.pin.taskHash).toBeUndefined()
    const withTask = s.extractCompleteLivePin({
      ...r.pin,
      taskHash: 'runtime-task-hash',
    })
    expect(withTask.pin.taskHash).toBe('runtime-task-hash')
  })

  it('resolveBindLivePin accepts legacy STAGING_BIND_LIVE_BOARD_REV and STAGING_BIND_LIVE_PIN', async () => {
    const s = await loadSmokeLib()
    expect(s.resolveBindLivePin({}, { STAGING_BIND_LIVE_BOARD_REV: '1' })).toBe(true)
    expect(s.resolveBindLivePin({}, { STAGING_BIND_LIVE_PIN: '1' })).toBe(true)
    expect(s.resolveBindLivePin({ bindLivePin: false }, { STAGING_BIND_LIVE_PIN: '1' })).toBe(
      false,
    )
    expect(s.resolveBindLivePin({ bindLiveBoardRev: true }, {})).toBe(true)
    expect(s.resolveBindLivePin({}, {})).toBe(false)
  })

  it('bindLivePin=false: fixture authority → PIN_PARITY_MISMATCH; no auth publish', async () => {
    const s = await loadSmokeLib()
    const c = await loadContract()
    const { createSyntheticRootPrincipal } = await loadBootstrap()
    const pin = c.loadStagingPin()
    const ids = c.buildSyntheticSmokeIds({ smokeRunId: 'unit-bind-off', boardId: 'mfs-rebuild' })
    const principal = createSyntheticRootPrincipal({ boardId: 'mfs-rebuild' })
    const expectedSha = 'e'.repeat(40)
    const { fetchImpl, calls } = s.createStagingSmokeMockFetch({ pin, ids, expectedSha })
    let code: string | null = null
    try {
      await s.runStagingAgentLifecycleSmoke({
        baseUrl: 'http://127.0.0.1:9',
        mode: 'self-test',
        pin,
        ids,
        bearer: principal.bearer,
        expectedSha,
        fetchImpl,
        runtimePin: {
          ok: true,
          httpStatus: 200,
          canonicalSnapshotId: 'synth-canonical-authority-live-v1',
          canonicalHash: 'f'.repeat(64),
          boardRev: 172,
          lifecycleRev: 40,
        },
        bindLivePin: false,
        failClosed: true,
        initialize: false,
      })
    } catch (e: unknown) {
      code = (e as { code?: string })?.code ?? null
    }
    expect(code).toBe('PIN_PARITY_MISMATCH')
    expect(
      calls.some(
        (x: { name: string | null; hasAuth: boolean }) =>
          x.name === 'publish_dispatch_plan' && x.hasAuth,
      ),
    ).toBe(false)
    principal.bearer = ''
  })

  it('bindLivePin=true: dispatch CAS uses full live pin; no invented taskHash; redacts bearer', async () => {
    const s = await loadSmokeLib()
    const c = await loadContract()
    const { createSyntheticRootPrincipal } = await loadBootstrap()
    const fixturePin = c.loadStagingPin()
    const livePin = {
      canonicalSnapshotId: 'synth-canonical-authority-live-v1',
      canonicalHash: 'b'.repeat(64),
      boardRev: 172,
      lifecycleRev: 40,
    }
    const ids = c.buildSyntheticSmokeIds({ smokeRunId: 'unit-bind-on', boardId: 'mfs-rebuild' })
    const principal = createSyntheticRootPrincipal({ boardId: 'mfs-rebuild' })
    const expectedSha = 'e'.repeat(40)
    const { fetchImpl, calls } = s.createStagingSmokeMockFetch({
      pin: livePin,
      ids,
      expectedSha,
      initialMemoryBoardRev: livePin.boardRev,
    })
    const receipt = await s.runStagingAgentLifecycleSmoke({
      baseUrl: 'http://127.0.0.1:9',
      mode: 'self-test',
      boardId: 'mfs-rebuild',
      pin: fixturePin,
      ids,
      bearer: principal.bearer,
      expectedSha,
      fetchImpl,
      runtimePin: { ok: true, httpStatus: 200, ...livePin },
      bindLivePin: true,
      now: '2026-07-13T00:00:00.000Z',
      failClosed: true,
      initialize: false,
    })
    expect(receipt.ok).toBe(true)
    expect(receipt.pin.pinSource).toBe('live_runtime')
    expect(receipt.pin.boardRev).toBe(172)
    expect(receipt.pin.taskHash).toBeNull()
    expect(receipt.steps.livePinBind?.ok).toBe(true)
    expect(receipt.steps.livePinBind?.bound?.hasTaskHash).toBe(false)
    const pub = calls.find(
      (x: { name: string | null; hasAuth: boolean; args?: Record<string, unknown> }) =>
        x.name === 'publish_dispatch_plan' && x.hasAuth,
    )
    expect(pub?.expectedBoardRev).toBe(172)
    expect(pub?.args?.canonicalSnapshotId).toBe(livePin.canonicalSnapshotId)
    expect(pub?.args?.canonicalHash).toBe(livePin.canonicalHash)
    expect(JSON.stringify(receipt)).not.toContain(principal.bearer)
    principal.bearer = ''
  })

  it('bindLivePin=true incomplete live pin → INCOMPLETE_LIVE_PIN before mutation', async () => {
    const s = await loadSmokeLib()
    const c = await loadContract()
    const { createSyntheticRootPrincipal } = await loadBootstrap()
    const pin = c.loadStagingPin()
    const ids = c.buildSyntheticSmokeIds({ smokeRunId: 'unit-inc', boardId: 'mfs-rebuild' })
    const principal = createSyntheticRootPrincipal({ boardId: 'mfs-rebuild' })
    const expectedSha = 'e'.repeat(40)
    const { fetchImpl, calls } = s.createStagingSmokeMockFetch({ pin, ids, expectedSha })
    let code: string | null = null
    try {
      await s.runStagingAgentLifecycleSmoke({
        baseUrl: 'http://127.0.0.1:9',
        mode: 'self-test',
        pin,
        ids,
        bearer: principal.bearer,
        expectedSha,
        fetchImpl,
        runtimePin: {
          ok: true,
          httpStatus: 200,
          canonicalSnapshotId: 'live-snap',
          boardRev: 172,
          lifecycleRev: 40,
          // canonicalHash missing
        },
        bindLivePin: true,
        failClosed: true,
        initialize: false,
      })
    } catch (e: unknown) {
      code = (e as { code?: string })?.code ?? null
    }
    expect(code).toBe('INCOMPLETE_LIVE_PIN')
    expect(
      calls.some(
        (x: { name: string | null; hasAuth: boolean }) =>
          x.name === 'publish_dispatch_plan' && x.hasAuth,
      ),
    ).toBe(false)
    principal.bearer = ''
  })

  it('rebindDispatchToLivePin sets full pin fields + planHash', async () => {
    const s = await loadSmokeLib()
    const c = await loadContract()
    const pin = c.loadStagingPin()
    const ids = c.buildSyntheticSmokeIds({ smokeRunId: 'unit-rebind-full', boardId: 'mfs-rebuild' })
    const plan = c.buildDispatchPlanArgs({
      pin,
      ids,
      now: '2026-07-13T00:00:00.000Z',
    })
    const prevHash = plan.planHash
    const live = {
      canonicalSnapshotId: 'live-snap-id',
      canonicalHash: 'c'.repeat(64),
      boardRev: 99,
      lifecycleRev: 11,
    }
    s.rebindDispatchToLivePin(plan, live)
    expect(plan.canonicalSnapshotId).toBe(live.canonicalSnapshotId)
    expect(plan.canonicalHash).toBe(live.canonicalHash)
    expect(plan.expectedBoardRev).toBe(99)
    expect(plan.planHash).not.toBe(prevHash)
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

  it('stale hash/rev still fails closed after one recovery when memory keeps advancing', async () => {
    const s = await loadSmokeLib()
    const c = await loadContract()
    const { createSyntheticRootPrincipal } = await loadBootstrap()
    const pin = c.loadStagingPin()
    const ids = c.buildSyntheticSmokeIds({ smokeRunId: 'unit-stale2', boardId: 'mfs-rebuild' })
    const principal = createSyntheticRootPrincipal({ boardId: 'mfs-rebuild' })
    const expectedSha = 'e'.repeat(40)
    const { fetchImpl, calls } = s.createStagingSmokeMockFetch({
      pin,
      ids,
      expectedSha,
      initialMemoryBoardRev: Number(pin.boardRev) + 1,
      forcePublishStaleCount: 2,
      advanceMemoryOnForcedPublishStale: true,
    })
    let code: string | null = null
    try {
      await s.runStagingAgentLifecycleSmoke({
        baseUrl: 'http://127.0.0.1:9',
        mode: 'self-test',
        pin,
        ids,
        bearer: principal.bearer,
        expectedSha,
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
        bindLivePin: false,
        failClosed: true,
        initialize: false,
      })
    } catch (e: unknown) {
      code = (e as { code?: string })?.code ?? null
    }
    // One bounded recovery then fail — never infinite retry
    const pubs = calls.filter(
      (x: { name: string | null; hasAuth: boolean }) =>
        x.name === 'publish_dispatch_plan' && x.hasAuth,
    )
    expect(pubs.length).toBeLessThanOrEqual(2)
    expect(code).toBe('PUBLISH_FAIL')
    principal.bearer = ''
  })
})
