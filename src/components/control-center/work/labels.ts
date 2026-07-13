/**
 * Presentation maps for Work buckets / overlays.
 * Labels and icons only — never used to assign membership.
 */
import type { IconName } from '#/lib/icons'
import {
  STALE_FAMILY_OVERLAYS as STALE_FAMILY_OVERLAYS_SHARED,
  type PrimaryBucket,
  type StaleOverlayKind,
} from '#/lib/control-plane-types'

export interface BucketSemantic {
  label: string
  shortLabel: string
  /** Icon from local Icon set (text + icon + color; never color alone). */
  icon: IconName
  /** CSS module suffix for semantic color token. */
  tone: 'done' | 'recon' | 'ongoing' | 'next' | 'queued' | 'blocked'
}

export const BUCKET_SEMANTICS: Readonly<Record<PrimaryBucket, BucketSemantic>> = {
  DONE: { label: 'Done', shortLabel: 'Done', icon: 'check', tone: 'done' },
  RECONCILIATION_PENDING: {
    label: 'Reconciliation pending',
    shortLabel: 'Reconcile',
    icon: 'alert',
    tone: 'recon',
  },
  ONGOING: { label: 'Ongoing', shortLabel: 'Ongoing', icon: 'bolt', tone: 'ongoing' },
  NEXT: { label: 'Next', shortLabel: 'Next', icon: 'arrow', tone: 'next' },
  QUEUED: { label: 'Queued', shortLabel: 'Queued', icon: 'inbox', tone: 'queued' },
  BLOCKED: { label: 'Blocked', shortLabel: 'Blocked', icon: 'lock', tone: 'blocked' },
}

export const OVERLAY_LABELS: Readonly<Record<StaleOverlayKind, string>> = {
  STALE_DATA_SOURCE: 'Stale data source',
  EXPIRED_STALLED_RUN: 'Expired / stalled run',
  STALE_CLAIM: 'Stale claim',
  STALE_DISPATCH_PLAN: 'Stale dispatch plan',
  STALE_ACCOUNT_SYNC: 'Stale account sync',
  BEYOND_STAGE_ONGOING: 'Beyond-stage claim',
  RECONCILIATION_DRILLDOWN: 'Reconciliation drilldown',
}

/** Overlays treated as the STALE chip family (ARCHITECTURE §9.1). */
export const STALE_FAMILY_OVERLAYS: ReadonlyArray<StaleOverlayKind> = STALE_FAMILY_OVERLAYS_SHARED

export function formatAgeSeconds(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return ''
  if (seconds < 60) return `${Math.floor(seconds)}s`
  const min = Math.floor(seconds / 60)
  if (min < 60) return `${min}m`
  const h = Math.floor(min / 60)
  const mm = min % 60
  return mm ? `${h}h ${mm}m` : `${h}h`
}

export function livenessLabel(liveness: string | null | undefined): string {
  if (!liveness) return ''
  const u = String(liveness).toUpperCase()
  if (u === 'PRODUCTIVE') return 'Productive'
  if (u === 'IDLE') return 'Idle'
  if (u === 'STALLED') return 'Stalled'
  if (u === 'EXPIRED') return 'Expired'
  return String(liveness)
}
