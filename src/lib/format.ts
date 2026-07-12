// Presentation constants + tiny formatters. Pure, client- and server-safe.
import type { AgentType, RunStatus } from './types'

export const PALETTE = [
  '#14b8a6', '#3b82f6', '#ec4899', '#8b5cf6', '#f59e0b', '#06b6d4', '#ef4444', '#84cc16',
]

export const ACTIVE_PHASES = ['spec', 'design', 'review-owner', 'build', 'qa', 'uat']

export const PHASE_CLS: Record<string, string> = {
  backlog: 'ph-backlog',
  spec: 'ph-spec',
  design: 'ph-design',
  'review-owner': 'ph-review',
  build: 'ph-build',
  qa: 'ph-qa',
  uat: 'ph-uat',
  done: 'ph-done',
}

export const STATUS_LBL: Record<RunStatus, string> = {
  running: 'Running',
  blocked: 'Blocked',
  queued: 'Queued',
  done: 'Done',
  failed: 'Failed',
}

export const PROJ_STATUS: Record<string, [string, string]> = {
  live: ['st-live', 'Live'],
  planned: ['st-planned', 'Planned'],
  internal: ['st-internal', 'Internal'],
}

// icon key per agent type (see icons.tsx)
export const AGENT_ICON: Record<string, string> = {
  claude: 'sparkles',
  grok: 'bolt',
  codex: 'terminal',
}

export function agentClass(t: AgentType): string {
  return `ag-${t}`
}

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** '2026-07-11T19:10:00+07:00' -> '11 Jul · 19:10'; date-only -> '11 Jul' */
export function fmtDate(iso?: string | null): string {
  if (!iso) return ''
  const m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?/)
  if (!m) return String(iso)
  const d = `${Number(m[3])} ${MON[Number(m[2]) - 1]}`
  return m[4] ? `${d} · ${m[4]}:${m[5]}` : d
}

/** duration between two ISO timestamps -> '1h 28m' / '28m' / '' */
export function dur(a?: string, b?: string): string {
  if (!a || !b) return ''
  const ms = new Date(b).getTime() - new Date(a).getTime()
  if (!(ms > 0)) return ''
  const min = Math.round(ms / 60000)
  const h = Math.floor(min / 60)
  const mm = min % 60
  return h ? `${h}h ${mm}m` : `${mm}m`
}
