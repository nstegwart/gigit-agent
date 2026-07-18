/**
 * TM_CANON_V3_SECONDARY_ROUTES_DEMOTED_LOCAL — secondary legacy IA demotion.
 *
 * Proves control-center board (mfs-rebuild via isControlCenterBoard) secondary
 * human UI routes short-circuit to `/b/$boardId/alur` with replace semantics
 * **before loaders**, by **invoking Route.options.beforeLoad at runtime**
 * (not regex-only). Classic boards keep non-redirect behavior; ops / admin /
 * login / public / MCP / API / health / alur stay out of scope; parent auth
 * fence remains.
 *
 * LOCAL ONLY — no browser/live claim.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { isRedirect } from '@tanstack/react-router'
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

/** On-disk secondary route modules demoted in this packet. */
const DEMOTED_SECONDARY_ROUTES: ReadonlyArray<{
  family: string
  file: string
  createPath: string
  /** Dynamic import path under #/routes (no extension). */
  importId: string
  params?: Record<string, string>
}> = [
  {
    family: 'agents',
    file: 'b.$boardId.agents.tsx',
    createPath: '/b/$boardId/agents',
    importId: '#/routes/b.$boardId.agents',
  },
  {
    family: 'evidence',
    file: 'b.$boardId.evidence.tsx',
    createPath: '/b/$boardId/evidence',
    importId: '#/routes/b.$boardId.evidence',
  },
  {
    family: 'decisions (layout)',
    file: 'b.$boardId.decisions.tsx',
    createPath: '/b/$boardId/decisions',
    importId: '#/routes/b.$boardId.decisions',
  },
  {
    family: 'decisions (index / list)',
    file: 'b.$boardId.decisions.index.tsx',
    createPath: '/b/$boardId/decisions/',
    importId: '#/routes/b.$boardId.decisions.index',
  },
  {
    family: 'decisions/$decisionId (detail)',
    file: 'b.$boardId.decisions.$decisionId.tsx',
    createPath: '/b/$boardId/decisions/$decisionId',
    importId: '#/routes/b.$boardId.decisions.$decisionId',
    params: { decisionId: 'd-1' },
  },
  {
    family: 'design',
    file: 'b.$boardId.design.tsx',
    createPath: '/b/$boardId/design',
    importId: '#/routes/b.$boardId.design',
  },
  {
    family: 'log',
    file: 'b.$boardId.log.tsx',
    createPath: '/b/$boardId/log',
    importId: '#/routes/b.$boardId.log',
  },
  {
    family: 'search',
    file: 'b.$boardId.search.tsx',
    createPath: '/b/$boardId/search',
    importId: '#/routes/b.$boardId.search',
  },
]

/** Bare aliases that do not exist (inventory honesty; not invented). */
const ABSENT_BARE_ALIASES = [
  // decisions list is *.index.tsx; layout parent is b.$boardId.decisions.tsx (present)
  // no extra bare alias beyond inventory
] as const

type BeforeLoadFn = (args: {
  params: Record<string, string>
  context?: { me: null | { id: string } }
}) => unknown

async function loadBeforeLoad(importId: string): Promise<BeforeLoadFn | undefined> {
  const mod = await import(importId)
  const route = mod.Route as { options?: { beforeLoad?: BeforeLoadFn } }
  return route.options?.beforeLoad
}

function invokeBeforeLoad(
  beforeLoad: BeforeLoadFn | undefined,
  boardId: string,
  extraParams: Record<string, string> = {},
) {
  if (!beforeLoad) return { threw: false as const, error: null }
  try {
    beforeLoad({ params: { boardId, ...extraParams } })
    return { threw: false as const, error: null }
  } catch (error) {
    return { threw: true as const, error }
  }
}

function assertAlurRedirect(error: unknown, boardId: string, label: string) {
  expect(isRedirect(error), `${label}: must throw redirect`).toBe(true)
  const opts = (error as { options: Record<string, unknown> }).options
  expect(opts.to, `${label}: to alur`).toBe('/b/$boardId/alur')
  expect(opts.replace, `${label}: replace: true`).toBe(true)
  expect(opts.params, `${label}: params`).toEqual({ boardId })
}

// ---------------------------------------------------------------------------
// Inventory
// ---------------------------------------------------------------------------

describe('inventory: secondary demoted route files exist; absent aliases reported', () => {
  it('every demoted on-disk secondary route module is present', () => {
    for (const r of DEMOTED_SECONDARY_ROUTES) {
      expect(routeExists(r.file), `missing ${r.file}`).toBe(true)
    }
  })

  it('reports decisions family layout + index + detail as present (no invented bare paths)', () => {
    expect(routeExists('b.$boardId.decisions.tsx')).toBe(true)
    expect(routeExists('b.$boardId.decisions.index.tsx')).toBe(true)
    expect(routeExists('b.$boardId.decisions.$decisionId.tsx')).toBe(true)
    // TanStack does not use a separate bare decisions list outside index.
    for (const rel of ABSENT_BARE_ALIASES) {
      expect(routeExists(rel), `${rel} should not exist`).toBe(false)
    }
  })

  it('createFileRoute paths match inventory families', () => {
    for (const r of DEMOTED_SECONDARY_ROUTES) {
      const src = routeSrc(r.file)
      expect(src, r.file).toContain(`createFileRoute('${r.createPath}')`)
    }
  })
})

// ---------------------------------------------------------------------------
// Taxonomy helper (reuse, no hardcode gate)
// ---------------------------------------------------------------------------

describe('isControlCenterBoard taxonomy for secondary demotion', () => {
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

  it('demoted secondary routes call isControlCenterBoard (not boardId === mfs-rebuild hardcode)', () => {
    for (const r of DEMOTED_SECONDARY_ROUTES) {
      const src = routeSrc(r.file)
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

// ---------------------------------------------------------------------------
// Runtime beforeLoad invocation (primary proof — not regex-only)
// ---------------------------------------------------------------------------

describe('runtime beforeLoad: control-center demotes secondary routes to alur', () => {
  for (const r of DEMOTED_SECONDARY_ROUTES) {
    it(`${r.family} (${r.file}) throws alur redirect with replace for mfs-rebuild`, async () => {
      const beforeLoad = await loadBeforeLoad(r.importId)
      expect(beforeLoad, `${r.file} exports beforeLoad`).toBeTypeOf('function')

      const result = invokeBeforeLoad(beforeLoad, 'mfs-rebuild', r.params)
      expect(result.threw, `${r.file} must throw for CC board`).toBe(true)
      assertAlurRedirect(result.error, 'mfs-rebuild', r.file)
    })
  }

  it('beforeLoad appears before loader in each demoted module (loader short-circuit order)', () => {
    for (const r of DEMOTED_SECONDARY_ROUTES) {
      const src = routeSrc(r.file)
      const beforeIdx = src.indexOf('beforeLoad:')
      const loaderIdx = src.indexOf('loader:')
      expect(beforeIdx, `${r.file} has beforeLoad`).toBeGreaterThan(-1)
      if (loaderIdx === -1) continue
      expect(beforeIdx, `${r.file}: beforeLoad before loader`).toBeLessThan(
        loaderIdx,
      )
    }
  })
})

describe('runtime beforeLoad: classic boards do not redirect', () => {
  for (const r of DEMOTED_SECONDARY_ROUTES) {
    it(`${r.family} falls through for demo and ibils`, async () => {
      const beforeLoad = await loadBeforeLoad(r.importId)
      expect(beforeLoad).toBeTypeOf('function')

      for (const boardId of ['demo', 'ibils'] as const) {
        const result = invokeBeforeLoad(beforeLoad, boardId, r.params)
        expect(
          result.threw,
          `${r.file} must not throw for classic board ${boardId}`,
        ).toBe(false)
      }
    })
  }

  it('demotion is conditional in source (not unconditional alur redirect)', () => {
    for (const r of DEMOTED_SECONDARY_ROUTES) {
      const src = routeSrc(r.file)
      expect(src).not.toMatch(
        /beforeLoad\s*:\s*\([^)]*\)\s*=>\s*\{\s*throw\s+redirect\(\s*\{\s*to:\s*['"]\/b\/\$boardId\/alur['"]/,
      )
      expect(src).toMatch(
        /if\s*\(\s*isControlCenterBoard\(\s*params\.boardId\s*\)\s*\)/,
      )
    }
  })

  it('legacy / dual-surface components remain (not deleted)', () => {
    expect(routeSrc('b.$boardId.agents.tsx')).toMatch(
      /AgentsScreen|LegacyAgents/,
    )
    expect(routeSrc('b.$boardId.evidence.tsx')).toMatch(/EvidenceScreen/)
    expect(routeSrc('b.$boardId.decisions.index.tsx')).toMatch(
      /LegacyDecisions|DecidePanel|DecisionsScreen/,
    )
    expect(routeSrc('b.$boardId.decisions.$decisionId.tsx')).toMatch(
      /DecisionDetailScreen/,
    )
    expect(routeSrc('b.$boardId.design.tsx')).toMatch(
      /DesignView|Architecture|DesignLinks/,
    )
    expect(routeSrc('b.$boardId.log.tsx')).toMatch(/Timeline/)
    expect(routeSrc('b.$boardId.search.tsx')).toMatch(/SearchScreen/)
  })
})

// ---------------------------------------------------------------------------
// Out of scope + auth + alur terminal
// ---------------------------------------------------------------------------

describe('out-of-scope routes and parent auth fence (secondary packet)', () => {
  it('does not demote ops, admin/users, login, public, MCP, API/health, or alur', async () => {
    const untouched: Array<{ file: string; importId?: string }> = [
      { file: 'b.$boardId.ops.tsx', importId: '#/routes/b.$boardId.ops' },
      { file: 'admin.users.tsx' },
      { file: 'login.tsx' },
      { file: 'public.features.index.tsx' },
      { file: 'api.healthz.ts' },
      { file: 'mcp.ts' },
      { file: 'b.$boardId.alur.tsx', importId: '#/routes/b.$boardId.alur' },
    ]
    for (const u of untouched) {
      expect(routeExists(u.file), u.file).toBe(true)
      const src = routeSrc(u.file)
      expect(src, `${u.file} must not demote to alur`).not.toMatch(
        /to:\s*['"]\/b\/\$boardId\/alur['"]/,
      )
    }

    // Runtime: ops beforeLoad absent or non-alur for CC board.
    const opsBefore = await loadBeforeLoad('#/routes/b.$boardId.ops')
    if (opsBefore) {
      const result = invokeBeforeLoad(opsBefore, 'mfs-rebuild')
      if (result.threw && isRedirect(result.error)) {
        const to = (result.error as { options: { to?: string } }).options.to
        expect(to).not.toBe('/b/$boardId/alur')
      }
    } else {
      expect(opsBefore).toBeUndefined()
    }

    const alurBefore = await loadBeforeLoad('#/routes/b.$boardId.alur')
    expect(alurBefore, 'alur must not define demotion beforeLoad').toBeUndefined()
  })

  it('runtime: parent board layout still redirects unauthenticated users to /login', async () => {
    const beforeLoad = await loadBeforeLoad('#/routes/b.$boardId')
    expect(beforeLoad).toBeTypeOf('function')
    try {
      beforeLoad!({ params: { boardId: 'mfs-rebuild' }, context: { me: null } })
      expect.fail('parent beforeLoad must throw for !me')
    } catch (error) {
      expect(isRedirect(error)).toBe(true)
      expect((error as { options: { to?: string } }).options.to).toBe('/login')
    }
  })

  it('alur has no redirect back to secondary demoted paths', () => {
    const src = routeSrc('b.$boardId.alur.tsx')
    expect(src).toContain("createFileRoute('/b/$boardId/alur')")
    expect(src).not.toMatch(/throw\s+redirect/)
    for (const path of [
      '/agents',
      '/evidence',
      '/decisions',
      '/design',
      '/log',
      '/search',
    ]) {
      expect(src, `alur must not redirect to ${path}`).not.toMatch(
        new RegExp(`to:\\s*['"\`].*${path.replace('/', '\\/')}`),
      )
    }
  })

  it('top-level /decisions and /search aliases stay board-prefixed (not alur demotion here)', () => {
    const decisions = routeSrc('decisions.tsx')
    const search = routeSrc('search.tsx')
    expect(decisions).toMatch(/to:\s*['"]\/b\/\$boardId\/decisions['"]/)
    expect(search).toMatch(/to:\s*['"]\/b\/\$boardId\/search['"]/)
    expect(decisions).not.toMatch(/to:\s*['"]\/b\/\$boardId\/alur['"]/)
    expect(search).not.toMatch(/to:\s*['"]\/b\/\$boardId\/alur['"]/)
  })
})

describe('runtime gate helper semantics for secondary redirect decision', () => {
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
