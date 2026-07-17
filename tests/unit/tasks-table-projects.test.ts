/**
 * W-FIX-PROJECTS pure helpers: task titles, domain grouping, run sort priority.
 */
import { describe, expect, it } from 'vitest'
import {
  cleanTaskTitle,
  domainGroupKeyOf,
  formatFeatureContractLabel,
  resolveTaskDisplayTitle,
  TASKS_TABLE_PAGE_SIZE,
} from '#/components/TasksTable'
import {
  countAttentionRuns,
  looksLikeRunId,
  PROJECT_RUNS_PAGE_SIZE,
  runCardPrimaryLabel,
  sortProjectRuns,
} from '#/components/RunCard'
import type { Run } from '#/lib/types'

describe('W-FIX-PROJECTS TasksTable titles', () => {
  it('uses humanTitle over raw technical title', () => {
    expect(
      resolveTaskDisplayTitle({
        id: 'T-RN-WELL-1',
        title: '[FC-RN-WELLNESS] map meditation',
        humanTitle: 'Meditasi RN',
      }),
    ).toBe('Meditasi RN')
  })

  it('W-CONTENT-3: id-ID humanTitle wins over English technical list title', () => {
    expect(
      resolveTaskDisplayTitle({
        id: 'T-ANN-REG-FILTER',
        title: 'Restore purchases + member history readback contract',
        humanTitle: 'Penerima pengumuman filter tanggal registrasi',
      }),
    ).toBe('Penerima pengumuman filter tanggal registrasi')
  })

  it('falls back to cleaned title when humanTitle absent', () => {
    expect(
      resolveTaskDisplayTitle({
        id: 'T-NO-HD',
        title: 'Restore purchases + member history readback contract',
      }),
    ).toMatch(/Restore purchases/i)
  })

  it('falls back to cleaned title, never bare placeholder', () => {
    expect(
      resolveTaskDisplayTitle({
        id: 'T-1',
        title: '[FC-99] raw technical must not be primary',
        ownerPrimaryTitle: 'Konten pemilik memerlukan peninjauan',
      }),
    ).toMatch(/raw technical/i)
  })

  it('last resort is task id', () => {
    expect(
      resolveTaskDisplayTitle({
        id: 'T-ONLY',
        title: '',
      }),
    ).toBe('T-ONLY')
  })

  it('cleanTaskTitle strips FC/T tokens', () => {
    expect(cleanTaskTitle('T-RN-FIT-JOURNEY Fit journey timeline')).toMatch(/Fit journey/i)
    expect(cleanTaskTitle('[FC-PAY] Purchase tails')).toMatch(/Purchase tails/i)
  })
})

describe('W-FIX-PROJECTS domain grouping', () => {
  it('maps FC-PAY-* to Payment domain', () => {
    expect(domainGroupKeyOf({ featureContractId: 'FC-PAY-RC-IAP-E2E' })).toBe('Payment')
  })

  it('maps FC-RN-AUTH-* to Auth', () => {
    expect(domainGroupKeyOf({ featureContractId: 'FC-RN-AUTH-BOOTSTRAP' })).toBe('Auth')
  })

  it('maps wellness suite FC to Wellness', () => {
    expect(domainGroupKeyOf({ featureContractId: 'FC-RN-CORP-WELLNESS' })).toBe('Wellness')
  })

  it('prefers human group over FC', () => {
    expect(
      domainGroupKeyOf({ group: 'Wellness', featureContractId: 'FC-RN-AUTH-BOOTSTRAP' }),
    ).toBe('Wellness')
  })

  it('does not use raw FC-* as group header', () => {
    const key = domainGroupKeyOf({ featureContractId: 'FC-RN-CONTENT-MEAL' })
    expect(key).not.toMatch(/^FC-/)
    expect(key).toBe('Content')
  })

  it('formatFeatureContractLabel is readable, not raw code alone', () => {
    const label = formatFeatureContractLabel('FC-RN-CHALLENGE-GAMIFY')
    expect(label).not.toBe('FC-RN-CHALLENGE-GAMIFY')
    expect(label.toLowerCase()).toMatch(/challenge/)
  })

  it('page size default is 20', () => {
    expect(TASKS_TABLE_PAGE_SIZE).toBe(20)
  })
})

describe('W-FIX-PROJECTS project runs', () => {
  const base = (over: Partial<Run> & Pick<Run, 'id' | 'status'>): Run => ({
    agent: over.agent ?? `w-stage1-map-verify-${over.id}`,
    role: 'verifier',
    agentType: 'grok',
    model: 'grok-4.5',
    effort: 'low',
    task: over.task ?? 'Independent mapping verification',
    project: 'rn',
    status: over.status,
    id: over.id,
    updated: over.updated,
    started: over.started,
    taskId: over.taskId ?? null,
  })

  it('page size is 6–12', () => {
    expect(PROJECT_RUNS_PAGE_SIZE).toBeGreaterThanOrEqual(6)
    expect(PROJECT_RUNS_PAGE_SIZE).toBeLessThanOrEqual(12)
  })

  it('sorts running/failed before done', () => {
    const sorted = sortProjectRuns([
      base({ id: 'd1', status: 'done', updated: '2026-07-17T10:00:00Z' }),
      base({ id: 'r1', status: 'running', updated: '2026-07-17T09:00:00Z' }),
      base({ id: 'f1', status: 'failed', updated: '2026-07-17T11:00:00Z' }),
      base({ id: 'q1', status: 'queued', updated: '2026-07-17T08:00:00Z' }),
    ])
    expect(sorted.map((r) => r.status)).toEqual(['running', 'failed', 'queued', 'done'])
  })

  it('is stable by id when status+updated tie', () => {
    const sorted = sortProjectRuns([
      base({ id: 'b', status: 'done', updated: '2026-07-17T10:00:00Z' }),
      base({ id: 'a', status: 'done', updated: '2026-07-17T10:00:00Z' }),
    ])
    expect(sorted.map((r) => r.id)).toEqual(['a', 'b'])
  })

  it('counts attention runs', () => {
    expect(
      countAttentionRuns([
        base({ id: '1', status: 'running' }),
        base({ id: '2', status: 'failed' }),
        base({ id: '3', status: 'done' }),
      ]),
    ).toBe(2)
  })
})

describe('W-FIX-PROJECTS RunCard labels', () => {
  it('detects internal run ids', () => {
    expect(looksLikeRunId('w-stage1-map-verify-cairn-01-20260712T1033Z-a02-s01')).toBe(true)
    expect(looksLikeRunId('Fit journey timeline')).toBe(false)
  })

  it('prefers taskTitle over agent run-id', () => {
    expect(
      runCardPrimaryLabel({
        agent: 'w-stage1-map-verify-cairn-01-20260712T1033Z-a02-s01',
        task: 'Independent current-canonical mapping verification',
        taskTitle: 'Fit journey timeline RN',
      }),
    ).toBe('Fit journey timeline RN')
  })

  it('uses task description when agent is a run-id', () => {
    expect(
      runCardPrimaryLabel({
        agent: 'w-stage1-map-verify-x',
        task: 'Independent current-canonical mapping verification for T-RN-FIT-JOURNEY',
      }),
    ).toMatch(/Independent current-canonical/i)
  })
})
