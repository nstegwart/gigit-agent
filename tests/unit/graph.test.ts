// Unit tests for the pure DAG layout in src/lib/graph.ts. The board fixture is
// deterministic and test-owned so collection never depends on gitignored
// runtime data under data/boards/*.
import { describe, expect, it } from 'vitest'

import { edgePath, layoutDag } from '#/lib/graph'
import { buildModel } from '#/lib/model'
import type { Feature, RawBoard } from '#/lib/types'

const raw: RawBoard = {
  fase_label: { build: 'Build' },
  fase_persen: { build: 60 },
  projects: [
    {
      id: 'synthetic-project',
      nama: 'Synthetic project',
      status: 'planned',
      tracks: ['synthetic'],
    },
  ],
  features: [
    { id: 'root', nama: 'Root', track: 'synthetic', fase: 'build', deps: [] },
    {
      id: 'middle',
      nama: 'Middle',
      track: 'synthetic',
      fase: 'build',
      deps: ['root'],
    },
    {
      id: 'leaf',
      nama: 'Leaf',
      track: 'synthetic',
      fase: 'build',
      deps: ['middle'],
    },
    {
      id: 'side',
      nama: 'Side',
      track: 'synthetic',
      fase: 'build',
      deps: ['root'],
    },
  ],
  runs: [],
}
const m = buildModel(raw)

// Minimal Feature factory for the hand-made subset test.
function mkFeat(id: string, deps: Array<string>): Feature {
  return {
    id,
    nama: id,
    fase: 'build',
    deps,
    projectId: null,
    taskTotal: 0,
    taskDone: 0,
    parked: false,
    isBlocked: false,
    isDone: false,
    pct: 0,
    phaseLabel: 'Build',
    phaseCls: 'ph-build',
    runs: [],
    design: [],
    comments: [],
    depth: 0,
  }
}

describe('layoutDag — deterministic board fixture', () => {
  const layout = layoutDag(m.features)

  it('produces exactly one node per feature', () => {
    expect(layout.nodes).toHaveLength(m.features.length)
    expect(m.features.length).toBeGreaterThan(0)
  })

  it('spans at least 3 columns', () => {
    expect(layout.cols).toBeGreaterThanOrEqual(3)
  })

  it('every edge endpoint references a known node id', () => {
    const ids = new Set(layout.nodes.map((n) => n.id))
    expect(layout.edges.length).toBeGreaterThan(0)
    for (const e of layout.edges) {
      expect(ids.has(e.from)).toBe(true)
      expect(ids.has(e.to)).toBe(true)
    }
  })

  it('places roots (no in-subset deps) in column 0', () => {
    const subset = new Set(m.features.map((f) => f.id))
    const nodeById = new Map(layout.nodes.map((n) => [n.id, n]))
    const roots = m.features.filter(
      (f) => (f.deps ?? []).filter((d) => subset.has(d)).length === 0,
    )
    expect(roots.length).toBeGreaterThan(0)
    for (const r of roots) {
      const node = nodeById.get(r.id)
      expect(node).toBeDefined()
      expect(node!.col).toBe(0)
    }
  })
})

describe('edgePath', () => {
  it('returns an SVG path string starting with "M"', () => {
    const layout = layoutDag(m.features)
    const path = edgePath(layout.nodes[0], layout.nodes[1])
    expect(typeof path).toBe('string')
    expect(path.startsWith('M')).toBe(true)
  })
})

describe('layoutDag — hand-made 3-feature chain', () => {
  it('lays a→b→c out across exactly 3 columns', () => {
    const chain = [mkFeat('a', []), mkFeat('b', ['a']), mkFeat('c', ['b'])]
    const layout = layoutDag(chain)
    expect(layout.cols).toBe(3)
    expect(layout.nodes).toHaveLength(3)
    const colById = new Map(layout.nodes.map((n) => [n.id, n.col]))
    expect(colById.get('a')).toBe(0)
    expect(colById.get('b')).toBe(1)
    expect(colById.get('c')).toBe(2)
  })
})
