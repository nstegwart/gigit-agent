/**
 * Deterministic unit tests for qa/perf/scale-fixture-loader.mjs.
 * LOCAL ONLY — pure self-test path; no shared staging load, no network required.
 */
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'

const ROOT = process.cwd()
const LOADER = join(ROOT, 'qa/perf/scale-fixture-loader.mjs')

async function loadLoader() {
  return import(pathToFileURL(LOADER).href)
}

describe('scale-fixture-loader (AC-PERF scale harness)', () => {
  it('exports stable schema + default isolated board', async () => {
    const m = await loadLoader()
    expect(m.SCALE_LOADER_SCHEMA).toBe('MFS_SCALE_FIXTURE_LOADER_V1')
    expect(m.DEFAULT_SCALE_BOARD_ID).toBe('mfs-rebuild-scale')
    expect(m.SHARED_STAGING_BOARD_ID).toBe('mfs-rebuild')
    expect(m.SHARED_STAGING_DB_NAME).toBe('cairn_tm_v3_staging')
  })

  it('prepareScalePayload yields 1000/200/20/100 OPEN decisions with deterministic ids', async () => {
    const m = await loadLoader()
    const a = m.prepareScalePayload({ boardId: m.DEFAULT_SCALE_BOARD_ID })
    const b = m.prepareScalePayload({ boardId: m.DEFAULT_SCALE_BOARD_ID })
    expect(a.ok).toBe(true)
    expect(a.counts).toEqual({
      tasks: 1000,
      runs: 200,
      accounts: 20,
      decisions: 100,
      openDecisions: 100,
    })
    expect(a.payload.taskHash).toBe(b.payload.taskHash)
    expect(a.payload.tasks[0].id).toBe('scale-task-0001')
    expect(a.payload.runs[0].id).toBe('scale-run-0001')
    expect(a.payload.accounts[0].accountIdMasked).toMatch(/\*\*\*\*/)
    expect(a.payload.decisions.every((d: { status: string }) => d.status === 'OPEN')).toBe(
      true,
    )
    expect(a.payload.syntheticOnly).toBe(true)
    expect(a.payload.productionDerived).toBe(false)
  })

  it('assertSyntheticPayload refuses production-derived and unmasked accounts', async () => {
    const m = await loadLoader()
    expect(
      m.assertSyntheticPayload({
        productionDerived: true,
        syntheticOnly: false,
        tasks: [],
        runs: [],
        accounts: [],
        decisions: [],
      }).code,
    ).toBe('PRODUCTION_DERIVED')
    expect(
      m.assertSyntheticPayload({
        productionDerived: false,
        syntheticOnly: true,
        tasks: [],
        runs: [],
        accounts: [{ id: '1', email: 'x@y.z', accountIdMasked: 'm' }],
        decisions: [],
      }).code,
    ).toBe('UNMASKED_ACCOUNT')
  })

  it('assertScaleLoadAllowed refuses unapproved, shared board/DB, prod host, staging host', async () => {
    const m = await loadLoader()
    expect(
      m.assertScaleLoadAllowed({
        approved: false,
        boardId: m.DEFAULT_SCALE_BOARD_ID,
        host: '127.0.0.1',
        allowLocalHost: true,
      }).code,
    ).toBe('APPROVAL_REQUIRED')

    expect(
      m.assertScaleLoadAllowed({
        approved: '1',
        boardId: m.SHARED_STAGING_BOARD_ID,
        host: '127.0.0.1',
        allowLocalHost: true,
      }).code,
    ).toBe('SHARED_OR_FORBIDDEN_BOARD')

    expect(
      m.assertScaleLoadAllowed({
        approved: '1',
        boardId: m.DEFAULT_SCALE_BOARD_ID,
        dbName: m.SHARED_STAGING_DB_NAME,
        host: '127.0.0.1',
        allowLocalHost: true,
      }).code,
    ).toBe('SHARED_OR_FORBIDDEN_DB')

    expect(
      m.assertScaleLoadAllowed({
        approved: '1',
        boardId: m.DEFAULT_SCALE_BOARD_ID,
        host: 'task-manager.mfsdev.net',
      }).code,
    ).toBe('PRODUCTION_HOST')

    expect(
      m.assertScaleLoadAllowed({
        approved: '1',
        boardId: m.DEFAULT_SCALE_BOARD_ID,
        host: 'cairn-tm-v3-mysql',
      }).code,
    ).toBe('SHARED_STAGING_HOST')
  })

  it('assertScaleLoadAllowed refuses local without explicit allowLocalHost', async () => {
    const m = await loadLoader()
    const denied = m.assertScaleLoadAllowed({
      approved: '1',
      boardId: m.DEFAULT_SCALE_BOARD_ID,
      host: '127.0.0.1',
      allowLocalHost: false,
      dbName: 'cairn_tm_synth_scale_unit',
    })
    expect(denied.ok).toBe(false)
    expect(denied.code).toBe('LOCAL_HOST_NOT_ALLOWED')
  })

  it('assertScaleLoadAllowed allows local disposable when approved + allowLocal', async () => {
    const m = await loadLoader()
    const ok = m.assertScaleLoadAllowed({
      approved: '1',
      boardId: m.DEFAULT_SCALE_BOARD_ID,
      host: '127.0.0.1',
      allowLocalHost: true,
      dbName: 'cairn_tm_synth_scale_unit',
    })
    expect(ok.ok).toBe(true)
    expect(ok.hostClass).toBe('LOCAL')
    expect(ok.provenance?.mode).toBe('SYNTHETIC')
  })

  it('runDisposableScaleProof source does not auto-bypass local allow', async () => {
    const { readFileSync } = await import('node:fs')
    const src = readFileSync(LOADER, 'utf8')
    // Residual fixed A17: disposable proof must not force allowLocal via || true
    expect(src).not.toMatch(
      /CAIRN_SCALE_LOAD_ALLOW_LOCAL\)\s*\|\|\s*true/,
    )
    expect(src).not.toMatch(/forces allowLocal for LOCAL hosts/)
  })

  it('mapRunState maps fixture statuses to control-plane run states', async () => {
    const m = await loadLoader()
    expect(m.mapRunState('done')).toBe('SUCCEEDED')
    expect(m.mapRunState('stalled')).toBe('STALE')
    expect(m.mapRunState('running')).toBe('RUNNING')
    expect(m.mapRunState('queued')).toBe('QUEUED')
  })

  it('dryRunScaleLoad does not require approval and reports wouldMutate=false', async () => {
    const m = await loadLoader()
    const dry = m.dryRunScaleLoad({ boardId: m.DEFAULT_SCALE_BOARD_ID })
    expect(dry.ok).toBe(true)
    expect(dry.wouldMutate).toBe(false)
    expect(dry.prepared.counts.tasks).toBe(1000)
    expect(dry.loadGateWithoutApproval.ok).toBe(false)
    expect(dry.loadGateWithoutApproval.code).toBe('APPROVAL_REQUIRED')
  })

  it('runScaleLoaderSelfTests pass with zero failures', async () => {
    const m = await loadLoader()
    const r = m.runScaleLoaderSelfTests()
    const failed = r.results.filter((x: { pass: boolean; name: string }) => !x.pass)
    expect(r.ok, failed.map((f: { name: string }) => f.name).join(', ')).toBe(true)
    expect(r.failCount).toBe(0)
    expect(r.passCount).toBeGreaterThanOrEqual(20)
  })
})
