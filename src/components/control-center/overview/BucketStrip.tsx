import type { PrimaryBucket } from '#/lib/control-plane-types'
import styles from './overview.module.css'
import { PRIMARY_BUCKETS, type OverviewBucketStrip } from './types'
import { SemanticIcon, bucketToneClass } from './SemanticIcon'
import { EmptySlot } from './SurfaceBanner'

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
      <section data-testid="overview-buckets" aria-labelledby="ov-buckets-title">
        <h2 id="ov-buckets-title" className={styles.sectionLabel}>
          Ringkasan bucket pekerjaan
        </h2>
        <EmptySlot>Hitungan bucket tidak tersedia.</EmptySlot>
      </section>
    )
  }

  return (
    <section data-testid="overview-buckets" aria-labelledby="ov-buckets-title">
      <h2 id="ov-buckets-title" className={styles.sectionLabel}>
        Ringkasan bucket pekerjaan
      </h2>
      <div
        className={styles.bucketStrip}
        role="tablist"
        aria-label="Bucket pekerjaan utama"
      >
        {PRIMARY_BUCKETS.map((bucket) => {
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
              <SemanticIcon kind={bucket} />
              <span>{label}</span>
              <span className={styles.bucketCount} aria-label={`${label} count`}>
                {count}
              </span>
            </button>
          )
        })}
        <button
          type="button"
          role="tab"
          aria-selected={!!data.staleActive}
          data-bucket="STALE"
          data-overlay="true"
          data-active={data.staleActive ? 'true' : 'false'}
          className={`${styles.bucketBtn} ${styles.bStale}${
            data.staleActive ? ` ${styles.bucketBtnActive}` : ''
          }`}
          onClick={() => data.onToggleStale?.()}
          title="Basi adalah filter overlay, bukan bucket utama"
        >
          <SemanticIcon kind="STALE" />
          <span>Basi</span>
          <span className={styles.bucketCount} aria-label="Hitungan overlay Basi">
            {data.staleCount}
          </span>
        </button>
      </div>
      <p className={styles.srOnly}>
        Basi adalah chip overlay, bukan bucket utama keenam yang eksklusif. Bucket utama
        saling eksklusif: Selesai, Sedang dicocokkan, Sedang dikerjakan, Berikutnya,
        Menunggu giliran, Terhambat.
      </p>
    </section>
  )
}

export type { PrimaryBucket }
