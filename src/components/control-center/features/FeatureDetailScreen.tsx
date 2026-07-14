import type { FeatureRowView, FeaturesPinView, FeaturesSurfaceState } from './types'
import styles from './features.module.css'

const CONTEXT_FIELDS: Array<{
  key: keyof Pick<
    FeatureRowView,
    | 'pageRoutes'
    | 'apiEndpoints'
    | 'logicRules'
    | 'dataContext'
    | 'geoVariants'
    | 'providerVariants'
    | 'sideEffectsReadback'
    | 'styleContext'
  >
  label: string
}> = [
  { key: 'pageRoutes', label: 'Routes / pages' },
  { key: 'apiEndpoints', label: 'API' },
  { key: 'logicRules', label: 'Rules' },
  { key: 'dataContext', label: 'Data' },
  { key: 'geoVariants', label: 'Geo' },
  { key: 'providerVariants', label: 'Provider' },
  { key: 'sideEffectsReadback', label: 'Readback' },
  { key: 'styleContext', label: 'Style' },
]

function branchLabel(branch: FeatureRowView['flowBranch']): string {
  if (!branch) return '—'
  return branch
}

export interface FeatureDetailScreenProps {
  surfaceState: FeaturesSurfaceState | 'loading' | 'empty' | 'error' | 'forbidden'
  boardId: string
  feature: FeatureRowView | null
  pin: FeaturesPinView | null
  error?: { code: string; message: string } | null
  listHref: string
  onRetry?: () => void
  className?: string
}

/**
 * Control-center feature detail — resolves from pinned FeaturesData, not legacy plan.
 * Owner-facing summary + progressive disclosure of technical context.
 */
export function FeatureDetailScreen({
  surfaceState,
  boardId,
  feature,
  pin,
  error,
  listHref,
  onRetry,
  className,
}: FeatureDetailScreenProps) {
  if (surfaceState === 'loading' && !feature) {
    return (
      <section
        className={[styles.root, className].filter(Boolean).join(' ')}
        data-testid="control-center-feature-detail"
        data-surface-state="loading"
        data-board-id={boardId}
      >
        <a href={listHref} className={styles.linkBtn} data-testid="feature-detail-back">
          ← Features
        </a>
        <div className={styles.skeleton} data-testid="feature-detail-skeleton" aria-hidden="true">
          <div className={styles.skeletonCard} />
        </div>
      </section>
    )
  }

  if (!feature) {
    return (
      <section
        className={[styles.root, className].filter(Boolean).join(' ')}
        data-testid="control-center-feature-detail"
        data-surface-state="empty"
        data-board-id={boardId}
      >
        <a href={listHref} className={styles.linkBtn} data-testid="feature-detail-back">
          ← Features
        </a>
        <div
          className={`${styles.banner} ${styles.banner_error}`}
          role="alert"
          data-testid="feature-detail-not-found"
        >
          <p className={styles.bannerTitle}>Feature not found</p>
          <p className={styles.bannerBody}>
            {error?.message ??
              'Feature id is not in the pinned control-center features set for this board.'}
          </p>
          {onRetry ? (
            <button type="button" className={styles.retryBtn} onClick={onRetry}>
              Retry
            </button>
          ) : null}
        </div>
      </section>
    )
  }

  const contextGroups = CONTEXT_FIELDS.map(({ key, label }) => ({
    key,
    label,
    values: feature[key],
  })).filter((g) => g.values.length > 0)

  return (
    <section
      className={[styles.root, className].filter(Boolean).join(' ')}
      data-testid="control-center-feature-detail"
      data-surface-state={surfaceState}
      data-board-id={boardId}
      data-feature-id={feature.featureId}
    >
      <a href={listHref} className={styles.linkBtn} data-testid="feature-detail-back">
        ← Features
      </a>

      <header className={styles.pageHead}>
        <div>
          <p className={styles.eyebrow}>IA · Feature detail</p>
          <h1 id="feature-detail-title" className={styles.pageTitle} data-testid="feature-detail-title">
            {feature.name}
          </h1>
          <p className={styles.pageSub}>
            Ringkasan fitur dari pin control-center — progress tugas dan konteks alur (bukan
            legacy plan checklist).
          </p>
        </div>
        <div className={styles.summaryStrip}>
          <span className={`${styles.chip} ${styles.chipAccent}`} data-testid="feature-detail-id">
            {feature.featureId}
          </span>
          <span className={styles.chip} data-testid="feature-detail-phase">
            Phase {feature.phase ?? '—'}
          </span>
          <span className={styles.chip} data-testid="feature-detail-tasks">
            {feature.taskCount} tasks
          </span>
          <span className={styles.chip} data-testid="feature-detail-flow">
            Flow {branchLabel(feature.flowBranch)}
          </span>
        </div>
      </header>

      {pin ? (
        <p className={styles.pinStrip} data-testid="feature-detail-pin">
          pin <code>{pin.canonicalSnapshotId}</code> · boardRev {pin.boardRev}
          {pin.stale ? ` · STALE ${pin.staleReason ?? ''}` : ''}
        </p>
      ) : null}

      <div className={styles.card} data-testid="feature-detail-meta">
        <dl className={styles.cardMeta}>
          <div>
            <dt>Project</dt>
            <dd className={styles.idCell}>
              {feature.projectHref && feature.projectId ? (
                <a href={feature.projectHref}>{feature.projectId}</a>
              ) : (
                feature.projectId ?? '—'
              )}
            </dd>
          </div>
          <div>
            <dt>Tasks linked</dt>
            <dd className={styles.metric}>{feature.taskCount}</dd>
          </div>
          <div>
            <dt>Phase</dt>
            <dd>{feature.phase ?? '—'}</dd>
          </div>
          <div>
            <dt>Flow branch</dt>
            <dd>{branchLabel(feature.flowBranch)}</dd>
          </div>
        </dl>
      </div>

      <div className={styles.card} data-testid="feature-detail-context">
        <h2 className={styles.pageTitle} style={{ fontSize: '1.05rem', marginBottom: 12 }}>
          Konteks alur
        </h2>
        {contextGroups.length === 0 ? (
          <p className={styles.empty} data-testid="feature-detail-context-empty">
            Tidak ada konteks rute/API/rule dari pin (jujur kosong — tidak diisi tebakan).
          </p>
        ) : (
          <div className={styles.summaryStrip}>
            {contextGroups.map((g) => (
              <details key={g.key} className={styles.gapDisclosure}>
                <summary className={styles.gapDisclosureSummary}>
                  {g.label} ({g.values.length})
                </summary>
                <ul className={styles.gapList}>
                  {g.values.map((v) => (
                    <li key={v}>
                      <code>{v}</code>
                    </li>
                  ))}
                </ul>
              </details>
            ))}
          </div>
        )}
      </div>

      {feature.taskCount > 0 ? (
        <p className={styles.pageSub} data-testid="feature-detail-work-hint">
          Lihat tugas terkait di{' '}
          <a href={`/b/${encodeURIComponent(boardId)}/work`}>Pekerjaan</a> (filter feature contract
          di detail teknis tugas).
        </p>
      ) : null}
    </section>
  )
}
