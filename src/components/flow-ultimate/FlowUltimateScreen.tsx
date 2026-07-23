import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
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
  positionStorageKey,
  projectColor,
  projectCss,
  projectLabel,
  savePosition,
} from './graph'
import {
  humanizeNodeMeta,
  humanizeScreen,
  humanizeTaskTitle,
  navHonestyBanner,
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
  LAYER_LABEL,
  MODE_LABEL,
  type FlowApi,
  type FlowDataBundle,
  type FlowMode,
  type FlowNavLayer,
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

const PAN_STEP = 40
const PAN_STEP_FAST = 80
/** Project-mode layer tabs (hidden in cross — no hidden-focus target). */
const FLOW_NAV_LAYERS: FlowNavLayer[] = ['app_flow', 'page_nav']

/**
 * Screen-space edge stroke width in CSS pixels.
 * Kept constant under zoom so edges stay ~1.5px on the viewport (not world-scaled).
 */
export const EDGE_LINE_WIDTH_PX = 1.5

/**
 * Map a world-space point through the active pan+zoom transform into stage
 * (viewport) CSS pixels. Used so a stage-sized edge canvas can stroke edges
 * that align with CSS-transformed HTML nodes.
 */
export function worldToViewport(
  wx: number,
  wy: number,
  t: Pick<FlowTransform, 'x' | 'y' | 'scale'>,
): { x: number; y: number } {
  return { x: wx * t.scale + t.x, y: wy * t.scale + t.y }
}

/**
 * Stage/viewport-sized canvas backing store. Never uses world layout extents —
 * that was the multi-GiB OOM path on large app-flow graphs (e.g. 28880×19284).
 */
export function edgeCanvasBackingSize(
  stageW: number,
  stageH: number,
  dpr: number,
): { cssW: number; cssH: number; bufW: number; bufH: number } {
  const cssW = Math.max(1, Math.floor(stageW) || 1)
  const cssH = Math.max(1, Math.floor(stageH) || 1)
  const ratio = Number.isFinite(dpr) && dpr > 0 ? dpr : 1
  return {
    cssW,
    cssH,
    bufW: Math.ceil(cssW * ratio),
    bufH: Math.ceil(cssH * ratio),
  }
}

const SHEET_FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

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
  return out.slice(0, 24)
}

function getSheetFocusables(sheet: HTMLElement): HTMLElement[] {
  return Array.from(sheet.querySelectorAll<HTMLElement>(SHEET_FOCUSABLE)).filter(
    (el) => {
      if (el.getAttribute('aria-hidden') === 'true') return false
      if (el.tabIndex < 0) return false
      // Skip inert / disabled
      if ((el as HTMLButtonElement).disabled) return false
      return true
    },
  )
}

export function FlowUltimateScreen({ data, boardId }: FlowUltimateScreenProps) {
  const stageRef = useRef<HTMLDivElement>(null)
  const edgesRef = useRef<HTMLCanvasElement>(null)
  const sheetRef = useRef<HTMLElement>(null)
  const closeBtnRef = useRef<HTMLButtonElement>(null)
  const openerRef = useRef<HTMLElement | null>(null)
  const sheetWasOpenRef = useRef(false)
  const [mode, setMode] = useState<FlowMode>('cross')
  /** Project-mode layer; cross always uses app_flow (no route reload). */
  const [layer, setLayer] = useState<FlowNavLayer>('app_flow')
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
  const modeRef = useRef(mode)
  const layerRef = useRef(layer)

  nodesRef.current = nodes
  transformRef.current = transform
  sheetOpenRef.current = sheetOpen
  modeRef.current = mode
  layerRef.current = layer

  /**
   * Coherent sheet close / focus policy for every dismiss path.
   * Clears openerRef always. Restores focus to (in order):
   * 1) explicit focusTarget (mode pill / brand initiator)
   * 2) original opener if still mounted
   * 3) selected mode tab or stage when opener unmounted
   */
  const closeSheet = useCallback((opts?: { focusTarget?: HTMLElement | null }) => {
    const wasOpen = sheetOpenRef.current
    setSheetOpen(false)
    setActiveNodeId(null)
    const opener = openerRef.current
    openerRef.current = null
    if (!wasOpen) return
    const preferred = opts?.focusTarget ?? null
    requestAnimationFrame(() => {
      if (preferred && document.contains(preferred)) {
        preferred.focus()
        return
      }
      if (opener && document.contains(opener)) {
        opener.focus()
        return
      }
      // Opener unmounted (graph rebuild) — land on intentional chrome
      const selectedTab = document.querySelector(
        '.flow-pill[aria-selected="true"]',
      ) as HTMLElement | null
      if (selectedTab) {
        selectedTab.focus()
        return
      }
      stageRef.current?.focus()
    })
  }, [])

  const rebuild = useCallback(
    (nextMode: FlowMode, nextLayer: FlowNavLayer = 'app_flow') => {
      const effectiveLayer = nextMode === 'cross' ? 'app_flow' : nextLayer
      const storageKey = positionStorageKey(nextMode, effectiveLayer)
      const saved = loadPositions(storageKey)
      const g = buildGraphForMode(data, nextMode, saved, effectiveLayer)
      setNodes(g.nodes)
      setEdges(g.edges)
      // Data rebuild always clears selection/sheet state.
      // Focus policy is applied by closeSheet when the sheet was open
      // (switchMode / brand paths); pure rebuild must not leave a stale opener.
      setActiveNodeId(null)
      setSheetOpen(false)
      openerRef.current = null
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
    rebuild('cross', 'app_flow')
  }, [rebuild])

  const resolveFocusInitiator = useCallback(
    (explicit?: HTMLElement | null): HTMLElement | null => {
      if (explicit && typeof document !== 'undefined' && document.contains(explicit)) {
        return explicit
      }
      if (
        typeof document !== 'undefined' &&
        document.activeElement instanceof HTMLElement
      ) {
        return document.activeElement
      }
      return null
    },
    [],
  )

  const switchMode = useCallback(
    (next: FlowMode, focusTarget?: HTMLElement | null) => {
      const initiator = resolveFocusInitiator(focusTarget)
      const sheetWasOpen = sheetOpenRef.current

      // Same mode: still dismiss an open sheet (brand reset / re-click pill).
      if (next === mode && nodes.length) {
        if (sheetWasOpen) {
          closeSheet({ focusTarget: initiator })
        }
        return
      }

      // Mode change rebuilds the graph — openers may unmount. Close with
      // coherent policy so focus lands on the intentional initiator.
      if (sheetWasOpen) {
        closeSheet({ focusTarget: initiator })
      } else {
        openerRef.current = null
      }
      // Reset layer to app_flow when entering project mode from another mode
      const nextLayer: FlowNavLayer =
        next === 'cross' ? 'app_flow' : layerRef.current
      if (next === 'cross') setLayer('app_flow')
      setMode(next)
      rebuild(next, nextLayer)
    },
    [mode, nodes.length, rebuild, closeSheet, resolveFocusInitiator],
  )

  /** In-screen layer toggle — no route / navigation reload. */
  const switchLayer = useCallback(
    (next: FlowNavLayer, focusTarget?: HTMLElement | null) => {
      if (mode === 'cross') return
      if (next === layer) return
      const initiator = resolveFocusInitiator(focusTarget)
      if (sheetOpenRef.current) {
        closeSheet({ focusTarget: initiator })
      } else {
        openerRef.current = null
      }
      setLayer(next)
      rebuild(mode, next)
    },
    [mode, layer, rebuild, closeSheet, resolveFocusInitiator],
  )

  /**
   * World layout extents only — HTML node layer + fit bounds.
   * Must NOT size the edge canvas (world can be ~29k×19k → multi-GiB bitmap).
   */
  const worldSize = useMemo(() => {
    let maxX = 800
    let maxY = 600
    for (const n of nodes) {
      maxX = Math.max(maxX, n.x + CARD_W + 80)
      maxY = Math.max(maxY, n.y + CARD_H + 80)
    }
    return { w: maxX, h: maxY }
  }, [nodes])

  /** Stage CSS size for viewport-sized edge canvas (ResizeObserver). */
  const [stageSize, setStageSize] = useState({ w: 0, h: 0 })

  useEffect(() => {
    const stage = stageRef.current
    if (!stage) return
    const read = () => {
      setStageSize({
        w: Math.max(0, Math.floor(stage.clientWidth)),
        h: Math.max(0, Math.floor(stage.clientHeight)),
      })
    }
    read()
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', read)
      return () => window.removeEventListener('resize', read)
    }
    const ro = new ResizeObserver(() => read())
    ro.observe(stage)
    return () => ro.disconnect()
  }, [])

  /**
   * Draw semantic edges on a stage-sized DPR canvas.
   * World anchors are mapped through pan+zoom so strokes align with CSS-scaled
   * HTML nodes. Natural clip = canvas bounds. Redraw on stage resize, pan,
   * zoom, node positions/drag, and mode/data edge sets.
   */
  useEffect(() => {
    const canvas = edgesRef.current
    const stage = stageRef.current
    if (!canvas || !stage) return
    const dpr = window.devicePixelRatio || 1
    const stageW = stageSize.w || stage.clientWidth || 1
    const stageH = stageSize.h || stage.clientHeight || 1
    const { cssW, cssH, bufW, bufH } = edgeCanvasBackingSize(stageW, stageH, dpr)
    canvas.width = bufW
    canvas.height = bufH
    canvas.style.width = `${cssW}px`
    canvas.style.height = `${cssH}px`
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    // Device-pixel transform; stroke in CSS/viewport pixels thereafter.
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, cssW, cssH)
    const line =
      getComputedStyle(document.documentElement)
        .getPropertyValue('--border-strong')
        .trim() || '#e0e0e0'
    ctx.strokeStyle = line
    // Screen-space width (not multiplied by transform.scale).
    ctx.lineWidth = EDGE_LINE_WIDTH_PX
    ctx.lineCap = 'round'
    const byId = Object.fromEntries(nodes.map((n) => [n.id, n]))
    const t = transform
    for (const e of edges) {
      const a = byId[e.from]
      const b = byId[e.to]
      if (!a || !b) continue
      const p0 = nodeCenter(a)
      const p1 = nodeCenter(b)
      const v0 = worldToViewport(p0.x, p0.y, t)
      const v1 = worldToViewport(p1.x, p1.y, t)
      // Control offset in viewport space (same relative shape as world dx*0.45).
      const dx = Math.abs(v1.x - v0.x) * 0.45
      ctx.beginPath()
      ctx.moveTo(v0.x, v0.y)
      ctx.bezierCurveTo(v0.x + dx, v0.y, v1.x - dx, v1.y, v1.x, v1.y)
      ctx.stroke()
    }
  }, [nodes, edges, transform, stageSize])

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

  /** Pan/center without opening sheet (keyboard focus path). */
  const panToNode = useCallback((id: string) => {
    const n = nodesRef.current.find((x) => x.id === id)
    if (!n) return
    const stage = stageRef.current
    if (!stage) return
    setTransform((t) =>
      centerTransform(
        n,
        stage.clientWidth,
        stage.clientHeight,
        t.scale,
        sheetOpenRef.current,
      ),
    )
  }, [])

  const openSheetForNode = useCallback(
    (id: string, opener?: HTMLElement | null) => {
      // Remember opener only when first opening (related links keep original).
      if (!sheetOpenRef.current) {
        if (opener) {
          openerRef.current = opener
        } else if (
          typeof document !== 'undefined' &&
          document.activeElement instanceof HTMLElement
        ) {
          openerRef.current = document.activeElement
        }
      }
      setActiveNodeId(id)
      setSheetOpen(true)
      centerOnNode(id, true)
    },
    [centerOnNode],
  )

  // Initial focus into dialog when it opens
  useEffect(() => {
    if (sheetOpen && !sheetWasOpenRef.current) {
      requestAnimationFrame(() => {
        const closeBtn = closeBtnRef.current
        if (closeBtn) {
          closeBtn.focus()
          return
        }
        const title = document.getElementById('sheet-title')
        if (title instanceof HTMLElement) title.focus()
      })
    }
    sheetWasOpenRef.current = sheetOpen
  }, [sheetOpen])

  // Escape + Tab trap while sheet open
  useEffect(() => {
    if (!sheetOpen) return
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') {
        ev.preventDefault()
        closeSheet()
        return
      }
      if (ev.key !== 'Tab') return
      const sheet = sheetRef.current
      if (!sheet) return
      const list = getSheetFocusables(sheet)
      if (list.length === 0) {
        ev.preventDefault()
        closeBtnRef.current?.focus()
        return
      }
      const first = list[0]
      const last = list[list.length - 1]
      const active = document.activeElement as HTMLElement | null
      if (ev.shiftKey) {
        if (!active || active === first || !sheet.contains(active)) {
          ev.preventDefault()
          last.focus()
        }
      } else if (!active || active === last || !sheet.contains(active)) {
        ev.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [sheetOpen, closeSheet])

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
        if (n) {
          const key = positionStorageKey(
            modeRef.current,
            modeRef.current === 'cross' ? 'app_flow' : layerRef.current,
          )
          savePosition(key, n.id, n.x, n.y)
        }
      } else {
        const el =
          (stageRef.current?.querySelector(
            `[data-node-id="${d.id.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"]`,
          ) as HTMLElement | null) ?? null
        openSheetForNode(d.id, el)
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

  /** Stage keyboard pan (Arrow / Shift+Arrow). */
  const onStageKeyDown = (e: ReactKeyboardEvent<HTMLElement>) => {
    if (sheetOpenRef.current) return
    const step = e.shiftKey ? PAN_STEP_FAST : PAN_STEP
    let dx = 0
    let dy = 0
    switch (e.key) {
      case 'ArrowLeft':
        dx = step
        break
      case 'ArrowRight':
        dx = -step
        break
      case 'ArrowUp':
        dy = step
        break
      case 'ArrowDown':
        dy = -step
        break
      default:
        return
    }
    e.preventDefault()
    setTransform((t) => ({ ...t, x: t.x + dx, y: t.y + dy }))
    setHintHidden(true)
  }

  const onNodeKeyDown = (
    e: ReactKeyboardEvent<HTMLElement>,
    id: string,
  ) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      e.stopPropagation()
      openSheetForNode(id, e.currentTarget)
    }
  }

  const onTablistKeyDown = (e: ReactKeyboardEvent<HTMLElement>) => {
    const idx = FLOW_MODES.indexOf(mode)
    if (idx < 0) return
    let nextIdx = idx
    switch (e.key) {
      case 'ArrowRight':
      case 'ArrowDown':
        nextIdx = (idx + 1) % FLOW_MODES.length
        break
      case 'ArrowLeft':
      case 'ArrowUp':
        nextIdx = (idx - 1 + FLOW_MODES.length) % FLOW_MODES.length
        break
      case 'Home':
        nextIdx = 0
        break
      case 'End':
        nextIdx = FLOW_MODES.length - 1
        break
      default:
        return
    }
    e.preventDefault()
    const next = FLOW_MODES[nextIdx]
    switchMode(next)
    requestAnimationFrame(() => {
      const btn = document.querySelector(
        `.flow-pill[data-mode="${next}"]`,
      ) as HTMLElement | null
      btn?.focus()
    })
  }

  /** Layer pills: Arrow/Home/End parity with mode tablist. Hidden in cross. */
  const onLayerTablistKeyDown = (e: ReactKeyboardEvent<HTMLElement>) => {
    if (mode === 'cross') return
    const idx = FLOW_NAV_LAYERS.indexOf(layer)
    if (idx < 0) return
    let nextIdx = idx
    switch (e.key) {
      case 'ArrowRight':
      case 'ArrowDown':
        nextIdx = (idx + 1) % FLOW_NAV_LAYERS.length
        break
      case 'ArrowLeft':
      case 'ArrowUp':
        nextIdx = (idx - 1 + FLOW_NAV_LAYERS.length) % FLOW_NAV_LAYERS.length
        break
      case 'Home':
        nextIdx = 0
        break
      case 'End':
        nextIdx = FLOW_NAV_LAYERS.length - 1
        break
      default:
        return
    }
    e.preventDefault()
    const next = FLOW_NAV_LAYERS[nextIdx]
    switchLayer(next)
    requestAnimationFrame(() => {
      const btn = document.querySelector(
        `.flow-layer-pill[data-layer="${next}"]`,
      ) as HTMLElement | null
      btn?.focus()
    })
  }

  const activeNode = activeNodeId
    ? nodes.find((n) => n.id === activeNodeId)
    : null
  const found = activeNode?.featureId
    ? findFeature(data, activeNode.featureId, activeNode.project)
    : null
  const feat = found?.feature ?? null
  const proj = found?.project ?? activeNode?.project
  /** Navigasi terkait — undirected semantic edge walk only (cap 12). */
  const related = useMemo(() => {
    if (!activeNode) return [] as FlowNode[]
    const ids = new Set<string>()
    edges.forEach((e) => {
      if (e.from === activeNode.id) ids.add(e.to)
      if (e.to === activeNode.id) ids.add(e.from)
    })
    return nodes.filter((o) => ids.has(o.id)).slice(0, 12)
  }, [activeNode, edges, nodes])

  /** Same soft feature — separately labeled; not navigation. */
  const sameFeature = useMemo(() => {
    if (!activeNode?.featureId) return [] as FlowNode[]
    return nodes
      .filter(
        (o) =>
          o.id !== activeNode.id && o.featureId === activeNode.featureId,
      )
      .slice(0, 12)
  }, [activeNode, nodes])

  const apis = activeNode ? collectApis(data, activeNode, feat?.id) : []
  const screens = (feat && feat.screens) || []
  const tasks = (feat && data.tasks_by_feature[feat.id]) || []
  const st = feat ? feat.status : activeNode?.status
  const pct = feat ? feat.pct || 0 : 0
  const sc = statusClass(st)
  const effectiveLayer: FlowNavLayer =
    mode === 'cross' ? 'app_flow' : layer
  const honestyMsg = navHonestyBanner(data.nav, effectiveLayer)

  const graphSummary = useMemo(() => {
    const modeLabel = MODE_LABEL[mode]
    const count = nodes.length
    const edgeCount = edges.length
    const parts = [
      `Mode ${modeLabel}.`,
      mode !== 'cross' ? `Lapisan ${LAYER_LABEL[layer]}.` : '',
      `${count} simpul.`,
      `${edgeCount} koneksi navigasi.`,
    ].filter(Boolean)
    if (activeNode) {
      parts.push(
        `Terpilih: ${activeNode.title}, ${statusLabel(activeNode.status)}.`,
      )
    }
    return parts.join(' ')
  }, [mode, layer, nodes.length, edges.length, activeNode])

  return (
    <div
      className="flow-ultimate-root"
      data-testid="flow-ultimate"
      data-board-id={boardId || ''}
      data-mode={mode}
      data-layer={effectiveLayer}
      data-page="alur"
    >
      <header className="flow-top" role="banner">
        {/* Exactly one document h1; not nested inside the brand button (D-A11Y-13). */}
        <h1 className="flow-sr-only">Alur</h1>
        <button
          type="button"
          className="flow-brand"
          data-testid="flow-brand"
          onClick={(e) => switchMode('cross', e.currentTarget)}
          title="Lintas Proyek"
          aria-label="Alur — Lintas Proyek"
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
            <span className="flow-brand-title">Alur</span>
            <small>Alur kerja interaktif</small>
          </div>
        </button>

        <nav
          className="flow-modes"
          aria-label="Mode alur kerja"
          role="tablist"
          onKeyDown={onTablistKeyDown}
        >
          {FLOW_MODES.map((m) => (
            <button
              key={m}
              type="button"
              className={`flow-pill${mode === m ? ' on' : ''}`}
              data-mode={m}
              role="tab"
              aria-selected={mode === m}
              aria-controls="flow-stage"
              id={`flow-tab-${m}`}
              tabIndex={mode === m ? 0 : -1}
              onClick={(e) => switchMode(m, e.currentTarget)}
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

        {mode !== 'cross' ? (
          <div
            className="flow-layers"
            role="tablist"
            aria-label="Lapisan navigasi"
            data-testid="flow-layer-toggle"
            onKeyDown={onLayerTablistKeyDown}
          >
            {FLOW_NAV_LAYERS.map((l) => (
              <button
                key={l}
                type="button"
                className={`flow-layer-pill${layer === l ? ' on' : ''}`}
                data-layer={l}
                role="tab"
                aria-selected={layer === l}
                tabIndex={layer === l ? 0 : -1}
                onClick={(e) => switchLayer(l, e.currentTarget)}
              >
                {LAYER_LABEL[l]}
              </button>
            ))}
          </div>
        ) : null}

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

      {honestyMsg ? (
        <div
          className="flow-honesty-pin"
          role="status"
          data-testid="flow-honesty-pin"
        >
          {honestyMsg}
        </div>
      ) : null}

      <div
        className="flow-sr-only"
        role="status"
        aria-live="polite"
        aria-atomic="true"
        data-testid="flow-graph-summary"
      >
        {graphSummary}
      </div>
      <ol className="flow-sr-only" data-testid="flow-graph-text-alt" aria-label="Daftar simpul alur">
        {nodes.map((n) => (
          <li key={n.id}>
            {n.title}, {statusLabel(n.status)}
            {n.project ? ` · ${projectLabel(n.project)}` : ''}
          </li>
        ))}
      </ol>

      <main
        className={`flow-stage${panning ? ' is-panning' : ''}`}
        ref={stageRef}
        id="flow-stage"
        role="tabpanel"
        aria-labelledby={`flow-tab-${mode}`}
        aria-label="Kanvas alur kerja"
        data-testid="flow-stage"
        tabIndex={0}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onWheel={onWheel}
        onKeyDown={onStageKeyDown}
        inert={sheetOpen ? true : undefined}
      >
        {/*
          Stage-sized edge canvas (not inside scaled .flow-world).
          Backing store = stage CSS × DPR; edges drawn in viewport coords.
        */}
        <canvas
          className="flow-edges"
          ref={edgesRef}
          aria-hidden="true"
          data-testid="flow-edges"
        />
        <div
          className="flow-world"
          data-testid="flow-world"
          style={{
            width: worldSize.w,
            height: worldSize.h,
            transform: `translate(${transform.x}px, ${transform.y}px) scale(${transform.scale})`,
          }}
        >
          <div
            className="flow-nodes"
            data-testid="flow-nodes"
            style={{ width: worldSize.w, height: worldSize.h }}
          >
            {nodes.map((n) => {
              const on = activeNodeId === n.id
              const scN = statusClass(n.status)
              const stLabel = statusLabel(n.status)
              const isInv = n.kind === 'inventory' || n.inventoryBadge
              const accessibleName = isInv
                ? `${n.title}, Inventaris, ${stLabel}`
                : `${n.title}, ${stLabel}`
              return (
                <div
                  key={n.id}
                  role="button"
                  tabIndex={0}
                  className={`fnode${mode === 'cross' || n.project ? ' has-proj' : ''}${isInv ? ' is-inventory' : ''}${on ? ' on is-hl' : ''}${draggingId === n.id ? ' is-dragging' : ''}`}
                  data-node-id={n.id}
                  data-node-kind={n.kind}
                  data-testid="flow-node"
                  aria-label={accessibleName}
                  aria-pressed={on || undefined}
                  onKeyDown={(e) => onNodeKeyDown(e, n.id)}
                  onFocus={() => panToNode(n.id)}
                  style={{
                    left: n.x,
                    top: n.y,
                    ['--proj-c' as string]: n.project
                      ? projectColor(n.project)
                      : undefined,
                  }}
                >
                  <span className={`fdot ${scN}`} aria-hidden="true" />
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <span className="ft">{n.title}</span>
                    {isInv ? (
                      <span className="flow-inv-badge">Inventaris</span>
                    ) : null}
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
                    <span className="flow-meta">{humanizeNodeMeta(n.meta)}</span>
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
          Seret kanvas untuk geser · seret simpul untuk pindah · klik simpul untuk
          detail · panah untuk geser kanvas
        </div>
      </main>

      <div
        className="flow-zoom"
        aria-label="Kontrol perbesaran"
        inert={sheetOpen ? true : undefined}
      >
        <button
          type="button"
          title="Perbesar"
          aria-label="Perbesar"
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
          aria-label="Perkecil"
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
          aria-label="Muat semua"
          onClick={() => {
            const stage = stageRef.current
            if (!stage) return
            setTransform(
              fitTransform(nodes, stage.clientWidth, stage.clientHeight),
            )
          }}
        >
          Muat
        </button>
      </div>

      <button
        type="button"
        className={`flow-backdrop${sheetOpen ? ' is-open' : ''}`}
        aria-label="Tutup detail"
        data-testid="flow-backdrop"
        onClick={() => closeSheet()}
        tabIndex={-1}
        aria-hidden={!sheetOpen}
      />

      <aside
        ref={sheetRef}
        className={`flow-sheet${sheetOpen ? ' is-open' : ''}`}
        id="flow-sheet"
        aria-hidden={!sheetOpen}
        role={sheetOpen ? 'dialog' : undefined}
        aria-modal={sheetOpen ? true : undefined}
        aria-labelledby="sheet-title"
        data-testid="flow-sheet"
        inert={!sheetOpen ? true : undefined}
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
            <h2
              className="flow-sheet-title"
              id="sheet-title"
              tabIndex={sheetOpen ? -1 : undefined}
            >
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
            ref={closeBtnRef}
            onClick={() => closeSheet()}
            tabIndex={sheetOpen ? 0 : -1}
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
                  <span className="pct">{pct}% terverifikasi</span>
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

              {feat?.doc_md ? (
                <section className="flow-sec">
                  <h3>Dokumentasi</h3>
                  <p className="flow-doc">{scrubTechIds(feat.doc_md)}</p>
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
                  <p className="flow-empty">Belum ada layar yang dipetakan.</p>
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
                      <b>{a.method}</b> {a.path}
                    </div>
                  ))
                ) : (
                  <p className="flow-empty">
                    Belum ada API terdaftar untuk langkah ini.
                  </p>
                )}
              </section>

              <section className="flow-sec">
                <h3>
                  Tugas bangun{' '}
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
                              tabIndex={sheetOpen ? 0 : -1}
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
                  <p className="flow-empty">Belum ada tugas terkait.</p>
                )}
              </section>

              <section className="flow-sec">
                <h3>
                  Navigasi terkait{' '}
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
                          tabIndex={sheetOpen ? 0 : -1}
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
                  <p className="flow-empty">Belum ada tetangga navigasi di graf ini.</p>
                )}
              </section>

              {sameFeature.length > 0 ? (
                <section className="flow-sec" data-testid="flow-same-feature">
                  <h3>
                    Fitur sama{' '}
                    <span className="flow-sec-hint">{sameFeature.length}</span>
                  </h3>
                  <p className="flow-empty" style={{ marginBottom: 8 }}>
                    Kartu lain dengan tautan fitur yang sama — bukan navigasi.
                  </p>
                  <ul className="flow-list-plain">
                    {sameFeature.map((r) => (
                      <li key={r.id}>
                        <button
                          type="button"
                          data-goto={r.id}
                          data-testid="flow-same-feature-item"
                          tabIndex={sheetOpen ? 0 : -1}
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
                </section>
              ) : null}
            </>
          ) : null}
        </div>
      </aside>
    </div>
  )
}
