// Domain types for the Cairn board. Raw* = shape as stored in data/plan.json + runs.json.
// Derived (Feature/Project/Model) = computed by buildModel() in model.ts.

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
}
export interface LifecycleConfig {
  stages: Array<LifecycleStage>
  allowSkip?: boolean // forward jumps that skip stages (default false = strict sequential)
  allowRegression?: boolean // move back to an earlier stage for repair/regression (default true)
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
export interface Rollup {
  stages: Array<LifecycleStage>
  counts: Record<string, number>
  uninitialized: number // active tasks with no lifecycle stage yet (NOT counted as the first stage)
  hold: number
  active: number
  byProject: Record<string, string>
  byFeature: Record<string, string>
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
  updated?: string
  note?: string
}

export interface DecisionOption {
  key: string
  label: string
  rekomendasi?: boolean
}
export interface Decision {
  id: string
  teks: string
  status: string // 'open' | 'decided' | 'blocked'
  aksi?: string
  opsi?: Array<DecisionOption>
  jawaban?: string
  keputusan?: string
  tanggal_putus?: string
  featureId?: string // set when an agent opened a decision against a feature
  openedBy?: string
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
