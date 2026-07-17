import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent,
  type WheelEvent,
} from 'react'
import { BoardLink as Link } from '#/components/BoardLink'
import type { Feature } from '#/lib/types'
import { edgePath, layoutDag, type GraphNode } from '#/lib/graph'
import { EmptyState, PhaseBadge } from '#/components/primitives'
import {
  blockedNodeSummaries,
  buildTreeOutline,
  detectDependencyCycles,
  groupFeatureCounts,
  type TreeOutlineNode,
} from './graphAnalysis'
import styles from './dependency.module.css'

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

const MIN_ZOOM = 0.4
const MAX_ZOOM = 2
const ZOOM_STEP = 0.15
const COLLAPSE_THRESHOLD = 48

type ViewMode = 'graph' | 'tree'

function nodeColor(feature: Feature): string {
  if (feature.isBlocked) return 'var(--blocked)'
  return PHASE_COLOR[feature.phaseCls] ?? 'var(--accent)'
}

function pathToNode(
  nodeId: string,
  edges: ReadonlyArray<{ from: string; to: string }>,
): Set<string> {
  const path = new Set<string>([nodeId])
  let frontier = [nodeId]
  while (frontier.length) {
    const next: string[] = []
    for (const e of edges) {
      if (frontier.includes(e.to) && !path.has(e.from)) {
        path.add(e.from)
        next.push(e.from)
      }
    }
    frontier = next
  }
  return path
}

function TreeBranch({
  node,
  selectedId,
  onSelect,
  depth,
}: {
  node: TreeOutlineNode
  selectedId: string | null
  onSelect: (id: string) => void
  depth: number
}) {
  const selected = selectedId === node.id
  return (
    <li className={styles.treeItem}>
      <Link
        to="/features/$featureId"
        params={{ featureId: node.id }}
        className={[styles.treeLink, selected ? styles.treeLinkSelected : ''].filter(Boolean).join(' ')}
        data-testid="dependency-tree-node"
        data-feature-id={node.id}
        data-depth={depth}
        aria-current={selected ? 'true' : undefined}
        onClick={() => onSelect(node.id)}
      >
        <span>{node.label}</span>
        {node.blocked ? (
          <span className={styles.treeBlocked} data-testid="dependency-tree-blocked">
            Terhambat
            {node.blockedReason ? `: ${node.blockedReason}` : ''}
          </span>
        ) : null}
      </Link>
      {node.children.length > 0 ? (
        <ul className={`${styles.treeList} ${styles.treeNested}`} role="group">
          {node.children.map((child) => (
            <TreeBranch
              key={child.id}
              node={child}
              selectedId={selectedId}
              onSelect={onSelect}
              depth={depth + 1}
            />
          ))}
        </ul>
      ) : null}
    </li>
  )
}

export interface DependencyFlowProps {
  features: ReadonlyArray<Feature>
  className?: string
  /** When feature count exceeds this, show group summary chips (never a hairball). */
  collapseThreshold?: number
}

/**
 * ART-022 dependency flow — zoom/pan/reset graph, tree outline, cycle/conflict warnings,
 * keyboard selection, path highlight, and honest blocked explanations.
 *
 * Hydration (#418 root cause on /map):
 * - SVG graph used useId() marker ids + absolute node coords from layoutDag
 * - matchMedia flipped default viewMode after mount (safe alone) but first paint already
 *   diverged when browser repaired SSR SVG/HTML or localeCompare order differed Node vs browser
 * - Correct fix: SSR + first client paint share one deterministic shell; mount interactive
 *   graph/tree/warnings only after useEffect clientReady. Never suppressHydrationWarning.
 */
export function DependencyFlow({
  features,
  className,
  collapseThreshold = COLLAPSE_THRESHOLD,
}: DependencyFlowProps) {
  const rootId = useId()
  const viewportRef = useRef<HTMLDivElement>(null)
  /** False on SSR and first client paint; flipped in useEffect only. */
  const [clientReady, setClientReady] = useState(false)
  const [viewMode, setViewMode] = useState<ViewMode>('graph')
  const [zoom, setZoom] = useState(1)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const [panning, setPanning] = useState(false)
  const panStart = useRef({ x: 0, y: 0, panX: 0, panY: 0 })
  const [selectedId, setSelectedId] = useState<string | null>(null)

  // Heavy graph work only after client gate (avoids SSR cost + any non-determinism in HTML).
  const layout = useMemo(
    () => (clientReady && features.length ? layoutDag([...features]) : null),
    [clientReady, features],
  )
  const cycles = useMemo(
    () => (clientReady ? detectDependencyCycles(features) : []),
    [clientReady, features],
  )
  const blocked = useMemo(
    () => (clientReady ? blockedNodeSummaries(features) : []),
    [clientReady, features],
  )
  const tree = useMemo(
    () => (clientReady ? buildTreeOutline(features) : []),
    [clientReady, features],
  )
  const groups = useMemo(
    () => (clientReady ? groupFeatureCounts(features) : []),
    [clientReady, features],
  )
  const showCollapseSummary = clientReady && features.length > collapseThreshold

  const nodeById = useMemo(() => {
    const m: Record<string, GraphNode> = {}
    if (!layout) return m
    for (const n of layout.nodes) m[n.id] = n
    return m
  }, [layout])

  const highlightIds = useMemo(() => {
    if (!selectedId || !layout) return new Set<string>()
    return pathToNode(selectedId, layout.edges)
  }, [selectedId, layout])

  const resetView = useCallback(() => {
    setZoom(1)
    setPan({ x: 0, y: 0 })
  }, [])

  const zoomIn = useCallback(() => {
    setZoom((z) => Math.min(MAX_ZOOM, +(z + ZOOM_STEP).toFixed(2)))
  }, [])

  const zoomOut = useCallback(() => {
    setZoom((z) => Math.max(MIN_ZOOM, +(z - ZOOM_STEP).toFixed(2)))
  }, [])

  const onWheel = useCallback((e: WheelEvent<HTMLDivElement>) => {
    e.preventDefault()
    const delta = e.deltaY > 0 ? -ZOOM_STEP : ZOOM_STEP
    setZoom((z) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, +(z + delta).toFixed(2))))
  }, [])

  const onPointerDown = useCallback(
    (e: MouseEvent<HTMLDivElement>) => {
      if (viewMode !== 'graph') return
      if ((e.target as HTMLElement).closest('a.wire-node')) return
      setPanning(true)
      panStart.current = { x: e.clientX, y: e.clientY, panX: pan.x, panY: pan.y }
    },
    [viewMode, pan.x, pan.y],
  )

  const onPointerMove = useCallback(
    (e: MouseEvent<HTMLDivElement>) => {
      if (!panning) return
      setPan({
        x: panStart.current.panX + (e.clientX - panStart.current.x),
        y: panStart.current.panY + (e.clientY - panStart.current.y),
      })
    },
    [panning],
  )

  const onPointerUp = useCallback(() => setPanning(false), [])

  const nodeOrder = useMemo(
    () => (layout ? layout.nodes.map((n) => n.id) : []),
    [layout],
  )

  const moveSelection = useCallback(
    (dir: -1 | 1) => {
      if (!nodeOrder.length) return
      const idx = selectedId ? nodeOrder.indexOf(selectedId) : -1
      const next = Math.min(nodeOrder.length - 1, Math.max(0, idx + dir))
      setSelectedId(nodeOrder[next] ?? null)
    },
    [nodeOrder, selectedId],
  )

  const onViewportKeyDown = useCallback(
    (e: KeyboardEvent<HTMLDivElement>) => {
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
        e.preventDefault()
        moveSelection(1)
      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
        e.preventDefault()
        moveSelection(-1)
      } else if (e.key === 'Home') {
        e.preventDefault()
        setSelectedId(nodeOrder[0] ?? null)
      } else if (e.key === 'End') {
        e.preventDefault()
        setSelectedId(nodeOrder[nodeOrder.length - 1] ?? null)
      } else if (e.key === '0' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault()
        resetView()
      }
    },
    [moveSelection, nodeOrder, resetView],
  )

  // Unlock interactive body only after hydrate. matchMedia must not affect first paint.
  useEffect(() => {
    setClientReady(true)
    const mq = window.matchMedia('(max-width: 767px)')
    const apply = () => setViewMode(mq.matches ? 'tree' : 'graph')
    apply()
    mq.addEventListener('change', apply)
    return () => mq.removeEventListener('change', apply)
  }, [])

  if (!features.length) {
    return <EmptyState>Tidak ada fitur untuk peta ketergantungan.</EmptyState>
  }

  const selectedFeature = selectedId
    ? features.find((f) => f.id === selectedId) ?? null
    : null

  // Shell attrs stay fixed until clientReady so SSR HTML === first client paint.
  const shellViewMode: ViewMode = clientReady ? viewMode : 'graph'
  const showGraphChrome = shellViewMode === 'graph' && clientReady

  return (
    <div
      className={[styles.root, className].filter(Boolean).join(' ')}
      data-testid="dependency-flow"
      data-view-mode={shellViewMode}
      data-client-ready={clientReady ? 'true' : 'false'}
      data-feature-count={features.length}
    >
      <div className={styles.toolbar} role="toolbar" aria-label="Kontrol peta ketergantungan">
        <div className={styles.toolbarGroup}>
          <button
            type="button"
            className={styles.toolBtn}
            aria-pressed={shellViewMode === 'graph'}
            onClick={() => setViewMode('graph')}
            data-testid="dependency-view-graph"
          >
            Grafik
          </button>
          <button
            type="button"
            className={styles.toolBtn}
            aria-pressed={shellViewMode === 'tree'}
            onClick={() => setViewMode('tree')}
            data-testid="dependency-view-tree"
          >
            Ringkasan teks
          </button>
        </div>
        {showGraphChrome ? (
          <div className={styles.toolbarGroup}>
            <button
              type="button"
              className={styles.toolBtn}
              onClick={zoomOut}
              aria-label="Perkecil"
              data-testid="dependency-zoom-out"
            >
              −
            </button>
            <span className={styles.zoomLabel} data-testid="dependency-zoom-level">
              {Math.round(zoom * 100)}%
            </span>
            <button
              type="button"
              className={styles.toolBtn}
              onClick={zoomIn}
              aria-label="Perbesar"
              data-testid="dependency-zoom-in"
            >
              +
            </button>
            <button
              type="button"
              className={styles.toolBtn}
              onClick={resetView}
              data-testid="dependency-zoom-reset"
            >
              Atur ulang
            </button>
          </div>
        ) : null}
      </div>

      {/* Feature-derived panels only after clientReady — keeps SSR shell byte-stable. */}
      {clientReady && (cycles.length > 0 || blocked.length > 0) ? (
        <div className={styles.warnings} data-testid="dependency-warnings">
          {cycles.map((c, i) => (
            <p
              key={`cycle-${i}`}
              className={`${styles.warning} ${styles.warningCycle}`}
              role="alert"
              data-testid="dependency-cycle-warning"
            >
              {c.message}
            </p>
          ))}
          {blocked.slice(0, 6).map((b) => (
            <p
              key={b.featureId}
              className={`${styles.warning} ${styles.warningBlocked}`}
              data-testid="dependency-blocked-warning"
              data-feature-id={b.featureId}
            >
              <strong>{b.featureId}</strong>: {b.message}
            </p>
          ))}
          {blocked.length > 6 ? (
            <p className={styles.collapseSummary}>
              +{blocked.length - 6} fitur terhambat lainnya — buka ringkasan teks untuk detail.
            </p>
          ) : null}
        </div>
      ) : null}

      {showCollapseSummary ? (
        <div data-testid="dependency-collapse-summary">
          <p className={styles.collapseSummary}>
            Grafik menampilkan {features.length} fitur — dikelompokkan agar tetap terbaca:
          </p>
          <div className={styles.collapseChips}>
            {groups.map((g) => (
              <span key={g.key} className={styles.collapseChip}>
                {g.label}: {g.count}
              </span>
            ))}
          </div>
        </div>
      ) : null}

      {clientReady && selectedFeature?.isBlocked ? (
        <p
          className={styles.warningBlocked}
          data-testid="dependency-selected-blocked"
          role="status"
        >
          <strong>Mengapa terhambat:</strong>{' '}
          {typeof selectedFeature.blocked === 'string' && selectedFeature.blocked.trim()
            ? selectedFeature.blocked.trim()
            : 'Prasyarat belum terpenuhi pada jalur ketergantungan ini.'}
        </p>
      ) : null}

      {!clientReady ? (
        <div
          className={styles.viewport}
          data-testid="dependency-graph-pending"
          aria-busy="true"
          aria-live="polite"
          aria-label="Memuat peta ketergantungan"
        >
          <p className={styles.pendingLabel}>Memuat peta ketergantungan…</p>
        </div>
      ) : viewMode === 'tree' ? (
        <nav
          className={styles.treePanel}
          aria-labelledby={`${rootId}-tree-heading`}
          data-testid="dependency-tree-panel"
        >
          <h2 id={`${rootId}-tree-heading`} className={styles.srOnly}>
            Ringkasan ketergantungan fitur
          </h2>
          <ul className={styles.treeList} role="tree">
            {tree.map((node) => (
              <TreeBranch
                key={node.id}
                node={node}
                selectedId={selectedId}
                onSelect={setSelectedId}
                depth={0}
              />
            ))}
          </ul>
        </nav>
      ) : layout ? (
        <div
          ref={viewportRef}
          className={[styles.viewport, panning ? styles.viewportPanning : ''].filter(Boolean).join(' ')}
          data-testid="dependency-graph-viewport"
          tabIndex={0}
          role="application"
          aria-label="Peta ketergantungan fitur — gunakan panah untuk memilih node, Ctrl+0 untuk atur ulang"
          onWheel={onWheel}
          onMouseDown={onPointerDown}
          onMouseMove={onPointerMove}
          onMouseUp={onPointerUp}
          onMouseLeave={onPointerUp}
          onKeyDown={onViewportKeyDown}
        >
          <div
            className={`wire-wrap ${styles.canvas}`}
            style={{
              transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
              border: 'none',
              boxShadow: 'none',
              overflow: 'visible',
            }}
          >
            <div
              className="wire"
              style={{ width: layout.width, height: layout.height }}
            >
              <svg
                className="wire-edges"
                width={layout.width}
                height={layout.height}
                aria-hidden="true"
              >
                <defs>
                  <marker
                    id={`${rootId}-arrow`}
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
                  const onPath =
                    highlightIds.has(edge.from) && highlightIds.has(edge.to)
                  const dim =
                    selectedId && !onPath ? { opacity: 0.28 } : undefined
                  return (
                    <g key={`${edge.from}->${edge.to}-${i}`} style={dim}>
                      <title>Prasyarat: {from.feature.nama} → {to.feature.nama}</title>
                      <path
                        className={`wire-edge${edge.blocked ? ' blocked' : ''}`}
                        d={edgePath(from, to)}
                        markerEnd={`url(#${rootId}-arrow)`}
                      />
                    </g>
                  )
                })}
              </svg>
              {layout.nodes.map((node) => {
                const selected = selectedId === node.id
                const dim = selectedId && !highlightIds.has(node.id)
                return (
                  <Link
                    key={node.id}
                    to="/features/$featureId"
                    params={{ featureId: node.id }}
                    className="wire-node"
                    data-testid="dependency-graph-node"
                    data-feature-id={node.id}
                    aria-current={selected ? 'true' : undefined}
                    onClick={() => setSelectedId(node.id)}
                    style={
                      {
                        left: node.x,
                        top: node.y,
                        width: node.w,
                        height: node.h,
                        '--nc': nodeColor(node.feature),
                        opacity: dim ? 0.35 : 1,
                        outline: selected ? '2px solid var(--focus-ring)' : undefined,
                        outlineOffset: selected ? 2 : undefined,
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
                    {node.feature.isBlocked ? (
                      <span className={styles.treeBlocked} style={{ fontSize: 11 }}>
                        Terhambat
                      </span>
                    ) : null}
                  </Link>
                )
              })}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}