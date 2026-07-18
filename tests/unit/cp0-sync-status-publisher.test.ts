/**
 * PACKET-P2: fail-closed CP0 sync-status one-tick publisher core.
 * Adversarial: defaults, partial, nonzero, dual zero, stale/future, pin drift,
 * CAS conflict, lock refusal, redacted throws, overflow, idempotent tick,
 * stale writer, IN_SYNC only under dual proven fresh zeros + stable pin.
 */
import { describe, expect, it, vi } from 'vitest'

import { buildCp0SyncStatusReadback } from '#/server/cp0-sync-status'
import {
  CP0_MEASURE_DEFAULT_MAX_AGE_MS,
  CP0_MEASURE_MAX_SAFE_COUNT,
  createDefaultCp0SyncStatusMeasureDeps,
  provenCount,
  type Cp0CountMeasureResult,
  type Cp0SyncStatusMeasureDeps,
} from '#/server/cp0-sync-status-measures'
import {
  CP0_SYNC_STATUS_PUBLISHER_SCHEMA,
  buildPublishCandidate,
  candidateToSyncStatusRow,
  createCp0SyncStatusPublisherDeps,
  decidePublisherRawStatus,
  effectiveStatusForCandidate,
  evaluateCasPreflight,
  isCompleteCp0Pin,
  pinsEqual,
  runCp0SyncStatusPublisherTick,
  sanitizePublisherReason,
  type Cp0PublisherLockHandle,
  type Cp0SyncStatusExistingRow,
  type Cp0SyncStatusPublishCandidate,
  type Cp0SyncStatusPublisherDeps,
} from '#/server/cp0-sync-status-publisher'

const NOW = Date.parse('2026-07-18T18:00:00.000Z')
const PIN = {
  boardRev: 5845,
  lifecycleRev: 1,
  canonicalHash: '8ba475c604a0'.padEnd(64, '0'),
}
const BOARD = 'mfs-rebuild'

function heldLock(release = vi.fn(async () => {})): Cp0PublisherLockHandle {
  return { held: true, fenceToken: 'fence-test', release }
}

function refusedLock(): Cp0PublisherLockHandle {
  return { held: false, release: vi.fn(async () => {}) }
}

function fixtureProven(
  name: 'outbox_pending' | 'legacy_unreplayed',
  value: number,
  measuredAtMs = NOW,
  sourceId = 'fixture',
): Cp0CountMeasureResult {
  return provenCount(name, value, { sourceId, measuredAtMs })
}

function dualProvenMeasureDeps(
  outbox: number,
  legacy: number,
  measuredAtMs = NOW,
): Cp0SyncStatusMeasureDeps {
  return createDefaultCp0SyncStatusMeasureDeps({
    measureOutbox: () => fixtureProven('outbox_pending', outbox, measuredAtMs, 'outbox-table'),
    measureLegacy: () => fixtureProven('legacy_unreplayed', legacy, measuredAtMs, 'legacy-scan'),
  })
}

function memoryCasStore() {
  let row: Cp0SyncStatusExistingRow | null = null
  const writes: Cp0SyncStatusPublishCandidate[] = []

  return {
    writes,
    get row() {
      return row
    },
    setRow(next: Cp0SyncStatusExistingRow | null) {
      row = next
    },
    loadExistingRow: async () => row,
    casPublish: async ({
      candidate,
      expectedEntityRev,
    }: {
      candidate: Cp0SyncStatusPublishCandidate
      expectedEntityRev: number | null
    }) => {
      if (row == null) {
        if (expectedEntityRev != null) return { ok: false as const, conflict: true as const }
        row = {
          entity_rev: candidate.nextEntityRev,
          freshness_at: candidate.freshness_at,
          status: candidate.rawStatus,
          outbox_pending: candidate.outbox_pending,
          legacy_unreplayed: candidate.legacy_unreplayed,
          effective_backlog: candidate.effective_backlog,
          board_rev: candidate.board_rev,
          lifecycle_rev: candidate.lifecycle_rev,
          canonical_hash: candidate.canonical_hash,
          last_ack_revision: candidate.last_ack_revision,
        }
        writes.push(candidate)
        return { ok: true as const }
      }
      if (row.entity_rev !== expectedEntityRev) {
        return { ok: false as const, conflict: true as const }
      }
      row = {
        entity_rev: candidate.nextEntityRev,
        freshness_at: candidate.freshness_at,
        status: candidate.rawStatus,
        outbox_pending: candidate.outbox_pending,
        legacy_unreplayed: candidate.legacy_unreplayed,
        effective_backlog: candidate.effective_backlog,
        board_rev: candidate.board_rev,
        lifecycle_rev: candidate.lifecycle_rev,
        canonical_hash: candidate.canonical_hash,
        last_ack_revision: candidate.last_ack_revision,
      }
      writes.push(candidate)
      return { ok: true as const }
    },
  }
}

function baseDeps(
  overrides: Partial<Cp0SyncStatusPublisherDeps> & {
    pin?: typeof PIN | null
    pinSequence?: Array<typeof PIN | null>
  } = {},
): Cp0SyncStatusPublisherDeps {
  let pinReads = 0
  const pinSequence = overrides.pinSequence
  const fixedPin = overrides.pin === undefined ? PIN : overrides.pin

  return createCp0SyncStatusPublisherDeps({
    nowMs: overrides.nowMs ?? (() => NOW),
    acquirePublisherLock:
      overrides.acquirePublisherLock ?? (async () => heldLock()),
    readCanonicalPin:
      overrides.readCanonicalPin ??
      (async () => {
        if (pinSequence) {
          const p = pinSequence[Math.min(pinReads, pinSequence.length - 1)] ?? null
          pinReads += 1
          return p
        }
        return fixedPin
      }),
    loadExistingRow: overrides.loadExistingRow,
    casPublish: overrides.casPublish,
    measureDeps: overrides.measureDeps,
    publisherId: overrides.publisherId ?? 'unit-publisher',
    tickId: overrides.tickId ?? 'tick-unit-1',
  })
}

describe('cp0-sync-status-publisher (PACKET-P2)', () => {
  describe('pin helpers', () => {
    it('isCompleteCp0Pin rejects incomplete pins', () => {
      expect(isCompleteCp0Pin(null)).toBe(false)
      expect(isCompleteCp0Pin({ ...PIN, canonicalHash: '' })).toBe(false)
      expect(isCompleteCp0Pin({ ...PIN, boardRev: -1 })).toBe(false)
      expect(isCompleteCp0Pin(PIN)).toBe(true)
    })

    it('pinsEqual is exact triple match', () => {
      expect(pinsEqual(PIN, { ...PIN })).toBe(true)
      expect(pinsEqual(PIN, { ...PIN, boardRev: PIN.boardRev + 1 })).toBe(false)
    })
  })

  describe('decidePublisherRawStatus', () => {
    it('IN_SYNC only for dual proven zeros with stable pin', () => {
      const d = decidePublisherRawStatus({
        countsProven: true,
        outbox: 0,
        legacy: 0,
        effective: 0,
        pinStable: true,
      })
      expect(d.rawStatus).toBe('IN_SYNC')
      expect(d.zeroBacklogClaimed).toBe(true)
    })

    it('IN_SYNC impossible without dual proven zeros or stable pin', () => {
      expect(
        decidePublisherRawStatus({
          countsProven: false,
          outbox: 0,
          legacy: 0,
          effective: 0,
          pinStable: true,
        }).rawStatus,
      ).toBe('READBACK_REQUIRED')
      expect(
        decidePublisherRawStatus({
          countsProven: true,
          outbox: 1,
          legacy: 0,
          effective: 1,
          pinStable: true,
        }).rawStatus,
      ).toBe('READBACK_REQUIRED')
      expect(
        decidePublisherRawStatus({
          countsProven: true,
          outbox: 0,
          legacy: 0,
          effective: 0,
          pinStable: false,
        }).rawStatus,
      ).toBe('READBACK_REQUIRED')
      // nulls (unproven columns) never count as zero proof
      expect(
        decidePublisherRawStatus({
          countsProven: true,
          outbox: null,
          legacy: null,
          effective: null,
          pinStable: true,
        }).rawStatus,
      ).toBe('READBACK_REQUIRED')
    })
  })

  describe('defaults / unproven (no default measurer may claim proof)', () => {
    it('default measure deps never publish IN_SYNC or proven zeros', async () => {
      const store = memoryCasStore()
      const result = await runCp0SyncStatusPublisherTick(
        BOARD,
        baseDeps({
          measureDeps: createDefaultCp0SyncStatusMeasureDeps(),
          loadExistingRow: store.loadExistingRow,
          casPublish: store.casPublish,
        }),
      )

      expect(result.schemaVersion).toBe(CP0_SYNC_STATUS_PUBLISHER_SCHEMA)
      expect(result.decision).toBe('PUBLISH_READBACK_REQUIRED')
      expect(result.published).toBe(true)
      expect(result.rawStatus).toBe('READBACK_REQUIRED')
      expect(result.zeroBacklogClaimed).toBe(false)
      expect(result.countsProven).toBe(false)
      expect(result.candidate).not.toBeNull()
      expect(result.candidate!.outbox_pending).toBeNull()
      expect(result.candidate!.legacy_unreplayed).toBeNull()
      expect(result.candidate!.effective_backlog).toBeNull()
      // adversarial: null is not 0
      expect(result.candidate!.outbox_pending).not.toBe(0)
      expect(result.candidate!.effective_backlog).not.toBe(0)
      expect(result.candidate!.freshness_at).toBe(new Date(NOW).toISOString())

      // Serializer effective status for the candidate is READBACK_REQUIRED, not green
      expect(result.effectiveStatus).toBe('READBACK_REQUIRED')
      const rb = buildCp0SyncStatusReadback(
        candidateToSyncStatusRow(result.candidate!),
        PIN,
        NOW,
      )
      expect(rb.status).toBe('READBACK_REQUIRED')
      expect(rb.rawStatus).toBe('READBACK_REQUIRED')
      expect(rb.zeroBacklogProven).toBe(false)
    })

    it('without casPublish, candidate is returned but published=false (P3 wire later)', async () => {
      const result = await runCp0SyncStatusPublisherTick(
        BOARD,
        baseDeps({ measureDeps: createDefaultCp0SyncStatusMeasureDeps() }),
      )
      expect(result.candidate).not.toBeNull()
      expect(result.published).toBe(false)
      expect(result.decision).toBe('PUBLISH_READBACK_REQUIRED')
      expect(result.rawStatus).toBe('READBACK_REQUIRED')
    })
  })

  describe('partial proof', () => {
    it('one-side proven zero never yields IN_SYNC or invented effective zero', async () => {
      const measureDeps = createDefaultCp0SyncStatusMeasureDeps({
        measureOutbox: () => fixtureProven('outbox_pending', 0),
        // legacy default unproven
      })
      const store = memoryCasStore()
      const result = await runCp0SyncStatusPublisherTick(
        BOARD,
        baseDeps({
          measureDeps,
          loadExistingRow: store.loadExistingRow,
          casPublish: store.casPublish,
        }),
      )
      expect(result.rawStatus).toBe('READBACK_REQUIRED')
      expect(result.zeroBacklogClaimed).toBe(false)
      expect(result.countsProven).toBe(false)
      expect(result.candidate!.effective_backlog).toBeNull()
      expect(result.candidate!.effective_backlog).not.toBe(0)
      expect(result.candidate!.outbox_pending).toBeNull() // hybrid null projection
    })
  })

  describe('nonzero proven backlog', () => {
    it('emits READBACK_REQUIRED with real counts (not zeros, not IN_SYNC)', async () => {
      const store = memoryCasStore()
      const result = await runCp0SyncStatusPublisherTick(
        BOARD,
        baseDeps({
          measureDeps: dualProvenMeasureDeps(3, 5),
          loadExistingRow: store.loadExistingRow,
          casPublish: store.casPublish,
        }),
      )
      expect(result.decision).toBe('PUBLISH_READBACK_REQUIRED')
      expect(result.published).toBe(true)
      expect(result.rawStatus).toBe('READBACK_REQUIRED')
      expect(result.zeroBacklogClaimed).toBe(false)
      expect(result.countsProven).toBe(true)
      expect(result.candidate).toMatchObject({
        outbox_pending: 3,
        legacy_unreplayed: 5,
        effective_backlog: 8,
      })
      expect(result.candidate!.rawStatus).not.toBe('IN_SYNC')

      // raw vs effective: raw is READBACK_REQUIRED; serializer keeps it (counts proven, fresh, on-pin)
      expect(result.effectiveStatus).toBe('READBACK_REQUIRED')
      const rb = buildCp0SyncStatusReadback(
        candidateToSyncStatusRow(result.candidate!),
        PIN,
        NOW,
      )
      expect(rb.rawStatus).toBe('READBACK_REQUIRED')
      expect(rb.status).toBe('READBACK_REQUIRED')
      expect(rb.effectiveBacklog).toBe(8)
      expect(rb.zeroBacklogProven).toBe(false)
    })
  })

  describe('dual proven zero', () => {
    it('emits IN_SYNC with zeros, last_ack=board_rev, freshness from sample', async () => {
      const store = memoryCasStore()
      const result = await runCp0SyncStatusPublisherTick(
        BOARD,
        baseDeps({
          measureDeps: dualProvenMeasureDeps(0, 0),
          loadExistingRow: store.loadExistingRow,
          casPublish: store.casPublish,
        }),
      )
      expect(result.decision).toBe('PUBLISH_IN_SYNC')
      expect(result.published).toBe(true)
      expect(result.rawStatus).toBe('IN_SYNC')
      expect(result.zeroBacklogClaimed).toBe(true)
      expect(result.countsProven).toBe(true)
      expect(result.candidate).toMatchObject({
        outbox_pending: 0,
        legacy_unreplayed: 0,
        effective_backlog: 0,
        last_ack_revision: PIN.boardRev,
        board_rev: PIN.boardRev,
        lifecycle_rev: PIN.lifecycleRev,
        canonical_hash: PIN.canonicalHash,
        nextEntityRev: 1,
        expectedEntityRev: null,
      })
      expect(result.candidate!.freshness_at).toBe(new Date(NOW).toISOString())
      expect(result.effectiveStatus).toBe('IN_SYNC')

      const rb = buildCp0SyncStatusReadback(
        candidateToSyncStatusRow(result.candidate!),
        PIN,
        NOW,
      )
      expect(rb.status).toBe('IN_SYNC')
      expect(rb.rawStatus).toBe('IN_SYNC')
      expect(rb.zeroBacklogProven).toBe(true)
      expect(rb.parity).toBe(true)
      expect(rb.stale).toBe(false)
    })
  })

  describe('stale / future measures', () => {
    it('stale proven zeros fail closed to READBACK_REQUIRED with null counts', async () => {
      const staleAt = NOW - CP0_MEASURE_DEFAULT_MAX_AGE_MS - 5_000
      const store = memoryCasStore()
      const result = await runCp0SyncStatusPublisherTick(
        BOARD,
        baseDeps({
          measureDeps: dualProvenMeasureDeps(0, 0, staleAt),
          loadExistingRow: store.loadExistingRow,
          casPublish: store.casPublish,
        }),
      )
      expect(result.rawStatus).toBe('READBACK_REQUIRED')
      expect(result.zeroBacklogClaimed).toBe(false)
      expect(result.countsProven).toBe(false)
      expect(result.candidate!.outbox_pending).toBeNull()
      expect(result.candidate!.effective_backlog).not.toBe(0)
    })

    it('future-skewed proven zeros fail closed (not IN_SYNC)', async () => {
      const futureAt = NOW + 10_000
      const result = await runCp0SyncStatusPublisherTick(
        BOARD,
        baseDeps({
          measureDeps: dualProvenMeasureDeps(0, 0, futureAt),
        }),
      )
      expect(result.rawStatus).toBe('READBACK_REQUIRED')
      expect(result.zeroBacklogClaimed).toBe(false)
      expect(result.countsProven).toBe(false)
    })
  })

  describe('pin drift', () => {
    it('re-read pin drift refuses publish (no candidate write path)', async () => {
      const store = memoryCasStore()
      const release = vi.fn(async () => {})
      const result = await runCp0SyncStatusPublisherTick(
        BOARD,
        baseDeps({
          measureDeps: dualProvenMeasureDeps(0, 0),
          pinSequence: [PIN, { ...PIN, boardRev: PIN.boardRev + 1 }],
          acquirePublisherLock: async () => heldLock(release),
          loadExistingRow: store.loadExistingRow,
          casPublish: store.casPublish,
        }),
      )
      expect(result.decision).toBe('SKIP_PIN_DRIFT')
      expect(result.published).toBe(false)
      expect(result.pinStable).toBe(false)
      expect(result.candidate).toBeNull()
      expect(result.zeroBacklogClaimed).toBe(false)
      expect(store.writes).toHaveLength(0)
      expect(release).toHaveBeenCalled()
    })

    it('missing pin refuses publish', async () => {
      const result = await runCp0SyncStatusPublisherTick(
        BOARD,
        baseDeps({
          pin: null,
          measureDeps: dualProvenMeasureDeps(0, 0),
        }),
      )
      expect(result.decision).toBe('SKIP_PIN_UNAVAILABLE')
      expect(result.published).toBe(false)
      expect(result.candidate).toBeNull()
    })
  })

  describe('CAS conflict', () => {
    it('CAS conflict when expected entity_rev mismatches', async () => {
      const store = memoryCasStore()
      store.setRow({
        entity_rev: 10,
        freshness_at: new Date(NOW - 5_000).toISOString(),
      })
      // Simulate racing writer: load sees rev 10, but CAS finds rev advanced to 11
      let casCalls = 0
      const result = await runCp0SyncStatusPublisherTick(
        BOARD,
        baseDeps({
          measureDeps: dualProvenMeasureDeps(0, 0),
          loadExistingRow: async () => ({
            entity_rev: 10,
            freshness_at: new Date(NOW - 5_000).toISOString(),
          }),
          casPublish: async ({ expectedEntityRev, candidate }) => {
            casCalls += 1
            expect(expectedEntityRev).toBe(10)
            expect(candidate.nextEntityRev).toBe(11)
            // conflict: another writer advanced the row
            return { ok: false, conflict: true }
          },
        }),
      )
      expect(casCalls).toBe(1)
      expect(result.decision).toBe('SKIP_CAS_CONFLICT')
      expect(result.published).toBe(false)
      expect(result.candidate).not.toBeNull()
      expect(result.candidate!.expectedEntityRev).toBe(10)
      expect(result.zeroBacklogClaimed).toBe(true) // candidate still claims zeros; not persisted
      expect(result.rawStatus).toBe('IN_SYNC')
    })

    it('evaluateCasPreflight detects expectedEntityRev mismatch against existing', () => {
      const candidate = buildPublishCandidate({
        boardId: BOARD,
        pin: PIN,
        combined: {
          schemaVersion: 'CP0_SYNC_STATUS_MEASURES_V1',
          outbox: fixtureProven('outbox_pending', 0),
          legacy: fixtureProven('legacy_unreplayed', 0),
          effective: fixtureProven('outbox_pending', 0), // shape only; builder uses toNullable
          countsProven: true,
          assembledAtMs: NOW,
          reasonCode: null,
          reason: null,
        } as never,
        measuredAtMs: NOW,
        existing: { entity_rev: 5, freshness_at: new Date(NOW - 1_000).toISOString() },
        publisherId: 'unit',
        tickId: 't1',
      })
      // Force mismatch
      const mismatched = { ...candidate, expectedEntityRev: 4 }
      const pre = evaluateCasPreflight({
        candidate: mismatched,
        existing: { entity_rev: 5, freshness_at: new Date(NOW - 1_000).toISOString() },
      })
      expect(pre.allow).toBe(false)
      if (!pre.allow) expect(pre.reasonCode).toBe('CAS_CONFLICT')
    })
  })

  describe('lock refusal', () => {
    it('lock not acquired is a silent no-op tick', async () => {
      const cas = vi.fn()
      const result = await runCp0SyncStatusPublisherTick(
        BOARD,
        baseDeps({
          acquirePublisherLock: async () => refusedLock(),
          measureDeps: dualProvenMeasureDeps(0, 0),
          casPublish: cas,
        }),
      )
      expect(result.decision).toBe('SKIP_LOCK_NOT_ACQUIRED')
      expect(result.lockHeld).toBe(false)
      expect(result.published).toBe(false)
      expect(result.candidate).toBeNull()
      expect(cas).not.toHaveBeenCalled()
    })
  })

  describe('thrown source errors redacted', () => {
    it('measurer throw does not leak message/secrets into publisher reason', async () => {
      const measureDeps = createDefaultCp0SyncStatusMeasureDeps({
        measureOutbox: () => {
          throw new Error('password=hunter2 token=sk-live-abc mysql://user:secret@host/db')
        },
        measureLegacy: () => fixtureProven('legacy_unreplayed', 0),
      })
      const result = await runCp0SyncStatusPublisherTick(
        BOARD,
        baseDeps({ measureDeps }),
      )
      expect(result.rawStatus).toBe('READBACK_REQUIRED')
      expect(result.zeroBacklogClaimed).toBe(false)
      expect(result.candidate!.outbox_pending).toBeNull()
      expect(result.reason).not.toMatch(/password|hunter2|sk-live|mysql:\/\//i)
      expect(result.candidate!.reason).not.toMatch(/password|hunter2|sk-live|mysql:\/\//i)
      expect(result.combined!.outbox.reason).not.toMatch(/password|hunter2|sk-live/i)
      // measures keep Error.name only
      expect(result.combined!.outbox.reasonCode).toBe('MEASURE_ERROR')
    })

    it('top-level publisher throw is redacted (name only)', async () => {
      const result = await runCp0SyncStatusPublisherTick(
        BOARD,
        baseDeps({
          readCanonicalPin: async () => {
            throw new Error('Bearer super-secret-token connection string')
          },
        }),
      )
      expect(result.decision).toBe('SKIP_ERROR')
      expect(result.reason).not.toMatch(/Bearer|super-secret|connection string/i)
      expect(result.reason).toMatch(/Error|publisher tick failed/i)
    })
  })

  describe('overflow / bad numeric inherited fail-closed', () => {
    it('combine overflow never yields IN_SYNC zeros', async () => {
      const measureDeps = createDefaultCp0SyncStatusMeasureDeps({
        measureOutbox: () =>
          fixtureProven('outbox_pending', CP0_MEASURE_MAX_SAFE_COUNT),
        measureLegacy: () => fixtureProven('legacy_unreplayed', 1),
      })
      const result = await runCp0SyncStatusPublisherTick(
        BOARD,
        baseDeps({ measureDeps }),
      )
      expect(result.rawStatus).toBe('READBACK_REQUIRED')
      expect(result.countsProven).toBe(false)
      expect(result.candidate!.effective_backlog).toBeNull()
      expect(result.zeroBacklogClaimed).toBe(false)
    })

    it('negative injected measure is revalidated unproven', async () => {
      const measureDeps = createDefaultCp0SyncStatusMeasureDeps({
        measureOutbox: () =>
          ({
            name: 'outbox_pending',
            proven: true,
            value: -1,
            source: { id: 'evil' },
            measuredAtMs: NOW,
            reasonCode: 'UNKNOWN',
            reason: 'evil',
          }) as unknown as Cp0CountMeasureResult,
        measureLegacy: () => fixtureProven('legacy_unreplayed', 0),
      })
      const result = await runCp0SyncStatusPublisherTick(
        BOARD,
        baseDeps({ measureDeps }),
      )
      expect(result.countsProven).toBe(false)
      expect(result.rawStatus).toBe('READBACK_REQUIRED')
      expect(result.candidate!.outbox_pending).toBeNull()
    })
  })

  describe('repeated idempotent tick', () => {
    it('two successful ticks advance entity_rev and refresh freshness without inventing zeros', async () => {
      const store = memoryCasStore()
      let clock = NOW
      const deps = baseDeps({
        nowMs: () => clock,
        measureDeps: dualProvenMeasureDeps(0, 0),
        loadExistingRow: store.loadExistingRow,
        casPublish: store.casPublish,
        tickId: undefined,
      })

      const t1 = await runCp0SyncStatusPublisherTick(BOARD, {
        ...deps,
        tickId: 'tick-a',
        measureDeps: createDefaultCp0SyncStatusMeasureDeps({
          measureOutbox: (ctx) =>
            fixtureProven('outbox_pending', 0, ctx.nowMs, 'outbox-table'),
          measureLegacy: (ctx) =>
            fixtureProven('legacy_unreplayed', 0, ctx.nowMs, 'legacy-scan'),
        }),
      })
      expect(t1.published).toBe(true)
      expect(t1.candidate!.nextEntityRev).toBe(1)
      expect(store.row?.entity_rev).toBe(1)

      clock = NOW + 30_000
      const t2 = await runCp0SyncStatusPublisherTick(BOARD, {
        ...deps,
        tickId: 'tick-b',
        measureDeps: createDefaultCp0SyncStatusMeasureDeps({
          measureOutbox: (ctx) =>
            fixtureProven('outbox_pending', 0, ctx.nowMs, 'outbox-table'),
          measureLegacy: (ctx) =>
            fixtureProven('legacy_unreplayed', 0, ctx.nowMs, 'legacy-scan'),
        }),
      })
      expect(t2.published).toBe(true)
      expect(t2.candidate!.expectedEntityRev).toBe(1)
      expect(t2.candidate!.nextEntityRev).toBe(2)
      expect(t2.candidate!.freshness_at).toBe(new Date(clock).toISOString())
      expect(store.row?.entity_rev).toBe(2)
      expect(store.writes).toHaveLength(2)
      // both still honest zeros
      expect(t2.rawStatus).toBe('IN_SYNC')
      expect(t2.zeroBacklogClaimed).toBe(true)
    })
  })

  describe('stale writer ordering', () => {
    it('older sample cannot overwrite a newer freshness row', async () => {
      const store = memoryCasStore()
      store.setRow({
        entity_rev: 3,
        freshness_at: new Date(NOW + 60_000).toISOString(), // newer than this tick's sample
      })
      const result = await runCp0SyncStatusPublisherTick(
        BOARD,
        baseDeps({
          nowMs: () => NOW,
          measureDeps: dualProvenMeasureDeps(0, 0),
          loadExistingRow: store.loadExistingRow,
          casPublish: store.casPublish,
        }),
      )
      expect(result.decision).toBe('SKIP_STALE_WRITER')
      expect(result.published).toBe(false)
      expect(store.writes).toHaveLength(0)
      expect(store.row?.entity_rev).toBe(3)
    })

    it('concurrent ticks: only one CAS wins when entity_rev races', async () => {
      let entityRev = 7
      const freshness = new Date(NOW - 10_000).toISOString()
      const casPublish: NonNullable<Cp0SyncStatusPublisherDeps['casPublish']> = async ({
        expectedEntityRev,
        candidate,
      }) => {
        if (entityRev !== expectedEntityRev) {
          return { ok: false, conflict: true }
        }
        entityRev = candidate.nextEntityRev
        return { ok: true }
      }
      const loadExistingRow = async () => ({
        entity_rev: 7,
        freshness_at: freshness,
      })

      // Both ticks load expected 7; first CAS wins → entity 8; second must conflict if it still expects 7
      const d1 = await runCp0SyncStatusPublisherTick(
        BOARD,
        baseDeps({
          measureDeps: dualProvenMeasureDeps(0, 0),
          loadExistingRow,
          casPublish,
          tickId: 'w1',
        }),
      )
      expect(d1.published).toBe(true)
      expect(entityRev).toBe(8)

      const d2 = await runCp0SyncStatusPublisherTick(
        BOARD,
        baseDeps({
          measureDeps: dualProvenMeasureDeps(0, 0),
          // stale view still sees 7
          loadExistingRow: async () => ({
            entity_rev: 7,
            freshness_at: freshness,
          }),
          casPublish,
          tickId: 'w2',
        }),
      )
      expect(d2.published).toBe(false)
      expect(d2.decision).toBe('SKIP_CAS_CONFLICT')
      expect(entityRev).toBe(8)
    })
  })

  describe('IN_SYNC gate invariants', () => {
    it('IN_SYNC is impossible without dual proven fresh zeros and stable pin', async () => {
      const cases: Array<{
        name: string
        deps: Partial<Cp0SyncStatusPublisherDeps> & {
          pin?: typeof PIN | null
          pinSequence?: Array<typeof PIN | null>
        }
      }> = [
        {
          name: 'defaults',
          deps: { measureDeps: createDefaultCp0SyncStatusMeasureDeps() },
        },
        {
          name: 'partial',
          deps: {
            measureDeps: createDefaultCp0SyncStatusMeasureDeps({
              measureOutbox: () => fixtureProven('outbox_pending', 0),
            }),
          },
        },
        {
          name: 'nonzero',
          deps: { measureDeps: dualProvenMeasureDeps(1, 0) },
        },
        {
          name: 'stale zeros',
          deps: {
            measureDeps: dualProvenMeasureDeps(
              0,
              0,
              NOW - CP0_MEASURE_DEFAULT_MAX_AGE_MS - 1,
            ),
          },
        },
        {
          name: 'pin drift',
          deps: {
            measureDeps: dualProvenMeasureDeps(0, 0),
            pinSequence: [PIN, { ...PIN, lifecycleRev: 99 }],
          },
        },
      ]

      for (const c of cases) {
        const r = await runCp0SyncStatusPublisherTick(BOARD, baseDeps(c.deps))
        expect(r.rawStatus === 'IN_SYNC', c.name).toBe(false)
        expect(r.zeroBacklogClaimed, c.name).toBe(false)
        if (r.candidate) {
          expect(r.candidate.rawStatus === 'IN_SYNC', c.name).toBe(false)
        }
      }

      // Positive control: dual fresh zeros + stable pin is the only IN_SYNC path
      const ok = await runCp0SyncStatusPublisherTick(
        BOARD,
        baseDeps({ measureDeps: dualProvenMeasureDeps(0, 0) }),
      )
      expect(ok.rawStatus).toBe('IN_SYNC')
      expect(ok.zeroBacklogClaimed).toBe(true)
    })
  })

  describe('raw vs effective serializer status', () => {
    it('preserves distinction: raw token vs buildCp0SyncStatusReadback status', () => {
      const candidate = buildPublishCandidate({
        boardId: BOARD,
        pin: PIN,
        combined: {
          schemaVersion: 'CP0_SYNC_STATUS_MEASURES_V1',
          outbox: fixtureProven('outbox_pending', 0),
          legacy: fixtureProven('legacy_unreplayed', 0),
          effective: {
            name: 'effective_backlog',
            proven: true,
            value: 0,
            source: { id: 'effective-combine' },
            measuredAtMs: NOW,
            reasonCode: 'UNKNOWN',
            reason: 'ok',
          },
          countsProven: true,
          assembledAtMs: NOW,
          reasonCode: null,
          reason: null,
        },
        measuredAtMs: NOW,
        existing: null,
        publisherId: 'unit',
        tickId: 't-eff',
      })
      expect(candidate.rawStatus).toBe('IN_SYNC')
      expect(effectiveStatusForCandidate(candidate, NOW)).toBe('IN_SYNC')

      // Off-pin projection of same raw IN_SYNC → effective READBACK_REQUIRED
      const offPinRow = candidateToSyncStatusRow(candidate)
      const offPinRb = buildCp0SyncStatusReadback(
        offPinRow,
        { ...PIN, boardRev: PIN.boardRev + 1 },
        NOW,
      )
      expect(offPinRb.rawStatus).toBe('IN_SYNC')
      expect(offPinRb.status).toBe('READBACK_REQUIRED')
    })
  })

  describe('hygiene', () => {
    it('sanitizePublisherReason bounds length and strips controls', () => {
      const long = 'x'.repeat(500)
      expect(sanitizePublisherReason(long, 'fb').length).toBeLessThanOrEqual(200)
      expect(sanitizePublisherReason('a\n\tb', 'fb')).toBe('a b')
      expect(sanitizePublisherReason(null, 'fallback')).toBe('fallback')
    })

    it('releases lock even when measure path succeeds', async () => {
      const release = vi.fn(async () => {})
      await runCp0SyncStatusPublisherTick(
        BOARD,
        baseDeps({
          acquirePublisherLock: async () => heldLock(release),
          measureDeps: dualProvenMeasureDeps(0, 0),
        }),
      )
      expect(release).toHaveBeenCalledTimes(1)
    })

    it('record_json has no secret-bearing fields', async () => {
      const result = await runCp0SyncStatusPublisherTick(
        BOARD,
        baseDeps({ measureDeps: dualProvenMeasureDeps(0, 0) }),
      )
      const json = JSON.stringify(result.candidate!.record)
      expect(json).not.toMatch(/password|secret|Bearer|api[_-]?key/i)
      expect(result.candidate!.record.schemaVersion).toBe(CP0_SYNC_STATUS_PUBLISHER_SCHEMA)
      expect(result.candidate!.record.measureSources.outbox).toBe('outbox-table')
    })
  })
})
