/**
 * Domain knowledge graph + DomainKnowledgeBundle contract
 * (01A §DOMAIN KNOWLEDGE + MCP RETRIEVAL).
 *
 * Pure retrieval layer: versioned, cited, revision-consistent. Does not invent
 * relations or silently omit known coverage. Unknown/conflict → explicit gaps.
 * Live MCP auth catalog lives in rbac MCP_TOOL_SPECS (separate packet when needed).
 */

import { createHash } from 'node:crypto'

import {
  AFFILIATE_DOMAIN_ID,
  buildAffiliateDomainKnowledgeBundle,
  isAffiliateDomainId,
} from '#/server/domain-knowledge-affiliate'
import type { DomainKnowledgeBundle as AffiliateDomainKnowledgeBundle } from '#/server/domain-knowledge-affiliate'

export const DOMAIN_KNOWLEDGE_SCHEMA_VERSION =
  'DOMAIN_KNOWLEDGE_BUNDLE_V1' as const

export type KnowledgeState = 'PROVEN' | 'UNKNOWN' | 'CONFLICT' | 'STALE'

export type CoverageDisposition =
  | 'expected'
  | 'included'
  | 'redacted'
  | 'unknown'
  | 'conflict'
  | 'omitted-with-reason'

export type CoverageManifestEntry = {
  id: string
  kind: string
  label: string
  disposition: CoverageDisposition
  reason: string | null
  projectIds: ReadonlyArray<string>
  knowledgeState: KnowledgeState
}

export type DomainKnowledgeCitation = {
  field: string
  path: string
  note?: string
  knowledgeState?: KnowledgeState
}

export type DomainKnowledgeEntity = {
  id: string
  kind: string
  label: string
  projectId: string | null
  technicalRef: string | null
  knowledgeState: KnowledgeState
}

export type DomainKnowledgeRelation = {
  id: string
  fromId: string
  toId: string
  type: string
  label: string
  knowledgeState: KnowledgeState
}

export type DomainKnowledgeFeature = {
  id: string
  name: string
  projectId: string
  summary: string
  knowledgeState: KnowledgeState
  /** Human docs body (optional; falls back to summary). */
  documentation?: string
  /** Technical appendix keys (routes, tables, symbols). */
  technicalAppendix?: Record<string, unknown>
  aliases?: ReadonlyArray<string>
}

export type DomainKnowledgeFlow = {
  id: string
  name: string
  featureId: string
  projectIds: ReadonlyArray<string>
  nodes: ReadonlyArray<{ id: string; label: string; order: number }>
  outcomes: ReadonlyArray<string>
  knowledgeState: KnowledgeState
  /** Optional dependency ids (features/entities/flows). */
  dependencies?: ReadonlyArray<string>
  variants?: ReadonlyArray<string>
  readbacks?: ReadonlyArray<string>
}

export type DomainKnowledgeProject = {
  id: string
  name: string
  role: string
  knowledgeState: KnowledgeState
}

export type DomainKnowledgeHumanDisplay = {
  title: string
  summary: string
  boundarySentence: string
  ownerLanguage: 'id-ID' | string
}

/**
 * Versioned DomainKnowledgeBundle contract (01A §DOMAIN KNOWLEDGE + MCP RETRIEVAL).
 * domainId is free-form; AFFILIATE is the first complete pack.
 */
export type DomainKnowledgeBundle = {
  domainId: string
  humanDisplay: DomainKnowledgeHumanDisplay
  boundaries: ReadonlyArray<string>
  projects: ReadonlyArray<DomainKnowledgeProject>
  features: ReadonlyArray<DomainKnowledgeFeature>
  flows: ReadonlyArray<DomainKnowledgeFlow>
  entities: ReadonlyArray<DomainKnowledgeEntity>
  relations: ReadonlyArray<DomainKnowledgeRelation>
  statusRollup: {
    knowledgeState: KnowledgeState
    featureCount: number
    flowCount: number
    projectCount: number
    gapCount: number
    coverageIncluded: number
    coverageExpected: number
  }
  blockers: ReadonlyArray<{
    id: string
    title: string
    knowledgeState: KnowledgeState
  }>
  decisions: ReadonlyArray<{ id: string; title: string; status: string }>
  evidence: ReadonlyArray<{ id: string; kind: string; summary: string }>
  knowledgeGaps: ReadonlyArray<{
    id: string
    code: string
    message: string
    knowledgeState: KnowledgeState
  }>
  coverageManifest: ReadonlyArray<CoverageManifestEntry>
  citations: ReadonlyArray<DomainKnowledgeCitation>
  snapshotId: string
  revision: number
  sourceHash: string
  generatedAt: string
  freshness: {
    ageSeconds: number | null
    stale: boolean
    staleReason: string | null
  }
  redactions: ReadonlyArray<{ field: string; reason: string }>
  schemaVersion: typeof DOMAIN_KNOWLEDGE_SCHEMA_VERSION | string
  availability: 'available' | 'partial' | 'unavailable'
  /** Optional stable search aliases for the domain itself. */
  aliases?: ReadonlyArray<string>
  /** Actor-attributed revision history (when known). */
  changeHistory?: ReadonlyArray<DomainKnowledgeChangeEntry>
}

export type DomainKnowledgeChangeEntry = {
  revision: number
  at: string
  actor: string
  action: string
  entityId: string | null
  entityKind: string | null
  summary: string
  sourceHash: string | null
}

export type KnowledgeSearchMode = 'exact' | 'keyword' | 'semantic' | 'alias'

export type KnowledgeSearchHit = {
  id: string
  kind: string
  title: string
  domainId: string
  projectId: string | null
  matchReason: string
  mode: KnowledgeSearchMode
  knowledgeState: KnowledgeState
  citation: DomainKnowledgeCitation
  score: number
}

export type DomainKnowledgeErrorCode =
  | 'DOMAIN_NOT_FOUND'
  | 'FEATURE_NOT_FOUND'
  | 'FLOW_NOT_FOUND'
  | 'ENTITY_NOT_FOUND'
  | 'MIXED_REVISION'
  | 'STALE_PIN'
  | 'INVALID_INPUT'
  | 'UNKNOWN_SEARCH_MODE'

export class DomainKnowledgeError extends Error {
  readonly code: DomainKnowledgeErrorCode
  readonly details: Record<string, unknown>

  constructor(
    code: DomainKnowledgeErrorCode,
    message: string,
    details: Record<string, unknown> = {},
  ) {
    super(message)
    this.name = 'DomainKnowledgeError'
    this.code = code
    this.details = details
  }
}

export const DEFAULT_KNOWLEDGE_PAGE_SIZE = 50
export const MAX_KNOWLEDGE_PAGE_SIZE = 200

/** Required MCP read tool names (01A). export_documentation is TM-04. */
export const DOMAIN_KNOWLEDGE_MCP_TOOL_NAMES = [
  'search_knowledge',
  'get_domain_overview',
  'list_domain_features',
  'get_feature_documentation',
  'get_feature_flow',
  'get_related_entities',
  'get_change_history',
] as const

export type DomainKnowledgeMcpToolName =
  (typeof DOMAIN_KNOWLEDGE_MCP_TOOL_NAMES)[number]

const SEMANTIC_SYNONYMS: Partial<Record<string, ReadonlyArray<string>>> = {
  affiliate: ['afiliasi', 'aff', 'referral', 'mitra', 'partner'],
  afiliasi: ['affiliate', 'aff', 'referral', 'mitra'],
  kyc: ['verifikasi', 'verification', 'identity', 'identitas'],
  commission: ['komisi', 'payout', 'pembayaran', 'settlement'],
  komisi: ['commission', 'payout', 'pembayaran'],
  voucher: ['kode', 'code', 'coupon', 'promo'],
  webhook: ['callback', 'hook', 'provider'],
  login: ['masuk', 'auth', 'authentication', 'signin'],
  registration: ['registrasi', 'daftar', 'signup', 'onboarding'],
  registrasi: ['registration', 'daftar', 'signup'],
  payment: ['pembayaran', 'provider', 'checkout', 'bayar'],
  pembayaran: ['payment', 'checkout', 'provider'],
}

export type DomainPackLoader = (opts?: {
  snapshotId?: string
  revision?: number
  sourceHash?: string
  generatedAt?: string
}) => DomainKnowledgeBundle

const packLoaders = new Map<string, DomainPackLoader>()

function normalizeDomainKey(domainId: string): string {
  return domainId.trim().toUpperCase()
}

/**
 * Register a domain pack loader (tests + additional domains).
 * AFFILIATE is pre-registered from domain-knowledge-affiliate.
 */
export function registerDomainPack(
  domainId: string,
  loader: DomainPackLoader,
): void {
  packLoaders.set(normalizeDomainKey(domainId), loader)
}

/** Test helper: clear non-builtin packs. AFFILIATE remains. */
export function resetDomainPacksForTests(): void {
  packLoaders.clear()
  registerBuiltinAffiliatePack()
}

function registerBuiltinAffiliatePack(): void {
  registerDomainPack(AFFILIATE_DOMAIN_ID, (opts) => {
    const built = buildAffiliateDomainKnowledgeBundle({
      snapshotId: opts?.snapshotId,
      revision: opts?.revision,
      sourceHash: opts?.sourceHash,
      generatedAt: opts?.generatedAt,
    })
    return affiliateToGeneralBundle(built)
  })
  // Aliases resolved via isAffiliateDomainId / resolveDomainId
}

registerBuiltinAffiliatePack()

function affiliateToGeneralBundle(
  b: AffiliateDomainKnowledgeBundle,
): DomainKnowledgeBundle {
  return {
    ...b,
    domainId: b.domainId,
    schemaVersion: b.schemaVersion,
    aliases: [
      AFFILIATE_DOMAIN_ID,
      'AFF',
      'AFFILIATE-REBUILD',
      'afiliasi',
      'mitra',
    ],
    changeHistory: buildDefaultChangeHistory(b),
  }
}

function buildDefaultChangeHistory(
  b: Pick<
    DomainKnowledgeBundle,
    | 'revision'
    | 'generatedAt'
    | 'sourceHash'
    | 'snapshotId'
    | 'knowledgeGaps'
    | 'coverageManifest'
  >,
): DomainKnowledgeChangeEntry[] {
  const entries: DomainKnowledgeChangeEntry[] = [
    {
      revision: b.revision,
      at: b.generatedAt,
      actor: 'system:domain-knowledge',
      action: 'BUNDLE_PINNED',
      entityId: null,
      entityKind: 'domain',
      summary: `Pinned DomainKnowledgeBundle snapshot ${b.snapshotId}`,
      sourceHash: b.sourceHash,
    },
  ]
  for (const gap of b.knowledgeGaps.slice(0, 20)) {
    entries.push({
      revision: b.revision,
      at: b.generatedAt,
      actor: 'system:domain-knowledge',
      action: 'GAP_DECLARED',
      entityId: gap.id,
      entityKind: 'knowledgeGap',
      summary: `${gap.code}: ${gap.message}`,
      sourceHash: b.sourceHash,
    })
  }
  for (const cov of b.coverageManifest
    .filter((c) => c.disposition !== 'included')
    .slice(0, 20)) {
    entries.push({
      revision: b.revision,
      at: b.generatedAt,
      actor: 'system:domain-knowledge',
      action: 'COVERAGE_DISPOSITION',
      entityId: cov.id,
      entityKind: cov.kind,
      summary: `${cov.disposition}: ${cov.label}${cov.reason ? ` — ${cov.reason}` : ''}`,
      sourceHash: b.sourceHash,
    })
  }
  return entries
}

export function listRegisteredDomainIds(): string[] {
  return [...packLoaders.keys()].sort()
}

/** Extra human/alias keys for AFFILIATE beyond isAffiliateDomainId. */
const AFFILIATE_RESOLVE_ALIASES = new Set([
  'AFFILIATE',
  'AFF',
  'AFFILIATE-REBUILD',
  'AFILIASI',
  'MITRA',
  'PARTNER',
])

export function resolveDomainId(domainId: string): string | null {
  const raw = domainId.trim()
  if (!raw) return null
  const key = normalizeDomainKey(raw)
  if (isAffiliateDomainId(raw) || AFFILIATE_RESOLVE_ALIASES.has(key)) {
    return AFFILIATE_DOMAIN_ID
  }
  if (packLoaders.has(key)) return key
  // Case-insensitive pack match
  for (const id of packLoaders.keys()) {
    if (id === key) return id
  }
  return null
}

export type LoadBundleOptions = {
  snapshotId?: string
  revision?: number
  sourceHash?: string
  generatedAt?: string
  /** When set, must equal bundle.revision or fail MIXED_REVISION. */
  expectedRevision?: number
  /** When true (default), refuse stale freshness. */
  refuseStale?: boolean
}

export function loadDomainBundle(
  domainId: string,
  opts: LoadBundleOptions = {},
): DomainKnowledgeBundle {
  const resolved = resolveDomainId(domainId)
  if (!resolved) {
    throw new DomainKnowledgeError(
      'DOMAIN_NOT_FOUND',
      `domain not found: ${domainId}`,
      {
        domainId,
        registered: listRegisteredDomainIds(),
      },
    )
  }
  const loader = packLoaders.get(normalizeDomainKey(resolved))
  if (!loader) {
    throw new DomainKnowledgeError(
      'DOMAIN_NOT_FOUND',
      `domain pack loader missing: ${resolved}`,
      {
        domainId: resolved,
      },
    )
  }
  const bundle = loader({
    snapshotId: opts.snapshotId,
    revision: opts.revision,
    sourceHash: opts.sourceHash,
    generatedAt: opts.generatedAt,
  })
  assertRevisionConsistency(bundle, opts.expectedRevision)
  assertNotStale(bundle, opts.refuseStale !== false)
  return bundle
}

export function assertRevisionConsistency(
  bundle: DomainKnowledgeBundle,
  expectedRevision?: number,
): void {
  if (expectedRevision == null) return
  if (bundle.revision !== expectedRevision) {
    throw new DomainKnowledgeError(
      'MIXED_REVISION',
      `revision token mismatch: expected ${expectedRevision}, bundle has ${bundle.revision}`,
      {
        expectedRevision,
        bundleRevision: bundle.revision,
        snapshotId: bundle.snapshotId,
        sourceHash: bundle.sourceHash,
      },
    )
  }
}

export function assertNotStale(
  bundle: DomainKnowledgeBundle,
  refuseStale = true,
): void {
  if (!refuseStale) return
  if (bundle.freshness.stale) {
    throw new DomainKnowledgeError(
      'STALE_PIN',
      bundle.freshness.staleReason ?? 'DomainKnowledgeBundle pin is stale',
      {
        snapshotId: bundle.snapshotId,
        sourceHash: bundle.sourceHash,
        revision: bundle.revision,
        staleReason: bundle.freshness.staleReason,
      },
    )
  }
}

export function boundPageSize(pageSize?: number): number {
  if (pageSize == null || !Number.isFinite(pageSize))
    return DEFAULT_KNOWLEDGE_PAGE_SIZE
  const n = Math.floor(pageSize)
  if (n < 1) return 1
  return Math.min(n, MAX_KNOWLEDGE_PAGE_SIZE)
}

export type CursorPage<T> = {
  items: T[]
  nextCursor: string | null
  pageSize: number
  total: number
}

export function paginateItems<T>(
  items: ReadonlyArray<T>,
  opts: { cursor?: string | null; pageSize?: number } = {},
): CursorPage<T> {
  const pageSize = boundPageSize(opts.pageSize)
  let start = 0
  if (opts.cursor != null && opts.cursor !== '') {
    const decoded = Number.parseInt(opts.cursor, 10)
    if (!Number.isFinite(decoded) || decoded < 0) {
      throw new DomainKnowledgeError(
        'INVALID_INPUT',
        `invalid cursor: ${opts.cursor}`,
        {
          cursor: opts.cursor,
        },
      )
    }
    start = decoded
  }
  const slice = items.slice(start, start + pageSize)
  const next = start + pageSize
  return {
    items: [...slice],
    nextCursor: next < items.length ? String(next) : null,
    pageSize,
    total: items.length,
  }
}

function normalizeQuery(q: string): string {
  return q.trim().toLowerCase()
}

function tokenize(q: string): string[] {
  return normalizeQuery(q)
    .split(/[^a-z0-9_./{}-]+/i)
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
}

function expandSemanticTokens(tokens: string[]): Set<string> {
  const out = new Set<string>()
  for (const t of tokens) {
    out.add(t)
    const syn = SEMANTIC_SYNONYMS[t]
    if (syn) for (const s of syn) out.add(s.toLowerCase())
    for (const [key, vals] of Object.entries(SEMANTIC_SYNONYMS)) {
      if (!vals) continue
      if (vals.some((v) => v.toLowerCase() === t)) {
        out.add(key)
        for (const s of vals) out.add(s.toLowerCase())
      }
    }
  }
  return out
}

type IndexRow = {
  id: string
  kind: string
  title: string
  domainId: string
  projectId: string | null
  knowledgeState: KnowledgeState
  aliases: string[]
  haystack: string
  citation: DomainKnowledgeCitation
}

function indexBundle(bundle: DomainKnowledgeBundle): IndexRow[] {
  const rows: IndexRow[] = []
  const domainId = bundle.domainId

  rows.push({
    id: domainId,
    kind: 'domain',
    title: bundle.humanDisplay.title,
    domainId,
    projectId: null,
    knowledgeState: bundle.statusRollup.knowledgeState,
    aliases: [...(bundle.aliases ?? []), domainId],
    haystack: [
      domainId,
      bundle.humanDisplay.title,
      bundle.humanDisplay.summary,
      bundle.humanDisplay.boundarySentence,
      ...bundle.boundaries,
      ...(bundle.aliases ?? []),
    ]
      .join(' ')
      .toLowerCase(),
    citation: {
      field: 'domain',
      path: `domain.${domainId}`,
      note: bundle.humanDisplay.title,
      knowledgeState: bundle.statusRollup.knowledgeState,
    },
  })

  for (const p of bundle.projects) {
    rows.push({
      id: p.id,
      kind: 'project',
      title: p.name,
      domainId,
      projectId: p.id,
      knowledgeState: p.knowledgeState,
      aliases: [p.id, p.name],
      haystack: [p.id, p.name, p.role].join(' ').toLowerCase(),
      citation: {
        field: 'project',
        path: `projects.${p.id}`,
        note: p.name,
        knowledgeState: p.knowledgeState,
      },
    })
  }

  for (const f of bundle.features) {
    rows.push({
      id: f.id,
      kind: 'feature',
      title: f.name,
      domainId,
      projectId: f.projectId,
      knowledgeState: f.knowledgeState,
      aliases: [f.id, f.name, ...(f.aliases ?? [])],
      haystack: [
        f.id,
        f.name,
        f.summary,
        f.projectId,
        ...(f.aliases ?? []),
        f.documentation ?? '',
      ]
        .join(' ')
        .toLowerCase(),
      citation: {
        field: 'feature',
        path: `features.${f.id}`,
        note: f.name,
        knowledgeState: f.knowledgeState,
      },
    })
  }

  for (const fl of bundle.flows) {
    rows.push({
      id: fl.id,
      kind: 'flow',
      title: fl.name,
      domainId,
      projectId: fl.projectIds[0] ?? null,
      knowledgeState: fl.knowledgeState,
      aliases: [fl.id, fl.name, fl.featureId],
      haystack: [
        fl.id,
        fl.name,
        fl.featureId,
        ...fl.projectIds,
        ...fl.nodes.map((n) => n.label),
        ...fl.outcomes,
        ...(fl.dependencies ?? []),
        ...(fl.variants ?? []),
        ...(fl.readbacks ?? []),
      ]
        .join(' ')
        .toLowerCase(),
      citation: {
        field: 'flow',
        path: `flows.${fl.id}`,
        note: fl.name,
        knowledgeState: fl.knowledgeState,
      },
    })
  }

  for (const e of bundle.entities) {
    rows.push({
      id: e.id,
      kind: e.kind || 'entity',
      title: e.label,
      domainId,
      projectId: e.projectId,
      knowledgeState: e.knowledgeState,
      aliases: [e.id, e.label, e.technicalRef ?? ''].filter(Boolean),
      haystack: [e.id, e.label, e.kind, e.technicalRef ?? '', e.projectId ?? '']
        .join(' ')
        .toLowerCase(),
      citation: {
        field: 'entity',
        path: `entities.${e.id}`,
        note: e.label,
        knowledgeState: e.knowledgeState,
      },
    })
  }

  for (const r of bundle.relations) {
    rows.push({
      id: r.id,
      kind: 'relation',
      title: r.label,
      domainId,
      projectId: null,
      knowledgeState: r.knowledgeState,
      aliases: [r.id, r.type, r.fromId, r.toId],
      haystack: [r.id, r.label, r.type, r.fromId, r.toId]
        .join(' ')
        .toLowerCase(),
      citation: {
        field: 'relation',
        path: `relations.${r.id}`,
        note: r.label,
        knowledgeState: r.knowledgeState,
      },
    })
  }

  return rows
}

function scoreExact(row: IndexRow, q: string): number {
  const nq = normalizeQuery(q)
  if (!nq) return 0
  if (row.id.toLowerCase() === nq) return 100
  if (row.title.toLowerCase() === nq) return 95
  if (row.aliases.some((a) => a.toLowerCase() === nq)) return 90
  return 0
}

function scoreKeyword(row: IndexRow, q: string): number {
  const nq = normalizeQuery(q)
  if (!nq) return 0
  if (row.haystack.includes(nq)) {
    if (row.id.toLowerCase().includes(nq)) return 80
    if (row.title.toLowerCase().includes(nq)) return 70
    return 50
  }
  const tokens = tokenize(q)
  if (tokens.length === 0) return 0
  let hits = 0
  for (const t of tokens) {
    if (row.haystack.includes(t)) hits += 1
  }
  if (hits === 0) return 0
  return Math.min(60, Math.round((hits / tokens.length) * 60))
}

function scoreAlias(row: IndexRow, q: string): number {
  const nq = normalizeQuery(q)
  if (!nq) return 0
  for (const a of row.aliases) {
    const al = a.toLowerCase()
    if (al === nq) return 100
    if (al.includes(nq) || nq.includes(al)) return 75
  }
  return 0
}

function scoreSemantic(row: IndexRow, q: string): number {
  const tokens = tokenize(q)
  if (tokens.length === 0) return 0
  const expanded = expandSemanticTokens(tokens)
  let hits = 0
  for (const t of expanded) {
    if (row.haystack.includes(t)) hits += 1
  }
  if (hits === 0) return scoreKeyword(row, q) * 0.5
  return Math.min(
    85,
    Math.round((hits / expanded.size) * 85) + scoreKeyword(row, q) * 0.1,
  )
}

export type SearchKnowledgeInput = {
  query: string
  mode?: KnowledgeSearchMode | 'all'
  domainId?: string
  pageSize?: number
  cursor?: string | null
  expectedRevision?: number
  refuseStale?: boolean
}

export type SearchKnowledgeResult = {
  ok: true
  query: string
  mode: KnowledgeSearchMode | 'all'
  hits: KnowledgeSearchHit[]
  nextCursor: string | null
  pageSize: number
  total: number
  revision: number | null
  snapshotId: string | null
  sourceHash: string | null
  domainsSearched: string[]
}

export function searchKnowledge(
  input: SearchKnowledgeInput,
): SearchKnowledgeResult {
  const query = input.query.trim()
  if (!query) {
    throw new DomainKnowledgeError('INVALID_INPUT', 'query is required', {})
  }
  const rawMode = String(input.mode ?? 'all')
  if (
    rawMode !== 'all' &&
    rawMode !== 'exact' &&
    rawMode !== 'keyword' &&
    rawMode !== 'semantic' &&
    rawMode !== 'alias'
  ) {
    throw new DomainKnowledgeError(
      'UNKNOWN_SEARCH_MODE',
      `unknown search mode: ${rawMode}`,
      {
        mode: rawMode,
      },
    )
  }
  const mode = rawMode

  let domainIds: string[]
  if (input.domainId) {
    const resolved = resolveDomainId(input.domainId)
    if (!resolved) {
      throw new DomainKnowledgeError(
        'DOMAIN_NOT_FOUND',
        `domain not found: ${input.domainId}`,
        {
          domainId: input.domainId,
        },
      )
    }
    domainIds = [resolved]
  } else {
    domainIds = listRegisteredDomainIds()
  }

  const allHits: KnowledgeSearchHit[] = []
  let revision: number | null = null
  let snapshotId: string | null = null
  let sourceHash: string | null = null

  for (const d of domainIds) {
    const bundle = loadDomainBundle(d, {
      expectedRevision: input.expectedRevision,
      refuseStale: input.refuseStale,
    })
    revision = bundle.revision
    snapshotId = bundle.snapshotId
    sourceHash = bundle.sourceHash
    const rows = indexBundle(bundle)

    for (const row of rows) {
      const modes: KnowledgeSearchMode[] =
        mode === 'all' ? ['exact', 'alias', 'keyword', 'semantic'] : [mode]
      let best: {
        mode: KnowledgeSearchMode
        score: number
        reason: string
      } | null = null
      for (const m of modes) {
        let score = 0
        let reason: string = m
        if (m === 'exact') {
          score = scoreExact(row, query)
          reason = score > 0 ? 'exact id/title/alias' : m
        } else if (m === 'alias') {
          score = scoreAlias(row, query)
          reason = score > 0 ? 'alias match' : m
        } else if (m === 'keyword') {
          score = scoreKeyword(row, query)
          reason = score > 0 ? 'keyword haystack' : m
        } else {
          score = scoreSemantic(row, query)
          reason = score > 0 ? 'semantic/synonym token overlap' : m
        }
        if (score > 0 && (!best || score > best.score)) {
          best = { mode: m, score, reason }
        }
      }
      if (best) {
        allHits.push({
          id: row.id,
          kind: row.kind,
          title: row.title,
          domainId: row.domainId,
          projectId: row.projectId,
          matchReason: best.reason,
          mode: best.mode,
          knowledgeState: row.knowledgeState,
          citation: row.citation,
          score: best.score,
        })
      }
    }
  }

  allHits.sort(
    (a, b) =>
      b.score - a.score ||
      a.domainId.localeCompare(b.domainId) ||
      a.id.localeCompare(b.id),
  )

  // Dedupe by domainId+kind+id keeping highest score
  const seen = new Set<string>()
  const deduped: KnowledgeSearchHit[] = []
  for (const h of allHits) {
    const k = `${h.domainId}::${h.kind}::${h.id}`
    if (seen.has(k)) continue
    seen.add(k)
    deduped.push(h)
  }

  const page = paginateItems(deduped, {
    cursor: input.cursor,
    pageSize: input.pageSize,
  })
  return {
    ok: true,
    query,
    mode,
    hits: page.items,
    nextCursor: page.nextCursor,
    pageSize: page.pageSize,
    total: page.total,
    revision,
    snapshotId,
    sourceHash,
    domainsSearched: domainIds,
  }
}

export type DomainOverviewResult = {
  ok: true
  domainId: string
  humanDisplay: DomainKnowledgeHumanDisplay
  boundaries: ReadonlyArray<string>
  coverageManifest: ReadonlyArray<CoverageManifestEntry>
  statusRollup: DomainKnowledgeBundle['statusRollup']
  knowledgeGaps: DomainKnowledgeBundle['knowledgeGaps']
  freshness: DomainKnowledgeBundle['freshness']
  blockers: DomainKnowledgeBundle['blockers']
  decisions: DomainKnowledgeBundle['decisions']
  evidence: DomainKnowledgeBundle['evidence']
  redactions: DomainKnowledgeBundle['redactions']
  availability: DomainKnowledgeBundle['availability']
  projects: ReadonlyArray<DomainKnowledgeProject>
  snapshotId: string
  revision: number
  sourceHash: string
  generatedAt: string
  citations: ReadonlyArray<DomainKnowledgeCitation>
  schemaVersion: string
}

export function getDomainOverview(
  domainId: string,
  opts: LoadBundleOptions = {},
): DomainOverviewResult {
  const bundle = loadDomainBundle(domainId, opts)
  return {
    ok: true,
    domainId: bundle.domainId,
    humanDisplay: bundle.humanDisplay,
    boundaries: bundle.boundaries,
    coverageManifest: bundle.coverageManifest,
    statusRollup: bundle.statusRollup,
    knowledgeGaps: bundle.knowledgeGaps,
    freshness: bundle.freshness,
    blockers: bundle.blockers,
    decisions: bundle.decisions,
    evidence: bundle.evidence,
    redactions: bundle.redactions,
    availability: bundle.availability,
    projects: bundle.projects,
    snapshotId: bundle.snapshotId,
    revision: bundle.revision,
    sourceHash: bundle.sourceHash,
    generatedAt: bundle.generatedAt,
    citations: bundle.citations,
    schemaVersion: bundle.schemaVersion,
  }
}

export type ListDomainFeaturesResult = {
  ok: true
  domainId: string
  features: DomainKnowledgeFeature[]
  nextCursor: string | null
  pageSize: number
  total: number
  revision: number
  snapshotId: string
  sourceHash: string
  crossProject: true
}

export function listDomainFeatures(
  domainId: string,
  opts: LoadBundleOptions & {
    cursor?: string | null
    pageSize?: number
    projectId?: string
  } = {},
): ListDomainFeaturesResult {
  const bundle = loadDomainBundle(domainId, opts)
  let features = [...bundle.features]
  if (opts.projectId) {
    features = features.filter((f) => f.projectId === opts.projectId)
  }
  // Stable cross-project inventory order: projectId then id
  features.sort(
    (a, b) =>
      a.projectId.localeCompare(b.projectId) || a.id.localeCompare(b.id),
  )
  const page = paginateItems(features, {
    cursor: opts.cursor,
    pageSize: opts.pageSize,
  })
  return {
    ok: true,
    domainId: bundle.domainId,
    features: page.items,
    nextCursor: page.nextCursor,
    pageSize: page.pageSize,
    total: page.total,
    revision: bundle.revision,
    snapshotId: bundle.snapshotId,
    sourceHash: bundle.sourceHash,
    crossProject: true,
  }
}

export type FeatureDocumentationResult = {
  ok: true
  domainId: string
  feature: DomainKnowledgeFeature
  humanDocumentation: string
  technicalAppendix: Record<string, unknown>
  relatedFlows: DomainKnowledgeFlow[]
  relatedEntities: DomainKnowledgeEntity[]
  citations: DomainKnowledgeCitation[]
  revision: number
  snapshotId: string
  sourceHash: string
  knowledgeState: KnowledgeState
}

export function getFeatureDocumentation(
  domainId: string,
  featureId: string,
  opts: LoadBundleOptions = {},
): FeatureDocumentationResult {
  const bundle = loadDomainBundle(domainId, opts)
  const feature = bundle.features.find(
    (f) => f.id === featureId || f.id.toLowerCase() === featureId.toLowerCase(),
  )
  if (!feature) {
    throw new DomainKnowledgeError(
      'FEATURE_NOT_FOUND',
      `feature not found: ${featureId}`,
      {
        domainId: bundle.domainId,
        featureId,
      },
    )
  }
  const relatedFlows = bundle.flows.filter((fl) => fl.featureId === feature.id)
  const flowEntityIds = new Set<string>()
  for (const fl of relatedFlows) {
    for (const n of fl.nodes) flowEntityIds.add(n.id)
    for (const d of fl.dependencies ?? []) flowEntityIds.add(d)
  }
  const relatedEntities = bundle.entities.filter(
    (e) =>
      e.projectId === feature.projectId ||
      flowEntityIds.has(e.id) ||
      (e.technicalRef &&
        feature.summary.toLowerCase().includes(e.technicalRef.toLowerCase())),
  )
  const citations = bundle.citations.filter(
    (c) =>
      c.path.includes(feature.id) ||
      c.field === 'feature' ||
      relatedFlows.some((fl) => c.path.includes(fl.id)),
  )
  if (citations.length === 0) {
    citations.push({
      field: 'feature',
      path: `features.${feature.id}`,
      note: feature.name,
      knowledgeState: feature.knowledgeState,
    })
  }
  return {
    ok: true,
    domainId: bundle.domainId,
    feature,
    humanDocumentation: feature.documentation?.trim() || feature.summary,
    technicalAppendix: {
      featureId: feature.id,
      projectId: feature.projectId,
      knowledgeState: feature.knowledgeState,
      flowIds: relatedFlows.map((f) => f.id),
      ...(feature.technicalAppendix ?? {}),
    },
    relatedFlows,
    relatedEntities,
    citations,
    revision: bundle.revision,
    snapshotId: bundle.snapshotId,
    sourceHash: bundle.sourceHash,
    knowledgeState: feature.knowledgeState,
  }
}

export type FeatureFlowResult = {
  ok: true
  domainId: string
  flow: DomainKnowledgeFlow
  orderedNodes: Array<{ id: string; label: string; order: number }>
  variants: ReadonlyArray<string>
  dependencies: ReadonlyArray<string>
  outcomes: ReadonlyArray<string>
  readbacks: ReadonlyArray<string>
  feature: DomainKnowledgeFeature | null
  revision: number
  snapshotId: string
  sourceHash: string
  knowledgeState: KnowledgeState
  citations: DomainKnowledgeCitation[]
}

export function getFeatureFlow(
  domainId: string,
  opts: LoadBundleOptions & { flowId?: string; featureId?: string } = {},
): FeatureFlowResult {
  const bundle = loadDomainBundle(domainId, opts)
  let flow: DomainKnowledgeFlow | undefined
  if (opts.flowId) {
    flow = bundle.flows.find(
      (f) =>
        f.id === opts.flowId ||
        f.id.toLowerCase() === opts.flowId!.toLowerCase(),
    )
  } else if (opts.featureId) {
    const flows = bundle.flows
      .filter(
        (f) =>
          f.featureId === opts.featureId ||
          f.featureId.toLowerCase() === opts.featureId!.toLowerCase(),
      )
      .slice()
      .sort((a, b) => a.id.localeCompare(b.id))
    flow = flows[0]
  }
  if (!flow) {
    throw new DomainKnowledgeError(
      'FLOW_NOT_FOUND',
      `flow not found (flowId=${opts.flowId ?? ''} featureId=${opts.featureId ?? ''})`,
      {
        domainId: bundle.domainId,
        flowId: opts.flowId,
        featureId: opts.featureId,
      },
    )
  }
  const orderedNodes = [...flow.nodes].sort(
    (a, b) => a.order - b.order || a.id.localeCompare(b.id),
  )
  const feature = bundle.features.find((f) => f.id === flow.featureId) ?? null
  return {
    ok: true,
    domainId: bundle.domainId,
    flow,
    orderedNodes,
    variants: flow.variants ?? [],
    dependencies: flow.dependencies ?? [],
    outcomes: flow.outcomes,
    readbacks: flow.readbacks ?? [],
    feature,
    revision: bundle.revision,
    snapshotId: bundle.snapshotId,
    sourceHash: bundle.sourceHash,
    knowledgeState: flow.knowledgeState,
    citations: [
      {
        field: 'flow',
        path: `flows.${flow.id}`,
        note: flow.name,
        knowledgeState: flow.knowledgeState,
      },
    ],
  }
}

export type RelatedEntitiesResult = {
  ok: true
  domainId: string
  entityId: string
  entity:
    DomainKnowledgeEntity | DomainKnowledgeFeature | DomainKnowledgeFlow | null
  entityKind: string
  incoming: DomainKnowledgeRelation[]
  outgoing: DomainKnowledgeRelation[]
  dependencyGraph: {
    nodes: Array<{ id: string; kind: string; label: string }>
    edges: Array<{ id: string; fromId: string; toId: string; type: string }>
  }
  revision: number
  snapshotId: string
  sourceHash: string
}

export function getRelatedEntities(
  domainId: string,
  entityId: string,
  opts: LoadBundleOptions = {},
): RelatedEntitiesResult {
  const bundle = loadDomainBundle(domainId, opts)
  const id = entityId.trim()
  if (!id) {
    throw new DomainKnowledgeError('INVALID_INPUT', 'entityId is required', {})
  }

  const feature = bundle.features.find((f) => f.id === id)
  const flow = bundle.flows.find((f) => f.id === id)
  const entity = bundle.entities.find((e) => e.id === id)
  const project = bundle.projects.find((p) => p.id === id)

  const resolvedEntity: RelatedEntitiesResult['entity'] =
    entity ?? feature ?? flow ?? null
  let entityKind =
    entity?.kind ??
    (feature ? 'feature' : flow ? 'flow' : project ? 'project' : 'unknown')

  if (!resolvedEntity && !project && id !== bundle.domainId) {
    // Still return empty relations if id appears only as relation endpoint
    const mentioned = bundle.relations.some(
      (r) => r.fromId === id || r.toId === id,
    )
    if (!mentioned) {
      throw new DomainKnowledgeError(
        'ENTITY_NOT_FOUND',
        `entity not found: ${id}`,
        {
          domainId: bundle.domainId,
          entityId: id,
        },
      )
    }
    entityKind = 'referenced'
  }

  const incoming = bundle.relations.filter((r) => r.toId === id)
  const outgoing = bundle.relations.filter((r) => r.fromId === id)
  const relatedIds = new Set<string>([id])
  for (const r of [...incoming, ...outgoing]) {
    relatedIds.add(r.fromId)
    relatedIds.add(r.toId)
  }

  const labelOf = (nid: string): { kind: string; label: string } => {
    const e = bundle.entities.find((x) => x.id === nid)
    if (e) return { kind: e.kind || 'entity', label: e.label }
    const f = bundle.features.find((x) => x.id === nid)
    if (f) return { kind: 'feature', label: f.name }
    const fl = bundle.flows.find((x) => x.id === nid)
    if (fl) return { kind: 'flow', label: fl.name }
    const p = bundle.projects.find((x) => x.id === nid)
    if (p) return { kind: 'project', label: p.name }
    if (nid === bundle.domainId)
      return { kind: 'domain', label: bundle.humanDisplay.title }
    return { kind: 'unknown', label: nid }
  }

  const nodes = [...relatedIds].map((nid) => {
    const meta = labelOf(nid)
    return { id: nid, kind: meta.kind, label: meta.label }
  })
  nodes.sort((a, b) => a.id.localeCompare(b.id))

  const edges = [...incoming, ...outgoing]
    .map((r) => ({ id: r.id, fromId: r.fromId, toId: r.toId, type: r.type }))
    .sort((a, b) => a.id.localeCompare(b.id))

  return {
    ok: true,
    domainId: bundle.domainId,
    entityId: id,
    entity: resolvedEntity,
    entityKind,
    incoming,
    outgoing,
    dependencyGraph: { nodes, edges },
    revision: bundle.revision,
    snapshotId: bundle.snapshotId,
    sourceHash: bundle.sourceHash,
  }
}

export type ChangeHistoryResult = {
  ok: true
  domainId: string
  entityId: string | null
  entries: DomainKnowledgeChangeEntry[]
  nextCursor: string | null
  pageSize: number
  total: number
  revision: number
  snapshotId: string
  sourceHash: string
}

export function getChangeHistory(
  domainId: string,
  opts: LoadBundleOptions & {
    entityId?: string | null
    cursor?: string | null
    pageSize?: number
  } = {},
): ChangeHistoryResult {
  const bundle = loadDomainBundle(domainId, opts)
  let entries = [...(bundle.changeHistory ?? buildDefaultChangeHistory(bundle))]
  if (opts.entityId) {
    const eid = opts.entityId
    entries = entries.filter((e) => e.entityId === eid || e.entityId == null)
  }
  // Newest revision first, stable secondary
  entries.sort(
    (a, b) =>
      b.revision - a.revision ||
      b.at.localeCompare(a.at) ||
      a.action.localeCompare(b.action),
  )
  const page = paginateItems(entries, {
    cursor: opts.cursor,
    pageSize: opts.pageSize,
  })
  return {
    ok: true,
    domainId: bundle.domainId,
    entityId: opts.entityId ?? null,
    entries: page.items,
    nextCursor: page.nextCursor,
    pageSize: page.pageSize,
    total: page.total,
    revision: bundle.revision,
    snapshotId: bundle.snapshotId,
    sourceHash: bundle.sourceHash,
  }
}

/** Full bundle fetch (for export / internal). Same fail-closed rules. */
export function getDomainKnowledgeBundle(
  domainId: string,
  opts: LoadBundleOptions = {},
): DomainKnowledgeBundle {
  return loadDomainBundle(domainId, opts)
}

/** Content hash of a serializable payload (tests / pin binding helpers). */
export function hashDomainKnowledgePayload(payload: unknown): string {
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex')
}

export function isDomainKnowledgeBundle(
  v: unknown,
): v is DomainKnowledgeBundle {
  if (!v || typeof v !== 'object') return false
  const o = v as Record<string, unknown>
  return (
    typeof o.domainId === 'string' &&
    typeof o.snapshotId === 'string' &&
    typeof o.revision === 'number' &&
    typeof o.sourceHash === 'string' &&
    Array.isArray(o.features) &&
    Array.isArray(o.coverageManifest)
  )
}
