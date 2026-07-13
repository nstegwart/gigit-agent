/**
 * Canonical route × viewport matrix for control-center harness.
 * Core routes captured at all viewports + 200% zoom; secondary at 1440 + 390.
 */

import { VIEWPORTS } from './keyboard.mjs'

export { VIEWPORTS }

export const VIEWPORT_ORDER = ['1440x900', '1024x768', '390x844', '360x800']

/**
 * @param {string} boardId
 */
export function buildRouteMatrix(boardId) {
  return [
    { path: `/b/${boardId}/`, label: 'Overview', mission: 'Q1', core: true, state: 'populated' },
    { path: `/b/${boardId}/work`, label: 'Work', mission: 'Q3', core: true, state: 'populated' },
    {
      path: `/b/${boardId}/work?bucket=DONE`,
      label: 'Work-DONE',
      mission: 'Q1',
      core: false,
      state: 'populated',
    },
    {
      path: `/b/${boardId}/work?bucket=ONGOING`,
      label: 'Work-ONGOING',
      mission: 'Q2',
      core: false,
      state: 'populated',
      zeroClick: true,
    },
    {
      path: `/b/${boardId}/work?bucket=NEXT`,
      label: 'Work-NEXT',
      mission: 'Q3',
      core: false,
      state: 'populated',
    },
    {
      path: `/b/${boardId}/work?bucket=QUEUED`,
      label: 'Work-QUEUED',
      mission: 'Q4',
      core: false,
      state: 'populated',
    },
    {
      path: `/b/${boardId}/work?bucket=BLOCKED`,
      label: 'Work-BLOCKED',
      mission: 'Q5',
      core: false,
      state: 'needs-human',
    },
    {
      path: `/b/${boardId}/work?bucket=RECONCILIATION_PENDING`,
      label: 'Work-RECON',
      mission: null,
      core: false,
      state: 'partial',
    },
    {
      path: `/b/${boardId}/work?bucket=RECONCILIATION_PENDING&stale=1`,
      label: 'Work-STALE',
      mission: null,
      core: false,
      state: 'stale',
    },
    {
      path: `/b/${boardId}/work?stale=1`,
      label: 'Work-STALE-RAW',
      mission: null,
      core: false,
      state: 'stale',
      rawStaleDeepLink: true,
    },
    {
      path: `/b/${boardId}/priority`,
      label: 'Priority',
      mission: 'Q7',
      core: true,
      state: 'populated',
    },
    { path: `/b/${boardId}/projects`, label: 'Projects', mission: null, core: false, state: 'populated' },
    { path: `/b/${boardId}/features`, label: 'Features', mission: null, core: false, state: 'populated' },
    { path: `/b/${boardId}/agents`, label: 'Agents', mission: 'Q2', core: false, state: 'populated' },
    { path: `/b/${boardId}/ops`, label: 'Ops', mission: null, core: false, state: 'populated' },
    {
      path: `/b/${boardId}/decisions`,
      label: 'Decisions',
      mission: 'Q6',
      core: true,
      state: 'needs-human',
    },
    {
      path: `/b/${boardId}/evidence`,
      label: 'Evidence',
      mission: 'Q8',
      core: true,
      state: 'populated',
    },
    { path: `/b/${boardId}/log`, label: 'Log-legacy', mission: null, core: false, state: 'populated' },
    { path: `/b/${boardId}/tasks`, label: 'Tasks-legacy', mission: null, core: false, state: 'populated' },
  ]
}

/**
 * Which viewports apply to a route row.
 * Core: all 4. Non-core: 1440 + 390 only (matrix completeness without explosion).
 */
export function viewportsForRoute(route) {
  if (route.core) return VIEWPORT_ORDER
  return ['1440x900', '390x844']
}

export function slugId(parts) {
  return String(parts)
    .replace(/[^\w.-]+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 120)
}

/**
 * Canonical planned capture count for board `mfs-rebuild` (19 routes):
 * - 5 core × 4 viewports = 20
 * - 14 secondary × 2 viewports = 28
 * - 5 core × 200% zoom = 5
 * Total = 53
 *
 * Contract tests pin this exact number so planned/captured bookkeeping cannot drift silently.
 */
export const EXPECTED_PLANNED_CAPTURES_MFS = 53

/**
 * Expand the full ordered capture plan (viewport rows + core 200% zoom).
 * Single source of truth for planned count + harness iteration.
 * @param {string} boardId
 * @returns {Array<{ kind: 'viewport'|'zoom200', route: object, vp: string, id: string }>}
 */
export function planCaptures(boardId = 'mfs-rebuild') {
  const routes = buildRouteMatrix(boardId)
  /** @type {Array<{ kind: 'viewport'|'zoom200', route: object, vp: string, id: string }>} */
  const items = []
  for (const r of routes) {
    for (const vp of viewportsForRoute(r)) {
      items.push({
        kind: 'viewport',
        route: r,
        vp,
        id: slugId(`${r.label}_${vp}`),
      })
    }
  }
  for (const r of routes.filter((x) => x.core)) {
    items.push({
      kind: 'zoom200',
      route: r,
      vp: '1440x900',
      id: slugId(`${r.label}_zoom200`),
    })
  }
  return items
}

/** Expected capture plan size (viewport matrix + core 200% zoom). */
export function countPlannedCaptures(boardId = 'mfs-rebuild') {
  return planCaptures(boardId).length
}

/**
 * Exact capture bookkeeping: planned = captured + skipped + error.
 * All counts must be program-emitted integers; consistent=false is a harness integrity fail.
 *
 * @param {{
 *   planned?: number,
 *   captured?: number|unknown[],
 *   skipped?: number|unknown[],
 *   error?: number|unknown[],
 *   errors?: number|unknown[],
 * }} input
 */
export function accountCaptureCounts(input = {}) {
  const asCount = (v) => {
    if (typeof v === 'number' && Number.isFinite(v)) return v
    if (Array.isArray(v)) return v.length
    return 0
  }
  const planned = asCount(input.planned)
  const captured = asCount(input.captured)
  const skipped = asCount(input.skipped)
  const error = asCount(input.error ?? input.errors)
  const accounted = captured + skipped + error
  const consistent = planned === accounted
  return {
    planned,
    captured,
    skipped,
    error,
    accounted,
    consistent,
    residual: planned - accounted,
  }
}

/**
 * Assert capture plan integrity for a board (used by self-test + contract).
 * @param {string} [boardId]
 */
export function assertPlannedCaptureContract(boardId = 'mfs-rebuild') {
  const planned = countPlannedCaptures(boardId)
  const plan = planCaptures(boardId)
  if (plan.length !== planned) {
    throw new Error(
      `CAPTURE_PLAN FAIL: planCaptures.length=${plan.length} != countPlannedCaptures=${planned}`,
    )
  }
  if (boardId === 'mfs-rebuild' && planned !== EXPECTED_PLANNED_CAPTURES_MFS) {
    throw new Error(
      `CAPTURE_PLAN FAIL: mfs-rebuild planned=${planned} expected ${EXPECTED_PLANNED_CAPTURES_MFS}`,
    )
  }
  return { planned, planLen: plan.length, expected: EXPECTED_PLANNED_CAPTURES_MFS }
}
