/**
 * W-API-1: rebuild parity MCP tools + graceful missing-table handling.
 * Memory fixtures only — no real MySQL.
 */
import { afterEach, describe, expect, it } from 'vitest'

import {
  assertMcpToolCatalogIntegrity,
  defaultScopesForRole,
  getToolSpec,
  isToolListable,
  MCP_TOOL_SPECS,
  type Principal,
} from '#/server/rbac'
import { registerBoardTools } from '#/server/board-mcp'
import {
  classifyBlindspotFromRecord,
  createMemoryRebuildParityDataAccess,
  get_feature_360,
  get_rebuild_parity,
  handleGetFeature360,
  handleGetRebuildParity,
  handleTraceBlindspot,
  listRebuildParityToolNames,
  REBUILD_DATA_TABLES_NOT_MIGRATED,
  REBUILD_PARITY_MCP_TOOL_NAMES,
  registerRebuildParityTools,
  setRebuildParityDataAccessForTests,
  trace_blindspot,
} from '#/server/rebuild-parity-mcp'
import type { ParityRollupRow, RebuildLineageRecord } from '#/server/rebuild-lineage-store'
import type { FeatureTaskMapRow, ProductFeatureRow } from '#/server/product-features-store'

afterEach(() => {
  setRebuildParityDataAccessForTests(null)
})

function boardAgent(): Principal {
  return {
    actorId: 'rebuild-parity-agent',
    role: 'AGENT',
    scopes: defaultScopesForRole('AGENT'),
    channel: 'bearer',
    boards: ['mfs-rebuild'],
    boardId: 'mfs-rebuild',
    agentId: 'rebuild-parity-agent',
  }
}

function sampleRollup(over: Partial<ParityRollupRow> = {}): ParityRollupRow {
  return {
    id: 1,
    capturedAt: '2026-07-17 06:00:00.000',
    mapped100: 1731,
    partialN: 200,
    missingN: 300,
    pendingN: 200,
    l0N: 70,
    measuredN: 2301,
    totalN: 2501,
    sourceFile: 'reports/latest.txt',
    rawText: 'MAPPED_100=1731',
    sourceHash: 'abc',
    ...over,
  }
}

function sampleLineage(over: Partial<RebuildLineageRecord> = {}): RebuildLineageRecord {
  return {
    boardId: 'mfs-rebuild',
    taskId: 'T-BE-DEP-MOD-MEDITATION-01',
    disposition: 'PRODUCT',
    repository: 'rebuild-backend',
    origin: 'existing',
    featureContractId: 'FC-WELLNESS-MEDITATION',
    parityVerdict: 'PARTIAL',
    acceptanceCovered: null,
    verifierModel: 'gemini',
    verifiedAt: '2026-07-16T12:00:00.000Z',
    stage1Json: {
      origin: 'existing',
      covered_legacy_units: ['UNIT-MED-1'],
      legacy_anchors: [{ file: 'legacy/foo/MeditationScreen.tsx' }],
    },
    evidenceJson: [{ file: 'src/meditation/player.ts', line: 10 }],
    gapsJson: ['player seek incomplete'],
    implementationJson: { status: 'partial' },
    sourceHash: 'hash1',
    syncedAt: '2026-07-17T00:00:00.000Z',
    ...over,
  }
}

function sampleFeature(over: Partial<ProductFeatureRow> = {}): ProductFeatureRow {
  return {
    featureId: 'FEAT-MEDITATION',
    namaId: 'Meditasi',
    domainBisnis: 'Kesehatan & Wellness',
    ringkasanId: 'Katalog sesi meditasi dan player',
    platformJson: { rn: true, web: true, backend: true },
    capabilitiesJson: ['katalog', 'player'],
    fcRefsJson: ['FC-WELLNESS-MEDITATION'],
    curated: false,
    ...over,
  }
}

function sampleMap(over: Partial<FeatureTaskMapRow> = {}): FeatureTaskMapRow {
  return {
    featureId: 'FEAT-MEDITATION',
    taskId: 'T-BE-DEP-MOD-MEDITATION-01',
    joinSource: 'prefix',
    confidence: 0.6,
    ...over,
  }
}

describe('catalog integrity (no duplicate rebuild tools)', () => {
  it('assertMcpToolCatalogIntegrity still passes with 3 new reads', () => {
    expect(() => assertMcpToolCatalogIntegrity()).not.toThrow()
    for (const name of REBUILD_PARITY_MCP_TOOL_NAMES) {
      const hits = MCP_TOOL_SPECS.filter((s) => s.name === name)
      expect(hits).toHaveLength(1)
      expect(getToolSpec(name)?.kind).toBe('read')
      expect(getToolSpec(name)?.scopes).toContain('board:read')
    }
  })

  it('AGENT can list the three rebuild tools', () => {
    const p = boardAgent()
    for (const name of REBUILD_PARITY_MCP_TOOL_NAMES) {
      expect(isToolListable(p, name)).toBe(true)
    }
  })
})

describe('registerBoardTools wires rebuild parity tools', () => {
  it('registers get_rebuild_parity, get_feature_360, trace_blindspot', () => {
    const registered: Array<string> = []
    registerBoardTools(
      {
        registerTool(name: string) {
          registered.push(name)
        },
        registerResource() {},
      } as never,
      { principal: boardAgent(), mechanism: { kind: 'OK' }, bearerPresent: true },
    )
    for (const name of REBUILD_PARITY_MCP_TOOL_NAMES) {
      expect(registered).toContain(name)
    }
  })

  it('registerRebuildParityTools registers exactly 3 tools', () => {
    const names: Array<string> = []
    registerRebuildParityTools({
      secureTool: (name) => {
        names.push(name)
      },
      jsonText: (v) => v,
    })
    expect(names).toEqual([...REBUILD_PARITY_MCP_TOOL_NAMES])
    expect(listRebuildParityToolNames()).toEqual([
      get_rebuild_parity,
      get_feature_360,
      trace_blindspot,
    ])
  })
})

describe('get_rebuild_parity happy path', () => {
  it('returns latest rollup + history + verdict breakdown + freshness', async () => {
    const access = createMemoryRebuildParityDataAccess({
      tablesPresent: true,
      rollups: [
        sampleRollup({ capturedAt: '2026-07-17 06:00:00.000', mapped100: 1731 }),
        sampleRollup({
          id: 2,
          capturedAt: '2026-07-17 05:00:00.000',
          mapped100: 1700,
          sourceHash: 'older',
        }),
      ],
      lineage: [
        sampleLineage({ parityVerdict: 'MAPPED_100', taskId: 'T-A' }),
        sampleLineage({ parityVerdict: 'PARTIAL', taskId: 'T-B' }),
        sampleLineage({ parityVerdict: 'MISSING', taskId: 'T-C' }),
      ],
    })
    setRebuildParityDataAccessForTests(access)

    const result = await handleGetRebuildParity({ boardId: 'mfs-rebuild', historyLimit: 5 })
    expect(result.available).toBe(true)
    if (!result.available) return
    expect(result.latest?.mapped100).toBe(1731)
    expect(result.latest?.totalN).toBe(2501)
    expect(result.latest?.mappedPct).toBeCloseTo(69.2, 0)
    expect(result.history.length).toBe(2)
    expect(result.verdictBreakdown.some((v) => v.verdict === 'MAPPED_100' && v.count === 1)).toBe(
      true,
    )
    expect(result.freshness.labelId).toMatch(/diukur ulang|belum ada/)
    expect(result.disclaimerId).toMatch(/bukan berarti production-ready/)
  })
})

describe('get_feature_360 happy path', () => {
  it('returns nama_id, bars (siap_produksi placeholder 0), tasks, units, docs', async () => {
    const access = createMemoryRebuildParityDataAccess({
      tablesPresent: true,
      features: [sampleFeature()],
      maps: [
        sampleMap(),
        sampleMap({
          taskId: 'T-BE-DEP-MOD-MEDITATION-02',
          joinSource: 'keyword',
          confidence: 0.4,
        }),
      ],
      lineage: [
        sampleLineage({
          taskId: 'T-BE-DEP-MOD-MEDITATION-01',
          parityVerdict: 'MAPPED_100',
        }),
        sampleLineage({
          taskId: 'T-BE-DEP-MOD-MEDITATION-02',
          parityVerdict: 'PARTIAL',
        }),
      ],
      units: [
        {
          unitId: 'U-RN-MED-1',
          featureContractId: 'FC-WELLNESS-MEDITATION',
          unitType: 'screen',
          identifier: 'MeditationList',
          anchor: 'screens/MeditationList.tsx',
          notes: null,
          coverageStatus: 'covered',
          repo: 'legacy/rn-mfs81',
          sourceHash: 'u1',
          syncedAt: '2026-07-17T00:00:00.000Z',
        },
        {
          unitId: 'U-BE-MED-1',
          featureContractId: 'FC-WELLNESS-MEDITATION',
          unitType: 'api',
          identifier: 'GET /meditation',
          anchor: 'controllers/MeditationController.php',
          notes: null,
          coverageStatus: 'partial',
          repo: 'legacy/myfitsociety-backend',
          sourceHash: 'u2',
          syncedAt: '2026-07-17T00:00:00.000Z',
        },
      ],
      directory: [
        {
          featureContractId: 'FC-WELLNESS-MEDITATION',
          judulId: 'Meditasi (FC)',
          domainBisnis: 'Kesehatan & Wellness',
          ringkasanId: 'docs',
          docMd: '# Meditasi\n\nKonten',
          deliveryStatus: 'draft',
          linksJson: null,
          sourceHash: 'd1',
          syncedAt: '2026-07-17T00:00:00.000Z',
        },
      ],
    })
    setRebuildParityDataAccessForTests(access)

    const result = await handleGetFeature360({ feature_id: 'FEAT-MEDITATION' })
    expect(result.available).toBe(true)
    if (!('nama_id' in result)) return
    expect(result.nama_id).toBe('Meditasi')
    expect(result.domain_bisnis).toBe('Kesehatan & Wellness')
    expect(result.bars.siap_produksi.numerator).toBe(0)
    expect(result.bars.siap_produksi.placeholder).toBe(true)
    expect(result.bars.siap_produksi.flag).toBe('PLACEHOLDER_SIAP_PRODUKSI_ZERO')
    expect(result.bars.terbukti_pindah.numerator).toBe(1)
    expect(result.tasks).toHaveLength(2)
    expect(result.tasks.some((t) => t.parity_verdict === 'MAPPED_100')).toBe(true)
    expect(result.units_by_platform.rn?.length).toBe(1)
    expect(result.units_by_platform.backend?.length).toBe(1)
    expect(result.docs_refs[0]?.has_doc_md).toBe(true)
  })

  it('FEATURE_NOT_FOUND when id missing from store', async () => {
    setRebuildParityDataAccessForTests(
      createMemoryRebuildParityDataAccess({ tablesPresent: true, features: [] }),
    )
    const result = await handleGetFeature360({ feature_id: 'FEAT-NOPE' })
    expect(result.available).toBe(false)
    if (result.available) return
    expect(result.reason).toBe('FEATURE_NOT_FOUND')
  })
})

describe('trace_blindspot happy + classification port', () => {
  it('STAGE1_ROW_BLINDSPOT when term has zero matches', async () => {
    setRebuildParityDataAccessForTests(
      createMemoryRebuildParityDataAccess({
        tablesPresent: true,
        lineage: [sampleLineage()],
      }),
    )
    const result = await handleTraceBlindspot({ term: 'xyz-totally-absent-feature-99' })
    expect(result.available).toBe(true)
    if (!result.available) return
    expect(result.primary_classification).toBe('STAGE1_ROW_BLINDSPOT')
    expect(result.matchCount).toBe(0)
  })

  it('classifies PARTIAL → STAGE2_PARTIAL and links FEAT ids', async () => {
    setRebuildParityDataAccessForTests(
      createMemoryRebuildParityDataAccess({
        tablesPresent: true,
        lineage: [sampleLineage({ parityVerdict: 'PARTIAL' })],
        maps: [sampleMap()],
      }),
    )
    const result = await handleTraceBlindspot({ term: 'meditation' })
    expect(result.available).toBe(true)
    if (!result.available) return
    expect(result.matchCount).toBeGreaterThan(0)
    expect(result.primary_classification).toBe('STAGE2_PARTIAL')
    expect(result.related_feature_ids).toContain('FEAT-MEDITATION')
  })

  it('classifyBlindspotFromRecord covers all 5 labels', () => {
    expect(
      classifyBlindspotFromRecord(sampleLineage({ parityVerdict: 'MAPPED_100' })),
    ).toBe('L2_FALSE_POSITIVE_OR_REGRESSION')
    expect(classifyBlindspotFromRecord(sampleLineage({ parityVerdict: 'PARTIAL' }))).toBe(
      'STAGE2_PARTIAL',
    )
    expect(classifyBlindspotFromRecord(sampleLineage({ parityVerdict: 'MISSING' }))).toBe(
      'STAGE2_NOT_IMPLEMENTED',
    )
    expect(
      classifyBlindspotFromRecord(
        sampleLineage({
          parityVerdict: 'PENDING_MEASURE',
          origin: 'firm-new-blindspot',
          stage1Json: { origin: 'firm-new-blindspot' },
        }),
      ),
    ).toBe('STAGE1_VARIANT_BLINDSPOT')
    expect(
      classifyBlindspotFromRecord(
        sampleLineage({ parityVerdict: 'PENDING_MEASURE', origin: 'existing' }),
      ),
    ).toBe('STAGE2_NOT_IMPLEMENTED')
  })
})

describe('graceful when tables 009/010 not migrated', () => {
  it('get_rebuild_parity returns available:false without throw', async () => {
    setRebuildParityDataAccessForTests(
      createMemoryRebuildParityDataAccess({ tablesPresent: false }),
    )
    const result = await handleGetRebuildParity({})
    expect(result).toEqual({
      available: false,
      reason: REBUILD_DATA_TABLES_NOT_MIGRATED,
      tool: get_rebuild_parity,
    })
  })

  it('get_feature_360 returns available:false without throw', async () => {
    setRebuildParityDataAccessForTests(
      createMemoryRebuildParityDataAccess({ tablesPresent: false }),
    )
    const result = await handleGetFeature360({ feature_id: 'FEAT-MEDITATION' })
    expect(result.available).toBe(false)
    if (result.available) return
    expect(result.reason).toBe(REBUILD_DATA_TABLES_NOT_MIGRATED)
    expect(result.tool).toBe(get_feature_360)
  })

  it('trace_blindspot returns available:false without throw', async () => {
    setRebuildParityDataAccessForTests(
      createMemoryRebuildParityDataAccess({ tablesPresent: false }),
    )
    const result = await handleTraceBlindspot({ term: 'meditation' })
    expect(result.available).toBe(false)
    if (result.available) return
    expect(result.reason).toBe(REBUILD_DATA_TABLES_NOT_MIGRATED)
    expect(result.tool).toBe(trace_blindspot)
  })

  it('memory access throw path still maps to graceful unavailable', async () => {
    // tablesAvailable=true but subsequent call throws ER_NO_SUCH_TABLE
    const access = createMemoryRebuildParityDataAccess({ tablesPresent: true })
    access.tablesAvailable = async () => true
    access.getLatestRollup = async () => {
      throw Object.assign(new Error("Table 'parity_rollups' doesn't exist"), {
        code: 'ER_NO_SUCH_TABLE',
        errno: 1146,
      })
    }
    setRebuildParityDataAccessForTests(access)
    const result = await handleGetRebuildParity({})
    expect(result.available).toBe(false)
    if (result.available) return
    expect(result.reason).toBe(REBUILD_DATA_TABLES_NOT_MIGRATED)
  })
})
