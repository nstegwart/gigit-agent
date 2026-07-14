import styles from './overview.module.css'
import type { OverviewSurfaceState, TypedErrorShape } from './types'

export function SurfaceBanner({
  state,
  error,
  partialErrors,
  staleReason,
  onRetry,
  onReconnect,
}: {
  state: OverviewSurfaceState
  error?: TypedErrorShape | null
  partialErrors?: TypedErrorShape[]
  staleReason?: string | null
  onRetry?: () => void
  onReconnect?: () => void
}) {
  if (state === 'populated' || state === 'needs-human' || state === 'empty') {
    return null
  }

  if (state === 'loading') {
    return (
      <div className={`${styles.banner} ${styles.bannerMuted}`} role="status" data-state="loading">
        <div className={styles.bannerBody}>
          <div className={styles.bannerTitle}>Memuat ringkasan</div>
          <p className={styles.bannerText}>Mengambil envelope misi ter-pin…</p>
        </div>
      </div>
    )
  }

  if (state === 'zero-results') {
    return (
      <div
        className={`${styles.banner} ${styles.bannerMuted}`}
        role="status"
        data-state="zero-results"
      >
        <div className={styles.bannerBody}>
          <div className={styles.bannerTitle}>Tidak ada hasil yang cocok</div>
          <p className={styles.bannerText}>
            Filter tidak menemukan pekerjaan. Hapus filter untuk melihat board penuh.
          </p>
        </div>
      </div>
    )
  }

  if (state === 'partial') {
    return (
      <div
        className={`${styles.banner} ${styles.bannerCompact} ${styles.bannerWarn}`}
        role="alert"
        data-state="partial"
      >
        <div className={styles.bannerBody}>
          <div className={styles.bannerTitle}>Ringkasan sebagian</div>
          <p className={styles.bannerText}>
            Beberapa bagian gagal — hanya menampilkan data yang tersedia.
          </p>
          {partialErrors?.length ? (
            <details className={styles.bannerDetails}>
              <summary>Detail teknis ({partialErrors.length} kode)</summary>
              <ul className={styles.blockers}>
                {partialErrors.map((e) => (
                  <li key={`${e.code}:${e.message}`} className={styles.blockerItem}>
                    <span>
                      <strong>{e.code}</strong>: {e.message}
                    </span>
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
        </div>
        {onRetry ? (
          <div className={styles.bannerActions}>
            <button type="button" className={styles.actionBtn} onClick={onRetry}>
              Coba lagi bagian yang gagal
            </button>
          </div>
        ) : null}
      </div>
    )
  }

  if (state === 'stale') {
    return (
      <div className={`${styles.banner} ${styles.bannerWarn}`} role="status" data-state="stale">
        <div className={styles.bannerBody}>
          <div className={styles.bannerTitle}>Data basi</div>
          <p className={styles.bannerText}>
            {staleReason?.trim() || 'Envelope ditandai basi. Muat ulang untuk pin terkini.'}
          </p>
        </div>
        {onRetry ? (
          <div className={styles.bannerActions}>
            <button type="button" className={styles.actionBtn} onClick={onRetry}>
              Muat ulang
            </button>
          </div>
        ) : null}
      </div>
    )
  }

  if (state === 'disconnected') {
    return (
      <div
        className={`${styles.banner} ${styles.bannerError}`}
        role="alert"
        data-state="disconnected"
      >
        <div className={styles.bannerBody}>
          <div className={styles.bannerTitle}>Terputus</div>
          <p className={styles.bannerText}>
            Transport mati. Sambungkan kembali untuk melanjutkan pembaruan langsung.
          </p>
        </div>
        {onReconnect ? (
          <div className={styles.bannerActions}>
            <button type="button" className={styles.actionBtn} onClick={onReconnect}>
              Sambungkan kembali
            </button>
          </div>
        ) : null}
      </div>
    )
  }

  if (state === 'error') {
    const shortMsg = error?.message?.trim() || 'Kesalahan tidak diketahui'
    return (
      <div
        className={`${styles.banner} ${styles.bannerCompact} ${styles.bannerError}`}
        role="alert"
        data-state="error"
      >
        <div className={styles.bannerBody}>
          <div className={styles.bannerTitle}>Ringkasan gagal</div>
          <p className={styles.bannerText}>Tidak dapat memuat envelope misi.</p>
          {error?.code || shortMsg ? (
            <details className={styles.bannerDetails}>
              <summary>Detail teknis</summary>
              <p className={styles.bannerText}>
                {error?.code ? (
                  <>
                    <strong>{error.code}</strong>
                    {error.message ? `: ${error.message}` : null}
                  </>
                ) : (
                  shortMsg
                )}
              </p>
            </details>
          ) : null}
        </div>
        {onRetry ? (
          <div className={styles.bannerActions}>
            <button type="button" className={styles.actionBtn} onClick={onRetry}>
              Coba lagi
            </button>
          </div>
        ) : null}
      </div>
    )
  }

  if (state === 'forbidden') {
    return (
      <div className={`${styles.banner} ${styles.bannerError}`} role="alert" data-state="forbidden">
        <div className={styles.bannerBody}>
          <div className={styles.bannerTitle}>Akses ditolak</div>
          <p className={styles.bannerText}>
            {error?.code === 'AUTHORIZATION_REQUIRED' || error?.code
              ? `${error.code}${error.message ? `: ${error.message}` : ''}`
              : 'Anda tidak punya izin melihat ringkasan ini (401/403).'}
          </p>
        </div>
      </div>
    )
  }

  return null
}

export function OverviewSkeleton() {
  return (
    <div className={styles.skeleton} data-testid="overview-skeleton" aria-hidden="true">
      <div className={styles.skelBlock} />
      <div className={styles.skelBlock} />
      <div className={styles.skelBlock} />
      <div className={styles.skelBlock} />
    </div>
  )
}

export function EmptySlot({ children }: { children: React.ReactNode }) {
  return (
    <div className={styles.emptySlot} data-empty="true">
      {children}
    </div>
  )
}
