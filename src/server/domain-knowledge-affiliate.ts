/**
 * TM-03: Deterministic AFFILIATE DomainKnowledgeBundle + coverage manifest.
 *
 * Spec: 01A §AFFILIATE DOMAIN ACCEPTANCE; ART S13/S14/S17.
 * domainId=AFFILIATE traverses business relations across portal, Sales, backend,
 * public web, payment, jobs/emails, and readbacks — not projectId=affiliate only.
 *
 * Pure data module: no DB I/O. Pin/live hits may enrich status; they never invent
 * G5 readiness. Every known feature/flow is listed or appears in coverageManifest
 * as omitted-with-reason / unknown / conflict.
 */

export const AFFILIATE_DOMAIN_ID = 'AFFILIATE' as const

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
}

export type DomainKnowledgeFlow = {
  id: string
  name: string
  featureId: string
  projectIds: ReadonlyArray<string>
  nodes: ReadonlyArray<{ id: string; label: string; order: number }>
  outcomes: ReadonlyArray<string>
  knowledgeState: KnowledgeState
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
  ownerLanguage: 'id-ID'
}

/**
 * Versioned DomainKnowledgeBundle contract (01A §DOMAIN KNOWLEDGE + MCP RETRIEVAL).
 */
export type DomainKnowledgeBundle = {
  domainId: typeof AFFILIATE_DOMAIN_ID
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
  /** Schema marker for consumers / fixtures. */
  schemaVersion: 'DOMAIN_KNOWLEDGE_BUNDLE_V1'
  availability: 'available' | 'partial' | 'unavailable'
}

export type AffiliateBundleBuildOptions = {
  /** Deterministic clock; defaults to fixed staging stamp for reproducibility. */
  generatedAt?: string
  snapshotId?: string
  revision?: number
  sourceHash?: string
  /** Optional live pin enrichment (task/decision/evidence hits). */
  pinHits?: {
    projects?: ReadonlyArray<{
      id: string
      name: string | null
      taskCount?: number
    }>
    features?: ReadonlyArray<{ id: string; name: string | null }>
    tasks?: ReadonlyArray<{
      taskId: string
      title: string
      bucket?: string | null
      ownerPrimaryTitle?: string | null
    }>
    decisions?: ReadonlyArray<{
      decisionId: string
      title: string
      status?: string
    }>
    evidence?: ReadonlyArray<{ id: string; kind: string; summary: string }>
    stale?: boolean
    staleReason?: string | null
    freshnessAgeSeconds?: number | null
  }
}

/** Fixed staging stamp so fixture + pure build stay bit-stable without a clock. */
export const AFFILIATE_BUNDLE_GENERATED_AT = '2026-07-14T00:00:00.000Z'
export const AFFILIATE_BUNDLE_SNAPSHOT_ID = 'dkb-affiliate-v1'
export const AFFILIATE_BUNDLE_REVISION = 1
export const AFFILIATE_BUNDLE_SOURCE_HASH =
  'aff_dkb_v1_7c3e9a2b1d4f6085e9c1a0b7d6e5f4a3'

const PROJECTS: ReadonlyArray<DomainKnowledgeProject> = [
  {
    id: 'affiliate-rebuild',
    name: 'Portal Affiliate',
    role: 'Affiliate registration, activation, login, profile, and member portal UX',
    knowledgeState: 'PROVEN',
  },
  {
    id: 'sales-rebuild',
    name: 'Panel Sales',
    role: 'KYC, verification, contracts, invitations, commission readback for sales ops',
    knowledgeState: 'PROVEN',
  },
  {
    id: 'rebuild-backend',
    name: 'Backend dan Layanan Inti',
    role: 'Referral attribution, commission engine, payout, webhook, reconciliation',
    knowledgeState: 'PROVEN',
  },
  {
    id: 'mfs-web-original-upgrade',
    name: 'Web Publik',
    role: 'Public /a/{code}, voucher persistence, web checkout entry',
    knowledgeState: 'PROVEN',
  },
  {
    id: 'payment-provider',
    name: 'Jalur Pembayaran Provider',
    role: 'Provider payment paths and settlement callbacks for affiliate-attributed orders',
    knowledgeState: 'PROVEN',
  },
]

const FEATURES: ReadonlyArray<DomainKnowledgeFeature> = [
  {
    id: 'feat-aff-reg-activate',
    name: 'Registrasi dan aktivasi affiliate',
    projectId: 'affiliate-rebuild',
    summary: 'Daftar, aktivasi akun, login, dan profil portal affiliate.',
    knowledgeState: 'PROVEN',
  },
  {
    id: 'feat-aff-portal',
    name: 'Portal affiliate (dashboard, aset, tautan)',
    projectId: 'affiliate-rebuild',
    summary: 'Dashboard anggota, aset pemasaran, dan tautan referral.',
    knowledgeState: 'PROVEN',
  },
  {
    id: 'feat-sales-kyc',
    name: 'KYC dan verifikasi Sales',
    projectId: 'sales-rebuild',
    summary:
      'Verifikasi identitas, kontrak, undangan, dan readback komisi di panel Sales.',
    knowledgeState: 'PROVEN',
  },
  {
    id: 'feat-sales-commission-readback',
    name: 'Readback komisi Sales',
    projectId: 'sales-rebuild',
    summary: 'Tampilan komisi/undangan yang selaras dengan engine backend.',
    knowledgeState: 'PROVEN',
  },
  {
    id: 'feat-be-referral-attr',
    name: 'Atribusi referral backend',
    projectId: 'rebuild-backend',
    summary:
      'Menautkan kode affiliate ke order/checkout dan menyimpan jejak atribusi.',
    knowledgeState: 'PROVEN',
  },
  {
    id: 'feat-be-commission-payout',
    name: 'Komisi, payout, webhook, rekonsiliasi',
    projectId: 'rebuild-backend',
    summary:
      'Hitung komisi, payout, webhook provider, dan rekonsiliasi ledger.',
    knowledgeState: 'PROVEN',
  },
  {
    id: 'feat-web-public-code',
    name: 'Public /a/{code} dan voucher',
    projectId: 'mfs-web-original-upgrade',
    summary: 'Landing kode affiliate, persistensi voucher, masuk checkout web.',
    knowledgeState: 'PROVEN',
  },
  {
    id: 'feat-pay-provider-paths',
    name: 'Jalur pembayaran provider',
    projectId: 'payment-provider',
    summary: 'Path pembayaran provider untuk order beratribusi affiliate.',
    knowledgeState: 'PROVEN',
  },
  {
    id: 'feat-jobs-emails-outcomes',
    name: 'Jobs, email, dan outcome status',
    projectId: 'rebuild-backend',
    summary:
      'Job async + email notifikasi; outcome success/fail/expired/refund/revoke/recurring.',
    knowledgeState: 'PROVEN',
  },
  {
    id: 'feat-readbacks',
    name: 'Readback member, admin, DB, email, provider, audit',
    projectId: 'rebuild-backend',
    summary:
      'Cross-surface readback untuk member/admin/DB/email/provider/audit.',
    knowledgeState: 'PROVEN',
  },
]

const FLOWS: ReadonlyArray<DomainKnowledgeFlow> = [
  {
    id: 'flow-aff-onboard',
    name: 'Onboarding affiliate end-to-end',
    featureId: 'feat-aff-reg-activate',
    projectIds: ['affiliate-rebuild', 'sales-rebuild', 'rebuild-backend'],
    nodes: [
      { id: 'n-reg', label: 'Registrasi portal', order: 1 },
      { id: 'n-kyc', label: 'KYC / verifikasi Sales', order: 2 },
      { id: 'n-contract', label: 'Kontrak / undangan', order: 3 },
      { id: 'n-activate', label: 'Aktivasi + login portal', order: 4 },
    ],
    outcomes: ['activated', 'rejected', 'pending_verification'],
    knowledgeState: 'PROVEN',
  },
  {
    id: 'flow-aff-referral-checkout',
    name: 'Referral → checkout → pembayaran',
    featureId: 'feat-be-referral-attr',
    projectIds: [
      'mfs-web-original-upgrade',
      'rebuild-backend',
      'payment-provider',
      'affiliate-rebuild',
    ],
    nodes: [
      { id: 'n-code', label: 'Public /a/{code}', order: 1 },
      { id: 'n-voucher', label: 'Persistensi voucher', order: 2 },
      { id: 'n-checkout', label: 'Web checkout', order: 3 },
      { id: 'n-pay', label: 'Provider payment', order: 4 },
      { id: 'n-attr', label: 'Atribusi + komisi', order: 5 },
    ],
    outcomes: ['success', 'fail', 'expired', 'refund', 'revoke', 'recurring'],
    knowledgeState: 'PROVEN',
  },
  {
    id: 'flow-aff-payout-reconcile',
    name: 'Payout dan rekonsiliasi',
    featureId: 'feat-be-commission-payout',
    projectIds: ['rebuild-backend', 'sales-rebuild', 'payment-provider'],
    nodes: [
      { id: 'n-comm', label: 'Hitung komisi', order: 1 },
      { id: 'n-webhook', label: 'Webhook settlement', order: 2 },
      { id: 'n-payout', label: 'Payout', order: 3 },
      { id: 'n-recon', label: 'Rekonsiliasi + audit readback', order: 4 },
    ],
    outcomes: ['paid', 'failed', 'held', 'reconciled'],
    knowledgeState: 'PROVEN',
  },
]

const ENTITIES: ReadonlyArray<DomainKnowledgeEntity> = [
  {
    id: 'ent-affiliate-user',
    kind: 'actor',
    label: 'Affiliate member',
    projectId: 'affiliate-rebuild',
    technicalRef: 'affiliate_users',
    knowledgeState: 'PROVEN',
  },
  {
    id: 'ent-sales-ops',
    kind: 'actor',
    label: 'Sales operator',
    projectId: 'sales-rebuild',
    technicalRef: 'sales_ops',
    knowledgeState: 'PROVEN',
  },
  {
    id: 'ent-referral-code',
    kind: 'code',
    label: 'Kode referral /a/{code}',
    projectId: 'mfs-web-original-upgrade',
    technicalRef: '/a/{code}',
    knowledgeState: 'PROVEN',
  },
  {
    id: 'ent-voucher',
    kind: 'record',
    label: 'Voucher affiliate',
    projectId: 'rebuild-backend',
    technicalRef: 'vouchers',
    knowledgeState: 'PROVEN',
  },
  {
    id: 'ent-commission-ledger',
    kind: 'record',
    label: 'Ledger komisi',
    projectId: 'rebuild-backend',
    technicalRef: 'affiliate_user_contract_commissions',
    knowledgeState: 'PROVEN',
  },
  {
    id: 'ent-provider-payment',
    kind: 'integration',
    label: 'Provider payment',
    projectId: 'payment-provider',
    technicalRef: 'provider.payment',
    knowledgeState: 'PROVEN',
  },
  {
    id: 'ent-webhook',
    kind: 'integration',
    label: 'Webhook settlement',
    projectId: 'rebuild-backend',
    technicalRef: 'webhooks.payment',
    knowledgeState: 'PROVEN',
  },
  {
    id: 'ent-email-job',
    kind: 'job',
    label: 'Email / async job',
    projectId: 'rebuild-backend',
    technicalRef: 'jobs.email',
    knowledgeState: 'PROVEN',
  },
]

const RELATIONS: ReadonlyArray<DomainKnowledgeRelation> = [
  {
    id: 'rel-portal-sales-kyc',
    fromId: 'feat-aff-reg-activate',
    toId: 'feat-sales-kyc',
    type: 'depends_on',
    label: 'Aktivasi portal bergantung verifikasi Sales',
    knowledgeState: 'PROVEN',
  },
  {
    id: 'rel-code-attr',
    fromId: 'feat-web-public-code',
    toId: 'feat-be-referral-attr',
    type: 'feeds',
    label: 'Kode publik mengisi atribusi backend',
    knowledgeState: 'PROVEN',
  },
  {
    id: 'rel-attr-commission',
    fromId: 'feat-be-referral-attr',
    toId: 'feat-be-commission-payout',
    type: 'feeds',
    label: 'Atribusi memicu komisi/payout',
    knowledgeState: 'PROVEN',
  },
  {
    id: 'rel-pay-webhook',
    fromId: 'feat-pay-provider-paths',
    toId: 'feat-be-commission-payout',
    type: 'notifies',
    label: 'Pembayaran provider → webhook rekonsiliasi',
    knowledgeState: 'PROVEN',
  },
  {
    id: 'rel-commission-sales-readback',
    fromId: 'feat-be-commission-payout',
    toId: 'feat-sales-commission-readback',
    type: 'readback',
    label: 'Ledger komisi dibaca panel Sales',
    knowledgeState: 'PROVEN',
  },
  {
    id: 'rel-jobs-outcomes',
    fromId: 'feat-jobs-emails-outcomes',
    toId: 'feat-readbacks',
    type: 'readback',
    label: 'Outcome job/email terlihat di readback audit',
    knowledgeState: 'PROVEN',
  },
  {
    id: 'rel-portal-dashboard-comm',
    fromId: 'feat-be-commission-payout',
    toId: 'feat-aff-portal',
    type: 'readback',
    label: 'Komisi dibaca dashboard portal affiliate',
    knowledgeState: 'PROVEN',
  },
]

const BOUNDARIES: ReadonlyArray<string> = [
  'Domain AFFILIATE mencakup relasi bisnis lintas proyek, bukan hanya projectId=affiliate.',
  'Portal: registrasi, aktivasi, login, profil, dashboard anggota.',
  'Sales: KYC, verifikasi, kontrak, undangan, readback komisi.',
  'Backend: atribusi referral, komisi, payout, webhook, rekonsiliasi.',
  'Web publik: /a/{code}, voucher, checkout.',
  'Pembayaran provider + outcome success/fail/expired/refund/revoke/recurring.',
  'Readback: member, admin, DB, email, provider, audit.',
  'HOLD/EXCLUDE: G5 pass/fail inventari tidak diganti oleh knowledge pack ini.',
]

function buildBaseCoverageManifest(): CoverageManifestEntry[] {
  const entries: CoverageManifestEntry[] = []
  for (const p of PROJECTS) {
    entries.push({
      id: `cov-project-${p.id}`,
      kind: 'project',
      label: p.name,
      disposition: 'included',
      reason: null,
      projectIds: [p.id],
      knowledgeState: p.knowledgeState,
    })
  }
  for (const f of FEATURES) {
    entries.push({
      id: `cov-feature-${f.id}`,
      kind: 'feature',
      label: f.name,
      disposition: 'included',
      reason: null,
      projectIds: [f.projectId],
      knowledgeState: f.knowledgeState,
    })
  }
  for (const fl of FLOWS) {
    entries.push({
      id: `cov-flow-${fl.id}`,
      kind: 'flow',
      label: fl.name,
      disposition: 'included',
      reason: null,
      projectIds: [...fl.projectIds],
      knowledgeState: fl.knowledgeState,
    })
  }
  // Explicit expected + honest unknown/omission slots (no silent drop).
  entries.push({
    id: 'cov-expected-recurring-billing-detail',
    kind: 'outcome-detail',
    label: 'Rincian billing recurring per provider',
    disposition: 'expected',
    reason:
      'Outcome recurring disebut di spek; detail per-provider belum diikat ke pin SSOT.',
    projectIds: ['payment-provider', 'rebuild-backend'],
    knowledgeState: 'UNKNOWN',
  })
  entries.push({
    id: 'cov-conflict-commission-formula',
    kind: 'rule',
    label: 'Formula komisi legacy vs rebuild',
    disposition: 'conflict',
    reason:
      'Dua sumber ter-sitasi tidak sepakat (legacy SSOT vs rebuild SSOT); certainty diblok sampai resolusi.',
    projectIds: ['rebuild-backend', 'sales-rebuild'],
    knowledgeState: 'CONFLICT',
  })
  entries.push({
    id: 'cov-unknown-tier-bonus-rules',
    kind: 'rule',
    label: 'Aturan bonus tier affiliate per kampanye',
    disposition: 'unknown',
    reason:
      'Aturan bonus tier per kampanye belum punya citasi SSOT pin yang PROVEN.',
    projectIds: ['affiliate-rebuild', 'sales-rebuild'],
    knowledgeState: 'UNKNOWN',
  })
  entries.push({
    id: 'cov-redacted-pii-kyc-payload',
    kind: 'payload',
    label: 'Payload PII KYC mentah',
    disposition: 'redacted',
    reason: 'RBAC/redaction: PII KYC tidak diekspor di knowledge pack default.',
    projectIds: ['sales-rebuild'],
    knowledgeState: 'PROVEN',
  })
  entries.push({
    id: 'cov-omit-device-native-apps',
    kind: 'surface',
    label: 'Aplikasi native mobile affiliate',
    disposition: 'omitted-with-reason',
    reason:
      'Di luar boundary domain web/portal/Sales/backend spek 01A AFFILIATE.',
    projectIds: [],
    knowledgeState: 'PROVEN',
  })
  return entries
}

function buildBaseCitations(): DomainKnowledgeCitation[] {
  return [
    {
      field: 'spec',
      path: '01A§AFFILIATE_DOMAIN_ACCEPTANCE',
      note: 'Cross-project AFFILIATE acceptance',
      knowledgeState: 'PROVEN',
    },
    {
      field: 'art',
      path: 'S13/S14/S17',
      note: 'Knowledge + documentation domain screens',
      knowledgeState: 'PROVEN',
    },
    {
      field: 'taxonomy',
      path: 'human-display.PROJECT_LABELS.affiliate-rebuild',
      note: 'Portal Affiliate',
      knowledgeState: 'PROVEN',
    },
    {
      field: 'public-route',
      path: '/a/{code}',
      note: 'Public affiliate code entry',
      knowledgeState: 'PROVEN',
    },
    {
      field: 'domain-module',
      path: 'src/server/domain-knowledge-affiliate.ts',
      note: 'Deterministic DomainKnowledgeBundle source',
      knowledgeState: 'PROVEN',
    },
  ]
}

function buildBaseGaps(): DomainKnowledgeBundle['knowledgeGaps'] {
  return [
    {
      id: 'gap-recurring-provider-detail',
      code: 'UNKNOWN_RECURRING_PROVIDER_DETAIL',
      message:
        'Outcome recurring disebut di spek; rincian billing per provider belum terikat SSOT pin.',
      knowledgeState: 'UNKNOWN',
    },
    {
      id: 'gap-legacy-commission-formula',
      code: 'CONFLICT_COMMISSION_FORMULA',
      message:
        'Formula komisi legacy vs rebuild CONFLICT: dua sumber ter-sitasi tidak sepakat; certainty diblok.',
      knowledgeState: 'CONFLICT',
    },
    {
      id: 'gap-kyc-pii-redacted',
      code: 'REDACTED_KYC_PII',
      message:
        'Payload PII KYC diredaksi dari export knowledge default (bukan silent omit).',
      knowledgeState: 'PROVEN',
    },
  ]
}

export function isAffiliateDomainId(
  domain: string | null | undefined,
): boolean {
  if (!domain) return false
  const d = domain.trim().toUpperCase()
  return d === AFFILIATE_DOMAIN_ID || d === 'AFF' || d === 'AFFILIATE-REBUILD'
}

/**
 * Build a deterministic AFFILIATE DomainKnowledgeBundle.
 * Optional pinHits enrich decisions/evidence/blockers without inventing G5 pass.
 */
export function buildAffiliateDomainKnowledgeBundle(
  opts: AffiliateBundleBuildOptions = {},
): DomainKnowledgeBundle {
  const generatedAt = opts.generatedAt ?? AFFILIATE_BUNDLE_GENERATED_AT
  const snapshotId = opts.snapshotId ?? AFFILIATE_BUNDLE_SNAPSHOT_ID
  const revision = opts.revision ?? AFFILIATE_BUNDLE_REVISION
  const sourceHash = opts.sourceHash ?? AFFILIATE_BUNDLE_SOURCE_HASH
  const pin = opts.pinHits

  const knowledgeGaps = [...buildBaseGaps()]
  if (pin) {
    const taskN = pin.tasks?.length ?? 0
    const decN = pin.decisions?.length ?? 0
    const evN = pin.evidence?.length ?? 0
    if (taskN === 0) {
      knowledgeGaps.push({
        id: 'gap-pin-no-tasks',
        code: 'NO_MATCHING_PIN_TASKS',
        message:
          'Pin board saat ini tidak punya task hit domain AFFILIATE (pack tetap tersedia).',
        knowledgeState: 'UNKNOWN',
      })
    }
    if (decN === 0) {
      knowledgeGaps.push({
        id: 'gap-pin-no-decisions',
        code: 'NO_MATCHING_PIN_DECISIONS',
        message:
          'Pin board saat ini tidak punya decision hit domain AFFILIATE.',
        knowledgeState: 'UNKNOWN',
      })
    }
    if (evN === 0) {
      knowledgeGaps.push({
        id: 'gap-pin-no-evidence',
        code: 'NO_MATCHING_PIN_EVIDENCE',
        message:
          'Pin board saat ini tidak punya evidence hit domain AFFILIATE.',
        knowledgeState: 'UNKNOWN',
      })
    }
    if (pin.stale) {
      knowledgeGaps.push({
        id: 'gap-pin-stale',
        code: 'PIN_STALE',
        message: pin.staleReason ?? 'Pinned control-center data is stale.',
        knowledgeState: 'STALE',
      })
    }
  }

  const decisions =
    pin?.decisions?.map((d) => ({
      id: d.decisionId,
      title: d.title,
      status: d.status ?? 'UNKNOWN',
    })) ?? []

  const evidence =
    pin?.evidence?.map((e) => ({
      id: e.id,
      kind: e.kind,
      summary: e.summary,
    })) ?? []

  const blockers =
    pin?.tasks
      ?.filter((t) => (t.bucket ?? '').toUpperCase() === 'BLOCKED')
      .map((t) => ({
        id: t.taskId,
        title: t.ownerPrimaryTitle || t.title,
        knowledgeState: 'PROVEN' as const,
      })) ?? []

  const coverageManifest = buildBaseCoverageManifest()
  const included = coverageManifest.filter(
    (e) => e.disposition === 'included',
  ).length
  const expected = coverageManifest.filter(
    (e) => e.disposition === 'expected' || e.disposition === 'included',
  ).length

  const hasUnknownOrConflict = coverageManifest.some(
    (e) => e.disposition === 'unknown' || e.disposition === 'conflict',
  )
  const availability: DomainKnowledgeBundle['availability'] =
    hasUnknownOrConflict ? 'partial' : 'available'

  const citations = [
    ...buildBaseCitations(),
    ...(pin?.tasks ?? []).slice(0, 20).map((t) => ({
      field: 'pin.task',
      path: `workRows.${t.taskId}`,
      note: t.ownerPrimaryTitle || t.title,
      knowledgeState: 'PROVEN' as const,
    })),
  ]

  return {
    schemaVersion: 'DOMAIN_KNOWLEDGE_BUNDLE_V1',
    domainId: AFFILIATE_DOMAIN_ID,
    humanDisplay: {
      title: 'Affiliate',
      summary:
        'Domain bisnis lintas portal affiliate, Sales, backend, web publik, pembayaran, jobs/email, dan readback — bukan satu projectId saja.',
      boundarySentence:
        'AFFILIATE menjangkau registrasi/aktivasi portal, KYC Sales, atribusi/komisi backend, /a/{code}+checkout web, provider payment, dan outcome/readback.',
      ownerLanguage: 'id-ID',
    },
    boundaries: [...BOUNDARIES],
    projects: [...PROJECTS],
    features: [...FEATURES],
    flows: [...FLOWS],
    entities: [...ENTITIES],
    relations: [...RELATIONS],
    statusRollup: {
      knowledgeState: hasUnknownOrConflict ? 'UNKNOWN' : 'PROVEN',
      featureCount: FEATURES.length,
      flowCount: FLOWS.length,
      projectCount: PROJECTS.length,
      gapCount: knowledgeGaps.length,
      coverageIncluded: included,
      coverageExpected: expected,
    },
    blockers,
    decisions,
    evidence,
    knowledgeGaps,
    coverageManifest,
    citations,
    snapshotId,
    revision,
    sourceHash,
    generatedAt,
    freshness: {
      ageSeconds: pin?.freshnessAgeSeconds ?? null,
      stale: pin?.stale ?? false,
      staleReason: pin?.staleReason ?? null,
    },
    redactions: [
      {
        field: 'kyc.pii_payload',
        reason: 'PII KYC diredaksi dari DomainKnowledgeBundle default (RBAC).',
      },
    ],
    availability,
  }
}

/**
 * UI/MCP presentation slice: maps bundle → control-center knowledge domain payload fields.
 * Preserves pin-hit rows when provided; always surfaces pack projects/features/graph.
 */
/**
 * Multi-source CONFLICT projector for knowledge UI (ART S21 / TM-08).
 * Emits both cited sources when coverage/gaps declare CONFLICT — never invents a solo conflict.
 */
export function projectKnowledgeConflictsFromBundle(
  bundle: DomainKnowledgeBundle,
): Array<{
  sourceId: string
  label: string
  citation: string | null
  claim: string | null
}> {
  const conflictEntries = bundle.coverageManifest.filter(
    (c) => c.disposition === 'conflict' || c.knowledgeState === 'CONFLICT',
  )
  const conflictGaps = bundle.knowledgeGaps.filter(
    (g) => g.knowledgeState === 'CONFLICT',
  )
  if (conflictEntries.length === 0 && conflictGaps.length === 0) return []

  // Honest dual-source pair for commission formula CONFLICT (cited pack paths).
  const dualCommission =
    conflictEntries.some((c) => c.id.includes('commission')) ||
    conflictGaps.some((g) => g.code.includes('COMMISSION'))
  if (dualCommission) {
    return [
      {
        sourceId: 'legacy-commission-ssot',
        label: 'Legacy commission SSOT',
        citation: 'legacy:commission.formula',
        claim: 'Formula komisi legacy (portal/Sales) sebagai acuan historis.',
      },
      {
        sourceId: 'rebuild-commission-ssot',
        label: 'Rebuild commission SSOT',
        citation: 'rebuild-backend:commission.formula',
        claim:
          'Formula komisi rebuild-backend sebagai acuan target; belum di-reconcile.',
      },
    ]
  }

  // Generic: one entry per conflict coverage row is not enough for multi-source UI;
  // pair with the gap message when present.
  const out: Array<{
    sourceId: string
    label: string
    citation: string | null
    claim: string | null
  }> = []
  for (const c of conflictEntries) {
    out.push({
      sourceId: c.id,
      label: c.label,
      citation: c.id,
      claim: c.reason,
    })
  }
  for (const g of conflictGaps) {
    out.push({
      sourceId: g.id,
      label: g.code,
      citation: g.id,
      claim: g.message,
    })
  }
  return out
}

export function projectKnowledgeRedactionsFromBundle(
  bundle: DomainKnowledgeBundle,
): Array<{ fieldPath: string; reason: string; hiddenScope: string | null }> {
  const fromBundle = bundle.redactions.map((r) => ({
    fieldPath: r.field,
    reason: r.reason,
    hiddenScope: r.field,
  }))
  const fromCoverage = bundle.coverageManifest
    .filter((c) => c.disposition === 'redacted')
    .map((c) => ({
      fieldPath: c.id,
      reason: c.reason ?? 'REDACTED',
      hiddenScope: c.label,
    }))
  // Prefer structured bundle redactions; coverage fills gaps only.
  if (fromBundle.length > 0) return fromBundle
  return fromCoverage
}

export function affiliateBundleToKnowledgeDomainData(
  bundle: DomainKnowledgeBundle,
  pinHits?: AffiliateBundleBuildOptions['pinHits'],
): {
  domain: string
  domainId: typeof AFFILIATE_DOMAIN_ID
  title: string
  summary: string
  availability: 'available' | 'partial' | 'unavailable'
  surfaceState: 'populated' | 'partial' | 'stale' | 'empty'
  projects: Array<{ id: string; name: string | null; taskCount: number }>
  features: Array<{ id: string; name: string | null }>
  tasks: Array<{
    taskId: string
    title: string
    bucket: string | null
    ownerPrimaryTitle: string | null
  }>
  decisions: Array<{ decisionId: string; title: string; status: string }>
  evidence: Array<{ id: string; kind: string; summary: string }>
  gaps: string[]
  knowledgeGaps: DomainKnowledgeBundle['knowledgeGaps']
  coverageManifest: DomainKnowledgeBundle['coverageManifest']
  relations: DomainKnowledgeBundle['relations']
  flows: DomainKnowledgeBundle['flows']
  entities: DomainKnowledgeBundle['entities']
  boundaries: DomainKnowledgeBundle['boundaries']
  statusRollup: DomainKnowledgeBundle['statusRollup']
  citations: DomainKnowledgeBundle['citations']
  blockers: DomainKnowledgeBundle['blockers']
  humanDisplay: DomainKnowledgeBundle['humanDisplay']
  /** Structured multi-source conflicts for ART S21 panel (pass-through). */
  conflicts: Array<{
    sourceId: string
    label: string
    citation: string | null
    claim: string | null
  }>
  /** Structured redaction disclosures for ART S21 panel. */
  redactions: Array<{
    fieldPath: string
    reason: string
    hiddenScope: string | null
  }>
  knowledgeState: KnowledgeState
  lastValidGeneratedAt: string | null
  bundle: DomainKnowledgeBundle
} {
  const packProjects: Array<{
    id: string
    name: string | null
    taskCount: number
  }> = bundle.projects.map((p) => {
    const hit = pinHits?.projects?.find((x) => x.id === p.id)
    return {
      id: p.id,
      name: hit?.name ?? p.name,
      taskCount: hit?.taskCount ?? 0,
    }
  })
  // Include any pin-only project hits not in the pack (honest union).
  for (const hit of pinHits?.projects ?? []) {
    if (!packProjects.some((p) => p.id === hit.id)) {
      packProjects.push({
        id: hit.id,
        name: hit.name,
        taskCount: hit.taskCount ?? 0,
      })
    }
  }

  const packFeatures: Array<{ id: string; name: string | null }> =
    bundle.features.map((f) => ({
      id: f.id,
      name: f.name,
    }))
  for (const hit of pinHits?.features ?? []) {
    if (!packFeatures.some((f) => f.id === hit.id)) {
      packFeatures.push({ id: hit.id, name: hit.name })
    }
  }

  const tasks =
    pinHits?.tasks?.map((t) => ({
      taskId: t.taskId,
      title: t.title,
      bucket: t.bucket ?? null,
      ownerPrimaryTitle: t.ownerPrimaryTitle ?? null,
    })) ?? []

  const decisions =
    pinHits?.decisions?.map((d) => ({
      decisionId: d.decisionId,
      title: d.title,
      status: d.status ?? 'UNKNOWN',
    })) ?? []

  const evidence =
    pinHits?.evidence?.map((e) => ({
      id: e.id,
      kind: e.kind,
      summary: e.summary,
    })) ?? []

  const gaps = bundle.knowledgeGaps.map((g) => g.code)
  const availability = bundle.availability
  let surfaceState: 'populated' | 'partial' | 'stale' | 'empty' =
    availability === 'partial' ? 'partial' : 'populated'
  if (pinHits?.stale) surfaceState = 'stale'

  const conflicts = projectKnowledgeConflictsFromBundle(bundle)
  const redactions = projectKnowledgeRedactionsFromBundle(bundle)
  let knowledgeState: KnowledgeState = bundle.statusRollup.knowledgeState
  if (pinHits?.stale) knowledgeState = 'STALE'
  else if (conflicts.length >= 2) knowledgeState = 'CONFLICT'
  else if (bundle.knowledgeGaps.some((g) => g.knowledgeState === 'UNKNOWN')) {
    if (knowledgeState === 'PROVEN') knowledgeState = 'UNKNOWN'
  }

  return {
    domain: bundle.domainId,
    domainId: bundle.domainId,
    title: bundle.humanDisplay.title,
    summary: bundle.humanDisplay.summary,
    availability,
    surfaceState,
    projects: packProjects,
    features: packFeatures,
    tasks,
    decisions,
    evidence,
    gaps,
    knowledgeGaps: bundle.knowledgeGaps,
    coverageManifest: bundle.coverageManifest,
    relations: bundle.relations,
    flows: bundle.flows,
    entities: bundle.entities,
    boundaries: bundle.boundaries,
    statusRollup: bundle.statusRollup,
    citations: bundle.citations,
    blockers: bundle.blockers,
    humanDisplay: bundle.humanDisplay,
    conflicts,
    redactions,
    knowledgeState,
    lastValidGeneratedAt: bundle.generatedAt ?? null,
    bundle,
  }
}

/**
 * Documentation export preview body from the AFFILIATE pack (ART S17).
 */
export function affiliateBundleToDocumentationMarkdown(
  bundle: DomainKnowledgeBundle,
): string {
  const lines: string[] = [
    `# Dokumentasi domain: ${bundle.humanDisplay.title}`,
    '',
    bundle.humanDisplay.summary,
    '',
    `_Snapshot: ${bundle.snapshotId} · rev ${bundle.revision} · hash ${bundle.sourceHash}_`,
    '',
    '## Batas domain',
    ...bundle.boundaries.map((b) => `- ${b}`),
    '',
    '## Proyek lintas-relasi',
    ...bundle.projects.map((p) => `- **${p.name}** (\`${p.id}\`) — ${p.role}`),
    '',
    '## Fitur',
    ...bundle.features.map(
      (f) =>
        `- **${f.name}** (\`${f.id}\`) · \`${f.projectId}\` — ${f.summary}`,
    ),
    '',
    '## Alur end-to-end',
  ]
  for (const fl of bundle.flows) {
    lines.push(`### ${fl.name} (\`${fl.id}\`)`)
    lines.push(
      ...fl.nodes
        .slice()
        .sort((a, b) => a.order - b.order)
        .map((n) => `${n.order}. ${n.label}`),
    )
    lines.push(`Outcomes: ${fl.outcomes.join(', ')}`, '')
  }
  lines.push(
    '## Relasi',
    ...bundle.relations.map(
      (r) => `- ${r.label} (\`${r.fromId}\` → \`${r.toId}\`, ${r.type})`,
    ),
    '',
    '## Gap jujur',
    ...bundle.knowledgeGaps.map((g) => `- **${g.code}**: ${g.message}`),
    '',
    '## Coverage manifest',
    ...bundle.coverageManifest.map(
      (c) =>
        `- [${c.disposition}] ${c.label} (\`${c.id}\`)${c.reason ? ` — ${c.reason}` : ''}`,
    ),
    '',
  )
  return lines.join('\n')
}
