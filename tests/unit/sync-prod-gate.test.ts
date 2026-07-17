/**
 * W-SYNC-PROD: fail-closed production apply gate + env path overrides.
 * Pure unit tests — no MySQL, no secrets.
 */
import { describe, expect, it } from 'vitest'

import {
  assertProductionSyncAuthority,
  defaultSyncPaths,
  resolveSyncPathsFromEnv,
} from '#/server/rebuild-lineage-store'

const HOST = '34.177.80.237'
const DB = 'cairn_taskmanager'

function fullEnv(over: Record<string, string | undefined> = {}) {
  return {
    PRODUCTION_MUTATION_APPROVED: '1',
    PRODUCTION_APPROVAL_ID: 'OWNER-CHAT-20260717-APPROVE-PROD',
    BACKUP_RECEIPT: '/tmp/fake-backup-receipt.txt',
    SYNC_TARGET_HOST: HOST,
    SYNC_TARGET_DATABASE: DB,
    ...over,
  }
}

const backupOk = () => ({ isFile: true, size: 408 })

describe('assertProductionSyncAuthority', () => {
  it('PASS when full bundle + host/db bind + backup file present', () => {
    const r = assertProductionSyncAuthority({
      env: fullEnv(),
      actualHost: HOST,
      actualDatabase: DB,
      backupStat: backupOk,
    })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.approvalId).toBe('OWNER-CHAT-20260717-APPROVE-PROD')
      expect(r.targetHost).toBe(HOST)
      expect(r.targetDatabase).toBe(DB)
    }
  })

  it('REFUSE without PRODUCTION_MUTATION_APPROVED=1', () => {
    const r = assertProductionSyncAuthority({
      env: fullEnv({ PRODUCTION_MUTATION_APPROVED: '0' }),
      actualHost: HOST,
      actualDatabase: DB,
      backupStat: backupOk,
    })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.code).toBe('MISSING_PRODUCTION_SYNC_BUNDLE')
      expect(r.missing).toContain('PRODUCTION_MUTATION_APPROVED=1')
      expect(r.message).toMatch(/APPLY_PRODUCTION_REFUSED/)
    }
  })

  it('REFUSE when SYNC_TARGET_HOST mismatches actual connection', () => {
    const r = assertProductionSyncAuthority({
      env: fullEnv({ SYNC_TARGET_HOST: '127.0.0.1' }),
      actualHost: HOST,
      actualDatabase: DB,
      backupStat: backupOk,
    })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.code).toBe('SYNC_TARGET_HOST_MISMATCH')
    }
  })

  it('REFUSE when BACKUP_RECEIPT path missing/empty', () => {
    const r = assertProductionSyncAuthority({
      env: fullEnv(),
      actualHost: HOST,
      actualDatabase: DB,
      backupStat: () => null,
    })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.code).toBe('BACKUP_RECEIPT_NOT_FOUND')
    }
  })

  it('REFUSE when SYNC_TARGET_DATABASE mismatches', () => {
    const r = assertProductionSyncAuthority({
      env: fullEnv({ SYNC_TARGET_DATABASE: 'other_db' }),
      actualHost: HOST,
      actualDatabase: DB,
      backupStat: backupOk,
    })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.code).toBe('SYNC_TARGET_DATABASE_MISMATCH')
    }
  })
})

describe('resolveSyncPathsFromEnv', () => {
  it('defaults match defaultSyncPaths when env empty', () => {
    const base = defaultSyncPaths('/opt/mfs/workspace')
    const resolved = resolveSyncPathsFromEnv({}, '/opt/mfs/workspace')
    expect(resolved).toEqual(base)
  })

  it('honors SYNC_* path overrides (path-B bundle)', () => {
    const resolved = resolveSyncPathsFromEnv(
      {
        SYNC_WORKSPACE_ROOT: '/tmp/tm-sync-input',
        SYNC_LINEAGE_JSONL: '/tmp/tm-sync-input/REBUILD_LINEAGE.jsonl',
        SYNC_VERDICTS_DIR: '/tmp/tm-sync-input/verdicts',
        SYNC_LATEST_REPORT: '/tmp/tm-sync-input/latest.txt',
        SYNC_FEATURE_CONTRACTS_DIR: '/tmp/tm-sync-input/feature-contracts',
        SYNC_RN_INVENTORY: '/tmp/tm-sync-input/rn_inventory.json',
      },
      '/opt/mfs/workspace',
    )
    expect(resolved.workspaceRoot).toBe('/tmp/tm-sync-input')
    expect(resolved.lineageJsonl).toBe('/tmp/tm-sync-input/REBUILD_LINEAGE.jsonl')
    expect(resolved.verdictsDir).toBe('/tmp/tm-sync-input/verdicts')
    expect(resolved.latestReport).toBe('/tmp/tm-sync-input/latest.txt')
    expect(resolved.featureContractsDir).toBe('/tmp/tm-sync-input/feature-contracts')
    expect(resolved.rnInventory).toBe('/tmp/tm-sync-input/rn_inventory.json')
  })
})
