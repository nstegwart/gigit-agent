// Domain types for the Cairn board. Raw* = shape as stored in data/plan.json + runs.json.
// Derived (Feature/Project/Model) = computed by buildModel() in model.ts.
// V3 control-plane enums/records live in control-plane-types.ts and are re-exported below
// so existing ibils/board consumers keep typechecking while C1 domain modules share one surface.

export type {
  TaskClass,
  TaskDisposition,
  PinnedRevisionTuple,
  ClassificationReceipt,
  TaskClassificationRecord,
  ClassificationEvaluation,
  ClassificationInvalidReason,
  LifecycleStageKey,
  StageEvidenceBinding,
  G5DomainStatus,
  G5DomainId,
  G5DomainRecord,
  G5Evaluation,
  PrimaryBucket,
  StaleOverlayKind,
  BlockReasonCode,
  BucketAssignment,
  TaskReadinessPolicyVersion,
  BoardReadinessPolicyVersion,
  BoardCappedBy,
  DomainErrorCode,
  RollupV3BucketCounts,
  RollupV3Result,
  PriorityFrontierState,
  PriorityAllocationResult,
  FeatureContractJoin,
  NodeJoin,
  DependencyJoin,
  PrimaryOwnership,
} from './control-plane-types'

export {
  TASK_CLASSES,
  TASK_DISPOSITIONS,
  LIFECYCLE_STAGE_ORDER,
  G5_REQUIRED_DOMAINS,
  G5_DOMAIN_LABELS,
  DomainError,
} from './control-plane-types'

// JSON-serializable value — server functions must return serializable data.
export type Json =
  | string | number | boolean | null
  | { [k: string]: Json }
  | Array<Json>

export interface BoardMeta {
  id: string
  name: string
  description?: string
  createdAt?: string
  /** adaptive nav — which views/tabs this board shows. Undefined = all standard. */
  views?: Array<string>
}

// ---- adaptive view types (Tasks / Ops / Prod / Guide) ----
export interface TaskCheckpoint {
  id: string
  label: string
  category?: string | null
  done: boolean
}
export interface TaskAnchor {
  repo?: string
  file?: string
  line?: string | number
  symbol?: string
  fact?: string
}
export interface TaskVariant {
  id?: string
  when?: string
  expect?: string
}

/** An agent-defined content block inside a task ("menu baru"). Fully custom — the
 *  agent adds/edits/removes these via MCP; the UI renders each by its `type`. */
export interface TaskSection {
  id: string
  type: string // text | callout | fields | list | checklist | table | chips | anchors | variants | links | badges
  title?: string
  collapsed?: boolean
  tone?: string // indigo|amber|green|blue|teal|red|parked
  body?: string // text / callout
  fields?: Array<{ k: string; v: string }>
  items?: Array<string> // list
  checklist?: Array<{ id?: string; label: string; done?: boolean }>
  columns?: Array<string> // table header
  rows?: Array<Array<string>> // table rows
  chips?: Array<string>
  anchors?: Array<TaskAnchor>
  variants?: Array<TaskVariant>
  links?: Array<{ label?: string; url: string }>
}

/** First-class task (T-… id) — distinct from the feature checklist `Task` above.
 *  Carries the full 20-point rebuild-mapping. Most fields are optional. */
export interface WorkTask {
  id: string
  title: string
  projectId?: string | null
  group?: string | null
  phase?: string | null
  scope?: string
  updated?: string | null
  objective?: string | null
  next?: string | null
  dependencies: Array<string>
  impacts: Array<string>
  featureContractId?: string | null
  mappingPct?: number | null
  status?: string | null
  checkpoints: Array<TaskCheckpoint>
  story?: { userStory?: string | null; currentGap?: string | null; targetScope?: string | null }
  refs?: { evidence?: string | null; api?: Array<string>; pages?: Array<string> }
  // ---- 20-point mapping (optional) ----
  actor?: string
  nodeIds?: Array<string>
  user_story?: string
  repository?: string
  unlocked?: boolean
  forbidden_scope?: Array<string>
  unlock_conditions?: Array<string>
  blockers?: Array<string>
  // legacy + target
  legacy_contract?: string
  legacy_anchors?: Array<TaskAnchor>
  rebuild_anchors?: Array<TaskAnchor>
  current_gap?: string
  target_scope?: string
  target_files_or_discovery_scope?: Array<string>
  // journey / api / rules
  page_routes?: Array<string>
  api_endpoints?: Array<string>
  inputs_outputs?: Array<string>
  logic_rules?: Array<string>
  state_lifecycle?: Array<string>
  outcome_variants?: Array<string>
  // data / callers / side effects
  sales_table_fields?: Array<string>
  data_migration?: string
  callers_consumers?: Array<string>
  blast_radius?: Array<string>
  compatibility?: Array<string>
  regression_matrix?: Array<string>
  side_effects_readback?: Array<string>
  // provider / geo
  provider_variants?: Array<TaskVariant>
  geo_variants?: Array<TaskVariant>
  // reliability / security / migration
  compensation_idempotency?: Array<string>
  security_perf?: Array<string>
  rollback?: string
  // acceptance / evidence
  implementation_steps?: Array<string>
  acceptance?: Array<string>
  acceptance_criteria?: Array<string>
  proof_required?: Array<string>
  evidence?: Array<string>
  evidence_path?: string
  history?: Array<string>
  mapping_missing?: Array<string>
  lifecycleStage?: string | null // current proven lifecycle stage (from the tasks table)
  blockedReason?: string | null // current blocker (set on repair/fail, cleared on forward)
  lastReceiptAt?: string | null // timestamp of the last lifecycle transition
  /**
   * Optional control-plane fields for C3 rollup truth (list + detail).
   * Read-only projection from persisted task JSON — never writable readiness/G5 shortcuts.
   * claimState: only VALID_CURRENT|STALE|ORPHAN|EXPIRED|FENCED|BEYOND_STAGE are trusted.
   * selectedForNextDispatch is intentionally NOT a task field authority (NEXT = active plan only).
   */
  claimState?:
    | 'VALID_CURRENT'
    | 'STALE'
    | 'ORPHAN'
    | 'EXPIRED'
    | 'FENCED'
    | 'BEYOND_STAGE'
    | string
    | null
  staleDataSource?: boolean
  staleDispatchPlan?: boolean
  staleAccountSync?: boolean
  /** Product DONE mode: Stage 1 = MAP_VERIFIED; Stage 2 = PROD_READY|LIVE_VERIFIED. */
  productStageMode?: 'STAGE_1' | 'STAGE_2' | string | null
  p0Blocker?: boolean
  /** Explicit target gate when distinct from lifecycleStage. */
  targetGate?: string | null
  /** Explicit current open-decision flags — may only supplement open Decision source. */
  hasBlockingDecision?: boolean
  hasNonBlockingDecision?: boolean
  // object-shaped extras (kept as opaque JSON)
  detail?: Json
  unit_test_plan?: Json
  mapping_na?: Json
  // fully agent-defined content blocks — rendered dynamically on the detail page
  sections?: Array<TaskSection>
}
export interface TasksFile {
  tasks: Array<WorkTask>
}

// ---- lifecycle engine (per-board configurable rail) ----
export interface LifecycleStage {
  key: string
  label: string
  color?: string // tone: indigo|amber|green|blue|teal|red|parked
  group?: string // 'mapping' | 'delivery' | custom bucket
  gated?: boolean // true = only via evidence/verifier receipt, never a manual tick
  requiresEvidence?: Array<string> // e.g. ['commitSha','deployReceipt','testReceipt']
  verifierRole?: string // who may PASS — must differ from the implementer
  readiness?: number // 0–100 — how ready-to-production this stage means (drives all % rollups)
  milestone?: boolean // the "ready" gate a rollup counts toward (e.g. PROD_READY); default = first stage with readiness>=100
}
export interface LifecycleConfig {
  stages: Array<LifecycleStage>
  allowSkip?: boolean // forward jumps that skip stages (default false = strict sequential)
  allowRegression?: boolean // move back to an earlier stage for repair/regression (default true)
  formulaVersion?: string // readiness formula id, surfaced in get_rollup (e.g. 'mfs-ready-prod-v1')
}
export interface LifecycleHistoryEntry {
  stage: string
  byRunId?: string
  role?: string
  blocker?: string | null
  ts: string
  verdict?: string
  evidence?: Record<string, Json>
  commitSha?: string
  deployReceipt?: string
}
export interface TaskLifecycle {
  history: Array<LifecycleHistoryEntry>
}
export interface TaskLifecycleState {
  stage: string | null
  rev: number
  implementerRun: string | null
  lifecycle: Json | null // { history: LifecycleHistoryEntry[] }
}
export interface GroupReadiness {
  readinessPercent: number // avg stage-readiness of the group's active tasks
  floor: string | null // lowest stage key among the group ('UNINITIALIZED' if any)
  total: number // active tasks in the group
  atMilestone: number // how many reached the milestone stage (e.g. PROD_READY)
  counts: Record<string, number> // active tasks per stage within the group
  uninitialized: number // group's active tasks with no stage yet
  blocked: number // group's active tasks with a blocker
}
export interface Rollup {
  formulaVersion: string
  readyStage: string | null // the "100% ready-production" gate (= milestone)
  stages: Array<LifecycleStage>
  counts: Record<string, number> // active tasks per stage
  readiness: Record<string, number> // readiness% each stage represents (resolved: config or evenly spread)
  readinessPercent: number // overall avg readiness across active tasks
  milestone: string | null // alias of readyStage
  atMilestone: number // active tasks that reached the milestone
  prodReady: number // active tasks at/after the ready stage
  liveVerified: number // active tasks past the ready stage (live badge)
  uninitialized: number // active tasks with no lifecycle stage yet (NOT counted as the first stage)
  hold: number
  active: number
  byProject: Record<string, GroupReadiness>
  byFeature: Record<string, GroupReadiness>
}

export interface Account {
  id: string
  label: string
  provider?: string
  status: string
  usable: boolean
  slotsInUse: number
  slotsCapacity: number
  reason?: string | null
  exhaustedAt?: string | null
  detail?: string | null
}
export interface AccountVault {
  generatedAt?: string | null
  source?: string | null
  sessionsPerAccount?: number | null
  minWorkers?: number | null
  maxWorkers?: number | null
  accountCount?: number | null
  usableCount?: number | null
  limitCount?: number | null
  capacityNote?: string | null
  provider?: string
}
export interface OpsData {
  vault: AccountVault
  accounts: Array<Account>
  alert?: { lowThreshold?: number; email?: string; enabled?: boolean }
}

export interface ProdGate {
  id: string
  title: string
  meaning?: string | null
  agent?: string | null
  doneWhen?: string | null
}
export interface ProdData {
  mockLabel?: string | null
  headline?: string | null
  gates: Array<ProdGate>
}

export interface GuideSection {
  title: string
  body: string
}
export interface GuideData {
  sections: Array<GuideSection>
}

export type Phase =
  | 'backlog' | 'spec' | 'design' | 'review-owner' | 'build' | 'qa' | 'uat' | 'done'

export type RunStatus = 'running' | 'blocked' | 'queued' | 'done' | 'failed'
export type AgentType = 'claude' | 'grok' | 'codex' | (string & {})

export interface Task {
  teks: string
  done: boolean
}

export interface FeatureLink {
  label?: string
  url: string
}

export interface RawFeature {
  id: string
  nama: string
  kelompok?: string
  track?: string
  tier?: string
  fase: Phase | string
  impact?: Array<string>
  desain?: Json
  updated?: string
  catatan?: string
  checklist?: Array<Task>
  deps?: Array<string>
  blocked?: string | null
  links?: Array<FeatureLink>
  branch?: string
  bucket?: string
}

export interface RawProject {
  id: string
  nama: string
  status: string
  tracks?: Array<string>
  ringkas?: string
  stage?: string
  repo?: string
  color?: string
  docs?: Record<string, Json>
  komponen?: Array<Record<string, Json>>
  // system-design foundation links (per-project design-system HTML in the repo)
  design_foundation?: string
  design_components?: string
  design_pages?: string
  // extra plan.json fields (environments, prasyarat, operate, releases, …) are read
  // through at runtime; not declared here so derived types can extend this cleanly.
}

export interface Run {
  id: string
  agent: string
  role?: string
  agentType: AgentType
  model: string
  effort: string
  task: string
  feature?: string | null
  taskId?: string | null // link to a first-class WorkTask (task-boards)
  account?: string | null // agent-account this run uses (ops vault)
  project?: string | null
  status: RunStatus
  started?: string
  updated?: string // last heartbeat
  note?: string
  targetGate?: string | null // the lifecycle stage this run is driving toward
  evidencePath?: string | null // where its proof lands
  verdict?: string | null // terminal receipt/verdict (PASS/FAIL/…)
}

export interface DecisionOption {
  key: string
  label: string
  rekomendasi?: boolean
}

/** Optional V3 option shape carried on board JSON (rich DecisionV3 seed). */
export interface DecisionOptionV3Carrier {
  optionId?: string
  id?: string
  key?: string
  label: string
  tradeoffs?: string | null
  declining?: boolean
  recommended?: boolean
}

/**
 * Board collab Decision carrier.
 * Legacy fields remain required for older boards; optional V3-shaped fields are
 * projected when present. Private body/privateNote/comment must never ship to UI.
 */
export interface Decision {
  id: string
  teks: string
  status: string // 'open' | 'decided' | 'blocked' | V3 OPEN|ACKNOWLEDGED|…
  aksi?: string
  opsi?: Array<DecisionOption>
  jawaban?: string
  keputusan?: string
  tanggal_putus?: string
  featureId?: string // set when an agent opened a decision against a feature
  openedBy?: string
  // ---- optional DecisionV3-shaped fields (read-only projection) ----
  decisionId?: string
  title?: string
  question?: string
  severity?: string
  blocking?: boolean
  type?: string
  evidence?: Array<string>
  options?: Array<DecisionOptionV3Carrier>
  agentRecommendation?: string | null
  recommendation?: string | null
  dueAt?: string | null
  due?: string | null
  createdAt?: string | null
  created?: string | null
  snoozedUntil?: string | null
  ownerId?: string | null
  resolverId?: string | null
  selectedOptionId?: string | null
  projectId?: string | null
  taskId?: string | null
  runId?: string | null
  expectedRev?: number | null
  boardRev?: number | null
  entityRev?: number | null
  scopedApprovalId?: string | null
  auditIds?: Array<string>
  expiresAt?: string | null
  /** Private — never map into public/UI projection. */
  body?: string
  privateNote?: string
  comment?: string | null
}

export type Actor = 'human' | 'agent'

export interface Comment {
  id: string
  featureId: string
  author: string
  authorType: Actor
  text: string
  ts: string
}

export interface ActivityEvent {
  ts: string
  actor: string
  actorType?: Actor
  kind: string // 'comment' | 'toggle' | 'claim' | 'decision' | 'blocked' | 'log' | ...
  text: string
  featureId?: string
  projectId?: string
}

export interface Conventions {
  brand?: string
  branch?: Record<string, string>
  worktree?: { path?: string; note?: string }
  commit?: string
  merge?: string
  usage?: Array<string>
  deploy?: string
  status_grades?: Array<string>
  repos?: Record<string, string>
  [k: string]: Json | undefined
}

export interface DesignOverlay {
  projects: Record<string, Array<FeatureLink>>
  features: Record<string, Array<FeatureLink>>
}
export interface CollabOverlay {
  comments: Record<string, Array<Comment>>
  activity: Array<ActivityEvent>
}

export interface LogEntry {
  tanggal: string
  teks: string
}

export interface DocEntry {
  judul: string
  desc?: string
  path?: string
}

export interface RawBoard {
  fase_label?: Record<string, string>
  fase_persen?: Record<string, number>
  projects: Array<RawProject>
  features: Array<RawFeature>
  decisions?: Array<Decision>
  log?: Array<LogEntry>
  queue?: { now?: Array<string>; next?: Array<string>; catatan?: string }
  runs?: Array<Run>
  docs?: Array<DocEntry>
  updated?: string
  // overlays (data/conventions.json, data/design.json, data/collab.json)
  conventions?: Conventions
  design?: DesignOverlay
  collab?: CollabOverlay
}

// ---- derived ----
export interface Feature extends RawFeature {
  projectId: string | null
  taskTotal: number
  taskDone: number
  parked: boolean
  isBlocked: boolean
  isDone: boolean
  pct: number | null
  phaseLabel: string
  phaseCls: string
  runs: Array<Run>
  design: Array<FeatureLink>
  comments: Array<Comment>
  depth: number // dependency depth (0 = root) — for the wire graph layout
}

export interface Project extends RawProject {
  color: string
  features: Array<Feature>
  progress: number
  activeAgents: number
  design: Array<FeatureLink>
}

export interface Model {
  projects: Array<Project>
  projById: Record<string, Project>
  features: Array<Feature>
  featById: Record<string, Feature>
  runs: Array<Run>
  runsByTask: Record<string, Array<Run>>
  queue: { now: Array<Feature>; next: Array<Feature>; catatan?: string }
  blocked: Array<Feature>
  active: Array<Feature>
  parked: Array<Feature>
  runningAgents: Array<Run>
  decisions: Array<Decision>
  openDecisions: Array<Decision>
  log: Array<LogEntry>
  docs: Array<DocEntry>
  updated?: string
  conventions?: Conventions
  activity: Array<ActivityEvent>
}

// ---- auth: human accounts + per-board visibility ----
export type Role = 'admin' | 'member'
/** The signed-in human (from the session cookie). admin sees every board + manages users;
 *  member sees only the board ids in `boards` and is read-only. */
export interface SessionUser {
  id: string
  username: string
  role: Role
  boards: Array<string> // allowed board ids (empty for admin — admin sees all)
}
/** An account row for the admin user-management screen. */
export interface UserRow {
  id: string
  username: string
  role: Role
  boards: Array<string>
  createdAt?: string
}
