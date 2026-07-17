import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent,
} from 'react'

import {
  buildGraphForMode,
  centerTransform,
  clamp,
  findFeature,
  fitTransform,
  loadPositions,
  nodeCenter,
  projectColor,
  projectCss,
  projectLabel,
  savePosition,
} from './graph'
import {
  humanizeScreen,
  humanizeTaskTitle,
  scrubTechIds,
  statusClass,
  statusLabel,
  verdictLabel,
} from './humanize'
import {
  CARD_H,
  CARD_W,
  DRAG_THRESHOLD,
  FLOW_MODES,
  MODE_LABEL,
  type FlowApi,
  type FlowDataBundle,
  type FlowMode,
  type FlowNode,
  type FlowTransform,
} from './types'
import './flow-ultimate.css'

export interface FlowUltimateScreenProps {
  data: FlowDataBundle
  boardId?: string
}

interface NodeDragState {
  id: string
  startX: number
  startY: number
  origX: number
  origY: number
  grabDX: number
  grabDY: number
  moved: boolean
}

interface PanState {
  x: number
  y: number
  ox: number
  oy: number
}

function collectApis(
  data: FlowDataBundle,
  n: FlowNode,
  featId: string | null | undefined,
): FlowApi[] {
  const out: FlowApi[] = []
  const push = (method: string, path: string) => {
    if (!method || !path) return
    path = String(path).replace(/[·].*$/, '').trim()
    if (!path.startsWith('/')) return
    if (!out.some((a) => a.method === method && a.path === path)) {
      out.push({ method, path })
    }
  }
  const rawList: string[] = []
  if (n.apis) rawList.push(...n.apis)
  if (n.step?.api) rawList.push(n.step.api)
  rawList.forEach((raw) => {
    String(raw)
      .split(/\s*·\s*/)
      .forEach((part) => {
        const m = part.trim().match(/^(GET|POST|PUT|PATCH|DELETE)\s+(\S+)/i)
        if (m) push(m[1].toUpperCase(), m[2])
      })
  })
  if (featId && data.apis_by_feature[featId]) {
    data.apis_by_feature[featId].forEach((a) => push(a.method, a.path))
  }
  if (n.kind === 'cross' && n.step?.n && data.premium_apis) {
    data.premium_apis
      .filter((a) => a.n === n.step?.n)
      .forEach((a) => push(a.method, a.path))
  }
  return out.slice(0, 24)
}

export function FlowUltimateScreen({ data, boardId }: FlowUltimateScreenProps) {
  const stageRef = useRef<HTMLDivElement>(null)
  const edgesRef = useRef<HTMLCanvasElement>(null)
  const [mode, setMode] = useState<FlowMode>('cross')
  const [nodes, setNodes] = useState<FlowNode[]>([])
  const [edges, setEdges] = useState<{ from: string; to: string }[]>([])
  const [transform, setTransform] = useState<FlowTransform>({
    x: 80,
    y: 60,
    scale: 1,
  })
  const [activeNodeId, setActiveNodeId] = useState<string | null>(null)
  const [sheetOpen, setSheetOpen] = useState(false)
  const [hintHidden, setHintHidden] = useState(false)
  const [panning, setPanning] = useState(false)
  const [draggingId, setDraggingId] = useState<string | null>(null)
  const dragRef = useRef<NodeDragState | null>(null)
  const panRef = useRef<PanState | null>(null)
  const nodesRef = useRef(nodes)
  const transformRef = useRef(transform)
  const sheetOpenRef = useRef(sheetOpen)

  nodesRef.current = nodes
  transformRef.current = transform
  sheetOpenRef.current = sheetOpen

  const rebuild = useCallback(
    (nextMode: FlowMode) => {
      const saved = loadPositions(nextMode)
      const g = buildGraphForMode(data, nextMode, saved)
      setNodes(g.nodes)
      setEdges(g.edges)
      setActiveNodeId(null)
      setSheetOpen(false)
      // fit after layout
      requestAnimationFrame(() => {
        const stage = stageRef.current
        if (!stage) return
        setTransform(fitTransform(g.nodes, stage.clientWidth, stage.clientHeight))
      })
    },
    [data],
  )

  useEffect(() => {
    rebuild('cross')
  }, [rebuild])

  const switchMode = useCallback(
    (next: FlowMode) => {
      if (next === mode && nodes.length) return
      setMode(next)
      rebuild(next)
    },
    [mode, nodes.length, rebuild],
  )

  const worldSize = useMemo(() => {
    let maxX = 800
    let maxY = 600
    for (const n of nodes) {
      maxX = Math.max(maxX, n.x + CARD_W + 80)
      maxY = Math.max(maxY, n.y + CARD_H + 80)
    }
    return { w: maxX, h: maxY }
  }, [nodes])

  // Draw edges whenever nodes/edges/size change
  useEffect(() => {
    const canvas = edgesRef.current
    if (!canvas) return
    const dpr = window.devicePixelRatio || 1
    canvas.width = Math.ceil(worldSize.w * dpr)
    canvas.height = Math.ceil(worldSize.h * dpr)
    canvas.style.width = `${worldSize.w}px`
    canvas.style.height = `${worldSize.h}px`
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, worldSize.w, worldSize.h)
    const line =
      getComputedStyle(document.documentElement)
        .getPropertyValue('--border-strong')
        .trim() || '#e0e0e0'
    ctx.strokeStyle = line
    ctx.lineWidth = 1.5
    ctx.lineCap = 'round'
    const byId = Object.fromEntries(nodes.map((n) => [n.id, n]))
    for (const e of edges) {
      const a = byId[e.from]
      const b = byId[e.to]
      if (!a || !b) continue
      const p0 = nodeCenter(a)
      const p1 = nodeCenter(b)
      const dx = Math.abs(p1.x - p0.x) * 0.45
      ctx.beginPath()
      ctx.moveTo(p0.x, p0.y)
      ctx.bezierCurveTo(p0.x + dx, p0.y, p1.x - dx, p1.y, p1.x, p1.y)
      ctx.stroke()
    }
  }, [nodes, edges, worldSize])

  const centerOnNode = useCallback(
    (id: string, open = true) => {
      const n = nodesRef.current.find((x) => x.id === id)
      if (!n) return
      const stage = stageRef.current
      if (!stage) return
      const nextOpen = open || sheetOpenRef.current
      setActiveNodeId(id)
      if (open) setSheetOpen(true)
      setTransform((t) =>
        centerTransform(
          n,
          stage.clientWidth,
          stage.clientHeight,
          t.scale,
          nextOpen,
        ),
      )
    },
    [],
  )

  const openSheetForNode = useCallback(
    (id: string) => {
      setActiveNodeId(id)
      setSheetOpen(true)
      centerOnNode(id, true)
    },
    [centerOnNode],
  )

  const closeSheet = useCallback(() => {
    setSheetOpen(false)
    setActiveNodeId(null)
  }, [])

  const clientToWorld = useCallback((cx: number, cy: number) => {
    const stage = stageRef.current
    if (!stage) return { x: 0, y: 0 }
    const rect = stage.getBoundingClientRect()
    const t = transformRef.current
    return {
      x: (cx - rect.left - t.x) / t.scale,
      y: (cy - rect.top - t.y) / t.scale,
    }
  }, [])

  const onPointerDown = (e: ReactPointerEvent) => {
    if (e.button != null && e.button !== 0) return
    const target = (e.target as HTMLElement).closest('.fnode') as HTMLElement | null
    if (target) {
      const id = target.dataset.nodeId
      if (!id) return
      const n = nodesRef.current.find((x) => x.id === id)
      if (!n) return
      const w = clientToWorld(e.clientX, e.clientY)
      dragRef.current = {
        id,
        startX: e.clientX,
        startY: e.clientY,
        origX: n.x,
        origY: n.y,
        grabDX: w.x - n.x,
        grabDY: w.y - n.y,
        moved: false,
      }
      try {
        stageRef.current?.setPointerCapture(e.pointerId)
      } catch {
        /* */
      }
      e.preventDefault()
      return
    }
    if (
      (e.target as HTMLElement).closest('.flow-zoom') ||
      (e.target as HTMLElement).closest('.flow-sheet') ||
      (e.target as HTMLElement).closest('.flow-top')
    ) {
      return
    }
    setPanning(true)
    panRef.current = {
      x: e.clientX,
      y: e.clientY,
      ox: transformRef.current.x,
      oy: transformRef.current.y,
    }
    try {
      stageRef.current?.setPointerCapture(e.pointerId)
    } catch {
      /* */
    }
    e.preventDefault()
  }

  const onPointerMove = (e: ReactPointerEvent) => {
    if (dragRef.current) {
      const d = dragRef.current
      const dist = Math.hypot(e.clientX - d.startX, e.clientY - d.startY)
      if (dist > DRAG_THRESHOLD) d.moved = true
      if (d.moved) {
        setDraggingId(d.id)
        const w = clientToWorld(e.clientX, e.clientY)
        setNodes((prev) =>
          prev.map((n) =>
            n.id === d.id
              ? { ...n, x: w.x - d.grabDX, y: w.y - d.grabDY }
              : n,
          ),
        )
      }
      return
    }
    if (panRef.current) {
      const p = panRef.current
      const dx = e.clientX - p.x
      const dy = e.clientY - p.y
      setTransform((t) => ({ ...t, x: p.ox + dx, y: p.oy + dy }))
      setHintHidden(true)
    }
  }

  const onPointerUp = () => {
    if (dragRef.current) {
      const d = dragRef.current
      if (d.moved) {
        const n = nodesRef.current.find((x) => x.id === d.id)
        if (n) savePosition(mode, n.id, n.x, n.y)
      } else {
        openSheetForNode(d.id)
      }
      dragRef.current = null
      setDraggingId(null)
    }
    if (panRef.current) {
      panRef.current = null
      setPanning(false)
    }
  }

  const onWheel = (e: ReactWheelEvent) => {
    e.preventDefault()
    const stage = stageRef.current
    if (!stage) return
    const rect = stage.getBoundingClientRect()
    const mx = e.clientX - rect.left
    const my = e.clientY - rect.top
    const before = clientToWorld(e.clientX, e.clientY)
    const factor = e.deltaY < 0 ? 1.08 : 1 / 1.08
    setTransform((t) => {
      const scale = clamp(t.scale * factor, 0.25, 2.5)
      return {
        scale,
        x: mx - before.x * scale,
        y: my - before.y * scale,
      }
    })
  }

  useEffect(() => {
    if (!sheetOpen) return
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') closeSheet()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [sheetOpen, closeSheet])

  const activeNode = activeNodeId
    ? nodes.find((n) => n.id === activeNodeId)
    : null
  const found = activeNode?.featureId
    ? findFeature(data, activeNode.featureId, activeNode.project)
    : null
  const feat = found?.feature ?? null
  const proj = found?.project ?? activeNode?.project
  const related = useMemo(() => {
    if (!activeNode) return [] as FlowNode[]
    const ids = new Set<string>()
    edges.forEach((e) => {
      if (e.from === activeNode.id) ids.add(e.to)
      if (e.to === activeNode.id) ids.add(e.from)
    })
    if (activeNode.featureId) {
      nodes.forEach((o) => {
        if (o.id !== activeNode.id && o.featureId === activeNode.featureId) {
          ids.add(o.id)
        }
      })
    }
    return nodes.filter((o) => ids.has(o.id)).slice(0, 12)
  }, [activeNode, edges, nodes])

  const apis = activeNode ? collectApis(data, activeNode, feat?.id) : []
  const screens = (feat && feat.screens) || []
  const tasks = (feat && data.tasks_by_feature[feat.id]) || []
  const st = feat ? feat.status : activeNode?.status
  const pct = feat ? feat.pct || 0 : 0
  const sc = statusClass(st)

  return (
    <div
      className="flow-ultimate-root"
      data-testid="flow-ultimate"
      data-board-id={boardId || ''}
      data-mode={mode}
      data-page="alur"
    >
      <header className="flow-top" role="banner">
        <button
          type="button"
          className="flow-brand"
          onClick={() => switchMode('cross')}
          title="Lintas-Project"
        >
          <span className="logo" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="15" fill="none">
              <path
                d="M5 19L12 5l7 14"
                stroke="#fff"
                strokeWidth="1.8"
                strokeLinejoin="round"
              />
            </svg>
          </span>
          <div>
            Alur
            <small>Workflow interaktif</small>
          </div>
        </button>

        <nav className="flow-modes" aria-label="Mode workflow" role="tablist">
          {FLOW_MODES.map((m) => (
            <button
              key={m}
              type="button"
              className={`flow-pill${mode === m ? ' on' : ''}`}
              data-mode={m}
              role="tab"
              aria-selected={mode === m}
              onClick={() => switchMode(m)}
            >
              {m !== 'cross' ? (
                <span
                  className="flow-pill-dot"
                  style={{ background: projectCss(m) }}
                />
              ) : null}
              {MODE_LABEL[m]}
            </button>
          ))}
        </nav>

        <div className="flow-legend" aria-label="Legenda status">
          <span>
            <i style={{ background: 'var(--ok)' }} />
            Terbukti
          </span>
          <span>
            <i style={{ background: 'var(--warn)' }} />
            Sebagian
          </span>
          <span>
            <i style={{ background: 'var(--bad)' }} />
            Belum
          </span>
        </div>
      </header>

      <main
        className={`flow-stage${panning ? ' is-panning' : ''}`}
        ref={stageRef}
        aria-label="Kanvas workflow"
        data-testid="flow-stage"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onWheel={onWheel}
      >
        <div
          className="flow-world"
          data-testid="flow-world"
          style={{
            width: worldSize.w,
            height: worldSize.h,
            transform: `translate(${transform.x}px, ${transform.y}px) scale(${transform.scale})`,
          }}
        >
          <canvas
            className="flow-edges"
            ref={edgesRef}
            aria-hidden="true"
            data-testid="flow-edges"
          />
          <div
            className="flow-nodes"
            data-testid="flow-nodes"
            style={{ width: worldSize.w, height: worldSize.h }}
          >
            {nodes.map((n) => {
              const on = activeNodeId === n.id
              const scN = statusClass(n.status)
              return (
                <div
                  key={n.id}
                  className={`fnode${mode === 'cross' || n.project ? ' has-proj' : ''}${on ? ' on is-hl' : ''}${draggingId === n.id ? ' is-dragging' : ''}`}
                  data-node-id={n.id}
                  data-testid="flow-node"
                  style={{
                    left: n.x,
                    top: n.y,
                    ['--proj-c' as string]: n.project
                      ? projectColor(n.project)
                      : undefined,
                  }}
                >
                  <span className={`fdot ${scN}`} />
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <span className="ft">{n.title}</span>
                    {mode === 'cross' && n.project ? (
                      <span
                        className="flow-proj-tag"
                        style={{
                          ['--proj-c' as string]: projectColor(n.project),
                        }}
                      >
                        {projectLabel(n.project)}
                      </span>
                    ) : null}
                    <span className="flow-meta">{n.meta}</span>
                  </div>
                </div>
              )
            })}
          </div>
        </div>
        <div
          className={`flow-hint${hintHidden ? ' is-hidden' : ''}`}
          id="flow-hint"
        >
          Seret kanvas untuk geser · seret node untuk pindah · klik node untuk
          detail
        </div>
      </main>

      <div className="flow-zoom" aria-label="Kontrol zoom">
        <button
          type="button"
          title="Perbesar"
          onClick={() =>
            setTransform((t) => ({
              ...t,
              scale: clamp(t.scale * 1.15, 0.25, 2.5),
            }))
          }
        >
          +
        </button>
        <button
          type="button"
          title="Perkecil"
          onClick={() =>
            setTransform((t) => ({
              ...t,
              scale: clamp(t.scale / 1.15, 0.25, 2.5),
            }))
          }
        >
          −
        </button>
        <button
          type="button"
          title="Muat semua"
          onClick={() => {
            const stage = stageRef.current
            if (!stage) return
            setTransform(
              fitTransform(nodes, stage.clientWidth, stage.clientHeight),
            )
          }}
        >
          Fit
        </button>
      </div>

      <button
        type="button"
        className={`flow-backdrop${sheetOpen ? ' is-open' : ''}`}
        aria-label="Tutup detail"
        data-testid="flow-backdrop"
        onClick={closeSheet}
        tabIndex={sheetOpen ? 0 : -1}
      />

      <aside
        className={`flow-sheet${sheetOpen ? ' is-open' : ''}`}
        id="flow-sheet"
        aria-hidden={!sheetOpen}
        role="dialog"
        aria-modal="true"
        aria-labelledby="sheet-title"
        data-testid="flow-sheet"
      >
        <div className="flow-sheet-handle" aria-hidden="true" />
        <header className="flow-sheet-head">
          <div className="flow-sheet-head-text">
            <div
              className="flow-sheet-badge"
              style={
                proj
                  ? { ['--proj-c' as string]: projectColor(proj) }
                  : undefined
              }
            >
              {proj ? (
                <>
                  <i />
                  {projectLabel(proj)}
                </>
              ) : (
                MODE_LABEL[mode]
              )}
            </div>
            <h2 className="flow-sheet-title" id="sheet-title">
              {activeNode?.title || feat?.nama_id || 'Detail'}
            </h2>
            <p className="flow-sheet-sub">
              {scrubTechIds(
                feat?.ringkasan_id || activeNode?.flowTitle || '',
              )}
            </p>
          </div>
          <button
            type="button"
            className="flow-sheet-close"
            aria-label="Tutup"
            data-testid="flow-sheet-close"
            onClick={closeSheet}
          >
            ×
          </button>
        </header>
        <div className="flow-sheet-body" data-testid="flow-sheet-body">
          {activeNode ? (
            <>
              <section className="flow-sec">
                <h3>Status &amp; progres</h3>
                <div className="flow-status-row">
                  <span className={`chip ${sc}`}>
                    <b />
                    {statusLabel(st)}
                  </span>
                  <span className="pct">{pct}%</span>
                  <div
                    className={`flow-bar ${sc}`}
                    style={{ maxWidth: 220 }}
                  >
                    <i style={{ width: `${pct}%` }} />
                  </div>
                </div>
                {activeNode.flowTitle ? (
                  <p className="flow-empty">
                    Bagian alur: {activeNode.flowTitle}
                  </p>
                ) : null}
              </section>

              {feat?.ringkasan_id ? (
                <section className="flow-sec">
                  <h3>Ringkasan</h3>
                  <p className="flow-doc">
                    {scrubTechIds(feat.ringkasan_id)}
                  </p>
                </section>
              ) : null}

              <section className="flow-sec">
                <h3>
                  Layar{' '}
                  <span className="flow-sec-hint">{screens.length}</span>
                </h3>
                {screens.length ? (
                  <ul className="flow-list-plain">
                    {screens.slice(0, 40).map((s) => (
                      <li key={s}>{humanizeScreen(s)}</li>
                    ))}
                  </ul>
                ) : (
                  <p className="flow-empty">Belum ada layar terpetakan.</p>
                )}
              </section>

              <section className="flow-sec">
                <h3>
                  API terkait{' '}
                  <span className="flow-sec-hint">{apis.length}</span>
                </h3>
                {apis.length ? (
                  apis.map((a) => (
                    <div
                      className="flow-api"
                      key={`${a.method}:${a.path}`}
                    >
                      <b>{a.method}</b>
                      {a.path}
                    </div>
                  ))
                ) : (
                  <p className="flow-empty">
                    Tidak ada API terdaftar untuk langkah ini.
                  </p>
                )}
              </section>

              <section className="flow-sec">
                <h3>
                  Tugas pembangun{' '}
                  <span className="flow-sec-hint">{tasks.length}</span>
                </h3>
                {tasks.length ? (
                  <ul className="flow-list-plain">
                    {tasks.slice(0, 20).map((t) => {
                      const vc = statusClass(
                        t.verdict === 'MAPPED_100' ? 'terbukti' : 'sebagian',
                      )
                      const label = humanizeTaskTitle(t.judul_id)
                      const other = feat
                        ? nodes.find(
                            (o) =>
                              o.id !== activeNode.id &&
                              o.featureId === feat.id,
                          )
                        : null
                      if (other) {
                        return (
                          <li key={t.id}>
                            <button
                              type="button"
                              data-goto={other.id}
                              onClick={() => openSheetForNode(other.id)}
                            >
                              <span className="flow-link-nm">{label}</span>
                              <span className={`chip ${vc}`}>
                                <b />
                                {verdictLabel(t.verdict)}
                              </span>
                            </button>
                          </li>
                        )
                      }
                      return (
                        <li key={t.id} className="flow-task-row">
                          <div className="flow-task-title">{label}</div>
                          <span className={`chip ${vc}`}>
                            <b />
                            {verdictLabel(t.verdict)}
                          </span>
                        </li>
                      )
                    })}
                  </ul>
                ) : (
                  <p className="flow-empty">Tidak ada tugas terhubung.</p>
                )}
              </section>

              <section className="flow-sec">
                <h3>
                  Fitur terkait{' '}
                  <span className="flow-sec-hint">{related.length}</span>
                </h3>
                {related.length ? (
                  <ul className="flow-list-plain">
                    {related.map((r) => (
                      <li key={r.id}>
                        <button
                          type="button"
                          data-goto={r.id}
                          data-testid="flow-related"
                          onClick={() => openSheetForNode(r.id)}
                        >
                          <span className="flow-link-nm">{r.title}</span>
                          <span className="flow-link-meta">
                            {r.project
                              ? `${projectLabel(r.project)} · `
                              : ''}
                            {statusLabel(r.status)}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="flow-empty">Tidak ada tetangga di graf ini.</p>
                )}
              </section>
            </>
          ) : null}
        </div>
      </aside>
    </div>
  )
}
