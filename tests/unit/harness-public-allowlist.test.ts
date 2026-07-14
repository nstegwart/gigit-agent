/**
 * Disposable harness public-board allowlist for owned preview.
 *
 * Proves child-only CAIRN_PUBLIC_BOARD_IDS = exact boardId, different board denied,
 * empty deny-all product semantics preserved, and helper does not mutate process.env.
 * LOCAL ONLY — no live preview / browser.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  buildOwnedPreviewPublicAllowlistEnv,
  publicAllowlistEnvAllows,
} from '../../qa/e2e/lib/server-lifecycle.mjs'
import {
  getPublicBoardAllowlist,
  isPublicBoardAllowed,
  resolvePublicBoardAllowlist,
  setPublicBoardAllowlistForTests,
} from '../../src/routes/api.public-snapshot'

const ENV_KEYS = ['CAIRN_PUBLIC_BOARD_IDS', 'CAIRN_PUBLIC_BOARDS'] as const

const saved: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {}

beforeEach(() => {
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k]
    delete process.env[k]
  }
  setPublicBoardAllowlistForTests(null)
})

afterEach(() => {
  setPublicBoardAllowlistForTests(null)
  for (const k of ENV_KEYS) {
    const v = saved[k]
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
})

describe('buildOwnedPreviewPublicAllowlistEnv', () => {
  it('injects exact boardId as CAIRN_PUBLIC_BOARD_IDS only', () => {
    const env = buildOwnedPreviewPublicAllowlistEnv('mfs-rebuild')
    expect(env).toEqual({ CAIRN_PUBLIC_BOARD_IDS: 'mfs-rebuild' })
    expect(publicAllowlistEnvAllows(env, 'mfs-rebuild')).toBe(true)
  })

  it('exact board allowed; different board denied', () => {
    const env = buildOwnedPreviewPublicAllowlistEnv('mfs-rebuild')
    expect(publicAllowlistEnvAllows(env, 'mfs-rebuild')).toBe(true)
    expect(publicAllowlistEnvAllows(env, 'not-allowlisted-board-xyz')).toBe(false)
    expect(publicAllowlistEnvAllows(env, 'mfs-rebuild-extra')).toBe(false)
  })

  it('does not mutate process.env (child inject only — cleanup is no parent leak)', () => {
    expect(process.env.CAIRN_PUBLIC_BOARD_IDS).toBeUndefined()
    const env = buildOwnedPreviewPublicAllowlistEnv('mfs-rebuild')
    expect(env.CAIRN_PUBLIC_BOARD_IDS).toBe('mfs-rebuild')
    expect(process.env.CAIRN_PUBLIC_BOARD_IDS).toBeUndefined()
    expect(process.env.CAIRN_PUBLIC_BOARDS).toBeUndefined()
  })

  it('trims boardId and fail-closes empty', () => {
    expect(buildOwnedPreviewPublicAllowlistEnv('  mfs-rebuild  ')).toEqual({
      CAIRN_PUBLIC_BOARD_IDS: 'mfs-rebuild',
    })
    expect(() => buildOwnedPreviewPublicAllowlistEnv('')).toThrow(/FAIL-CLOSED|boardId/i)
    expect(() => buildOwnedPreviewPublicAllowlistEnv('   ')).toThrow(/FAIL-CLOSED|boardId/i)
  })

  it('parent snapshot restore cleans accidental pollution', () => {
    const prior = process.env.CAIRN_PUBLIC_BOARD_IDS
    const snapshot = { CAIRN_PUBLIC_BOARD_IDS: prior }
    process.env.CAIRN_PUBLIC_BOARD_IDS = 'polluted-parent'
    if (snapshot.CAIRN_PUBLIC_BOARD_IDS === undefined) {
      delete process.env.CAIRN_PUBLIC_BOARD_IDS
    } else {
      process.env.CAIRN_PUBLIC_BOARD_IDS = snapshot.CAIRN_PUBLIC_BOARD_IDS
    }
    expect(process.env.CAIRN_PUBLIC_BOARD_IDS).toBe(prior)
  })
})

describe('product empty-allowlist deny-all remains intact', () => {
  it('resolvePublicBoardAllowlist empty → deny all (product semantics)', () => {
    expect(resolvePublicBoardAllowlist({}).size).toBe(0)
    expect(resolvePublicBoardAllowlist({ CAIRN_PUBLIC_BOARD_IDS: '' }).size).toBe(0)
    expect(resolvePublicBoardAllowlist({ CAIRN_PUBLIC_BOARDS: '  ' }).size).toBe(0)
    setPublicBoardAllowlistForTests(null)
    // Ambient process env cleared in beforeEach
    expect(getPublicBoardAllowlist().size).toBe(0)
    expect(isPublicBoardAllowed('mfs-rebuild')).toBe(false)
  })

  it('product allowlist with harness-shaped env allows exact board only', () => {
    const child = buildOwnedPreviewPublicAllowlistEnv('mfs-rebuild')
    const set = resolvePublicBoardAllowlist(child as NodeJS.ProcessEnv)
    expect(set.has('mfs-rebuild')).toBe(true)
    expect(set.has('not-allowlisted-board-xyz')).toBe(false)
  })
})
