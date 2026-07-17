import type { Feature } from '#/lib/types'

export interface CycleWarning {
  kind: 'cycle'
  path: ReadonlyArray<string>
  message: string
}

export interface ConflictWarning {
  kind: 'conflict'
  featureId: string
  message: string
}

export type GraphWarning = CycleWarning | ConflictWarning

/** Detect dependency cycles within the given feature subset. */
export function detectDependencyCycles(features: ReadonlyArray<Feature>): CycleWarning[] {
  const ids = new Set(features.map((f) => f.id))
  const byId: Record<string, Feature> = {}
  for (const f of features) byId[f.id] = f

  const cycles: CycleWarning[] = []
  const visiting = new Set<string>()
  const visited = new Set<string>()
  const stack: string[] = []

  const dfs = (id: string): void => {
    if (visited.has(id)) return
    if (visiting.has(id)) {
      const start = stack.indexOf(id)
      const path = start >= 0 ? stack.slice(start).concat(id) : [id]
      cycles.push({
        kind: 'cycle',
        path,
        message: `Siklus ketergantungan: ${path.join(' → ')}`,
      })
      return
    }
    visiting.add(id)
    stack.push(id)
    for (const dep of byId[id]?.deps ?? []) {
      if (ids.has(dep)) dfs(dep)
    }
    stack.pop()
    visiting.delete(id)
    visited.add(id)
  }

  for (const f of features) {
    if (!visited.has(f.id)) dfs(f.id)
  }

  return cycles
}

/** Blocked nodes with human-readable why-blocked copy. */
export function blockedNodeSummaries(features: ReadonlyArray<Feature>): ConflictWarning[] {
  const out: ConflictWarning[] = []
  for (const f of features) {
    if (!f.isBlocked) continue
    const reason =
      typeof f.blocked === 'string' && f.blocked.trim()
        ? f.blocked.trim()
        : 'Prasyarat belum terpenuhi atau ada hambatan pada jalur ini.'
    out.push({
      kind: 'conflict',
      featureId: f.id,
      message: reason,
    })
  }
  return out
}

export interface TreeOutlineNode {
  id: string
  label: string
  blocked: boolean
  blockedReason: string | null
  children: TreeOutlineNode[]
}

/** Build a forest outline (roots = nodes with no in-subset deps). */
export function buildTreeOutline(features: ReadonlyArray<Feature>): TreeOutlineNode[] {
  const ids = new Set(features.map((f) => f.id))
  const byId: Record<string, Feature> = {}
  for (const f of features) byId[f.id] = f

  const build = (id: string, seen: Set<string>): TreeOutlineNode | null => {
    if (seen.has(id)) return null
    const f = byId[id]
    if (!f) return null
    const nextSeen = new Set(seen)
    nextSeen.add(id)
    const childIds = features
      .filter((x) => (x.deps ?? []).includes(id))
      .map((x) => x.id)
      .sort((a, b) => (byId[a]?.nama ?? a).localeCompare(byId[b]?.nama ?? b, 'en'))

    return {
      id,
      label: f.nama,
      blocked: f.isBlocked,
      blockedReason:
        typeof f.blocked === 'string' && f.blocked.trim() ? f.blocked.trim() : null,
      children: childIds
        .map((cid) => build(cid, nextSeen))
        .filter((n): n is TreeOutlineNode => n != null),
    }
  }

  const roots = features
    .filter((f) => !(f.deps ?? []).some((d) => ids.has(d)))
    .sort((a, b) => a.nama.localeCompare(b.nama, 'en'))

  return roots
    .map((f) => build(f.id, new Set()))
    .filter((n): n is TreeOutlineNode => n != null)
}

/** Group features by kelompok/project for collapse summaries. */
export function groupFeatureCounts(features: ReadonlyArray<Feature>): Array<{
  key: string
  label: string
  count: number
}> {
  const map = new Map<string, { label: string; count: number }>()
  for (const f of features) {
    const key = f.kelompok ?? f.projectId ?? 'lainnya'
    const label = f.kelompok ?? f.projectId ?? 'Lainnya'
    const cur = map.get(key)
    if (cur) cur.count += 1
    else map.set(key, { label, count: 1 })
  }
  return [...map.entries()]
    .map(([key, v]) => ({ key, label: v.label, count: v.count }))
    .sort((a, b) => b.count - a.count)
}