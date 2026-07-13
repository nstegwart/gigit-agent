// V3 control-plane domain types (pure / serializable).
// Schema version markers and enums used by classification, readiness, G5, and rollup-v3.
// Existing board consumers should import from `#/lib/types` (re-exports) or this module.

// ---- classification ----

export type TaskClass = 'PRODUCT' | 'CONTROL_PLANE' | 'UNCLASSIFIED'
export type TaskDisposition = 'ACTIVE' | 'HOLD' | 'EXCLUDE' | 'UNCLASSIFIED'

export const TASK_CLASSES: ReadonlyArray<TaskClass> = [
  'PRODUCT',
  'CONTROL_PLANE',
  'UNCLASSIFIED',
] as const

export const TASK_DISPOSITIONS: ReadonlyArray<TaskDisposition> = [
  'ACTIVE',
  'HOLD',
  'EXCLUDE',
  'UNCLASSIFIED',
] as const

/** Pinned revision tuple every aggregation binds to (AC-COUNT / AC-READY-06). */
export interface PinnedRevisionTuple {
  canonicalSnapshotId: string
  canonicalHash: string
  taskHash: string
  boardRev: number
  lifecycleRev: number
}

/** Classification / membership receipt bound to current revs+hashes. */
export interface ClassificationReceipt {
  receiptId: string
  receiptHash: string
  taskId: string
  taskClass: TaskClass
  disposition: TaskDisposition
  /** Membership portfolio proof (e.g. SALES_WEB_RELATED_BACKEND) when applicable. */
  membershipPortfolioId?: string | null
  /** Hash of the membership proof payload; required for product contribution. */
  membershipProofHash?: string | null
  canonicalSnapshotId: string
  canonicalHash: string
  taskHash: string
  boardRev: number
  lifecycleRev: number
  issuedAt: string
  /** Optional expiry; if present and past `now`, receipt is stale. */
  expiresAt?: string | null
}

export interface TaskClassificationRecord {
  taskId: string
  taskClass: TaskClass
  disposition: TaskDisposition
  /** Caller-supplied contribution is ignored; server derives it. */
  contributesToProductReadiness?: boolean | null
  receipt: ClassificationReceipt | null
  /** Control-plane target gate for CONTROL_PLANE DONE (AC-BUCKET-04). */
  controlPlaneTargetGate?: string | null
  controlPlaneGateVerifiedPass?: boolean
  controlPlaneRootAccepted?: boolean
}

export type ClassificationInvalidReason =
  | 'MISSING_RECORD'
  | 'MISSING_RECEIPT'
  | 'INVALID_TASK_CLASS'
  | 'INVALID_DISPOSITION'
  | 'STALE_CANONICAL_SNAPSHOT'
  | 'STALE_CANONICAL_HASH'
  | 'STALE_TASK_HASH'
  | 'STALE_BOARD_REV'
  | 'STALE_LIFECYCLE_REV'
  | 'STALE_RECEIPT_EXPIRED'
  | 'RECEIPT_TASK_MISMATCH'
  | 'RECEIPT_CLASS_MISMATCH'
  | 'RECEIPT_DISPOSITION_MISMATCH'
  | 'INVALID_RECEIPT_HASH'
  | 'UNCLASSIFIED_TASK_CLASS'
  | 'UNCLASSIFIED_DISPOSITION'

export interface ClassificationEvaluation {
  taskId: string
  taskClass: TaskClass
  disposition: TaskDisposition
  /** True only PRODUCT+ACTIVE+current valid classification/membership proof. */
  contributesToProductReadiness: boolean
  /** Fully valid classified receipt (class and disposition both not UNCLASSIFIED). */
  isFullyClassifiedValid: boolean
  /** True when tracked once as BLOCKED:DATA_INTEGRITY repair row. */
  isClassificationRepair: boolean
  /** True when fully valid HOLD/EXCLUDE — outside tracked work. */
  isOutsideTrackedWork: boolean
  valid: boolean
  reasons: Array<ClassificationInvalidReason>
  blockReason: 'DATA_INTEGRITY' | null
}

// ---- lifecycle stages (V3 ordered rail) ----

export type LifecycleStageKey =
  | 'MAPPING'
  | 'MAPPED'
  | 'MAP_VERIFIED'
  | 'BUILT'
  | 'FUNCTIONAL'
  | 'INTEGRATED'
  | 'STAGING_PROVEN'
  | 'PROD_READY'
  | 'LIVE_VERIFIED'

export const LIFECYCLE_STAGE_ORDER: ReadonlyArray<LifecycleStageKey> = [
  'MAPPING',
  'MAPPED',
  'MAP_VERIFIED',
  'BUILT',
  'FUNCTIONAL',
  'INTEGRATED',
  'STAGING_PROVEN',
  'PROD_READY',
  'LIVE_VERIFIED',
] as const

export type StageEvidenceBinding = {
  stage: LifecycleStageKey
  receiptId: string
  receiptHash: string
  independentVerifier: boolean
  verifierRunId?: string | null
  authorRunId?: string | null
  boardRev: number
  lifecycleRev: number
  taskHash: string
  canonicalHash: string
}

// ---- G5 ----

export type G5DomainStatus =
  | 'NOT_STARTED'
  | 'IN_PROGRESS'
  | 'PASS'
  | 'FAIL'
  | 'BLOCKED'

/** Exact nine required G5 domains (AC-LIFE-05). Domain IDs are stable slugs. */
export type G5DomainId =
  | 'security'
  | 'performance_capacity'
  | 'migration_data_integrity'
  | 'rollback_restore'
  | 'backup_dr'
  | 'monitoring_alerts_runbooks'
  | 'config_secrets'
  | 'cutover_rehearsal'
  | 'dependency_provider_readiness'

export const G5_REQUIRED_DOMAINS: ReadonlyArray<G5DomainId> = [
  'security',
  'performance_capacity',
  'migration_data_integrity',
  'rollback_restore',
  'backup_dr',
  'monitoring_alerts_runbooks',
  'config_secrets',
  'cutover_rehearsal',
  'dependency_provider_readiness',
] as const

/** Human labels matching V3 contract wording. */
export const G5_DOMAIN_LABELS: Readonly<Record<G5DomainId, string>> = {
  security: 'security',
  performance_capacity: 'performance/capacity',
  migration_data_integrity: 'migration/data integrity',
  rollback_restore: 'rollback/restore',
  backup_dr: 'backup/DR',
  monitoring_alerts_runbooks: 'monitoring/alerts/runbooks',
  config_secrets: 'config/secrets',
  cutover_rehearsal: 'cutover rehearsal',
  dependency_provider_readiness: 'dependency/provider readiness',
}

export interface G5DomainRecord {
  domainId: G5DomainId
  scope: string
  required: boolean
  status: G5DomainStatus
  evidenceReceiptIds: Array<string>
  evidenceReceiptHashes: Array<string>
  verifierAgent?: string | null
  verifierModel?: string | null
  verifierRunId?: string | null
  /** Author/implementer run — must differ from verifier for independence. */
  authorRunId?: string | null
  subjectRevision: number
  subjectHash: string
  findings?: string | null
  blocker?: string | null
  capturedAt?: string | null
  expectedRev: number
  boardRev: number
  subjectLifecycleRev: number
  /** Program-emitted evidence (not hand-typed). */
  programmaticEvidence: boolean
  independentVerifier: boolean
}

export interface G5Evaluation {
  g5Pass: boolean
  domainResults: Array<{
    domainId: G5DomainId
    pass: boolean
    reason: string | null
  }>
  missingDomains: Array<G5DomainId>
}

// ---- buckets / overlays ----

export type PrimaryBucket =
  | 'DONE'
  | 'RECONCILIATION_PENDING'
  | 'ONGOING'
  | 'NEXT'
  | 'QUEUED'
  | 'BLOCKED'

export type StaleOverlayKind =
  | 'STALE_DATA_SOURCE'
  | 'EXPIRED_STALLED_RUN'
  | 'STALE_CLAIM'
  | 'STALE_DISPATCH_PLAN'
  | 'STALE_ACCOUNT_SYNC'
  | 'BEYOND_STAGE_ONGOING'
  | 'RECONCILIATION_DRILLDOWN'

export type BlockReasonCode =
  | 'DATA_INTEGRITY'
  | 'BLOCKING_DECISION'
  | 'HARD_BLOCKER'
  | 'DEPENDENCY'
  | 'REJECTED_EVIDENCE'
  | 'COLLISION'
  | 'MISSING_ACCESS'
  | 'MALFORMED'

export interface BucketAssignment {
  taskId: string
  primary: PrimaryBucket | null
  /** Outside tracked work (valid HOLD/EXCLUDE). */
  outsideTracked: boolean
  blockReason: BlockReasonCode | null
  overlays: Array<StaleOverlayKind>
  ruleIndex: number
}

// ---- readiness policy versions ----

export type TaskReadinessPolicyVersion = 'MFS_DELIVERY_READINESS_V1'
export type BoardReadinessPolicyVersion = 'MFS_BOARD_READINESS_G5_CAP_V1'

export type BoardCappedBy =
  | 'G5'
  | 'EVIDENCE'
  | 'DATA_INTEGRITY_OR_P0'
  | 'EMPTY_PRODUCT_SCOPE'
  | null

// ---- typed domain errors ----

export type DomainErrorCode =
  | 'DATA_INTEGRITY'
  | 'DUPLICATE_FC_JOIN'
  | 'DUPLICATE_NODE_JOIN'
  | 'DUPLICATE_DEPENDENCY_JOIN'
  | 'CONFLICTING_PRIMARY_OWNERSHIP'
  | 'STALE_REVISION'
  | 'STALE_HASH'
  | 'INVALID_INPUT'
  | 'UNCLASSIFIED_SCOPE'
  | 'HOLD_OR_EXCLUDE'

export class DomainError extends Error {
  readonly code: DomainErrorCode
  readonly details: Readonly<Record<string, unknown>>

  constructor(code: DomainErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message)
    this.name = 'DomainError'
    this.code = code
    this.details = details
  }
}

// ---- rollup output ----

export interface RollupV3BucketCounts {
  DONE: number
  RECONCILIATION_PENDING: number
  ONGOING: number
  NEXT: number
  QUEUED: number
  BLOCKED: number
}

export interface RollupV3Result {
  schemaVersion: 'MFS_ROLLUP_V3'
  taskReadinessPolicyVersion: TaskReadinessPolicyVersion
  boardReadinessPolicyVersion: BoardReadinessPolicyVersion
  pin: PinnedRevisionTuple
  trackedWorkDenominator: number
  productDenominator: number
  stageProdReady: number
  prodReadyWithEvidence: number
  unclassifiedCount: number
  g5Pass: boolean
  complete: boolean
  rawTaskReadinessPercent: number | null
  boardReadinessPercent: number | null
  cappedBy: BoardCappedBy
  buckets: RollupV3BucketCounts
  overlays: Record<StaleOverlayKind, number>
  /** DISTINCT tracked task IDs sorted deterministically. */
  trackedTaskIds: Array<string>
  productTaskIds: Array<string>
  assignments: Array<BucketAssignment>
  hasP0OrDataIntegrityBlocker: boolean
}

// ---- priority / capacity (pure semantics for rollup consumers; not scheduler) ----

export type PriorityFrontierState =
  | 'PRIORITY_FRONTIER_ACTIVE'
  | 'PRIORITY_FRONTIER_COMPLETE'
  | 'PRIORITY_FRONTIER_BLOCKED'
  | 'PRIORITY_FRONTIER_EMPTY'
  | 'PRIORITY_FRONTIER_EXHAUSTED'

export interface PriorityAllocationResult {
  portfolioId: 'SALES_WEB_RELATED_BACKEND'
  /** ACTIVE PRODUCT task IDs with valid membership receipt only. */
  membershipTaskIds: Array<string>
  membershipDenominator: number
  priorityClosureCapacity: number
  allClosureCapacity: number
  priorityCapacityShare: number | null
  majorityAllocationPass: boolean | null
  frontierState: PriorityFrontierState
  reason: string | null
}

// ---- join graph validation inputs ----

export interface FeatureContractJoin {
  featureContractId: string
  taskId: string
}

export interface NodeJoin {
  nodeId: string
  taskId: string
}

export interface DependencyJoin {
  fromTaskId: string
  toTaskId: string
}

export interface PrimaryOwnership {
  taskId: string
  ownerId: string
}
