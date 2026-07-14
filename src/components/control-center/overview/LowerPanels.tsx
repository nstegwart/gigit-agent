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
      className={styles.lowerGrid}
      data-testid="overview-lower"
      aria-label="Proyek, lifecycle, G5, keputusan, peristiwa"
    >
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
        <h2 className={styles.panelTitle}>Lifecycle</h2>
        {data.lifecycle.length === 0 ? (
          <p className={styles.panelMuted}>Tidak ada rollup lifecycle.</p>
        ) : (
          <ul className={styles.panelList}>
            {data.lifecycle.map((row) => (
              <li key={row.stage} className={styles.panelRow}>
                <span>{row.stage}</span>
                <span className={styles.bucketCount}>{row.count}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className={styles.panel} data-panel="g5">
        <h2 className={styles.panelTitle}>
          G5{' '}
          {data.g5 ? (
            <span className={data.g5.g5Pass ? styles.pass : styles.fail}>
              {data.g5.g5Pass ? 'PASS' : 'FAIL'}
            </span>
          ) : null}
        </h2>
        {!data.g5 ? (
          <p className={styles.panelMuted}>G5 tidak tersedia.</p>
        ) : data.g5.domains.length === 0 ? (
          <p className={styles.panelMuted}>Tidak ada domain G5.</p>
        ) : (
          <ul className={styles.panelList}>
            {data.g5.domains.map((d) => (
              <li key={d.domainId} className={styles.panelRow}>
                <span>{d.label}</span>
                <span className={d.pass ? styles.pass : styles.fail}>{d.status}</span>
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

      <div className={styles.panel} data-panel="material-events">
        <h2 className={styles.panelTitle}>Peristiwa material</h2>
        {data.materialEvents.length === 0 ? (
          <p className={styles.panelMuted}>Tidak ada peristiwa material.</p>
        ) : (
          <ul className={styles.panelList}>
            {data.materialEvents.map((ev) => (
              <li key={ev.eventId} className={styles.panelRow}>
                <span>
                  <span className={styles.panelMuted}>{ev.atLabel}</span> {ev.kind}: {ev.summary}
                </span>
                {ev.actor ? <span className={styles.panelMuted}>{ev.actor}</span> : null}
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  )
}
