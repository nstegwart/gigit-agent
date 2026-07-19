/**
 * TM_CANON_KNOWLEDGE_DOC_REDIRECTS_LOCAL — knowledge + documentation domain demotion.
 *
 * Proves control-center board (mfs-rebuild via isControlCenterBoard) knowledge
 * and documentation domain routes short-circuit to `/b/$boardId/alur` with
 * replace semantics **before loaders**, by **invoking Route.options.beforeLoad
 * at runtime** (not regex-only). Classic boards keep non-redirect behavior;
 * top-level ART aliases keep a finite first hop into board scope then terminate
 * at alur (no loops); ops / admin / login / public / MCP / API / health / alur
 * stay out of scope; parent auth fence remains.
 *
 * Exclusive write scope: board-scoped knowledge + documentation domain modules
 * only. Secondary redirects and core redirect files are not edited here.
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

/** On-disk knowledge/documentation board-scoped modules demoted in this packet. */
const DEMOTED_KNOWLEDGE_DOC_ROUTES: ReadonlyArray<{
  family: string
  file: string
  createPath: string
  /** Dynamic import path under #/routes (no extension). */
  importId: string
  params?: Record<string, string>
  componentMarker: RegExp
}> = [
  {
    family: 'knowledge domains',
    file: 'b.$boardId.knowledge.domains.$domain.tsx',
    createPath: '/b/$boardId/knowledge/domains/$domain',
    importId: '#/routes/b.$boardId.knowledge.domains.$domain',
    params: { domain: 'product' },
    componentMarker: /KnowledgeDomainScreen/,
  },
  {
    family: 'documentation domains',
    file: 'b.$boardId.documentation.domains.$domain.tsx',
    createPath: '/b/$boardId/documentation/domains/$domain',
    importId: '#/routes/b.$boardId.documentation.domains.$domain',
    params: { domain: 'export' },
    componentMarker: /DocumentationDomainScreen/,
  },
]

/** Top-level ART aliases: finite first hop into board scope (not alur). */
const TOP_LEVEL_ALIASES: ReadonlyArray<{
  family: string
  file: string
  createPath: string
  importId: string
  boardTarget: string
  params?: Record<string, string>
}> = [
  {
    family: 'top-level knowledge',
    file: 'knowledge.domains.$domain.tsx',
    createPath: '/knowledge/domains/$domain',
    importId: '#/routes/knowledge.domains.$domain',
    boardTarget: '/b/$boardId/knowledge/domains/$domain',
    params: { domain: 'product' },
  },
  {
    family: 'top-level documentation',
    file: 'documentation.domains.$domain.tsx',
    createPath: '/documentation/domains/$domain',
    importId: '#/routes/documentation.domains.$domain',
    boardTarget: '/b/$boardId/documentation/domains/$domain',
    params: { domain: 'export' },
  },
]

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
  context?: { me: null | { id: string } },
) {
  if (!beforeLoad) return { threw: false as const, error: null }
  try {
    beforeLoad({
      params: { boardId, ...extraParams },
      ...(context !== undefined ? { context } : {}),
    })
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

describe('inventory: knowledge + documentation demoted route files exist', () => {
  it('every demoted on-disk board-scoped module is present', () => {
    for (const r of DEMOTED_KNOWLEDGE_DOC_ROUTES) {
      expect(routeExists(r.file), `missing ${r.file}`).toBe(true)
    }
  })

  it('top-level ART aliases exist (finite first hop into board scope)', () => {
    for (const a of TOP_LEVEL_ALIASES) {
      expect(routeExists(a.file), `missing ${a.file}`).toBe(true)
    }
  })

  it('createFileRoute paths match inventory families', () => {
    for (const r of DEMOTED_KNOWLEDGE_DOC_ROUTES) {
      const src = routeSrc(r.file)
      expect(src, r.file).toContain(`createFileRoute('${r.createPath}')`)
    }
    for (const a of TOP_LEVEL_ALIASES) {
      const src = routeSrc(a.file)
      expect(src, a.file).toContain(`createFileRoute('${a.createPath}')`)
    }
  })

  it('does not invent extra bare knowledge/documentation list modules', () => {
    for (const rel of [
      'b.$boardId.knowledge.tsx',
      'b.$boardId.documentation.tsx',
      'b.$boardId.knowledge.index.tsx',
      'b.$boardId.documentation.index.tsx',
    ]) {
      expect(routeExists(rel), `${rel} should not exist`).toBe(false)
    }
  })
})

// ---------------------------------------------------------------------------
// Taxonomy helper (reuse, no hardcode gate)
// ---------------------------------------------------------------------------

describe('isControlCenterBoard taxonomy for knowledge/doc demotion', () => {
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

  it('demoted routes call isControlCenterBoard (not boardId === mfs-rebuild hardcode)', () => {
    for (const r of DEMOTED_KNOWLEDGE_DOC_ROUTES) {
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

describe('runtime beforeLoad: control-center demotes knowledge/doc to alur', () => {
  for (const r of DEMOTED_KNOWLEDGE_DOC_ROUTES) {
    it(`${r.family} (${r.file}) throws alur redirect with replace for mfs-rebuild`, async () => {
      const beforeLoad = await loadBeforeLoad(r.importId)
      expect(beforeLoad, `${r.file} exports beforeLoad`).toBeTypeOf('function')

      const result = invokeBeforeLoad(beforeLoad, 'mfs-rebuild', r.params)
      expect(result.threw, `${r.file} must throw for CC board`).toBe(true)
      assertAlurRedirect(result.error, 'mfs-rebuild', r.file)
    })
  }

  it('beforeLoad appears before loader in each demoted module (loader short-circuit order)', () => {
    for (const r of DEMOTED_KNOWLEDGE_DOC_ROUTES) {
      const src = routeSrc(r.file)
      const beforeIdx = src.indexOf('beforeLoad:')
      const loaderIdx = src.indexOf('loader:')
      expect(beforeIdx, `${r.file} has beforeLoad`).toBeGreaterThan(-1)
      expect(loaderIdx, `${r.file} has loader`).toBeGreaterThan(-1)
      expect(beforeIdx, `${r.file}: beforeLoad before loader`).toBeLessThan(
        loaderIdx,
      )
    }
  })
})

describe('runtime beforeLoad: classic boards do not redirect', () => {
  for (const r of DEMOTED_KNOWLEDGE_DOC_ROUTES) {
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
    for (const r of DEMOTED_KNOWLEDGE_DOC_ROUTES) {
      const src = routeSrc(r.file)
      expect(src).not.toMatch(
        /beforeLoad\s*:\s*\([^)]*\)\s*=>\s*\{\s*throw\s+redirect\(\s*\{\s*to:\s*['"]\/b\/\$boardId\/alur['"]/,
      )
      expect(src).toMatch(
        /if\s*\(\s*isControlCenterBoard\(\s*params\.boardId\s*\)\s*\)/,
      )
    }
  })

  it('legacy domain components remain (not deleted)', () => {
    for (const r of DEMOTED_KNOWLEDGE_DOC_ROUTES) {
      expect(routeSrc(r.file)).toMatch(r.componentMarker)
    }
  })
})

// ---------------------------------------------------------------------------
// Finite top-level alias chain (no loops)
// ---------------------------------------------------------------------------

describe('finite top-level alias chain: board hop then alur terminal', () => {
  for (const a of TOP_LEVEL_ALIASES) {
    it(`${a.family}: authenticated hop targets board-scoped path (not alur)`, async () => {
      const beforeLoad = await loadBeforeLoad(a.importId)
      expect(beforeLoad, `${a.file} exports beforeLoad`).toBeTypeOf('function')

      try {
        beforeLoad!({
          params: { ...(a.params ?? {}) },
          context: { me: { id: 'u-1' } },
        })
        expect.fail(`${a.file} must throw redirect for authenticated user`)
      } catch (error) {
        expect(isRedirect(error)).toBe(true)
        const opts = (error as { options: Record<string, unknown> }).options
        expect(opts.to, `${a.file}: board hop`).toBe(a.boardTarget)
        expect(opts.to).not.toBe('/b/$boardId/alur')
        expect(opts.params).toMatchObject({
          boardId: DEFAULT_CONTROL_CENTER_BOARD_ID,
          ...(a.params ?? {}),
        })
      }
    })

    it(`${a.family}: unauthenticated first hop still fences to /login`, async () => {
      const beforeLoad = await loadBeforeLoad(a.importId)
      expect(beforeLoad).toBeTypeOf('function')
      try {
        beforeLoad!({
          params: { ...(a.params ?? {}) },
          context: { me: null },
        })
        expect.fail(`${a.file} must throw for !me`)
      } catch (error) {
        expect(isRedirect(error)).toBe(true)
        expect((error as { options: { to?: string } }).options.to).toBe(
          '/login',
        )
      }
    })
  }

  it('board-scoped demotion terminates at alur (second hop) — no redirect back to knowledge/doc', async () => {
    for (const r of DEMOTED_KNOWLEDGE_DOC_ROUTES) {
      const beforeLoad = await loadBeforeLoad(r.importId)
      const result = invokeBeforeLoad(beforeLoad, 'mfs-rebuild', r.params)
      expect(result.threw).toBe(true)
      assertAlurRedirect(result.error, 'mfs-rebuild', r.file)
    }

    const alurSrc = routeSrc('b.$boardId.alur.tsx')
    expect(alurSrc).toContain("createFileRoute('/b/$boardId/alur')")
    expect(alurSrc).not.toMatch(/throw\s+redirect/)
    for (const path of [
      '/knowledge/domains',
      '/documentation/domains',
      'knowledge.domains',
      'documentation.domains',
    ]) {
      expect(alurSrc, `alur must not redirect to ${path}`).not.toContain(path)
    }
  })

  it('top-level aliases do not demote directly to alur (finite 2-hop, not loop)', () => {
    for (const a of TOP_LEVEL_ALIASES) {
      const src = routeSrc(a.file)
      expect(src).toMatch(
        new RegExp(
          `to:\\s*['"]${a.boardTarget.replace(/\$/g, '\\$')}['"]`,
        ),
      )
      expect(src).not.toMatch(/to:\s*['"]\/b\/\$boardId\/alur['"]/)
    }
  })

  it('chain is acyclic: alias → board knowledge/doc → alur; alur is terminal', async () => {
    // Hop 1: top-level → board path
    for (const a of TOP_LEVEL_ALIASES) {
      const aliasBefore = await loadBeforeLoad(a.importId)
      try {
        aliasBefore!({
          params: { ...(a.params ?? {}) },
          context: { me: { id: 'u-1' } },
        })
        expect.fail('alias must redirect')
      } catch (error) {
        const to = (error as { options: { to?: string } }).options.to
        expect(to).toBe(a.boardTarget)
      }
    }

    // Hop 2: board path → alur (CC only)
    for (const r of DEMOTED_KNOWLEDGE_DOC_ROUTES) {
      const boardBefore = await loadBeforeLoad(r.importId)
      const result = invokeBeforeLoad(boardBefore, 'mfs-rebuild', r.params)
      assertAlurRedirect(result.error, 'mfs-rebuild', r.file)
    }

    // Terminal: alur has no demotion beforeLoad
    const alurBefore = await loadBeforeLoad('#/routes/b.$boardId.alur')
    expect(alurBefore, 'alur must not define demotion beforeLoad').toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Out of scope + auth + exclusive write fence
// ---------------------------------------------------------------------------

describe('out-of-scope routes and parent auth fence (knowledge/doc packet)', () => {
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

  it('exclusive write fence: secondary and core demoted modules still present (not re-authored here)', () => {
    // Presence-only check — this packet must not delete prior demotions.
    for (const file of [
      'b.$boardId.agents.tsx',
      'b.$boardId.evidence.tsx',
      'b.$boardId.search.tsx',
      'b.$boardId.rebuild.tsx',
      'b.$boardId.map.tsx',
      'b.$boardId.work.tsx',
    ]) {
      expect(routeExists(file), file).toBe(true)
      expect(routeSrc(file)).toMatch(
        /to:\s*['"]\/b\/\$boardId\/alur['"]/,
      )
    }
  })
})

describe('runtime gate helper semantics for knowledge/doc redirect decision', () => {
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
