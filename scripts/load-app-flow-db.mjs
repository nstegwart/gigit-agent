#!/usr/bin/env node
/**
 * TM-AUTHOR-APP-FLOW-MYSQL-LOADER-R2 — offline JSON → MySQL SQL bundle for migration-011.
 *
 * Reads canonical data/app-flow/{rn,web,sales,affiliate,backend}.json (source_hash required).
 * Default mode: validate + dry summary (no write).
 * --bundle --out <path>: emit one deterministic START TRANSACTION…COMMIT UPSERT bundle.
 *
 * R2: NO --db connection. NO prune/delete/truncate. NO app_pages/nav_edges/api/CP tables.
 * Hardened: canonical generatedAt only; statement allowlist safety; migration-011 widths + INT range.
 * Does NOT mutate product repos, migrations, or data/app-flow contents.
 *
 * Usage:
 *   node scripts/load-app-flow-db.mjs --help
 *   node scripts/load-app-flow-db.mjs [--dir data/app-flow]
 *   node scripts/load-app-flow-db.mjs --bundle --out /tmp/upload-app-flow.sql [--generated-at ISO]
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import {
  PROJECTS,
  computeSourceHash,
  resolveProjectAlias,
} from './ingest-app-flow.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const DEFAULT_DIR = path.join(ROOT, 'data', 'app-flow')
const DEFAULT_BATCH = 50

/** C0 controls + DEL — reject anywhere in validated string fields. */
const CONTROL_CHAR_RE = /[\u0000-\u001F\u007F]/

/**
 * migration-011 VARCHAR widths (exact).
 * project_id VARCHAR(64); node_id/feature_id/from/to VARCHAR(160);
 * label_id/source_ref VARCHAR(512); kind VARCHAR(32);
 * edge_id VARCHAR(191); edge_kind VARCHAR(64).
 */
export const SCHEMA_WIDTH = Object.freeze({
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

/** Signed MySQL INT range for sort_order / layout_col / layout_row. */
export const MYSQL_INT_MIN = -2147483648
export const MYSQL_INT_MAX = 2147483647

/** Exact canonical UTC ISO: YYYY-MM-DDTHH:mm:ss.sssZ (no offsets/spaces/controls). */
const CANONICAL_UTC_ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

// node_id / from / to: 1..160; edge_id: 1..191 (shape + schema width)
const NODE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,159}$/
const EDGE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,190}$/
const FEATURE_SOFT_RE = /^FEAT-[A-Z0-9][A-Z0-9_-]*$/
const HASH_RE = /^[a-f0-9]{64}$/
const PAGE_ID_HINT_RE = /^(rn|web|aff|sales|backend)-[a-z0-9]/i

// ─── CLI ─────────────────────────────────────────────────────────────────────

export function parseArgs(argv = process.argv.slice(2)) {
  const opts = {
    help: false,
    bundle: false,
    out: null,
    dir: DEFAULT_DIR,
    generatedAt: process.env.APP_FLOW_BUNDLE_GENERATED_AT || null,
    batchSize: DEFAULT_BATCH,
    /** Explicit refuse — R1 has no live DB mode. */
    db: false,
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--help' || a === '-h') opts.help = true
    else if (a === '--bundle') opts.bundle = true
    else if (a === '--out') opts.out = path.resolve(argv[++i] || '')
    else if (a === '--dir') opts.dir = path.resolve(argv[++i] || '')
    else if (a === '--generated-at') opts.generatedAt = argv[++i] || null
    else if (a === '--batch-size') {
      const n = Number(argv[++i])
      if (!Number.isInteger(n) || n < 1 || n > 500) {
        throw new Error(`--batch-size must be integer 1..500, got ${n}`)
      }
      opts.batchSize = n
    } else if (a === '--db') {
      opts.db = true
    } else if (a === '--dry-run') {
      /* default is dry; accepted as no-op alias */
    } else if (a.startsWith('-')) {
      throw new Error(`unknown flag: ${a}`)
    } else {
      throw new Error(`unexpected argument: ${a}`)
    }
  }
  return opts
}

export function printHelp() {
  const text = `Usage: node scripts/load-app-flow-db.mjs [options]

Offline migration-011 SQL bundle generator for app_flow_nodes / app_flow_edges.
No DB connection in R1. No prune/delete. Never writes 012 page_nav / API tables.

Options:
  --help, -h              Show this help
  --dir <path>            Input directory (default: data/app-flow)
  --bundle                Emit SQL bundle (requires --out); still validates first
  --out <path>            Output .sql path (atomic temp→rename)
  --generated-at <iso>    Pin header timestamp (exact UTC ISO YYYY-MM-DDTHH:mm:ss.sssZ)
  --batch-size <n>        Multi-row INSERT batch size (default: ${DEFAULT_BATCH}, max 500)
  --dry-run               Default mode alias: validate + summary, no write

Environment:
  APP_FLOW_BUNDLE_GENERATED_AT   Same exact UTC ISO pin as --generated-at (no newlines/controls)

Canonical projects (exact filenames): rn web sales affiliate backend
generatedAt must round-trip through Date and match YYYY-MM-DDTHH:mm:ss.sssZ exactly.
`
  console.log(text)
  return text
}

// ─── utils ───────────────────────────────────────────────────────────────────

export function sha256(text) {
  return crypto.createHash('sha256').update(String(text), 'utf8').digest('hex')
}

function hasControlChars(s) {
  return typeof s === 'string' && CONTROL_CHAR_RE.test(s)
}

/**
 * Accept only exact canonical UTC ISO `YYYY-MM-DDTHH:mm:ss.sssZ` that round-trips
 * through Date. Rejects newline/CR/tab/controls, comments, extra spaces, offsets,
 * invalid calendar dates, and any non-exact form (env/CLI injection surface).
 * @returns {string} the validated string (unchanged)
 */
export function assertCanonicalGeneratedAt(value) {
  if (value == null || typeof value !== 'string') {
    throw new Error(
      'generated_at_invalid: must be exact canonical UTC ISO YYYY-MM-DDTHH:mm:ss.sssZ',
    )
  }
  // Fail closed on any control / whitespace outside the exact ISO charset
  if (CONTROL_CHAR_RE.test(value) || /[\s\r\n\t]/.test(value)) {
    throw new Error(
      'generated_at_invalid: control characters, newlines, or whitespace not allowed',
    )
  }
  if (/--|\/\*|\*\//.test(value)) {
    throw new Error('generated_at_invalid: SQL comment markers not allowed')
  }
  if (!CANONICAL_UTC_ISO_RE.test(value)) {
    throw new Error(
      'generated_at_invalid: must be exact canonical UTC ISO YYYY-MM-DDTHH:mm:ss.sssZ',
    )
  }
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) {
    throw new Error('generated_at_invalid: not a valid date')
  }
  // Round-trip rejects invalid calendar (e.g. 2026-02-30) and non-canonical forms
  if (d.toISOString() !== value) {
    throw new Error(
      'generated_at_invalid: does not round-trip through Date.toISOString()',
    )
  }
  return value
}

/**
 * Resolve generatedAt for SQL emission: options → env → current canonical ISO.
 * Always validates before use (never interpolates untrusted values into header).
 */
export function resolveGeneratedAt(optionsGeneratedAt) {
  const raw =
    optionsGeneratedAt != null && optionsGeneratedAt !== ''
      ? optionsGeneratedAt
      : process.env.APP_FLOW_BUNDLE_GENERATED_AT != null &&
          process.env.APP_FLOW_BUNDLE_GENERATED_AT !== ''
        ? process.env.APP_FLOW_BUNDLE_GENERATED_AT
        : new Date().toISOString()
  return assertCanonicalGeneratedAt(raw)
}

function pushWidthIssue(issues, code, field, value, max, pathLabel) {
  issues.push({
    code,
    message: `${field} length ${String(value).length} exceeds migration-011 max ${max}`,
    path: pathLabel,
  })
}

function checkMysqlInt(value, code, pathLabel, issues) {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    issues.push({
      code,
      message: `${pathLabel} must be a signed integer (MySQL INT)`,
      path: pathLabel,
    })
    return
  }
  if (value < MYSQL_INT_MIN || value > MYSQL_INT_MAX) {
    issues.push({
      code,
      message: `${pathLabel} out of signed MySQL INT range [${MYSQL_INT_MIN}, ${MYSQL_INT_MAX}]`,
      path: pathLabel,
    })
  }
}

function checkNoControl(value, pathLabel, issues) {
  if (value == null) return
  if (typeof value === 'string') {
    if (hasControlChars(value)) {
      issues.push({
        code: 'control_char',
        message: `control character in ${pathLabel}`,
        path: pathLabel,
      })
    }
    return
  }
  if (typeof value === 'number' || typeof value === 'boolean') return
  if (Array.isArray(value)) {
    value.forEach((v, i) => checkNoControl(v, `${pathLabel}[${i}]`, issues))
    return
  }
  if (typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (hasControlChars(k)) {
        issues.push({
          code: 'control_char',
          message: `control character in key ${pathLabel}.${k}`,
          path: pathLabel,
        })
      }
      checkNoControl(v, `${pathLabel}.${k}`, issues)
    }
  }
}

/**
 * Injection-safe MySQL string literal via UTF-8 hex (no quote/backslash breakout).
 * MySQL 8.4: CONVERT(X'…' USING utf8mb4)
 */
export function sqlStr(v) {
  if (v == null) return 'NULL'
  const hex = Buffer.from(String(v), 'utf8').toString('hex')
  return `CONVERT(X'${hex}' USING utf8mb4)`
}

/** JSON column: CAST(utf8 hex string AS JSON), or NULL. */
export function sqlJson(v) {
  if (v == null) return 'NULL'
  const text = typeof v === 'string' ? v : JSON.stringify(v)
  return `CAST(${sqlStr(text)} AS JSON)`
}

export function sqlInt(n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) {
    throw new Error(`sqlInt expects finite number, got ${n}`)
  }
  return String(Math.trunc(n))
}

function sortNodes(nodes) {
  return [...nodes].sort(
    (a, b) =>
      (a.sort_order ?? 0) - (b.sort_order ?? 0) ||
      String(a.node_id).localeCompare(String(b.node_id)),
  )
}

function sortEdges(edges) {
  return [...edges].sort(
    (a, b) =>
      (a.sort_order ?? 0) - (b.sort_order ?? 0) ||
      String(a.edge_id).localeCompare(String(b.edge_id)),
  )
}

function chunk(arr, size) {
  const out = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}

// ─── load + validate ─────────────────────────────────────────────────────────

/**
 * Loader validation: equally strict as salvage validateFlow + source_hash recompute,
 * control-char reject, exact canonical project identity, no page/FEAT endpoint fiction.
 * Does not require pre-sorted arrays (SQL emission sorts deterministically).
 */
export function validateFlowForLoad(flow, expectedProjectId) {
  const issues = []
  if (!flow || typeof flow !== 'object' || Array.isArray(flow)) {
    return {
      ok: false,
      issues: [{ code: 'not_object', message: 'flow is not an object' }],
    }
  }

  if (typeof flow.project_id !== 'string' || !flow.project_id) {
    issues.push({
      code: 'project_id',
      message: 'missing project_id',
      path: 'project_id',
    })
  } else {
    checkNoControl(flow.project_id, 'project_id', issues)
    if (flow.project_id.length > SCHEMA_WIDTH.project_id) {
      pushWidthIssue(
        issues,
        'project_id_width',
        'project_id',
        flow.project_id,
        SCHEMA_WIDTH.project_id,
        'project_id',
      )
    }
    const alias = resolveProjectAlias(flow.project_id)
    if (!alias) {
      issues.push({
        code: 'unknown_project',
        message: `unknown project_id: ${flow.project_id}`,
        path: 'project_id',
      })
    } else if (flow.project_id !== alias) {
      issues.push({
        code: 'project_alias_noncanonical',
        message: `project_id ${flow.project_id} must be canonical ${alias}`,
        path: 'project_id',
      })
    } else if (expectedProjectId && flow.project_id !== expectedProjectId) {
      issues.push({
        code: 'project_identity',
        message: `expected project_id ${expectedProjectId}, got ${flow.project_id}`,
        path: 'project_id',
      })
    }
  }

  checkNoControl(flow.source, 'source', issues)
  if (flow.generated_at != null) checkNoControl(flow.generated_at, 'generated_at', issues)

  if (!Array.isArray(flow.nodes)) {
    issues.push({ code: 'nodes', message: 'nodes must be an array', path: 'nodes' })
  }
  if (!Array.isArray(flow.edges)) {
    issues.push({ code: 'edges', message: 'edges must be an array', path: 'edges' })
  }
  if (!Array.isArray(flow.nodes) || !Array.isArray(flow.edges)) {
    // source_hash recompute needs arrays; surface structural errors first
    if (typeof flow.source_hash !== 'string' || !flow.source_hash) {
      issues.push({
        code: 'source_hash',
        message: 'missing source_hash (required nonempty 64-hex)',
        path: 'source_hash',
      })
    } else if (!HASH_RE.test(flow.source_hash)) {
      issues.push({
        code: 'source_hash',
        message: 'source_hash must be exact 64 lowercase hex',
        path: 'source_hash',
      })
    }
    return { ok: false, issues }
  }
  if (flow.nodes.length < 1) {
    issues.push({ code: 'min_nodes', message: 'nodes must be nonempty', path: 'nodes' })
  }

  if (typeof flow.source_hash !== 'string' || !flow.source_hash) {
    issues.push({
      code: 'source_hash',
      message: 'missing source_hash (required nonempty 64-hex)',
      path: 'source_hash',
    })
  } else if (!HASH_RE.test(flow.source_hash)) {
    issues.push({
      code: 'source_hash',
      message: 'source_hash must be exact 64 lowercase hex',
      path: 'source_hash',
    })
  } else {
    const recomputed = computeSourceHash(flow)
    if (recomputed !== flow.source_hash) {
      issues.push({
        code: 'source_hash_mismatch',
        message: `source_hash mismatch (file=${flow.source_hash.slice(0, 12)}… recomputed=${recomputed.slice(0, 12)}…)`,
        path: 'source_hash',
      })
    }
  }

  const nodeIds = new Set()
  for (let i = 0; i < flow.nodes.length; i++) {
    const n = flow.nodes[i]
    const p = `nodes[${i}]`
    if (!n || typeof n !== 'object' || Array.isArray(n)) {
      issues.push({ code: 'malformed', message: `malformed node at ${p}`, path: p })
      continue
    }
    if (typeof n.node_id !== 'string' || !n.node_id) {
      issues.push({ code: 'node_id', message: `invalid node_id at ${p}`, path: p })
      continue
    }
    if (n.node_id.length > SCHEMA_WIDTH.node_id) {
      pushWidthIssue(
        issues,
        'node_id_width',
        'node_id',
        n.node_id,
        SCHEMA_WIDTH.node_id,
        `${p}.node_id`,
      )
      continue
    }
    if (!NODE_ID_RE.test(n.node_id)) {
      issues.push({ code: 'node_id', message: `invalid node_id at ${p}`, path: p })
      continue
    }
    checkNoControl(n.node_id, `${p}.node_id`, issues)
    if (nodeIds.has(n.node_id)) {
      issues.push({
        code: 'duplicate_node',
        message: `duplicate node_id ${n.node_id}`,
        path: p,
      })
    }
    nodeIds.add(n.node_id)

    if (typeof n.label_id !== 'string' || !n.label_id) {
      issues.push({ code: 'label_id', message: 'missing label_id', path: p })
    } else {
      checkNoControl(n.label_id, `${p}.label_id`, issues)
      if (n.label_id.length > SCHEMA_WIDTH.label_id) {
        pushWidthIssue(
          issues,
          'label_id_width',
          'label_id',
          n.label_id,
          SCHEMA_WIDTH.label_id,
          `${p}.label_id`,
        )
      }
    }

    if (n.kind !== 'screen' && n.kind !== 'feature') {
      issues.push({
        code: 'kind',
        message: `invalid kind ${String(n?.kind)}`,
        path: p,
      })
    } else if (typeof n.kind === 'string' && n.kind.length > SCHEMA_WIDTH.kind) {
      pushWidthIssue(issues, 'kind_width', 'kind', n.kind, SCHEMA_WIDTH.kind, `${p}.kind`)
    }

    if (n.feature_id == null) {
      if (n.kind === 'feature') {
        issues.push({
          code: 'feature_soft_ref',
          message: 'kind=feature requires feature_id soft ref',
          path: p,
        })
      }
    } else if (typeof n.feature_id !== 'string' || !FEATURE_SOFT_RE.test(n.feature_id)) {
      issues.push({
        code: 'feature_soft_ref',
        message: `feature_id must be null or FEAT-* soft ref`,
        path: p,
      })
    } else {
      checkNoControl(n.feature_id, `${p}.feature_id`, issues)
      if (n.feature_id.length > SCHEMA_WIDTH.feature_id) {
        pushWidthIssue(
          issues,
          'feature_id_width',
          'feature_id',
          n.feature_id,
          SCHEMA_WIDTH.feature_id,
          `${p}.feature_id`,
        )
      }
    }

    checkMysqlInt(n.sort_order, 'sort_order', `${p}.sort_order`, issues)
    checkMysqlInt(n.layout_col, 'layout', `${p}.layout_col`, issues)
    checkMysqlInt(n.layout_row, 'layout', `${p}.layout_row`, issues)

    // source_ref: explicit value or default app-flow/<project>.json must fit VARCHAR(512)
    const effectiveSourceRef =
      n.source_ref != null && String(n.source_ref).length > 0
        ? String(n.source_ref)
        : `app-flow/${flow.project_id || expectedProjectId || 'unknown'}.json`
    if (n.source_ref != null) checkNoControl(n.source_ref, `${p}.source_ref`, issues)
    if (effectiveSourceRef.length > SCHEMA_WIDTH.source_ref) {
      pushWidthIssue(
        issues,
        'source_ref_width',
        'source_ref',
        effectiveSourceRef,
        SCHEMA_WIDTH.source_ref,
        `${p}.source_ref`,
      )
    }
    if (n.meta != null) checkNoControl(n.meta, `${p}.meta`, issues)
  }

  const edgeIds = new Set()
  const pairs = new Set()
  for (let i = 0; i < flow.edges.length; i++) {
    const e = flow.edges[i]
    const p = `edges[${i}]`
    if (!e || typeof e !== 'object' || Array.isArray(e)) {
      issues.push({ code: 'malformed', message: `malformed edge at ${p}`, path: p })
      continue
    }
    if (typeof e.edge_id !== 'string' || !e.edge_id) {
      issues.push({ code: 'edge_id', message: `invalid edge_id at ${p}`, path: p })
      continue
    }
    if (e.edge_id.length > SCHEMA_WIDTH.edge_id) {
      pushWidthIssue(
        issues,
        'edge_id_width',
        'edge_id',
        e.edge_id,
        SCHEMA_WIDTH.edge_id,
        `${p}.edge_id`,
      )
      continue
    }
    if (!EDGE_ID_RE.test(e.edge_id)) {
      issues.push({ code: 'edge_id', message: `invalid edge_id at ${p}`, path: p })
      continue
    }
    checkNoControl(e.edge_id, `${p}.edge_id`, issues)
    if (edgeIds.has(e.edge_id)) {
      issues.push({
        code: 'duplicate_edge_id',
        message: `duplicate edge_id ${e.edge_id}`,
        path: p,
      })
    }
    edgeIds.add(e.edge_id)

    if (typeof e.from_node !== 'string' || !e.from_node) {
      issues.push({ code: 'edge_from', message: 'missing from_node', path: p })
    } else {
      checkNoControl(e.from_node, `${p}.from_node`, issues)
      if (e.from_node.length > SCHEMA_WIDTH.from_node) {
        pushWidthIssue(
          issues,
          'from_node_width',
          'from_node',
          e.from_node,
          SCHEMA_WIDTH.from_node,
          `${p}.from_node`,
        )
      }
      if (!nodeIds.has(e.from_node)) {
        issues.push({
          code: 'dangling_endpoint',
          message: `from_node ${e.from_node} not in project node set`,
          path: p,
        })
      }
      // Reject page-id shaped endpoints that are not real graph nodes (already dangling)
      // and FEAT-* as edge endpoints (feature soft refs are not navigation endpoints).
      if (FEATURE_SOFT_RE.test(e.from_node)) {
        issues.push({
          code: 'feat_endpoint',
          message: `from_node must not be FEAT projection id ${e.from_node}`,
          path: p,
        })
      }
      if (PAGE_ID_HINT_RE.test(e.from_node) && !nodeIds.has(e.from_node)) {
        issues.push({
          code: 'page_id_endpoint',
          message: `from_node looks like page id ${e.from_node}`,
          path: p,
        })
      }
    }

    if (typeof e.to_node !== 'string' || !e.to_node) {
      issues.push({ code: 'edge_to', message: 'missing to_node', path: p })
    } else {
      checkNoControl(e.to_node, `${p}.to_node`, issues)
      if (e.to_node.length > SCHEMA_WIDTH.to_node) {
        pushWidthIssue(
          issues,
          'to_node_width',
          'to_node',
          e.to_node,
          SCHEMA_WIDTH.to_node,
          `${p}.to_node`,
        )
      }
      if (!nodeIds.has(e.to_node)) {
        issues.push({
          code: 'dangling_endpoint',
          message: `to_node ${e.to_node} not in project node set`,
          path: p,
        })
      }
      if (FEATURE_SOFT_RE.test(e.to_node)) {
        issues.push({
          code: 'feat_endpoint',
          message: `to_node must not be FEAT projection id ${e.to_node}`,
          path: p,
        })
      }
      if (PAGE_ID_HINT_RE.test(e.to_node) && !nodeIds.has(e.to_node)) {
        issues.push({
          code: 'page_id_endpoint',
          message: `to_node looks like page id ${e.to_node}`,
          path: p,
        })
      }
    }

    if (e.from_node && e.to_node && e.from_node === e.to_node) {
      issues.push({
        code: 'edge_self',
        message: `self-loop ${e.edge_id}`,
        path: p,
      })
    }

    if (typeof e.edge_kind !== 'string' || !e.edge_kind) {
      issues.push({ code: 'edge_kind', message: 'edge_kind required', path: p })
    } else {
      checkNoControl(e.edge_kind, `${p}.edge_kind`, issues)
      if (e.edge_kind.length > SCHEMA_WIDTH.edge_kind) {
        pushWidthIssue(
          issues,
          'edge_kind_width',
          'edge_kind',
          e.edge_kind,
          SCHEMA_WIDTH.edge_kind,
          `${p}.edge_kind`,
        )
      }
    }

    if (e.sort_order !== undefined && e.sort_order !== null) {
      checkMysqlInt(e.sort_order, 'sort_order', `${p}.sort_order`, issues)
    }

    const pk = `${e.from_node}\0${e.to_node}\0${e.edge_kind}`
    if (pairs.has(pk)) {
      issues.push({
        code: 'duplicate_edge',
        message: `duplicate edge ${e.from_node}→${e.to_node} (${e.edge_kind})`,
        path: p,
      })
    }
    pairs.add(pk)

    if (e.meta != null) checkNoControl(e.meta, `${p}.meta`, issues)
  }

  return { ok: issues.length === 0, issues }
}

/**
 * Load + validate all five canonical project files from dir.
 * Fail-closed: any missing file, identity mismatch, or validation issue aborts.
 */
export function loadAndValidateAll(dir) {
  const abs = path.resolve(dir)
  if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) {
    throw new Error(`input dir missing or not a directory: ${abs}`)
  }

  const flows = []
  const allIssues = []

  for (const projectId of PROJECTS) {
    const filePath = path.join(abs, `${projectId}.json`)
    if (!fs.existsSync(filePath)) {
      allIssues.push({
        project_id: projectId,
        code: 'missing_file',
        message: `missing ${projectId}.json`,
        path: filePath,
      })
      continue
    }
    let raw
    try {
      raw = JSON.parse(fs.readFileSync(filePath, 'utf8'))
    } catch (err) {
      allIssues.push({
        project_id: projectId,
        code: 'malformed',
        message: `JSON parse failed: ${err instanceof Error ? err.message : String(err)}`,
        path: filePath,
      })
      continue
    }
    const v = validateFlowForLoad(raw, projectId)
    if (!v.ok) {
      for (const issue of v.issues) {
        allIssues.push({ project_id: projectId, ...issue })
      }
      continue
    }
    flows.push({
      project_id: projectId,
      path: filePath,
      flow: raw,
      source_hash: raw.source_hash,
      nodes: raw.nodes.length,
      edges: raw.edges.length,
    })
  }

  // Reject extra non-canonical project files that look like app-flow graphs? Not required.
  // Reject if any of five failed.
  if (allIssues.length > 0 || flows.length !== PROJECTS.length) {
    return {
      ok: false,
      dir: abs,
      projects: flows,
      issues: allIssues,
      totals: {
        nodes: flows.reduce((s, f) => s + f.nodes, 0),
        edges: flows.reduce((s, f) => s + f.edges, 0),
      },
    }
  }

  return {
    ok: true,
    dir: abs,
    projects: flows,
    issues: [],
    totals: {
      nodes: flows.reduce((s, f) => s + f.nodes, 0),
      edges: flows.reduce((s, f) => s + f.edges, 0),
    },
  }
}

// ─── SQL generation ──────────────────────────────────────────────────────────

/**
 * Build meta_json for a node: preserve original meta + source_hash + provenance.
 * Does not mutate the input flow object.
 */
export function buildNodeMetaJson(node, sourceHash) {
  const base =
    node.meta && typeof node.meta === 'object' && !Array.isArray(node.meta)
      ? { ...node.meta }
      : node.meta == null
        ? {}
        : { value: node.meta }
  return {
    ...base,
    source_hash: sourceHash,
    provenance: 'app_flow_json',
  }
}

export function buildEdgeMetaJson(edge, sourceHash) {
  const base =
    edge.meta && typeof edge.meta === 'object' && !Array.isArray(edge.meta)
      ? { ...edge.meta }
      : edge.meta == null
        ? {}
        : { value: edge.meta }
  return {
    ...base,
    source_hash: sourceHash,
    provenance: 'app_flow_json',
  }
}

function nodeValueTuple(projectId, node, sourceHash) {
  const meta = buildNodeMetaJson(node, sourceHash)
  const sourceRef =
    node.source_ref != null && String(node.source_ref).length > 0
      ? String(node.source_ref)
      : `app-flow/${projectId}.json`
  return `(${sqlStr(projectId)}, ${sqlStr(node.node_id)}, ${
    node.feature_id == null ? 'NULL' : sqlStr(node.feature_id)
  }, ${sqlStr(node.label_id)}, ${sqlStr(node.kind)}, ${sqlInt(node.sort_order)}, ${sqlInt(
    node.layout_col,
  )}, ${sqlInt(node.layout_row)}, ${sqlStr(sourceRef)}, ${sqlJson(meta)})`
}

function edgeValueTuple(projectId, edge, sourceHash) {
  const meta = buildEdgeMetaJson(edge, sourceHash)
  const sortOrder = edge.sort_order ?? 0
  return `(${sqlStr(projectId)}, ${sqlStr(edge.edge_id)}, ${sqlStr(edge.from_node)}, ${sqlStr(
    edge.to_node,
  )}, ${sqlStr(edge.edge_kind)}, ${sqlInt(sortOrder)}, ${sqlJson(meta)})`
}

const NODE_COLS =
  'project_id, node_id, feature_id, label_id, kind, sort_order, layout_col, layout_row, source_ref, meta_json'
const NODE_UPSERT = `ON DUPLICATE KEY UPDATE feature_id=VALUES(feature_id), label_id=VALUES(label_id), kind=VALUES(kind), sort_order=VALUES(sort_order), layout_col=VALUES(layout_col), layout_row=VALUES(layout_row), source_ref=VALUES(source_ref), meta_json=VALUES(meta_json)`

const EDGE_COLS =
  'project_id, edge_id, from_node, to_node, edge_kind, sort_order, meta_json'
const EDGE_UPSERT = `ON DUPLICATE KEY UPDATE from_node=VALUES(from_node), to_node=VALUES(to_node), edge_kind=VALUES(edge_kind), sort_order=VALUES(sort_order), meta_json=VALUES(meta_json)`

/**
 * Generate deterministic all-five SQL bundle. Pure function of validated projects + options.
 * generatedAt is validated BEFORE any header interpolation (F1 hardening).
 */
export function generateBundleSql(validated, options = {}) {
  if (!validated?.ok) {
    throw new Error('generateBundleSql requires validated.ok === true')
  }
  const batchSize = options.batchSize ?? DEFAULT_BATCH
  // Validate pin/env/default BEFORE SQL generation — reject newline/comment breakout.
  const generatedAt = resolveGeneratedAt(options.generatedAt)

  const lines = []
  lines.push('-- upload-app-flow.sql — migration-011 app_flow_nodes / app_flow_edges UPSERT bundle')
  lines.push(`-- generated_at: ${generatedAt}`)
  lines.push(
    `-- totals: nodes=${validated.totals.nodes} edges=${validated.totals.edges} projects=${PROJECTS.join(',')}`,
  )
  lines.push('-- SAFE: additive UPSERT only; no prune; never touches page_nav / API / CP tables')
  lines.push('-- source_hash per project (extractor-compatible, excludes generated_at):')
  for (const p of validated.projects) {
    lines.push(
      `--   ${p.project_id}: nodes=${p.nodes} edges=${p.edges} source_hash=${p.source_hash}`,
    )
  }
  lines.push('SET NAMES utf8mb4;')
  lines.push('SET SESSION sql_mode = CONCAT(@@sql_mode, \',STRICT_TRANS_TABLES\');')
  lines.push('START TRANSACTION;')
  lines.push('')

  // Nodes first (all projects, stable project order), then edges.
  lines.push('-- app_flow_nodes (UPSERT; PK project_id+node_id)')
  for (const p of validated.projects) {
    const nodes = sortNodes(p.flow.nodes)
    const batches = chunk(nodes, batchSize)
    for (const batch of batches) {
      const values = batch
        .map((n) => nodeValueTuple(p.project_id, n, p.source_hash))
        .join(',\n  ')
      lines.push(
        `INSERT INTO app_flow_nodes (${NODE_COLS}) VALUES\n  ${values}\n${NODE_UPSERT};`,
      )
    }
  }

  lines.push('')
  lines.push('-- app_flow_edges (UPSERT; PK project_id+edge_id); after nodes for endpoint integrity')
  for (const p of validated.projects) {
    const edges = sortEdges(p.flow.edges)
    if (edges.length === 0) continue
    const batches = chunk(edges, batchSize)
    for (const batch of batches) {
      const values = batch
        .map((e) => edgeValueTuple(p.project_id, e, p.source_hash))
        .join(',\n  ')
      lines.push(
        `INSERT INTO app_flow_edges (${EDGE_COLS}) VALUES\n  ${values}\n${EDGE_UPSERT};`,
      )
    }
  }

  lines.push('')
  lines.push('COMMIT;')
  return lines.join('\n') + '\n'
}

/**
 * Atomic write: temp sibling → rename.
 */
export function writeAtomic(outPath, content) {
  const abs = path.resolve(outPath)
  const dir = path.dirname(abs)
  fs.mkdirSync(dir, { recursive: true })
  const tmp = path.join(
    dir,
    `.${path.basename(abs)}.${process.pid}.${Date.now()}.tmp`,
  )
  try {
    fs.writeFileSync(tmp, content, { encoding: 'utf8', mode: 0o644 })
    fs.renameSync(tmp, abs)
  } catch (err) {
    try {
      fs.unlinkSync(tmp)
    } catch {
      /* ignore */
    }
    throw err
  }
  return abs
}

// ─── static safety scan of generated SQL (statement allowlist) ───────────────

const NODE_COLS_BODY =
  'project_id, node_id, feature_id, label_id, kind, sort_order, layout_col, layout_row, source_ref, meta_json'
const EDGE_COLS_BODY =
  'project_id, edge_id, from_node, to_node, edge_kind, sort_order, meta_json'

/** Strip `--` line comments so safety scans do not false-positive on headers. */
function stripSqlLineComments(sql) {
  return String(sql)
    .split('\n')
    .map((line) => {
      // Safe line-comment strip: only `--` that is not inside X'hex' / 'string'
      // Headers are pure comment lines; generated body never places `--` in hex.
      const idx = line.indexOf('--')
      return idx >= 0 ? line.slice(0, idx) : line
    })
    .join('\n')
}

/**
 * Split SQL body into statements on `;` without treating hex-encoded `3b` or
 * quoted string contents as terminators. Hex literals only contain [0-9a-fA-F],
 * so a literal `;` character never appears inside X'…'; still skip them correctly.
 */
export function splitSqlStatements(sqlBody) {
  const s = String(sqlBody)
  const stmts = []
  let cur = ''
  let i = 0
  while (i < s.length) {
    const c = s[i]
    // Hex literal: X'…' or x'…'
    if ((c === 'X' || c === 'x') && s[i + 1] === "'") {
      cur += c + "'"
      i += 2
      while (i < s.length && s[i] !== "'") {
        cur += s[i]
        i++
      }
      if (i < s.length) {
        cur += s[i]
        i++
      }
      continue
    }
    // Single-quoted string (e.g. SET SESSION sql_mode CONCAT arg)
    if (c === "'") {
      cur += c
      i++
      while (i < s.length) {
        if (s[i] === "'" && s[i + 1] === "'") {
          cur += "''"
          i += 2
          continue
        }
        if (s[i] === "'") {
          cur += s[i]
          i++
          break
        }
        cur += s[i]
        i++
      }
      continue
    }
    if (c === ';') {
      const t = cur.trim()
      if (t) stmts.push(t)
      cur = ''
      i++
      continue
    }
    cur += c
    i++
  }
  const tail = cur.trim()
  if (tail) stmts.push(tail)
  return stmts
}

function normalizeWs(stmt) {
  return stmt.replace(/\s+/g, ' ').trim()
}

/**
 * Statement/DML allowlist appropriate to the generated bundle (not a denylist).
 * After stripping line comments, only permit:
 *   SET NAMES utf8mb4
 *   SET SESSION sql_mode = CONCAT(@@sql_mode, ',STRICT_TRANS_TABLES')
 *   START TRANSACTION
 *   INSERT INTO app_flow_nodes (…) VALUES … ON DUPLICATE KEY UPDATE …
 *   INSERT INTO app_flow_edges (…) VALUES … ON DUPLICATE KEY UPDATE …
 *   COMMIT
 * Rejects UPDATE/DELETE/TRUNCATE/DROP/REPLACE/LOAD/ALTER/CREATE/CALL/DO/SELECT/USE
 * and INSERT into any other table (including header breakout).
 */
export function assertBundleSafety(sql) {
  const body = stripSqlLineComments(sql)
  const statements = splitSqlStatements(body)
  if (statements.length === 0) {
    throw new Error('bundle safety: no SQL statements after comment strip')
  }

  let sawStart = false
  let sawCommit = false
  let sawNodeInsert = false
  let sawEdgeInsert = false
  let commitIndex = -1
  let firstNodeIndex = -1
  let firstEdgeIndex = -1

  for (let si = 0; si < statements.length; si++) {
    const raw = statements[si]
    const stmt = normalizeWs(raw)
    const upper = stmt.toUpperCase()

    // SET NAMES utf8mb4
    if (/^SET\s+NAMES\s+utf8mb4$/i.test(stmt)) {
      continue
    }

    // SET SESSION sql_mode = CONCAT(@@sql_mode, ',STRICT_TRANS_TABLES')
    if (
      /^SET\s+SESSION\s+sql_mode\s*=\s*CONCAT\s*\(\s*@@sql_mode\s*,\s*',STRICT_TRANS_TABLES'\s*\)$/i.test(
        stmt,
      )
    ) {
      continue
    }

    if (/^START\s+TRANSACTION$/i.test(stmt)) {
      if (sawStart) throw new Error('bundle safety: multiple START TRANSACTION')
      sawStart = true
      continue
    }

    if (/^COMMIT$/i.test(stmt)) {
      if (sawCommit) throw new Error('bundle safety: multiple COMMIT')
      sawCommit = true
      commitIndex = si
      continue
    }

    // INSERT INTO app_flow_nodes … ON DUPLICATE KEY UPDATE …
    if (/^INSERT\s+INTO\s+app_flow_nodes\b/i.test(stmt)) {
      if (!/\bON\s+DUPLICATE\s+KEY\s+UPDATE\b/i.test(stmt)) {
        throw new Error('bundle safety: app_flow_nodes INSERT missing ON DUPLICATE KEY UPDATE')
      }
      // Exact column list (order) after normalize
      const colsMatch = stmt.match(
        /^INSERT\s+INTO\s+app_flow_nodes\s*\(([^)]+)\)\s*VALUES\b/i,
      )
      if (!colsMatch) {
        throw new Error('bundle safety: app_flow_nodes INSERT column list malformed')
      }
      const cols = colsMatch[1].replace(/\s+/g, ' ').trim().toLowerCase()
      if (cols !== NODE_COLS_BODY) {
        throw new Error('bundle safety: app_flow_nodes column list mismatch')
      }
      if (!/\bVALUES\b/i.test(stmt)) {
        throw new Error('bundle safety: app_flow_nodes INSERT missing VALUES')
      }
      // Reject if statement smuggles other DML keywords as top-level (allowlist only)
      if (
        /\b(UPDATE|DELETE|TRUNCATE|DROP|REPLACE|LOAD|ALTER|CREATE|CALL|DO|SELECT|USE)\b/i.test(
          upper.replace(/\bON\s+DUPLICATE\s+KEY\s+UPDATE\b/gi, ' '),
        )
      ) {
        // ON DUPLICATE KEY UPDATE is allowed; strip that phrase then re-check
        const withoutUpsert = upper.replace(/\bON\s+DUPLICATE\s+KEY\s+UPDATE\b/gi, ' ')
        if (
          /\b(UPDATE|DELETE|TRUNCATE|DROP|REPLACE|LOAD|ALTER|CREATE|CALL|DO|SELECT|USE)\b/.test(
            withoutUpsert,
          )
        ) {
          throw new Error('bundle safety: disallowed keyword in app_flow_nodes INSERT')
        }
      }
      sawNodeInsert = true
      if (firstNodeIndex < 0) firstNodeIndex = si
      continue
    }

    // INSERT INTO app_flow_edges … ON DUPLICATE KEY UPDATE …
    if (/^INSERT\s+INTO\s+app_flow_edges\b/i.test(stmt)) {
      if (!/\bON\s+DUPLICATE\s+KEY\s+UPDATE\b/i.test(stmt)) {
        throw new Error('bundle safety: app_flow_edges INSERT missing ON DUPLICATE KEY UPDATE')
      }
      const colsMatch = stmt.match(
        /^INSERT\s+INTO\s+app_flow_edges\s*\(([^)]+)\)\s*VALUES\b/i,
      )
      if (!colsMatch) {
        throw new Error('bundle safety: app_flow_edges INSERT column list malformed')
      }
      const cols = colsMatch[1].replace(/\s+/g, ' ').trim().toLowerCase()
      if (cols !== EDGE_COLS_BODY) {
        throw new Error('bundle safety: app_flow_edges column list mismatch')
      }
      const withoutUpsert = upper.replace(/\bON\s+DUPLICATE\s+KEY\s+UPDATE\b/gi, ' ')
      if (
        /\b(UPDATE|DELETE|TRUNCATE|DROP|REPLACE|LOAD|ALTER|CREATE|CALL|DO|SELECT|USE)\b/.test(
          withoutUpsert,
        )
      ) {
        throw new Error('bundle safety: disallowed keyword in app_flow_edges INSERT')
      }
      sawEdgeInsert = true
      if (firstEdgeIndex < 0) firstEdgeIndex = si
      continue
    }

    // Anything else is rejected (allowlist, not denylist)
    // Surface common breakouts with a clear prefix
    if (/^UPDATE\b/i.test(stmt)) {
      throw new Error('bundle safety: disallowed statement UPDATE (not on allowlist)')
    }
    if (/^DELETE\b/i.test(stmt)) {
      throw new Error('bundle safety: disallowed statement DELETE (not on allowlist)')
    }
    if (/^TRUNCATE\b/i.test(stmt)) {
      throw new Error('bundle safety: disallowed statement TRUNCATE (not on allowlist)')
    }
    if (/^DROP\b/i.test(stmt)) {
      throw new Error('bundle safety: disallowed statement DROP (not on allowlist)')
    }
    if (/^REPLACE\b/i.test(stmt)) {
      throw new Error('bundle safety: disallowed statement REPLACE (not on allowlist)')
    }
    if (/^LOAD\b/i.test(stmt)) {
      throw new Error('bundle safety: disallowed statement LOAD (not on allowlist)')
    }
    if (/^ALTER\b/i.test(stmt)) {
      throw new Error('bundle safety: disallowed statement ALTER (not on allowlist)')
    }
    if (/^CREATE\b/i.test(stmt)) {
      throw new Error('bundle safety: disallowed statement CREATE (not on allowlist)')
    }
    if (/^CALL\b/i.test(stmt)) {
      throw new Error('bundle safety: disallowed statement CALL (not on allowlist)')
    }
    if (/^DO\b/i.test(stmt)) {
      throw new Error('bundle safety: disallowed statement DO (not on allowlist)')
    }
    if (/^SELECT\b/i.test(stmt)) {
      throw new Error('bundle safety: disallowed statement SELECT (not on allowlist)')
    }
    if (/^USE\b/i.test(stmt)) {
      throw new Error('bundle safety: disallowed statement USE (not on allowlist)')
    }
    if (/^INSERT\s+INTO\b/i.test(stmt)) {
      const m = stmt.match(/^INSERT\s+INTO\s+([`"]?)([A-Za-z0-9_]+)\1/i)
      const table = m ? m[2] : '?'
      throw new Error(
        `bundle safety: INSERT into non-allowlisted table ${table}`,
      )
    }
    throw new Error(
      `bundle safety: statement not on allowlist: ${stmt.slice(0, 80)}`,
    )
  }

  if (!sawStart || !sawCommit) {
    throw new Error('bundle safety: missing START TRANSACTION / COMMIT')
  }
  if (!sawNodeInsert) {
    throw new Error('bundle safety: missing app_flow_nodes INSERT')
  }
  // edges may be empty for all projects (theoretical); still require nodes-before-edges if present
  if (sawEdgeInsert && firstEdgeIndex < firstNodeIndex) {
    throw new Error('bundle safety: edges before nodes')
  }
  if (commitIndex >= 0 && firstNodeIndex >= 0 && commitIndex < firstNodeIndex) {
    throw new Error('bundle safety: COMMIT before node INSERT')
  }
  if (commitIndex >= 0 && firstEdgeIndex >= 0 && commitIndex < firstEdgeIndex) {
    throw new Error('bundle safety: COMMIT before edge INSERT')
  }
  // COMMIT must be last statement
  if (commitIndex !== statements.length - 1) {
    throw new Error('bundle safety: COMMIT must be the final statement')
  }

  return true
}

// ─── main ────────────────────────────────────────────────────────────────────

export function buildSummary(validated, extra = {}) {
  return {
    ok: validated.ok,
    mode: extra.mode || 'validate',
    dir: validated.dir,
    projects: validated.projects.map((p) => ({
      project_id: p.project_id,
      nodes: p.nodes,
      edges: p.edges,
      source_hash: p.source_hash,
    })),
    totals: validated.totals,
    issues: validated.issues,
    ...extra,
  }
}

export function main(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv)
  if (opts.help) {
    printHelp()
    return { ok: true, help: true }
  }
  if (opts.db) {
    throw new Error(
      'REFUSED: --db is not available in R1 (offline SQL bundle only). Use --bundle --out <path>.',
    )
  }
  if (opts.bundle && !opts.out) {
    throw new Error('--bundle requires --out <path>')
  }

  const validated = loadAndValidateAll(opts.dir)
  if (!validated.ok) {
    const summary = buildSummary(validated, { mode: opts.bundle ? 'bundle' : 'validate' })
    console.error(JSON.stringify(summary, null, 2))
    throw new Error(
      `validation failed: ${validated.issues.length} issue(s); no SQL written`,
    )
  }

  if (!opts.bundle) {
    const summary = buildSummary(validated, {
      mode: 'validate',
      wrote: false,
      note: 'dry summary only; pass --bundle --out <path> to emit SQL',
    })
    console.log(JSON.stringify(summary, null, 2))
    console.log('\n--- count node/edge per project ---')
    for (const p of validated.projects) {
      console.log(
        `${p.project_id.padEnd(12)} nodes=${String(p.nodes).padStart(4)} edges=${String(p.edges).padStart(4)} hash=${p.source_hash.slice(0, 12)}`,
      )
    }
    console.log(
      `TOTAL        nodes=${String(validated.totals.nodes).padStart(4)} edges=${String(validated.totals.edges).padStart(4)}`,
    )
    return summary
  }

  // Resolve + validate generatedAt before SQL generation / any write (F1).
  const generatedAt = resolveGeneratedAt(opts.generatedAt)
  const sql = generateBundleSql(validated, {
    generatedAt,
    batchSize: opts.batchSize,
  })
  assertBundleSafety(sql)
  const outAbs = writeAtomic(opts.out, sql)
  const summary = buildSummary(validated, {
    mode: 'bundle',
    wrote: true,
    out: outAbs,
    bytes: Buffer.byteLength(sql, 'utf8'),
    generated_at: generatedAt,
    batch_size: opts.batchSize,
  })
  console.log(JSON.stringify(summary, null, 2))
  return summary
}

const isMain =
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url

if (isMain) {
  try {
    main()
  } catch (err) {
    console.error(
      JSON.stringify({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      }),
    )
    process.exit(1)
  }
}
