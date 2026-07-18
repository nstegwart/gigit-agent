/**
 * TM_CANON_V3_LEGACY_ROUTES_DEMOTED_LOCAL — static route-contract tests.
 *
 * Proves control-center board (mfs-rebuild via isControlCenterBoard) legacy
 * IA routes short-circuit to `/b/$boardId/alur` with replace semantics before
 * expensive loaders, classic boards keep non-redirect behavior, alur has no
 * loop-back, and out-of-scope routes are untouched.
 *
 * LOCAL ONLY — no browser/live claim.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  CONTROL_CENTER_BOARD_IDS,
  isControlCenterBoard,
} from '#/lib/control-center-query'
import { DEFAULT_CONTROL_CENTER_BOARD_ID } from '#/lib/control-center-default-board'

const ROOT = process.cwd()
const routesDir = join(ROOT, 'src/routes')

function routeSrc(rel: string): string {
  return readFileSync(join(routesDir, rel), 'utf8')
}

function routeExists(rel: string): boolean {
  return existsSync(join(routesDir, rel))
}

/** beforeLoad + isControlCenterBoard + throw redirect to alur + replace: true */
function assertControlCenterAlurDemotion(src: string, label: string) {
  expect(src, `${label}: must import isControlCenterBoard`).toMatch(
    /isControlCenterBoard/,
  )
  expect(src, `${label}: must use beforeLoad short-circuit`).toMatch(
    /beforeLoad\s*:\s*\(\s*\{\s*params\s*\}/,
  )
  expect(src, `${label}: must gate on isControlCenterBoard(params.boardId)`).toMatch(
    /if\s*\(\s*isControlCenterBoard\(\s*params\.boardId\s*\)\s*\)/,
  )
  expect(src, `${label}: must throw redirect`).toMatch(/throw\s+redirect\s*\(/)
  expect(src, `${label}: must target /b/$boardId/alur`).toMatch(
    /to:\s*['"]\/b\/\$boardId\/alur['"]/,
  )
  expect(src, `${label}: must use replace: true`).toMatch(/replace:\s*true/)
  expect(src, `${label}: must pass boardId param through`).toMatch(
    /params:\s*\{\s*boardId:\s*params\.boardId\s*\}/,
  )
}

/**
 * On-disk route modules demoted in this packet.
 * TanStack index routes use `*.index.tsx` (no bare `projects.tsx` etc.).
 */
const DEMOTED_ROUTE_FILES: ReadonlyArray<{
  family: string
  file: string
  createPath: string
}> = [
  {
    family: 'rebuild',
    file: 'b.$boardId.rebuild.tsx',
    createPath: '/b/$boardId/rebuild',
  },
  {
    family: 'work (layout)',
    file: 'b.$boardId.work.tsx',
    createPath: '/b/$boardId/work',
  },
  {
    family: 'work/$taskId',
    file: 'b.$boardId.work.$taskId.tsx',
    createPath: '/b/$boardId/work/$taskId',
  },
  {
    family: 'priority',
    file: 'b.$boardId.priority.tsx',
    createPath: '/b/$boardId/priority',
  },
  {
    family: 'projects (index)',
    file: 'b.$boardId.projects.index.tsx',
    createPath: '/b/$boardId/projects/',
  },
  {
    family: 'projects/$projectId',
    file: 'b.$boardId.projects.$projectId.tsx',
    createPath: '/b/$boardId/projects/$projectId',
  },
  {
    family: 'fitur (index)',
    file: 'b.$boardId.fitur.index.tsx',
    createPath: '/b/$boardId/fitur/',
  },
  {
    family: 'fitur/$featureId',
    file: 'b.$boardId.fitur.$featureId.tsx',
    createPath: '/b/$boardId/fitur/$featureId',
  },
  {
    family: 'features (index)',
    file: 'b.$boardId.features.index.tsx',
    createPath: '/b/$boardId/features/',
  },
  {
    family: 'features/$featureId',
    file: 'b.$boardId.features.$featureId.tsx',
    createPath: '/b/$boardId/features/$featureId',
  },
  {
    family: 'tasks (index)',
    file: 'b.$boardId.tasks.index.tsx',
    createPath: '/b/$boardId/tasks/',
  },
  {
    family: 'tasks/$taskId',
    file: 'b.$boardId.tasks.$taskId.tsx',
    createPath: '/b/$boardId/tasks/$taskId',
  },
  {
    family: 'map',
    file: 'b.$boardId.map.tsx',
    createPath: '/b/$boardId/map',
  },
]

/** Brace-expansion aliases that do not exist on disk (TanStack uses .index). */
const ABSENT_BARE_ALIASES = [
  'b.$boardId.projects.tsx',
  'b.$boardId.fitur.tsx',
  'b.$boardId.features.tsx',
  'b.$boardId.tasks.tsx',
] as const

describe('inventory: demoted route files exist; bare aliases absent', () => {
  it('every demoted on-disk route module is present', () => {
    for (const r of DEMOTED_ROUTE_FILES) {
      expect(routeExists(r.file), `missing ${r.file}`).toBe(true)
    }
  })

  it('reports bare non-index aliases as absent (do not invent paths)', () => {
    for (const rel of ABSENT_BARE_ALIASES) {
      expect(routeExists(rel), `${rel} should not exist`).toBe(false)
    }
  })

  it('work list lives under work.index; layout parent carries family demotion', () => {
    expect(routeExists('b.$boardId.work.index.tsx')).toBe(true)
    // List loaders remain for classic boards; CC short-circuit is on layout parent.
    const layout = routeSrc('b.$boardId.work.tsx')
    assertControlCenterAlurDemotion(layout, 'work layout')
  })
})

describe('isControlCenterBoard taxonomy (reuse, no duplicate hardcode in routes)', () => {
  it('pins mfs-rebuild as the sole control-center board id', () => {
    expect(DEFAULT_CONTROL_CENTER_BOARD_ID).toBe('mfs-rebuild')
    expect(isControlCenterBoard('mfs-rebuild')).toBe(true)
    expect(CONTROL_CENTER_BOARD_IDS.has('mfs-rebuild')).toBe(true)
  })

  it('classic boards are not control-center', () => {
    for (const id of ['demo', 'ibils', 'other-board', 'mfs-rebuild-scale']) {
      expect(isControlCenterBoard(id), id).toBe(false)
    }
  })

  it('demoted routes call isControlCenterBoard rather than hardcoding mfs-rebuild string for gate', () => {
    for (const r of DEMOTED_ROUTE_FILES) {
      const src = routeSrc(r.file)
      // Gate condition must use helper; literal mfs-rebuild may still appear in comments.
      expect(src).toMatch(/isControlCenterBoard\(\s*params\.boardId\s*\)/)
      const beforeLoadBlock = src.match(
        /beforeLoad\s*:\s*\(\s*\{\s*params\s*\}\s*\)\s*=>\s*\{[\s\S]*?\n\s*\},/,
      )
      expect(beforeLoadBlock, `${r.file} beforeLoad block`).toBeTruthy()
      expect(beforeLoadBlock![0]).not.toMatch(
        /params\.boardId\s*===\s*['"]mfs-rebuild['"]/,
      )
    }
  })
})

describe('control-center short-circuit contract per route family', () => {
  for (const r of DEMOTED_ROUTE_FILES) {
    it(`${r.family} (${r.file}) demotes CC board to alur with replace`, () => {
      const src = routeSrc(r.file)
      expect(src).toContain(`createFileRoute('${r.createPath}')`)
      assertControlCenterAlurDemotion(src, r.file)
    })
  }

  it('beforeLoad demotion appears before loader so expensive CC fetches cannot run first', () => {
    for (const r of DEMOTED_ROUTE_FILES) {
      const src = routeSrc(r.file)
      const beforeIdx = src.indexOf('beforeLoad:')
      const loaderIdx = src.indexOf('loader:')
      expect(beforeIdx, `${r.file} has beforeLoad`).toBeGreaterThan(-1)
      if (loaderIdx === -1) continue
      expect(beforeIdx, `${r.file}: beforeLoad before loader`).toBeLessThan(loaderIdx)
    }
  })
})

describe('classic-board non-redirect contract', () => {
  it('demotion is conditional — classic boards fall through past beforeLoad', () => {
    for (const r of DEMOTED_ROUTE_FILES) {
      const src = routeSrc(r.file)
      // Must not unconditional-redirect every board to alur.
      expect(src).not.toMatch(
        /beforeLoad\s*:\s*\([^)]*\)\s*=>\s*\{\s*throw\s+redirect\(\s*\{\s*to:\s*['"]\/b\/\$boardId\/alur['"]/,
      )
      expect(src).toMatch(
        /if\s*\(\s*isControlCenterBoard\(\s*params\.boardId\s*\)\s*\)/,
      )
    }
  })

  it('classic dual-surface routes still retain legacy components / branches', () => {
    // projects / features keep Legacy* paths for non-CC boards.
    expect(routeSrc('b.$boardId.projects.index.tsx')).toMatch(/LegacyProjects|function View/)
    expect(routeSrc('b.$boardId.features.index.tsx')).toMatch(/LegacyFeatures/)
    expect(routeSrc('b.$boardId.tasks.index.tsx')).toMatch(/createFileRoute\('\/b\/\$boardId\/tasks\/'\)/)
    expect(routeSrc('b.$boardId.map.tsx')).toMatch(/function MapView/)
    // Old CC screens not deleted (compatibility / history).
    expect(routeSrc('b.$boardId.rebuild.tsx')).toMatch(/RebuildDashboardScreen/)
    expect(routeSrc('b.$boardId.priority.tsx')).toMatch(/PriorityScreen/)
    expect(routeSrc('b.$boardId.fitur.index.tsx')).toMatch(/FeatureDirectoryScreen/)
  })

  it('work.index keeps classic loaders (family demotion is parent layout only for list)', () => {
    const src = routeSrc('b.$boardId.work.index.tsx')
    // Not required to host beforeLoad itself; parent work.tsx does.
    // Must not redirect classic work list away from itself via alur loop.
    expect(src).not.toMatch(/to:\s*['"]\/b\/\$boardId\/alur['"]/)
  })
})

describe('no loop-back from alur + out-of-scope routes untouched', () => {
  it('alur route has no redirect back to demoted legacy IA paths', () => {
    const src = routeSrc('b.$boardId.alur.tsx')
    expect(src).toContain("createFileRoute('/b/$boardId/alur')")
    expect(src).not.toMatch(/throw\s+redirect/)
    for (const path of [
      '/rebuild',
      '/work',
      '/priority',
      '/projects',
      '/fitur',
      '/features',
      '/tasks',
      '/map',
    ]) {
      expect(src, `alur must not redirect to ${path}`).not.toMatch(
        new RegExp(`to:\\s*['"\`].*${path.replace('/', '\\/')}`),
      )
    }
  })

  it('does not demote /ops, /admin/users, /login, /public/**, health, or API routes', () => {
    const untouched = [
      'b.$boardId.ops.tsx',
      'admin.users.tsx',
      'login.tsx',
      'public.features.index.tsx',
      'api.healthz.ts',
    ]
    for (const rel of untouched) {
      expect(routeExists(rel), rel).toBe(true)
      const src = routeSrc(rel)
      expect(src, `${rel} must not demote to alur`).not.toMatch(
        /to:\s*['"]\/b\/\$boardId\/alur['"]/,
      )
    }
  })

  it('board layout auth fence remains (parent of demoted routes)', () => {
    const src = routeSrc('b.$boardId.tsx')
    expect(src).toMatch(/beforeLoad/)
    expect(src).toMatch(/if\s*\(\s*!context\.me\s*\)\s*throw\s+redirect\(\s*\{\s*to:\s*['"]\/login['"]/)
  })

  it('top-level /work aliases stay board-prefixed ART redirects, not alur demotion here', () => {
    // Out of exclusive write scope; contract: still point at board work, not removed.
    const work = routeSrc('work.tsx')
    const workTask = routeSrc('work.$taskId.tsx')
    expect(work).toMatch(/to:\s*['"]\/b\/\$boardId\/work['"]/)
    expect(workTask).toMatch(/to:\s*['"]\/b\/\$boardId\/work\/\$taskId['"]/)
    expect(work).not.toMatch(/to:\s*['"]\/b\/\$boardId\/alur['"]/)
    expect(workTask).not.toMatch(/to:\s*['"]\/b\/\$boardId\/alur['"]/)
  })
})

describe('runtime gate helper semantics for redirect decision', () => {
  it('isControlCenterBoard short-circuits true only for mfs-rebuild', () => {
    const decisions = [
      ['mfs-rebuild', true],
      ['demo', false],
      ['ibils', false],
    ] as const
    for (const [id, want] of decisions) {
      expect(isControlCenterBoard(id)).toBe(want)
    }
  })
})
