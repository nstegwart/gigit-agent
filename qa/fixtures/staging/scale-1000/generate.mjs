#!/usr/bin/env node
/**
 * Deterministic scale fixture generator (AC-PERF-01).
 *
 * Counts (fixed):
 *   1000 tasks / 200 runs / 20 accounts / 100 decisions
 *
 * Synthetic only — no production-derived fields, no secrets.
 *
 * Usage (repo root):
 *   node qa/fixtures/staging/scale-1000/generate.mjs
 *   node qa/fixtures/staging/scale-1000/generate.mjs --out /tmp/scale-1000
 *
 * Env:
 *   SCALE_OUT — output directory (default: this directory)
 *   BOARD_ID  — default mfs-rebuild-scale
 */
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export const SCALE_COUNTS = Object.freeze({
  tasks: 1000,
  runs: 200,
  accounts: 20,
  decisions: 100,
})

const BUCKETS = ['DONE', 'ONGOING', 'NEXT', 'QUEUED', 'BLOCKED', 'RECON', 'STALE']

function argValue(name) {
  const i = process.argv.indexOf(name)
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1]
  return null
}

function pad(n, w = 4) {
  return String(n).padStart(w, '0')
}

function sha256Hex(s) {
  return createHash('sha256').update(s, 'utf8').digest('hex')
}

export function generateScaleFixture(opts = {}) {
  const boardId = opts.boardId || process.env.BOARD_ID || 'mfs-rebuild-scale'
  const now = opts.nowIso || '2026-07-14T00:00:00.000Z'
  const counts = { ...SCALE_COUNTS, ...(opts.counts || {}) }

  const tasks = []
  for (let i = 1; i <= counts.tasks; i++) {
    const bucket = BUCKETS[(i - 1) % BUCKETS.length]
    tasks.push({
      id: `scale-task-${pad(i)}`,
      boardId,
      title: `SYNTH scale task ${i}`,
      bucket,
      readinessPercent: (i * 7) % 101,
      synthetic: true,
    })
  }

  const runs = []
  for (let i = 1; i <= counts.runs; i++) {
    const task = tasks[(i - 1) % tasks.length]
    runs.push({
      id: `scale-run-${pad(i)}`,
      boardId,
      taskId: task.id,
      status: i % 5 === 0 ? 'done' : i % 3 === 0 ? 'stalled' : 'running',
      agentId: `scale-agent-${pad(((i - 1) % 10) + 1, 2)}`,
      synthetic: true,
    })
  }

  const accounts = []
  for (let i = 1; i <= counts.accounts; i++) {
    accounts.push({
      id: `scale-acct-${pad(i, 2)}`,
      boardId,
      // Masked identity only — never raw emails/tokens
      accountIdMasked: `acct_****${pad(i, 2)}`,
      accountRefMasked: `ref_****${pad(i, 2)}`,
      status: i % 4 === 0 ? 'STALE' : 'ACTIVE',
      synthetic: true,
    })
  }

  const decisions = []
  for (let i = 1; i <= counts.decisions; i++) {
    decisions.push({
      id: `scale-dec-${pad(i, 3)}`,
      boardId,
      status: i % 3 === 0 ? 'resolved' : 'open',
      // Public-safe title only — no private decision body
      title: `SYNTH scale decision ${i}`,
      synthetic: true,
    })
  }

  const taskIds = tasks.map((t) => t.id).sort()
  const taskHash = sha256Hex(taskIds.join('\n'))

  const manifest = {
    fixtureId: 'staging-scale-1000-v1',
    version: 1,
    purpose: 'Deterministic AC-PERF-01 scale fixture (synthetic only)',
    syntheticOnly: true,
    productionDerived: false,
    boardId,
    generatedAt: now,
    counts: {
      tasks: tasks.length,
      runs: runs.length,
      accounts: accounts.length,
      decisions: decisions.length,
    },
    expected: { ...SCALE_COUNTS },
    pin: {
      canonicalSnapshotId: `scale-snap-${taskHash.slice(0, 16)}`,
      canonicalHash: taskHash,
      taskHash,
      boardRev: 1,
      lifecycleRev: 1,
    },
    residualGaps: [
      'fixture files only — not loaded into DB unless an explicit seeder consumes them',
      'does not claim live p95 / 20rps proof by itself',
    ],
  }

  return { manifest, tasks, runs, accounts, decisions, taskHash }
}

export function writeScaleFixture(outDir, fixture = generateScaleFixture()) {
  fs.mkdirSync(outDir, { recursive: true })
  const writeJsonl = (name, rows) => {
    const p = path.join(outDir, name)
    fs.writeFileSync(p, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8')
    return p
  }
  const paths = {
    manifest: path.join(outDir, 'manifest.json'),
    tasks: writeJsonl('tasks.jsonl', fixture.tasks),
    runs: writeJsonl('runs.jsonl', fixture.runs),
    accounts: writeJsonl('accounts.jsonl', fixture.accounts),
    decisions: writeJsonl('decisions.jsonl', fixture.decisions),
  }
  fs.writeFileSync(paths.manifest, JSON.stringify(fixture.manifest, null, 2) + '\n', 'utf8')
  return { ok: true, outDir, paths, counts: fixture.manifest.counts, taskHash: fixture.taskHash }
}

function main() {
  const out =
    argValue('--out') ||
    process.env.SCALE_OUT?.trim() ||
    __dirname
  const fixture = generateScaleFixture()
  const written = writeScaleFixture(out, fixture)
  const ok =
    written.counts.tasks === SCALE_COUNTS.tasks &&
    written.counts.runs === SCALE_COUNTS.runs &&
    written.counts.accounts === SCALE_COUNTS.accounts &&
    written.counts.decisions === SCALE_COUNTS.decisions
  console.log(
    JSON.stringify(
      {
        ok,
        outDir: written.outDir,
        counts: written.counts,
        expected: SCALE_COUNTS,
        taskHash: written.taskHash,
        paths: written.paths,
      },
      null,
      2,
    ),
  )
  process.exit(ok ? 0 : 1)
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
if (isMain) main()
