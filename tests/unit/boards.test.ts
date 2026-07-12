// Focused unit tests for the multi-board index API (createBoard / listBoards /
// defaultBoardId) in src/server/board-store.ts. Runs against a throwaway temp
// CAIRN_DATA_DIR seeded with a boards.json index so the real repo SSOT is never
// touched. Removed after the suite.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

type Store = typeof import('#/server/board-store')

const repoData = path.resolve(process.cwd(), 'data')

let tmpDir: string
let store: Store

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'boards-index-test-'))
  fs.mkdirSync(path.join(tmpDir, 'boards'), { recursive: true })
  // seed the global boards index with a single 'ibils' entry
  fs.writeFileSync(
    path.join(tmpDir, 'boards.json'),
    JSON.stringify({ boards: [{ id: 'ibils', name: 'Ibils Roadmap' }] }, null, 2),
    'utf8',
  )
  // conventions is global too; copy the real one so readBoard-adjacent paths work
  fs.copyFileSync(path.join(repoData, 'conventions.json'), path.join(tmpDir, 'conventions.json'))

  process.env.CAIRN_DATA_DIR = tmpDir
  store = await import('#/server/board-store')
})

afterAll(() => {
  delete process.env.CAIRN_DATA_DIR
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('board index API', () => {
  it('listBoards() reflects the seeded index and defaultBoardId() is the first entry', () => {
    const boards = store.listBoards()
    expect(boards.map((b) => b.id)).toContain('ibils')
    expect(store.defaultBoardId()).toBe('ibils')
  })

  it('createBoard() appends a new board and lays out its scope on disk', () => {
    expect(store.boardExists('team-alpha')).toBe(false)
    const boards = store.createBoard('team-alpha', 'Team Alpha', 'a second board')
    expect(boards.some((b) => b.id === 'team-alpha')).toBe(true)
    expect(store.boardExists('team-alpha')).toBe(true)

    // scope files materialised
    const dir = path.join(tmpDir, 'boards', 'team-alpha')
    for (const f of ['plan.json', 'runs.json', 'design.json', 'collab.json']) {
      expect(fs.existsSync(path.join(dir, f))).toBe(true)
    }
    // still resolvable via a fresh listBoards read
    expect(store.listBoards().some((b) => b.id === 'team-alpha')).toBe(true)
    // defaultBoardId stays the first (ibils), not the newly appended one
    expect(store.defaultBoardId()).toBe('ibils')
  })

  it('rejects an invalid board id', () => {
    expect(() => store.createBoard('Not Kebab!', 'Bad')).toThrow(/invalid board id/i)
    expect(store.boardExists('Not Kebab!')).toBe(false)
  })

  it('rejects a duplicate board id', () => {
    // team-alpha was materialised on disk by the earlier test, so boardExists()
    // is true and a second create must throw.
    expect(store.boardExists('team-alpha')).toBe(true)
    expect(() => store.createBoard('team-alpha', 'Dup')).toThrow(/already exists/i)
  })
})
