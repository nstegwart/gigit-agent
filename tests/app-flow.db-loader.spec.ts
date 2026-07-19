/**
 * TM-AUTHOR-APP-FLOW-MYSQL-LOADER-R2 — offline SQL bundle gates + hardening.
 * Temp fixtures only (never mutates gitignored data/app-flow).
 * No live DB. No secrets. No product-repo mutation.
 * R2: generatedAt canonical ISO, statement allowlist, migration-011 widths + INT.
 */
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const ROOT = join(import.meta.dirname, '..')
const SCRIPT = join(ROOT, 'scripts', 'load-app-flow-db.mjs')
const INGEST = join(ROOT, 'scripts', 'ingest-app-flow.mjs')
const SALVAGE_SPEC = join(ROOT, 'tests', 'app-flow.ingest.spec.ts')
const MIGRATION_011 = join(ROOT, 'migrations', '011_feature_flow_edges.sql')

const CANONICAL = ['rn', 'web', 'sales', 'affiliate', 'backend'] as const
const FIXED_AT = '2026-07-19T12:00:00.000Z'

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

function tempDir(prefix = 'app-flow-db-'): string {
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

function sha256File(p: string): string {
  return createHash('sha256').update(readFileSync(p)).digest('hex')
}

type FlowNode = {
  node_id: string
  feature_id: string | null
  label_id: string
  kind: 'screen' | 'feature'
  sort_order: number
  layout_col: number
  layout_row: number
  source_ref?: string | null
  meta?: Record<string, unknown> | null
}

type FlowEdge = {
  edge_id: string
  from_node: string
  to_node: string
  edge_kind: string
  sort_order?: number
  meta?: Record<string, unknown> | null
}

type ProjectFlow = {
  project_id: string
  version: number
  source: string
  generated_at?: string
  source_hash?: string
  nodes: FlowNode[]
  edges: FlowEdge[]
  stats?: {
    nodes: number
    edges: number
    mapped_features: number
    unmapped_screens: number
    feature_ids: string[]
  }
}

async function computeHash(flow: ProjectFlow): Promise<string> {
  const mod = await import(INGEST)
  return mod.computeSourceHash(flow) as string
}

function baseNodes(labelSuffix = ''): FlowNode[] {
  return [
    {
      node_id: 'Login',
      feature_id: 'FEAT-AUTH-MEMBER',
      label_id: `Login${labelSuffix}`,
      kind: 'screen',
      sort_order: 0,
      layout_col: 0,
      layout_row: 0,
      source_ref: 'fixture',
      meta: null,
    },
    {
      node_id: 'Home',
      feature_id: 'FEAT-HOME-SHELL',
      label_id: `Home${labelSuffix}`,
      kind: 'screen',
      sort_order: 1,
      layout_col: 1,
      layout_row: 0,
      source_ref: 'fixture',
      meta: null,
    },
    {
      node_id: 'Settings',
      feature_id: null,
      label_id: `Settings${labelSuffix}`,
      kind: 'screen',
      sort_order: 2,
      layout_col: 2,
      layout_row: 0,
      source_ref: 'fixture',
      meta: null,
    },
    {
      node_id: 'Profile',
      feature_id: null,
      label_id: `Profile${labelSuffix}`,
      kind: 'screen',
      sort_order: 3,
      layout_col: 3,
      layout_row: 0,
      source_ref: 'fixture',
      meta: null,
    },
    {
      node_id: 'Help',
      feature_id: null,
      label_id: `Help${labelSuffix}`,
      kind: 'screen',
      sort_order: 4,
      layout_col: 4,
      layout_row: 0,
      source_ref: 'fixture',
      meta: null,
    },
  ]
}

function baseEdges(): FlowEdge[] {
  return [
    {
      edge_id: 'Login__Home__auth',
      from_node: 'Login',
      to_node: 'Home',
      edge_kind: 'auth',
      sort_order: 0,
      meta: null,
    },
    {
      edge_id: 'Home__Settings__hub',
      from_node: 'Home',
      to_node: 'Settings',
      edge_kind: 'hub',
      sort_order: 1,
      meta: null,
    },
    {
      edge_id: 'Home__Profile__nav',
      from_node: 'Home',
      to_node: 'Profile',
      edge_kind: 'nav',
      sort_order: 2,
      meta: null,
    },
    {
      edge_id: 'Home__Help__nav',
      from_node: 'Home',
      to_node: 'Help',
      edge_kind: 'nav',
      sort_order: 3,
      meta: null,
    },
  ]
}

async function makeFlow(
  projectId: string,
  extra?: Partial<ProjectFlow> & {
    nodes?: FlowNode[]
    edges?: FlowEdge[]
  },
): Promise<ProjectFlow> {
  const nodes = extra?.nodes ?? baseNodes(`-${projectId}`)
  const edges = extra?.edges ?? baseEdges()
  const stats =
    extra?.stats ??
    ({
      nodes: nodes.length,
      edges: edges.length,
      mapped_features: nodes.filter((n) => n.feature_id).length,
      unmapped_screens: nodes.filter((n) => !n.feature_id).length,
      feature_ids: [
        ...new Set(nodes.map((n) => n.feature_id).filter(Boolean) as string[]),
      ],
    } as ProjectFlow['stats'])
  const flow: ProjectFlow = {
    project_id: extra?.project_id ?? projectId,
    version: extra?.version ?? 1,
    source: extra?.source ?? 'fixture',
    generated_at: extra?.generated_at ?? '2026-07-19T00:00:00.000Z',
    nodes,
    edges,
    stats,
  }
  if (extra && 'source_hash' in extra && extra.source_hash === undefined) {
    // explicit undefined key is unusual; treat as hashless
    delete flow.source_hash
  } else if (extra?.source_hash === undefined) {
    flow.source_hash = await computeHash(flow)
  } else if (extra.source_hash === (null as unknown as string)) {
    delete flow.source_hash
  } else {
    flow.source_hash = extra.source_hash
  }
  return flow
}

/**
 * Write all five canonical project JSON files.
 * Mutator receives a fully hashed flow; it must leave source_hash correct
 * (or intentionally wrong/missing for rejection tests).
 */
async function writeFiveProjectDir(
  mutate?: (projectId: string, flow: ProjectFlow) => void | ProjectFlow,
): Promise<{ dir: string; flows: Record<string, ProjectFlow> }> {
  const dir = tempDir()
  const flows: Record<string, ProjectFlow> = {}
  for (const id of CANONICAL) {
    let flow = await makeFlow(id)
    if (mutate) {
      const m = mutate(id, flow)
      if (m) flow = m
    }
    flows[id] = flow
    writeFileSync(join(dir, `${id}.json`), JSON.stringify(flow, null, 2) + '\n')
  }
  return { dir, flows }
}

function parseJsonSummary(stdout: string): Record<string, unknown> {
  const start = stdout.indexOf('{')
  const end = stdout.lastIndexOf('}')
  expect(start).toBeGreaterThanOrEqual(0)
  return JSON.parse(stdout.slice(start, end + 1)) as Record<string, unknown>
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

describe('scripts/load-app-flow-db.mjs CLI', () => {
  it('--help exits 0 and documents offline bundle mode', () => {
    expect(existsSync(SCRIPT)).toBe(true)
    const res = runScript(['--help'])
    expect(res.status, res.stderr || res.stdout).toBe(0)
    const out = `${res.stdout}\n${res.stderr}`
    expect(out).toMatch(/--bundle/)
    expect(out).toMatch(/--out/)
    expect(out).toMatch(/--dir/)
    expect(out).toMatch(/No DB connection/)
    expect(out).toMatch(/rn web sales affiliate backend/)
  })

  it('default mode validates five-project fixture and writes nothing', async () => {
    const { dir } = await writeFiveProjectDir()
    const before = readdirSync(dir).sort()
    const res = runScript(['--dir', dir])
    expect(res.status, res.stderr || res.stdout).toBe(0)
    const summary = parseJsonSummary(res.stdout) as {
      ok: boolean
      mode: string
      wrote?: boolean
      totals: { nodes: number; edges: number }
      projects: Array<{ project_id: string; nodes: number; edges: number; source_hash: string }>
    }
    expect(summary.ok).toBe(true)
    expect(summary.mode).toBe('validate')
    expect(summary.wrote).toBe(false)
    expect(summary.projects.map((p) => p.project_id)).toEqual([...CANONICAL])
    expect(summary.totals.nodes).toBe(5 * 5)
    expect(summary.totals.edges).toBe(5 * 4)
    for (const p of summary.projects) {
      expect(p.nodes).toBe(5)
      expect(p.edges).toBe(4)
      expect(p.source_hash).toMatch(/^[a-f0-9]{64}$/)
    }
    expect(readdirSync(dir).sort()).toEqual(before)
    expect(existsSync(join(dir, 'upload-app-flow.sql'))).toBe(false)
  })

  it('--bundle without --out fails closed', async () => {
    const { dir } = await writeFiveProjectDir()
    const res = runScript(['--bundle', '--dir', dir])
    expect(res.status).not.toBe(0)
    expect(`${res.stdout}\n${res.stderr}`).toMatch(/--bundle requires --out/)
  })

  it('--db is refused in R1', async () => {
    const { dir } = await writeFiveProjectDir()
    const res = runScript(['--db', '--dir', dir])
    expect(res.status).not.toBe(0)
    expect(`${res.stdout}\n${res.stderr}`).toMatch(/REFUSED|--db is not available/)
  })

  it('--bundle --out writes SQL only after all five pass (atomic)', async () => {
    const { dir } = await writeFiveProjectDir()
    const out = join(dir, 'upload-app-flow.sql')
    const res = runScript([
      '--bundle',
      '--out',
      out,
      '--dir',
      dir,
      '--generated-at',
      FIXED_AT,
      '--batch-size',
      '10',
    ])
    expect(res.status, res.stderr || res.stdout).toBe(0)
    expect(existsSync(out)).toBe(true)
    // no leftover temp files
    const leftovers = readdirSync(dir).filter((f) => f.endsWith('.tmp'))
    expect(leftovers).toEqual([])
    const summary = parseJsonSummary(res.stdout) as {
      ok: boolean
      mode: string
      wrote: boolean
      bytes: number
    }
    expect(summary.ok).toBe(true)
    expect(summary.mode).toBe('bundle')
    expect(summary.wrote).toBe(true)
    expect(summary.bytes).toBeGreaterThan(100)
  })
})

// ─── Happy path SQL contract ─────────────────────────────────────────────────

describe('bundle SQL contract (happy five-project fixture)', () => {
  it('emits deterministic transaction with 011 columns, UPSERT, nodes before edges', async () => {
    const mod = await import(SCRIPT)
    const { dir, flows } = await writeFiveProjectDir()
    const validated = mod.loadAndValidateAll(dir) as {
      ok: boolean
      projects: Array<{ project_id: string; nodes: number; edges: number; source_hash: string }>
      totals: { nodes: number; edges: number }
    }
    expect(validated.ok).toBe(true)
    expect(validated.totals).toEqual({ nodes: 25, edges: 20 })

    const sqlA = mod.generateBundleSql(validated, {
      generatedAt: FIXED_AT,
      batchSize: 50,
    }) as string
    const sqlB = mod.generateBundleSql(validated, {
      generatedAt: FIXED_AT,
      batchSize: 50,
    }) as string
    expect(sqlA).toBe(sqlB)
    expect(createHash('sha256').update(sqlA).digest('hex')).toBe(
      createHash('sha256').update(sqlB).digest('hex'),
    )

    mod.assertBundleSafety(sqlA)

    // transaction shape
    expect(sqlA).toMatch(/START TRANSACTION;/)
    expect(sqlA).toMatch(/COMMIT;/)
    const startIdx = sqlA.indexOf('START TRANSACTION')
    const commitIdx = sqlA.lastIndexOf('COMMIT')
    const nodeIdx = sqlA.indexOf('INSERT INTO app_flow_nodes')
    const edgeIdx = sqlA.indexOf('INSERT INTO app_flow_edges')
    expect(startIdx).toBeGreaterThanOrEqual(0)
    expect(nodeIdx).toBeGreaterThan(startIdx)
    expect(edgeIdx).toBeGreaterThan(nodeIdx)
    expect(commitIdx).toBeGreaterThan(edgeIdx)

    // exact 011 columns
    expect(sqlA).toMatch(
      /INSERT INTO app_flow_nodes \(project_id, node_id, feature_id, label_id, kind, sort_order, layout_col, layout_row, source_ref, meta_json\)/,
    )
    expect(sqlA).toMatch(
      /INSERT INTO app_flow_edges \(project_id, edge_id, from_node, to_node, edge_kind, sort_order, meta_json\)/,
    )
    expect(sqlA).toMatch(/ON DUPLICATE KEY UPDATE/)
    expect(sqlA).toMatch(/SET NAMES utf8mb4/)

    // header: hashes + counts + generated time
    expect(sqlA).toContain(`-- generated_at: ${FIXED_AT}`)
    expect(sqlA).toMatch(/totals: nodes=25 edges=20/)
    for (const id of CANONICAL) {
      expect(sqlA).toContain(`source_hash=${flows[id].source_hash}`)
      expect(sqlA).toContain(`${id}: nodes=`)
    }

    // no 012 / CP / forbidden tables
    expect(sqlA).not.toMatch(/\bapp_pages\b/)
    expect(sqlA).not.toMatch(/\bnav_edges\b/)
    expect(sqlA).not.toMatch(/\bapi_endpoints\b/)
    expect(sqlA).not.toMatch(/\bpage_api_calls\b/)
    expect(sqlA).not.toMatch(/\bknowledge_aliases\b/)
    expect(sqlA).not.toMatch(/\bcp0_/i)
    expect(sqlA).not.toMatch(/\bcontrol_plane\b/i)
    expect(sqlA).not.toMatch(/\bschema_migrations\b/)

    // no prune DML outside INSERT UPSERT
    const body = sqlA
      .split('\n')
      .filter((l) => !l.trimStart().startsWith('--'))
      .join('\n')
    expect(body).not.toMatch(/\bDELETE\b/i)
    expect(body).not.toMatch(/\bTRUNCATE\b/i)
    expect(body).not.toMatch(/\bDROP\b/i)
    expect(body).not.toMatch(/\bREPLACE\s+INTO\b/i)

    // source_hash stored in meta_json path (hex payload contains utf8 of source_hash key)
    const hashKeyHex = Buffer.from('source_hash', 'utf8').toString('hex')
    expect(sqlA.toLowerCase()).toContain(hashKeyHex)

    // migration-011 schema alignment
    expect(existsSync(MIGRATION_011)).toBe(true)
    const mig = readFileSync(MIGRATION_011, 'utf8')
    expect(mig).toMatch(/CREATE TABLE IF NOT EXISTS app_flow_nodes/)
    expect(mig).toMatch(/CREATE TABLE IF NOT EXISTS app_flow_edges/)
    for (const col of [
      'project_id',
      'node_id',
      'feature_id',
      'label_id',
      'kind',
      'sort_order',
      'layout_col',
      'layout_row',
      'source_ref',
      'meta_json',
    ]) {
      expect(mig).toContain(col)
    }
    for (const col of [
      'project_id',
      'edge_id',
      'from_node',
      'to_node',
      'edge_kind',
      'sort_order',
      'meta_json',
    ]) {
      expect(mig).toContain(col)
    }
  })

  it('chunks multi-row INSERT by batch-size', async () => {
    const mod = await import(SCRIPT)
    const { dir } = await writeFiveProjectDir()
    const validated = mod.loadAndValidateAll(dir)
    expect(validated.ok).toBe(true)
    const sql = mod.generateBundleSql(validated, {
      generatedAt: FIXED_AT,
      batchSize: 3,
    }) as string
    // Chunking is per-project: 5 nodes/project → ceil(5/3)=2 inserts × 5 projects = 10
    // edges: 4/project → ceil(4/3)=2 × 5 = 10
    const nodeInserts = (sql.match(/INSERT INTO app_flow_nodes/g) || []).length
    const edgeInserts = (sql.match(/INSERT INTO app_flow_edges/g) || []).length
    expect(nodeInserts).toBe(5 * Math.ceil(5 / 3))
    expect(edgeInserts).toBe(5 * Math.ceil(4 / 3))
  })

  it('writeAtomic is temp→rename and re-run is byte-identical', async () => {
    const mod = await import(SCRIPT)
    const { dir } = await writeFiveProjectDir()
    const validated = mod.loadAndValidateAll(dir)
    const sql = mod.generateBundleSql(validated, {
      generatedAt: FIXED_AT,
      batchSize: 50,
    }) as string
    const out = join(dir, 'bundle.sql')
    mod.writeAtomic(out, sql)
    const h1 = sha256File(out)
    mod.writeAtomic(out, sql)
    const h2 = sha256File(out)
    expect(h1).toBe(h2)
    expect(readFileSync(out, 'utf8')).toBe(sql)
  })

  it('project/node/edge order is stable (canonical project order)', async () => {
    const mod = await import(SCRIPT)
    const { dir } = await writeFiveProjectDir()
    const validated = mod.loadAndValidateAll(dir)
    const sql = mod.generateBundleSql(validated, {
      generatedAt: FIXED_AT,
      batchSize: 100,
    }) as string
    // project order in header and inserts: rn → web → sales → affiliate → backend
    const projPos = CANONICAL.map((id) => {
      const needle = mod.sqlStr(id) as string
      return sql.indexOf(needle)
    })
    for (let i = 1; i < projPos.length; i++) {
      expect(projPos[i]).toBeGreaterThan(projPos[i - 1])
    }
  })
})

// ─── SQL encoding / injection safety ─────────────────────────────────────────

describe('SQL encoding injection safety', () => {
  it('sqlStr / sqlJson use utf8 hex (quotes, backslash, newline, UTF-8)', async () => {
    const mod = await import(SCRIPT)
    const samples = [
      `it's a "quote"`,
      `path\\to\\file`,
      "line1\nline2\r\n",
      '中文emoji😀',
      `'); DROP TABLE users; --`,
      `a\u0000b`,
    ]
    for (const s of samples) {
      const lit = mod.sqlStr(s) as string
      expect(lit).toMatch(/^CONVERT\(X'[0-9a-f]*' USING utf8mb4\)$/)
      // never raw quote-wrapped user content
      expect(lit).not.toMatch(/^'/)
      const hex = Buffer.from(s, 'utf8').toString('hex')
      expect(lit).toBe(`CONVERT(X'${hex}' USING utf8mb4)`)
    }
    const j = mod.sqlJson({ a: "x'y", b: '中' }) as string
    expect(j).toMatch(/^CAST\(CONVERT\(X'[0-9a-f]+' USING utf8mb4\) AS JSON\)$/)
  })

  it('bundle embeds injection-shaped labels only as hex (no multi-statement breakout)', async () => {
    const mod = await import(SCRIPT)
    const evilLabel = `Home'); DROP TABLE app_flow_nodes; --`
    const dir = tempDir()
    for (const id of CANONICAL) {
      const flow = await makeFlow(id)
      if (id === 'rn') {
        flow.nodes = flow.nodes.map((n, i) =>
          i === 1 ? { ...n, label_id: evilLabel } : n,
        )
        flow.source_hash = await computeHash(flow)
      }
      writeFileSync(join(dir, `${id}.json`), JSON.stringify(flow, null, 2) + '\n')
    }

    const validated = mod.loadAndValidateAll(dir)
    expect(validated.ok).toBe(true)
    const sql = mod.generateBundleSql(validated, {
      generatedAt: FIXED_AT,
      batchSize: 50,
    }) as string
    mod.assertBundleSafety(sql)
    // raw evil SQL fragment must not appear outside comments
    const body = sql
      .split('\n')
      .filter((l) => !l.trimStart().startsWith('--'))
      .join('\n')
    expect(body).not.toContain(evilLabel)
    expect(body).not.toMatch(/DROP TABLE/i)
    // hex of evil label must be present
    const hex = Buffer.from(evilLabel, 'utf8').toString('hex')
    expect(sql).toContain(hex)
  })
})

// ─── Rejection paths (no SQL output) ─────────────────────────────────────────

describe('validation rejection (no SQL written)', () => {
  it('rejects missing source_hash (hashless)', async () => {
    const { dir } = await writeFiveProjectDir((_id, flow) => {
      if (flow.project_id === 'web') delete flow.source_hash
    })
    const out = join(dir, 'should-not-exist.sql')
    const res = runScript([
      '--bundle',
      '--out',
      out,
      '--dir',
      dir,
      '--generated-at',
      FIXED_AT,
    ])
    expect(res.status).not.toBe(0)
    expect(existsSync(out)).toBe(false)
    expect(`${res.stdout}\n${res.stderr}`).toMatch(/source_hash/)
  })

  it('rejects source_hash mismatch', async () => {
    const { dir } = await writeFiveProjectDir((_id, flow) => {
      if (flow.project_id === 'web') flow.source_hash = 'f'.repeat(64)
    })
    const out = join(dir, 'should-not-exist.sql')
    const res = runScript([
      '--bundle',
      '--out',
      out,
      '--dir',
      dir,
      '--generated-at',
      FIXED_AT,
    ])
    expect(res.status).not.toBe(0)
    expect(existsSync(out)).toBe(false)
    expect(`${res.stdout}\n${res.stderr}`).toMatch(/source_hash_mismatch|source_hash/)
  })

  it('rejects unknown project_id', async () => {
    const dir = tempDir()
    for (const id of CANONICAL) {
      const flow = await makeFlow(id)
      if (id === 'sales') {
        flow.project_id = 'not-a-real-project'
        flow.source_hash = await computeHash(flow)
      }
      writeFileSync(join(dir, `${id}.json`), JSON.stringify(flow, null, 2) + '\n')
    }
    const out = join(dir, 'out.sql')
    const res = runScript(['--bundle', '--out', out, '--dir', dir])
    expect(res.status).not.toBe(0)
    expect(existsSync(out)).toBe(false)
    expect(`${res.stdout}\n${res.stderr}`).toMatch(/unknown_project|project/)
  })

  it('rejects non-canonical project alias identity (filename vs body)', async () => {
    const dir = tempDir()
    for (const id of CANONICAL) {
      const flow = await makeFlow(id)
      if (id === 'rn') {
        // alias that resolves to rn but is not canonical form
        flow.project_id = 'react-native'
        flow.source_hash = await computeHash(flow)
      }
      writeFileSync(join(dir, `${id}.json`), JSON.stringify(flow, null, 2) + '\n')
    }
    const out = join(dir, 'out.sql')
    const res = runScript(['--bundle', '--out', out, '--dir', dir])
    expect(res.status).not.toBe(0)
    expect(existsSync(out)).toBe(false)
    expect(`${res.stdout}\n${res.stderr}`).toMatch(
      /project_alias_noncanonical|project_identity|canonical/,
    )
  })

  it('rejects dangling edge endpoint', async () => {
    const dir = tempDir()
    for (const id of CANONICAL) {
      const flow = await makeFlow(id)
      if (id === 'affiliate') {
        flow.edges = [
          ...flow.edges,
          {
            edge_id: 'Home__Ghost__nav',
            from_node: 'Home',
            to_node: 'GhostNodeMissing',
            edge_kind: 'nav',
            sort_order: 99,
            meta: null,
          },
        ]
        flow.stats = {
          nodes: flow.nodes.length,
          edges: flow.edges.length,
          mapped_features: 2,
          unmapped_screens: 3,
          feature_ids: ['FEAT-AUTH-MEMBER', 'FEAT-HOME-SHELL'],
        }
        flow.source_hash = await computeHash(flow)
      }
      writeFileSync(join(dir, `${id}.json`), JSON.stringify(flow, null, 2) + '\n')
    }
    const out = join(dir, 'out.sql')
    const res = runScript(['--bundle', '--out', out, '--dir', dir])
    expect(res.status).not.toBe(0)
    expect(existsSync(out)).toBe(false)
    expect(`${res.stdout}\n${res.stderr}`).toMatch(/dangling_endpoint/)
  })

  it('rejects duplicate node_id / edge_id', async () => {
    const dir = tempDir()
    for (const id of CANONICAL) {
      const flow = await makeFlow(id)
      if (id === 'backend') {
        flow.nodes = [...flow.nodes, { ...flow.nodes[0], sort_order: 99 }]
        flow.source_hash = await computeHash(flow)
      }
      writeFileSync(join(dir, `${id}.json`), JSON.stringify(flow, null, 2) + '\n')
    }
    let res = runScript([
      '--bundle',
      '--out',
      join(dir, 'out.sql'),
      '--dir',
      dir,
    ])
    expect(res.status).not.toBe(0)
    expect(`${res.stdout}\n${res.stderr}`).toMatch(/duplicate_node/)

    const dir2 = tempDir()
    for (const id of CANONICAL) {
      const flow = await makeFlow(id)
      if (id === 'backend') {
        flow.edges = [
          ...flow.edges,
          { ...flow.edges[0], from_node: 'Settings', to_node: 'Help' },
        ]
        flow.source_hash = await computeHash(flow)
      }
      writeFileSync(join(dir2, `${id}.json`), JSON.stringify(flow, null, 2) + '\n')
    }
    res = runScript([
      '--bundle',
      '--out',
      join(dir2, 'out.sql'),
      '--dir',
      dir2,
    ])
    expect(res.status).not.toBe(0)
    expect(`${res.stdout}\n${res.stderr}`).toMatch(/duplicate_edge_id/)
  })

  it('rejects FEAT projection and page-id shaped endpoints', async () => {
    const dir = tempDir()
    for (const id of CANONICAL) {
      const flow = await makeFlow(id)
      if (id === 'web') {
        flow.edges = [
          ...flow.edges,
          {
            edge_id: 'FEAT__Home__nav',
            from_node: 'FEAT-AUTH-MEMBER',
            to_node: 'Home',
            edge_kind: 'nav',
            sort_order: 50,
            meta: null,
          },
        ]
        flow.source_hash = await computeHash(flow)
      }
      writeFileSync(join(dir, `${id}.json`), JSON.stringify(flow, null, 2) + '\n')
    }
    let res = runScript(['--bundle', '--out', join(dir, 'out.sql'), '--dir', dir])
    expect(res.status).not.toBe(0)
    expect(`${res.stdout}\n${res.stderr}`).toMatch(
      /feat_endpoint|dangling_endpoint/,
    )

    const dir2 = tempDir()
    for (const id of CANONICAL) {
      const flow = await makeFlow(id)
      if (id === 'web') {
        flow.edges = [
          ...flow.edges,
          {
            edge_id: 'page__Home__nav',
            from_node: 'rn-about',
            to_node: 'Home',
            edge_kind: 'nav',
            sort_order: 51,
            meta: null,
          },
        ]
        flow.source_hash = await computeHash(flow)
      }
      writeFileSync(join(dir2, `${id}.json`), JSON.stringify(flow, null, 2) + '\n')
    }
    res = runScript([
      '--bundle',
      '--out',
      join(dir2, 'out.sql'),
      '--dir',
      dir2,
    ])
    expect(res.status).not.toBe(0)
    expect(`${res.stdout}\n${res.stderr}`).toMatch(
      /page_id_endpoint|dangling_endpoint/,
    )
  })

  it('rejects control characters in labels', async () => {
    const dir = tempDir()
    for (const id of CANONICAL) {
      const flow = await makeFlow(id)
      if (id === 'sales') {
        flow.nodes = flow.nodes.map((n, i) =>
          i === 0 ? { ...n, label_id: 'Login\nScreen' } : n,
        )
        flow.source_hash = await computeHash(flow)
      }
      writeFileSync(join(dir, `${id}.json`), JSON.stringify(flow, null, 2) + '\n')
    }
    const out = join(dir, 'out.sql')
    const res = runScript(['--bundle', '--out', out, '--dir', dir])
    expect(res.status).not.toBe(0)
    expect(existsSync(out)).toBe(false)
    expect(`${res.stdout}\n${res.stderr}`).toMatch(/control_char/)
  })

  it('rejects malformed records and missing files', async () => {
    const dir = tempDir()
    for (const id of CANONICAL) {
      if (id === 'backend') continue // missing file
      const flow = await makeFlow(id)
      writeFileSync(join(dir, `${id}.json`), JSON.stringify(flow, null, 2) + '\n')
    }
    let res = runScript([
      '--bundle',
      '--out',
      join(dir, 'out.sql'),
      '--dir',
      dir,
    ])
    expect(res.status).not.toBe(0)
    expect(`${res.stdout}\n${res.stderr}`).toMatch(/missing_file|missing/)

    const dir2 = tempDir()
    for (const id of CANONICAL) {
      if (id === 'rn') {
        writeFileSync(join(dir2, `${id}.json`), '{not json')
      } else {
        const flow = await makeFlow(id)
        writeFileSync(join(dir2, `${id}.json`), JSON.stringify(flow, null, 2) + '\n')
      }
    }
    res = runScript([
      '--bundle',
      '--out',
      join(dir2, 'out.sql'),
      '--dir',
      dir2,
    ])
    expect(res.status).not.toBe(0)
    expect(`${res.stdout}\n${res.stderr}`).toMatch(/malformed|JSON parse/)
  })

  it('rejects cross-project endpoint fiction (endpoint not in same project node set)', async () => {
    // Edges only reference node ids within the same file; a foreign node_id is dangling.
    const dir = tempDir()
    for (const id of CANONICAL) {
      const flow = await makeFlow(id)
      if (id === 'rn') {
        flow.edges = [
          ...flow.edges,
          {
            edge_id: 'Home__WebOnly__nav',
            from_node: 'Home',
            to_node: 'WebOnlyScreen',
            edge_kind: 'nav',
            sort_order: 40,
            meta: null,
          },
        ]
        flow.source_hash = await computeHash(flow)
      }
      writeFileSync(join(dir, `${id}.json`), JSON.stringify(flow, null, 2) + '\n')
    }
    const res = runScript([
      '--bundle',
      '--out',
      join(dir, 'out.sql'),
      '--dir',
      dir,
    ])
    expect(res.status).not.toBe(0)
    expect(`${res.stdout}\n${res.stderr}`).toMatch(/dangling_endpoint/)
  })
})

// ─── Pure unit helpers ───────────────────────────────────────────────────────

describe('loader pure helpers', () => {
  it('validateFlowForLoad accepts extractor-compatible hash (excludes generated_at)', async () => {
    const mod = await import(SCRIPT)
    const flow = await makeFlow('sales')
    const h1 = flow.source_hash!
    flow.generated_at = '2099-01-01T00:00:00.000Z'
    // hash field unchanged; recompute must still match payload excluding generated_at
    const v = mod.validateFlowForLoad(flow, 'sales') as {
      ok: boolean
      issues: Array<{ code: string }>
    }
    expect(v.ok).toBe(true)
    expect(h1).toMatch(/^[a-f0-9]{64}$/)
    const h2 = await computeHash({ ...flow, generated_at: '1999-01-01T00:00:00.000Z' })
    expect(h2).toBe(h1)
  })

  it('buildNodeMetaJson embeds source_hash + provenance without mutating input', async () => {
    const mod = await import(SCRIPT)
    const node = {
      node_id: 'X',
      feature_id: null,
      label_id: 'X',
      kind: 'screen' as const,
      sort_order: 0,
      layout_col: 0,
      layout_row: 0,
      meta: { keep: true },
    }
    const meta = mod.buildNodeMetaJson(node, 'ab'.repeat(32)) as Record<string, unknown>
    expect(meta.source_hash).toBe('ab'.repeat(32))
    expect(meta.provenance).toBe('app_flow_json')
    expect(meta.keep).toBe(true)
    expect(node.meta).toEqual({ keep: true })
  })

  it('assertBundleSafety rejects forbidden tables / DML via allowlist', async () => {
    const mod = await import(SCRIPT)
    expect(() =>
      mod.assertBundleSafety(
        'START TRANSACTION;\nINSERT INTO app_pages (id) VALUES (1);\nCOMMIT;\n',
      ),
    ).toThrow(/non-allowlisted table|allowlist/)
    expect(() =>
      mod.assertBundleSafety(
        'START TRANSACTION;\nDELETE FROM app_flow_nodes;\nCOMMIT;\n',
      ),
    ).toThrow(/DELETE|allowlist/)
    expect(() =>
      mod.assertBundleSafety('INSERT INTO app_flow_nodes (project_id) VALUES (1);\n'),
    ).toThrow(/START TRANSACTION|allowlist|ON DUPLICATE/)
  })
})

// ─── R2: generatedAt hardening (F1 residual) ─────────────────────────────────

describe('R2 generatedAt canonical UTC ISO hardening', () => {
  it('assertCanonicalGeneratedAt accepts only exact round-trip ISO', async () => {
    const mod = await import(SCRIPT)
    expect(mod.assertCanonicalGeneratedAt(FIXED_AT)).toBe(FIXED_AT)
    expect(mod.assertCanonicalGeneratedAt('2026-07-19T00:00:00.000Z')).toBe(
      '2026-07-19T00:00:00.000Z',
    )
    const bad = [
      `${FIXED_AT}\nUPDATE app_flow_nodes SET kind='x'; --`,
      `${FIXED_AT}\r\nDELETE FROM app_flow_nodes; --`,
      `${FIXED_AT}--`,
      `${FIXED_AT}/*`,
      `${FIXED_AT} */`,
      '2026-07-19T12:00:00Z', // missing millis
      '2026-07-19T12:00:00.000+00:00', // offset
      ' 2026-07-19T12:00:00.000Z',
      '2026-07-19T12:00:00.000Z ',
      '2026-02-30T00:00:00.000Z', // invalid calendar
      '2026-13-01T00:00:00.000Z',
      'not-a-date',
      '',
      null,
      undefined,
    ]
    for (const v of bad) {
      expect(() => mod.assertCanonicalGeneratedAt(v as string), String(v)).toThrow(
        /generated_at_invalid/,
      )
    }
  })

  it('malicious generatedAt with \\nUPDATE fails; no output replacement', async () => {
    const { dir } = await writeFiveProjectDir()
    const out = join(dir, 'out.sql')
    // Seed prior content that must be preserved on failure
    writeFileSync(out, '-- PRIOR CONTENT MUST SURVIVE\n')
    const evil = `${FIXED_AT}\nUPDATE app_flow_nodes SET kind='x'; --`
    const res = runScript([
      '--bundle',
      '--out',
      out,
      '--dir',
      dir,
      '--generated-at',
      evil,
    ])
    expect(res.status).not.toBe(0)
    expect(`${res.stdout}\n${res.stderr}`).toMatch(/generated_at_invalid/)
    expect(existsSync(out)).toBe(true)
    expect(readFileSync(out, 'utf8')).toBe('-- PRIOR CONTENT MUST SURVIVE\n')
    expect(readFileSync(out, 'utf8')).not.toMatch(/UPDATE/)
  })

  it('malicious generatedAt with \\r\\nDELETE fails; no output', async () => {
    const { dir } = await writeFiveProjectDir()
    const out = join(dir, 'out.sql')
    writeFileSync(out, '-- KEEP\n')
    const evil = `${FIXED_AT}\r\nDELETE FROM app_flow_nodes; --`
    const res = runScript([
      '--bundle',
      '--out',
      out,
      '--dir',
      dir,
      '--generated-at',
      evil,
    ])
    expect(res.status).not.toBe(0)
    expect(`${res.stdout}\n${res.stderr}`).toMatch(/generated_at_invalid/)
    expect(readFileSync(out, 'utf8')).toBe('-- KEEP\n')
  })

  it('generatedAt with -- or /* comment markers fails', async () => {
    const { dir } = await writeFiveProjectDir()
    for (const evil of [`${FIXED_AT}--`, `${FIXED_AT}/*x*/`]) {
      const out = join(dir, `out-${Buffer.from(evil).toString('hex').slice(0, 8)}.sql`)
      const res = runScript([
        '--bundle',
        '--out',
        out,
        '--dir',
        dir,
        '--generated-at',
        evil,
      ])
      expect(res.status, evil).not.toBe(0)
      expect(`${res.stdout}\n${res.stderr}`).toMatch(/generated_at_invalid/)
      expect(existsSync(out)).toBe(false)
    }
  })

  it('invalid calendar generatedAt fails (round-trip)', async () => {
    const { dir } = await writeFiveProjectDir()
    const out = join(dir, 'out.sql')
    const res = runScript([
      '--bundle',
      '--out',
      out,
      '--dir',
      dir,
      '--generated-at',
      '2026-02-30T00:00:00.000Z',
    ])
    expect(res.status).not.toBe(0)
    expect(`${res.stdout}\n${res.stderr}`).toMatch(/generated_at_invalid/)
    expect(existsSync(out)).toBe(false)
  })

  it('evil APP_FLOW_BUNDLE_GENERATED_AT env fails with no output replacement', async () => {
    const { dir } = await writeFiveProjectDir()
    const out = join(dir, 'out.sql')
    writeFileSync(out, '-- ENV PRIOR\n')
    const evil = `${FIXED_AT}\nUPDATE app_flow_nodes SET kind='evil'; --`
    const res = runScript(['--bundle', '--out', out, '--dir', dir], {
      APP_FLOW_BUNDLE_GENERATED_AT: evil,
    })
    expect(res.status).not.toBe(0)
    expect(`${res.stdout}\n${res.stderr}`).toMatch(/generated_at_invalid/)
    expect(readFileSync(out, 'utf8')).toBe('-- ENV PRIOR\n')
  })

  it('generateBundleSql rejects evil generatedAt before header emission', async () => {
    const mod = await import(SCRIPT)
    const { dir } = await writeFiveProjectDir()
    const validated = mod.loadAndValidateAll(dir)
    expect(validated.ok).toBe(true)
    expect(() =>
      mod.generateBundleSql(validated, {
        generatedAt: `${FIXED_AT}\nUPDATE app_flow_nodes SET kind='x'; --`,
        batchSize: 50,
      }),
    ).toThrow(/generated_at_invalid/)
  })

  it('fixed valid generatedAt remains deterministic; default ISO works internally', async () => {
    const mod = await import(SCRIPT)
    const { dir } = await writeFiveProjectDir()
    const validated = mod.loadAndValidateAll(dir)
    const a = mod.generateBundleSql(validated, {
      generatedAt: FIXED_AT,
      batchSize: 50,
    }) as string
    const b = mod.generateBundleSql(validated, {
      generatedAt: FIXED_AT,
      batchSize: 50,
    }) as string
    expect(a).toBe(b)
    expect(a).toContain(`-- generated_at: ${FIXED_AT}`)
    // No pin: uses current canonical ISO (still valid, may differ by call)
    const c = mod.generateBundleSql(validated, { batchSize: 50 }) as string
    expect(c).toMatch(/-- generated_at: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/)
    mod.assertBundleSafety(c)
  })
})

// ─── R2: statement allowlist safety (adversarial probes) ─────────────────────

describe('R2 assertBundleSafety statement allowlist', () => {
  const minimalGood = `
SET NAMES utf8mb4;
SET SESSION sql_mode = CONCAT(@@sql_mode, ',STRICT_TRANS_TABLES');
START TRANSACTION;
INSERT INTO app_flow_nodes (project_id, node_id, feature_id, label_id, kind, sort_order, layout_col, layout_row, source_ref, meta_json) VALUES
  (CONVERT(X'726e' USING utf8mb4), CONVERT(X'41' USING utf8mb4), NULL, CONVERT(X'41' USING utf8mb4), CONVERT(X'73637265656e' USING utf8mb4), 0, 0, 0, CONVERT, NULL)
ON DUPLICATE KEY UPDATE feature_id=VALUES(feature_id), label_id=VALUES(label_id), kind=VALUES(kind), sort_order=VALUES(sort_order), layout_col=VALUES(layout_col), layout_row=VALUES(layout_row), source_ref=VALUES(source_ref), meta_json=VALUES(meta_json);
INSERT INTO app_flow_edges (project_id, edge_id, from_node, to_node, edge_kind, sort_order, meta_json) VALUES
  (CONVERT(X'726e' USING utf8mb4), CONVERT(X'65' USING utf8mb4), CONVERT(X'41' USING utf8mb4), CONVERT(X'42' USING utf8mb4), CONVERT(X'6e6176' USING utf8mb4), 0, NULL)
ON DUPLICATE KEY UPDATE from_node=VALUES(from_node), to_node=VALUES(to_node), edge_kind=VALUES(edge_kind), sort_order=VALUES(sort_order), meta_json=VALUES(meta_json);
COMMIT;
`.trim()

  it('accepts honest minimal allowlisted bundle', async () => {
    const mod = await import(SCRIPT)
    expect(mod.assertBundleSafety(minimalGood)).toBe(true)
  })

  it('rejects bare UPDATE (F1 header breakout class)', async () => {
    const mod = await import(SCRIPT)
    const evil =
      `SET NAMES utf8mb4;\nSTART TRANSACTION;\n` +
      `UPDATE app_flow_nodes SET kind='x';\n` +
      `INSERT INTO app_flow_nodes (project_id, node_id, feature_id, label_id, kind, sort_order, layout_col, layout_row, source_ref, meta_json) VALUES (1,1,NULL,1,'screen',0,0,0,NULL,NULL) ON DUPLICATE KEY UPDATE kind=VALUES(kind);\n` +
      `COMMIT;\n`
    expect(() => mod.assertBundleSafety(evil)).toThrow(/UPDATE|allowlist/)
  })

  it('rejects DELETE/TRUNCATE/DROP/REPLACE/LOAD/ALTER/CREATE/CALL/DO/SELECT/USE', async () => {
    const mod = await import(SCRIPT)
    const banned = [
      'DELETE FROM app_flow_nodes',
      'TRUNCATE TABLE app_flow_nodes',
      'DROP TABLE app_flow_nodes',
      'REPLACE INTO app_flow_nodes (project_id) VALUES (1)',
      'LOAD DATA INFILE "x" INTO TABLE app_flow_nodes',
      'ALTER TABLE app_flow_nodes ADD COLUMN z INT',
      'CREATE TABLE evil (id INT)',
      'CALL some_proc()',
      'DO 1',
      'SELECT * FROM app_flow_nodes',
      'USE mysql',
    ]
    for (const stmt of banned) {
      const sql = `SET NAMES utf8mb4;\nSTART TRANSACTION;\n${stmt};\nCOMMIT;\n`
      expect(() => mod.assertBundleSafety(sql), stmt).toThrow(/allowlist|disallowed|missing app_flow/)
    }
  })

  it('rejects INSERT into non-allowlisted tables', async () => {
    const mod = await import(SCRIPT)
    for (const table of [
      'app_pages',
      'nav_edges',
      'users',
      'schema_migrations',
      'cp0_snapshot',
    ]) {
      const sql =
        `SET NAMES utf8mb4;\nSTART TRANSACTION;\n` +
        `INSERT INTO ${table} (id) VALUES (1);\nCOMMIT;\n`
      expect(() => mod.assertBundleSafety(sql), table).toThrow(
        /non-allowlisted|allowlist/,
      )
    }
  })

  it('does not mis-split on hex-encoded semicolon (0x3b)', async () => {
    const mod = await import(SCRIPT)
    // Hex payload contains ASCII ';' (0x3b) but must remain one INSERT statement
    const hexWithSemi = Buffer.from("a;b", 'utf8').toString('hex')
    expect(hexWithSemi).toContain('3b')
    const sql = `
SET NAMES utf8mb4;
SET SESSION sql_mode = CONCAT(@@sql_mode, ',STRICT_TRANS_TABLES');
START TRANSACTION;
INSERT INTO app_flow_nodes (project_id, node_id, feature_id, label_id, kind, sort_order, layout_col, layout_row, source_ref, meta_json) VALUES
  (CONVERT(X'${hexWithSemi}' USING utf8mb4), CONVERT(X'41' USING utf8mb4), NULL, CONVERT(X'41' USING utf8mb4), CONVERT(X'73637265656e' USING utf8mb4), 0, 0, 0, NULL, NULL)
ON DUPLICATE KEY UPDATE feature_id=VALUES(feature_id), label_id=VALUES(label_id), kind=VALUES(kind), sort_order=VALUES(sort_order), layout_col=VALUES(layout_col), layout_row=VALUES(layout_row), source_ref=VALUES(source_ref), meta_json=VALUES(meta_json);
COMMIT;
`.trim()
    expect(mod.assertBundleSafety(sql)).toBe(true)
    const stmts = mod.splitSqlStatements(
      sql
        .split('\n')
        .map((l: string) => {
          const idx = l.indexOf('--')
          return idx >= 0 ? l.slice(0, idx) : l
        })
        .join('\n'),
    ) as string[]
    // SET NAMES, SET SESSION, START, INSERT, COMMIT = 5
    expect(stmts.length).toBe(5)
    expect(stmts.some((s) => /INSERT\s+INTO\s+app_flow_nodes/i.test(s))).toBe(true)
  })

  it('header comment noise with DELETE is ignored; body DELETE is not', async () => {
    const mod = await import(SCRIPT)
    const withComment =
      `-- DELETE FROM app_flow_nodes;\n` + minimalGood
    expect(mod.assertBundleSafety(withComment)).toBe(true)
    const withBodyDelete =
      minimalGood.replace(
        'START TRANSACTION;',
        'START TRANSACTION;\nDELETE FROM app_flow_nodes;',
      )
    expect(() => mod.assertBundleSafety(withBodyDelete)).toThrow(/DELETE|allowlist/)
  })

  it('rejects INSERT without ON DUPLICATE KEY UPDATE', async () => {
    const mod = await import(SCRIPT)
    const sql = `
SET NAMES utf8mb4;
START TRANSACTION;
INSERT INTO app_flow_nodes (project_id, node_id, feature_id, label_id, kind, sort_order, layout_col, layout_row, source_ref, meta_json) VALUES (1,1,NULL,1,'screen',0,0,0,NULL,NULL);
COMMIT;
`.trim()
    expect(() => mod.assertBundleSafety(sql)).toThrow(/ON DUPLICATE/)
  })
})

// ─── R2: migration-011 schema width + MySQL INT range ────────────────────────

describe('R2 migration-011 width and INT range validation', () => {
  async function validateMutated(
    mutate: (flow: ProjectFlow) => void | Promise<void>,
  ) {
    const mod = await import(SCRIPT)
    const flow = await makeFlow('rn')
    await mutate(flow)
    // rehash after mutation unless mutate intentionally breaks hash
    if (flow.source_hash) {
      flow.source_hash = await computeHash(flow)
    }
    return mod.validateFlowForLoad(flow, 'rn') as {
      ok: boolean
      issues: Array<{ code: string; message: string }>
    }
  }

  it('exact schema width boundaries pass; +1 fails with stable codes', async () => {
    const mod = await import(SCRIPT)
    expect(mod.SCHEMA_WIDTH).toMatchObject({
      project_id: 64,
      node_id: 160,
      feature_id: 160,
      label_id: 512,
      kind: 32,
      source_ref: 512,
      edge_id: 191,
      from_node: 160,
      to_node: 160,
      edge_kind: 64,
    })

    // node_id exactly 160
    {
      const id160 = 'N' + 'a'.repeat(159)
      expect(id160.length).toBe(160)
      const v = await validateMutated((flow) => {
        flow.nodes[0] = { ...flow.nodes[0], node_id: id160 }
        // fix edges that pointed at Login
        flow.edges = flow.edges.map((e) => ({
          ...e,
          from_node: e.from_node === 'Login' ? id160 : e.from_node,
          to_node: e.to_node === 'Login' ? id160 : e.to_node,
          edge_id:
            e.from_node === 'Login' || e.to_node === 'Login'
              ? `${e.from_node === 'Login' ? id160 : e.from_node}__${e.to_node === 'Login' ? id160 : e.to_node}__${e.edge_kind}`.slice(
                  0,
                  191,
                )
              : e.edge_id,
        }))
      })
      expect(v.ok, JSON.stringify(v.issues)).toBe(true)
    }

    // node_id 161 → node_id_width
    {
      const id161 = 'N' + 'a'.repeat(160)
      expect(id161.length).toBe(161)
      const v = await validateMutated((flow) => {
        flow.nodes[0] = { ...flow.nodes[0], node_id: id161 }
      })
      expect(v.ok).toBe(false)
      expect(v.issues.some((i) => i.code === 'node_id_width')).toBe(true)
    }

    // label_id 512 pass / 513 fail
    {
      const lab512 = 'L' + 'b'.repeat(511)
      expect(lab512.length).toBe(512)
      const v = await validateMutated((flow) => {
        flow.nodes[0] = { ...flow.nodes[0], label_id: lab512 }
      })
      expect(v.ok, JSON.stringify(v.issues)).toBe(true)
    }
    {
      const lab513 = 'L' + 'b'.repeat(512)
      const v = await validateMutated((flow) => {
        flow.nodes[0] = { ...flow.nodes[0], label_id: lab513 }
      })
      expect(v.ok).toBe(false)
      expect(v.issues.some((i) => i.code === 'label_id_width')).toBe(true)
    }

    // edge_id 191 pass / 192 fail
    {
      const eid191 = 'E' + 'c'.repeat(190)
      expect(eid191.length).toBe(191)
      const v = await validateMutated((flow) => {
        flow.edges[0] = { ...flow.edges[0], edge_id: eid191 }
      })
      expect(v.ok, JSON.stringify(v.issues)).toBe(true)
    }
    {
      const eid192 = 'E' + 'c'.repeat(191)
      const v = await validateMutated((flow) => {
        flow.edges[0] = { ...flow.edges[0], edge_id: eid192 }
      })
      expect(v.ok).toBe(false)
      expect(v.issues.some((i) => i.code === 'edge_id_width')).toBe(true)
    }

    // edge_kind 64 pass / 65 fail
    {
      const ek64 = 'k' + 'd'.repeat(63)
      expect(ek64.length).toBe(64)
      const v = await validateMutated((flow) => {
        flow.edges[0] = { ...flow.edges[0], edge_kind: ek64 }
      })
      expect(v.ok, JSON.stringify(v.issues)).toBe(true)
    }
    {
      const ek65 = 'k' + 'd'.repeat(64)
      const v = await validateMutated((flow) => {
        flow.edges[0] = { ...flow.edges[0], edge_kind: ek65 }
      })
      expect(v.ok).toBe(false)
      expect(v.issues.some((i) => i.code === 'edge_kind_width')).toBe(true)
    }

    // feature_id 160 pass / 161 fail
    {
      const feat160 = 'FEAT-' + 'A'.repeat(155)
      expect(feat160.length).toBe(160)
      const v = await validateMutated((flow) => {
        flow.nodes[0] = { ...flow.nodes[0], feature_id: feat160 }
      })
      expect(v.ok, JSON.stringify(v.issues)).toBe(true)
    }
    {
      const feat161 = 'FEAT-' + 'A'.repeat(156)
      expect(feat161.length).toBe(161)
      const v = await validateMutated((flow) => {
        flow.nodes[0] = { ...flow.nodes[0], feature_id: feat161 }
      })
      expect(v.ok).toBe(false)
      expect(v.issues.some((i) => i.code === 'feature_id_width')).toBe(true)
    }

    // source_ref 512 pass / 513 fail
    {
      const sr512 = 's' + 'e'.repeat(511)
      const v = await validateMutated((flow) => {
        flow.nodes[0] = { ...flow.nodes[0], source_ref: sr512 }
      })
      expect(v.ok, JSON.stringify(v.issues)).toBe(true)
    }
    {
      const sr513 = 's' + 'e'.repeat(512)
      const v = await validateMutated((flow) => {
        flow.nodes[0] = { ...flow.nodes[0], source_ref: sr513 }
      })
      expect(v.ok).toBe(false)
      expect(v.issues.some((i) => i.code === 'source_ref_width')).toBe(true)
    }

    // default source_ref fits for canonical project ids
    {
      const v = await validateMutated((flow) => {
        flow.nodes[0] = { ...flow.nodes[0], source_ref: null }
      })
      expect(v.ok, JSON.stringify(v.issues)).toBe(true)
    }
  })

  it('signed MySQL INT range: boundaries pass; non-integers and OOR fail', async () => {
    const mod = await import(SCRIPT)
    const min = mod.MYSQL_INT_MIN as number
    const max = mod.MYSQL_INT_MAX as number
    expect(min).toBe(-2147483648)
    expect(max).toBe(2147483647)

    {
      const v = await validateMutated((flow) => {
        flow.nodes[0] = {
          ...flow.nodes[0],
          sort_order: min,
          layout_col: max,
          layout_row: 0,
        }
      })
      expect(v.ok, JSON.stringify(v.issues)).toBe(true)
    }
    {
      const v = await validateMutated((flow) => {
        flow.nodes[0] = { ...flow.nodes[0], sort_order: max + 1 }
      })
      expect(v.ok).toBe(false)
      expect(v.issues.some((i) => i.code === 'sort_order')).toBe(true)
    }
    {
      const v = await validateMutated((flow) => {
        flow.nodes[0] = { ...flow.nodes[0], layout_col: min - 1 }
      })
      expect(v.ok).toBe(false)
      expect(v.issues.some((i) => i.code === 'layout')).toBe(true)
    }
    {
      const v = await validateMutated((flow) => {
        flow.nodes[0] = { ...flow.nodes[0], sort_order: 1.5 as unknown as number }
      })
      expect(v.ok).toBe(false)
      expect(v.issues.some((i) => i.code === 'sort_order')).toBe(true)
    }
    {
      const v = await validateMutated((flow) => {
        flow.nodes[0] = {
          ...flow.nodes[0],
          layout_row: Number.NaN,
        }
      })
      expect(v.ok).toBe(false)
      expect(v.issues.some((i) => i.code === 'layout')).toBe(true)
    }
  })

  it('width failure blocks SQL write (atomic no-replace)', async () => {
    const dir = tempDir()
    for (const id of CANONICAL) {
      const flow = await makeFlow(id)
      if (id === 'web') {
        flow.nodes[0] = {
          ...flow.nodes[0],
          label_id: 'L' + 'x'.repeat(512), // 513
        }
        flow.source_hash = await computeHash(flow)
      }
      writeFileSync(join(dir, `${id}.json`), JSON.stringify(flow, null, 2) + '\n')
    }
    const out = join(dir, 'out.sql')
    writeFileSync(out, '-- STALE\n')
    const res = runScript([
      '--bundle',
      '--out',
      out,
      '--dir',
      dir,
      '--generated-at',
      FIXED_AT,
    ])
    expect(res.status).not.toBe(0)
    expect(`${res.stdout}\n${res.stderr}`).toMatch(/label_id_width/)
    expect(readFileSync(out, 'utf8')).toBe('-- STALE\n')
  })
})

// ─── Salvage regression (do not modify salvage trio) ─────────────────────────

describe('salvage regression (file extractor remains green)', () => {
  it('app-flow.ingest.spec.ts still exists and salvage CLI --help works', () => {
    expect(existsSync(SALVAGE_SPEC)).toBe(true)
    expect(existsSync(INGEST)).toBe(true)
    const res = spawnSync(process.execPath, [INGEST, '--help'], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 30_000,
    })
    expect(res.status, res.stderr || res.stdout).toBe(0)
    expect(res.stdout).toMatch(/--dry-run/)
    expect(res.stdout).toMatch(/No DB/)
  })
})
