/**
 * FP-C contract: control-plane schema+seed helper self-tests + optional live iso proof.
 * harness-contract project (no product auth server required for pure path).
 *
 * Live disposable MySQL path runs when CAIRN_FP_C_LIVE=1 (or always tries and soft-skips
 * if MySQL unreachable — pure self-test still hard-fails on logic bugs).
 */
import { expect, test } from '@playwright/test'

import {
  FP_C_REQUIRED_VERSIONS,
  assertFpCTargetDb,
  buildFpCAccountSnapshotRecord,
  buildFpCRunRecord,
  loadMigrationFile,
  runDisposableFpCProof,
  runFpCSchemaSeedSelfTests,
} from '../../../qa/e2e/lib/control-plane-schema-seed.mjs'

test.describe('FP-C control-plane schema+seed contract', () => {
  test('pure self-tests: migrations load, refuse ambient/staging, fixture shapes', () => {
    const r = runFpCSchemaSeedSelfTests()
    expect(r.ok, JSON.stringify(r.results)).toBe(true)
    expect(FP_C_REQUIRED_VERSIONS).toEqual(['001', '002', '004', '005'])
    const m005 = loadMigrationFile('005')
    expect(m005.statements.some((s: string) => /control_plane_runs/i.test(s))).toBe(true)
  })

  test('assertFpCTargetDb refuses ambient and staging names', () => {
    expect(() => assertFpCTargetDb('cairn_taskmanager')).toThrow(/FAIL-CLOSED|refusing/i)
    expect(() => assertFpCTargetDb('cairn_tm_v3_staging')).toThrow(/FAIL-CLOSED|refusing/i)
    expect(() => assertFpCTargetDb('cairn_tm_e2e_fpc_ok_test')).not.toThrow()
  })

  test('fixture run + account shapes are masked product contracts', () => {
    const run = buildFpCRunRecord('ibils')
    expect(run.runId).toBeTruthy()
    expect(run.state).toBe('RUNNING')
    expect(run.agentId).toBeTruthy()
    const snap = buildFpCAccountSnapshotRecord('mfs-rebuild')
    expect(snap.accounts.length).toBeGreaterThanOrEqual(1)
    for (const a of snap.accounts) {
      expect(a.maskedAccountId).toMatch(/^acc_/)
      expect(a).not.toHaveProperty('token')
      expect(a).not.toHaveProperty('secret')
      expect(a).not.toHaveProperty('password')
    }
  })

  test('disposable MySQL: migrate×2 idempotent + seed run/account counts', async () => {
    // Live proof when MySQL available. Hard-fail only if CAIRN_FP_C_LIVE=1 forced.
    const forceLive =
      process.env.CAIRN_FP_C_LIVE === '1' || process.env.CAIRN_FP_C_LIVE === 'true'
    try {
      const proof = await runDisposableFpCProof({ slug: 'fpctest' })
      expect(proof.ok, JSON.stringify(proof)).toBe(true)
      expect(proof.secondSkippedAll).toBe(true)
      expect(proof.counts.runs.length).toBeGreaterThanOrEqual(1)
      expect(proof.counts.accounts.length).toBeGreaterThanOrEqual(1)
      for (const v of FP_C_REQUIRED_VERSIONS) {
        expect(proof.counts.migrations).toContain(v)
      }
    } catch (e) {
      if (forceLive) throw e
      const msg = String((e as Error)?.message || e)
      // Soft-skip only connectivity classes — never swallow logic failures in force mode.
      if (/ECONNREFUSED|ENOTFOUND|ER_ACCESS|connect/i.test(msg)) {
        test.skip(true, `MySQL unreachable: ${msg}`)
        return
      }
      throw e
    }
  })
})
