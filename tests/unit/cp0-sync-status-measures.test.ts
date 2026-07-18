/**
 * PACKET-P1: fail-closed CP0 sync-status measurement primitives.
 * Adversarial coverage: undefined=>0, one-side-proven=>0, stale cache, negatives.
 */
import { describe, expect, it } from 'vitest'

import {
  CP0_MEASURE_DEFAULT_MAX_AGE_MS,
  CP0_MEASURE_MAX_SAFE_COUNT,
  CP0_SYNC_STATUS_MEASURES_SCHEMA,
  assembleCombinedBacklogMeasure,
  combineEffectiveBacklog,
  countFromUnknown,
  createDefaultCp0SyncStatusMeasureDeps,
  defaultUnprovenLegacyMeasurer,
  defaultUnprovenOutboxMeasurer,
  isMeasureFresh,
  measureCp0SyncStatusCounts,
  parseNonNegativeCount,
  provenCount,
  requireFreshMeasure,
  toNullableCountColumns,
  unprovenCount,
  type Cp0CountMeasureResult,
  type Cp0MeasureContext,
} from '#/server/cp0-sync-status-measures'

const NOW = Date.parse('2026-07-18T18:00:00.000Z')
const CTX: Cp0MeasureContext = { boardId: 'mfs-rebuild', nowMs: NOW }

function fixtureProven(
  name: 'outbox_pending' | 'legacy_unreplayed',
  value: number,
  measuredAtMs = NOW,
  sourceId = 'fixture',
): Cp0CountMeasureResult {
  return provenCount(name, value, { sourceId, measuredAtMs })
}

describe('cp0-sync-status-measures (PACKET-P1)', () => {
  describe('parseNonNegativeCount', () => {
    it('accepts finite non-negative integers and integer strings', () => {
      expect(parseNonNegativeCount(0)).toEqual({ ok: true, value: 0 })
      expect(parseNonNegativeCount(42)).toEqual({ ok: true, value: 42 })
      expect(parseNonNegativeCount('7')).toEqual({ ok: true, value: 7 })
      expect(parseNonNegativeCount(0n)).toEqual({ ok: true, value: 0 })
    })

    it('rejects undefined/null without inventing zero', () => {
      expect(parseNonNegativeCount(undefined)).toMatchObject({
        ok: false,
        reasonCode: 'VALUE_MISSING',
      })
      expect(parseNonNegativeCount(null)).toMatchObject({
        ok: false,
        reasonCode: 'VALUE_MISSING',
      })
    })

    it('rejects negatives, floats, non-integers, overflow, non-finite', () => {
      expect(parseNonNegativeCount(-1)).toMatchObject({
        ok: false,
        reasonCode: 'VALUE_NEGATIVE',
      })
      expect(parseNonNegativeCount(1.5)).toMatchObject({
        ok: false,
        reasonCode: 'VALUE_NOT_INTEGER',
      })
      expect(parseNonNegativeCount(true)).toMatchObject({
        ok: false,
        reasonCode: 'VALUE_NOT_INTEGER',
      })
      expect(parseNonNegativeCount(Number.NaN)).toMatchObject({
        ok: false,
        reasonCode: 'VALUE_NON_FINITE',
      })
      expect(parseNonNegativeCount(Number.POSITIVE_INFINITY)).toMatchObject({
        ok: false,
        reasonCode: 'VALUE_NON_FINITE',
      })
      expect(parseNonNegativeCount(Number.MAX_SAFE_INTEGER + 1)).toMatchObject({
        ok: false,
        reasonCode: 'VALUE_OVERFLOW',
      })
      expect(parseNonNegativeCount('1.0')).toMatchObject({
        ok: false,
        reasonCode: 'VALUE_NOT_INTEGER',
      })
      expect(parseNonNegativeCount('')).toMatchObject({
        ok: false,
        reasonCode: 'VALUE_MISSING',
      })
    })
  })

  describe('default / no-source measures', () => {
    it('default outbox measurer is unproven with null value (never proven zero)', () => {
      const m = defaultUnprovenOutboxMeasurer(CTX)
      expect(m.proven).toBe(false)
      expect(m.value).toBeNull()
      expect(m.name).toBe('outbox_pending')
      expect(m.reasonCode).toBe('NO_SOURCE')
      expect(m.source.id).toBe('default-unproven')
      expect(m.reason).not.toMatch(/password|token|secret|Bearer/i)
    })

    it('default legacy measurer is unproven with null value', () => {
      const m = defaultUnprovenLegacyMeasurer(CTX)
      expect(m.proven).toBe(false)
      expect(m.value).toBeNull()
      expect(m.name).toBe('legacy_unreplayed')
      expect(m.reasonCode).toBe('NO_SOURCE')
    })

    it('createDefaultCp0SyncStatusMeasureDeps + measure never yields proven zero', async () => {
      const deps = createDefaultCp0SyncStatusMeasureDeps()
      const combined = await measureCp0SyncStatusCounts(deps, CTX)
      expect(combined.schemaVersion).toBe(CP0_SYNC_STATUS_MEASURES_SCHEMA)
      expect(combined.countsProven).toBe(false)
      expect(combined.outbox.proven).toBe(false)
      expect(combined.legacy.proven).toBe(false)
      expect(combined.effective.proven).toBe(false)
      expect(combined.outbox.value).toBeNull()
      expect(combined.legacy.value).toBeNull()
      expect(combined.effective.value).toBeNull()

      const cols = toNullableCountColumns(combined)
      expect(cols.countsProven).toBe(false)
      expect(cols.outbox_pending).toBeNull()
      expect(cols.legacy_unreplayed).toBeNull()
      expect(cols.effective_backlog).toBeNull()
      // Adversarial: null is not 0
      expect(cols.outbox_pending).not.toBe(0)
      expect(cols.effective_backlog).not.toBe(0)
    })
  })

  describe('effective_backlog combination (outbox + legacy)', () => {
    it('proven zero when both sources genuinely proven zero', () => {
      const outbox = fixtureProven('outbox_pending', 0)
      const legacy = fixtureProven('legacy_unreplayed', 0)
      const effective = combineEffectiveBacklog(outbox, legacy, NOW)
      expect(effective).toMatchObject({
        proven: true,
        value: 0,
        name: 'effective_backlog',
      })

      const combined = assembleCombinedBacklogMeasure({ outbox, legacy, nowMs: NOW })
      expect(combined.countsProven).toBe(true)
      expect(combined.effective.value).toBe(0)
      expect(toNullableCountColumns(combined)).toEqual({
        outbox_pending: 0,
        legacy_unreplayed: 0,
        effective_backlog: 0,
        countsProven: true,
      })
    })

    it('proven nonzero = sum when both sources proven nonzero', () => {
      const outbox = fixtureProven('outbox_pending', 3)
      const legacy = fixtureProven('legacy_unreplayed', 5)
      const effective = combineEffectiveBacklog(outbox, legacy, NOW)
      expect(effective).toMatchObject({ proven: true, value: 8 })

      const combined = assembleCombinedBacklogMeasure({ outbox, legacy, nowMs: NOW })
      expect(combined.countsProven).toBe(true)
      expect(toNullableCountColumns(combined).effective_backlog).toBe(8)
    })

    it('one-side proven zero does NOT yield proven effective zero', () => {
      const outboxOnly = assembleCombinedBacklogMeasure({
        outbox: fixtureProven('outbox_pending', 0),
        legacy: unprovenCount('legacy_unreplayed', {
          sourceId: 'missing',
          measuredAtMs: NOW,
          reasonCode: 'NO_SOURCE',
        }),
        nowMs: NOW,
      })
      expect(outboxOnly.outbox.proven).toBe(true)
      expect(outboxOnly.outbox.value).toBe(0)
      expect(outboxOnly.legacy.proven).toBe(false)
      expect(outboxOnly.effective.proven).toBe(false)
      expect(outboxOnly.effective.value).toBeNull()
      expect(outboxOnly.countsProven).toBe(false)
      expect(toNullableCountColumns(outboxOnly).effective_backlog).toBeNull()
      expect(toNullableCountColumns(outboxOnly).effective_backlog).not.toBe(0)

      const legacyOnly = assembleCombinedBacklogMeasure({
        outbox: unprovenCount('outbox_pending', {
          sourceId: 'missing',
          measuredAtMs: NOW,
          reasonCode: 'SOURCE_UNAVAILABLE',
        }),
        legacy: fixtureProven('legacy_unreplayed', 0),
        nowMs: NOW,
      })
      expect(legacyOnly.countsProven).toBe(false)
      expect(legacyOnly.effective.proven).toBe(false)
      expect(legacyOnly.effective.reasonCode).toBe('PARTIAL_PROOF')
      expect(toNullableCountColumns(legacyOnly)).toMatchObject({
        outbox_pending: null,
        legacy_unreplayed: null,
        effective_backlog: null,
        countsProven: false,
      })
    })

    it('one-side proven nonzero still leaves combined unproven (no hybrid publish)', () => {
      const combined = assembleCombinedBacklogMeasure({
        outbox: fixtureProven('outbox_pending', 9),
        legacy: unprovenCount('legacy_unreplayed', {
          sourceId: 'x',
          measuredAtMs: NOW,
        }),
        nowMs: NOW,
      })
      expect(combined.countsProven).toBe(false)
      // Even though outbox is proven 9, nullable projection nulls ALL when unproven bundle
      expect(toNullableCountColumns(combined).outbox_pending).toBeNull()
    })

    it('combine overflow fails closed', () => {
      const outbox = fixtureProven('outbox_pending', CP0_MEASURE_MAX_SAFE_COUNT)
      const legacy = fixtureProven('legacy_unreplayed', 1)
      const effective = combineEffectiveBacklog(outbox, legacy, NOW)
      expect(effective.proven).toBe(false)
      expect(effective.value).toBeNull()
      expect(effective.reasonCode).toBe('COMBINE_OVERFLOW')
    })
  })

  describe('adversarial: undefined => 0', () => {
    it('countFromUnknown(undefined) is unproven null, not proven 0', () => {
      const m = countFromUnknown('outbox_pending', undefined, {
        sourceId: 'bad-source',
        measuredAtMs: NOW,
      })
      expect(m.proven).toBe(false)
      expect(m.value).toBeNull()
      expect(m.value).not.toBe(0)
      expect(m.reasonCode).toBe('VALUE_MISSING')
    })

    it('injected measurer returning undefined value cannot prove zero', async () => {
      const deps = createDefaultCp0SyncStatusMeasureDeps({
        measureOutbox: () =>
          ({
            name: 'outbox_pending',
            proven: true,
            value: undefined,
            source: { id: 'forged' },
            measuredAtMs: NOW,
            reasonCode: 'UNKNOWN',
            reason: 'forged',
          }) as unknown as Cp0CountMeasureResult,
        measureLegacy: () => fixtureProven('legacy_unreplayed', 0),
      })
      const combined = await measureCp0SyncStatusCounts(deps, CTX)
      expect(combined.countsProven).toBe(false)
      expect(combined.outbox.proven).toBe(false)
      expect(combined.outbox.value).toBeNull()
      expect(toNullableCountColumns(combined).effective_backlog).not.toBe(0)
    })

    it('measurer returning bare undefined shape is fail-closed', async () => {
      const deps = createDefaultCp0SyncStatusMeasureDeps({
        measureOutbox: () => undefined as unknown as Cp0CountMeasureResult,
        measureLegacy: () => fixtureProven('legacy_unreplayed', 0),
      })
      const combined = await measureCp0SyncStatusCounts(deps, CTX)
      expect(combined.countsProven).toBe(false)
      expect(combined.outbox.reasonCode).toBe('MEASURE_ERROR')
    })
  })

  describe('adversarial: stale cached values', () => {
    it('isMeasureFresh rejects ages beyond max', () => {
      const fresh = fixtureProven('outbox_pending', 0, NOW - 1_000)
      const stale = fixtureProven('outbox_pending', 0, NOW - CP0_MEASURE_DEFAULT_MAX_AGE_MS - 1)
      expect(isMeasureFresh(fresh, NOW)).toBe(true)
      expect(isMeasureFresh(stale, NOW)).toBe(false)
    })

    it('stale proven zeros become unproven and cannot satisfy countsProven', () => {
      const staleOutbox = fixtureProven(
        'outbox_pending',
        0,
        NOW - CP0_MEASURE_DEFAULT_MAX_AGE_MS - 5_000,
      )
      const staleLegacy = fixtureProven(
        'legacy_unreplayed',
        0,
        NOW - CP0_MEASURE_DEFAULT_MAX_AGE_MS - 5_000,
      )
      expect(requireFreshMeasure(staleOutbox, NOW).proven).toBe(false)
      expect(requireFreshMeasure(staleOutbox, NOW).reasonCode).toBe('STALE_MEASURE')

      const combined = assembleCombinedBacklogMeasure({
        outbox: staleOutbox,
        legacy: staleLegacy,
        nowMs: NOW,
      })
      expect(combined.countsProven).toBe(false)
      expect(combined.outbox.proven).toBe(false)
      expect(combined.legacy.proven).toBe(false)
      expect(combined.effective.value).toBeNull()
      expect(toNullableCountColumns(combined).effective_backlog).toBeNull()
      expect(toNullableCountColumns(combined).outbox_pending).not.toBe(0)
    })

    it('fresh within window still proves zeros', () => {
      const outbox = fixtureProven('outbox_pending', 0, NOW - 10_000)
      const legacy = fixtureProven('legacy_unreplayed', 0, NOW - 10_000)
      const combined = assembleCombinedBacklogMeasure({ outbox, legacy, nowMs: NOW })
      expect(combined.countsProven).toBe(true)
      expect(combined.effective.value).toBe(0)
    })

    it('measureCp0SyncStatusCounts rejects stale injected cache', async () => {
      const staleAt = NOW - 60_000
      const deps = createDefaultCp0SyncStatusMeasureDeps({
        measureOutbox: () => fixtureProven('outbox_pending', 0, staleAt, 'cache'),
        measureLegacy: () => fixtureProven('legacy_unreplayed', 0, staleAt, 'cache'),
        maxMeasureAgeMs: 30_000,
      })
      const combined = await measureCp0SyncStatusCounts(deps, CTX)
      expect(combined.countsProven).toBe(false)
      expect(combined.reasonCode).toBe('STALE_MEASURE')
    })
  })

  describe('adversarial: negative values', () => {
    it('provenCount rejects negatives', () => {
      const m = provenCount('outbox_pending', -3, {
        sourceId: 'neg',
        measuredAtMs: NOW,
      })
      expect(m.proven).toBe(false)
      expect(m.value).toBeNull()
      expect(m.reasonCode).toBe('VALUE_NEGATIVE')
    })

    it('injected measurer proven:-1 is revalidated to unproven', async () => {
      const deps = createDefaultCp0SyncStatusMeasureDeps({
        measureOutbox: () =>
          ({
            name: 'outbox_pending',
            proven: true,
            value: -1,
            source: { id: 'evil' },
            measuredAtMs: NOW,
            reasonCode: 'UNKNOWN',
            reason: 'evil negative',
          }) as unknown as Cp0CountMeasureResult,
        measureLegacy: () => fixtureProven('legacy_unreplayed', 0),
      })
      const combined = await measureCp0SyncStatusCounts(deps, CTX)
      expect(combined.outbox.proven).toBe(false)
      expect(combined.outbox.reasonCode).toBe('VALUE_NEGATIVE')
      expect(combined.countsProven).toBe(false)
    })
  })

  describe('injectable real measurers', () => {
    it('both injected proven sources produce proven nonzero and zero paths', async () => {
      const zeroDeps = createDefaultCp0SyncStatusMeasureDeps({
        measureOutbox: (ctx) =>
          provenCount('outbox_pending', 0, {
            sourceId: 'outbox-table',
            measuredAtMs: ctx.nowMs,
          }),
        measureLegacy: (ctx) =>
          provenCount('legacy_unreplayed', 0, {
            sourceId: 'legacy-scan',
            measuredAtMs: ctx.nowMs,
          }),
      })
      const zero = await measureCp0SyncStatusCounts(zeroDeps, CTX)
      expect(zero.countsProven).toBe(true)
      expect(toNullableCountColumns(zero)).toEqual({
        outbox_pending: 0,
        legacy_unreplayed: 0,
        effective_backlog: 0,
        countsProven: true,
      })

      const nonzeroDeps = createDefaultCp0SyncStatusMeasureDeps({
        measureOutbox: (ctx) =>
          provenCount('outbox_pending', 2, {
            sourceId: 'outbox-table',
            measuredAtMs: ctx.nowMs,
          }),
        measureLegacy: (ctx) =>
          provenCount('legacy_unreplayed', 4, {
            sourceId: 'legacy-scan',
            measuredAtMs: ctx.nowMs,
          }),
      })
      const nonzero = await measureCp0SyncStatusCounts(nonzeroDeps, CTX)
      expect(nonzero.countsProven).toBe(true)
      expect(toNullableCountColumns(nonzero)).toEqual({
        outbox_pending: 2,
        legacy_unreplayed: 4,
        effective_backlog: 6,
        countsProven: true,
      })
    })

    it('measurer throw is fail-closed unproven (no zero invent)', async () => {
      const deps = createDefaultCp0SyncStatusMeasureDeps({
        measureOutbox: () => {
          throw new Error('db down')
        },
        measureLegacy: (ctx) =>
          provenCount('legacy_unreplayed', 0, {
            sourceId: 'legacy-scan',
            measuredAtMs: ctx.nowMs,
          }),
      })
      const combined = await measureCp0SyncStatusCounts(deps, CTX)
      expect(combined.countsProven).toBe(false)
      expect(combined.outbox.reasonCode).toBe('MEASURE_ERROR')
      expect(combined.outbox.reason).not.toMatch(/db down/) // message not leaked raw; name only
      expect(toNullableCountColumns(combined).outbox_pending).toBeNull()
    })

    it('async measurers are supported', async () => {
      const deps = createDefaultCp0SyncStatusMeasureDeps({
        measureOutbox: async (ctx) =>
          provenCount('outbox_pending', 1, {
            sourceId: 'async-outbox',
            measuredAtMs: ctx.nowMs,
          }),
        measureLegacy: async (ctx) =>
          provenCount('legacy_unreplayed', 1, {
            sourceId: 'async-legacy',
            measuredAtMs: ctx.nowMs,
          }),
      })
      const combined = await measureCp0SyncStatusCounts(deps, CTX)
      expect(combined.countsProven).toBe(true)
      expect(combined.effective.value).toBe(2)
    })
  })

  describe('metadata hygiene', () => {
    it('preserves source ids and reasons without secrets', async () => {
      const deps = createDefaultCp0SyncStatusMeasureDeps()
      const combined = await measureCp0SyncStatusCounts(deps, CTX)
      for (const m of [combined.outbox, combined.legacy, combined.effective]) {
        expect(m.source.id).toMatch(/^[a-z0-9._:-]+$/)
        expect(m.reason.length).toBeGreaterThan(0)
        expect(m.reason).not.toMatch(/password|secret|api[_-]?key|Bearer\s+\S+/i)
      }
    })
  })
})
