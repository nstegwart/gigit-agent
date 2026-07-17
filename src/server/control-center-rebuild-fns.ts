/**
 * W-UI-1: Authenticated server functions for Rebuild dashboard.
 * Pattern mirrors control-center-ui-fns.ts; data via rebuild-parity-mcp (W-API-1).
 * Graceful when migration 009/010 tables are absent — never throws ER_NO_SUCH_TABLE.
 */

import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'

import { requireView, AuthError } from '#/server/auth'
import {
  DEFAULT_BOARD_ID,
  type RebuildLineageRecord,
} from '#/server/rebuild-lineage-store'
import {
  REBUILD_DATA_TABLES_NOT_MIGRATED,
  getRebuildParityDataAccess,
  handleGetFeature360,
  handleGetRebuildParity,
  handleTraceBlindspot,
  type Feature360Payload,
  type RebuildParityPayload,
  type TraceBlindspotPayload,
  type UnavailablePayload,
} from '#/server/rebuild-parity-mcp'
import type {
  FeatureDirectoryRow,
  FeatureUnitRow,
} from '#/server/rebuild-lineage-store'
import {
  STABLE_DOMAINS,
  defaultProductFeaturesSeedPath,
  listFeatureTaskMaps,
  listProductFeatures,
  loadProductFeaturesSeed,
  type FeatureTaskMapRow,
  type ProductFeatureRow,
  type ProductFeatureSeedEntry,
} from '#/server/product-features-store'

const boardArgs = z.object({
  boardId: z.string().min(1),
  historyLimit: z.number().int().min(1).max(50).optional(),
  topFeaturesPerDomain: z.number().int().min(1).max(20).optional(),
})

const blindspotArgs = z.object({
  boardId: z.string().min(1),
  term: z.string().min(1).max(200),
  limit: z.number().int().min(1).max(100).optional(),
})

// ---------------------------------------------------------------------------
// Wire types (JSON-serializable)
// ---------------------------------------------------------------------------

export type RebuildChipKey = 'terbukti' | 'sebagian' | 'belum_ada' | 'belum_diukur'

export type RebuildChipTone = 'ok' | 'warn' | 'blocked' | 'muted'

export type RebuildDashboardChip = {
  key: RebuildChipKey
  labelId: string
  count: number
  tone: RebuildChipTone
}

export type RebuildHistoryPoint = {
  capturedAt: string
  mapped100: number
  partialN: number
  missingN: number
  pendingN: number
  measuredN: number
  totalN: number
  mappedPct: number | null
}

export type RebuildFeatureCard = {
  featureId: string
  namaId: string
  domainBisnis: string
  taskCount: number
  unitCount: number
  mapped100: number
  measuredN: number
  mappedPct: number | null
  /** Existing control-center features detail route (W-UI-2 will deepen 360). */
  detailHref: string
}

export type RebuildDomainRow = {
  domainBisnis: string
  featureCount: number
  taskCount: number
  mapped100: number
  measuredN: number
  mappedPct: number | null
  topFeatures: Array<RebuildFeatureCard>
}

export type RebuildDashboardUnavailable = {
  available: false
  reason: typeof REBUILD_DATA_TABLES_NOT_MIGRATED | string
  boardId: string
  emptyStateLabelId: string
}

export type RebuildDashboardAvailable = {
  available: true
  boardId: string
  kpi: {
    mapped100: number
    totalN: number
    mappedPct: number | null
    labelId: string
    display: string
  }
  freshness: {
    capturedAt: string | null
    ageSeconds: number | null
    labelId: string
  }
  disclaimerId: string
  chips: Array<RebuildDashboardChip>
  history: Array<RebuildHistoryPoint>
  domains: Array<RebuildDomainRow>
}

export type RebuildDashboardData = RebuildDashboardUnavailable | RebuildDashboardAvailable

/** Wire-safe blindspot payload (unknown JSON cells → Json). */
export type RebuildBlindspotWire =
  | {
      available: false
      reason: string
      tool: 'trace_blindspot'
      error?: string
    }
  | {
      available: true
      term: string
      boardId: string
      matchCount: number
      primary_classification: string
      matches: Array<{
        task_id: string
        classification: string
        parity_verdict: string | null
        origin: string | null
        disposition: string | null
        feature_contract_id: string | null
        gaps: string | null
        evidence_sample: string | null
        stage1_origin: string | null
      }>
      related_feature_ids: Array<string>
      note_id: string
    }

function toBlindspotWire(
  raw: RebuildBlindspotData | Awaited<ReturnType<typeof handleTraceBlindspot>>,
): RebuildBlindspotWire {
  if (!raw || typeof raw !== 'object') {
    return {
      available: false,
      reason: REBUILD_DATA_TABLES_NOT_MIGRATED,
      tool: 'trace_blindspot',
    }
  }
  if (!('available' in raw) || raw.available !== true) {
    const u = raw as UnavailablePayload & { error?: string }
    return {
      available: false,
      reason: String(u.reason ?? REBUILD_DATA_TABLES_NOT_MIGRATED),
      tool: 'trace_blindspot',
      error: u.error ? String(u.error).slice(0, 200) : undefined,
    }
  }
  const p = raw as TraceBlindspotPayload
  return {
    available: true,
    term: p.term,
    boardId: p.boardId,
    matchCount: p.matchCount,
    primary_classification: p.primary_classification,
    matches: (p.matches ?? []).map((m) => ({
      task_id: m.task_id,
      classification: m.classification,
      parity_verdict: m.parity_verdict,
      origin: m.origin,
      disposition: m.disposition,
      feature_contract_id: m.feature_contract_id,
      gaps: m.gaps == null ? null : JSON.stringify(m.gaps).slice(0, 2000),
      evidence_sample:
        m.evidence_sample == null
          ? null
          : JSON.stringify(m.evidence_sample).slice(0, 2000),
      stage1_origin: m.stage1_origin,
    })),
    related_feature_ids: p.related_feature_ids ?? [],
    note_id: p.note_id,
  }
}

export type RebuildBlindspotData =
  | UnavailablePayload
  | TraceBlindspotPayload
  | { available: false; reason: string; tool: 'trace_blindspot'; error?: string }

const EMPTY_STATE_ID =
  'Data rebuild belum diaktifkan — menunggu migrasi database (009/010)' as const

const DISCLAIMER_ID =
  'terbukti secara bukti kode (MAPPED_100), bukan berarti siap produksi' as const

const KPI_LABEL_ID = 'Terbukti pindah dari legacy' as const

function pct(n: number, d: number): number | null {
  if (d <= 0) return null
  return Math.round((n / d) * 1000) / 10
}

function asStringArray(value: unknown): Array<string> {
  if (!value) return []
  if (Array.isArray(value)) return value.map(String).filter(Boolean)
  if (typeof value === 'string') {
    try {
      const p = JSON.parse(value) as unknown
      if (Array.isArray(p)) return p.map(String).filter(Boolean)
    } catch {
      return value ? [value] : []
    }
  }
  return []
}

/** Product Fitur 360 route (W-UI-2). Legacy FC technical surface stays at /features. */
function featureDetailHref(boardId: string, featureId: string): string {
  return `/b/${encodeURIComponent(boardId)}/fitur/${encodeURIComponent(featureId)}`
}

function featureDirectoryHref(boardId: string): string {
  return `/b/${encodeURIComponent(boardId)}/fitur`
}

function technicalFcHref(boardId: string): string {
  return `/b/${encodeURIComponent(boardId)}/features`
}

/** Pure chips from rollup numbers (SPEC §4.1 semantic tones). */
export function buildRebuildChips(latest: {
  mapped100: number
  partialN: number
  missingN: number
  pendingN: number
  l0N?: number
} | null): Array<RebuildDashboardChip> {
  const mapped100 = latest?.mapped100 ?? 0
  const partialN = latest?.partialN ?? 0
  const missingN = latest?.missingN ?? 0
  const pendingN = (latest?.pendingN ?? 0) + (latest?.l0N ?? 0)
  return [
    { key: 'terbukti', labelId: 'Terbukti', count: mapped100, tone: 'ok' },
    { key: 'sebagian', labelId: 'Sebagian', count: partialN, tone: 'warn' },
    { key: 'belum_ada', labelId: 'Belum ada', count: missingN, tone: 'blocked' },
    { key: 'belum_diukur', labelId: 'Belum diukur', count: pendingN, tone: 'muted' },
  ]
}

/**
 * Aggregate 8 stable domains + top features (SPEC §3.A + ADDENDUM V1.1 §B).
 * Pure — safe for unit tests without MySQL.
 */
export function aggregateRebuildDomains(input: {
  boardId: string
  features: ReadonlyArray<ProductFeatureRow>
  maps: ReadonlyArray<FeatureTaskMapRow>
  lineage: ReadonlyArray<RebuildLineageRecord>
  unitCountByFeatureId?: Readonly<Record<string, number>>
  topN?: number
}): Array<RebuildDomainRow> {
  const topN = input.topN ?? 5
  const unitCountByFeatureId = input.unitCountByFeatureId ?? {}
  const boardLineage = input.lineage.filter((r) => r.boardId === input.boardId)
  const verdictByTask = new Map(
    boardLineage.map((r) => [r.taskId, r.parityVerdict ?? null] as const),
  )

  const mapsByFeature = new Map<string, Array<FeatureTaskMapRow>>()
  for (const m of input.maps) {
    const list = mapsByFeature.get(m.featureId) ?? []
    list.push(m)
    mapsByFeature.set(m.featureId, list)
  }

  const featuresByDomain = new Map<string, Array<ProductFeatureRow>>()
  for (const d of STABLE_DOMAINS) featuresByDomain.set(d, [])
  for (const f of input.features) {
    const domain = STABLE_DOMAINS.includes(
      f.domainBisnis as (typeof STABLE_DOMAINS)[number],
    )
      ? f.domainBisnis
      : f.domainBisnis || 'Platform & Infrastruktur'
    const list = featuresByDomain.get(domain) ?? []
    list.push(f)
    featuresByDomain.set(domain, list)
  }

  const rows: Array<RebuildDomainRow> = []
  for (const domain of STABLE_DOMAINS) {
    const feats = featuresByDomain.get(domain) ?? []
    const featureCards: Array<RebuildFeatureCard> = feats.map((f) => {
      const maps = mapsByFeature.get(f.featureId) ?? []
      const taskIds = [...new Set(maps.map((m) => m.taskId))]
      let mapped100 = 0
      let measuredN = 0
      for (const tid of taskIds) {
        const v = verdictByTask.get(tid)
        if (v == null || v === '' || v === 'NULL') continue
        measuredN += 1
        if (v === 'MAPPED_100') mapped100 += 1
      }
      // When lineage missing for a mapped task, still count task; bar uses lineage when present
      const den = Math.max(measuredN, taskIds.length, 0)
      return {
        featureId: f.featureId,
        namaId: f.namaId,
        domainBisnis: f.domainBisnis,
        taskCount: taskIds.length,
        unitCount: unitCountByFeatureId[f.featureId] ?? asStringArray(f.fcRefsJson).length,
        mapped100,
        measuredN: den,
        mappedPct: pct(mapped100, den),
        detailHref: featureDetailHref(input.boardId, f.featureId),
      }
    })

    // Sort top features by mapped100 desc, then taskCount
    const sorted = [...featureCards].sort((a, b) => {
      if (b.mapped100 !== a.mapped100) return b.mapped100 - a.mapped100
      if (b.taskCount !== a.taskCount) return b.taskCount - a.taskCount
      return a.namaId.localeCompare(b.namaId, 'id')
    })

    const taskIdSet = new Set<string>()
    let domainMapped = 0
    let domainMeasured = 0
    for (const card of featureCards) {
      domainMapped += card.mapped100
      domainMeasured += card.measuredN
      const maps = mapsByFeature.get(card.featureId) ?? []
      for (const m of maps) taskIdSet.add(m.taskId)
    }

    rows.push({
      domainBisnis: domain,
      featureCount: featureCards.length,
      taskCount: taskIdSet.size,
      mapped100: domainMapped,
      measuredN: Math.max(domainMeasured, taskIdSet.size),
      mappedPct: pct(domainMapped, Math.max(domainMeasured, taskIdSet.size)),
      topFeatures: sorted.slice(0, topN),
    })
  }
  return rows
}

/** Pure projector: parity payload + taxonomy → dashboard data. */
export function projectRebuildDashboard(input: {
  boardId: string
  parity: RebuildParityPayload | UnavailablePayload
  features?: ReadonlyArray<ProductFeatureRow>
  maps?: ReadonlyArray<FeatureTaskMapRow>
  lineage?: ReadonlyArray<RebuildLineageRecord>
  unitCountByFeatureId?: Readonly<Record<string, number>>
  topFeaturesPerDomain?: number
}): RebuildDashboardData {
  const boardId = input.boardId.trim() || DEFAULT_BOARD_ID
  if (!input.parity.available) {
    return {
      available: false,
      reason: input.parity.reason ?? REBUILD_DATA_TABLES_NOT_MIGRATED,
      boardId,
      emptyStateLabelId: EMPTY_STATE_ID,
    }
  }

  const latest = input.parity.latest
  const mapped100 = latest?.mapped100 ?? 0
  const totalN = latest?.totalN ?? 0
  const mappedPct = latest?.mappedPct ?? pct(mapped100, totalN)

  const history: Array<RebuildHistoryPoint> = (input.parity.history ?? []).map((h) => ({
    capturedAt: h.capturedAt,
    mapped100: h.mapped100,
    partialN: h.partialN,
    missingN: h.missingN,
    pendingN: h.pendingN,
    measuredN: h.measuredN,
    totalN: h.totalN,
    mappedPct: pct(h.mapped100, h.totalN),
  }))

  // History chronological for sparkline (oldest → newest)
  const historyAsc = [...history].sort((a, b) =>
    a.capturedAt < b.capturedAt ? -1 : a.capturedAt > b.capturedAt ? 1 : 0,
  )

  const domains = aggregateRebuildDomains({
    boardId,
    features: input.features ?? [],
    maps: input.maps ?? [],
    lineage: input.lineage ?? [],
    unitCountByFeatureId: input.unitCountByFeatureId,
    topN: input.topFeaturesPerDomain ?? 5,
  })

  return {
    available: true,
    boardId,
    kpi: {
      mapped100,
      totalN,
      mappedPct,
      labelId: KPI_LABEL_ID,
      display: `${mapped100}/${totalN}`,
    },
    freshness: {
      capturedAt: input.parity.freshness.capturedAt,
      ageSeconds: input.parity.freshness.ageSeconds,
      labelId: input.parity.freshness.labelId,
    },
    disclaimerId: DISCLAIMER_ID,
    chips: buildRebuildChips(
      latest
        ? {
            mapped100: latest.mapped100,
            partialN: latest.partialN,
            missingN: latest.missingN,
            pendingN: latest.pendingN,
            l0N: latest.l0N,
          }
        : null,
    ),
    history: historyAsc,
    domains,
  }
}

/**
 * Load full rebuild dashboard. Uses W-API-1 handlers + product feature stores.
 * Injectable parts for unit tests (no MySQL).
 */
export async function loadRebuildDashboard(
  boardId: string,
  opts: {
    historyLimit?: number
    topFeaturesPerDomain?: number
    /** Inject parity result (tests). */
    parity?: RebuildParityPayload | UnavailablePayload
    features?: ReadonlyArray<ProductFeatureRow>
    maps?: ReadonlyArray<FeatureTaskMapRow>
    lineage?: ReadonlyArray<RebuildLineageRecord>
    unitCountByFeatureId?: Readonly<Record<string, number>>
    skipTaxonomy?: boolean
  } = {},
): Promise<RebuildDashboardData> {
  const bid = boardId.trim() || DEFAULT_BOARD_ID
  const parity =
    opts.parity ??
    (await handleGetRebuildParity({
      boardId: bid,
      historyLimit: opts.historyLimit ?? 12,
    }))

  if (!parity.available) {
    return projectRebuildDashboard({ boardId: bid, parity })
  }

  if (opts.skipTaxonomy) {
    return projectRebuildDashboard({
      boardId: bid,
      parity,
      features: opts.features ?? [],
      maps: opts.maps ?? [],
      lineage: opts.lineage ?? [],
      unitCountByFeatureId: opts.unitCountByFeatureId,
      topFeaturesPerDomain: opts.topFeaturesPerDomain,
    })
  }

  // Taxonomy aggregation — graceful if product tables fail mid-flight
  try {
    const access = getRebuildParityDataAccess()
    const features =
      opts.features ??
      (await listProductFeatures({}).catch(() => [] as Array<ProductFeatureRow>))
    const maps =
      opts.maps ??
      (await listFeatureTaskMaps({}).catch(() => [] as Array<FeatureTaskMapRow>))
    const lineage =
      opts.lineage ??
      (await access.listLineageForBoard(bid).catch(() => [] as Array<RebuildLineageRecord>))

    // Unit counts: group by feature via fc_refs
    let unitCountByFeatureId = opts.unitCountByFeatureId
    if (!unitCountByFeatureId && features.length > 0) {
      const counts: Record<string, number> = {}
      const allFc = new Set<string>()
      const featureFc = new Map<string, Array<string>>()
      for (const f of features) {
        const refs = asStringArray(f.fcRefsJson)
        featureFc.set(f.featureId, refs)
        for (const r of refs) allFc.add(r)
      }
      try {
        const units = await access.listUnitsByFcIds([...allFc])
        const byFc = new Map<string, number>()
        for (const u of units) {
          if (!u.featureContractId) continue
          byFc.set(u.featureContractId, (byFc.get(u.featureContractId) ?? 0) + 1)
        }
        for (const [fid, refs] of featureFc) {
          let n = 0
          for (const r of refs) n += byFc.get(r) ?? 0
          counts[fid] = n
        }
      } catch {
        for (const [fid, refs] of featureFc) counts[fid] = refs.length
      }
      unitCountByFeatureId = counts
    }

    return projectRebuildDashboard({
      boardId: bid,
      parity,
      features,
      maps,
      lineage,
      unitCountByFeatureId,
      topFeaturesPerDomain: opts.topFeaturesPerDomain,
    })
  } catch {
    // Parity available but taxonomy failed — still show KPI/chips/history
    return projectRebuildDashboard({
      boardId: bid,
      parity,
      features: [],
      maps: [],
      lineage: [],
      topFeaturesPerDomain: opts.topFeaturesPerDomain,
    })
  }
}

export async function loadRebuildBlindspot(
  boardId: string,
  term: string,
  limit?: number,
): Promise<RebuildBlindspotData> {
  return handleTraceBlindspot({
    boardId: boardId.trim() || DEFAULT_BOARD_ID,
    term,
    limit,
  })
}

// ---------------------------------------------------------------------------
// Server functions
// ---------------------------------------------------------------------------

function authFailBoard(boardId: string): RebuildDashboardUnavailable {
  return {
    available: false,
    reason: 'FORBIDDEN',
    boardId,
    emptyStateLabelId: EMPTY_STATE_ID,
  }
}

export const getControlCenterRebuildFn = createServerFn({ method: 'GET' })
  .validator(boardArgs)
  .handler(async ({ data }): Promise<RebuildDashboardData> => {
    try {
      await requireView(data.boardId)
      return await loadRebuildDashboard(data.boardId, {
        historyLimit: data.historyLimit,
        topFeaturesPerDomain: data.topFeaturesPerDomain,
      })
    } catch (e) {
      if (e instanceof AuthError) {
        return authFailBoard(data.boardId)
      }
      // Never crash the surface — honest empty / unavailable
      return {
        available: false,
        reason: REBUILD_DATA_TABLES_NOT_MIGRATED,
        boardId: data.boardId,
        emptyStateLabelId: EMPTY_STATE_ID,
      }
    }
  })

export const getControlCenterRebuildBlindspotFn = createServerFn({ method: 'GET' })
  .validator(blindspotArgs)
  .handler(async ({ data }): Promise<RebuildBlindspotWire> => {
    try {
      await requireView(data.boardId)
      const raw = await loadRebuildBlindspot(data.boardId, data.term, data.limit)
      return toBlindspotWire(raw)
    } catch (e) {
      if (e instanceof AuthError) {
        return {
          available: false,
          reason: 'FORBIDDEN',
          tool: 'trace_blindspot',
          error: 'authentication required',
        }
      }
      return {
        available: false,
        reason: REBUILD_DATA_TABLES_NOT_MIGRATED,
        tool: 'trace_blindspot',
      }
    }
  })

// ===========================================================================
// W-UI-2 — Feature directory (produk) + Fitur 360
// SPEC §1 IA, §3.B, §4.3, ADDENDUM V1.1 §B
// ===========================================================================

const feature360Args = z.object({
  boardId: z.string().min(1),
  featureId: z.string().min(1),
})

const featureDocArgs = z.object({
  boardId: z.string().min(1),
  featureContractId: z.string().min(1),
})

export type FeatureDirCard = {
  featureId: string
  namaId: string
  domainBisnis: string
  taskCount: number
  unitCount: number
  /** docs ✓ when any linked FC directory has doc_md */
  docsOk: boolean
  mapped100: number
  measuredN: number
  mappedPct: number | null
  detailHref: string
}

export type FeatureDirDomainGroup = {
  domainBisnis: string
  featureCount: number
  features: Array<FeatureDirCard>
}

export type FeatureDirectoryUnavailable = {
  available: false
  reason: typeof REBUILD_DATA_TABLES_NOT_MIGRATED | string
  boardId: string
  emptyStateLabelId: string
  technicalFcHref: string
}

export type FeatureDirectoryAvailable = {
  available: true
  boardId: string
  featureCount: number
  domains: Array<FeatureDirDomainGroup>
  technicalFcHref: string
  directoryHref: string
}

export type FeatureDirectoryData = FeatureDirectoryUnavailable | FeatureDirectoryAvailable

export type Feature360BarUi = {
  key: 'pemetaan' | 'terbukti_pindah' | 'siap_produksi'
  labelId: string
  numerator: number
  denominator: number
  pct: number | null
  placeholder?: boolean
  /** id-ID note under bar when placeholder (siap produksi) */
  noteId?: string
}

export type Feature360UnitRow = {
  unitId: string
  unitType: string | null
  identifier: string | null
  anchor: string | null
  coverageStatus: string | null
  repo: string | null
  platform: string
}

export type Feature360TaskRow = {
  taskId: string
  joinSource: string
  confidence: number
  parityVerdict: string | null
  verdictTone: 'ok' | 'warn' | 'blocked' | 'muted'
  verdictLabelId: string
}

export type Feature360DocRef = {
  featureContractId: string
  judulId: string | null
  deliveryStatus: string | null
  hasDocMd: boolean
  /** Full markdown when loaded (directory join or doc_md server fn). */
  docMd: string | null
}

export type Feature360EvidenceLine = {
  file: string
  line: number | null
  side?: string | null
}

export type Feature360LineageRow = {
  taskId: string
  origin: string | null
  gapClass: string | null
  verifier: string | null
  verifiedAt: string | null
  parityVerdict: string | null
  featureContractId: string | null
  evidence: Array<Feature360EvidenceLine>
}

export type Feature360Unavailable = {
  available: false
  reason: string
  boardId: string
  featureId: string
  emptyStateLabelId: string
  technicalFcHref: string
  directoryHref: string
}

export type Feature360Available = {
  available: true
  boardId: string
  featureId: string
  namaId: string
  domainBisnis: string
  ringkasanId: string | null
  bars: {
    pemetaan: Feature360BarUi
    terbukti_pindah: Feature360BarUi
    siap_produksi: Feature360BarUi
  }
  unitsByPlatform: Record<string, Array<Feature360UnitRow>>
  tasks: Array<Feature360TaskRow>
  docs: Array<Feature360DocRef>
  lineage: Array<Feature360LineageRow>
  technicalFcHref: string
  directoryHref: string
  rollup: {
    taskCount: number
    lineageCount: number
    parityMapped100: number
    parityTotal: number
  }
}

export type Feature360UiData = Feature360Unavailable | Feature360Available

export type FeatureDocMdData =
  | {
      available: false
      reason: string
      boardId: string
      featureContractId: string
      emptyStateLabelId: string
    }
  | {
      available: true
      boardId: string
      featureContractId: string
      judulId: string | null
      deliveryStatus: string | null
      docMd: string | null
      hasDocMd: boolean
    }

function verdictTone(v: string | null | undefined): Feature360TaskRow['verdictTone'] {
  const u = (v ?? '').toUpperCase()
  if (u === 'MAPPED_100') return 'ok'
  if (u === 'PARTIAL') return 'warn'
  if (u === 'MISSING') return 'blocked'
  return 'muted'
}

function verdictLabelId(v: string | null | undefined): string {
  const u = (v ?? '').toUpperCase()
  if (u === 'MAPPED_100') return 'Terbukti'
  if (u === 'PARTIAL') return 'Sebagian'
  if (u === 'MISSING') return 'Belum ada'
  if (u === 'PENDING' || u === 'L0') return 'Belum diukur'
  if (!u) return 'Belum diukur'
  return u
}

function extractEvidenceLines(evidenceJson: unknown): Array<Feature360EvidenceLine> {
  if (evidenceJson == null) return []
  const rows: Array<Feature360EvidenceLine> = []
  const push = (item: unknown) => {
    if (!item || typeof item !== 'object') return
    const o = item as Record<string, unknown>
    const file = o.file ?? o.path ?? o.anchor
    if (file == null) return
    const lineRaw = o.line ?? o.lineno ?? o.line_number
    const line =
      lineRaw == null || lineRaw === ''
        ? null
        : Number.isFinite(Number(lineRaw))
          ? Number(lineRaw)
          : null
    rows.push({
      file: String(file),
      line,
      side: o.side != null ? String(o.side) : o.repo != null ? String(o.repo) : null,
    })
  }
  if (Array.isArray(evidenceJson)) {
    for (const item of evidenceJson) push(item)
  } else if (typeof evidenceJson === 'object') {
    const o = evidenceJson as Record<string, unknown>
    if (Array.isArray(o.items)) {
      for (const item of o.items) push(item)
    } else {
      push(evidenceJson)
    }
  }
  return rows.slice(0, 40)
}

function gapClassFromRecord(rec: {
  gapsJson?: unknown
  parityVerdict?: string | null
  origin?: string | null
}): string | null {
  const gaps = rec.gapsJson
  if (Array.isArray(gaps) && gaps.length > 0) {
    const first = gaps[0]
    if (typeof first === 'string') return first
    if (first && typeof first === 'object' && 'class' in (first as object)) {
      return String((first as { class: unknown }).class)
    }
    if (first && typeof first === 'object' && 'type' in (first as object)) {
      return String((first as { type: unknown }).type)
    }
    return String(first).slice(0, 120)
  }
  if (gaps && typeof gaps === 'object' && gaps !== null) {
    const g = gaps as Record<string, unknown>
    if (g.class != null) return String(g.class)
    if (g.gap_class != null) return String(g.gap_class)
  }
  const v = (rec.parityVerdict ?? '').toUpperCase()
  if (v === 'MISSING') return 'STAGE2_NOT_IMPLEMENTED'
  if (v === 'PARTIAL') return 'STAGE2_PARTIAL'
  if (v === 'MAPPED_100') return null
  if (v === 'PENDING' || v === 'L0' || !v) {
    const origin = (rec.origin ?? '').toLowerCase()
    if (origin.includes('firm-new') || origin.includes('blindspot')) {
      return 'STAGE1_VARIANT_BLINDSPOT'
    }
    return 'STAGE2_NOT_IMPLEMENTED'
  }
  return null
}

/**
 * Pure projector: product features + maps + lineage → directory grouped by domain.
 * Meditation and other FEAT-* appear as independent product features (ADDENDUM §B).
 */
export function projectFeatureDirectory(input: {
  boardId: string
  available: boolean
  reason?: string
  features?: ReadonlyArray<ProductFeatureRow>
  maps?: ReadonlyArray<FeatureTaskMapRow>
  lineage?: ReadonlyArray<RebuildLineageRecord>
  unitCountByFeatureId?: Readonly<Record<string, number>>
  docsOkByFeatureId?: Readonly<Record<string, boolean>>
}): FeatureDirectoryData {
  const boardId = input.boardId.trim() || DEFAULT_BOARD_ID
  const technical = technicalFcHref(boardId)
  if (!input.available) {
    return {
      available: false,
      reason: input.reason ?? REBUILD_DATA_TABLES_NOT_MIGRATED,
      boardId,
      emptyStateLabelId: EMPTY_STATE_ID,
      technicalFcHref: technical,
    }
  }

  const features = input.features ?? []
  const maps = input.maps ?? []
  const lineage = (input.lineage ?? []).filter((r) => r.boardId === boardId)
  const verdictByTask = new Map(
    lineage.map((r) => [r.taskId, r.parityVerdict ?? null] as const),
  )
  const mapsByFeature = new Map<string, Array<FeatureTaskMapRow>>()
  for (const m of maps) {
    const list = mapsByFeature.get(m.featureId) ?? []
    list.push(m)
    mapsByFeature.set(m.featureId, list)
  }

  const byDomain = new Map<string, Array<FeatureDirCard>>()
  for (const d of STABLE_DOMAINS) byDomain.set(d, [])

  for (const f of features) {
    const domain = STABLE_DOMAINS.includes(
      f.domainBisnis as (typeof STABLE_DOMAINS)[number],
    )
      ? f.domainBisnis
      : f.domainBisnis || 'Platform & Infrastruktur'
    const fMaps = mapsByFeature.get(f.featureId) ?? []
    const taskIds = [...new Set(fMaps.map((m) => m.taskId))]
    let mapped100 = 0
    let measuredN = 0
    for (const tid of taskIds) {
      const v = verdictByTask.get(tid)
      if (v == null || v === '' || v === 'NULL') continue
      measuredN += 1
      if (v === 'MAPPED_100') mapped100 += 1
    }
    const den = Math.max(measuredN, taskIds.length, 0)
    const card: FeatureDirCard = {
      featureId: f.featureId,
      namaId: f.namaId,
      domainBisnis: f.domainBisnis,
      taskCount: taskIds.length,
      unitCount: input.unitCountByFeatureId?.[f.featureId] ?? asStringArray(f.fcRefsJson).length,
      docsOk: input.docsOkByFeatureId?.[f.featureId] ?? false,
      mapped100,
      measuredN: den,
      mappedPct: pct(mapped100, den),
      detailHref: featureDetailHref(boardId, f.featureId),
    }
    const list = byDomain.get(domain) ?? []
    list.push(card)
    byDomain.set(domain, list)
  }

  const domains: Array<FeatureDirDomainGroup> = []
  for (const domain of STABLE_DOMAINS) {
    const feats = [...(byDomain.get(domain) ?? [])].sort((a, b) =>
      a.namaId.localeCompare(b.namaId, 'id'),
    )
    domains.push({
      domainBisnis: domain,
      featureCount: feats.length,
      features: feats,
    })
  }

  return {
    available: true,
    boardId,
    featureCount: features.length,
    domains,
    technicalFcHref: technical,
    directoryHref: featureDirectoryHref(boardId),
  }
}

export async function loadFeatureDirectory(
  boardId: string,
  opts: {
    features?: ReadonlyArray<ProductFeatureRow>
    maps?: ReadonlyArray<FeatureTaskMapRow>
    lineage?: ReadonlyArray<RebuildLineageRecord>
    unitCountByFeatureId?: Readonly<Record<string, number>>
    docsOkByFeatureId?: Readonly<Record<string, boolean>>
    /** Force unavailable (tests). */
    forceUnavailable?: boolean
  } = {},
): Promise<FeatureDirectoryData> {
  const bid = boardId.trim() || DEFAULT_BOARD_ID
  if (opts.forceUnavailable) {
    return projectFeatureDirectory({ boardId: bid, available: false })
  }

  try {
    const access = getRebuildParityDataAccess()
    const tablesOk = await access.tablesAvailable().catch(() => false)
    if (!tablesOk && !opts.features) {
      return projectFeatureDirectory({
        boardId: bid,
        available: false,
        reason: REBUILD_DATA_TABLES_NOT_MIGRATED,
      })
    }

    const features =
      opts.features ??
      (await listProductFeatures({}).catch(() => [] as Array<ProductFeatureRow>))
    const maps =
      opts.maps ??
      (await listFeatureTaskMaps({}).catch(() => [] as Array<FeatureTaskMapRow>))
    const lineage =
      opts.lineage ??
      (await access.listLineageForBoard(bid).catch(() => [] as Array<RebuildLineageRecord>))

    let unitCountByFeatureId = opts.unitCountByFeatureId
    let docsOkByFeatureId = opts.docsOkByFeatureId

    if ((!unitCountByFeatureId || !docsOkByFeatureId) && features.length > 0) {
      const allFc = new Set<string>()
      const featureFc = new Map<string, Array<string>>()
      for (const f of features) {
        const refs = asStringArray(f.fcRefsJson)
        featureFc.set(f.featureId, refs)
        for (const r of refs) allFc.add(r)
      }
      const fcList = [...allFc]
      if (!unitCountByFeatureId) {
        const counts: Record<string, number> = {}
        try {
          const units = await access.listUnitsByFcIds(fcList)
          const byFc = new Map<string, number>()
          for (const u of units) {
            if (!u.featureContractId) continue
            byFc.set(u.featureContractId, (byFc.get(u.featureContractId) ?? 0) + 1)
          }
          for (const [fid, refs] of featureFc) {
            let n = 0
            for (const r of refs) n += byFc.get(r) ?? 0
            counts[fid] = n
          }
        } catch {
          for (const [fid, refs] of featureFc) counts[fid] = refs.length
        }
        unitCountByFeatureId = counts
      }
      if (!docsOkByFeatureId) {
        const docs: Record<string, boolean> = {}
        try {
          const directory = await access.listDirectoryByFcIds(fcList)
          const hasMd = new Set(
            directory
              .filter((d) => d.docMd && String(d.docMd).trim())
              .map((d) => d.featureContractId),
          )
          for (const [fid, refs] of featureFc) {
            docs[fid] = refs.some((r) => hasMd.has(r))
          }
        } catch {
          for (const fid of featureFc.keys()) docs[fid] = false
        }
        docsOkByFeatureId = docs
      }
    }

    return projectFeatureDirectory({
      boardId: bid,
      available: true,
      features,
      maps,
      lineage,
      unitCountByFeatureId,
      docsOkByFeatureId,
    })
  } catch {
    return projectFeatureDirectory({
      boardId: bid,
      available: false,
      reason: REBUILD_DATA_TABLES_NOT_MIGRATED,
    })
  }
}

/** Pure projector from W-API-1 get_feature_360 + lineage/docs enrichment. */
export function projectFeature360Ui(input: {
  boardId: string
  featureId: string
  payload: Feature360Payload | UnavailablePayload | { available: false; reason: string; tool?: string; error?: string }
  lineage?: ReadonlyArray<RebuildLineageRecord>
  directory?: ReadonlyArray<FeatureDirectoryRow>
}): Feature360UiData {
  const boardId = input.boardId.trim() || DEFAULT_BOARD_ID
  const featureId = input.featureId.trim()
  const technical = technicalFcHref(boardId)
  const directoryHref = featureDirectoryHref(boardId)

  if (!input.payload.available) {
    const reason = String(
      (input.payload as { reason?: string }).reason ?? REBUILD_DATA_TABLES_NOT_MIGRATED,
    )
    const empty =
      reason === 'FEATURE_NOT_FOUND'
        ? 'Fitur tidak ditemukan di direktori produk'
        : EMPTY_STATE_ID
    return {
      available: false,
      reason,
      boardId,
      featureId,
      emptyStateLabelId: empty,
      technicalFcHref: technical,
      directoryHref,
    }
  }

  const p = input.payload as Feature360Payload
  const lineageByTask = new Map(
    (input.lineage ?? []).map((r) => [r.taskId, r] as const),
  )
  const dirByFc = new Map(
    (input.directory ?? []).map((d) => [d.featureContractId, d] as const),
  )

  const bars = {
    pemetaan: {
      key: 'pemetaan' as const,
      labelId: 'Pemetaan',
      numerator: p.bars.pemetaan.numerator,
      denominator: p.bars.pemetaan.denominator,
      pct: p.bars.pemetaan.pct,
    },
    terbukti_pindah: {
      key: 'terbukti_pindah' as const,
      labelId: 'Terbukti pindah',
      numerator: p.bars.terbukti_pindah.numerator,
      denominator: p.bars.terbukti_pindah.denominator,
      pct: p.bars.terbukti_pindah.pct,
    },
    siap_produksi: {
      key: 'siap_produksi' as const,
      labelId: 'Siap produksi',
      numerator: p.bars.siap_produksi.numerator,
      denominator: p.bars.siap_produksi.denominator,
      pct: p.bars.siap_produksi.pct,
      placeholder: true as const,
      noteId: 'belum dihitung',
    },
  }

  const unitsByPlatform: Record<string, Array<Feature360UnitRow>> = {}
  for (const [platform, units] of Object.entries(p.units_by_platform ?? {})) {
    unitsByPlatform[platform] = (units ?? []).map((u) => ({
      unitId: u.unit_id,
      unitType: u.unit_type,
      identifier: u.identifier,
      anchor: u.anchor,
      coverageStatus: u.coverage_status,
      repo: u.repo,
      platform,
    }))
  }

  const tasks: Array<Feature360TaskRow> = (p.tasks ?? []).map((t) => ({
    taskId: t.task_id,
    joinSource: t.join_source,
    confidence: t.confidence,
    parityVerdict: t.parity_verdict,
    verdictTone: verdictTone(t.parity_verdict),
    verdictLabelId: verdictLabelId(t.parity_verdict),
  }))

  const docs: Array<Feature360DocRef> = (p.docs_refs ?? []).map((d) => {
    const full = dirByFc.get(d.feature_contract_id)
    const md = full?.docMd != null ? String(full.docMd) : null
    return {
      featureContractId: d.feature_contract_id,
      judulId: d.judul_id ?? full?.judulId ?? null,
      deliveryStatus: d.delivery_status ?? full?.deliveryStatus ?? null,
      hasDocMd: d.has_doc_md || Boolean(md && md.trim()),
      docMd: md && md.trim() ? md : null,
    }
  })

  // Lineage rows: one per task with joined map presence
  const lineageRows: Array<Feature360LineageRow> = tasks.map((t) => {
    const lin = lineageByTask.get(t.taskId)
    return {
      taskId: t.taskId,
      origin: lin?.origin ?? null,
      gapClass: lin
        ? gapClassFromRecord({
            gapsJson: lin.gapsJson,
            parityVerdict: lin.parityVerdict,
            origin: lin.origin,
          })
        : null,
      verifier: lin?.verifierModel ?? null,
      verifiedAt: lin?.verifiedAt ?? null,
      parityVerdict: lin?.parityVerdict ?? t.parityVerdict,
      featureContractId: lin?.featureContractId ?? null,
      evidence: lin ? extractEvidenceLines(lin.evidenceJson) : [],
    }
  })

  return {
    available: true,
    boardId,
    featureId: p.feature_id,
    namaId: p.nama_id,
    domainBisnis: p.domain_bisnis,
    ringkasanId: p.ringkasan_id,
    bars,
    unitsByPlatform,
    tasks,
    docs,
    lineage: lineageRows,
    technicalFcHref: technical,
    directoryHref,
    rollup: {
      taskCount: p.rollup.taskCount,
      lineageCount: p.rollup.lineageCount,
      parityMapped100: p.rollup.parityMapped100,
      parityTotal: p.rollup.parityTotal,
    },
  }
}

export async function loadFeature360Ui(
  boardId: string,
  featureId: string,
  opts: {
    payload?: Feature360Payload | UnavailablePayload | { available: false; reason: string; tool?: string; error?: string }
    lineage?: ReadonlyArray<RebuildLineageRecord>
    directory?: ReadonlyArray<FeatureDirectoryRow>
  } = {},
): Promise<Feature360UiData> {
  const bid = boardId.trim() || DEFAULT_BOARD_ID
  const fid = featureId.trim()

  const payload =
    opts.payload ??
    (await handleGetFeature360({ boardId: bid, feature_id: fid }))

  if (!payload.available) {
    return projectFeature360Ui({ boardId: bid, featureId: fid, payload })
  }

  // Enrich with lineage + directory doc_md when not injected
  try {
    const access = getRebuildParityDataAccess()
    const p = payload as Feature360Payload
    const taskIds = p.tasks.map((t) => t.task_id)
    const lineage =
      opts.lineage ??
      (await access.listLineageByTaskIds(bid, taskIds).catch(() => [] as Array<RebuildLineageRecord>))
    const fcIds = p.docs_refs.map((d) => d.feature_contract_id)
    const directory =
      opts.directory ??
      (await access.listDirectoryByFcIds(fcIds).catch(() => [] as Array<FeatureDirectoryRow>))
    return projectFeature360Ui({
      boardId: bid,
      featureId: fid,
      payload,
      lineage,
      directory,
    })
  } catch {
    return projectFeature360Ui({ boardId: bid, featureId: fid, payload })
  }
}

export async function loadFeatureDocMd(
  boardId: string,
  featureContractId: string,
  opts: {
    directory?: ReadonlyArray<FeatureDirectoryRow>
    forceUnavailable?: boolean
  } = {},
): Promise<FeatureDocMdData> {
  const bid = boardId.trim() || DEFAULT_BOARD_ID
  const fcId = featureContractId.trim()
  if (opts.forceUnavailable) {
    return {
      available: false,
      reason: REBUILD_DATA_TABLES_NOT_MIGRATED,
      boardId: bid,
      featureContractId: fcId,
      emptyStateLabelId: EMPTY_STATE_ID,
    }
  }
  try {
    const access = getRebuildParityDataAccess()
    if (!opts.directory) {
      const ok = await access.tablesAvailable().catch(() => false)
      if (!ok) {
        return {
          available: false,
          reason: REBUILD_DATA_TABLES_NOT_MIGRATED,
          boardId: bid,
          featureContractId: fcId,
          emptyStateLabelId: EMPTY_STATE_ID,
        }
      }
    }
    const directory =
      opts.directory ?? (await access.listDirectoryByFcIds([fcId]))
    const row = directory.find((d) => d.featureContractId === fcId) ?? null
    if (!row) {
      return {
        available: true,
        boardId: bid,
        featureContractId: fcId,
        judulId: null,
        deliveryStatus: null,
        docMd: null,
        hasDocMd: false,
      }
    }
    const md = row.docMd != null ? String(row.docMd) : null
    return {
      available: true,
      boardId: bid,
      featureContractId: fcId,
      judulId: row.judulId,
      deliveryStatus: row.deliveryStatus,
      docMd: md && md.trim() ? md : null,
      hasDocMd: Boolean(md && md.trim()),
    }
  } catch {
    return {
      available: false,
      reason: REBUILD_DATA_TABLES_NOT_MIGRATED,
      boardId: bid,
      featureContractId: fcId,
      emptyStateLabelId: EMPTY_STATE_ID,
    }
  }
}

export const getControlCenterFeatureDirectoryFn = createServerFn({ method: 'GET' })
  .validator(boardArgs.pick({ boardId: true }))
  .handler(async ({ data }): Promise<FeatureDirectoryData> => {
    try {
      await requireView(data.boardId)
      return await loadFeatureDirectory(data.boardId)
    } catch (e) {
      if (e instanceof AuthError) {
        return {
          available: false,
          reason: 'FORBIDDEN',
          boardId: data.boardId,
          emptyStateLabelId: EMPTY_STATE_ID,
          technicalFcHref: technicalFcHref(data.boardId),
        }
      }
      return {
        available: false,
        reason: REBUILD_DATA_TABLES_NOT_MIGRATED,
        boardId: data.boardId,
        emptyStateLabelId: EMPTY_STATE_ID,
        technicalFcHref: technicalFcHref(data.boardId),
      }
    }
  })

export const getControlCenterFeature360Fn = createServerFn({ method: 'GET' })
  .validator(feature360Args)
  .handler(async ({ data }): Promise<Feature360UiData> => {
    try {
      await requireView(data.boardId)
      return await loadFeature360Ui(data.boardId, data.featureId)
    } catch (e) {
      if (e instanceof AuthError) {
        return {
          available: false,
          reason: 'FORBIDDEN',
          boardId: data.boardId,
          featureId: data.featureId,
          emptyStateLabelId: EMPTY_STATE_ID,
          technicalFcHref: technicalFcHref(data.boardId),
          directoryHref: featureDirectoryHref(data.boardId),
        }
      }
      return {
        available: false,
        reason: REBUILD_DATA_TABLES_NOT_MIGRATED,
        boardId: data.boardId,
        featureId: data.featureId,
        emptyStateLabelId: EMPTY_STATE_ID,
        technicalFcHref: technicalFcHref(data.boardId),
        directoryHref: featureDirectoryHref(data.boardId),
      }
    }
  })

export const getControlCenterFeatureDocMdFn = createServerFn({ method: 'GET' })
  .validator(featureDocArgs)
  .handler(async ({ data }): Promise<FeatureDocMdData> => {
    try {
      await requireView(data.boardId)
      return await loadFeatureDocMd(data.boardId, data.featureContractId)
    } catch (e) {
      if (e instanceof AuthError) {
        return {
          available: false,
          reason: 'FORBIDDEN',
          boardId: data.boardId,
          featureContractId: data.featureContractId,
          emptyStateLabelId: EMPTY_STATE_ID,
        }
      }
      return {
        available: false,
        reason: REBUILD_DATA_TABLES_NOT_MIGRATED,
        boardId: data.boardId,
        featureContractId: data.featureContractId,
        emptyStateLabelId: EMPTY_STATE_ID,
      }
    }
  })

// ===========================================================================
// W-UI-3 — Per-task Lineage Rebuild panel (SPEC §3.C + §4 + Feature A)
// ===========================================================================

const taskLineageArgs = z.object({
  boardId: z.string().min(1),
  taskId: z.string().min(1),
})

export type TaskLineageVerdictKey =
  | 'terbukti'
  | 'sebagian'
  | 'belum_ada'
  | 'belum_diukur'

export type TaskLineageChipTone = 'ok' | 'warn' | 'blocked' | 'muted'

export type TaskLineageChip = {
  key: TaskLineageVerdictKey
  labelId: string
  tone: TaskLineageChipTone
}

export type TaskLineageAnchorLine = {
  label: string
  fact: string | null
}

export type TaskLineageUnavailable = {
  available: false
  reason: string
  boardId: string
  taskId: string
  /** Small-line copy (not a big empty panel). */
  emptyStateLabelId: string
}

export type TaskLineageAvailable = {
  available: true
  boardId: string
  taskId: string
  disposition: string | null
  parityVerdict: string | null
  chip: TaskLineageChip
  /** One human id-ID sentence for the rollup header. */
  summarySentenceId: string
  verifierModel: string | null
  verifiedAt: string | null
  verifiedRelativeId: string | null
  origin: {
    raw: string | null
    labelId: string
    denominatorReasonId: string
    coveredUnits: Array<string>
    coveredUnitCount: number
    gapClass: string | null
    legacyAnchors: Array<TaskLineageAnchorLine>
  }
  evidence: {
    legacy: Array<string>
    rebuild: Array<string>
    gaps: Array<string>
  }
  implementation: {
    hasRealOutput: boolean | null
    hasRealOutputLabelId: string
    commitSha: string | null
    commits: Array<string>
    noteId: string | null
  }
  technical: {
    repository: string | null
    featureContractId: string | null
    acceptanceCovered: string | null
    sourceHash: string | null
  }
}

export type TaskLineageData = TaskLineageAvailable | TaskLineageUnavailable

export const TASK_LINEAGE_UNAVAILABLE_LABEL_ID =
  'Data lineage belum tersedia untuk task ini' as const

function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }
  return {}
}

function formatAnchorLine(a: unknown): TaskLineageAnchorLine | null {
  if (a == null) return null
  if (typeof a === 'string') {
    const s = a.trim()
    return s ? { label: s, fact: null } : null
  }
  if (typeof a !== 'object') return null
  const o = a as Record<string, unknown>
  const repo = o.repo != null ? String(o.repo) : ''
  const file = o.file != null ? String(o.file) : ''
  const symbol = o.symbol != null ? String(o.symbol) : ''
  const lineStart = o.line_start != null ? Number(o.line_start) : null
  const lineEnd = o.line_end != null ? Number(o.line_end) : null
  const fact = o.fact != null ? String(o.fact) : null
  let range = ''
  if (lineStart != null && Number.isFinite(lineStart)) {
    range =
      lineEnd != null && Number.isFinite(lineEnd) && lineEnd !== lineStart
        ? `:${lineStart}-${lineEnd}`
        : `:${lineStart}`
  }
  const path = [repo, file].filter(Boolean).join('/')
  const label = [path + range, symbol].filter(Boolean).join(' · ') || path || symbol
  if (!label) return null
  return { label, fact: fact && fact.trim() ? fact : null }
}

/** Split evidence strings into legacy vs rebuild sides (file:line). */
export function splitEvidenceSides(
  evidence: unknown,
): { legacy: Array<string>; rebuild: Array<string> } {
  const items: Array<string> = []
  if (Array.isArray(evidence)) {
    for (const e of evidence) {
      if (typeof e === 'string' && e.trim()) items.push(e.trim())
      else if (e && typeof e === 'object') {
        const line = formatAnchorLine(e)
        if (line) items.push(line.label)
      }
    }
  } else if (typeof evidence === 'string' && evidence.trim()) {
    items.push(evidence.trim())
  }
  const legacy: Array<string> = []
  const rebuild: Array<string> = []
  for (const item of items) {
    const lower = item.toLowerCase()
    if (
      lower.startsWith('legacy/') ||
      lower.includes('/legacy/') ||
      lower.startsWith('legacy\\')
    ) {
      legacy.push(item)
    } else {
      rebuild.push(item)
    }
  }
  return { legacy, rebuild }
}

export function mapParityVerdictToChip(
  verdict: string | null | undefined,
): TaskLineageChip {
  const v = (verdict ?? '').trim().toUpperCase()
  if (v === 'MAPPED_100') {
    return { key: 'terbukti', labelId: 'Terbukti', tone: 'ok' }
  }
  if (v === 'PARTIAL') {
    return { key: 'sebagian', labelId: 'Sebagian', tone: 'warn' }
  }
  if (v === 'MISSING') {
    return { key: 'belum_ada', labelId: 'Belum ada', tone: 'blocked' }
  }
  return { key: 'belum_diukur', labelId: 'Belum diukur', tone: 'muted' }
}

/** Relative time in id-ID (e.g. "3 hari lalu"). Pure; injectable nowMs for tests. */
export function formatRelativeId(
  isoOrMysql: string | null | undefined,
  nowMs: number = Date.now(),
): string | null {
  if (!isoOrMysql) return null
  const raw = String(isoOrMysql).trim()
  if (!raw) return null
  // Accept "YYYY-MM-DD HH:mm:ss.sss" MySQL-ish or ISO
  const normalized = raw.includes('T') ? raw : raw.replace(' ', 'T') + (raw.endsWith('Z') ? '' : 'Z')
  const t = Date.parse(normalized)
  if (!Number.isFinite(t)) return null
  const ageSec = Math.max(0, Math.floor((nowMs - t) / 1000))
  if (ageSec < 60) return `${ageSec} detik lalu`
  const mins = Math.floor(ageSec / 60)
  if (mins < 60) return `${mins} menit lalu`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours} jam lalu`
  const days = Math.floor(hours / 24)
  return `${days} hari lalu`
}

export function buildLineageSummarySentence(input: {
  chipKey: TaskLineageVerdictKey
  verifierModel: string | null
  verifiedRelativeId: string | null
}): string {
  const bits: Array<string> = []
  if (input.verifierModel) bits.push(input.verifierModel)
  if (input.verifiedRelativeId) bits.push(input.verifiedRelativeId)
  const verifiedTail =
    bits.length > 0 ? ` (diverifikasi ${bits.join(' ')})` : ''

  switch (input.chipKey) {
    case 'terbukti':
      return `Task ini terbukti pindah ke rebuild${verifiedTail}.`
    case 'sebagian':
      return `Task ini hanya sebagian pindah ke rebuild — masih ada gap bukti${verifiedTail}.`
    case 'belum_ada':
      return `Task ini belum terbukti pindah ke rebuild (bukti kode belum lengkap)${verifiedTail}.`
    default:
      return 'Parity task ini belum diukur.'
  }
}

function originLabelId(origin: string | null): string {
  if (origin === 'existing') return 'existing'
  if (origin === 'firm-new-blindspot') return 'blindspot-baru'
  if (origin && origin.trim()) return origin
  return 'tidak diketahui'
}

function denominatorReasonId(
  origin: string | null,
  gapClass: string | null,
): string {
  if (origin === 'existing') {
    return 'Masuk denominator karena unit legacy yang sudah dipetakan (existing).'
  }
  if (origin === 'firm-new-blindspot') {
    return 'Masuk denominator sebagai blindspot baru yang sebelumnya belum tercakup inventory.'
  }
  if (gapClass && gapClass.trim()) {
    return `Masuk denominator (kelas gap: ${gapClass}).`
  }
  return 'Masuk denominator rebuild (asal-usul tidak tercatat rinci).'
}

function parseImplementation(implRaw: unknown): TaskLineageAvailable['implementation'] {
  const impl = asRecord(implRaw)
  const hasReal =
    typeof impl.has_real_output === 'boolean'
      ? impl.has_real_output
      : typeof impl.hasRealOutput === 'boolean'
        ? impl.hasRealOutput
        : null

  const commits: Array<string> = []
  const pushSha = (v: unknown) => {
    if (v == null) return
    if (typeof v === 'string' && v.trim()) commits.push(v.trim())
    else if (Array.isArray(v)) {
      for (const x of v) {
        if (typeof x === 'string' && x.trim()) commits.push(x.trim())
        else if (x && typeof x === 'object') {
          const o = x as Record<string, unknown>
          const s = o.sha ?? o.commit ?? o.id
          if (typeof s === 'string' && s.trim()) commits.push(s.trim())
        }
      }
    }
  }
  pushSha(impl.commit_sha ?? impl.commitSha ?? impl.sha ?? impl.commit)
  pushSha(impl.commits)
  pushSha(impl.commit_shas)

  const unique = [...new Set(commits)]
  const hasRealOutputLabelId =
    hasReal === true
      ? 'Ada keluaran implementasi nyata'
      : hasReal === false
        ? 'Belum ada keluaran implementasi nyata'
        : 'Status implementasi tidak tercatat'

  let noteId: string | null = null
  if (typeof impl.note === 'string' && impl.note.trim()) noteId = impl.note.trim()
  else if (typeof impl.status === 'string' && impl.status.trim()) noteId = impl.status.trim()

  return {
    hasRealOutput: hasReal,
    hasRealOutputLabelId,
    commitSha: unique[0] ?? null,
    commits: unique,
    noteId,
  }
}

/** Pure projector: RebuildLineageRecord → TaskLineageData (available). */
export function projectTaskLineage(
  record: RebuildLineageRecord,
  opts: { nowMs?: number } = {},
): TaskLineageAvailable {
  const stage1 = asRecord(record.stage1Json)
  const originRaw =
    record.origin != null
      ? String(record.origin)
      : stage1.origin != null
        ? String(stage1.origin)
        : null
  const gapClass =
    stage1.gap_class != null
      ? String(stage1.gap_class)
      : stage1.gapClass != null
        ? String(stage1.gapClass)
        : null

  const coveredRaw =
    stage1.covered_legacy_units ??
    stage1.covered_gap_units ??
    stage1.coveredLegacyUnits ??
    []
  const coveredUnits = asStringArray(coveredRaw)

  const anchorsRaw = stage1.legacy_anchors ?? stage1.legacyAnchors ?? []
  const legacyAnchors: Array<TaskLineageAnchorLine> = []
  if (Array.isArray(anchorsRaw)) {
    for (const a of anchorsRaw) {
      const line = formatAnchorLine(a)
      if (line) legacyAnchors.push(line)
    }
  }

  const sides = splitEvidenceSides(record.evidenceJson)
  // Prefer structured legacy_anchors labels when evidence legacy side is empty
  if (sides.legacy.length === 0 && legacyAnchors.length > 0) {
    for (const a of legacyAnchors) sides.legacy.push(a.label)
  }

  const gaps = asStringArray(record.gapsJson)
  const chip = mapParityVerdictToChip(record.parityVerdict)
  const verifierModel = record.verifierModel
  const verifiedAt = record.verifiedAt
  const verifiedRelativeId = formatRelativeId(verifiedAt, opts.nowMs)
  const summarySentenceId = buildLineageSummarySentence({
    chipKey: chip.key,
    verifierModel,
    verifiedRelativeId,
  })

  return {
    available: true,
    boardId: record.boardId,
    taskId: record.taskId,
    disposition: record.disposition,
    parityVerdict: record.parityVerdict,
    chip,
    summarySentenceId,
    verifierModel,
    verifiedAt,
    verifiedRelativeId,
    origin: {
      raw: originRaw,
      labelId: originLabelId(originRaw),
      denominatorReasonId: denominatorReasonId(originRaw, gapClass),
      coveredUnits,
      coveredUnitCount: coveredUnits.length,
      gapClass,
      legacyAnchors,
    },
    evidence: {
      legacy: sides.legacy,
      rebuild: sides.rebuild,
      gaps,
    },
    implementation: parseImplementation(record.implementationJson),
    technical: {
      repository: record.repository,
      featureContractId: record.featureContractId,
      acceptanceCovered: record.acceptanceCovered,
      sourceHash: record.sourceHash || null,
    },
  }
}

export function taskLineageUnavailable(
  boardId: string,
  taskId: string,
  reason: string,
): TaskLineageUnavailable {
  return {
    available: false,
    reason,
    boardId,
    taskId,
    emptyStateLabelId: TASK_LINEAGE_UNAVAILABLE_LABEL_ID,
  }
}

/**
 * Load per-task lineage via W-API-1 data access.
 * Graceful when tables missing or task not present.
 */
export async function loadTaskLineage(
  boardId: string,
  taskId: string,
  opts: {
    record?: RebuildLineageRecord | null
    forceUnavailable?: boolean
    unavailableReason?: string
    nowMs?: number
    tablesAvailable?: boolean
  } = {},
): Promise<TaskLineageData> {
  const bid = boardId.trim() || DEFAULT_BOARD_ID
  const tid = taskId.trim()
  if (!tid) {
    return taskLineageUnavailable(bid, tid, 'TASK_ID_REQUIRED')
  }

  if (opts.forceUnavailable) {
    return taskLineageUnavailable(
      bid,
      tid,
      opts.unavailableReason ?? REBUILD_DATA_TABLES_NOT_MIGRATED,
    )
  }

  if (opts.record !== undefined) {
    if (!opts.record) {
      return taskLineageUnavailable(bid, tid, 'TASK_LINEAGE_NOT_FOUND')
    }
    return projectTaskLineage(opts.record, { nowMs: opts.nowMs })
  }

  try {
    const access = getRebuildParityDataAccess()
    const tablesOk =
      opts.tablesAvailable ?? (await access.tablesAvailable().catch(() => false))
    if (!tablesOk) {
      return taskLineageUnavailable(bid, tid, REBUILD_DATA_TABLES_NOT_MIGRATED)
    }
    const rows = await access.listLineageByTaskIds(bid, [tid])
    const row = rows[0] ?? null
    if (!row) {
      return taskLineageUnavailable(bid, tid, 'TASK_LINEAGE_NOT_FOUND')
    }
    return projectTaskLineage(row, { nowMs: opts.nowMs })
  } catch {
    return taskLineageUnavailable(bid, tid, REBUILD_DATA_TABLES_NOT_MIGRATED)
  }
}

/** Server fn name per packet: getTaskLineageFn(taskId). */
export const getTaskLineageFn = createServerFn({ method: 'GET' })
  .validator(taskLineageArgs)
  .handler(async ({ data }): Promise<TaskLineageData> => {
    try {
      await requireView(data.boardId)
      return await loadTaskLineage(data.boardId, data.taskId)
    } catch (e) {
      if (e instanceof AuthError) {
        return taskLineageUnavailable(data.boardId, data.taskId, 'FORBIDDEN')
      }
      return taskLineageUnavailable(
        data.boardId,
        data.taskId,
        REBUILD_DATA_TABLES_NOT_MIGRATED,
      )
    }
  })

// ===========================================================================
// W-UI-5 — Grouped global search (Fitur / Tugas / Dokumen / Unit)
// SPEC-TM-KOMPAT-VISUAL-V1 §1 + §3.E. Narrow add-only; does not alter existing fns.
// ===========================================================================

const groupedSearchArgs = z.object({
  boardId: z.string().min(1),
  q: z.string().max(200).optional(),
  limit: z.number().int().min(1).max(100).optional(),
})

export type GroupedSearchEntityKey = 'fitur' | 'tugas' | 'dokumen' | 'unit'

export type GroupedSearchHitWire = {
  id: string
  title: string
  breadcrumb: string | null
  kind: GroupedSearchEntityKey
  kindLabelId: string
  href: string
  technicalAlias: string | null
}

export type GroupedSearchSectionWire = {
  key: GroupedSearchEntityKey
  labelId: string
  tone: string
  items: Array<GroupedSearchHitWire>
}

export type GroupedSearchUnavailable = {
  available: false
  reason: string
  boardId: string
  query: string
  sections: Array<GroupedSearchSectionWire>
  totalCount: number
  dataGaps: Array<string>
  emptyStateLabelId: string
}

export type GroupedSearchAvailable = {
  available: true
  boardId: string
  query: string
  sections: Array<GroupedSearchSectionWire>
  totalCount: number
  dataGaps: Array<string>
}

export type GroupedSearchData = GroupedSearchAvailable | GroupedSearchUnavailable

const SECTION_META: Record<
  GroupedSearchEntityKey,
  { labelId: string; tone: string }
> = {
  fitur: { labelId: 'Fitur', tone: 'accent' },
  tugas: { labelId: 'Tugas', tone: 'ok' },
  dokumen: { labelId: 'Dokumen', tone: 'warn' },
  unit: { labelId: 'Unit', tone: 'muted' },
}

const SECTION_ORDER: ReadonlyArray<GroupedSearchEntityKey> = [
  'fitur',
  'tugas',
  'dokumen',
  'unit',
]

function featureBreadcrumb(
  namaId: string | null | undefined,
  domainBisnis: string | null | undefined,
): string | null {
  const parts = [namaId, domainBisnis]
    .map((p) => (typeof p === 'string' ? p.trim() : ''))
    .filter((p) => p.length > 0)
  return parts.length ? parts.join(' · ') : null
}

function textBlob(...parts: Array<string | null | undefined>): string {
  return parts
    .filter((p): p is string => typeof p === 'string' && p.length > 0)
    .join('\n')
    .toLowerCase()
}

/** True when needle matches haystack tokens / substrings (id-ID + EN friendly). */
export function searchTextMatches(haystack: string, needle: string): boolean {
  const h = haystack.toLowerCase()
  const n = needle.toLowerCase().trim()
  if (!n) return false
  if (h.includes(n)) return true
  // Token split: "meditasi wellness" vs "meditation"
  const tokens = n.split(/[\s_./-]+/).filter((t) => t.length >= 3)
  if (tokens.length === 0) return false
  return tokens.every((t) => h.includes(t))
}

type FeatureJoinHints = {
  keywords: Array<string>
  idIncludes: Array<string>
}

function buildJoinHintsByFeatureId(
  seedEntries: ReadonlyArray<ProductFeatureSeedEntry> | null | undefined,
): Map<string, FeatureJoinHints> {
  const map = new Map<string, FeatureJoinHints>()
  for (const e of seedEntries ?? []) {
    const join = e.join
    map.set(e.feature_id, {
      keywords: (join?.keywords ?? []).map((k) => k.toLowerCase()),
      idIncludes: (join?.id_includes ?? []).map((k) => k.toUpperCase()),
    })
  }
  return map
}

function featureMatchesQuery(
  f: ProductFeatureRow,
  needle: string,
  hints: FeatureJoinHints | undefined,
): boolean {
  const caps = asStringArray(f.capabilitiesJson)
  const fcs = asStringArray(f.fcRefsJson)
  const hay = textBlob(
    f.featureId,
    f.namaId,
    f.domainBisnis,
    f.ringkasanId,
    ...caps,
    ...fcs,
  )
  if (searchTextMatches(hay, needle)) return true
  if (hints) {
    const n = needle.toLowerCase()
    for (const kw of hints.keywords) {
      if (!kw) continue
      if (n.includes(kw) || kw.includes(n)) return true
    }
    const nUp = needle.toUpperCase().replace(/[\s_-]+/g, '')
    if (nUp.length >= 3) {
      for (const id of hints.idIncludes) {
        const token = id.replace(/[\s_-]+/g, '')
        if (!token) continue
        if (token.includes(nUp) || nUp.includes(token)) return true
      }
    }
  }
  return false
}

/**
 * Pure grouped search projector over product_features + task maps + units + docs.
 * Never invents rows. Section order: Fitur → Tugas → Dokumen → Unit.
 * Meditation query lands feature first, then related tasks under Tugas with breadcrumb.
 */
export function projectGroupedSearch(input: {
  boardId: string
  query: string
  available: boolean
  reason?: string
  features?: ReadonlyArray<ProductFeatureRow>
  maps?: ReadonlyArray<FeatureTaskMapRow>
  units?: ReadonlyArray<FeatureUnitRow>
  directory?: ReadonlyArray<FeatureDirectoryRow>
  /** Optional seed join hints (keywords / id_includes) for synonym match. */
  seedEntries?: ReadonlyArray<ProductFeatureSeedEntry> | null
  limit?: number
}): GroupedSearchData {
  const boardId = input.boardId.trim() || DEFAULT_BOARD_ID
  const q = (input.query ?? '').trim()
  const limit = input.limit ?? 40
  const dataGaps: Array<string> = []

  if (!input.available) {
    return {
      available: false,
      reason: input.reason ?? REBUILD_DATA_TABLES_NOT_MIGRATED,
      boardId,
      query: q,
      sections: [],
      totalCount: 0,
      dataGaps: [
        'PRODUCT_SEARCH_TABLES_UNAVAILABLE — pin-flat grouping masih dipakai di UI',
      ],
      emptyStateLabelId: EMPTY_STATE_ID,
    }
  }

  if (!q) {
    return {
      available: true,
      boardId,
      query: '',
      sections: [],
      totalCount: 0,
      dataGaps: [],
    }
  }

  const features = input.features ?? []
  const maps = input.maps ?? []
  const units = input.units ?? []
  const directory = input.directory ?? []
  const hintsById = buildJoinHintsByFeatureId(input.seedEntries)

  const featureById = new Map(features.map((f) => [f.featureId, f] as const))
  const mapsByFeature = new Map<string, Array<FeatureTaskMapRow>>()
  const mapsByTask = new Map<string, Array<FeatureTaskMapRow>>()
  for (const m of maps) {
    const fl = mapsByFeature.get(m.featureId) ?? []
    fl.push(m)
    mapsByFeature.set(m.featureId, fl)
    const tl = mapsByTask.get(m.taskId) ?? []
    tl.push(m)
    mapsByTask.set(m.taskId, tl)
  }

  // FC → product feature (first ref wins for breadcrumb)
  const featureByFc = new Map<string, ProductFeatureRow>()
  for (const f of features) {
    for (const fc of asStringArray(f.fcRefsJson)) {
      if (!featureByFc.has(fc)) featureByFc.set(fc, f)
    }
  }

  const fiturHits: Array<GroupedSearchHitWire> = []
  const matchedFeatureIds = new Set<string>()

  for (const f of features) {
    if (!featureMatchesQuery(f, q, hintsById.get(f.featureId))) continue
    matchedFeatureIds.add(f.featureId)
    fiturHits.push({
      id: f.featureId,
      title: f.namaId,
      breadcrumb: featureBreadcrumb(f.namaId, f.domainBisnis),
      kind: 'fitur',
      kindLabelId: SECTION_META.fitur.labelId,
      href: featureDetailHref(boardId, f.featureId),
      technicalAlias: f.featureId,
    })
  }

  // Prefer exact id / nama starts-with first (meditation → Meditasi / FEAT-MEDITATION)
  const nLow = q.toLowerCase()
  fiturHits.sort((a, b) => {
    const aId = a.technicalAlias?.toLowerCase() ?? ''
    const bId = b.technicalAlias?.toLowerCase() ?? ''
    const aExact =
      aId.includes(nLow) || a.title.toLowerCase().includes(nLow) ? 0 : 1
    const bExact =
      bId.includes(nLow) || b.title.toLowerCase().includes(nLow) ? 0 : 1
    if (aExact !== bExact) return aExact - bExact
    return a.title.localeCompare(b.title, 'id')
  })

  const tugasHits: Array<GroupedSearchHitWire> = []
  const seenTasks = new Set<string>()

  // Tasks mapped to matched features (related tasks for meditation feature)
  for (const fid of matchedFeatureIds) {
    const f = featureById.get(fid)
    for (const m of mapsByFeature.get(fid) ?? []) {
      if (seenTasks.has(m.taskId)) continue
      seenTasks.add(m.taskId)
      tugasHits.push({
        id: m.taskId,
        title: m.taskId,
        breadcrumb: featureBreadcrumb(f?.namaId, f?.domainBisnis),
        kind: 'tugas',
        kindLabelId: SECTION_META.tugas.labelId,
        href: `/b/${encodeURIComponent(boardId)}/work/${encodeURIComponent(m.taskId)}`,
        technicalAlias: m.taskId,
      })
    }
  }

  // Direct task-id matches not already included
  for (const m of maps) {
    if (seenTasks.has(m.taskId)) continue
    if (!searchTextMatches(m.taskId, q)) continue
    seenTasks.add(m.taskId)
    const f = featureById.get(m.featureId)
    tugasHits.push({
      id: m.taskId,
      title: m.taskId,
      breadcrumb: featureBreadcrumb(f?.namaId, f?.domainBisnis),
      kind: 'tugas',
      kindLabelId: SECTION_META.tugas.labelId,
      href: `/b/${encodeURIComponent(boardId)}/work/${encodeURIComponent(m.taskId)}`,
      technicalAlias: m.taskId,
    })
  }

  const dokumenHits: Array<GroupedSearchHitWire> = []
  for (const d of directory) {
    const hay = textBlob(d.featureContractId, d.judulId, d.deliveryStatus)
    if (!searchTextMatches(hay, q)) {
      // Also include docs for matched features
      const parent = featureByFc.get(d.featureContractId)
      if (!parent || !matchedFeatureIds.has(parent.featureId)) continue
    }
    const parent = featureByFc.get(d.featureContractId)
    dokumenHits.push({
      id: d.featureContractId,
      title: d.judulId?.trim() || d.featureContractId,
      breadcrumb: featureBreadcrumb(parent?.namaId, parent?.domainBisnis),
      kind: 'dokumen',
      kindLabelId: SECTION_META.dokumen.labelId,
      href: featureDetailHref(boardId, parent?.featureId ?? d.featureContractId),
      technicalAlias: d.featureContractId,
    })
  }

  const unitHits: Array<GroupedSearchHitWire> = []
  for (const u of units) {
    const hay = textBlob(
      u.unitId,
      u.unitType,
      u.identifier,
      u.anchor,
      u.featureContractId,
      u.repo,
    )
    const parent = u.featureContractId
      ? featureByFc.get(u.featureContractId)
      : undefined
    const relatedToMatch =
      parent != null && matchedFeatureIds.has(parent.featureId)
    if (!searchTextMatches(hay, q) && !relatedToMatch) continue
    unitHits.push({
      id: u.unitId,
      title: u.identifier?.trim() || u.unitType?.trim() || u.unitId,
      breadcrumb: featureBreadcrumb(parent?.namaId, parent?.domainBisnis),
      kind: 'unit',
      kindLabelId: SECTION_META.unit.labelId,
      href: parent
        ? featureDetailHref(boardId, parent.featureId)
        : featureDirectoryHref(boardId),
      technicalAlias: u.unitId,
    })
  }

  if (features.length === 0) {
    dataGaps.push('PRODUCT_FEATURES_EMPTY — tidak ada baris product_features')
  }
  if (maps.length === 0) {
    dataGaps.push(
      'FEATURE_TASK_MAP_EMPTY — tugas terkait hanya dari pin-flat bila ada',
    )
  }
  if (units.length === 0) {
    dataGaps.push('FEATURE_UNITS_EMPTY — section Unit mungkin kosong')
  }
  if (directory.length === 0) {
    dataGaps.push('FEATURE_DIRECTORY_EMPTY — section Dokumen mungkin kosong')
  }

  const trim = (items: Array<GroupedSearchHitWire>) => items.slice(0, limit)
  const sections: Array<GroupedSearchSectionWire> = []
  const packs: Array<[GroupedSearchEntityKey, Array<GroupedSearchHitWire>]> = [
    ['fitur', trim(fiturHits)],
    ['tugas', trim(tugasHits)],
    ['dokumen', trim(dokumenHits)],
    ['unit', trim(unitHits)],
  ]
  for (const [key, items] of packs) {
    if (items.length === 0) continue
    sections.push({
      key,
      labelId: SECTION_META[key].labelId,
      tone: SECTION_META[key].tone,
      items,
    })
  }

  // Keep section order stable even if some empty
  sections.sort(
    (a, b) => SECTION_ORDER.indexOf(a.key) - SECTION_ORDER.indexOf(b.key),
  )

  const totalCount = sections.reduce((n, s) => n + s.items.length, 0)

  return {
    available: true,
    boardId,
    query: q,
    sections,
    totalCount,
    dataGaps,
  }
}

function tryLoadSeedEntries(): Array<ProductFeatureSeedEntry> | null {
  try {
    const seed = loadProductFeaturesSeed(defaultProductFeaturesSeedPath())
    return seed.features
  } catch {
    return null
  }
}

export async function loadGroupedSearch(
  boardId: string,
  q: string,
  opts: {
    features?: ReadonlyArray<ProductFeatureRow>
    maps?: ReadonlyArray<FeatureTaskMapRow>
    units?: ReadonlyArray<FeatureUnitRow>
    directory?: ReadonlyArray<FeatureDirectoryRow>
    seedEntries?: ReadonlyArray<ProductFeatureSeedEntry> | null
    forceUnavailable?: boolean
    limit?: number
  } = {},
): Promise<GroupedSearchData> {
  const bid = boardId.trim() || DEFAULT_BOARD_ID
  const query = (q ?? '').trim()
  if (opts.forceUnavailable) {
    return projectGroupedSearch({
      boardId: bid,
      query,
      available: false,
      limit: opts.limit,
    })
  }

  try {
    const access = getRebuildParityDataAccess()
    const tablesOk = await access.tablesAvailable().catch(() => false)
    if (!tablesOk && !opts.features) {
      return projectGroupedSearch({
        boardId: bid,
        query,
        available: false,
        reason: REBUILD_DATA_TABLES_NOT_MIGRATED,
        limit: opts.limit,
      })
    }

    const features =
      opts.features ??
      (await listProductFeatures({}).catch(() => [] as Array<ProductFeatureRow>))
    const maps =
      opts.maps ??
      (await listFeatureTaskMaps({}).catch(() => [] as Array<FeatureTaskMapRow>))

    let units = opts.units
    let directory = opts.directory
    if ((!units || !directory) && features.length > 0) {
      const allFc = new Set<string>()
      for (const f of features) {
        for (const r of asStringArray(f.fcRefsJson)) allFc.add(r)
      }
      const fcList = [...allFc]
      if (!units) {
        units = await access.listUnitsByFcIds(fcList).catch(() => [] as Array<FeatureUnitRow>)
      }
      if (!directory) {
        directory = await access
          .listDirectoryByFcIds(fcList)
          .catch(() => [] as Array<FeatureDirectoryRow>)
      }
    }

    const seedEntries =
      opts.seedEntries !== undefined ? opts.seedEntries : tryLoadSeedEntries()

    return projectGroupedSearch({
      boardId: bid,
      query,
      available: true,
      features,
      maps,
      units: units ?? [],
      directory: directory ?? [],
      seedEntries,
      limit: opts.limit,
    })
  } catch {
    return projectGroupedSearch({
      boardId: bid,
      query,
      available: false,
      reason: REBUILD_DATA_TABLES_NOT_MIGRATED,
      limit: opts.limit,
    })
  }
}

/** Narrow W-UI-5 server fn — product/rebuild grouped search only. */
export const getControlCenterGroupedSearchFn = createServerFn({ method: 'GET' })
  .validator(groupedSearchArgs)
  .handler(async ({ data }): Promise<GroupedSearchData> => {
    try {
      await requireView(data.boardId)
      return await loadGroupedSearch(data.boardId, data.q ?? '', {
        limit: data.limit,
      })
    } catch (e) {
      if (e instanceof AuthError) {
        return {
          available: false,
          reason: 'FORBIDDEN',
          boardId: data.boardId,
          query: data.q ?? '',
          sections: [],
          totalCount: 0,
          dataGaps: ['FORBIDDEN'],
          emptyStateLabelId: EMPTY_STATE_ID,
        }
      }
      return {
        available: false,
        reason: REBUILD_DATA_TABLES_NOT_MIGRATED,
        boardId: data.boardId,
        query: data.q ?? '',
        sections: [],
        totalCount: 0,
        dataGaps: [
          'PRODUCT_SEARCH_TABLES_UNAVAILABLE — pin-flat grouping masih dipakai di UI',
        ],
        emptyStateLabelId: EMPTY_STATE_ID,
      }
    }
  })
