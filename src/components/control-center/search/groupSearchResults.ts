/**
 * W-UI-5 — Group global search hits by entity kind (SPEC-TM-KOMPAT-VISUAL-V1 §1 / §3.E).
 * Pure helpers — no I/O. Client groups pin-flat results; server product search uses the same labels.
 */

export type SearchEntitySectionKey = 'fitur' | 'tugas' | 'dokumen' | 'unit'

export const SEARCH_SECTION_ORDER: ReadonlyArray<SearchEntitySectionKey> = [
  'fitur',
  'tugas',
  'dokumen',
  'unit',
] as const

export const SEARCH_SECTION_LABEL_ID: Record<SearchEntitySectionKey, string> = {
  fitur: 'Fitur',
  tugas: 'Tugas',
  dokumen: 'Dokumen',
  unit: 'Unit',
}

/** Accent tones for section headers (CSS custom-property friendly keys). */
export const SEARCH_SECTION_TONE: Record<SearchEntitySectionKey, string> = {
  fitur: 'accent',
  tugas: 'ok',
  dokumen: 'warn',
  unit: 'muted',
}

export type FlatSearchHit = {
  kind: 'task' | 'project' | 'feature' | 'decision' | 'evidence' | string
  id: string
  title: string
  subtitle?: string | null
  href: string
  technicalAlias?: string | null
  /** Optional parent feature breadcrumb when already enriched. */
  breadcrumb?: string | null
}

export type GroupedSearchHit = {
  id: string
  title: string
  breadcrumb: string | null
  kind: SearchEntitySectionKey
  kindLabelId: string
  href: string
  technicalAlias: string | null
}

export type GroupedSearchSection = {
  key: SearchEntitySectionKey
  labelId: string
  tone: string
  items: Array<GroupedSearchHit>
}

/**
 * Map pin/legacy search kinds → owner-facing entity sections.
 * - feature → Fitur
 * - task → Tugas
 * - decision / evidence → Dokumen
 * - project → Unit (closest available pin entity; product units preferred when present)
 */
export function mapPinKindToSection(
  kind: string,
): SearchEntitySectionKey | null {
  switch (kind) {
    case 'feature':
    case 'fitur':
      return 'fitur'
    case 'task':
    case 'tugas':
      return 'tugas'
    case 'decision':
    case 'evidence':
    case 'dokumen':
    case 'document':
      return 'dokumen'
    case 'project':
    case 'unit':
      return 'unit'
    default:
      return null
  }
}

/** Build "Meditasi · Kesehatan & Wellness" style breadcrumb from non-empty parts. */
export function formatFeatureBreadcrumb(
  ...parts: Array<string | null | undefined>
): string | null {
  const cleaned = parts
    .map((p) => (typeof p === 'string' ? p.trim() : ''))
    .filter((p) => p.length > 0)
  if (cleaned.length === 0) return null
  return cleaned.join(' · ')
}

/**
 * Group flat search hits into ordered entity sections.
 * Empty sections are omitted. Within a section, first-seen order is preserved.
 */
export function groupFlatSearchResults(
  results: ReadonlyArray<FlatSearchHit>,
): Array<GroupedSearchSection> {
  const buckets: Record<SearchEntitySectionKey, Array<GroupedSearchHit>> = {
    fitur: [],
    tugas: [],
    dokumen: [],
    unit: [],
  }
  const seen = new Set<string>()

  for (const r of results) {
    const section = mapPinKindToSection(r.kind)
    if (!section) continue
    const dedupe = `${section}:${r.id}`
    if (seen.has(dedupe)) continue
    seen.add(dedupe)

    const breadcrumb =
      r.breadcrumb?.trim() ||
      (r.subtitle && r.subtitle.trim().length > 0 && !r.subtitle.startsWith('tasks:')
        ? r.subtitle.trim()
        : null)

    buckets[section].push({
      id: r.id,
      title: r.title,
      breadcrumb,
      kind: section,
      kindLabelId: SEARCH_SECTION_LABEL_ID[section],
      href: r.href,
      technicalAlias: r.technicalAlias ?? null,
    })
  }

  const sections: Array<GroupedSearchSection> = []
  for (const key of SEARCH_SECTION_ORDER) {
    const items = buckets[key]
    if (items.length === 0) continue
    sections.push({
      key,
      labelId: SEARCH_SECTION_LABEL_ID[key],
      tone: SEARCH_SECTION_TONE[key],
      items,
    })
  }
  return sections
}

/** Merge multiple section lists (product first, then pin). Product hits win on id collision. */
export function mergeGroupedSections(
  primary: ReadonlyArray<GroupedSearchSection>,
  secondary: ReadonlyArray<GroupedSearchSection>,
): Array<GroupedSearchSection> {
  const byKey = new Map<SearchEntitySectionKey, Array<GroupedSearchHit>>()
  const seen = new Set<string>()

  for (const list of [primary, secondary]) {
    for (const sec of list) {
      const bucket = byKey.get(sec.key) ?? []
      for (const item of sec.items) {
        const k = `${sec.key}:${item.id}`
        if (seen.has(k)) continue
        seen.add(k)
        bucket.push(item)
      }
      byKey.set(sec.key, bucket)
    }
  }

  const out: Array<GroupedSearchSection> = []
  for (const key of SEARCH_SECTION_ORDER) {
    const items = byKey.get(key)
    if (!items || items.length === 0) continue
    out.push({
      key,
      labelId: SEARCH_SECTION_LABEL_ID[key],
      tone: SEARCH_SECTION_TONE[key],
      items,
    })
  }
  return out
}

export function totalGroupedCount(
  sections: ReadonlyArray<GroupedSearchSection>,
): number {
  return sections.reduce((n, s) => n + s.items.length, 0)
}
