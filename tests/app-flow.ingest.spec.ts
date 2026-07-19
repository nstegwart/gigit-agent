/**
 * TM-SALVAGE-APP-FLOW-INGEST — file-only app-flow extraction gates.
 * Uses temp fixtures only (never gitignored data/app-flow production output).
 * No DB. No secrets. No product-repo mutation.
 */
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  APP_FLOW_PROJECT_IDS,
  hasFlowPath,
  isStableEdgeOrder,
  isStableNodeOrder,
  loadAllProjectFlows,
  loadProjectFlow,
  resolveProjectAlias,
  validateProjectFlow,
  type ProjectFlow,
} from '#/lib/app-flow-types'

const ROOT = join(import.meta.dirname, '..')
const SCRIPT = join(ROOT, 'scripts', 'ingest-app-flow.mjs')

const tempDirs: string[] = []

afterEach(() => {
  while (tempDirs.length) {
    const d = tempDirs.pop()
    if (d) {
      try {
        rmSync(d, { recursive: true, force: true })
      } catch {
        /* ignore */
      }
    }
  }
})

function tempDir(prefix = 'app-flow-test-'): string {
  const d = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(d)
  return d
}

function runScript(args: string[], env: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, ...env },
    timeout: 60_000,
    maxBuffer: 10 * 1024 * 1024,
  })
}

function writeMiniFlow(
  dir: string,
  projectId: string,
  extra?: Partial<ProjectFlow>,
): ProjectFlow {
  const flowDir = join(dir, 'data', 'app-flow')
  mkdirSync(flowDir, { recursive: true })
  const nodes = [
    {
      node_id: 'Login',
      feature_id: 'FEAT-AUTH-MEMBER',
      label_id: 'Login',
      kind: 'screen' as const,
      sort_order: 0,
      layout_col: 0,
      layout_row: 0,
      source_ref: 'fixture',
      meta: null,
    },
    {
      node_id: 'Register',
      feature_id: 'FEAT-AUTH-MEMBER',
      label_id: 'Register',
      kind: 'screen' as const,
      sort_order: 1,
      layout_col: 1,
      layout_row: 0,
      source_ref: 'fixture',
      meta: null,
    },
    {
      node_id: 'OnboardingPage',
      feature_id: 'FEAT-AUTH-MEMBER',
      label_id: 'OnboardingPage',
      kind: 'screen' as const,
      sort_order: 2,
      layout_col: 2,
      layout_row: 0,
      source_ref: 'fixture',
      meta: null,
    },
    {
      node_id: 'Home',
      feature_id: 'FEAT-HOME-SHELL',
      label_id: 'Home',
      kind: 'screen' as const,
      sort_order: 3,
      layout_col: 3,
      layout_row: 0,
      source_ref: 'fixture',
      meta: null,
    },
    {
      node_id: 'settings',
      feature_id: null,
      label_id: 'settings',
      kind: 'screen' as const,
      sort_order: 4,
      layout_col: 4,
      layout_row: 0,
      source_ref: 'fixture',
      meta: null,
    },
  ]
  const edges = [
    {
      edge_id: 'Login__Home__auth',
      from_node: 'Login',
      to_node: 'Home',
      edge_kind: 'auth',
      sort_order: 0,
      meta: null,
    },
    {
      edge_id: 'Login__Register__auth',
      from_node: 'Login',
      to_node: 'Register',
      edge_kind: 'auth',
      sort_order: 1,
      meta: null,
    },
    {
      edge_id: 'Register__OnboardingPage__auth',
      from_node: 'Register',
      to_node: 'OnboardingPage',
      edge_kind: 'auth',
      sort_order: 2,
      meta: null,
    },
    {
      edge_id: 'OnboardingPage__Home__auth',
      from_node: 'OnboardingPage',
      to_node: 'Home',
      edge_kind: 'auth',
      sort_order: 3,
      meta: null,
    },
    {
      edge_id: 'Home__settings__hub',
      from_node: 'Home',
      to_node: 'settings',
      edge_kind: 'hub',
      sort_order: 4,
      meta: null,
    },
  ]
  const base: ProjectFlow = {
    project_id: projectId,
    version: 1,
    source: 'fixture',
    generated_at: '2026-07-18T00:00:00.000Z',
    source_hash: 'a'.repeat(64),
    nodes,
    edges,
    stats: {
      nodes: nodes.length,
      edges: edges.length,
      mapped_features: 4,
      unmapped_screens: 1,
      feature_ids: ['FEAT-AUTH-MEMBER', 'FEAT-HOME-SHELL'],
    },
    ...extra,
  }
  writeFileSync(join(flowDir, `${projectId}.json`), JSON.stringify(base, null, 2) + '\n')
  return base
}

describe('scripts/ingest-app-flow.mjs CLI', () => {
  it('--help exits 0 and documents dry-run/self-test', () => {
    expect(existsSync(SCRIPT)).toBe(true)
    const res = runScript(['--help'])
    expect(res.status, res.stderr || res.stdout).toBe(0)
    const out = `${res.stdout}\n${res.stderr}`
    expect(out).toMatch(/--help/)
    expect(out).toMatch(/--dry-run/)
    expect(out).toMatch(/--self-test/)
    expect(out).toMatch(/No DB/)
  })

  it('--self-test builds temp fixtures, Login→Home, stable hashes', () => {
    const res = runScript(['--self-test'])
    expect(res.status, res.stderr || res.stdout).toBe(0)
    const start = res.stdout.indexOf('{')
    const end = res.stdout.lastIndexOf('}')
    expect(start).toBeGreaterThanOrEqual(0)
    const summary = JSON.parse(res.stdout.slice(start, end + 1)) as {
      ok: boolean
      selfTest: boolean
      login_to_home: boolean
      idempotent: boolean
      projects: Array<{ project_id: string; nodes: number; source_hash: string }>
    }
    expect(summary.ok).toBe(true)
    expect(summary.selfTest).toBe(true)
    expect(summary.login_to_home).toBe(true)
    expect(summary.idempotent).toBe(true)
    expect(summary.projects.map((p) => p.project_id).sort()).toEqual(
      [...APP_FLOW_PROJECT_IDS].sort(),
    )
    for (const p of summary.projects) {
      expect(p.nodes).toBeGreaterThanOrEqual(5)
      expect(p.source_hash).toMatch(/^[a-f0-9]{64}$/)
    }
  })

  it('--dry-run against temp fixtures does not write JSON and is deterministic', async () => {
    const mod = await import(SCRIPT)
    const base = tempDir()
    const fx = mod.writeSelfTestFixtures(base) as {
      wsRoot: string
      seedPath: string
      outDir: string
      f1Fallback: string
    }
    const pin = '2026-07-18T12:00:00.000Z'
    const a = mod.runIngest({
      dryRun: true,
      outDir: fx.outDir,
      wsRoot: fx.wsRoot,
      seedPath: fx.seedPath,
      f1Fallback: fx.f1Fallback,
      projects: ['rn', 'web', 'sales', 'affiliate', 'backend'],
      generatedAt: pin,
    }) as {
      ok: boolean
      dryRun: boolean
      flows: Record<string, ProjectFlow>
    }
    const b = mod.runIngest({
      dryRun: true,
      outDir: fx.outDir,
      wsRoot: fx.wsRoot,
      seedPath: fx.seedPath,
      f1Fallback: fx.f1Fallback,
      projects: ['rn', 'web', 'sales', 'affiliate', 'backend'],
      generatedAt: pin,
    }) as {
      flows: Record<string, ProjectFlow>
    }
    expect(a.ok).toBe(true)
    expect(a.dryRun).toBe(true)
    // no files written under outDir in dry-run
    expect(existsSync(join(fx.outDir, 'rn.json'))).toBe(false)
    for (const id of APP_FLOW_PROJECT_IDS) {
      expect(a.flows[id].source_hash).toBe(b.flows[id].source_hash)
      expect(a.flows[id].generated_at).toBe(pin)
      expect(mod.validateFlow(a.flows[id]).ok).toBe(true)
    }
    expect(mod.hasFlowPath(a.flows.rn, 'Login', 'Home')).toBe(true)
  })
})

describe('ingest pure helpers (module import)', () => {
  it('resolves project aliases', async () => {
    const mod = await import(SCRIPT)
    expect(mod.resolveProjectAlias('react-native')).toBe('rn')
    expect(mod.resolveProjectAlias('mfs-web')).toBe('web')
    expect(mod.resolveProjectAlias('admin')).toBe('sales')
    expect(mod.resolveProjectAlias('api')).toBe('backend')
    expect(mod.resolveProjectAlias('nope')).toBeNull()
  })

  it('collapses duplicate edges and keeps unique edge_ids', async () => {
    const mod = await import(SCRIPT)
    const flow = mod.buildFlow(
      'web',
      'unit',
      [
        { node_id: 'A', label_id: 'A' },
        { node_id: 'B', label_id: 'B' },
        { node_id: 'C', label_id: 'C' },
        { node_id: 'D', label_id: 'D' },
        { node_id: 'E', label_id: 'E' },
      ],
      [
        { from_node: 'A', to_node: 'B', edge_kind: 'nav' },
        { from_node: 'A', to_node: 'B', edge_kind: 'nav' },
        { from_node: 'B', to_node: 'C', edge_kind: 'nav' },
        { from_node: 'C', to_node: 'D', edge_kind: 'nav' },
        { from_node: 'D', to_node: 'E', edge_kind: 'nav' },
      ],
      [],
      { generatedAt: '2026-07-18T00:00:00.000Z' },
    ) as ProjectFlow
    expect(flow.edges.filter((e) => e.from_node === 'A' && e.to_node === 'B')).toHaveLength(
      1,
    )
    const ids = flow.edges.map((e) => e.edge_id)
    expect(new Set(ids).size).toBe(ids.length)
    const v = mod.validateFlow(flow)
    expect(v.ok, JSON.stringify(v.issues)).toBe(true)
  })

  it('source_hash is sha256 and stable for identical payload', async () => {
    const mod = await import(SCRIPT)
    const pin = '2026-07-18T00:00:00.000Z'
    const specs = {
      nodes: [
        { node_id: 'Login', label_id: 'Login', feature_id: 'FEAT-AUTH-MEMBER' },
        { node_id: 'Home', label_id: 'Home', feature_id: 'FEAT-HOME-SHELL' },
        { node_id: 'A', label_id: 'A' },
        { node_id: 'B', label_id: 'B' },
        { node_id: 'C', label_id: 'C' },
      ],
      edges: [
        { from_node: 'Login', to_node: 'Home', edge_kind: 'auth' },
        { from_node: 'Home', to_node: 'A', edge_kind: 'hub' },
        { from_node: 'A', to_node: 'B', edge_kind: 'nav' },
        { from_node: 'B', to_node: 'C', edge_kind: 'nav' },
      ],
    }
    const a = mod.buildFlow('rn', 'unit', specs.nodes, specs.edges, [], {
      generatedAt: pin,
    }) as ProjectFlow
    const b = mod.buildFlow('rn', 'unit', specs.nodes, specs.edges, [], {
      generatedAt: '2099-01-01T00:00:00.000Z',
    }) as ProjectFlow
    expect(a.source_hash).toMatch(/^[a-f0-9]{64}$/)
    // generated_at excluded from hash
    expect(a.source_hash).toBe(b.source_hash)
    expect(a.source_hash).toBe(mod.computeSourceHash(a))
    const manual = createHash('sha256')
      .update(mod.stableStringify({
        project_id: a.project_id,
        version: a.version,
        source: a.source,
        nodes: a.nodes.map((n: ProjectFlow['nodes'][number]) => ({
          node_id: n.node_id,
          feature_id: n.feature_id ?? null,
          label_id: n.label_id,
          kind: n.kind,
          sort_order: n.sort_order,
          layout_col: n.layout_col,
          layout_row: n.layout_row,
          source_ref: n.source_ref ?? null,
          meta: n.meta ?? null,
        })),
        edges: a.edges.map((e: ProjectFlow['edges'][number]) => ({
          edge_id: e.edge_id,
          from_node: e.from_node,
          to_node: e.to_node,
          edge_kind: e.edge_kind,
          sort_order: e.sort_order ?? 0,
          meta: e.meta ?? null,
        })),
        stats: a.stats ?? null,
      }), 'utf8')
      .digest('hex')
    expect(a.source_hash).toBe(manual)
  })

  it('stable node/edge ordering across rebuilds', async () => {
    const mod = await import(SCRIPT)
    const pin = '2026-07-18T00:00:00.000Z'
    // reverse-ish insertion order
    const nodes = [
      { node_id: 'Zulu', label_id: 'Zulu' },
      { node_id: 'Alpha', label_id: 'Alpha' },
      { node_id: 'Mike', label_id: 'Mike' },
      { node_id: 'Bravo', label_id: 'Bravo' },
      { node_id: 'Charlie', label_id: 'Charlie' },
    ]
    const edges = [
      { from_node: 'Mike', to_node: 'Zulu', edge_kind: 'nav' },
      { from_node: 'Alpha', to_node: 'Bravo', edge_kind: 'nav' },
      { from_node: 'Bravo', to_node: 'Charlie', edge_kind: 'nav' },
      { from_node: 'Charlie', to_node: 'Mike', edge_kind: 'nav' },
    ]
    const a = mod.buildFlow('backend', 'order', nodes, edges, [], {
      generatedAt: pin,
    }) as ProjectFlow
    const b = mod.buildFlow(
      'backend',
      'order',
      [...nodes].reverse(),
      [...edges].reverse(),
      [],
      { generatedAt: pin },
    ) as ProjectFlow
    expect(a.nodes.map((n) => n.node_id)).toEqual(b.nodes.map((n) => n.node_id))
    expect(a.edges.map((e) => e.edge_id)).toEqual(b.edges.map((e) => e.edge_id))
    expect(isStableNodeOrder(a)).toBe(true)
    expect(isStableEdgeOrder(a)).toBe(true)
  })

  it('rejects invalid feature soft refs and duplicate nodes in validateFlow', async () => {
    const mod = await import(SCRIPT)
    const bad = {
      project_id: 'rn',
      version: 1,
      source: 'x',
      generated_at: '2026-07-18T00:00:00.000Z',
      source_hash: '0'.repeat(64),
      nodes: [
        {
          node_id: 'A',
          feature_id: 'NOT-A-FEAT',
          label_id: 'A',
          kind: 'screen',
          sort_order: 0,
          layout_col: 0,
          layout_row: 0,
        },
        {
          node_id: 'A',
          feature_id: null,
          label_id: 'A2',
          kind: 'screen',
          sort_order: 1,
          layout_col: 0,
          layout_row: 1,
        },
        {
          node_id: 'B',
          feature_id: null,
          label_id: 'B',
          kind: 'screen',
          sort_order: 2,
          layout_col: 1,
          layout_row: 0,
        },
        {
          node_id: 'C',
          feature_id: null,
          label_id: 'C',
          kind: 'screen',
          sort_order: 3,
          layout_col: 1,
          layout_row: 1,
        },
        {
          node_id: 'D',
          feature_id: null,
          label_id: 'D',
          kind: 'screen',
          sort_order: 4,
          layout_col: 1,
          layout_row: 2,
        },
      ],
      edges: [
        {
          edge_id: 'A__B__nav',
          from_node: 'A',
          to_node: 'B',
          edge_kind: 'nav',
          sort_order: 0,
        },
      ],
      stats: {
        nodes: 5,
        edges: 1,
        mapped_features: 0,
        unmapped_screens: 5,
        feature_ids: [],
      },
    }
    const v = mod.validateFlow(bad, { minNodes: 5 })
    expect(v.ok).toBe(false)
    const codes = v.issues.map((i: { code: string }) => i.code)
    expect(codes).toContain('feature_soft_ref')
    expect(codes).toContain('duplicate_node')
  })

  it('SCREEN_FEATURE_ALIASES maps Login/Home soft refs', async () => {
    const mod = await import(SCRIPT)
    expect(mod.SCREEN_FEATURE_ALIASES.Login).toBe('FEAT-AUTH-MEMBER')
    expect(mod.SCREEN_FEATURE_ALIASES.Home).toBe('FEAT-HOME-SHELL')
    expect(mod.resolveFeatureId('Login', [], 'rn')).toBe('FEAT-AUTH-MEMBER')
  })
})

describe('src/lib/app-flow-types loader + validation (temp fixtures)', () => {
  it('project aliases match canonical portfolio ids', () => {
    expect(resolveProjectAlias('rn')).toBe('rn')
    expect(resolveProjectAlias('react-native')).toBe('rn')
    expect(resolveProjectAlias('mfs-web-original-upgrade')).toBe('web')
    expect(resolveProjectAlias('sales-rebuild')).toBe('sales')
    expect(resolveProjectAlias('affiliate-rebuild')).toBe('affiliate')
    expect(resolveProjectAlias('rebuild-backend')).toBe('backend')
    expect(APP_FLOW_PROJECT_IDS).toEqual([
      'rn',
      'web',
      'sales',
      'affiliate',
      'backend',
    ])
  })

  it('loads from temp data/app-flow without DB', () => {
    const root = tempDir()
    for (const id of APP_FLOW_PROJECT_IDS) {
      writeMiniFlow(root, id)
    }
    const all = loadAllProjectFlows(root)
    expect(all.projects).toEqual([...APP_FLOW_PROJECT_IDS].sort())
    for (const id of APP_FLOW_PROJECT_IDS) {
      const flow = loadProjectFlow(id, root)
      expect(flow).not.toBeNull()
      expect(flow!.nodes.length).toBeGreaterThanOrEqual(5)
      const v = validateProjectFlow(flow!, { requireSourceHash: true })
      expect(v.ok, JSON.stringify(v.issues)).toBe(true)
    }
  })

  it('validates Login→Home representative path on fixture RN graph', () => {
    const root = tempDir()
    const rn = writeMiniFlow(root, 'rn')
    expect(hasFlowPath(rn, 'Login', 'Home')).toBe(true)
    // multi-hop also works
    expect(hasFlowPath(rn, 'Login', 'settings')).toBe(true)
    expect(hasFlowPath(rn, 'settings', 'Login')).toBe(false)
  })

  it('flags bad edge endpoints and duplicate edges', () => {
    const flow: ProjectFlow = {
      project_id: 'web',
      version: 1,
      source: 'x',
      source_hash: 'b'.repeat(64),
      nodes: [
        {
          node_id: 'A',
          feature_id: null,
          label_id: 'A',
          kind: 'screen',
          sort_order: 0,
          layout_col: 0,
          layout_row: 0,
        },
        {
          node_id: 'B',
          feature_id: null,
          label_id: 'B',
          kind: 'screen',
          sort_order: 1,
          layout_col: 1,
          layout_row: 0,
        },
        {
          node_id: 'C',
          feature_id: null,
          label_id: 'C',
          kind: 'screen',
          sort_order: 2,
          layout_col: 2,
          layout_row: 0,
        },
        {
          node_id: 'D',
          feature_id: null,
          label_id: 'D',
          kind: 'screen',
          sort_order: 3,
          layout_col: 3,
          layout_row: 0,
        },
        {
          node_id: 'E',
          feature_id: null,
          label_id: 'E',
          kind: 'screen',
          sort_order: 4,
          layout_col: 4,
          layout_row: 0,
        },
      ],
      edges: [
        {
          edge_id: 'A__B__nav',
          from_node: 'A',
          to_node: 'B',
          edge_kind: 'nav',
          sort_order: 0,
        },
        {
          edge_id: 'A__B__nav2',
          from_node: 'A',
          to_node: 'B',
          edge_kind: 'nav',
          sort_order: 1,
        },
        {
          edge_id: 'A__MISSING__nav',
          from_node: 'A',
          to_node: 'MISSING',
          edge_kind: 'nav',
          sort_order: 2,
        },
      ],
    }
    const v = validateProjectFlow(flow)
    expect(v.ok).toBe(false)
    const codes = v.issues.map((i) => i.code)
    expect(codes).toContain('duplicate_edge')
    expect(codes).toContain('edge_to')
  })

  it('rejects path traversal project ids in loader', () => {
    const root = tempDir()
    writeMiniFlow(root, 'rn')
    expect(loadProjectFlow('../rn', root)).toBeNull()
    expect(loadProjectFlow('rn;drop', root)).toBeNull()
  })
})

describe('no DB / no secrets contract (static)', () => {
  it('script source has no INSERT/mysql2/credentials', () => {
    const src = readFileSync(SCRIPT, 'utf8')
    expect(src).not.toMatch(/\bINSERT\s+INTO\b/i)
    expect(src).not.toMatch(/mysql2|createPool|CAIRN_DB_|BEGIN RSA/i)
    expect(src).toMatch(/Does NOT touch DB|No DB writes/)
  })
})
