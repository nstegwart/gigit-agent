/**
 * F1 control-data-persistence unit tests.
 * Exercises MySQL repository adapters against in-memory SQL engine (no real DB).
 */
import fs from 'node:fs'
import path from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'

import type { ClassificationReceipt, G5DomainRecord } from '#/lib/control-plane-types'
import { G5_REQUIRED_DOMAINS } from '#/lib/control-plane-types'
import {
  applyImport,
  planImport,
  IMPORT_WRITE_SCOPE,
} from '#/server/canonical-import'
import {
  loadPinnedDefinitionReadModel,
  CanonicalReadModelError,
} from '#/server/canonical-read-model'
import {
  canonicalSubjectHash,
  produceCanonicalSnapshot,
  type CanonicalSnapshotInput,
} from '#/server/canonical-snapshot'
import { evaluateClassification } from '#/server/classification'
import {
  ControlDataPersistenceError,
  IMPORT_AUDIT_REDACTED,
  IMPORT_AUDIT_REDACTED_PRIVATE,
  bindImportAuditEntry,
  createMemoryBackedControlDataPersistence,
  createMemoryControlDataSql,
  createMysqlControlDataPersistence,
  createMysqlDecisionV3Store,
  isImportAuditSensitiveKey,
  sanitizeImportAuditPayload,
  seedBoardRevision,
} from '#/server/control-data-persistence'
import type { DecisionV3Record } from '#/server/decisions-v3'
import { evaluateG5, makePassingDomain } from '#/server/g5'
import { beginIdempotent, completeIdempotent } from '#/server/idempotency'
import { STALE_REVISION, subjectHashOf } from '#/server/revisions'

function splitSqlStatements(sql: string): Array<string> {
  const withoutBlock = sql.replace(/\/\*[\s\S]*?\*\//g, '')
  const lines = withoutBlock.split('\n').filter((line) => {
    const t = line.trim()
    return t.length > 0 && !t.startsWith('--')
  })
  return lines
    .join('\n')
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

const MIGRATION_004 = path.join(process.cwd(), 'migrations/004_control_data_persistence.sql')

describe('004_control_data_persistence.sql migration contract', () => {
  it('exists and is additive / idempotent-safe', () => {
    expect(fs.existsSync(MIGRATION_004)).toBe(true)
    const sql = fs.readFileSync(MIGRATION_004, 'utf8')
    expect(sql).toMatch(/Classification:\s*REVERSIBLE/i)
    expect(sql).toMatch(/control_plane_decisions/)
    expect(sql).toMatch(/control_plane_classification_receipts/)
    expect(sql).toMatch(/control_plane_import_audit/)
    expect(sql).toMatch(/content_hash/)
    expect(sql).toMatch(/record_json/)
    expect(sql).toMatch(/receipt_json/)
    expect(sql).toMatch(/in_progress/)
    expect(sql).toMatch(/import_entity_rev/)
    expect(sql).toMatch(/canonical_hash/)
    expect(sql).not.toMatch(/DEFAULT\s+'PRODUCT'/)

    const stmts = splitSqlStatements(sql)
    expect(stmts.length).toBeGreaterThan(10)
    for (const s of stmts) {
      const lower = s.toLowerCase()
      expect(lower).not.toMatch(/\bdrop\s+table\b/)
      expect(lower).not.toMatch(/\btruncate\b/)
      expect(lower).not.toMatch(/foreign\s+key/)
      if (lower.includes('create table')) {
        expect(lower).toMatch(/if not exists/)
      }
    }
  })
})

describe('control-data-persistence MySQL adapters (memory SQL)', () => {
  let store: ReturnType<typeof createMemoryBackedControlDataPersistence>

  beforeEach(() => {
    store = createMemoryBackedControlDataPersistence()
  })

  describe('RevisionStore CAS + pins', () => {
    it('CAS succeeds and advances entity+board rev with subject hash pin', async () => {
      await seedBoardRevision(store.sql, {
        boardId: 'b1',
        boardRev: 5,
        subjectHash: subjectHashOf({ v: 1 }),
      })
      const result = await store.revisions.compareAndSwap({
        boardId: 'b1',
        entityType: 'task',
        entityId: 't1',
        entityExpectedRev: 0,
        expectedBoardRev: 5,
        expectedSubjectHash: '',
        nextSubjectHash: subjectHashOf({ v: 2 }),
      })
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.entityRev).toBe(1)
        expect(result.boardRev).toBe(6)
        expect(result.subjectHash).toBe(subjectHashOf({ v: 2 }))
      }
      const board = await store.revisions.getBoardRev('b1')
      const ent = await store.revisions.getEntity({
        boardId: 'b1',
        entityType: 'task',
        entityId: 't1',
      })
      expect(ent).not.toBeNull()
      expect(ent!.entityRev).toBe(1)
      expect(board.boardRev).toBe(6)
      expect(ent!.subjectHash).toBe(subjectHashOf({ v: 2 }))
    })

    it('returns STALE_REVISION with safe current metadata (no LWW)', async () => {
      await seedBoardRevision(store.sql, {
        boardId: 'b1',
        boardRev: 3,
        subjectHash: 'aaa',
      })
      const first = await store.revisions.compareAndSwap({
        boardId: 'b1',
        entityType: 'task',
        entityId: 't1',
        entityExpectedRev: 0,
        expectedBoardRev: 3,
        expectedSubjectHash: '',
        nextSubjectHash: 'bbb',
      })
      expect(first.ok).toBe(true)

      const stale = await store.revisions.compareAndSwap({
        boardId: 'b1',
        entityType: 'task',
        entityId: 't1',
        entityExpectedRev: 0,
        expectedBoardRev: 3,
        expectedSubjectHash: 'bbb',
        nextSubjectHash: 'ccc',
      })
      expect(stale.ok).toBe(false)
      if (!stale.ok) {
        expect(stale.code).toBe(STALE_REVISION)
        expect(stale.current.entityRev).toBe(1)
        expect(stale.current.boardRev).toBe(4)
        expect(stale.current.subjectHash).toBe('bbb')
      }
      const ent = await store.revisions.getEntity({
        boardId: 'b1',
        entityType: 'task',
        entityId: 't1',
      })
      expect(ent!.subjectHash).toBe('bbb')
    })
  })

  describe('IdempotencyStorage', () => {
    it('putIfAbsent + complete + replay same hash; conflict on different hash', async () => {
      const begin1 = await beginIdempotent(store.idempotency, {
        scope: {
          actorId: 'actor-1',
          boardId: 'b1',
          endpoint: 'canonical_import_apply',
          key: 'k-1',
        },
        requestBody: { a: 1 },
        nowMs: 1_000_000,
      })
      expect(begin1.kind).toBe('EXECUTE')
      await completeIdempotent(
        store.idempotency,
        begin1.scopeHash,
        200,
        { ok: true },
        begin1.requestHash,
      )

      const replay = await beginIdempotent(store.idempotency, {
        scope: {
          actorId: 'actor-1',
          boardId: 'b1',
          endpoint: 'canonical_import_apply',
          key: 'k-1',
        },
        requestBody: { a: 1 },
        nowMs: 1_000_100,
      })
      expect(replay.kind).toBe('REPLAY')
      expect(replay.record?.responseStatus).toBe(200)

      await expect(
        beginIdempotent(store.idempotency, {
          scope: {
            actorId: 'actor-1',
            boardId: 'b1',
            endpoint: 'canonical_import_apply',
            key: 'k-1',
          },
          requestBody: { a: 2 },
          nowMs: 1_000_200,
        }),
      ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' })
    })
  })

  describe('DecisionV3Store', () => {
    it('put/get/list round-trip preserves options and revs', async () => {
      const rec: DecisionV3Record = {
        decisionId: 'd-1',
        boardId: 'b1',
        projectId: 'p1',
        featureId: null,
        taskId: 't1',
        runId: null,
        type: 'PRIORITY',
        severity: 'HIGH',
        title: 'Approve cutover?',
        question: 'Proceed with staging cutover?',
        evidence: ['ev-1'],
        options: [
          { optionId: 'yes', label: 'Yes' },
          { optionId: 'no', label: 'No', declining: true },
        ],
        agentRecommendation: 'yes',
        blocking: true,
        dueAt: '2026-07-14T12:00:00.000Z',
        dueAtMs: Date.parse('2026-07-14T12:00:00.000Z'),
        createdAt: '2026-07-13T10:00:00.000Z',
        createdAtMs: Date.parse('2026-07-13T10:00:00.000Z'),
        snoozedUntil: null,
        snoozedUntilMs: null,
        status: 'OPEN',
        ownerId: 'owner-1',
        resolverId: null,
        selectedOptionId: null,
        comment: null,
        expectedRev: 2,
        boardRev: 10,
        entityRev: 1,
        scopedApprovalId: null,
        auditIds: ['aud-1'],
        expiresAt: null,
        expiresAtMs: null,
      }
      await store.decisions.put(rec)
      const got = await store.decisions.get('b1', 'd-1')
      expect(got).not.toBeNull()
      expect(got!.title).toBe('Approve cutover?')
      expect(got!.options).toHaveLength(2)
      expect(got!.blocking).toBe(true)
      expect(got!.boardRev).toBe(10)
      const list = await store.decisions.list('b1')
      expect(list).toHaveLength(1)

      let lockRan = false
      await store.decisions.withBoardLock('b1', async () => {
        lockRan = true
        return 1
      })
      expect(lockRan).toBe(true)
    })

    it('withBoardLock pins GET_LOCK+RELEASE_LOCK to one connection; acquire!=1 fails closed', async () => {
      const sql = createMemoryControlDataSql()
      const decisions = createMysqlDecisionV3Store(sql)

      let inside = false
      await decisions.withBoardLock('board-pin', async () => {
        inside = true
        expect(sql.heldNamedLocks.get('cairn_decision_board-pin')).toBeTruthy()
      })
      expect(inside).toBe(true)

      const getCalls = sql.calls.filter((c) => /SELECT GET_LOCK/i.test(c.sql))
      const relCalls = sql.calls.filter((c) => /SELECT RELEASE_LOCK/i.test(c.sql))
      expect(getCalls.length).toBeGreaterThanOrEqual(1)
      expect(relCalls.length).toBeGreaterThanOrEqual(1)
      const lastGet = getCalls[getCalls.length - 1]!
      const lastRel = relCalls[relCalls.length - 1]!
      expect(lastGet.connectionId).toMatch(/^memory-conn-/)
      expect(lastRel.connectionId).toBe(lastGet.connectionId)
      expect(lastGet.connectionId).not.toBe('memory-pool')
      expect(sql.heldNamedLocks.has('cairn_decision_board-pin')).toBe(false)

      // Hold lock on a different connection → second withBoardLock must not run fn.
      const holder = await sql.getConnection()
      const [acq] = await holder.query('SELECT GET_LOCK(?, 10) AS l', [
        'cairn_decision_board-held',
      ])
      expect(Number((acq as Array<{ l: number }>)[0]?.l)).toBe(1)

      let ranWhileHeld = false
      await expect(
        decisions.withBoardLock('board-held', async () => {
          ranWhileHeld = true
          return 1
        }),
      ).rejects.toMatchObject({
        code: 'DATA_INTEGRITY',
        name: 'ControlDataPersistenceError',
      })
      expect(ranWhileHeld).toBe(false)
      // Original holder still owns the lock (not stolen by fail path).
      expect(sql.heldNamedLocks.get('cairn_decision_board-held')).toBe(
        (holder as { connectionId?: string }).connectionId,
      )
      await holder.query('SELECT RELEASE_LOCK(?) AS r', ['cairn_decision_board-held'])
      holder.release()
    })

    it('withBoardLock without getConnection fails closed', async () => {
      const bare = {
        async query() {
          return [[], []] as never
        },
      }
      const decisions = createMysqlDecisionV3Store(bare as never)
      let ran = false
      await expect(
        decisions.withBoardLock('b-bare', async () => {
          ran = true
        }),
      ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
      expect(ran).toBe(false)
    })
  })

  describe('G5DomainStore', () => {
    it('persists nine domains and evaluateG5 reads programmatically', async () => {
      const pin = {
        canonicalSnapshotId: 'snap-1',
        canonicalHash: 'hash-canonical-aaaaaaaa',
        taskHash: 'hash-task-bbbbbbbb',
        boardRev: 7,
        lifecycleRev: 3,
      }
      const domains: Array<G5DomainRecord> = G5_REQUIRED_DOMAINS.map((id) =>
        makePassingDomain(id, pin),
      )
      await store.g5.putAll('b1', domains)
      const listed = await store.g5.list('b1')
      expect(listed).toHaveLength(9)
      const one = await store.g5.get('b1', 'security')
      expect(one?.status).toBe('PASS')
      expect(one?.programmaticEvidence).toBe(true)
      expect(one?.independentVerifier).toBe(true)
      const evald = evaluateG5(listed, pin)
      expect(evald.g5Pass).toBe(true)
    })
  })

  describe('ClassificationDataStore', () => {
    it('put receipt + record; evaluateClassification validates pin', async () => {
      const pin = {
        canonicalSnapshotId: 'snap-1',
        canonicalHash: 'chash-aaaaaaaaaaaaaaaa',
        taskHash: 'thash-bbbbbbbbbbbbbbbb',
        boardRev: 4,
        lifecycleRev: 2,
      }
      const receipt: ClassificationReceipt = {
        receiptId: 'rcpt-1',
        receiptHash: 'abcdef0123456789',
        taskId: 't-1',
        taskClass: 'PRODUCT',
        disposition: 'ACTIVE',
        membershipPortfolioId: 'SALES_WEB_RELATED_BACKEND',
        membershipProofHash: 'proof-hash-cccc',
        canonicalSnapshotId: pin.canonicalSnapshotId,
        canonicalHash: pin.canonicalHash,
        taskHash: pin.taskHash,
        boardRev: pin.boardRev,
        lifecycleRev: pin.lifecycleRev,
        issuedAt: '2026-07-13T00:00:00.000Z',
        expiresAt: '2099-01-01T00:00:00.000Z',
      }
      await store.classification.put(
        'b1',
        {
          taskId: 't-1',
          taskClass: 'PRODUCT',
          disposition: 'ACTIVE',
          receipt,
        },
        { boardRev: pin.boardRev, entityRev: 1, lifecycleRev: pin.lifecycleRev },
      )
      const got = await store.classification.get('b1', 't-1')
      expect(got?.taskClass).toBe('PRODUCT')
      expect(got?.receipt?.receiptId).toBe('rcpt-1')
      const archived = await store.classification.getReceipt('b1', 'rcpt-1')
      expect(archived?.receiptHash).toBe('abcdef0123456789')

      const evaluation = evaluateClassification(got, pin, {
        now: '2026-07-13T12:00:00.000Z',
      })
      expect(evaluation.valid).toBe(true)
      expect(evaluation.contributesToProductReadiness).toBe(true)
    })

    it('R2 put strips self-asserted sales-rebuild membership fields', async () => {
      const pin = {
        canonicalSnapshotId: 'snap-r2',
        canonicalHash: 'chash-r2aaaaaaaaaaaaaaaa',
        taskHash: 'thash-r2bbbbbbbbbbbbbbbb',
        boardRev: 5,
        lifecycleRev: 1,
      }
      const receipt: ClassificationReceipt = {
        receiptId: 'rcpt-r2',
        receiptHash: 'abcdef0123456789r2strip',
        taskId: 't-r2',
        taskClass: 'PRODUCT',
        disposition: 'ACTIVE',
        membershipPortfolioId: 'SALES_WEB_RELATED_BACKEND',
        membershipProofHash: 'deadbeefdeadbeefdeadbeef',
        membershipProductLine: 'sales-rebuild',
        canonicalSnapshotId: pin.canonicalSnapshotId,
        canonicalHash: pin.canonicalHash,
        taskHash: pin.taskHash,
        boardRev: pin.boardRev,
        lifecycleRev: pin.lifecycleRev,
        issuedAt: '2026-07-13T00:00:00.000Z',
        expiresAt: null,
      }
      await store.classification.put(
        'b-r2',
        {
          taskId: 't-r2',
          taskClass: 'PRODUCT',
          disposition: 'ACTIVE',
          receipt,
        },
        { boardRev: pin.boardRev, entityRev: 1, lifecycleRev: pin.lifecycleRev },
      )
      const got = await store.classification.get('b-r2', 't-r2')
      expect(got?.receipt?.membershipProductLine).toBeUndefined()
      expect(got?.receipt?.membershipProofHash).toBeUndefined()
      expect(got?.receipt?.membershipPortfolioId).toBeUndefined()
      const archived = await store.classification.getReceipt('b-r2', 'rcpt-r2')
      expect(archived?.membershipProductLine).toBeUndefined()
      expect(archived?.membershipProofHash).toBeUndefined()
      // Class/disposition still persisted
      expect(got?.taskClass).toBe('PRODUCT')
      expect(got?.disposition).toBe('ACTIVE')
    })

    it('putReceipt same hash is idempotent; different hash is IDEMPOTENCY_CONFLICT with no write', async () => {
      const base: ClassificationReceipt = {
        receiptId: 'rcpt-imm-1',
        receiptHash: 'hash-original-11111111',
        taskId: 't-imm',
        taskClass: 'PRODUCT',
        disposition: 'ACTIVE',
        membershipPortfolioId: null,
        membershipProofHash: null,
        canonicalSnapshotId: 'snap-imm',
        canonicalHash: 'can-hash-original-aaaa',
        taskHash: 'task-hash-original-bbbb',
        boardRev: 1,
        lifecycleRev: 0,
        issuedAt: '2026-07-13T00:00:00.000Z',
        expiresAt: null,
      }
      await store.classification.putReceipt('b-imm', base)

      // Exact same receipt_hash may idempotently replay (no throw).
      await store.classification.putReceipt('b-imm', { ...base })
      const afterReplay = await store.classification.getReceipt('b-imm', 'rcpt-imm-1')
      expect(afterReplay?.receiptHash).toBe('hash-original-11111111')
      expect(afterReplay?.canonicalHash).toBe('can-hash-original-aaaa')

      // Different hash for same receipt_id must not rewrite stored row.
      await expect(
        store.classification.putReceipt('b-imm', {
          ...base,
          receiptHash: 'hash-TAMPERED-99999999',
          canonicalHash: 'can-hash-TAMPERED-zzzz',
        }),
      ).rejects.toMatchObject({
        code: 'IDEMPOTENCY_CONFLICT',
        name: 'ControlDataPersistenceError',
      })
      const afterConflict = await store.classification.getReceipt('b-imm', 'rcpt-imm-1')
      expect(afterConflict?.receiptHash).toBe('hash-original-11111111')
      expect(afterConflict?.canonicalHash).toBe('can-hash-original-aaaa')
      // Memory table proves no LWW rewrite
      const row = store.sql.tables.control_plane_classification_receipts.get('b-imm::rcpt-imm-1')
      expect(row?.receipt_hash).toBe('hash-original-11111111')
    })
  })

  describe('ImportStorage + plan/apply', () => {
    function makeSnapshot(boardId: string) {
      const input: CanonicalSnapshotInput = {
        boardId,
        snapshotId: 'snap-import-001',
        sourceRepoId: 'repo-1',
        sourceCommitSha: 'a'.repeat(40),
        generatedAt: '2026-07-13T11:00:00.000Z',
        producerVersion: 'test-1',
        projects: [{ id: 'p1', name: 'P1' }],
        flows: [{ id: 'f1', projectId: 'p1', name: 'F1' }],
        nodes: [{ id: 'n1', flowId: 'f1' }],
        tasks: [{ id: 't1', projectId: 'p1', title: 'Task 1' }],
        classifications: [
          { taskId: 't1', taskClass: 'UNCLASSIFIED', disposition: 'UNCLASSIFIED' },
        ],
      }
      return produceCanonicalSnapshot(input)
    }

    it('plan + apply advances import pin without touching lifecycle evidence', async () => {
      const boardId = 'b-import'
      await seedBoardRevision(store.sql, {
        boardId,
        boardRev: 1,
        lifecycleRev: 9,
        subjectHash: '',
        importEntityRev: 0,
      })
      const snapshot = makeSnapshot(boardId)
      const auth = { actorId: 'importer', scopes: [IMPORT_WRITE_SCOPE] }

      const plan = await planImport(store.imports, {
        auth,
        snapshot,
        entityExpectedRev: 0,
        expectedBoardRev: 1,
        expectedSubjectHash: '',
      })
      expect(plan.ok).toBe(true)
      expect(plan.nextBoardRev).toBe(2)

      const applied = await applyImport(
        store.imports,
        store.idempotency,
        store.revisions,
        {
          auth,
          snapshot,
          entityExpectedRev: 0,
          expectedBoardRev: 1,
          expectedSubjectHash: '',
          idempotencyKey: 'import-key-1',
          importId: 'imp-1',
          now: '2026-07-13T11:00:00.000Z',
        },
      )
      expect(applied.ok).toBe(true)
      expect(applied.kind).toBe('APPLIED')
      expect(applied.lifecycleEvidenceUnchanged).toBe(true)
      expect(applied.boardRev).toBe(2)
      expect(applied.lifecycleRev).toBe(9)

      const state = await store.imports.getBoardState(boardId)
      expect(state?.canonicalSnapshotId).toBe(snapshot.manifest.snapshotId)
      expect(state?.lifecycleRev).toBe(9)
      expect(state?.boardRev).toBe(2)
      expect(state?.entityRev).toBe(1)

      const replay = await applyImport(
        store.imports,
        store.idempotency,
        store.revisions,
        {
          auth,
          snapshot,
          entityExpectedRev: 0,
          expectedBoardRev: 1,
          expectedSubjectHash: '',
          idempotencyKey: 'import-key-1',
          importId: 'imp-1',
          now: '2026-07-13T11:01:00.000Z',
        },
      )
      expect(replay.kind).toBe('REPLAY')
    })

    it('applySnapshot rejects rewrite of snapshot/import provenance with different hash', async () => {
      const boardId = 'b-prov'
      await seedBoardRevision(store.sql, {
        boardId,
        boardRev: 0,
        lifecycleRev: 1,
        subjectHash: '',
        importEntityRev: 0,
      })
      const snapshot = makeSnapshot(boardId)
      await store.imports.applySnapshot({
        boardId,
        snapshot,
        nextEntityRev: 1,
        nextBoardRev: 1,
        canonicalHash: snapshot.manifest.payloadSha256,
        actorId: 'actor',
        importId: 'imp-prov-1',
        appliedAt: '2026-07-13T12:00:00.000Z',
      })
      const snapKey = `${boardId}::${snapshot.manifest.snapshotId}`
      const beforeSnap = store.sql.tables.control_plane_snapshots.get(snapKey)
      expect(beforeSnap?.payload_sha256).toBe(snapshot.manifest.payloadSha256)
      const beforeImport = store.sql.tables.control_plane_imports.get(`${boardId}::imp-prov-1`)
      expect(beforeImport?.canonical_hash).toBe(snapshot.manifest.payloadSha256)

      // Same keys, different hashes → must conflict and leave stored provenance intact.
      const tampered = {
        ...snapshot,
        manifest: {
          ...snapshot.manifest,
          payloadSha256: 'deadbeef'.repeat(8),
        },
      }
      await expect(
        store.imports.applySnapshot({
          boardId,
          snapshot: tampered,
          nextEntityRev: 2,
          nextBoardRev: 2,
          canonicalHash: 'deadbeef'.repeat(8),
          actorId: 'actor',
          importId: 'imp-prov-1',
          appliedAt: '2026-07-13T12:01:00.000Z',
        }),
      ).rejects.toMatchObject({
        code: 'IDEMPOTENCY_CONFLICT',
        name: 'ControlDataPersistenceError',
      })
      expect(store.sql.tables.control_plane_snapshots.get(snapKey)?.payload_sha256).toBe(
        snapshot.manifest.payloadSha256,
      )
      expect(
        store.sql.tables.control_plane_imports.get(`${boardId}::imp-prov-1`)?.canonical_hash,
      ).toBe(snapshot.manifest.payloadSha256)

      // Same hash replay is allowed (insert-once no-op on provenance rows).
      await store.imports.applySnapshot({
        boardId,
        snapshot,
        nextEntityRev: 2,
        nextBoardRev: 2,
        canonicalHash: snapshot.manifest.payloadSha256,
        actorId: 'actor',
        importId: 'imp-prov-1',
        appliedAt: '2026-07-13T12:02:00.000Z',
      })
      expect(store.sql.tables.control_plane_snapshots.get(snapKey)?.payload_sha256).toBe(
        snapshot.manifest.payloadSha256,
      )
    })

    it('getPinnedSnapshot returns pin + reconstructed payload after applyImport', async () => {
      const boardId = 'b-pinned-read'
      await seedBoardRevision(store.sql, {
        boardId,
        boardRev: 1,
        lifecycleRev: 4,
        subjectHash: '',
        importEntityRev: 0,
      })
      const snapshot = makeSnapshot(boardId)
      const auth = { actorId: 'importer', scopes: [IMPORT_WRITE_SCOPE] }
      const applied = await applyImport(
        store.imports,
        store.idempotency,
        store.revisions,
        {
          auth,
          snapshot,
          entityExpectedRev: 0,
          expectedBoardRev: 1,
          expectedSubjectHash: '',
          idempotencyKey: 'import-pinned-read-1',
          importId: 'imp-pinned-1',
          now: '2026-07-13T11:30:00.000Z',
        },
      )
      expect(applied.ok).toBe(true)

      const bundle = await store.imports.getPinnedSnapshot(boardId)
      expect(bundle).not.toBeNull()
      expect(bundle!.pin.canonicalSnapshotId).toBe(snapshot.manifest.snapshotId)
      expect(bundle!.pin.boardRev).toBe(applied.boardRev)
      expect(bundle!.pin.lifecycleRev).toBe(4)
      expect(bundle!.snapshot).not.toBeNull()
      expect(bundle!.snapshot!.manifest.snapshotId).toBe(snapshot.manifest.snapshotId)
      expect(bundle!.snapshot!.payload.tasks.map((t) => t.id)).toEqual(['t1'])
      expect(bundle!.snapshot!.manifest.payloadSha256).toBe(snapshot.manifest.payloadSha256)
      expect(bundle!.snapshotBoardRev).toBe(applied.boardRev)
      expect(bundle!.snapshotLifecycleRev).toBe(4)

      // High-level adapter over MySQL ImportStorage
      const model = await loadPinnedDefinitionReadModel(store.imports, boardId)
      expect(model.pin.canonicalHash).toBe(canonicalSubjectHash(snapshot))
      expect(model.projection.distinctTaskIds).toEqual(['t1'])
      expect(model.projection.projects.map((p) => p.id)).toEqual(['p1'])
      expect(model.projection.flows.map((f) => f.id)).toEqual(['f1'])
    })

    it('getPinnedSnapshot returns null pin missing; SNAPSHOT_MISSING when pin without row', async () => {
      expect(await store.imports.getPinnedSnapshot('no-such-board')).toBeNull()

      const boardId = 'b-pin-orphan'
      // Pin points at a snapshot id that was never inserted into control_plane_snapshots.
      await seedBoardRevision(store.sql, {
        boardId,
        boardRev: 3,
        lifecycleRev: 1,
        subjectHash: 'd'.repeat(64),
        importEntityRev: 1,
        canonicalSnapshotId: 'snap-does-not-exist',
        canonicalHash: 'd'.repeat(64),
      })
      const bundle = await store.imports.getPinnedSnapshot(boardId)
      expect(bundle).not.toBeNull()
      expect(bundle!.pin.canonicalSnapshotId).toBe('snap-does-not-exist')
      expect(bundle!.snapshot).toBeNull()

      await expect(loadPinnedDefinitionReadModel(store.imports, boardId)).rejects.toBeInstanceOf(
        CanonicalReadModelError,
      )
      await expect(loadPinnedDefinitionReadModel(store.imports, boardId)).rejects.toMatchObject({
        code: 'SNAPSHOT_MISSING',
      })
    })

    it('appendAudit persists across two repository instances (shared SQL client)', async () => {
      const sql = createMemoryControlDataSql()
      const instanceA = createMysqlControlDataPersistence({ client: sql, requireInjected: true })
      const instanceB = createMysqlControlDataPersistence({ client: sql, requireInjected: true })

      const entry = {
        boardId: 'b-audit-dual',
        importId: 'imp-dual-1',
        snapshotId: 'snap-dual-1',
        action: 'canonical_import',
        actor: 'importer-a',
        payloadSha256: 'aa'.repeat(32),
        boardRev: 3,
        lifecycleRev: 1,
        entityRev: 2,
        ts: '2026-07-13T15:00:00.000Z',
      }
      await instanceA.imports.appendAudit(entry)

      // Second process / repository instance must read the same durable rows.
      const listed = await instanceB.imports.listImportAudit('b-audit-dual')
      expect(listed).toHaveLength(1)
      expect(listed[0]?.boardId).toBe('b-audit-dual')
      expect(listed[0]?.importId).toBe('imp-dual-1')
      expect(listed[0]?.snapshotId).toBe('snap-dual-1')
      expect(listed[0]?.event).toBe('canonical_import')
      expect(listed[0]?.actorId).toBe('importer-a')
      expect(listed[0]?.payloadSha256).toBe('aa'.repeat(32))
      expect(listed[0]?.boardRev).toBe(3)
      expect(listed[0]?.lifecycleRev).toBe(1)
      expect(listed[0]?.entityRev).toBe(2)
      expect(listed[0]?.contentHash).toMatch(/^[a-f0-9]{64}$/)
      expect(listed[0]?.capturedAt).toBe('2026-07-13T15:00:00.000Z')

      const got = await instanceB.imports.getImportAudit('b-audit-dual', listed[0]!.auditId)
      expect(got?.contentHash).toBe(listed[0]?.contentHash)
      expect(got?.payload.password).toBeUndefined()
    })

    it('appendAudit exact replay is idempotent; tamper is IDEMPOTENCY_CONFLICT', async () => {
      const entry = {
        boardId: 'b-audit-replay',
        importId: 'imp-replay-1',
        snapshotId: 'snap-replay-1',
        event: 'canonical_import',
        actorId: 'actor-r',
        payloadSha256: 'bb'.repeat(32),
        canonicalHash: 'cc'.repeat(32),
        boardRev: 5,
        lifecycleRev: 2,
        entityRev: 4,
        capturedAt: '2026-07-13T16:00:00.000Z',
      }
      await store.imports.appendAudit(entry)
      const first = await store.imports.listImportAudit('b-audit-replay')
      expect(first).toHaveLength(1)
      const auditId = first[0]!.auditId
      const contentHash = first[0]!.contentHash

      // Exact replay: same bound material → no throw, no second row.
      await store.imports.appendAudit({ ...entry })
      const afterReplay = await store.imports.listImportAudit('b-audit-replay')
      expect(afterReplay).toHaveLength(1)
      expect(afterReplay[0]?.contentHash).toBe(contentHash)
      expect(afterReplay[0]?.auditId).toBe(auditId)

      // Tamper: same identity (board/import/snapshot/event/capturedAt) different hash.
      await expect(
        store.imports.appendAudit({
          ...entry,
          payloadSha256: 'dd'.repeat(32),
          boardRev: 99,
        }),
      ).rejects.toMatchObject({
        code: 'IDEMPOTENCY_CONFLICT',
        name: 'ControlDataPersistenceError',
      })
      const afterTamper = await store.imports.listImportAudit('b-audit-replay')
      expect(afterTamper).toHaveLength(1)
      expect(afterTamper[0]?.contentHash).toBe(contentHash)
      expect(afterTamper[0]?.payloadSha256).toBe('bb'.repeat(32))
      expect(afterTamper[0]?.boardRev).toBe(5)
      // Memory table proves no LWW rewrite
      const row = store.sql.tables.control_plane_import_audit.get(`${'b-audit-replay'}::${auditId}`)
      expect(row?.content_hash).toBe(contentHash)
      expect(row?.payload_sha256).toBe('bb'.repeat(32))
    })

    it('appendAudit is board-isolated', async () => {
      const sharedMaterial = {
        importId: 'imp-iso',
        snapshotId: 'snap-iso',
        event: 'canonical_import',
        actorId: 'actor-iso',
        payloadSha256: 'ee'.repeat(32),
        boardRev: 1,
        lifecycleRev: 0,
        entityRev: 1,
        capturedAt: '2026-07-13T17:00:00.000Z',
      }
      await store.imports.appendAudit({ ...sharedMaterial, boardId: 'board-A' })
      await store.imports.appendAudit({ ...sharedMaterial, boardId: 'board-B' })

      const aOnly = await store.imports.listImportAudit('board-A')
      const bOnly = await store.imports.listImportAudit('board-B')
      expect(aOnly).toHaveLength(1)
      expect(bOnly).toHaveLength(1)
      expect(aOnly[0]?.boardId).toBe('board-A')
      expect(bOnly[0]?.boardId).toBe('board-B')
      // audit_id derivation includes boardId; rows are still PK-isolated by board.
      expect(aOnly[0]?.importId).toBe('imp-iso')
      expect(bOnly[0]?.importId).toBe('imp-iso')
      expect(await store.imports.getImportAudit('board-A', aOnly[0]!.auditId)).not.toBeNull()
      expect(await store.imports.getImportAudit('board-B', bOnly[0]!.auditId)).not.toBeNull()
      // Cross-board leak: A's audit_id must not resolve under board-B (and vice versa)
      expect(await store.imports.getImportAudit('board-B', aOnly[0]!.auditId)).toBeNull()
      expect(await store.imports.getImportAudit('board-A', bOnly[0]!.auditId)).toBeNull()
      expect(aOnly.every((r) => r.boardId === 'board-A')).toBe(true)
      expect(bOnly.every((r) => r.boardId === 'board-B')).toBe(true)
      expect(store.sql.tables.control_plane_import_audit.size).toBe(2)
    })

    it('appendAudit sanitizes secrets and private decision text', async () => {
      await store.imports.appendAudit({
        boardId: 'b-audit-san',
        importId: 'imp-san-1',
        snapshotId: 'snap-san-1',
        action: 'canonical_import',
        actor: 'actor-san',
        payloadSha256: 'ff'.repeat(32),
        boardRev: 2,
        lifecycleRev: 1,
        ts: '2026-07-13T18:00:00.000Z',
        password: 'super-secret-password',
        token: 'bearer-xyz',
        apiKey: 'ak_live_123',
        question: 'Should we ship private decision text?',
        agent_recommendation: 'never store this',
        comment: 'owner private comment',
        privateDecision: 'secret rationale',
        schemaVersion: 'v3',
      })

      const listed = await store.imports.listImportAudit('b-audit-san')
      expect(listed).toHaveLength(1)
      const payload = listed[0]!.payload
      // Bound material retained
      expect(payload.boardId).toBe('b-audit-san')
      expect(payload.importId).toBe('imp-san-1')
      expect(payload.event).toBe('canonical_import')
      expect(payload.schemaVersion).toBe('v3')
      // Secrets must never appear in stored payload
      expect(JSON.stringify(payload)).not.toContain('super-secret-password')
      expect(JSON.stringify(payload)).not.toContain('bearer-xyz')
      expect(JSON.stringify(payload)).not.toContain('ak_live_123')
      expect(payload.password).toBeUndefined()
      expect(payload.token).toBeUndefined()
      expect(payload.apiKey).toBeUndefined()
      // Private decision text must not appear
      expect(JSON.stringify(payload)).not.toContain('Should we ship private decision text?')
      expect(JSON.stringify(payload)).not.toContain('never store this')
      expect(JSON.stringify(payload)).not.toContain('owner private comment')
      expect(JSON.stringify(payload)).not.toContain('secret rationale')
      expect(payload.question).toBeUndefined()
      expect(payload.agent_recommendation).toBeUndefined()
      expect(payload.comment).toBeUndefined()
      expect(payload.privateDecision).toBeUndefined()

      // Unit helpers also prove sanitization without storage
      const sanitized = sanitizeImportAuditPayload({
        password: 'x',
        question: 'private?',
        boardId: 'b1',
      }) as Record<string, unknown>
      expect(sanitized.password).toBe(IMPORT_AUDIT_REDACTED)
      expect(sanitized.question).toBe(IMPORT_AUDIT_REDACTED_PRIVATE)
      expect(sanitized.boardId).toBe('b1')

      expect(() => bindImportAuditEntry({})).toThrow(ControlDataPersistenceError)
      try {
        bindImportAuditEntry({})
      } catch (e) {
        expect(e).toMatchObject({ code: 'INVALID_INPUT' })
      }
    })

    it('bindImportAuditEntry fail-closed: hostile aliases + nested secrets never leak raw markers', () => {
      const RAW_JWT =
        'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c'
      const RAW_SESSION = 'session=RAW_SESSION'
      const RAW_CLIENT_SECRET = 'cs_live_hostile_client_secret_marker'
      const RAW_ACCESS = 'at_live_nested_access_token_marker'
      const RAW_OWNER = 'OWNER_COMMENT_PRIVATE_PROSE_MARKER'
      const RAW_PEM =
        '-----BEGIN PRIVATE KEY-----\nMIIEvhostilePEM\n-----END PRIVATE KEY-----'
      const RAW_SK = 'sk-livehostileopenaikey1234567890ab'
      const RAW_EMAIL = 'victim@example.invalid'
      const RAW_IDENTITY = 'raw-account-identity-DO-NOT-STORE'

      // Sensitive key classification: camel / snake / kebab / Header-Case
      for (const k of [
        'cookieHeader',
        'authHeader',
        'Cookie',
        'Authorization',
        'clientSecret',
        'client_secret',
        'Client-Secret',
        'access_token',
        'accessToken',
        'Access-Token',
        'api-key',
        'private_key',
        'sessionId',
        'x-auth-token',
        'ownerComment',
        'owner_comment',
        'comments',
        'rawIdentity',
        'raw_identity',
        'email',
      ]) {
        expect(isImportAuditSensitiveKey(k), k).toBe(true)
      }
      expect(isImportAuditSensitiveKey('schemaVersion')).toBe(false)
      expect(isImportAuditSensitiveKey('boardId')).toBe(false)

      const hostile: Record<string, unknown> = {
        boardId: 'b-hostile-audit',
        importId: 'imp-hostile',
        snapshotId: 'snap-hostile',
        event: 'canonical_import',
        actorId: 'actor-hostile',
        payloadSha256: 'aa'.repeat(32),
        schemaVersion: 'v3-hostile',
        // Top-level hostile aliases (verifier-reported leak surface)
        cookieHeader: RAW_SESSION,
        authHeader: `Bearer ${RAW_JWT}`,
        clientSecret: RAW_CLIENT_SECRET,
        ownerComment: RAW_OWNER,
        Cookie: RAW_SESSION,
        Authorization: `Bearer ${RAW_JWT}`,
        'api-key': 'ak_hostile_top',
        'private-key': RAW_PEM,
        sessionId: 'sess-hostile-id',
        rawIdentity: RAW_IDENTITY,
        email: RAW_EMAIL,
        // Nested object + array (recursive)
        nested: {
          access_token: RAW_ACCESS,
          accessToken: RAW_ACCESS,
          client_secret: RAW_CLIENT_SECRET,
          owner_comment: RAW_OWNER,
          deeper: {
            cookieHeader: RAW_SESSION,
            authHeader: `Bearer ${RAW_JWT}`,
          },
        },
        items: [
          { access_token: RAW_ACCESS, keep: 1 },
          { Cookie: RAW_SESSION, note: `prefix ${RAW_JWT} suffix` },
        ],
        // Value-shape leaks under innocuous keys (key names must not themselves
        // contain secret tokens like bearer/session/cookie — those are key-redacted/dropped).
        freeTextA: RAW_JWT,
        freeTextB: `Bearer ${RAW_JWT}`,
        freeTextC: RAW_SESSION,
        freeTextD: RAW_PEM,
        freeTextE: RAW_SK,
      }

      const bound = bindImportAuditEntry(hostile)
      const serialized = JSON.stringify(bound.payload)

      // Bound safe material retained
      expect(bound.boardId).toBe('b-hostile-audit')
      expect(bound.payload.boardId).toBe('b-hostile-audit')
      expect(bound.payload.schemaVersion).toBe('v3-hostile')
      expect(bound.payload.event).toBe('canonical_import')

      // Top-level sensitive keys must not appear on durable payload (dropped after sanitize)
      expect(bound.payload.cookieHeader).toBeUndefined()
      expect(bound.payload.authHeader).toBeUndefined()
      expect(bound.payload.clientSecret).toBeUndefined()
      expect(bound.payload.ownerComment).toBeUndefined()
      expect(bound.payload.Cookie).toBeUndefined()
      expect(bound.payload.Authorization).toBeUndefined()
      expect(bound.payload.rawIdentity).toBeUndefined()
      expect(bound.payload.email).toBeUndefined()

      // Nested secrets redacted; non-sensitive fields kept
      const nested = bound.payload.nested as Record<string, unknown>
      expect(nested).toBeDefined()
      expect(nested.access_token).toBe(IMPORT_AUDIT_REDACTED)
      expect(nested.accessToken).toBe(IMPORT_AUDIT_REDACTED)
      expect(nested.client_secret).toBe(IMPORT_AUDIT_REDACTED)
      expect(nested.owner_comment).toBe(IMPORT_AUDIT_REDACTED_PRIVATE)
      const deeper = nested.deeper as Record<string, unknown>
      expect(deeper.cookieHeader).toBe(IMPORT_AUDIT_REDACTED)
      expect(deeper.authHeader).toBe(IMPORT_AUDIT_REDACTED)

      const items = bound.payload.items as Array<Record<string, unknown>>
      expect(items[0]!.access_token).toBe(IMPORT_AUDIT_REDACTED)
      expect(items[0]!.keep).toBe(1)
      expect(items[1]!.Cookie).toBe(IMPORT_AUDIT_REDACTED)

      // Value-shape under innocuous keys
      expect(bound.payload.freeTextA).toBe(IMPORT_AUDIT_REDACTED)
      expect(bound.payload.freeTextB).toBe(IMPORT_AUDIT_REDACTED)
      expect(bound.payload.freeTextC).toBe(IMPORT_AUDIT_REDACTED)
      expect(bound.payload.freeTextD).toBe(IMPORT_AUDIT_REDACTED)
      expect(bound.payload.freeTextE).toBe(IMPORT_AUDIT_REDACTED)

      // Serialized payload must contain none of the raw markers
      for (const marker of [
        RAW_JWT,
        RAW_SESSION,
        'RAW_SESSION',
        `Bearer ${RAW_JWT}`,
        RAW_CLIENT_SECRET,
        RAW_ACCESS,
        RAW_OWNER,
        RAW_PEM,
        'MIIEvhostilePEM',
        RAW_SK,
        RAW_EMAIL,
        RAW_IDENTITY,
        'ak_hostile_top',
      ]) {
        expect(serialized, `leak of ${marker}`).not.toContain(marker)
      }

      // sanitizeImportAuditPayload unit surface for the same aliases
      const sanitized = sanitizeImportAuditPayload({
        cookieHeader: RAW_SESSION,
        authHeader: `Bearer ${RAW_JWT}`,
        clientSecret: RAW_CLIENT_SECRET,
        access_token: RAW_ACCESS,
        ownerComment: RAW_OWNER,
        boardId: 'b1',
      }) as Record<string, unknown>
      expect(sanitized.cookieHeader).toBe(IMPORT_AUDIT_REDACTED)
      expect(sanitized.authHeader).toBe(IMPORT_AUDIT_REDACTED)
      expect(sanitized.clientSecret).toBe(IMPORT_AUDIT_REDACTED)
      expect(sanitized.access_token).toBe(IMPORT_AUDIT_REDACTED)
      expect(sanitized.ownerComment).toBe(IMPORT_AUDIT_REDACTED_PRIVATE)
      expect(sanitized.boardId).toBe('b1')
      expect(JSON.stringify(sanitized)).not.toContain(RAW_JWT)
      expect(JSON.stringify(sanitized)).not.toContain(RAW_SESSION)
      expect(JSON.stringify(sanitized)).not.toContain(RAW_CLIENT_SECRET)
      expect(JSON.stringify(sanitized)).not.toContain(RAW_ACCESS)
      expect(JSON.stringify(sanitized)).not.toContain(RAW_OWNER)
    })

    it('sanitizeImportAuditPayload rejects cycles and excessive depth (fail-closed)', () => {
      const cyclic: Record<string, unknown> = {
        boardId: 'b-cycle',
        ok: true,
      }
      cyclic.self = cyclic
      expect(() => sanitizeImportAuditPayload(cyclic)).toThrow(ControlDataPersistenceError)
      try {
        sanitizeImportAuditPayload(cyclic)
      } catch (e) {
        expect(e).toBeInstanceOf(ControlDataPersistenceError)
        expect((e as ControlDataPersistenceError).code).toBe('INVALID_INPUT')
        expect((e as ControlDataPersistenceError).message).toMatch(/cyclic/i)
      }

      // Depth > 12 must reject rather than return uninspected subtree
      let deep: unknown = { leaf: 'safe-value' }
      for (let i = 0; i < 14; i++) {
        deep = { child: deep }
      }
      expect(() => sanitizeImportAuditPayload(deep)).toThrow(ControlDataPersistenceError)
      try {
        sanitizeImportAuditPayload(deep)
      } catch (e) {
        expect(e).toBeInstanceOf(ControlDataPersistenceError)
        expect((e as ControlDataPersistenceError).code).toBe('INVALID_INPUT')
        expect((e as ControlDataPersistenceError).message).toMatch(/max depth/i)
      }

      // bindImportAuditEntry must also fail closed on cycles (no partial materialize)
      const cyclicEntry: Record<string, unknown> = {
        boardId: 'b-cycle-bind',
        event: 'canonical_import',
      }
      cyclicEntry.loop = cyclicEntry
      expect(() => bindImportAuditEntry(cyclicEntry)).toThrow(ControlDataPersistenceError)
    })

    it('applyImport path writes durable audit via appendAudit (not no-op)', async () => {
      const boardId = 'b-import-audit-path'
      await seedBoardRevision(store.sql, {
        boardId,
        boardRev: 1,
        lifecycleRev: 3,
        subjectHash: '',
        importEntityRev: 0,
      })
      const snapshot = makeSnapshot(boardId)
      const auth = { actorId: 'importer-path', scopes: [IMPORT_WRITE_SCOPE] }
      const applied = await applyImport(
        store.imports,
        store.idempotency,
        store.revisions,
        {
          auth,
          snapshot,
          entityExpectedRev: 0,
          expectedBoardRev: 1,
          expectedSubjectHash: '',
          idempotencyKey: 'import-audit-path-key',
          importId: 'imp-path-1',
          now: '2026-07-13T19:00:00.000Z',
        },
      )
      expect(applied.ok).toBe(true)
      expect(applied.kind).toBe('APPLIED')

      const audits = await store.imports.listImportAudit(boardId)
      expect(audits.length).toBeGreaterThanOrEqual(1)
      const row = audits.find((a) => a.snapshotId === snapshot.manifest.snapshotId)
      expect(row).toBeDefined()
      expect(row?.event).toBe('canonical_import')
      expect(row?.actorId).toBe('importer-path')
      expect(row?.payloadSha256).toBe(snapshot.manifest.payloadSha256)
      expect(row?.boardRev).toBe(applied.boardRev)
      expect(row?.lifecycleRev).toBe(3)
      // Direct table proof (not no-op)
      expect(store.sql.tables.control_plane_import_audit.size).toBeGreaterThan(0)
    })
  })

  describe('factory', () => {
    it('requireInjected without client throws', () => {
      expect(() =>
        createMysqlControlDataPersistence({ requireInjected: true }),
      ).toThrow(/client required/)
    })

    it('ControlDataPersistenceError is constructible with integrity codes', () => {
      const e = new ControlDataPersistenceError('DATA_INTEGRITY', 'x', { a: 1 })
      expect(e).toBeInstanceOf(Error)
      expect(e.code).toBe('DATA_INTEGRITY')
      expect(e.details).toEqual({ a: 1 })
    })
  })
})
