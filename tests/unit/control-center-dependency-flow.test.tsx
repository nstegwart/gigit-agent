/**
 * ART-022 dependency flow — graph/tree modes, cycle warnings, zoom controls.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { DependencyFlow } from '#/components/control-center/dependency'
import {
  detectDependencyCycles,
  buildTreeOutline,
  blockedNodeSummaries,
} from '#/components/control-center/dependency/graphAnalysis'
import type { Feature } from '#/lib/types'

vi.mock('#/components/BoardLink', () => ({
  BoardLink: ({
    children,
    className,
    onClick,
    ...rest
  }: {
    children: React.ReactNode
    className?: string
    onClick?: () => void
    'data-testid'?: string
    'data-feature-id'?: string
  }) => (
    <a className={className} onClick={onClick} {...rest}>
      {children}
    </a>
  ),
}))

function feat(over: Partial<Feature> & Pick<Feature, 'id' | 'nama'>): Feature {
  return {
    projectId: 'proj-a',
    taskTotal: 3,
    taskDone: 1,
    parked: false,
    isBlocked: false,
    isDone: false,
    pct: null,
    phaseLabel: 'Build',
    phaseCls: 'ph-build',
    runs: [],
    design: [],
    comments: [],
    depth: 0,
    fase: 'build',
    deps: [],
    ...over,
  }
}

describe('graphAnalysis', () => {
  it('detectDependencyCycles finds a simple cycle', () => {
    const features = [
      feat({ id: 'a', nama: 'A', deps: ['c'] }),
      feat({ id: 'b', nama: 'B', deps: ['a'] }),
      feat({ id: 'c', nama: 'C', deps: ['b'] }),
    ]
    const cycles = detectDependencyCycles(features)
    expect(cycles.length).toBeGreaterThan(0)
    expect(cycles[0]?.message).toMatch(/Siklus/)
  })

  it('blockedNodeSummaries surfaces blocked reason', () => {
    const features = [
      feat({ id: 'x', nama: 'X', isBlocked: true, blocked: 'Menunggu API Sales' }),
    ]
    const blocked = blockedNodeSummaries(features)
    expect(blocked).toHaveLength(1)
    expect(blocked[0]?.message).toBe('Menunggu API Sales')
  })

  it('buildTreeOutline nests children under roots', () => {
    const features = [
      feat({ id: 'root', nama: 'Root' }),
      feat({ id: 'child', nama: 'Child', deps: ['root'] }),
    ]
    const tree = buildTreeOutline(features)
    expect(tree).toHaveLength(1)
    expect(tree[0]?.id).toBe('root')
    expect(tree[0]?.children[0]?.id).toBe('child')
  })
})

describe('DependencyFlow', () => {
  const desktopMq = {
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }

  beforeEach(() => {
    vi.stubGlobal('matchMedia', vi.fn(() => desktopMq))
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('renders empty state in id-ID when no features', () => {
    render(<DependencyFlow features={[]} />)
    expect(screen.getByText(/Tidak ada fitur untuk peta ketergantungan/)).toBeTruthy()
  })

  it('renders graph toolbar and nodes', () => {
    const features = [
      feat({ id: 'f1', nama: 'Checkout' }),
      feat({ id: 'f2', nama: 'Payment', deps: ['f1'] }),
    ]
    render(<DependencyFlow features={features} />)
    expect(screen.getByTestId('dependency-flow')).toBeTruthy()
    expect(screen.getByTestId('dependency-view-graph')).toBeTruthy()
    expect(screen.getByTestId('dependency-view-tree')).toBeTruthy()
    expect(screen.getAllByTestId('dependency-graph-node')).toHaveLength(2)
  })

  it('shows cycle warning when graph has a cycle', () => {
    const features = [
      feat({ id: 'a', nama: 'A', deps: ['c'] }),
      feat({ id: 'b', nama: 'B', deps: ['a'] }),
      feat({ id: 'c', nama: 'C', deps: ['b'] }),
    ]
    render(<DependencyFlow features={features} />)
    expect(screen.getByTestId('dependency-cycle-warning')).toBeTruthy()
  })

  it('switches to tree outline view', () => {
    const features = [feat({ id: 'r', nama: 'Root' })]
    render(<DependencyFlow features={features} />)
    fireEvent.click(screen.getByTestId('dependency-view-tree'))
    expect(screen.getByTestId('dependency-tree-panel')).toBeTruthy()
    expect(screen.getByTestId('dependency-tree-node')).toBeTruthy()
  })

  it('zoom controls update displayed level', () => {
    const features = [feat({ id: 'z', nama: 'Zoom' })]
    render(<DependencyFlow features={features} />)
    expect(screen.getByTestId('dependency-zoom-level').textContent).toBe('100%')
    fireEvent.click(screen.getByTestId('dependency-zoom-in'))
    expect(screen.getByTestId('dependency-zoom-level').textContent).toBe('115%')
    fireEvent.click(screen.getByTestId('dependency-zoom-reset'))
    expect(screen.getByTestId('dependency-zoom-level').textContent).toBe('100%')
  })

  it('shows collapse summary for large graphs', () => {
    const features = Array.from({ length: 50 }, (_, i) =>
      feat({ id: `f-${i}`, nama: `Fitur ${i}`, kelompok: i % 2 === 0 ? 'Sales' : 'Web' }),
    )
    render(<DependencyFlow features={features} collapseThreshold={48} />)
    expect(screen.getByTestId('dependency-collapse-summary')).toBeTruthy()
  })
})