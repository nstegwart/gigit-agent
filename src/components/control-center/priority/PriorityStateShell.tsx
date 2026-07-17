import type { ReactNode } from 'react'
import {
  pinnedSurfaceDataAttrs,
  type PinnedSurfaceMeta,
} from '#/components/control-center/PinnedSurface'
import { Button, Disclosure, EmptyState, Skeleton } from '#/components/ui'
import type { PriorityUiState } from './constants'
import styles from './priority.module.css'

export interface PriorityStateShellProps {
  uiState: PriorityUiState
  errorCode?: string | null
  errorMessage?: string | null
  onRetry?: () => void
  liveMessage?: string | null
  staleReason?: string | null
  /** Envelope pin for root data attrs. */
  pin?: PinnedSurfaceMeta | null
  children?: ReactNode
}

const STATE_COPY: Record<
  PriorityUiState,
  { title: string; body: string; role?: 'status' | 'alert' }
> = {
  populated: { title: '', body: '' },
  loading: {
    title: 'Memuat portofolio prioritas',
    body: 'Mengambil envelope server… angka disembunyikan sampai data tiba.',
    role: 'status',
  },
  empty: {
    title: 'Belum ada data portofolio prioritas',
    body: 'Server mengembalikan envelope prioritas kosong untuk pin board ini.',
    role: 'status',
  },
  'zero-results': {
    title: 'Tidak ada item prioritas yang cocok',
    body: 'Filter tidak menemukan apa pun. Ini berbeda dari envelope board yang kosong.',
    role: 'status',
  },
  partial: {
    title: 'Data prioritas sebagian',
    body: 'Beberapa bagian Priority gagal dimuat. Hanya menampilkan field server yang tersedia.',
    role: 'alert',
  },
  stale: {
    title: 'Envelope prioritas sudah basi',
    body: 'Data pin sudah usang. Muat ulang untuk revisi board/lifecycle terkini.',
    role: 'status',
  },
  disconnected: {
    title: 'Terputus',
    body: 'Koneksi transport mati. Sambungkan kembali untuk memuat kebenaran portofolio prioritas.',
    role: 'alert',
  },
  error: {
    title: 'Gagal memuat prioritas',
    body: 'Kegagalan keras saat memuat portofolio prioritas. Coba lagi bila siap.',
    role: 'alert',
  },
  forbidden: {
    title: 'Akses ditolak',
    body: 'Anda tidak punya wewenang membaca portofolio prioritas.',
    role: 'alert',
  },
  'needs-human': {
    title: 'Memerlukan keputusan manusia (needs human)',
    body: 'Keputusan pemblokir harus diselesaikan sebelum penjadwalan prioritas dapat dilanjutkan.',
    role: 'alert',
  },
}

/**
 * Required UI state shell (UI_CONTRACT §5). Never fabricates numbers in non-populated states.
 */
export function PriorityStateShell({
  uiState,
  errorCode,
  errorMessage,
  onRetry,
  liveMessage,
  staleReason,
  pin,
  children,
}: PriorityStateShellProps) {
  const meta = STATE_COPY[uiState]
  const showBlocking =
    uiState === 'loading' ||
    uiState === 'empty' ||
    uiState === 'zero-results' ||
    uiState === 'disconnected' ||
    uiState === 'error' ||
    uiState === 'forbidden'

  const showBanner =
    uiState === 'partial' ||
    uiState === 'stale' ||
    uiState === 'needs-human' ||
    uiState === 'error' ||
    uiState === 'disconnected' ||
    uiState === 'forbidden'

  return (
    <div
      className={styles.screen}
      data-testid="priority-screen"
      data-ui-state={uiState}
      data-portfolio="SALES_WEB_RELATED_BACKEND"
      {...pinnedSurfaceDataAttrs(pin)}
    >
      <div className={styles.liveRegion} aria-live="polite" aria-atomic="true">
        {liveMessage ?? (showBlocking ? meta.title : null)}
      </div>

      {showBanner ? (
        <div
          className={`${styles.banner} ${styles[`banner_${uiState.replace(/-/g, '_')}`] ?? ''}`}
          role={meta.role ?? 'status'}
          data-testid="priority-state-banner"
        >
          <div className={styles.bannerTitle}>{meta.title}</div>
          <p className={styles.bannerBody}>
            {errorMessage ?? meta.body}
            {uiState === 'stale' && staleReason ? (
              <>
                {' '}
                Alasan:{' '}
                <code data-testid="priority-stale-reason">{staleReason}</code>
              </>
            ) : null}
          </p>
          {errorCode ? (
            <Disclosure summary="Detail teknis" data-testid="priority-error-disclosure">
              <p className={styles.errorCode}>
                Code: <code data-testid="priority-error-code">{errorCode}</code>
              </p>
            </Disclosure>
          ) : null}
          {(uiState === 'error' || uiState === 'disconnected') && onRetry ? (
            <div className={styles.bannerActions}>
              <Button
                type="button"
                variant="primary"
                size="md"
                onClick={onRetry}
                data-testid="priority-retry"
              >
                Coba lagi
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}

      {uiState === 'loading' ? (
        <div
          className={styles.skeleton}
          data-testid="priority-skeleton"
          role="status"
          aria-busy="true"
          aria-label="Memuat portofolio prioritas"
        >
          <Skeleton className={styles.skeletonBlock} height={88} width="100%" />
          <Skeleton className={styles.skeletonBlock} height={88} width="100%" />
          <Skeleton className={styles.skeletonBlock} height={88} width="100%" />
        </div>
      ) : null}

      {uiState === 'empty' || uiState === 'zero-results' || uiState === 'forbidden' ? (
        <EmptyState
          data-testid={`priority-state-${uiState}`}
          title={meta.title}
          description={errorMessage ?? meta.body}
        />
      ) : null}

      {uiState === 'disconnected' && !onRetry ? (
        <EmptyState
          data-testid="priority-state-disconnected"
          title={meta.title}
          description={errorMessage ?? meta.body}
        />
      ) : null}

      {/* Content when not blocking (populated / partial / stale / needs-human). */}
      {!showBlocking ? children : null}
    </div>
  )
}
