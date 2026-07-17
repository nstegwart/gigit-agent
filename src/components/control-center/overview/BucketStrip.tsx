import type { PrimaryBucket } from '#/lib/control-plane-types'
import styles from './overview.module.css'
import type { OverviewBucketStrip } from './types'
import { SemanticIcon, bucketToneClass } from './SemanticIcon'
import { EmptySlot } from './SurfaceBanner'

/**
 * ART-UX-DIRECTION.md (sha 4eca14e1…): five owner work buckets stay primary.
 * Reconciliation is a visible integrity exception rail; STALE remains an overlay.
 * Canonical membership/counts still come from the server PrimaryBucket contract.
 */
const ACTIVE_OWNER_BUCKETS = [
  'DONE',
  'ONGOING',
  'NEXT',
  'QUEUED',
  'BLOCKED',
] as const
const RECONCILIATION_BUCKET: PrimaryBucket = 'RECONCILIATION_PENDING'

/** Owner-facing id-ID labels — presentation only; membership still uses PrimaryBucket. */
const BUCKET_OWNER_LABEL: Record<PrimaryBucket, string> = {
  DONE: 'Selesai',
  RECONCILIATION_PENDING: 'Sedang dicocokkan',
  ONGOING: 'Sedang dikerjakan',
  NEXT: 'Berikutnya',
  QUEUED: 'Menunggu giliran',
  BLOCKED: 'Terhambat',
}

export function BucketStrip({ data }: { data: OverviewBucketStrip | null }) {
  if (!data) {
    return (
      <section
        data-testid="overview-buckets"
        aria-labelledby="ov-buckets-title"
      >
        <h2 id="ov-buckets-title" className={styles.sectionLabel}>
          Lima bucket pekerjaan aktif
        </h2>
        <EmptySlot>Hitungan bucket tidak tersedia.</EmptySlot>
      </section>
    )
  }

  return (
    <section data-testid="overview-buckets" aria-labelledby="ov-buckets-title">
      <h2 id="ov-buckets-title" className={styles.sectionLabel}>
        Lima bucket pekerjaan aktif
      </h2>
      <p className={styles.bucketIntro}>
        Setiap pekerjaan berada tepat di satu bucket aktif. Ini adalah status
        pekerjaan — terpisah dari kesiapan Mapping, Product, dan Program di kartu
        di atas.
      </p>
      <div
        className={styles.bucketStrip}
        role="tablist"
        aria-label="Lima bucket pekerjaan aktif"
      >
        {ACTIVE_OWNER_BUCKETS.map((bucket) => {
          const count = data.counts[bucket]
          const active = data.activeBucket === bucket
          const label = BUCKET_OWNER_LABEL[bucket]
          return (
            <button
              key={bucket}
              type="button"
              role="tab"
              aria-selected={active}
              data-bucket={bucket}
              data-active={active ? 'true' : 'false'}
              className={`${styles.bucketBtn} ${bucketToneClass(bucket)}${
                active ? ` ${styles.bucketBtnActive}` : ''
              }`}
              onClick={() => data.onSelectBucket?.(bucket)}
            >
              <span className={styles.bucketBtnIcon} aria-hidden="true">
                <SemanticIcon kind={bucket} />
              </span>
              <span className={styles.bucketBtnBody}>
                <span
                  className={styles.bucketCount}
                  aria-label={`${label} count`}
                >
                  {count}
                </span>
                <span className={styles.bucketBtnLabel}>{label}</span>
              </span>
            </button>
          )
        })}
      </div>

      <div
        className={styles.integrityRail}
        role="group"
        aria-labelledby="ov-integrity-title"
        data-testid="overview-integrity-rail"
      >
        <div className={styles.integrityCopy}>
          <h3 id="ov-integrity-title" className={styles.integrityTitle}>
            Pengecualian integritas
          </h3>
          <p>
            Sedang dicocokkan bukan antrean normal. Sistem memeriksa bukti dan
            kepemilikan sebelum pekerjaan dijadwalkan ulang; Basi hanya
            menyaring data yang perlu diperbarui.
          </p>
        </div>
        <div className={styles.integrityActions}>
          <button
            type="button"
            aria-pressed={data.activeBucket === RECONCILIATION_BUCKET}
            data-bucket={RECONCILIATION_BUCKET}
            data-integrity-exception="true"
            data-active={
              data.activeBucket === RECONCILIATION_BUCKET ? 'true' : 'false'
            }
            className={`${styles.bucketBtn} ${styles.integrityBtn} ${bucketToneClass(
              RECONCILIATION_BUCKET,
            )}${
              data.activeBucket === RECONCILIATION_BUCKET
                ? ` ${styles.bucketBtnActive}`
                : ''
            }`}
            onClick={() => data.onSelectBucket?.(RECONCILIATION_BUCKET)}
          >
            <span className={styles.bucketBtnIcon} aria-hidden="true">
              <SemanticIcon kind={RECONCILIATION_BUCKET} />
            </span>
            <span className={styles.bucketBtnBody}>
              <span
                className={styles.bucketCount}
                aria-label={`${BUCKET_OWNER_LABEL[RECONCILIATION_BUCKET]} count`}
              >
                {data.counts[RECONCILIATION_BUCKET]}
              </span>
              <span className={styles.bucketBtnLabel}>
                {BUCKET_OWNER_LABEL[RECONCILIATION_BUCKET]}
              </span>
            </span>
          </button>
          <button
            type="button"
            aria-pressed={!!data.staleActive}
            data-bucket="STALE"
            data-overlay="true"
            data-active={data.staleActive ? 'true' : 'false'}
            className={`${styles.bucketBtn} ${styles.integrityBtn} ${styles.bStale}${
              data.staleActive ? ` ${styles.bucketBtnActive}` : ''
            }`}
            onClick={() => data.onToggleStale?.()}
            title="Basi adalah filter overlay, bukan bucket utama"
          >
            <span className={styles.bucketBtnIcon} aria-hidden="true">
              <SemanticIcon kind="STALE" />
            </span>
            <span className={styles.bucketBtnBody}>
              <span
                className={styles.bucketCount}
                aria-label="Hitungan overlay Basi"
              >
                {data.staleCount}
              </span>
              <span className={styles.bucketBtnLabel}>Basi</span>
            </span>
          </button>
        </div>
      </div>
    </section>
  )
}

export type { PrimaryBucket }
