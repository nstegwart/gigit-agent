/**
 * Client-only presentation helpers for operational enums and long identifiers.
 * Never mutates server/policy values — display layer only.
 */

/**
 * SCREAMING_SNAKE / mixed token → spaced readable label.
 * `PRIORITY_FRONTIER_EMPTY` → `PRIORITY FRONTIER EMPTY`
 * Leaves non-underscore strings unchanged (except trimming).
 */
export function formatOperationalLabel(raw: string | null | undefined): string {
  if (raw == null) return ''
  const s = String(raw).trim()
  if (!s) return ''
  // Prefer underscore splits (operational enums / portfolio ids).
  if (s.includes('_')) {
    return s.split('_').filter(Boolean).join(' ')
  }
  // Hyphenated run/task ids: keep as-is for copyability (ellipsis CSS handles overflow).
  return s
}

/**
 * Truncate long mono IDs while keeping head + tail distinguishable.
 * Full value must remain available via title/aria on the consumer.
 */
export function truncateIdentifier(
  raw: string | null | undefined,
  head = 10,
  tail = 6,
): { display: string; full: string; truncated: boolean } {
  const full = raw == null ? '' : String(raw)
  if (!full) return { display: '', full: '', truncated: false }
  if (full.length <= head + tail + 1) {
    return { display: full, full, truncated: false }
  }
  return {
    display: `${full.slice(0, head)}…${full.slice(-tail)}`,
    full,
    truncated: true,
  }
}

/** Compact ISO timestamp for dense tables (full ISO stays in title). */
export function formatDenseTimestamp(iso: string | null | undefined): string {
  if (!iso) return '—'
  const m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?/)
  if (!m) return String(iso)
  return `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}`
}
