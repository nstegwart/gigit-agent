/**
 * Direction B "Fitur unggulan" grid — presentation only.
 * Maps available project summaries; never invents feature catalog rows.
 */
import { Card, StatusChip, type StatusChipVariant } from '#/components/ui'
import styles from './overview.module.css'
import type { OverviewProjectSummary } from './types'

function statusVariant(label: string | undefined): StatusChipVariant {
  if (!label) return 'pending'
  const s = label.toUpperCase()
  if (/PROD|READY|DONE|SELESAI|PASS|COMPLETE|ACTIVE/.test(s)) return 'done'
  if (/BLOCK|FAIL|HOLD|STOP/.test(s)) return 'blocked'
  if (/WARN|MAP|PENDING|WAIT/.test(s)) return 'warn'
  if (/ONGOING|RUN|PROGRESS|BUILD/.test(s)) return 'ongoing'
  return 'pending'
}

export function FeaturedFeatures({
  projects,
}: {
  projects: OverviewProjectSummary[] | null | undefined
}) {
  const items = projects ?? []
  if (items.length === 0) return null

  return (
    <section
      className={styles.featureSection}
      data-testid="overview-featured-features"
      aria-labelledby="ov-features-title"
    >
      <h2 id="ov-features-title" className={styles.sectionLabel}>
        Fitur unggulan
      </h2>
      <div className={styles.featureGrid}>
        {items.map((p) => {
          const status = p.statusLabel ?? p.bucketHint
          return (
            <Card
              key={p.projectId}
              as="article"
              className={styles.featureCard}
              data-testid="overview-feature-card"
              data-project-id={p.projectId}
            >
              <div className={styles.featureTop}>
                <div className={styles.featureName}>{p.name}</div>
                {status ? (
                  <StatusChip variant={statusVariant(status)} showDot>
                    {status}
                  </StatusChip>
                ) : null}
              </div>
              <div className={styles.featureStats}>
                {typeof p.count === 'number' && Number.isFinite(p.count) ? (
                  <div className={styles.featureStat}>
                    <strong className={styles.tabular}>{p.count}</strong>
                    tugas
                  </div>
                ) : null}
                {p.bucketHint && p.bucketHint !== p.statusLabel ? (
                  <div className={styles.featureStat}>
                    <strong>{p.bucketHint}</strong>
                    bucket
                  </div>
                ) : null}
                <div className={styles.featureStat}>
                  <strong className={styles.tabular}>{p.projectId}</strong>
                  id
                </div>
              </div>
            </Card>
          )
        })}
      </div>
    </section>
  )
}
