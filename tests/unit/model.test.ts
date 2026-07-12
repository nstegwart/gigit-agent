// Unit tests for buildModel — the pure adapter that turns raw plan.json + runs.json
// into the derived, UI-ready Model. Feeds it the REAL board data on disk so the
// assertions double as a contract check on the committed SSOT.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { buildModel } from '#/lib/model'
import type { Feature, RawBoard } from '#/lib/types'

// vitest runs with cwd = project root; the ibils board now lives under
// data/boards/ibils/ (multi-board layout).
const dataDir = join(process.cwd(), 'data', 'boards', 'ibils')

function readJSON<T>(name: string): T {
  return JSON.parse(readFileSync(join(dataDir, name), 'utf8')) as T
}

// Merge exactly like the server store (readBoard): plan + runs.json's `runs`.
const plan = readJSON<Omit<RawBoard, 'runs'>>('plan.json')
const runsFile = readJSON<{ runs: RawBoard['runs'] }>('runs.json')
const raw: RawBoard = { ...plan, runs: runsFile.runs ?? [] }

const m = buildModel(raw)

describe('buildModel — real board data', () => {
  it('produces 5 projects and 56 features', () => {
    expect(m.projects).toHaveLength(5)
    expect(m.features).toHaveLength(56)
    expect(Object.keys(m.projById)).toHaveLength(5)
    expect(Object.keys(m.featById)).toHaveLength(56)
  })

  it('maps feature.projectId from track -> project for sampled features', () => {
    // business track -> ibils-business
    expect(m.featById['f4-m0-backend-foundation'].projectId).toBe('ibils-business')
    // qurasi track -> qurasi
    expect(m.featById['qurasi-post-artikel'].projectId).toBe('qurasi')
    // cs-service track -> cs-ai-service
    expect(m.featById['cs-core-service'].projectId).toBe('cs-ai-service')
  })

  it('every mapped projectId resolves to a real project (or null)', () => {
    for (const f of m.features) {
      if (f.projectId !== null) {
        expect(m.projById[f.projectId]).toBeDefined()
      }
    }
  })

  it('computes taskDone/taskTotal from the checklist for a known feature', () => {
    const f = m.featById['f4-m0-backend-foundation']
    const rawFeat = plan.features.find((x) => x.id === 'f4-m0-backend-foundation')!
    const cl = rawFeat.checklist ?? []
    expect(f.taskTotal).toBe(cl.length)
    expect(f.taskTotal).toBe(9)
    expect(f.taskDone).toBe(cl.filter((c) => c.done).length)
    expect(f.taskDone).toBe(3)
    expect(f.taskDone).toBeLessThanOrEqual(f.taskTotal)
  })

  it('resolves queue.now / queue.next ids to real Feature objects', () => {
    expect(m.queue.now.length).toBe(raw.queue!.now!.length)
    expect(m.queue.next.length).toBe(raw.queue!.next!.length)
    // first now id resolves to the matching Feature (derived shape, not a bare id)
    const firstNowId = raw.queue!.now![0]
    const firstNow = m.queue.now[0]
    expect(firstNow.id).toBe(firstNowId)
    expect(firstNow).toBe(m.featById[firstNowId])
    // Feature objects carry derived fields, proving they are not raw strings
    for (const f of [...m.queue.now, ...m.queue.next]) {
      expect(typeof f).toBe('object')
      expect(f).toHaveProperty('taskTotal')
      expect(f).toHaveProperty('phaseCls')
    }
    expect(m.queue.catatan).toBe(raw.queue!.catatan)
  })

  it('partitions blocked / parked / active correctly', () => {
    expect(m.blocked).toHaveLength(5)
    expect(m.parked).toHaveLength(28)
    expect(m.active).toHaveLength(23)

    // blocked = features with a truthy blocked field
    expect(m.blocked.every((f) => f.isBlocked)).toBe(true)
    expect(m.blocked).toHaveLength(m.features.filter((f) => Boolean(f.blocked)).length)

    // parked = bucket 'nanti'
    expect(m.parked.every((f) => f.parked && f.bucket === 'nanti')).toBe(true)

    // active = not parked, not blocked, phase in ACTIVE_PHASES; disjoint from the others
    const activeIds = new Set(m.active.map((f: Feature) => f.id))
    for (const f of m.active) {
      expect(f.parked).toBe(false)
      expect(f.isBlocked).toBe(false)
    }
    // active never overlaps parked or blocked
    for (const f of m.parked) expect(activeIds.has(f.id)).toBe(false)
    for (const f of m.blocked) expect(activeIds.has(f.id)).toBe(false)
  })

  it('runningAgents length matches the count of running runs', () => {
    const runningRaw = (raw.runs ?? []).filter((r) => r.status === 'running')
    expect(m.runningAgents).toHaveLength(runningRaw.length)
    expect(m.runningAgents).toHaveLength(6)
    expect(m.runningAgents.every((r) => r.status === 'running')).toBe(true)
  })

  it('computes project.progress and project.activeAgents', () => {
    const biz = m.projById['ibils-business']
    expect(biz.features.length).toBe(16)
    expect(biz.progress).toBe(55)
    expect(biz.activeAgents).toBe(2)

    const qurasi = m.projById['qurasi']
    expect(qurasi.progress).toBe(52)
    expect(qurasi.activeAgents).toBe(2)

    const cs = m.projById['cs-ai-service']
    expect(cs.progress).toBe(44)
    expect(cs.activeAgents).toBe(1)

    // progress is a bounded integer; activeAgents matches running runs for that project
    for (const p of m.projects) {
      expect(p.progress).toBeGreaterThanOrEqual(0)
      expect(p.progress).toBeLessThanOrEqual(100)
      expect(Number.isInteger(p.progress)).toBe(true)
      const running = (raw.runs ?? []).filter(
        (r) => r.project === p.id && r.status === 'running',
      ).length
      expect(p.activeAgents).toBe(running)
      // project.features only contains features mapped to this project
      expect(p.features.every((f) => f.projectId === p.id)).toBe(true)
    }
  })
})
