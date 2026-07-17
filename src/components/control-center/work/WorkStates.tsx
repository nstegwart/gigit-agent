import { Button, EmptyState, Skeleton } from '#/components/ui'
import { Icon } from '#/lib/icons'
import type { PrimaryBucket } from '#/lib/control-plane-types'
import { BUCKET_SEMANTICS } from './labels'
import type { WorkScreenError, WorkSurfaceState } from './types'
import styles from './work.module.css'

export interface WorkStatesProps {
  state: WorkSurfaceState
  error?: WorkScreenError | null
  partialMessage?: string | null
  envelopeStale?: boolean
  envelopeStaleReason?: string | null
  needsHumanMessage?: string | null
  onRetry?: () => void
  onRefresh?: () => void
  onReconnect?: () => void
}

/** Loading skeleton — no fake numbers (UI_CONTRACT §5). */
export function WorkLoadingState() {
  return (
    <div
      className={styles.skeletonList}
      role="status"
      aria-live="polite"
      aria-busy="true"
      data-testid="work-state-loading"
    >
      <span className={styles.srOnly}>Memuat item pekerjaan…</span>
      <Skeleton height={56} width="100%" />
      <Skeleton height={56} width="100%" />
      <Skeleton height={56} width="92%" />
      <Skeleton height={56} width="96%" />
    </div>
  )
}

export function WorkEmptyState({
  kind,
  activeBucket,
  staleOverlayActive,
  onClearStale,
  onSwitchToOngoing,
}: {
  kind: 'empty' | 'zero-results'
  activeBucket?: PrimaryBucket
  staleOverlayActive?: boolean
  onClearStale?: () => void
  onSwitchToOngoing?: () => void
}) {
  const bucketLabel = activeBucket
    ? (BUCKET_SEMANTICS[activeBucket]?.label ?? activeBucket)
    : 'bucket ini'
  const title =
    kind === 'zero-results'
      ? 'Tidak ada pekerjaan yang cocok'
      : 'Tidak ada pekerjaan di board ini'
  const body =
    kind === 'zero-results'
      ? staleOverlayActive
        ? `Tidak ada baris server di ${bucketLabel} dengan filter BASI aktif. Hapus BASI atau ganti bucket.`
        : `Tidak ada baris server di bucket ${bucketLabel} untuk pin saat ini.`
      : activeBucket
        ? `Tidak ada pekerjaan terlacak di ${bucketLabel} untuk tahap aktif.`
        : 'Board ini tidak punya pekerjaan terlacak untuk tahap aktif.'
  const showClearStale =
    kind === 'zero-results' && !!staleOverlayActive && !!onClearStale
  const showSwitchOngoing =
    kind === 'zero-results' &&
    !!onSwitchToOngoing &&
    !!activeBucket &&
    activeBucket !== 'ONGOING'

  const action =
    showClearStale || showSwitchOngoing ? (
      <div className={styles.bannerActions}>
        {showClearStale ? (
          <Button
            type="button"
            variant="primary"
            size="sm"
            onClick={onClearStale}
            data-testid="work-empty-clear-stale"
          >
            Hapus filter BASI
          </Button>
        ) : null}
        {showSwitchOngoing ? (
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={onSwitchToOngoing}
            data-testid="work-empty-switch-ongoing"
          >
            Pindah ke Sedang dikerjakan
          </Button>
        ) : null}
      </div>
    ) : undefined

  return (
    <EmptyState
      icon={<Icon name="inbox" size={20} />}
      title={title}
      description={body}
      action={action}
      data-testid={
        kind === 'zero-results' ? 'work-state-zero-results' : 'work-state-empty'
      }
      data-active-bucket={activeBucket ?? undefined}
      data-stale-overlay={staleOverlayActive ? '1' : '0'}
    />
  )
}

/**
 * Banner / empty / error surfaces for Work. State is parent-controlled;
 * this package never invents transport outcomes.
 */
export function WorkStates({
  state,
  error,
  partialMessage,
  envelopeStale,
  envelopeStaleReason,
  needsHumanMessage,
  activeBucket,
  staleOverlayActive,
  onRetry,
  onRefresh,
  onReconnect,
  onClearStale,
  onSwitchToOngoing,
}: WorkStatesProps & {
  activeBucket?: PrimaryBucket
  staleOverlayActive?: boolean
  onClearStale?: () => void
  onSwitchToOngoing?: () => void
}) {
  if (state === 'loading') return <WorkLoadingState />

  if (state === 'empty') {
    return <WorkEmptyState kind="empty" activeBucket={activeBucket} />
  }
  if (state === 'zero-results') {
    return (
      <WorkEmptyState
        kind="zero-results"
        activeBucket={activeBucket}
        staleOverlayActive={staleOverlayActive}
        onClearStale={onClearStale}
        onSwitchToOngoing={onSwitchToOngoing}
      />
    )
  }

  if (state === 'disconnected') {
    return (
      <div
        className={`${styles.banner} ${styles.bannerMuted}`}
        role="alert"
        data-testid="work-state-disconnected"
      >
        <Icon name="alert" size={18} />
        <div className={styles.bannerBody}>
          <p className={styles.bannerTitle}>Terputus</p>
          <p className={styles.bannerText}>
            Transport mati. Data pekerjaan mungkin tidak lengkap sampai
            tersambung kembali.
          </p>
        </div>
        <div className={styles.bannerActions}>
          {onReconnect ? (
            <Button
              type="button"
              variant="primary"
              size="sm"
              onClick={onReconnect}
              data-testid="work-reconnect"
            >
              Sambungkan kembali
            </Button>
          ) : null}
        </div>
      </div>
    )
  }

  if (state === 'forbidden') {
    return (
      <div
        className={`${styles.banner} ${styles.bannerError}`}
        role="alert"
        data-testid="work-state-forbidden"
      >
        <Icon name="lock" size={18} />
        <div className={styles.bannerBody}>
          <p className={styles.bannerTitle}>Akses ditolak</p>
          <p className={styles.bannerText}>
            {error?.message ??
              'Anda tidak berwenang melihat daftar pekerjaan ini (401/403).'}
          </p>
          {error?.code ? (
            <p className={styles.fieldError} data-testid="work-error-code">
              {error.code}
            </p>
          ) : null}
        </div>
      </div>
    )
  }

  if (state === 'error') {
    const fieldId = error?.field ? `work-field-error-${error.field}` : undefined
    return (
      <div
        className={`${styles.banner} ${styles.bannerError}`}
        role="alert"
        data-testid="work-state-error"
        aria-describedby={fieldId}
      >
        <Icon name="alert" size={18} />
        <div className={styles.bannerBody}>
          <p className={styles.bannerTitle}>Tidak dapat memuat pekerjaan</p>
          <p className={styles.bannerText}>
            {error?.message ?? 'Kesalahan tidak diketahui'}
          </p>
          {error?.code ? (
            <p className={styles.fieldError} data-testid="work-error-code">
              {error.code}
            </p>
          ) : null}
          {error?.field ? (
            <p
              className={styles.fieldError}
              id={fieldId}
              data-testid="work-field-error"
            >
              Field: {error.field}
            </p>
          ) : null}
        </div>
        <div className={styles.bannerActions}>
          {error?.retryable !== false && onRetry ? (
            <Button
              type="button"
              variant="primary"
              size="sm"
              onClick={onRetry}
              data-testid="work-retry"
            >
              Coba lagi
            </Button>
          ) : null}
        </div>
      </div>
    )
  }

  return (
    <>
      {state === 'partial' || partialMessage ? (
        <div
          className={`${styles.banner} ${styles.bannerWarn}`}
          role="status"
          data-testid="work-state-partial"
        >
          <Icon name="alert" size={18} />
          <div className={styles.bannerBody}>
            <p className={styles.bannerTitle}>Data sebagian</p>
            <p className={styles.bannerText}>
              {partialMessage ??
                'Beberapa bagian gagal; hanya menampilkan baris yang tersedia.'}
            </p>
          </div>
          <div className={styles.bannerActions}>
            {onRetry ? (
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={onRetry}
                data-testid="work-retry"
              >
                Coba lagi
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}

      {state === 'stale' || envelopeStale ? (
        <div
          className={`${styles.banner} ${styles.bannerWarn}`}
          role="status"
          data-testid="work-state-stale"
        >
          <Icon name="clock" size={18} />
          <div className={styles.bannerBody}>
            <p className={styles.bannerTitle}>Envelope basi</p>
            <p className={styles.bannerText}>
              {envelopeStaleReason ??
                'Server menandai respons ini basi. Muat ulang untuk pin terkini.'}
            </p>
          </div>
          <div className={styles.bannerActions}>
            {onRefresh ? (
              <Button
                type="button"
                variant="primary"
                size="sm"
                onClick={onRefresh}
                data-testid="work-refresh"
              >
                Muat ulang
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}

      {state === 'needs-human' || needsHumanMessage ? (
        <div
          className={`${styles.banner} ${styles.bannerError}`}
          role="status"
          data-testid="work-state-needs-human"
        >
          <Icon name="flag" size={18} />
          <div className={styles.bannerBody}>
            <p className={styles.bannerTitle}>Memerlukan keputusan manusia</p>
            <p className={styles.bannerText}>
              {needsHumanMessage ??
                'Keputusan pemblokir terbuka dinaikkan untuk board ini.'}
            </p>
          </div>
        </div>
      ) : null}
    </>
  )
}
