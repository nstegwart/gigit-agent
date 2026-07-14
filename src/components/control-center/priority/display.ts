/**
 * Presentation-only helpers. Never invent majority PASS, readiness 100, or complete=true.
 * Human labels are id-ID plain language (ART-UX-DIRECTION STATUS SENTENCE CONTRACT);
 * raw enums remain available via title / data-* / Detail teknis consumers.
 *
 * Grounding (src/lib/control-plane-types.ts):
 * - PriorityFrontierState, BoardCappedBy, G5DomainId / G5DomainStatus
 * - PriorityAllocationResult portfolioId SALES_WEB_RELATED_BACKEND
 * - NON_PRIORITY_REASON_ALLOWLIST (constants.ts / UI_CONTRACT §8)
 */
import type { BoardCappedBy, G5DomainId, G5DomainStatus } from '#/lib/control-plane-types'
import {
  NON_PRIORITY_REASON_ALLOWLIST,
  NON_PRIORITY_REASON_LABELS,
  PRIORITY_PORTFOLIO_ID,
  type NonPriorityReasonCode,
} from './constants'

/** Literal N-A token for null/undefined capacity share and majority. */
export const NA_TOKEN = 'N-A' as const

/**
 * Owner-facing portfolio name (ART-UX-DIRECTION HUMAN TAXONOMY).
 * Technical id stays SALES_WEB_RELATED_BACKEND.
 */
export const PORTFOLIO_HUMAN_LABEL: Readonly<Record<string, string>> = {
  [PRIORITY_PORTFOLIO_ID]:
    'Prioritas Utama — Panel Sales, Website, dan Backend Terkait',
}

export function humanPortfolioLabel(portfolioId: string | null | undefined): string {
  if (!portfolioId) return PORTFOLIO_HUMAN_LABEL[PRIORITY_PORTFOLIO_ID] ?? PRIORITY_PORTFOLIO_ID
  return PORTFOLIO_HUMAN_LABEL[portfolioId] ?? portfolioId
}

/**
 * Majority display: true → "PASS", false → "FAIL", null/undefined → "N-A".
 * Never maps null/false to PASS. Tokens kept for fail-closed contracts / tests.
 */
export function formatMajorityAllocationPass(
  value: boolean | null | undefined,
): 'PASS' | 'FAIL' | typeof NA_TOKEN {
  if (value === true) return 'PASS'
  if (value === false) return 'FAIL'
  return NA_TOKEN
}

/** Plain id-ID sentence for majority allocation (primary UX). */
export function humanMajorityAllocation(value: boolean | null | undefined): string {
  if (value === true) return 'Alokasi mayoritas terpenuhi.'
  if (value === false) return 'Alokasi mayoritas belum terpenuhi.'
  return 'Alokasi mayoritas tidak berlaku (cakupan/kapasitas tidak memungkinkan perhitungan).'
}

/**
 * Share display: null → N-A; number → fixed fraction (server exact, no recompute).
 */
export function formatCapacityShare(
  share: number | null | undefined,
  fractionDigits = 4,
): string {
  if (share === null || share === undefined || Number.isNaN(share)) return NA_TOKEN
  return share.toFixed(fractionDigits)
}

/**
 * Readiness percent: null → N-A; never coerce empty-scope null into 100.
 */
export function formatReadinessPercent(
  value: number | null | undefined,
  fractionDigits = 1,
): string {
  if (value === null || value === undefined || Number.isNaN(value)) return NA_TOKEN
  return value.toFixed(fractionDigits)
}

export function formatCappedBy(cappedBy: string | null | undefined): string {
  if (cappedBy === null || cappedBy === undefined || cappedBy === '') return NA_TOKEN
  return cappedBy
}

/**
 * BoardCappedBy (control-plane-types + readiness-policy applyBoardReadinessCap):
 * G5 | EVIDENCE | DATA_INTEGRITY_OR_P0 | EMPTY_PRODUCT_SCOPE | null
 */
export function humanCappedBy(cappedBy: BoardCappedBy | string | null | undefined): string {
  switch (cappedBy) {
    case 'G5':
      return 'Dibatasi gerbang G5 (sembilan domain kesiapan program belum lolos).'
    case 'EVIDENCE':
      return 'Dibatasi kelengkapan bukti — bukti target belum memadai.'
    case 'DATA_INTEGRITY_OR_P0':
      return 'Dibatasi integritas data atau pemblokir P0.'
    case 'EMPTY_PRODUCT_SCOPE':
      return 'Cakupan produk kosong — kesiapan tidak dihitung (N-A).'
    case null:
    case undefined:
    case '':
      return 'Tidak ada pembatas kesiapan yang aktif.'
    default:
      return `Dibatasi oleh faktor server: ${String(cappedBy)}.`
  }
}

/**
 * PriorityFrontierState (control-plane-types) + ZERO_SCHEDULABLE_CAPACITY reason
 * from rollup-v3 priority allocation.
 */
export function humanFrontierState(state: string | null | undefined): string {
  switch (state) {
    case 'PRIORITY_FRONTIER_ACTIVE':
      return 'Frontier prioritas aktif — ada pekerjaan prioritas yang dapat dijadwalkan.'
    case 'PRIORITY_FRONTIER_COMPLETE':
      return 'Frontier prioritas selesai — tidak ada sisa pekerjaan prioritas terbuka.'
    case 'PRIORITY_FRONTIER_BLOCKED':
      return 'Frontier prioritas terhambat — pekerjaan prioritas tidak dapat dilanjutkan.'
    case 'PRIORITY_FRONTIER_EMPTY':
      return 'Frontier prioritas kosong — belum ada keanggotaan prioritas yang valid.'
    case 'PRIORITY_FRONTIER_EXHAUSTED':
      return 'Frontier prioritas habis — semua slot prioritas yang bisa dijadwalkan sudah terpakai.'
    default:
      if (!state) return 'Status frontier tidak tersedia.'
      return `Status frontier: ${state}.`
  }
}

/** Capacity / allocation reason codes emitted by rollup-v3 (display only). */
export function humanCapacityReason(reason: string | null | undefined): string {
  if (reason == null || reason === '') return 'Tidak ada alasan server untuk status kapasitas ini.'
  switch (reason) {
    case 'ZERO_SCHEDULABLE_CAPACITY':
      return 'Tidak ada kapasitas penjadwalan (semua peran = 0) — mayoritas gagal, bukan lolos.'
    case 'PRIORITY_FRONTIER_EMPTY':
      return 'Frontier prioritas kosong — share dan mayoritas ditampilkan N-A (fail-closed).'
    case 'PRIORITY_FRONTIER_EXHAUSTED':
      return 'Frontier prioritas habis — tidak ada sisa pekerjaan prioritas yang dapat diambil.'
    case 'PRIORITY_FRONTIER_BLOCKED':
      return 'Frontier prioritas terhambat — alokasi di luar prioritas harus memakai alasan allowlist.'
    case 'PRIORITY_FRONTIER_ACTIVE':
      return 'Frontier prioritas aktif.'
    case 'PRIORITY_FRONTIER_COMPLETE':
      return 'Frontier prioritas selesai.'
    default:
      return `Alasan server: ${reason}.`
  }
}

export function formatBoolean(value: boolean | null | undefined): string {
  if (value === true) return 'true'
  if (value === false) return 'false'
  return NA_TOKEN
}

export function humanBoolean(value: boolean | null | undefined, whenTrue: string, whenFalse: string): string {
  if (value === true) return whenTrue
  if (value === false) return whenFalse
  return 'Tidak diketahui (N-A)'
}

export function isAllowlistedNonPriorityReason(
  reason: string,
): reason is NonPriorityReasonCode {
  return (NON_PRIORITY_REASON_ALLOWLIST as ReadonlyArray<string>).includes(reason)
}

export function labelNonPriorityReason(reason: string): string {
  if (isAllowlistedNonPriorityReason(reason)) {
    return NON_PRIORITY_REASON_LABELS[reason]
  }
  return reason
}

/**
 * Filter to allowlisted reasons only — unknown codes are excluded from UI proof list
 * (server must not emit them; UI fail-closes by not rendering as justified).
 */
export function filterAllowlistedReasons<T extends { reason: string }>(
  items: ReadonlyArray<T>,
): { allowed: T[]; rejected: T[] } {
  const allowed: T[] = []
  const rejected: T[] = []
  for (const item of items) {
    if (isAllowlistedNonPriorityReason(item.reason)) allowed.push(item)
    else rejected.push(item)
  }
  return { allowed, rejected }
}

export function majoritySemanticClass(
  value: boolean | null | undefined,
): 'pass' | 'fail' | 'na' {
  if (value === true) return 'pass'
  if (value === false) return 'fail'
  return 'na'
}

/** G5DomainStatus — primary id-ID; raw status stays in title/code. */
export function humanG5Status(status: G5DomainStatus | string): string {
  switch (status) {
    case 'NOT_STARTED':
      return 'Belum dimulai'
    case 'IN_PROGRESS':
      return 'Sedang berjalan'
    case 'PASS':
      return 'Lolos'
    case 'FAIL':
      return 'Gagal'
    case 'BLOCKED':
      return 'Terhambat'
    default:
      return String(status)
  }
}

/**
 * id-ID labels for the nine required G5 domains (AC-LIFE-05).
 * domainId slugs remain the technical key (G5_DOMAIN_LABELS in control-plane-types
 * are English contract tokens — we project human copy only in this UI layer).
 */
export const G5_DOMAIN_HUMAN_LABELS: Readonly<Record<G5DomainId, string>> = {
  security: 'Keamanan',
  performance_capacity: 'Performa dan kapasitas',
  migration_data_integrity: 'Migrasi dan integritas data',
  rollback_restore: 'Rollback dan pemulihan',
  backup_dr: 'Cadangan dan pemulihan bencana (DR)',
  monitoring_alerts_runbooks: 'Pemantauan, peringatan, dan runbook',
  config_secrets: 'Konfigurasi dan rahasia',
  cutover_rehearsal: 'Latihan cutover',
  dependency_provider_readiness: 'Kesiapan dependensi / penyedia',
}

export function humanG5DomainLabel(domainId: string, fallbackLabel?: string | null): string {
  if (domainId in G5_DOMAIN_HUMAN_LABELS) {
    return G5_DOMAIN_HUMAN_LABELS[domainId as G5DomainId]
  }
  return fallbackLabel || domainId
}
