/**
 * Staging gate fixture pack — pure contract + product engine binding.
 * Status cap: LOCAL ONLY (unit/self-test; no staging mutation).
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import {
  evaluateClassification,
  isProductDenominatorMember,
  isTrackedWork,
} from '#/server/classification'
import {
  evaluateG5,
  G5_REQUIRED_DOMAINS,
  makePassingDomain,
} from '#/server/g5'
import {
  produceCanonicalSnapshot,
  SnapshotValidationError,
  validateCanonicalSnapshot,
} from '#/server/canonical-snapshot'
import { evaluateCapacityPolicy } from '#/server/account-sync'
import {
  computePriorityAllocation,
  type PriorityPacket,
} from '#/server/rollup-v3'
import type {
  G5DomainRecord,
  PinnedRevisionTuple,
  TaskClassificationRecord,
} from '#/lib/control-plane-types'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '../..')
const GATES = join(ROOT, 'qa/fixtures/staging/gates')

function readJson<T>(rel: string): T {
  return JSON.parse(readFileSync(join(GATES, rel), 'utf8')) as T
}

function pinTuple(): PinnedRevisionTuple {
  const pin = readJson<{
    canonicalSnapshotId: string
    canonicalHash: string
    boardRev: number
    lifecycleRev: number
    taskHash: string
  }>('pin.json')
  return {
    canonicalSnapshotId: pin.canonicalSnapshotId,
    canonicalHash: pin.canonicalHash,
    boardRev: pin.boardRev,
    lifecycleRev: pin.lifecycleRev,
    taskHash: pin.taskHash,
  }
}

type ClassRow = {
  taskId: string
  taskClass: TaskClassificationRecord['taskClass']
  disposition: TaskClassificationRecord['disposition']
  receiptMode: string
  controlPlaneTargetGate?: string
  controlPlaneGateVerifiedPass?: boolean
  expect: {
    contributesToProductReadiness: boolean
    isFullyClassifiedValid: boolean
    isClassificationRepair: boolean
    isOutsideTrackedWork: boolean
    isTrackedWork: boolean
    isProductDenominatorMember: boolean
    blockReason: 'DATA_INTEGRITY' | null
    reasonsIncludes?: string[]
  }
}

function buildReceipt(
  row: ClassRow,
  pin: PinnedRevisionTuple,
): TaskClassificationRecord['receipt'] {
  if (row.receiptMode === 'missing') return null
  const base = {
    receiptId: `synth-gate-rcpt-${row.taskId}`,
    receiptHash: 'abcdef0123456789abcdef01',
    taskId: row.taskId,
    taskClass: row.taskClass,
    disposition: row.disposition,
    canonicalSnapshotId: pin.canonicalSnapshotId,
    canonicalHash: pin.canonicalHash,
    taskHash: pin.taskHash,
    boardRev: pin.boardRev,
    lifecycleRev: pin.lifecycleRev,
    issuedAt: '2026-07-13T00:00:00.000Z',
  }
  if (row.receiptMode === 'stale_board_rev') return { ...base, boardRev: pin.boardRev - 1 }
  if (row.receiptMode === 'expired') return { ...base, expiresAt: '2020-01-01T00:00:00.000Z' }
  return base
}

describe('staging-gates contract inventory', () => {
  it('MANIFEST is synthetic-only schema 006 with all packets', () => {
    const m = readJson<{
      fixtureId: string
      syntheticOnly: boolean
      productionDerived: boolean
      schemaVersionExpected: string
      packets: string[]
      idPrefix: string
    }>('MANIFEST.json')
    expect(m.fixtureId).toBe('staging-gate-fixtures-v1')
    expect(m.syntheticOnly).toBe(true)
    expect(m.productionDerived).toBe(false)
    expect(m.schemaVersionExpected).toBe('006')
    expect(m.idPrefix).toBe('synth-gate-')
    for (const p of [
      'classification',
      'distinct',
      'lifecycle',
      'g5',
      'capacity',
      'priority',
      'reconciler',
    ]) {
      expect(m.packets).toContain(p)
    }
  })

  it('seed-policy refuses live apply without dual gates and never DROP DATABASE', () => {
    const p = readJson<{
      defaultMode: string
      dropDatabase: boolean
      requiredEnvForLiveApply: Record<string, string>
      syntheticOnly: boolean
    }>('seed-policy.json')
    expect(p.defaultMode).toBe('self-test')
    expect(p.dropDatabase).toBe(false)
    expect(p.syntheticOnly).toBe(true)
    expect(p.requiredEnvForLiveApply.CAIRN_STAGING_SEED_APPROVED).toBe('1')
    expect(p.requiredEnvForLiveApply.CAIRN_GATES_APPLY).toBe('1')
  })
})

describe('AC-CLASS matrix via gate fixtures', () => {
  const pin = pinTuple()
  const matrix = readJson<{ rows: ClassRow[] }>('classification/matrix.json')

  it('covers full PRODUCT/CONTROL_PLANE/UNCLASSIFIED × ACTIVE/HOLD/EXCLUDE/UNCLASSIFIED grid + stale/missing', () => {
    const classes = ['PRODUCT', 'CONTROL_PLANE', 'UNCLASSIFIED'] as const
    const disps = ['ACTIVE', 'HOLD', 'EXCLUDE', 'UNCLASSIFIED'] as const
    const pairs = new Set(matrix.rows.map((r) => `${r.taskClass}×${r.disposition}`))
    for (const c of classes) {
      for (const d of disps) {
        expect(pairs.has(`${c}×${d}`), `missing cross-product cell ${c}×${d}`).toBe(true)
      }
    }
    expect(pairs.has('CONTROL_PLANE×HOLD')).toBe(true)
    expect(pairs.has('UNCLASSIFIED×UNCLASSIFIED')).toBe(true)
    expect(matrix.rows.some((r) => r.receiptMode === 'stale_board_rev')).toBe(true)
    expect(matrix.rows.some((r) => r.receiptMode === 'missing')).toBe(true)
    expect(matrix.rows.some((r) => r.receiptMode === 'expired')).toBe(true)
  })

  it('each row matches evaluateClassification / tracked / product denom expectations', () => {
    for (const row of matrix.rows) {
      const record: TaskClassificationRecord = {
        taskId: row.taskId,
        taskClass: row.taskClass,
        disposition: row.disposition,
        receipt: buildReceipt(row, pin),
        controlPlaneTargetGate: row.controlPlaneTargetGate ?? null,
        controlPlaneGateVerifiedPass: row.controlPlaneGateVerifiedPass ?? false,
      }
      const ev = evaluateClassification(record, pin, {
        now: '2026-07-13T12:00:00.000Z',
      })
      expect(ev.contributesToProductReadiness, row.taskId).toBe(
        row.expect.contributesToProductReadiness,
      )
      expect(ev.isFullyClassifiedValid, row.taskId).toBe(row.expect.isFullyClassifiedValid)
      expect(ev.isClassificationRepair, row.taskId).toBe(row.expect.isClassificationRepair)
      expect(ev.isOutsideTrackedWork, row.taskId).toBe(row.expect.isOutsideTrackedWork)
      expect(isTrackedWork(ev), row.taskId).toBe(row.expect.isTrackedWork)
      expect(isProductDenominatorMember(ev), row.taskId).toBe(
        row.expect.isProductDenominatorMember,
      )
      expect(ev.blockReason, row.taskId).toBe(row.expect.blockReason)
      if (row.expect.reasonsIncludes) {
        for (const r of row.expect.reasonsIncludes) {
          expect(ev.reasons, row.taskId).toContain(r)
        }
      }
    }
  })
})

describe('AC-COUNT distinct reject fixtures', () => {
  const seeds = [
    'distinct/valid-import.seed.json',
    'distinct/dup-fc.seed.json',
    'distinct/dup-node.seed.json',
    'distinct/dup-dependency.seed.json',
    'distinct/dup-task-id.seed.json',
  ] as const

  for (const rel of seeds) {
    it(`seed ${rel}`, () => {
      const seed = readJson<{
        expect: { ok: boolean; rejectCode: string | null }
        input: Parameters<typeof produceCanonicalSnapshot>[0]
      }>(rel)
      if (seed.expect.ok) {
        const snap = produceCanonicalSnapshot(seed.input)
        expect(() => validateCanonicalSnapshot(snap)).not.toThrow()
        expect(snap.manifest.distinctCounts.tasks).toBeGreaterThan(0)
      } else {
        try {
          const snap = produceCanonicalSnapshot(seed.input)
          validateCanonicalSnapshot(snap)
          throw new Error(`expected reject ${seed.expect.rejectCode} but validation passed`)
        } catch (e) {
          expect(e).toBeInstanceOf(SnapshotValidationError)
          expect((e as SnapshotValidationError).code).toBe(seed.expect.rejectCode)
        }
      }
    })
  }
})

describe('AC-LIFE-05 G5 honest statuses from fixtures', () => {
  const pin = pinTuple()
  const g5 = readJson<{
    requiredDomains: string[]
    scenarios: Array<{
      id: string
      empty?: boolean
      statusForAll?: string
      programmaticEvidence?: boolean
      independentVerifier?: boolean
      selfVerify?: boolean
      staleBoardRev?: boolean
      mixed?: { defaultStatus: string; overrides: Record<string, string> }
      expect: {
        g5Pass: boolean
        allDomainPass?: boolean
        missingDomainsCount?: number
        reasonIncludes?: string
      }
    }>
  }>('g5/domains.json')

  it('declares exact nine required domains', () => {
    expect(g5.requiredDomains).toEqual([...G5_REQUIRED_DOMAINS])
  })

  function domainsFor(
    scenario: (typeof g5.scenarios)[number],
  ): G5DomainRecord[] {
    if (scenario.empty) return []
    const out: G5DomainRecord[] = []
    for (const domainId of G5_REQUIRED_DOMAINS) {
      let status = (scenario.statusForAll ?? 'NOT_STARTED') as G5DomainRecord['status']
      if (scenario.mixed) {
        status = (scenario.mixed.overrides[domainId] ??
          scenario.mixed.defaultStatus) as G5DomainRecord['status']
      }
      if (status === 'PASS' && scenario.programmaticEvidence) {
        const base = makePassingDomain(domainId, pin)
        if (scenario.selfVerify) {
          out.push({
            ...base,
            verifierRunId: base.authorRunId,
          })
        } else if (scenario.staleBoardRev) {
          out.push({
            ...base,
            boardRev: pin.boardRev - 1,
            expectedRev: pin.boardRev - 1,
            subjectRevision: pin.boardRev - 1,
          })
        } else {
          out.push(base)
        }
      } else {
        out.push({
          domainId,
          scope: 'board',
          required: true,
          status,
          evidenceReceiptIds: status === 'PASS' ? [`ev-${domainId}`] : [],
          evidenceReceiptHashes: status === 'PASS' ? [`hash-${domainId}`] : [],
          verifierRunId: status === 'PASS' ? `run-v-${domainId}` : null,
          authorRunId: status === 'PASS' ? `run-a-${domainId}` : null,
          subjectRevision: pin.boardRev,
          subjectHash: pin.canonicalHash,
          expectedRev: pin.boardRev,
          boardRev: pin.boardRev,
          subjectLifecycleRev: pin.lifecycleRev,
          programmaticEvidence: Boolean(scenario.programmaticEvidence) && status === 'PASS',
          independentVerifier: Boolean(scenario.independentVerifier),
        })
      }
    }
    return out
  }

  for (const scenario of g5.scenarios) {
    it(`scenario ${scenario.id}`, () => {
      const domains = domainsFor(scenario)
      const ev = evaluateG5(domains, pin)
      expect(ev.g5Pass).toBe(scenario.expect.g5Pass)
      if (scenario.expect.missingDomainsCount != null) {
        expect(ev.missingDomains.length).toBe(scenario.expect.missingDomainsCount)
      }
      if (scenario.expect.allDomainPass != null) {
        expect(ev.domainResults.every((r) => r.pass)).toBe(scenario.expect.allDomainPass)
      }
      if (scenario.expect.reasonIncludes) {
        expect(
          ev.domainResults.some((r) => r.reason?.includes(scenario.expect.reasonIncludes!)),
        ).toBe(true)
      }
    })
  }
})

describe('AC-CAP capacity fixtures', () => {
  const cap = readJson<{
    scenarios: Array<{
      id: string
      input: Parameters<typeof evaluateCapacityPolicy>[0]
      expect: Record<string, unknown>
    }>
  }>('capacity/matrix.json')

  for (const scenario of cap.scenarios) {
    it(`capacity ${scenario.id}`, () => {
      const r = evaluateCapacityPolicy(scenario.input)
      const exp = scenario.expect
      if ('usableCapacity' in exp) expect(r.usableCapacity).toBe(exp.usableCapacity)
      if ('dispatchMode' in exp) expect(r.dispatchMode).toBe(exp.dispatchMode)
      if ('belowFloor' in exp) expect(r.belowFloor).toBe(exp.belowFloor)
      if ('floorMet' in exp) expect(r.floorMet).toBe(exp.floorMet)
      if ('belowFloorReasonMatch' in exp) {
        expect(String(r.belowFloorReason ?? '')).toMatch(
          String(exp.belowFloorReasonMatch),
        )
      }
      if ('sparkLive' in exp) expect(r.sparkLive).toBe(exp.sparkLive)
      if ('solLive' in exp) expect(r.solLive).toBe(exp.solLive)
      if ('grokLive' in exp) expect(r.grokLive).toBe(exp.grokLive)
      if ('grokMajority' in exp) expect(r.grokMajority).toBe(exp.grokMajority)
      if ('combinedLiveMax' in exp) {
        expect(r.combinedLive).toBeLessThanOrEqual(Number(exp.combinedLiveMax))
      }
      if (Array.isArray(exp.limitingReasonsIncludes)) {
        for (const code of exp.limitingReasonsIncludes as string[]) {
          expect(r.limitingReasons.some((x) => x.includes(code))).toBe(true)
        }
      }
    })
  }
})

describe('AC-PRIORITY fixtures', () => {
  const pin = pinTuple()
  const pri = readJson<{
    scenarios: Array<{
      id: string
      input: {
        membershipTaskIds: string[]
        packets: Array<PriorityPacket & { excluded?: boolean }>
      }
      expect: {
        membershipDenominator?: number
        priorityCapacityShare?: number | null
        majorityAllocationPass: boolean | null
        frontierState: string
        allClosureCapacity?: number
        priorityClosureCapacity?: number
        reason?: string
      }
    }>
  }>('priority/matrix.json')

  function tasksForMembership(ids: string[]): Array<{
    taskId: string
    classification: TaskClassificationRecord
    priorityMembership: boolean
  }> {
    return ids.map((taskId) => ({
      taskId,
      priorityMembership: true,
      classification: {
        taskId,
        taskClass: 'PRODUCT',
        disposition: 'ACTIVE',
        receipt: {
          receiptId: `rcpt-${taskId}`,
          receiptHash: 'abcdef0123456789abcdef01',
          taskId,
          taskClass: 'PRODUCT',
          disposition: 'ACTIVE',
          canonicalSnapshotId: pin.canonicalSnapshotId,
          canonicalHash: pin.canonicalHash,
          taskHash: pin.taskHash,
          boardRev: pin.boardRev,
          lifecycleRev: pin.lifecycleRev,
          issuedAt: '2026-07-13T00:00:00.000Z',
        },
      },
    }))
  }

  for (const scenario of pri.scenarios) {
    it(`priority ${scenario.id}`, () => {
      const result = computePriorityAllocation({
        pin,
        tasks: tasksForMembership(scenario.input.membershipTaskIds),
        packets: scenario.input.packets,
      })
      if (scenario.expect.membershipDenominator != null) {
        expect(result.membershipDenominator).toBe(scenario.expect.membershipDenominator)
      }
      expect(result.majorityAllocationPass).toBe(scenario.expect.majorityAllocationPass)
      expect(result.frontierState).toBe(scenario.expect.frontierState)
      if (scenario.expect.priorityCapacityShare === null) {
        expect(result.priorityCapacityShare).toBeNull()
      } else if (typeof scenario.expect.priorityCapacityShare === 'number') {
        expect(result.priorityCapacityShare).toBeCloseTo(
          scenario.expect.priorityCapacityShare,
          10,
        )
      }
      if (scenario.expect.allClosureCapacity != null) {
        expect(result.allClosureCapacity).toBe(scenario.expect.allClosureCapacity)
      }
      if (scenario.expect.priorityClosureCapacity != null) {
        expect(result.priorityClosureCapacity).toBe(scenario.expect.priorityClosureCapacity)
      }
      if (scenario.expect.reason != null) {
        expect(result.reason).toBe(scenario.expect.reason)
      }
    })
  }
})
