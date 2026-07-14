/**
 * C3-R5S: authoritative pin + claim/stale projection + DecisionV3 redaction.
 * Support evidence only (LOCAL ONLY) — no browser/MCP.
 */
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'

import type { ClassificationReceipt } from '#/lib/control-plane-types'
import type { Decision, Run, WorkTask } from '#/lib/types'
import {
  buildControlCenterAggregationFromSources,
  mapLegacyDecisionToV3,
  mapWorkTaskToControlCenterInput,
  parsePersistedBoardRevisionRow,
  SAFE_CANONICAL_HASH_RE,
} from '#/server/control-center-ui-adapter'
import {
  envelopePinIdentity,
  projectAllSurfaces,
  projectDecisions,
  projectWork,
  type ControlCenterPin,
} from '#/server/control-center-ui'
import {
  lightFromRow,
  parseValidClaimState,
  projectLightTaskControlPlane,
} from '#/server/tasks-store'

const AUTH_HASH = 'a1b2c3d4e5f60718293a4b5c6d7e8f901234567890abcdef1234567890ab'
const AUTH_SNAP = 'synth-c3-r2d-snap-001'
const LIVE_BOARD_HASH = 'live_board_hash_content_zzzz'

const PIN: ControlCenterPin = {
  boardId: 'mfs-rebuild',
  canonicalSnapshotId: AUTH_SNAP,
  canonicalHash: AUTH_HASH,
  taskHash: 'taskhash_bbbbbbbbbbbb',
  boardRev: 7,
  lifecycleRev: 3,
  generatedAt: '2026-07-13T12:00:00.000Z',
  freshnessAgeSeconds: 0,
  stale: false,
  staleReason: null,
}

function boardTaskHash(ids: string[]): string {
  return createHash('sha256')
    .update([...ids].sort().join('|') || 'empty-tasks')
    .digest('hex')
}

function makeReceipt(
  taskId: string,
  pin: Pick<
    ControlCenterPin,
    'canonicalSnapshotId' | 'canonicalHash' | 'taskHash' | 'boardRev' | 'lifecycleRev'
  >,
  overrides: Partial<ClassificationReceipt> = {},
): ClassificationReceipt {
  return {
    receiptId: `rcp-${taskId}`,
    receiptHash: 'abcdef0123456789abcdef01',
    taskId,
    taskClass: 'PRODUCT',
    disposition: 'ACTIVE',
    membershipPortfolioId: 'SALES_WEB_RELATED_BACKEND',
    membershipProofHash: 'abcdef0123456789ccccdddd',
    membershipProductLine: 'sales-rebuild',
    canonicalSnapshotId: pin.canonicalSnapshotId,
    canonicalHash: pin.canonicalHash,
    taskHash: pin.taskHash,
    boardRev: pin.boardRev,
    lifecycleRev: pin.lifecycleRev,
    issuedAt: '2026-07-13T00:00:00.000Z',
    ...overrides,
  }
}

function bareTask(id: string, extra: Partial<WorkTask> = {}): WorkTask {
  return {
    id,
    title: `Task ${id}`,
    dependencies: [],
    impacts: [],
    checkpoints: [],
    ...extra,
  }
}

function classifiedTask(
  id: string,
  pin: Pick<
    ControlCenterPin,
    'canonicalSnapshotId' | 'canonicalHash' | 'taskHash' | 'boardRev' | 'lifecycleRev'
  >,
  extra: Partial<WorkTask> = {},
): WorkTask {
  const t = bareTask(id, extra) as WorkTask & {
    classification: {
      taskClass: 'PRODUCT'
      disposition: 'ACTIVE'
      receipt: ClassificationReceipt
    }
  }
  t.classification = {
    taskClass: 'PRODUCT',
    disposition: 'ACTIVE',
    receipt: makeReceipt(id, pin),
  }
  return t
}

const emptyRaw = {
  id: 'mfs-rebuild',
  name: 'MFS',
  projects: [{ id: 'p1', nama: 'P1' }],
  features: [{ id: 'f1', nama: 'F1', projectId: 'p1', fase: 'build', checklist: [] }],
  runs: [] as Run[],
  decisions: [] as Decision[],
  log: [] as unknown[],
  collab: { comments: {}, activity: [] as unknown[] },
}

/** Minimal non-stale account-sync fixture (typed via never at call sites that accept CcReadModel|Snapshot). */
const nonStaleAccountSync = {
  boardId: 'mfs-rebuild',
  sourceRevision: 1,
  generatedAt: PIN.generatedAt,
  generatedAtMs: Date.parse(PIN.generatedAt),
  accounts: [] as never[],
  readbackSurfaces: {
    mcp: { sourceRevision: 1, generatedAt: PIN.generatedAt },
    api: { sourceRevision: 1, generatedAt: PIN.generatedAt },
    ui: { sourceRevision: 1, generatedAt: PIN.generatedAt },
    ops: { sourceRevision: 1, generatedAt: PIN.generatedAt },
  },
  publishedAtMs: Date.parse(PIN.generatedAt),
  lastPeriodicHealthAtMs: Date.parse(PIN.generatedAt),
  stale: false as const,
  staleReason: null,
  usableCapacity: 1,
  capacity: {
    sparkLive: 0,
    sparkCap: 10,
    solLive: 0,
    solCap: 10,
    grokLive: 1,
    grokPerAccount: [] as never[],
    grokMajority: false,
    healthyGrokUsableCapacity: 1,
    sparkUsableCapacity: 0,
    solUsableCapacity: 0,
    otherUsableCapacity: 0,
    combinedLive: 1,
    combinedCap: 200,
    floorTarget: 60,
    floorMet: false,
    belowFloor: true,
    belowFloorReason: null as string | null,
    usableCapacity: 1,
    dispatchAllowed: true,
    // CapacityDispatchMode = OPEN | GROK_ONLY | BLOCKED (LIMITED is invalid)
    dispatchMode: 'OPEN' as const,
    nonGrokAssignmentAllowed: true,
    grokAssignmentAllowed: true,
    limitingReasons: [] as string[],
    failSafeActions: [],
    policy: {
      sparkMax: 10,
      solMax: 10,
      grokStartPerAccount: 5,
      grokMaxPerAccount: 10,
      combinedMax: 200,
      floorMin: 60,
      physicalSlotsDisplayOnly: true,
      neverAccountsAll: true,
      neverFiller: true,
      cpuBoundedDrainMaxReduceSlots: 10,
    },
  },
  entityRev: 1,
}

// ---------------------------------------------------------------------------
// A — authoritative pin
// ---------------------------------------------------------------------------
describe('C3-R5S Acceptance A — authoritative pin', () => {
  it('parsePersistedBoardRevisionRow: complete row validates revs + hash + snapshot', () => {
    const parsed = parsePersistedBoardRevisionRow({
      board_rev: 7,
      lifecycle_rev: 3,
      subject_hash: AUTH_HASH,
      canonical_snapshot_id: AUTH_SNAP,
    })
    expect(parsed).not.toBeNull()
    expect(parsed!.complete).toBe(true)
    expect(parsed!.boardRev).toBe(7)
    expect(parsed!.lifecycleRev).toBe(3)
    expect(parsed!.subjectHash).toBe(AUTH_HASH)
    expect(parsed!.canonicalSnapshotId).toBe(AUTH_SNAP)
    expect(parsed!.incompleteReason).toBeNull()
    expect(SAFE_CANONICAL_HASH_RE.test(AUTH_HASH)).toBe(true)
  })

  it('parsePersistedBoardRevisionRow: invalid hash / partial → fail closed incomplete', () => {
    const badHash = parsePersistedBoardRevisionRow({
      board_rev: 1,
      lifecycle_rev: 0,
      subject_hash: 'not-a-hex!!!',
      canonical_snapshot_id: AUTH_SNAP,
    })
    expect(badHash!.complete).toBe(false)
    expect(badHash!.subjectHash).toBeNull()
    expect(badHash!.incompleteReason).toContain('subject_hash_invalid_shape')

    const missingSnap = parsePersistedBoardRevisionRow({
      board_rev: 1,
      lifecycle_rev: 0,
      subject_hash: AUTH_HASH,
      canonical_snapshot_id: null,
    })
    expect(missingSnap!.complete).toBe(false)
    expect(missingSnap!.canonicalSnapshotId).toBeNull()
    expect(missingSnap!.incompleteReason).toContain('canonical_snapshot_id_absent')

    const badRev = parsePersistedBoardRevisionRow({
      board_rev: -1,
      lifecycle_rev: 0,
      subject_hash: AUTH_HASH,
      canonical_snapshot_id: AUTH_SNAP,
    })
    expect(badRev).toBeNull()
  })

  it('persisted authority wins over boardHash; all nine surfaces share pin; mismatch blocks', () => {
    const taskIds = ['task-auth-ok', 'task-mismatch']
    const taskHash = boardTaskHash(taskIds)
    const authPin = {
      canonicalSnapshotId: AUTH_SNAP,
      canonicalHash: AUTH_HASH,
      taskHash,
      boardRev: 7,
      lifecycleRev: 3,
    }
    const ok = classifiedTask('task-auth-ok', authPin, {
      lifecycleStage: 'PROD_READY',
      status: 'done',
      claimState: 'STALE',
    })
    // Receipt bound to LIVE board hash — must fail closed under authority pin
    const mismatch = classifiedTask('task-mismatch', {
      ...authPin,
      canonicalHash: LIVE_BOARD_HASH,
      canonicalSnapshotId: `cc-mfs-rebuild-${LIVE_BOARD_HASH.slice(0, 16)}`,
    }, { lifecycleStage: 'BUILT' })

    const agg = buildControlCenterAggregationFromSources({
      boardId: 'mfs-rebuild',
      raw: emptyRaw as never,
      tasks: [ok, mismatch],
      opsAccounts: [],
      runs: [],
      boardContentHash: LIVE_BOARD_HASH,
      boardRev: 7,
      lifecycleRev: 3,
      authorityCanonicalHash: AUTH_HASH,
      authorityCanonicalSnapshotId: AUTH_SNAP,
      pinAuthorityComplete: true,
      now: PIN.generatedAt,
      accountSyncSnapshot: nonStaleAccountSync as never,
    })

    // Authority pin wins — not live boardContentHash
    expect(agg.pin.canonicalHash).toBe(AUTH_HASH)
    expect(agg.pin.canonicalHash).not.toBe(LIVE_BOARD_HASH)
    expect(agg.pin.canonicalSnapshotId).toBe(AUTH_SNAP)
    expect(agg.pin.boardRev).toBe(7)
    expect(agg.pin.lifecycleRev).toBe(3)
    expect(agg.sectionErrors.some((e) => e.code === 'PIN_AUTHORITY_FALLBACK')).toBe(false)

    const surfaces = projectAllSurfaces(agg)
    const ids = [
      'overview',
      'work',
      'priority',
      'projects',
      'features',
      'agents',
      'ops',
      'decisions',
      'evidence',
    ] as const
    expect(ids).toHaveLength(9)
    const pin0 = envelopePinIdentity(surfaces.overview)
    for (const key of ids) {
      const env = surfaces[key]
      const id = envelopePinIdentity(env)
      expect(id.canonicalHash).toBe(AUTH_HASH)
      expect(id.canonicalSnapshotId).toBe(AUTH_SNAP)
      expect(id.boardRev).toBe(7)
      expect(id.lifecycleRev).toBe(3)
      expect(id).toEqual(pin0)
    }

    // Matching receipt not integrity-blocked; mismatched receipt is
    expect(agg.assignmentsByTaskId.get('task-auth-ok')?.blockReason).not.toBe('DATA_INTEGRITY')
    expect(agg.assignmentsByTaskId.get('task-auth-ok')?.primary).toBe('DONE')
    expect(agg.assignmentsByTaskId.get('task-mismatch')?.primary).toBe('BLOCKED')
    expect(agg.assignmentsByTaskId.get('task-mismatch')?.blockReason).toBe('DATA_INTEGRITY')
  })

  it('incomplete authority documents fallback; does not treat pin as verified authority', () => {
    const agg = buildControlCenterAggregationFromSources({
      boardId: 'mfs-rebuild',
      raw: emptyRaw as never,
      tasks: [bareTask('t1')],
      opsAccounts: [],
      runs: [],
      boardContentHash: LIVE_BOARD_HASH,
      boardRev: 1,
      lifecycleRev: 0,
      pinAuthorityComplete: false,
      now: PIN.generatedAt,
    })
    expect(agg.pin.canonicalHash).toBe(LIVE_BOARD_HASH)
    expect(agg.sectionErrors.some((e) => e.code === 'PIN_AUTHORITY_FALLBACK')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// B — bounded task control-plane projection
// ---------------------------------------------------------------------------
describe('C3-R5S Acceptance B — claim / stale control-plane projection', () => {
  it('parseValidClaimState only trusts six enums; invalid → undefined', () => {
    expect(parseValidClaimState('VALID_CURRENT')).toBe('VALID_CURRENT')
    expect(parseValidClaimState('STALE')).toBe('STALE')
    expect(parseValidClaimState('ORPHAN')).toBe('ORPHAN')
    expect(parseValidClaimState('EXPIRED')).toBe('EXPIRED')
    expect(parseValidClaimState('FENCED')).toBe('FENCED')
    expect(parseValidClaimState('BEYOND_STAGE')).toBe('BEYOND_STAGE')
    expect(parseValidClaimState('NONE')).toBeUndefined()
    expect(parseValidClaimState('bogus')).toBeUndefined()
    expect(parseValidClaimState(null)).toBeUndefined()
  })

  it('lightFromRow projects claim/stale/decision fields from data_* extracts', () => {
    const row = lightFromRow({
      id: 'task-stale-1',
      title: 'Stale',
      summary: { checkpoints: [], dependencies: [], impacts: [] },
      lifecycle_stage: 'IMPL_IN_PROGRESS',
      data_claim_state: 'STALE',
      data_stale_data_source: true,
      data_stale_dispatch_plan: false,
      data_product_stage_mode: 'STAGE_2',
      data_p0_blocker: false,
      data_target_gate: 'PROD_READY',
      data_evidence_path: 'qa/e2e/out/runtime/synth/stale.md',
      data_has_blocking_decision: false,
    })
    expect(row.claimState).toBe('STALE')
    expect(row.staleDataSource).toBe(true)
    expect(row.staleDispatchPlan).toBe(false)
    expect(row.productStageMode).toBe('STAGE_2')
    expect(row.targetGate).toBe('PROD_READY')
    expect(row.evidence_path).toBe('qa/e2e/out/runtime/synth/stale.md')

    const invalid = projectLightTaskControlPlane({ dataClaimState: 'NOT_A_CLAIM' })
    expect(invalid.claimState).toBeUndefined()
  })

  it('mapWorkTask ignores task selectedForNextDispatch; only opts from dispatch plan', () => {
    // Runtime pollution of non-field selectedForNextDispatch — must not be trusted.
    const t = {
      ...bareTask('t-next'),
      selectedForNextDispatch: true,
    } as WorkTask
    const withoutPlan = mapWorkTaskToControlCenterInput(t, PIN)
    expect(withoutPlan.selectedForNextDispatch).toBe(false)
    const withPlan = mapWorkTaskToControlCenterInput(t, PIN, { selectedForNextDispatch: true })
    expect(withPlan.selectedForNextDispatch).toBe(true)
  })

  it('bucket truth: DONE+stale exception, ONGOING, RECON, STALE overlay, UNCLASSIFIED once', () => {
    const taskIds = [
      'task-done-1',
      'task-ongoing-1',
      'task-recon-1',
      'task-stale-1',
      'task-missing-proof-1',
    ]
    const taskHash = boardTaskHash(taskIds)
    const authPin = {
      canonicalSnapshotId: AUTH_SNAP,
      canonicalHash: AUTH_HASH,
      taskHash,
      boardRev: 7,
      lifecycleRev: 3,
    }

    const done = classifiedTask('task-done-1', authPin, {
      lifecycleStage: 'PROD_READY',
      status: 'done',
      claimState: 'STALE',
      evidence_path: 'qa/e2e/out/runtime/synth/done-evidence.md',
    })
    const ongoing = classifiedTask('task-ongoing-1', authPin, {
      lifecycleStage: 'IMPL_IN_PROGRESS',
      status: 'in_progress',
      claimState: 'VALID_CURRENT',
      evidence_path: 'qa/e2e/out/runtime/synth/ongoing-evidence.md',
    })
    const recon = classifiedTask('task-recon-1', authPin, {
      lifecycleStage: 'QA_IN_PROGRESS',
      status: 'in_progress',
      claimState: 'ORPHAN',
    })
    const stale = classifiedTask('task-stale-1', authPin, {
      lifecycleStage: 'IMPL_IN_PROGRESS',
      status: 'in_progress',
      claimState: 'STALE',
      staleDataSource: true,
    })
    const missing = bareTask('task-missing-proof-1', {
      lifecycleStage: 'IMPL_IN_PROGRESS',
      mappingPct: 80,
      status: 'in_progress',
    })

    const run: Run = {
      id: 'run-synth-ongoing',
      agent: 'run-synth-ongoing',
      agentType: 'claude',
      model: 'grok-4.5',
      effort: 'high',
      task: 'task-ongoing-1',
      taskId: 'task-ongoing-1',
      status: 'running',
      started: '2026-07-13T11:00:00.000Z',
      updated: '2026-07-13T11:50:00.000Z',
      account: 'acc-001',
      evidencePath: 'qa/e2e/out/runtime/synth/ongoing-evidence.md',
    }

    const agg = buildControlCenterAggregationFromSources({
      boardId: 'mfs-rebuild',
      raw: {
        ...emptyRaw,
        runs: [run],
      } as never,
      tasks: [done, ongoing, recon, stale, missing],
      opsAccounts: [],
      runs: [run],
      boardContentHash: LIVE_BOARD_HASH,
      boardRev: 7,
      lifecycleRev: 3,
      authorityCanonicalHash: AUTH_HASH,
      authorityCanonicalSnapshotId: AUTH_SNAP,
      pinAuthorityComplete: true,
      now: PIN.generatedAt,
      accountSyncSnapshot: nonStaleAccountSync as never,
    })

    // DONE + STALE claim → stays DONE with STALE_CLAIM overlay (completed exception)
    const doneA = agg.assignmentsByTaskId.get('task-done-1')
    expect(doneA?.primary).toBe('DONE')
    expect(doneA?.overlays).toContain('STALE_CLAIM')

    // ONGOING zero-click: VALID_CURRENT + RUNNING
    const onA = agg.assignmentsByTaskId.get('task-ongoing-1')
    expect(onA?.primary).toBe('ONGOING')
    const workOn = projectWork(agg, { bucket: 'ONGOING' })
    expect(workOn.data.items.some((i) => i.taskId === 'task-ongoing-1')).toBe(true)
    expect(workOn.data.items.find((i) => i.taskId === 'task-ongoing-1')?.claimState).toBe(
      'VALID_CURRENT',
    )

    // RECONCILIATION_PENDING from ORPHAN claim — still STALE chip family via STALE_CLAIM
    const reconA = agg.assignmentsByTaskId.get('task-recon-1')
    expect(reconA?.primary).toBe('RECONCILIATION_PENDING')
    expect(reconA?.overlays).toContain('STALE_CLAIM')
    expect(reconA?.overlays).toContain('RECONCILIATION_DRILLDOWN')

    // STALE overlay (incomplete + STALE claim) → RECON + STALE_CLAIM + staleDataSource
    const staleA = agg.assignmentsByTaskId.get('task-stale-1')
    expect(staleA?.primary).toBe('RECONCILIATION_PENDING')
    expect(staleA?.overlays).toContain('STALE_CLAIM')
    expect(staleA?.overlays).toContain('STALE_DATA_SOURCE')
    expect(staleA?.overlays).toContain('RECONCILIATION_DRILLDOWN')

    // Exactly one UNCLASSIFIED / DATA_INTEGRITY row
    const missA = agg.assignmentsByTaskId.get('task-missing-proof-1')
    expect(missA?.primary).toBe('BLOCKED')
    expect(missA?.blockReason).toBe('DATA_INTEGRITY')
    const integrity = [...agg.assignmentsByTaskId.values()].filter(
      (a) => a.blockReason === 'DATA_INTEGRITY',
    )
    expect(integrity).toHaveLength(1)
    expect(integrity[0]!.taskId).toBe('task-missing-proof-1')
  })
})

// ---------------------------------------------------------------------------
// C — rich DecisionV3 projection with redaction
// ---------------------------------------------------------------------------
describe('C3-R5S Acceptance C — DecisionV3 projection + redaction', () => {
  const PRIVATE_CANARY = 'CANARY_PRIVATE_DECISION_BODY_NEVER_PUBLIC'

  it('maps rich V3 fields; private body/privateNote/comment never project', () => {
    const d: Decision = {
      id: 'dec-v3-001',
      decisionId: 'dec-v3-001',
      teks: 'Should we allocate majority Grok capacity?',
      status: 'open',
      severity: 'HIGH',
      blocking: true,
      type: 'owner',
      title: 'SYNTH DecisionV3 OPEN capacity policy',
      question: 'Should we allocate majority Grok capacity to SALES_WEB_RELATED_BACKEND?',
      options: [
        {
          optionId: 'opt-a',
          label: 'Approve majority Grok capacity',
          tradeoffs: 'Faster sales-web closure',
        },
        {
          optionId: 'opt-b',
          label: 'Defer one sprint',
          tradeoffs: 'Preserves spare capacity',
        },
      ],
      agentRecommendation: 'Approve majority Grok capacity (opt-a)',
      evidence: ['ev-synth-r2d-001', 'qa/e2e/out/runtime/synth/decision-capacity.md'],
      dueAt: '2026-07-20T00:00:00.000Z',
      createdAt: '2026-07-13T10:00:00.000Z',
      ownerId: 'owner-synth',
      featureId: 'feat-login',
      projectId: 'proj-auth',
      taskId: 'task-blocked-1',
      entityRev: 1,
      expectedRev: 7,
      boardRev: 7,
      auditIds: ['audit-dec-001'],
      body: `SYNTHETIC ${PRIVATE_CANARY}`,
      privateNote: PRIVATE_CANARY,
      comment: PRIVATE_CANARY,
    }
    const v3 = mapLegacyDecisionToV3('mfs-rebuild', d, 7)
    expect(v3.decisionId).toBe('dec-v3-001')
    expect(v3.title).toContain('OPEN capacity')
    expect(v3.question).toContain('SALES_WEB_RELATED_BACKEND')
    expect(v3.severity).toBe('HIGH')
    expect(v3.blocking).toBe(true)
    expect(v3.status).toBe('OPEN')
    expect(v3.options).toHaveLength(2)
    expect(v3.options[0]?.optionId).toBe('opt-a')
    expect(v3.options[0]?.tradeoffs).toContain('Faster sales-web')
    expect(v3.agentRecommendation).toContain('opt-a')
    expect(v3.evidence).toEqual([
      'ev-synth-r2d-001',
      'qa/e2e/out/runtime/synth/decision-capacity.md',
    ])
    expect(v3.dueAt).toBe('2026-07-20T00:00:00.000Z')
    expect(v3.ownerId).toBe('owner-synth')
    expect(v3.taskId).toBe('task-blocked-1')
    expect(v3.projectId).toBe('proj-auth')
    expect(v3.featureId).toBe('feat-login')
    expect(v3.entityRev).toBe(1)
    expect(v3.expectedRev).toBe(7)
    expect(v3.auditIds).toEqual(['audit-dec-001'])
    // Redaction: private carriers never appear
    expect(v3.comment).toBeNull()
    expect(JSON.stringify(v3)).not.toContain(PRIVATE_CANARY)
    expect(JSON.stringify(v3)).not.toContain('privateNote')
  })

  it('legacy opsi still works; V3 options take precedence when valid', () => {
    const legacyOnly: Decision = {
      id: 'dec-leg',
      teks: 'Legacy question?',
      status: 'open',
      opsi: [
        { key: 'ya', label: 'Ya' },
        { key: 'tidak', label: 'Tidak' },
      ],
    }
    const fromOpsi = mapLegacyDecisionToV3('mfs-rebuild', legacyOnly, 1)
    expect(fromOpsi.options.map((o) => o.optionId)).toEqual(['ya', 'tidak'])

    const both: Decision = {
      id: 'dec-both',
      teks: 'Both?',
      status: 'open',
      opsi: [{ key: 'legacy', label: 'Legacy' }],
      options: [{ optionId: 'v3', label: 'V3 option', tradeoffs: 't' }],
    }
    const fromV3 = mapLegacyDecisionToV3('mfs-rebuild', both, 1)
    expect(fromV3.options).toHaveLength(1)
    expect(fromV3.options[0]?.optionId).toBe('v3')
  })

  it('REJECTED vs RESOLVED+declining preserved; rich fields reach authenticated projection', () => {
    const rejected: Decision = {
      id: 'dec-rej',
      teks: 'Reject me',
      status: 'REJECTED',
      title: 'Rejected request',
      question: 'Reject this?',
    }
    const rej = mapLegacyDecisionToV3('mfs-rebuild', rejected, 2)
    expect(rej.status).toBe('REJECTED')

    const declining: Decision = {
      id: 'dec-dec',
      teks: 'Decline option',
      status: 'RESOLVED',
      title: 'Resolved with declining option',
      question: 'Ship?',
      options: [
        { optionId: 'no', label: 'Decline ship', declining: true, tradeoffs: 'delay' },
      ],
      selectedOptionId: 'no',
    }
    const res = mapLegacyDecisionToV3('mfs-rebuild', declining, 2)
    expect(res.status).toBe('RESOLVED')
    expect(res.options[0]?.declining).toBe(true)
    expect(res.selectedOptionId).toBe('no')

    const raw = {
      id: 'mfs-rebuild',
      name: 'MFS',
      projects: [],
      features: [],
      runs: [],
      decisions: [
        {
          id: 'dec-v3-001',
          decisionId: 'dec-v3-001',
          status: 'open',
          severity: 'HIGH',
          blocking: true,
          teks: 'Public question text',
          title: 'Rich OPEN decision',
          question: 'Public question text for capacity',
          options: [{ optionId: 'opt-a', label: 'Approve', tradeoffs: 'speed' }],
          agentRecommendation: 'Approve',
          evidence: ['ev-1'],
          ownerId: 'owner-synth',
          taskId: 'task-blocked-1',
          featureId: 'feat-login',
          body: PRIVATE_CANARY,
          privateNote: PRIVATE_CANARY,
        },
      ],
      log: [],
      collab: { comments: {}, activity: [] },
    } as never

    const agg = buildControlCenterAggregationFromSources({
      boardId: 'mfs-rebuild',
      raw,
      tasks: [],
      opsAccounts: [],
      runs: [],
      boardContentHash: AUTH_HASH,
      boardRev: 7,
      lifecycleRev: 3,
      authorityCanonicalHash: AUTH_HASH,
      authorityCanonicalSnapshotId: AUTH_SNAP,
      pinAuthorityComplete: true,
      now: PIN.generatedAt,
    })
    expect(agg.decisions).toHaveLength(1)
    expect(agg.decisions[0]?.title).toBe('Rich OPEN decision')
    expect(agg.decisions[0]?.agentRecommendation).toBe('Approve')
    expect(agg.decisions[0]?.options[0]?.optionId).toBe('opt-a')
    expect(agg.decisions[0]?.comment).toBeNull()

    const projected = projectDecisions(agg)
    const blob = JSON.stringify(projected)
    expect(blob).toContain('Rich OPEN decision')
    expect(blob).toContain('Public question text')
    expect(blob).toContain('opt-a')
    expect(blob).not.toContain(PRIVATE_CANARY)
  })
})
