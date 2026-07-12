// Unit tests for the server-only board store (src/server/board-store.ts).
// Multi-board layout: each board is a scope under data/boards/<id>/ (plan/runs/
// design/collab), with global data/conventions.json + data/boards.json.
// Strategy: build a throwaway temp CAIRN_DATA_DIR that mirrors the repo layout,
// copy the real ibils board + globals into it, then import the store fresh so
// every read/write hits the temp copy — never the real repo SSOT. Removed after.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import type { RawBoard, RawFeature } from '#/lib/types'

type Store = typeof import('#/server/board-store')

// vitest runs from the project root; the real SSOT lives in ./data.
const repoData = path.resolve(process.cwd(), 'data')
const repoIbils = path.join(repoData, 'boards', 'ibils')

let tmpDir: string
let store: Store
let sampleFeatureId: string
const sampleTaskIndex = 0

beforeAll(async () => {
  // 1. Build an isolated temp data root mirroring the multi-board layout:
  //    <tmp>/boards/ibils/{plan,runs,design,collab}.json + <tmp>/{conventions,boards}.json
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'board-store-test-'))
  const tmpIbils = path.join(tmpDir, 'boards', 'ibils')
  fs.mkdirSync(tmpIbils, { recursive: true })
  for (const file of ['plan.json', 'runs.json', 'design.json', 'collab.json']) {
    fs.copyFileSync(path.join(repoIbils, file), path.join(tmpIbils, file))
  }
  for (const file of ['conventions.json', 'boards.json']) {
    fs.copyFileSync(path.join(repoData, file), path.join(tmpDir, file))
  }

  // 2. Point the store at the temp copy BEFORE importing it.
  process.env.CAIRN_DATA_DIR = tmpDir

  // 3. Import the store fresh so it resolves against the configured dir.
  store = await import('#/server/board-store')

  // Locate a feature that actually has a checklist to toggle.
  const board = store.readBoard('ibils')
  const feat = board.features.find(
    (f): f is RawFeature => Array.isArray(f.checklist) && f.checklist.length > 0,
  )
  if (!feat) throw new Error('fixture has no feature with a checklist')
  sampleFeatureId = feat.id
})

afterAll(() => {
  delete process.env.CAIRN_DATA_DIR
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true })
})

const planPath = () => path.join(tmpDir, 'boards', 'ibils', 'plan.json')
const runsPath = () => path.join(tmpDir, 'boards', 'ibils', 'runs.json')

describe('board-store — multi-board', () => {
  it("readBoard('ibils') merges plan + runs + overlays into one raw board", () => {
    const board: RawBoard = store.readBoard('ibils')
    // plan side
    expect(Array.isArray(board.features)).toBe(true)
    expect(board.features.length).toBeGreaterThan(0)
    // runs side (comes from runs.json, not plan.json)
    expect(Array.isArray(board.runs)).toBe(true)
    expect(board.runs!.length).toBeGreaterThan(0)
    // overlays folded in from design.json / collab.json
    expect(board.design).toBeDefined()
    expect(board.design!.features).toBeDefined()
    expect(board.collab).toBeDefined()
    expect(Array.isArray(board.collab!.activity)).toBe(true)
    // conventions come from the global data/conventions.json
    expect(board.conventions).toBeDefined()
    // the merged board must not have inherited a `runs` array from the plan file
    const plan = JSON.parse(fs.readFileSync(planPath(), 'utf8'))
    expect(plan.runs).toBeUndefined()
  })

  it("toggleTask('ibils', ...) flips done and persists it to disk", () => {
    const before = store.readBoard('ibils')
    const featBefore = before.features.find((f) => f.id === sampleFeatureId)!
    const original = featBefore.checklist![sampleTaskIndex].done ?? false

    // toggle once
    const afterBoard = store.toggleTask('ibils', sampleFeatureId, sampleTaskIndex)
    const featAfter = afterBoard.features.find((f) => f.id === sampleFeatureId)!
    expect(featAfter.checklist![sampleTaskIndex].done).toBe(!original)

    // persisted: a completely fresh read reflects the flip
    const reread = store.readBoard('ibils')
    const featReread = reread.features.find((f) => f.id === sampleFeatureId)!
    expect(featReread.checklist![sampleTaskIndex].done).toBe(!original)

    // and it is genuinely on disk (not just in memory)
    const onDisk = JSON.parse(fs.readFileSync(planPath(), 'utf8'))
    const featDisk = onDisk.features.find((f: RawFeature) => f.id === sampleFeatureId)
    expect(featDisk.checklist[sampleTaskIndex].done).toBe(!original)

    // toggle back to restore
    const restored = store.toggleTask('ibils', sampleFeatureId, sampleTaskIndex)
    const featRestored = restored.features.find((f) => f.id === sampleFeatureId)!
    expect(featRestored.checklist![sampleTaskIndex].done).toBe(original)
  })

  it("upsertRun('ibils', ...) adds a new run", () => {
    const id = 'run-unit-test-fixture'
    const before = store.readBoard('ibils')
    expect(before.runs!.find((r) => r.id === id)).toBeUndefined()

    const board = store.upsertRun('ibils', {
      id,
      agent: 'unit-tester',
      task: 'verify upsertRun adds a run',
    })
    const added = board.runs!.find((r) => r.id === id)
    expect(added).toBeDefined()
    expect(added!.agent).toBe('unit-tester')
    // defaults applied by the store for a brand-new run
    expect(added!.status).toBe('running')

    // persisted to disk
    const onDisk = JSON.parse(fs.readFileSync(runsPath(), 'utf8'))
    expect(onDisk.runs.find((r: { id: string }) => r.id === id)).toBeDefined()
  })

  it("setRunStatus('ibils', ...) changes an existing run status", () => {
    const id = 'run-unit-test-fixture'
    // seeded by the previous test as 'running'
    const board = store.setRunStatus('ibils', id, 'done')
    const run = board.runs!.find((r) => r.id === id)
    expect(run).toBeDefined()
    expect(run!.status).toBe('done')

    // persisted
    const reread = store.readBoard('ibils')
    expect(reread.runs!.find((r) => r.id === id)!.status).toBe('done')
  })

  it("addComment('ibils', ...) persists a comment onto the feature", () => {
    const board = store.addComment('ibils', sampleFeatureId, 'me', 'human', 'hi')
    const comments = board.collab!.comments[sampleFeatureId] ?? []
    const mine = comments.find((c) => c.text === 'hi' && c.author === 'me')
    expect(mine).toBeDefined()
    expect(mine!.authorType).toBe('human')
    // the comment also lands on the activity feed
    expect(board.collab!.activity.some((a) => a.kind === 'comment' && a.text === 'hi')).toBe(true)

    // persisted: a fresh read still has it
    const reread = store.readBoard('ibils')
    expect((reread.collab!.comments[sampleFeatureId] ?? []).some((c) => c.text === 'hi')).toBe(true)
  })

  it('openDecision blocks the feature + creates an open decision, decideDecision clears the block', () => {
    // pick a feature that is not already blocked so the assertions are unambiguous
    const start = store.readBoard('ibils')
    const target = start.features.find((f) => !f.blocked)!
    expect(target).toBeDefined()

    const openedBoard = store.openDecision('ibils', target.id, 'Q?', [{ key: 'a', label: 'A' }])
    // feature is now blocked
    const featBlocked = openedBoard.features.find((f) => f.id === target.id)!
    expect(featBlocked.blocked).toBeTruthy()
    // a matching open decision exists for this feature
    const dec = (openedBoard.decisions ?? []).find(
      (d) => d.featureId === target.id && d.status === 'open',
    )
    expect(dec).toBeDefined()
    expect(dec!.teks).toBe('Q?')

    // decide it -> block clears
    const decidedBoard = store.decideDecision('ibils', dec!.id, 'a')
    const decided = (decidedBoard.decisions ?? []).find((d) => d.id === dec!.id)!
    expect(decided.status).toBe('decided')
    expect(decided.jawaban).toBe('a')
    const featCleared = decidedBoard.features.find((f) => f.id === target.id)!
    expect(featCleared.blocked).toBeFalsy()
  })

  it('listBoards() returns the ibils board', () => {
    const boards = store.listBoards()
    expect(boards.some((b) => b.id === 'ibils')).toBe(true)
  })

  it('createBoard() then boardExists() reflects the new board', () => {
    expect(store.boardExists('temp-b')).toBe(false)
    const boards = store.createBoard('temp-b', 'Temp')
    expect(boards.some((b) => b.id === 'temp-b')).toBe(true)
    expect(store.boardExists('temp-b')).toBe(true)
    // it also shows up via listBoards / index re-read
    expect(store.listBoards().some((b) => b.id === 'temp-b')).toBe(true)
  })
})
