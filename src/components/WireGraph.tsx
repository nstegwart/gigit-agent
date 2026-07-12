import type { CSSProperties } from 'react'
import { BoardLink as Link } from '#/components/BoardLink'
import type { Feature } from '#/lib/types'
import { layoutDag, edgePath } from '#/lib/graph'
import type { GraphNode } from '#/lib/graph'
import { PhaseBadge, EmptyState } from '#/components/primitives'

// Left-border accent color per phase class; blocked always wins (red).
const PHASE_COLOR: Record<string, string> = {
  'ph-backlog': 'var(--text-faint)',
  'ph-spec': 'var(--text-dim)',
  'ph-design': 'var(--accent)',
  'ph-review': 'var(--accent)',
  'ph-build': 'var(--accent)',
  'ph-qa': 'var(--ok)',
  'ph-uat': 'var(--ok)',
  'ph-done': 'var(--ok)',
}

function nodeColor(feature: Feature): string {
  if (feature.isBlocked) return 'var(--blocked)'
  return PHASE_COLOR[feature.phaseCls] ?? 'var(--accent)'
}

export function WireGraph({ features }: { features: Array<Feature> }) {
  if (!features.length) return <EmptyState>No features.</EmptyState>

  const layout = layoutDag(features)
  const nodeById: Record<string, GraphNode> = {}
  for (const n of layout.nodes) nodeById[n.id] = n

  return (
    <div className="wire-wrap">
      <div
        className="wire"
        style={{ width: layout.width, height: layout.height }}
      >
        <svg
          className="wire-edges"
          width={layout.width}
          height={layout.height}
        >
          <defs>
            <marker
              id="wire-arrow"
              viewBox="0 0 8 8"
              refX="7"
              refY="4"
              markerWidth="6"
              markerHeight="6"
              orient="auto-start-reverse"
            >
              <path d="M0 0 L8 4 L0 8 z" fill="var(--border)" />
            </marker>
          </defs>
          {layout.edges.map((edge, i) => {
            const from = nodeById[edge.from]
            const to = nodeById[edge.to]
            if (!from || !to) return null
            return (
              <path
                key={`${edge.from}->${edge.to}-${i}`}
                className={`wire-edge${edge.blocked ? ' blocked' : ''}`}
                d={edgePath(from, to)}
                markerEnd="url(#wire-arrow)"
              />
            )
          })}
        </svg>
        {layout.nodes.map((node) => (
          <Link
            key={node.id}
            to="/features/$featureId"
            params={{ featureId: node.id }}
            className="wire-node"
            style={
              {
                left: node.x,
                top: node.y,
                width: node.w,
                height: node.h,
                '--nc': nodeColor(node.feature),
              } as CSSProperties
            }
          >
            <span className="wn-name">{node.feature.nama}</span>
            <span className="wn-meta">
              <PhaseBadge feature={node.feature} />
              <span>
                {node.feature.taskDone}/{node.feature.taskTotal}
              </span>
            </span>
          </Link>
        ))}
      </div>
    </div>
  )
}
