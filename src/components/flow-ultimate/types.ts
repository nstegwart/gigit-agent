/** Flow ultimate — wire types for data-bundle + canvas nodes. */

export type FlowMode =
  | 'cross'
  | 'rn'
  | 'web-member'
  | 'panel-sales'
  | 'affiliate'
  | 'backend'

export type FlowStatusClass = 'ok' | 'warn' | 'bad'

export interface FlowProjectRollup {
  terbukti: number
  sebagian: number
  belum: number
}

export interface FlowProjectMeta {
  id: string
  label: string
  repo?: string
  features?: number
  tasks?: number
  rollup?: FlowProjectRollup
  pct?: number
  status?: string
  generated_at?: string
}

export interface FlowFeature {
  id: string
  nama_id: string
  ringkasan_id?: string
  status: string
  pct?: number
  screens?: string[]
  doc_md?: string
  task_ids?: string[]
  rollup?: FlowProjectRollup
}

export interface FlowTask {
  id: string
  judul_id: string
  project?: string
  verdict?: string
}

export interface FlowApi {
  method: string
  path: string
  n?: number
  proj?: string
}

export interface FlowPremiumStep {
  n: number
  proj: string
  title: string
  kind?: string
  file?: string
  api?: string
  db?: string
  fields?: string[]
  st?: string
  feature_id?: string
  project?: string
}

export interface FlowDataBundle {
  projects: {
    version?: number
    generated_at?: string
    source?: string
    projects: FlowProjectMeta[]
  }
  premium: {
    name: string
    desc?: string
    steps: FlowPremiumStep[]
  }
  features: Record<string, FlowFeature[]>
  tasks_by_feature: Record<string, FlowTask[]>
  apis_by_feature: Record<string, FlowApi[]>
  premium_apis?: FlowApi[]
}

export interface FlowNode {
  id: string
  x: number
  y: number
  title: string
  meta: string
  status: string
  project?: string
  featureId?: string | null
  step?: FlowPremiumStep & { flowTitle?: string }
  kind: 'cross' | 'feature'
  flowTitle?: string
  apis?: string[]
}

export interface FlowEdge {
  from: string
  to: string
}

export interface FlowGraph {
  nodes: FlowNode[]
  edges: FlowEdge[]
}

export interface FlowTransform {
  x: number
  y: number
  scale: number
}

export const CARD_W = 200
export const CARD_H = 64
export const GAP_X = 72
export const GAP_Y = 36
export const DRAG_THRESHOLD = 5
export const STORAGE_KEY = 'cairn-flow-pos-v1'

export const MODE_LABEL: Record<FlowMode, string> = {
  cross: 'Lintas Proyek',
  rn: 'React Native',
  'web-member': 'Web Member',
  'panel-sales': 'Panel Sales',
  affiliate: 'Afiliasi',
  backend: 'Backend',
}

export const PROJ_META: Record<
  string,
  { label: string; color: string; css: string }
> = {
  rn: { label: 'React Native', color: 'var(--proj-rn)', css: '#f472b6' },
  'web-member': { label: 'Web Member', color: 'var(--proj-web)', css: '#35c479' },
  web: { label: 'Web Member', color: 'var(--proj-web)', css: '#35c479' },
  'panel-sales': {
    label: 'Panel Sales',
    color: 'var(--proj-sales)',
    css: '#e5a54b',
  },
  sales: { label: 'Panel Sales', color: 'var(--proj-sales)', css: '#e5a54b' },
  affiliate: {
    label: 'Afiliasi',
    color: 'var(--proj-affiliate)',
    css: '#5b9dff',
  },
  backend: { label: 'Backend', color: 'var(--proj-backend)', css: '#a78bfa' },
}

export const FLOW_MODES: FlowMode[] = [
  'cross',
  'rn',
  'web-member',
  'panel-sales',
  'affiliate',
  'backend',
]
