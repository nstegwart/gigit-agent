/**
 * Local semantic icons for Overview (text+icon+color). Scoped here so icons.tsx
 * stays untouched. Decorative; parent supplies accessible text.
 */
import type { PrimaryBucket } from '#/lib/control-plane-types'
import type { ProductiveState } from './types'
import styles from './overview.module.css'

type IconKind =
  | PrimaryBucket
  | 'STALE'
  | 'check'
  | 'alert'
  | 'activity'
  | 'forward'
  | 'queue'
  | 'stop'
  | 'warning'
  | ProductiveState

const PATHS: Record<string, string> = {
  check: '<path d="M4 12l5 5 11-12"/>',
  activity:
    '<path d="M3 12h4l2-7 4 14 2-7h6" fill="none"/><circle cx="12" cy="12" r="0" />',
  forward: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  queue:
    '<path d="M4 7h16M4 12h16M4 17h10"/><circle cx="18" cy="17" r="1.4" fill="currentColor" stroke="none"/>',
  stop: '<rect x="5" y="5" width="14" height="14" rx="2"/><path d="M9 9h6v6H9z" fill="currentColor" stroke="none" opacity=".35"/>',
  warning: '<path d="M12 3 2 20h20L12 3z"/><path d="M12 10v4M12 17.5v.5" stroke-width="2"/>',
  alert: '<path d="M12 3 2 20h20L12 3z"/><path d="M12 10v4M12 17.5v.5" stroke-width="2"/>',
  DONE: '<path d="M4 12l5 5 11-12"/>',
  ONGOING: '<path d="M3 12h4l2-7 4 14 2-7h6"/>',
  NEXT: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  QUEUED:
    '<path d="M4 7h16M4 12h16M4 17h10"/><circle cx="18" cy="17" r="1.4" fill="currentColor" stroke="none"/>',
  BLOCKED:
    '<rect x="5" y="5" width="14" height="14" rx="2"/><path d="M9 9h6v6H9z" fill="currentColor" stroke="none" opacity=".35"/>',
  RECONCILIATION_PENDING:
    '<path d="M12 3 2 20h20L12 3z"/><path d="M12 10v4M12 17.5v.5" stroke-width="2"/>',
  STALE: '<path d="M12 3 2 20h20L12 3z"/><path d="M12 10v4M12 17.5v.5" stroke-width="2"/>',
  PRODUCTIVE: '<circle cx="12" cy="12" r="4" fill="currentColor" stroke="none"/>',
  IDLE: '<circle cx="12" cy="12" r="4.5"/><circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none"/>',
  STALLED: '<path d="M12 3 2 20h20L12 3z"/><path d="M12 10v4M12 17.5v.5" stroke-width="2"/>',
}

export function SemanticIcon({
  kind,
  className,
}: {
  kind: IconKind
  className?: string
}) {
  const html = PATHS[kind] ?? PATHS.activity
  return (
    <span className={`${styles.icon}${className ? ` ${className}` : ''}`} aria-hidden="true">
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.7}
        strokeLinecap="round"
        strokeLinejoin="round"
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </span>
  )
}

export function bucketToneClass(bucket: PrimaryBucket): string {
  switch (bucket) {
    case 'DONE':
      return styles.bDone
    case 'ONGOING':
      return styles.bOngoing
    case 'NEXT':
      return styles.bNext
    case 'QUEUED':
      return styles.bQueued
    case 'BLOCKED':
      return styles.bBlocked
    case 'RECONCILIATION_PENDING':
      return styles.bRecon
    default:
      return ''
  }
}
