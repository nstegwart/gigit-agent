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
/** First-class task (T-… id) — distinct from the feature checklist `Task` above. */
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
}
export interface TasksFile {
  tasks: Array<WorkTask>
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
