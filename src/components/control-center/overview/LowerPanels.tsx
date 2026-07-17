/**
 * Direction B lower panels — presentation only.
 * Lead: "Aktivitas terkini" feed + "Gerbang G5" checklist.
 * Secondary: projects, lifecycle, open decisions (existing data-panel contracts).
 */
import { formatLifecycleStageLabel } from '#/lib/display-label'
import { Card, StatusChip } from '#/components/ui'
import styles from './overview.module.css'
import type { OverviewLowerPanels } from './types'
import { EmptySlot } from './SurfaceBanner'
import { SemanticIcon } from './SemanticIcon'

export function LowerPanels({ data }: { data: OverviewLowerPanels | null }) {
  if (!data) {
    return (
      <section data-testid="overview-lower" aria-label="Proyek, lifecycle, G5, keputusan, peristiwa">
        <EmptySlot>Panel sekunder tidak tersedia.</EmptySlot>
      </section>
    )
  }

  return (
    <section
      className={styles.lowerRoot}
      data-testid="overview-lower"
      aria-label="Proyek, lifecycle, G5, keputusan, peristiwa"
    >
      {/* Direction B lead pair */}
      <div className={styles.activityG5Grid}>
        <Card
          data-panel="material-events"
          data-testid="overview-activity-feed"
          title="Aktivitas terkini"
          subtitle="Peristiwa material dari snapshot"
        >
          {data.materialEvents.length === 0 ? (
            <p className={styles.panelMuted}>Tidak ada peristiwa material.</p>
          ) : (
            <ul className={styles.activityFeed}>
              {data.materialEvents.map((ev) => (
                <li key={ev.eventId} className={styles.activityItem}>
                  <div className={styles.activityMain}>
                    <span className={styles.activityActor}>
                      {ev.actor?.trim() ? ev.actor : 'Sistem'}
                    </span>
                    <span className={styles.activityAction}>
                      {ev.kind}: {ev.summary}
                    </span>
                  </div>
                  <span className={styles.activityMeta}>{ev.atLabel}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card
          data-panel="g5"
          data-testid="overview-g5-gate"
          title={
            <span className={styles.cardTitleInline}>
              Gerbang G5{' '}
              {data.g5 ? (
                <StatusChip variant={data.g5.g5Pass ? 'done' : 'blocked'} showDot>
                  {data.g5.g5Pass ? 'Lulus' : 'Belum'}
                </StatusChip>
              ) : null}
            </span>
          }
          subtitle="Checklist domain kesiapan G5"
        >
          {!data.g5 ? (
            <p className={styles.panelMuted}>G5 tidak tersedia.</p>
          ) : data.g5.domains.length === 0 ? (
            <p className={styles.panelMuted}>Tidak ada domain G5.</p>
          ) : (
            <ul className={styles.g5Checklist} data-testid="overview-g5-checklist">
              {data.g5.domains.map((d) => (
                <li key={d.domainId} className={styles.g5Item} data-domain={d.domainId}>
                  <span className={styles.g5Label}>{d.label}</span>
                  <StatusChip variant={d.pass ? 'done' : 'pending'} showDot>
                    {d.pass ? 'Lulus' : d.status || 'Belum'}
                  </StatusChip>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      {/* Secondary panels — preserve data-panel contracts for suite */}
      <div className={styles.lowerGrid}>
        <div className={styles.panel} data-panel="projects">
          <h2 className={styles.panelTitle}>Proyek</h2>
          {data.projects.length === 0 ? (
            <p className={styles.panelMuted}>Tidak ada proyek.</p>
          ) : (
            <ul className={styles.panelList}>
              {data.projects.map((p) => (
                <li key={p.projectId} className={styles.panelRow}>
                  <span>{p.name}</span>
                  <span className={styles.panelMuted}>
                    {p.statusLabel ?? p.bucketHint ?? (typeof p.count === 'number' ? p.count : '')}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className={styles.panel} data-panel="lifecycle">
          <h2 className={styles.panelTitle}>Progres tahap (lifecycle)</h2>
          {data.lifecycle.length === 0 ? (
            <p className={styles.panelMuted}>Tidak ada rollup lifecycle.</p>
          ) : (
            <ul className={styles.panelList} data-testid="overview-lifecycle-histogram">
              {data.lifecycle.map((row) => (
                <li
                  key={row.stage}
                  className={styles.panelRow}
                  data-stage={row.stage}
                  data-testid="overview-lifecycle-row"
                >
                  <span title={row.stage}>{formatLifecycleStageLabel(row.stage)}</span>
                  <span className={styles.bucketCount}>{row.count}</span>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className={styles.panel} data-panel="decisions">
          <h2 className={styles.panelTitle}>Keputusan</h2>
          <p className={styles.metricValue}>
            <SemanticIcon kind="alert" /> {data.decisionCount} terbuka
          </p>
        </div>
      </div>
    </section>
  )
}
