/**
 * PACKET-P3D: fail-closed CP0 sync-status publisher runtime / scheduler.
 * Fake timers/deps only — no live MySQL, no outbox writer, no invented zeros.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  CP0_PUBLISHER_DEFAULT_PUBLISH_INTERVAL_MS,
  type Cp0SyncStatusPublishResult,
  type Cp0SyncStatusPublisherDeps,
} from '#/server/cp0-sync-status-publisher'
import {
  CP0_PUBLISHER_ENV_ALLOW_PRODUCTION,
  CP0_PUBLISHER_ENV_BOARDS,
  CP0_PUBLISHER_ENV_ENABLE,
  CP0_PUBLISHER_ENV_INTERVAL_MS,
  CP0_PUBLISHER_ENV_JITTER_MS,
  CP0_PUBLISHER_ENV_MAX_CONCURRENCY,
  CP0_PUBLISHER_ENV_TICK_TIMEOUT_MS,
  CP0_PUBLISHER_INTERVAL_MS_MAX,
  CP0_PUBLISHER_INTERVAL_MS_MIN,
  CP0_PUBLISHER_RUNTIME_SCHEMA,
  CP0_PUBLISHER_RUNTIME_SYMBOL,
  attachCp0SyncStatusPublisherRuntime,
  composeCp0PublisherRuntimeDeps,
  ensureCp0SyncStatusPublisherRuntime,
  getCp0PublisherRuntimeSnapshot,
  isCp0PublisherMasterEnabled,
  isCp0PublisherProductionBlocked,
  isValidCp0PublisherBoardId,
  parseCp0PublisherBoardAllowlist,
  parseCp0PublisherRuntimeConfig,
  peekCp0SyncStatusPublisherRuntime,
  sanitizeCp0PublisherRuntimeError,
  startCp0SyncStatusPublisherLoop,
  stopCp0SyncStatusPublisherRuntimeForTests,
  warmCp0SyncStatusPublisherRuntime,
  wrapPoolAsCp0PublisherMysqlClient,
} from '#/server/cp0-sync-status-publisher-runtime'
import {
  createMemoryControlPlaneRuntimeContext,
  resetControlPlaneRuntimeContextForTests,
} from '#/server/control-plane-runtime-context'

const BOARD_A = 'mfs-rebuild-staging-synth'
const BOARD_B = 'board-b'

function baseResult(
  boardId: string,
  overrides: Partial<Cp0SyncStatusPublishResult> = {},
): Cp0SyncStatusPublishResult {
  return {
    schemaVersion: 'CP0_SYNC_STATUS_PUBLISHER_V1',
    boardId,
    decision: 'PUBLISH_READBACK_REQUIRED',
    published: false,
    lockHeld: true,
    pinStable: true,
    candidate: null,
    rawStatus: 'READBACK_REQUIRED',
    effectiveStatus: 'READBACK_REQUIRED',
    zeroBacklogClaimed: false,
    countsProven: false,
    reasonCode: 'COUNTS_UNPROVEN',
    reason: 'outbox/legacy/effective counts not fully proven',
    measuredAtMs: 1_000,
    combined: null,
    tickId: 'tick-test',
    ...overrides,
  }
}

function fakeDeps(
  runImpl?: (boardId: string) => Promise<Cp0SyncStatusPublishResult>,
): {
  deps: Cp0SyncStatusPublisherDeps
  ticks: string[]
} {
  const ticks: string[] = []
  const deps: Cp0SyncStatusPublisherDeps = {
    nowMs: () => 1_000,
    acquirePublisherLock: async () => ({
      held: true,
      release: async () => {},
    }),
    readCanonicalPin: async () => ({
      boardRev: 1,
      lifecycleRev: 1,
      canonicalHash: 'a'.repeat(64),
    }),
    loadExistingRow: async () => null,
    casPublish: async () => ({ ok: true as const }),
  }
  // runTick is injected separately; deps only need shape for composition.
  void runImpl
  void ticks
  return { deps, ticks }
}

describe('cp0-sync-status-publisher-runtime (P3D)', () => {
  beforeEach(async () => {
    await stopCp0SyncStatusPublisherRuntimeForTests()
    resetControlPlaneRuntimeContextForTests()
    vi.useRealTimers()
  })

  afterEach(async () => {
    await stopCp0SyncStatusPublisherRuntimeForTests()
    resetControlPlaneRuntimeContextForTests()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  // -------------------------------------------------------------------------
  // Config / env (T1–T3, T17, T18)
  // -------------------------------------------------------------------------

  describe('env contract', () => {
    it('T1: master unset/0 ⇒ disabled ENV_OFF, no boards required', () => {
      expect(isCp0PublisherMasterEnabled({})).toBe(false)
      expect(isCp0PublisherMasterEnabled({ [CP0_PUBLISHER_ENV_ENABLE]: '0' })).toBe(
        false,
      )
      const cfg = parseCp0PublisherRuntimeConfig({
        [CP0_PUBLISHER_ENV_ENABLE]: '0',
        [CP0_PUBLISHER_ENV_BOARDS]: BOARD_A,
      })
      expect(cfg.enabled).toBe(false)
      expect(cfg.disableReason).toBe('ENV_OFF')
    })

    it('T2: env=1 + empty boards ⇒ DISABLED_NO_BOARDS', () => {
      const cfg = parseCp0PublisherRuntimeConfig({
        [CP0_PUBLISHER_ENV_ENABLE]: '1',
        [CP0_PUBLISHER_ENV_BOARDS]: '',
      })
      expect(cfg.enabled).toBe(false)
      expect(cfg.disableReason).toBe('DISABLED_NO_BOARDS')
      expect(cfg.boards).toEqual([])
    })

    it('T3: production CAIRN_ENV without ALLOW ⇒ BLOCKED_PRODUCTION_GATE', () => {
      const cfg = parseCp0PublisherRuntimeConfig({
        [CP0_PUBLISHER_ENV_ENABLE]: '1',
        [CP0_PUBLISHER_ENV_BOARDS]: BOARD_A,
        CAIRN_ENV: 'production',
      })
      expect(cfg.enabled).toBe(false)
      expect(cfg.disableReason).toBe('BLOCKED_PRODUCTION_GATE')
      expect(isCp0PublisherProductionBlocked({ CAIRN_ENV: 'production' })).toBe(
        true,
      )
    })

    it('T17: staging NODE_ENV=production still allowed; bare NODE_ENV=production not prod gate', () => {
      expect(
        isCp0PublisherProductionBlocked({
          NODE_ENV: 'production',
          CAIRN_ENV: 'staging',
        }),
      ).toBe(false)
      expect(
        isCp0PublisherProductionBlocked({ NODE_ENV: 'production' }),
      ).toBe(false)
      const staging = parseCp0PublisherRuntimeConfig({
        NODE_ENV: 'production',
        CAIRN_ENV: 'staging',
        [CP0_PUBLISHER_ENV_ENABLE]: '1',
        [CP0_PUBLISHER_ENV_BOARDS]: BOARD_A,
      })
      expect(staging.enabled).toBe(true)
      expect(staging.disableReason).toBeNull()

      const allowProd = parseCp0PublisherRuntimeConfig({
        CAIRN_ENV: 'production',
        [CP0_PUBLISHER_ENV_ENABLE]: '1',
        [CP0_PUBLISHER_ENV_BOARDS]: BOARD_A,
        [CP0_PUBLISHER_ENV_ALLOW_PRODUCTION]: '1',
      })
      expect(allowProd.enabled).toBe(true)
    })

    it('T18: interval/jitter/timeout/concurrency clamps are deterministic', () => {
      const low = parseCp0PublisherRuntimeConfig({
        [CP0_PUBLISHER_ENV_ENABLE]: '1',
        [CP0_PUBLISHER_ENV_BOARDS]: BOARD_A,
        [CP0_PUBLISHER_ENV_INTERVAL_MS]: '100',
        [CP0_PUBLISHER_ENV_JITTER_MS]: '999999',
        [CP0_PUBLISHER_ENV_TICK_TIMEOUT_MS]: '1',
        [CP0_PUBLISHER_ENV_MAX_CONCURRENCY]: '99',
      })
      expect(low.intervalMs).toBe(CP0_PUBLISHER_INTERVAL_MS_MIN)
      expect(low.jitterMs).toBeLessThanOrEqual(Math.floor(low.intervalMs / 2))
      expect(low.tickTimeoutMs).toBe(2_000)
      expect(low.maxConcurrency).toBe(4)

      const high = parseCp0PublisherRuntimeConfig({
        [CP0_PUBLISHER_ENV_ENABLE]: '1',
        [CP0_PUBLISHER_ENV_BOARDS]: BOARD_A,
        [CP0_PUBLISHER_ENV_INTERVAL_MS]: '999999',
      })
      expect(high.intervalMs).toBe(CP0_PUBLISHER_INTERVAL_MS_MAX)

      const defaults = parseCp0PublisherRuntimeConfig({
        [CP0_PUBLISHER_ENV_ENABLE]: '1',
        [CP0_PUBLISHER_ENV_BOARDS]: BOARD_A,
      })
      expect(defaults.intervalMs).toBe(CP0_PUBLISHER_DEFAULT_PUBLISH_INTERVAL_MS)
    })

    it('parses board allowlist; rejects control chars / empty / overlong', () => {
      expect(parseCp0PublisherBoardAllowlist(` ${BOARD_A}, ${BOARD_B} ,`)).toEqual([
        BOARD_A,
        BOARD_B,
      ])
      expect(parseCp0PublisherBoardAllowlist('a\nb,ok')).toEqual(['ok'])
      expect(isValidCp0PublisherBoardId('')).toBe(false)
      expect(isValidCp0PublisherBoardId('x'.repeat(65))).toBe(false)
      expect(isValidCp0PublisherBoardId(BOARD_A)).toBe(true)
    })

    it('accepts 1/true/yes/on case-insensitively for master flag', () => {
      for (const v of ['1', 'true', 'TRUE', 'yes', 'YES', 'on', 'On']) {
        expect(
          isCp0PublisherMasterEnabled({ [CP0_PUBLISHER_ENV_ENABLE]: v }),
        ).toBe(true)
      }
    })
  })

  // -------------------------------------------------------------------------
  // Loop semantics (T1/T2/T4/T6/T7/T8/T9)
  // -------------------------------------------------------------------------

  describe('loop', () => {
    it('T1/T2: disabled config starts no timers and runOnce is no-op', async () => {
      const setTimeoutFn = vi.fn(() => 1 as unknown as ReturnType<typeof setTimeout>)
      const { deps } = fakeDeps()
      const handle = startCp0SyncStatusPublisherLoop({
        config: parseCp0PublisherRuntimeConfig({}),
        deps,
        setTimeoutFn: setTimeoutFn as unknown as typeof setTimeout,
        clearTimeoutFn: vi.fn() as unknown as typeof clearTimeout,
      })
      expect(handle.isRunning()).toBe(false)
      expect(setTimeoutFn).not.toHaveBeenCalled()
      await handle.runOnce()
      expect(setTimeoutFn).not.toHaveBeenCalled()
      const snap = handle.getSnapshot()
      expect(snap.publisherRunning).toBe(false)
      expect(snap.schemaVersion).toBe(CP0_PUBLISHER_RUNTIME_SCHEMA)
    })

    it('T4: enabled + boards ⇒ immediate first tick', async () => {
      vi.useFakeTimers()
      const ticks: string[] = []
      const { deps } = fakeDeps()
      const handle = startCp0SyncStatusPublisherLoop({
        config: parseCp0PublisherRuntimeConfig({
          [CP0_PUBLISHER_ENV_ENABLE]: '1',
          [CP0_PUBLISHER_ENV_BOARDS]: `${BOARD_A},${BOARD_B}`,
          [CP0_PUBLISHER_ENV_INTERVAL_MS]: '30000',
          [CP0_PUBLISHER_ENV_JITTER_MS]: '0',
        }),
        deps,
        nowMs: () => Date.now(),
        random: () => 0.5,
        runTick: async (boardId) => {
          ticks.push(boardId)
          return baseResult(boardId, {
            decision: 'SKIP_LOCK_NOT_ACQUIRED',
            reasonCode: 'LOCK_NOT_ACQUIRED',
            lockHeld: false,
          })
        },
      })
      expect(handle.isRunning()).toBe(true)
      await vi.advanceTimersByTimeAsync(0)
      expect(ticks.sort()).toEqual([BOARD_A, BOARD_B].sort())
      await handle.stop()
      expect(handle.isRunning()).toBe(false)
    })

    it('T6: stop drains; further sweeps no-op', async () => {
      vi.useFakeTimers()
      let n = 0
      const { deps } = fakeDeps()
      const handle = startCp0SyncStatusPublisherLoop({
        config: parseCp0PublisherRuntimeConfig({
          [CP0_PUBLISHER_ENV_ENABLE]: '1',
          [CP0_PUBLISHER_ENV_BOARDS]: BOARD_A,
          [CP0_PUBLISHER_ENV_INTERVAL_MS]: '5000',
          [CP0_PUBLISHER_ENV_JITTER_MS]: '0',
        }),
        deps,
        random: () => 0.5,
        runTick: async (boardId) => {
          n += 1
          return baseResult(boardId)
        },
      })
      await vi.advanceTimersByTimeAsync(0)
      expect(n).toBe(1)
      await handle.stop()
      expect(handle.isRunning()).toBe(false)
      await handle.runOnce()
      expect(n).toBe(1)
    })

    it('T7: overlap — long tick causes SKIP_OVERLAP on concurrent sweep', async () => {
      vi.useFakeTimers()
      let release!: () => void
      const gate = new Promise<void>((r) => {
        release = r
      })
      let enterCount = 0
      const { deps } = fakeDeps()
      const handle = startCp0SyncStatusPublisherLoop({
        config: parseCp0PublisherRuntimeConfig({
          [CP0_PUBLISHER_ENV_ENABLE]: '1',
          [CP0_PUBLISHER_ENV_BOARDS]: BOARD_A,
          [CP0_PUBLISHER_ENV_INTERVAL_MS]: '5000',
          [CP0_PUBLISHER_ENV_JITTER_MS]: '0',
        }),
        deps,
        random: () => 0.5,
        // Manual drive only — first runOnce holds the gate; second overlaps.
        immediateFirstTick: false,
        runTick: async (boardId) => {
          enterCount += 1
          if (enterCount === 1) await gate
          return baseResult(boardId)
        },
      })
      const first = handle.runOnce()
      // Flush microtasks so first runTick is entered and parked on gate.
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
      expect(enterCount).toBe(1)
      // Concurrent sweep while still ticking → SKIP_OVERLAP
      await handle.runOnce()
      expect(handle.getSnapshot().overlapSkipCount).toBe(1)
      release()
      await first
      await handle.stop()
    })

    it('T8: per-board throw isolates; other boards still tick; error redacted', async () => {
      vi.useFakeTimers()
      const ticks: string[] = []
      const { deps } = fakeDeps()
      const handle = startCp0SyncStatusPublisherLoop({
        config: parseCp0PublisherRuntimeConfig({
          [CP0_PUBLISHER_ENV_ENABLE]: '1',
          [CP0_PUBLISHER_ENV_BOARDS]: `${BOARD_A},${BOARD_B}`,
          [CP0_PUBLISHER_ENV_INTERVAL_MS]: '30000',
          [CP0_PUBLISHER_ENV_JITTER_MS]: '0',
          [CP0_PUBLISHER_ENV_MAX_CONCURRENCY]: '1',
        }),
        deps,
        random: () => 0.5,
        runTick: async (boardId) => {
          ticks.push(boardId)
          if (boardId === BOARD_A) {
            throw Object.assign(new Error('ER_ACCESS_DENIED_ERROR: password=secret dsn=mysql://x'), {
              name: 'Error',
              code: 'ER_ACCESS_DENIED_ERROR',
              errno: 1045,
            })
          }
          return baseResult(boardId, {
            published: true,
            decision: 'PUBLISH_READBACK_REQUIRED',
            reasonCode: 'OK_READBACK_REQUIRED',
          })
        },
      })
      await vi.advanceTimersByTimeAsync(0)
      expect(ticks).toContain(BOARD_A)
      expect(ticks).toContain(BOARD_B)
      const snap = handle.getSnapshot()
      expect(snap.errorCount).toBeGreaterThanOrEqual(1)
      expect(snap.lastErrorToken).toBeTruthy()
      expect(snap.lastErrorToken).not.toMatch(/password/i)
      expect(snap.lastErrorToken).not.toMatch(/mysql:\/\//i)
      expect(snap.lastErrorToken).not.toMatch(/secret/i)
      await handle.stop()
    })

    it('T9: tick timeout does not hang; records error token', async () => {
      vi.useFakeTimers()
      const { deps } = fakeDeps()
      const handle = startCp0SyncStatusPublisherLoop({
        config: parseCp0PublisherRuntimeConfig({
          [CP0_PUBLISHER_ENV_ENABLE]: '1',
          [CP0_PUBLISHER_ENV_BOARDS]: BOARD_A,
          [CP0_PUBLISHER_ENV_INTERVAL_MS]: '30000',
          [CP0_PUBLISHER_ENV_JITTER_MS]: '0',
          [CP0_PUBLISHER_ENV_TICK_TIMEOUT_MS]: '2000',
        }),
        deps,
        random: () => 0.5,
        runTick: async () => {
          // Never resolves until far future
          await new Promise(() => {})
          return baseResult(BOARD_A)
        },
      })
      const p = vi.advanceTimersByTimeAsync(0)
      await Promise.resolve()
      await vi.advanceTimersByTimeAsync(2_000)
      await p
      const snap = handle.getSnapshot()
      expect(snap.errorCount).toBeGreaterThanOrEqual(1)
      expect(snap.lastErrorToken).toMatch(/TickTimeoutError/i)
      await handle.stop()
    })

    it('T10: lock not acquired increments lockMissCount', async () => {
      vi.useFakeTimers()
      const { deps } = fakeDeps()
      const handle = startCp0SyncStatusPublisherLoop({
        config: parseCp0PublisherRuntimeConfig({
          [CP0_PUBLISHER_ENV_ENABLE]: '1',
          [CP0_PUBLISHER_ENV_BOARDS]: BOARD_A,
          [CP0_PUBLISHER_ENV_JITTER_MS]: '0',
        }),
        deps,
        random: () => 0.5,
        runTick: async (boardId) =>
          baseResult(boardId, {
            decision: 'SKIP_LOCK_NOT_ACQUIRED',
            reasonCode: 'LOCK_NOT_ACQUIRED',
            lockHeld: false,
          }),
      })
      await vi.advanceTimersByTimeAsync(0)
      expect(handle.getSnapshot().lockMissCount).toBe(1)
      await handle.stop()
    })

    it('records success publish + pin without fabricating zeros', async () => {
      vi.useFakeTimers()
      const { deps } = fakeDeps()
      const handle = startCp0SyncStatusPublisherLoop({
        config: parseCp0PublisherRuntimeConfig({
          [CP0_PUBLISHER_ENV_ENABLE]: '1',
          [CP0_PUBLISHER_ENV_BOARDS]: BOARD_A,
          [CP0_PUBLISHER_ENV_JITTER_MS]: '0',
        }),
        deps,
        random: () => 0.5,
        runTick: async (boardId) =>
          baseResult(boardId, {
            published: true,
            decision: 'PUBLISH_IN_SYNC',
            reasonCode: 'OK_IN_SYNC_ZEROS',
            zeroBacklogClaimed: true,
            countsProven: true,
            rawStatus: 'IN_SYNC',
            candidate: {
              schemaVersion: 'CP0_SYNC_STATUS_PUBLISHER_V1',
              boardId,
              rawStatus: 'IN_SYNC',
              outbox_pending: 0,
              legacy_unreplayed: 0,
              effective_backlog: 0,
              board_rev: 10,
              lifecycle_rev: 2,
              canonical_hash: 'b'.repeat(64),
              last_ack_revision: 10,
              freshness_at: new Date(1_000).toISOString(),
              expectedEntityRev: null,
              nextEntityRev: 1,
              countsProven: true,
              pinStable: true,
              measuredAtMs: 1_000,
              reasonCode: 'OK_IN_SYNC_ZEROS',
              reason: 'dual proven',
              record: {
                schemaVersion: 'CP0_SYNC_STATUS_PUBLISHER_V1',
                publisherId: 'cp0-runtime',
                tickId: 't1',
                measuredAtMs: 1_000,
                pin: {
                  boardRev: 10,
                  lifecycleRev: 2,
                  canonicalHash: 'b'.repeat(64),
                },
                countsProven: true,
                rawStatus: 'IN_SYNC',
                measureReasonCode: null,
                measureSources: {
                  outbox: 'cp0-sync-outbox',
                  legacy: 'cp0-legacy-residuals',
                  effective: 'combined',
                },
              },
            },
          }),
      })
      await vi.advanceTimersByTimeAsync(0)
      const snap = handle.getSnapshot()
      expect(snap.successCount).toBe(1)
      expect(snap.lastPublishedBoardId).toBe(BOARD_A)
      expect(snap.lastEntityRev).toBe(1)
      expect(snap.lastPin?.boardRev).toBe(10)
      await handle.stop()
    })
  })

  // -------------------------------------------------------------------------
  // Singleton / ensure / attach (T5, T15, T16)
  // -------------------------------------------------------------------------

  describe('process singleton', () => {
    it('T5: double ensure returns one running handle', async () => {
      vi.useFakeTimers()
      const { deps } = fakeDeps()
      const env = {
        [CP0_PUBLISHER_ENV_ENABLE]: '1',
        [CP0_PUBLISHER_ENV_BOARDS]: BOARD_A,
        [CP0_PUBLISHER_ENV_JITTER_MS]: '0',
      }
      const a = ensureCp0SyncStatusPublisherRuntime({
        env,
        deps,
        runTick: async (boardId) => baseResult(boardId),
        random: () => 0.5,
      })
      const b = ensureCp0SyncStatusPublisherRuntime({
        env,
        deps,
        runTick: async (boardId) => baseResult(boardId),
        random: () => 0.5,
      })
      expect(a).not.toBeNull()
      expect(b).toBe(a)
      expect(peekCp0SyncStatusPublisherRuntime()).toBe(a)
      await a!.stop()
    })

    it('ensure env OFF returns null and snapshot shows ENV_OFF', () => {
      const h = ensureCp0SyncStatusPublisherRuntime({
        env: { [CP0_PUBLISHER_ENV_ENABLE]: '0' },
        deps: fakeDeps().deps,
      })
      expect(h).toBeNull()
      const snap = getCp0PublisherRuntimeSnapshot()
      expect(snap.publisherEnabled).toBe(false)
      expect(snap.disableReason).toBe('ENV_OFF')
      expect(snap.publisherRunning).toBe(false)
    })

    it('T15: import path does not start timer; Symbol.for is stable', () => {
      expect(CP0_PUBLISHER_RUNTIME_SYMBOL).toBe(
        Symbol.for('cairn.cp0SyncStatusPublisherRuntime.v1'),
      )
      // Module already imported at top — peek without ensure is null/stopped.
      // After stop in beforeEach, peek is null.
      expect(peekCp0SyncStatusPublisherRuntime()).toBeNull()
    })

    it('T16: memory control-plane context default has no CP0 loop', () => {
      const ctx = createMemoryControlPlaneRuntimeContext()
      expect(ctx.cp0SyncStatusPublisherLoop).toBeNull()
      expect(ctx.accountSyncSchedulerLoop).toBeNull()
    })

    it('attach API is alias of ensure; warm never throws', () => {
      expect(() =>
        warmCp0SyncStatusPublisherRuntime({
          env: { [CP0_PUBLISHER_ENV_ENABLE]: '0' },
        }),
      ).not.toThrow()
      const h = attachCp0SyncStatusPublisherRuntime({
        env: {
          [CP0_PUBLISHER_ENV_ENABLE]: '1',
          // empty boards
        },
        deps: fakeDeps().deps,
      })
      expect(h).toBeNull()
    })

    it('autoStart:false never starts even if env ON', () => {
      const h = ensureCp0SyncStatusPublisherRuntime({
        autoStart: false,
        env: {
          [CP0_PUBLISHER_ENV_ENABLE]: '1',
          [CP0_PUBLISHER_ENV_BOARDS]: BOARD_A,
        },
        deps: fakeDeps().deps,
      })
      expect(h).toBeNull()
      expect(getCp0PublisherRuntimeSnapshot().disableReason).toBe('NOT_STARTED')
    })
  })

  // -------------------------------------------------------------------------
  // Redaction / no outbox writer / composition
  // -------------------------------------------------------------------------

  describe('safety fences', () => {
    it('T14: sanitize strips secrets; snapshot has no password/DSN keys', async () => {
      const token = sanitizeCp0PublisherRuntimeError(
        Object.assign(new Error('Access denied for user root@localhost password=hunter2'), {
          name: 'Error',
          code: 'ER_ACCESS_DENIED_ERROR',
          errno: 1045,
        }),
      )
      expect(token).toMatch(/Error/)
      expect(token).not.toMatch(/hunter2/)
      expect(token).not.toMatch(/password=/i)

      vi.useFakeTimers()
      const handle = startCp0SyncStatusPublisherLoop({
        config: parseCp0PublisherRuntimeConfig({
          [CP0_PUBLISHER_ENV_ENABLE]: '1',
          [CP0_PUBLISHER_ENV_BOARDS]: BOARD_A,
          [CP0_PUBLISHER_ENV_JITTER_MS]: '0',
        }),
        deps: fakeDeps().deps,
        random: () => 0.5,
        runTick: async (b) => baseResult(b),
      })
      await vi.advanceTimersByTimeAsync(0)
      const snap = handle.getSnapshot()
      const json = JSON.stringify(snap)
      expect(json).not.toMatch(/password/i)
      expect(json).not.toMatch(/CAIRN_DB_PASSWORD/)
      expect(json).not.toMatch(/mysql:\/\//i)
      expect(Object.keys(snap)).not.toContain('password')
      expect(Object.keys(snap)).not.toContain('dsn')
      await handle.stop()
    })

    it('NO_OUTBOX_WRITER: runtime source has no outbox INSERT/claim/ACK/DEAD', () => {
      const src = readFileSync(
        join(process.cwd(), 'src/server/cp0-sync-status-publisher-runtime.ts'),
        'utf8',
      )
      expect(src).not.toMatch(/INSERT\s+INTO\s+control_plane_sync_outbox/i)
      expect(src).not.toMatch(/control_plane_legacy_residuals/i)
      expect(src).toMatch(/NO outbox enqueue/)
      expect(src).toMatch(/BLOCKED_MODEL/)
      // Sink publish composition only
      expect(src).toMatch(/createCp0SyncStatusPublisherMysqlDeps/)
      expect(src).toMatch(/createCp0MysqlBacklogCountMeasurers/)
      expect(src).toMatch(/runCp0SyncStatusPublisherTick/)
    })

    it('wrapPoolAsCp0PublisherMysqlClient only exposes query/getConnection', async () => {
      const released: string[] = []
      const pool = {
        query: vi.fn(async () => [[{ n: 1 }], undefined]),
        getConnection: vi.fn(async () => ({
          query: vi.fn(async () => [[{ n: 2 }], undefined]),
          release: () => released.push('ok'),
        })),
      }
      const client = wrapPoolAsCp0PublisherMysqlClient(pool)
      await client.query('SELECT 1')
      const conn = await client.getConnection()
      await conn.query('SELECT 2')
      conn.release()
      expect(released).toEqual(['ok'])
      expect(Object.keys(client).sort()).toEqual(['getConnection', 'query'])
    })

    it('composeCp0PublisherRuntimeDeps wires measure + mysql deps', () => {
      const pool = {
        query: async () => [[]],
        getConnection: async () => ({
          query: async () => [[]],
          release: () => {},
        }),
      }
      const client = wrapPoolAsCp0PublisherMysqlClient(pool)
      const deps = composeCp0PublisherRuntimeDeps({
        client,
        nowMs: () => 42,
        publisherId: 'cp0-runtime',
      })
      expect(typeof deps.acquirePublisherLock).toBe('function')
      expect(typeof deps.readCanonicalPin).toBe('function')
      expect(typeof deps.loadExistingRow).toBe('function')
      expect(typeof deps.casPublish).toBe('function')
      expect(deps.measureDeps).toBeTruthy()
      expect(deps.publisherId).toBe('cp0-runtime')
      expect(deps.nowMs()).toBe(42)
    })
  })

  // -------------------------------------------------------------------------
  // Jitter bounds
  // -------------------------------------------------------------------------

  it('T18b: scheduled delay stays within interval±jitter', async () => {
    vi.useFakeTimers()
    const scheduleDelays: number[] = []
    // Capture only scheduleNext delays (interval±jitter), not tick timeouts.
    const setTimeoutFn = ((fn: () => void, ms?: number) => {
      const m = typeof ms === 'number' ? ms : 0
      // Interval schedule range for this test: [7000, 13000]
      if (m >= 7_000 && m <= 13_000) scheduleDelays.push(m)
      return vi.getTimerCount() >= 0
        ? (globalThis.setTimeout(fn, m) as unknown as ReturnType<typeof setTimeout>)
        : (0 as unknown as ReturnType<typeof setTimeout>)
    }) as unknown as typeof setTimeout

    const handle = startCp0SyncStatusPublisherLoop({
      config: parseCp0PublisherRuntimeConfig({
        [CP0_PUBLISHER_ENV_ENABLE]: '1',
        [CP0_PUBLISHER_ENV_BOARDS]: BOARD_A,
        [CP0_PUBLISHER_ENV_INTERVAL_MS]: '10000',
        [CP0_PUBLISHER_ENV_JITTER_MS]: '3000',
        [CP0_PUBLISHER_ENV_TICK_TIMEOUT_MS]: '15000',
      }),
      deps: fakeDeps().deps,
      setTimeoutFn,
      clearTimeoutFn: clearTimeout as unknown as typeof clearTimeout,
      // fixed random → delta = (0.25*2-1)*3000 = -1500 → delay 8500
      random: () => 0.25,
      runTick: async (b) => baseResult(b),
      immediateFirstTick: true,
    })
    await vi.advanceTimersByTimeAsync(0)
    // After first sweep schedules next: expect 8500
    expect(scheduleDelays).toContain(8500)
    for (const d of scheduleDelays) {
      expect(d).toBeGreaterThanOrEqual(10_000 - 3_000)
      expect(d).toBeLessThanOrEqual(10_000 + 3_000)
    }
    await handle.stop()
  })
})
