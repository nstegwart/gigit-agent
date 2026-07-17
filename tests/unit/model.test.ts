// Unit tests for buildModel — the pure adapter that turns raw board data into
// the derived, UI-ready Model. The generated fixture is deterministic,
// repository-owned test code and contains no production board data.
import { describe, expect, it } from 'vitest'

import { buildModel } from '#/lib/model'
import type { Feature, RawBoard } from '#/lib/types'

const PROJECT_SPECS = [
  {
    id: 'ibils-business',
    track: 'business',
    featureCount: 16,
    parkedCount: 8,
    livePhases: [
      'review-owner',
      'review-owner',
      'review-owner',
      'review-owner',
      'build',
      'build',
      'build',
      'build',
    ],
    sampledId: 'f4-m0-backend-foundation',
  },
  {
    id: 'qurasi',
    track: 'qurasi',
    featureCount: 10,
    parkedCount: 5,
    livePhases: ['design', 'design', 'design', 'build', 'qa'],
    sampledId: 'qurasi-post-artikel',
  },
  {
    id: 'cs-ai-service',
    track: 'cs-service',
    featureCount: 10,
    parkedCount: 5,
    livePhases: ['design', 'design', 'design', 'design', 'build'],
    sampledId: 'cs-core-service',
  },
  {
    id: 'ops-console',
    track: 'ops',
    featureCount: 10,
    parkedCount: 5,
    livePhases: ['build', 'build', 'build', 'build', 'build'],
    sampledId: 'ops-core',
  },
  {
    id: 'platform-api',
    track: 'platform',
    featureCount: 10,
    parkedCount: 5,
    livePhases: ['design', 'review-owner', 'build', 'qa', 'uat'],
    sampledId: 'platform-core',
  },
] as const

function buildSyntheticBoard(): RawBoard {
  const features: RawBoard['features'] = []

  for (const spec of PROJECT_SPECS) {
    const liveCount = spec.featureCount - spec.parkedCount
    for (let i = 0; i < liveCount; i += 1) {
      const id = i === 0 ? spec.sampledId : `${spec.track}-live-${i}`
      features.push({
        id,
        nama: `Synthetic ${spec.track} live ${i}`,
        track: spec.track,
        fase: spec.livePhases[i],
        blocked: i === liveCount - 1 ? 'Synthetic blocked case' : null,
        deps: i === 0 ? [] : [features[features.length - 1].id],
        checklist:
          id === 'f4-m0-backend-foundation'
            ? Array.from({ length: 9 }, (_, index) => ({
                teks: `Synthetic checkpoint ${index + 1}`,
                done: index < 3,
              }))
            : [],
      })
    }

    for (let i = 0; i < spec.parkedCount; i += 1) {
      features.push({
        id: `${spec.track}-parked-${i}`,
        nama: `Synthetic ${spec.track} parked ${i}`,
        track: spec.track,
        fase: 'backlog',
        bucket: 'nanti',
        deps: [],
        checklist: [],
      })
    }
  }

  const runningProjects = [
    'ibils-business',
    'ibils-business',
    'qurasi',
    'qurasi',
    'cs-ai-service',
    'ops-console',
  ]

  return {
    fase_label: {
      backlog: 'Backlog',
      design: 'Design',
      'review-owner': 'Owner review',
      build: 'Build',
      qa: 'QA',
      uat: 'UAT',
    },
    fase_persen: {
      backlog: 0,
      design: 40,
      'review-owner': 50,
      build: 60,
      qa: 80,
      uat: 100,
    },
    projects: PROJECT_SPECS.map((spec) => ({
      id: spec.id,
      nama: `Synthetic ${spec.id}`,
      status: 'planned',
      tracks: [spec.track],
    })),
    features,
    queue: {
      now: ['f4-m0-backend-foundation', 'qurasi-post-artikel'],
      next: ['cs-core-service', 'ops-core'],
      catatan: 'Deterministic synthetic queue',
    },
    runs: runningProjects.map((project, index) => ({
      id: `synthetic-run-${index + 1}`,
      agent: `fixture-agent-${index + 1}`,
      agentType: index % 2 === 0 ? 'codex' : 'grok',
      model: 'fixture-model',
      effort: 'fixture',
      task: `Synthetic run ${index + 1}`,
      project,
      status: 'running',
    })),
  }
}

const raw = buildSyntheticBoard()
const plan = raw

const m = buildModel(raw)

describe('buildModel — deterministic board fixture', () => {
  it('produces 5 projects and 56 features', () => {
    expect(m.projects).toHaveLength(5)
    expect(m.features).toHaveLength(56)
    expect(Object.keys(m.projById)).toHaveLength(5)
    expect(Object.keys(m.featById)).toHaveLength(56)
  })

  it('maps feature.projectId from track -> project for sampled features', () => {
    // business track -> ibils-business
    expect(m.featById['f4-m0-backend-foundation'].projectId).toBe(
      'ibils-business',
    )
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
    const rawFeat = plan.features.find(
      (x) => x.id === 'f4-m0-backend-foundation',
    )!
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
    expect(m.blocked).toHaveLength(
      m.features.filter((f) => Boolean(f.blocked)).length,
    )

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
