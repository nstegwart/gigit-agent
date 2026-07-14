/**
 * Presentation maps for Work buckets / overlays.
 * Labels and icons only — never used to assign membership.
 * Owner chrome default: plain id-ID (01A OWNER MODE).
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
  DONE: { label: 'Selesai', shortLabel: 'Selesai', icon: 'check', tone: 'done' },
  RECONCILIATION_PENDING: {
    label: 'Sedang dicocokkan',
    shortLabel: 'Cocokkan',
    icon: 'alert',
    tone: 'recon',
  },
  ONGOING: { label: 'Sedang dikerjakan', shortLabel: 'Dikerjakan', icon: 'bolt', tone: 'ongoing' },
  NEXT: { label: 'Berikutnya', shortLabel: 'Berikut', icon: 'arrow', tone: 'next' },
  QUEUED: { label: 'Menunggu giliran', shortLabel: 'Antri', icon: 'inbox', tone: 'queued' },
  BLOCKED: { label: 'Terhambat', shortLabel: 'Hambat', icon: 'lock', tone: 'blocked' },
}

export const OVERLAY_LABELS: Readonly<Record<StaleOverlayKind, string>> = {
  STALE_DATA_SOURCE: 'Sumber data basi',
  EXPIRED_STALLED_RUN: 'Run kedaluwarsa / macet',
  STALE_CLAIM: 'Klaim basi',
  STALE_DISPATCH_PLAN: 'Rencana dispatch basi',
  STALE_ACCOUNT_SYNC: 'Sinkron akun basi',
  BEYOND_STAGE_ONGOING: 'Klaim di luar tahap',
  RECONCILIATION_DRILLDOWN: 'Drilldown pencocokan',
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
  if (u === 'PRODUCTIVE') return 'Produktif'
  if (u === 'IDLE') return 'Menganggur'
  if (u === 'STALLED') return 'Macet'
  if (u === 'EXPIRED') return 'Kedaluwarsa'
  return String(liveness)
}
