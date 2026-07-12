// Unit tests for the adaptive-view readers on the server-only board store
// (src/server/board-store.ts): readTasks / readOps / readProd / readGuide and
// the toggleCheckpoint write path — the data spine behind Batch 5's
// Tasks · Ops · Prod · Guide views for the "mfs-rebuild" board.
//
// Strategy (same as board-store.test.ts): copy the real data root into a
// throwaway temp dir, point CAIRN_DATA_DIR at it BEFORE importing the store
// fresh, so every read/write hits the temp copy and never the repo SSOT.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import type { GuideData, OpsData, ProdData, TasksFile } from '#/lib/types'

type Store = typeof import('#/server/board-store')

const BOARD = 'mfs-rebuild'
const repoData = path.resolve(process.cwd(), 'data')

let tmpDir: string
let store: Store

const tasksPath = () => path.join(tmpDir, 'boards', BOARD, 'tasks.json')

beforeAll(async () => {
  // 1. Isolated temp data root — a full recursive copy of the repo's ./data
  //    (mirrors <tmp>/boards/<id>/*.json + <tmp>/{conventions,boards}.json).
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'views-store-test-'))
  fs.cpSync(repoData, tmpDir, { recursive: true })

  // 2. Point the store at the temp copy BEFORE importing it.
  process.env.CAIRN_DATA_DIR = tmpDir

  // 3. Import the store fresh so it resolves against the configured dir.
  store = await import('#/server/board-store')
})

afterAll(() => {
  delete process.env.CAIRN_DATA_DIR
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('board-store — adaptive views (mfs-rebuild)', () => {
  it('readTasks returns the full task list', () => {
    const t: TasksFile = store.readTasks(BOARD)
    expect(Array.isArray(t.tasks)).toBe(true)
    expect(t.tasks.length).toBe(44)
  })

  it('readOps returns the account pool + vault summary', () => {
    const ops: OpsData = store.readOps(BOARD)
    expect(Array.isArray(ops.accounts)).toBe(true)
    expect(ops.accounts.length).toBe(21)
    expect(ops.vault.usableCount).toBe(7)
  })

  it('readProd returns the production gates', () => {
    const prod: ProdData = store.readProd(BOARD)
    expect(Array.isArray(prod.gates)).toBe(true)
    expect(prod.gates.length).toBe(7)
  })

  it('readGuide returns guide sections', () => {
    const guide: GuideData = store.readGuide(BOARD)
    expect(Array.isArray(guide.sections)).toBe(true)
    expect(guide.sections.length).toBeGreaterThan(0)
  })

  it('toggleCheckpoint flips a checkpoint and persists to disk', () => {
    const taskId = 'T-AFF-INTEGRATION-E2E'
    const checkpointId = 'exec-product'

    const before = store
      .readTasks(BOARD)
      .tasks.find((t) => t.id === taskId)!
      .checkpoints.find((c) => c.id === checkpointId)!.done

    // Toggle: returned file reflects the flip.
    const flipped = store
      .toggleCheckpoint(BOARD, taskId, checkpointId)
      .tasks.find((t) => t.id === taskId)!
      .checkpoints.find((c) => c.id === checkpointId)!.done
    expect(flipped).toBe(!before)

    // Persisted: a fresh read from disk sees the new value.
    const persisted = store
      .readTasks(BOARD)
      .tasks.find((t) => t.id === taskId)!
      .checkpoints.find((c) => c.id === checkpointId)!.done
    expect(persisted).toBe(!before)

    // And the raw file on disk was rewritten with the flip.
    const onDisk = JSON.parse(fs.readFileSync(tasksPath(), 'utf8')) as TasksFile
    const diskDone = onDisk.tasks
      .find((t) => t.id === taskId)!
      .checkpoints.find((c) => c.id === checkpointId)!.done
    expect(diskDone).toBe(!before)

    // Restore original state (leave the temp fixture as we found it).
    store.toggleCheckpoint(BOARD, taskId, checkpointId)
    const restored = store
      .readTasks(BOARD)
      .tasks.find((t) => t.id === taskId)!
      .checkpoints.find((c) => c.id === checkpointId)!.done
    expect(restored).toBe(before)
  })
})
