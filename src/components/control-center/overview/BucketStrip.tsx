import type { PrimaryBucket } from '#/lib/control-plane-types'
import styles from './overview.module.css'
import { PRIMARY_BUCKETS, type OverviewBucketStrip } from './types'
import { SemanticIcon, bucketToneClass } from './SemanticIcon'
import { EmptySlot } from './SurfaceBanner'

export function BucketStrip({ data }: { data: OverviewBucketStrip | null }) {
  if (!data) {
    return (
      <section data-testid="overview-buckets" aria-labelledby="ov-buckets-title">
        <h2 id="ov-buckets-title" className={styles.sectionLabel}>
          Work buckets
        </h2>
        <EmptySlot>Bucket counts unavailable.</EmptySlot>
      </section>
    )
  }

  return (
    <section data-testid="overview-buckets" aria-labelledby="ov-buckets-title">
      <h2 id="ov-buckets-title" className={styles.sectionLabel}>
        Work buckets
      </h2>
      <div
        className={styles.bucketStrip}
        role="tablist"
        aria-label="Primary work buckets"
      >
        {PRIMARY_BUCKETS.map((bucket) => {
          const count = data.counts[bucket]
          const active = data.activeBucket === bucket
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
              <span>{bucket.replaceAll('_', ' ')}</span>
              <span className={styles.bucketCount} aria-label={`${bucket} count`}>
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
          title="STALE is an overlay filter, not a primary bucket"
        >
          <SemanticIcon kind="STALE" />
          <span>STALE</span>
          <span className={styles.bucketCount} aria-label="STALE overlay count">
            {data.staleCount}
          </span>
        </button>
      </div>
      <p className={styles.srOnly}>
        STALE is an overlay chip, not a sixth exclusive primary bucket. Primary buckets are mutually
        exclusive: DONE, RECONCILIATION_PENDING, ONGOING, NEXT, QUEUED, BLOCKED.
      </p>
    </section>
  )
}

export type { PrimaryBucket }
