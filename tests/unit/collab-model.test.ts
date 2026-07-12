// Unit tests for buildModel's Batch-2 overlay wiring: the design / collab / decision
// overlays that get folded onto derived Feature + Model objects. Uses a hand-built
// RawBoard literal (not the on-disk board) so every asserted value is pinned here.
import { describe, expect, it } from 'vitest'

import { buildModel } from '#/lib/model'
import type { RawBoard } from '#/lib/types'

// X = the feature the overlays target. feat-x depends on feat-a so its dependency
// depth is a real (non-zero) number, exercising the depthOf() walk.
const X = 'feat-x'

const raw: RawBoard = {
  fase_label: { build: 'Build', backlog: 'Backlog' },
  fase_persen: { build: 60, backlog: 0 },
  projects: [
    { id: 'proj-1', nama: 'Project One', status: 'active', tracks: ['track-1'] },
  ],
  features: [
    {
      id: 'feat-a',
      nama: 'Feature A (root)',
      track: 'track-1',
      fase: 'backlog',
      checklist: [{ teks: 'a1', done: true }],
    },
    {
      id: X,
      nama: 'Feature X',
      track: 'track-1',
      fase: 'build',
      deps: ['feat-a'],
      checklist: [
        { teks: 'x1', done: true },
        { teks: 'x2', done: false },
      ],
    },
  ],
  decisions: [
    {
      id: 'dec-open',
      teks: 'Which auth provider for Feature X?',
      status: 'open',
      featureId: X,
      opsi: [
        { key: 'clerk', label: 'Clerk', rekomendasi: true },
        { key: 'authjs', label: 'Auth.js' },
      ],
    },
    {
      id: 'dec-done',
      teks: 'Already decided',
      status: 'decided',
      keputusan: 'Went with Postgres',
      tanggal_putus: '2026-07-01',
    },
  ],
  log: [
    { tanggal: '2026-07-05T10:00:00Z', teks: 'oldest log entry' },
    { tanggal: '2026-07-09T10:00:00Z', teks: 'newer log entry' },
  ],
  queue: { now: [X], next: ['feat-a'] },
  runs: [],
  design: {
    projects: {},
    features: {
      [X]: [
        { label: 'Figma spec', url: 'https://figma.com/feat-x' },
        { url: 'https://example.com/no-label' },
      ],
    },
  },
  collab: {
    comments: {
      [X]: [
        {
          id: 'c1',
          featureId: X,
          author: 'you',
          authorType: 'human',
          text: 'Looks good, ship it',
          ts: '2026-07-08T12:00:00Z',
        },
      ],
    },
    activity: [
      {
        ts: '2026-07-10T09:30:00Z',
        actor: 'grok-worker',
        actorType: 'agent',
        kind: 'comment',
        text: 'Opened a question on Feature X',
        featureId: X,
      },
    ],
  },
}

const m = buildModel(raw)

describe('buildModel — Batch 2 overlay wiring', () => {
  it('folds the design overlay onto featById[X].design', () => {
    const fx = m.featById[X]
    expect(fx).toBeDefined()
    expect(fx.design).toHaveLength(2)
    expect(fx.design[0]).toEqual({ label: 'Figma spec', url: 'https://figma.com/feat-x' })
    expect(fx.design[1].url).toBe('https://example.com/no-label')
    // a feature with no design overlay gets an empty array, not undefined
    expect(m.featById['feat-a'].design).toEqual([])
  })

  it('folds the collab comments overlay onto featById[X].comments', () => {
    const fx = m.featById[X]
    expect(fx.comments).toHaveLength(1)
    expect(fx.comments[0].id).toBe('c1')
    expect(fx.comments[0].author).toBe('you')
    expect(fx.comments[0].authorType).toBe('human')
    expect(fx.comments[0].text).toBe('Looks good, ship it')
    // unrelated feature has no comments
    expect(m.featById['feat-a'].comments).toEqual([])
  })

  it('computes feature.depth as a number (dependency chain length)', () => {
    const fx = m.featById[X]
    const fa = m.featById['feat-a']
    expect(typeof fx.depth).toBe('number')
    expect(typeof fa.depth).toBe('number')
    expect(fa.depth).toBe(0) // root, no deps
    expect(fx.depth).toBe(1) // depends on feat-a
  })

  it('exposes only the open decision (with featureId) in model.openDecisions', () => {
    expect(m.decisions).toHaveLength(2)
    expect(m.openDecisions).toHaveLength(1)
    const open = m.openDecisions[0]
    expect(open.id).toBe('dec-open')
    expect(open.status).toBe('open')
    expect(open.featureId).toBe(X)
    // the decided one is absent from openDecisions
    expect(m.openDecisions.find((d) => d.id === 'dec-done')).toBeUndefined()
  })

  it('merges log[] + collab.activity[] into model.activity, newest first', () => {
    // 2 log entries + 1 collab activity event = 3 total
    expect(m.activity).toHaveLength(3)

    // sorted strictly newest -> oldest by ts
    const ts = m.activity.map((a) => a.ts)
    const sortedDesc = [...ts].sort((a, b) => (a < b ? 1 : a > b ? -1 : 0))
    expect(ts).toEqual(sortedDesc)

    // concrete newest-first order: collab event (07-10) > newer log (07-09) > oldest log (07-05)
    expect(m.activity[0].kind).toBe('comment')
    expect(m.activity[0].actor).toBe('grok-worker')
    expect(m.activity[0].featureId).toBe(X)
    expect(m.activity[1].kind).toBe('log')
    expect(m.activity[1].text).toBe('newer log entry')
    expect(m.activity[2].kind).toBe('log')
    expect(m.activity[2].text).toBe('oldest log entry')

    // both sources are represented
    expect(m.activity.some((a) => a.kind === 'log')).toBe(true)
    expect(m.activity.some((a) => a.kind === 'comment')).toBe(true)
    // log events are mapped: actor 'log', ts taken from log.tanggal
    const logEvents = m.activity.filter((a) => a.kind === 'log')
    expect(logEvents.every((a) => a.actor === 'log')).toBe(true)
  })
})
