// Shared readiness math — one formula for server (get_rollup / list_tasks) and UI
// (LifecycleRail / TasksTable). Readiness% of a stage = its configured `readiness`,
// else evenly spread across the rail (last = 100).
import type { LifecycleConfig, LifecycleStage } from './types'

export function resolvedReadiness(cfg: LifecycleConfig): Record<string, number> {
  const n = cfg.stages.length
  const r: Record<string, number> = {}
  cfg.stages.forEach((s, i) => { r[s.key] = s.readiness ?? (n > 1 ? Math.round((i / (n - 1)) * 100) : 100) })
  return r
}
export function stageIndex(cfg: LifecycleConfig, key: string | null | undefined): number {
  return key ? cfg.stages.findIndex((s) => s.key === key) : -1
}
export function stageReadiness(cfg: LifecycleConfig, key: string | null | undefined): number {
  const r = resolvedReadiness(cfg)
  return key && key in r ? r[key] : 0
}
/** §1: at the first (MAPPING) stage with readiness 0, derive 0–9 from M01–M20; else flat. */
export function rowReadiness(cfg: LifecycleConfig, key: string | null | undefined, ckDone = 0, ckTotal = 0): number {
  const r = resolvedReadiness(cfg)
  const first = cfg.stages[0]?.key
  if (key && key === first && (r[first] ?? 0) === 0 && ckTotal) return Math.min(9, Math.round((ckDone / ckTotal) * 9))
  return key && key in r ? r[key] : 0
}
export function nextStage(cfg: LifecycleConfig, key: string | null | undefined): LifecycleStage | null {
  const i = stageIndex(cfg, key)
  return cfg.stages[i + 1] ?? null
}
/** What proof unlocks the next gate — evidence keys, or the verifier requirement. */
export function nextEvidence(cfg: LifecycleConfig, key: string | null | undefined): Array<string> {
  const ns = nextStage(cfg, key)
  if (!ns) return []
  const ev = [...(ns.requiresEvidence ?? [])]
  if (ns.verifierRole) ev.push(`${ns.verifierRole} verdict`)
  return ev
}
