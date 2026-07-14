import { formatLifecycleStageLabel, formatOperationalLabel } from '#/lib/display-label'
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
  { key: 'pageRoutes', label: 'Rute / halaman' },
  { key: 'apiEndpoints', label: 'API' },
  { key: 'logicRules', label: 'Aturan' },
  { key: 'dataContext', label: 'Data' },
  { key: 'geoVariants', label: 'Geo' },
  { key: 'providerVariants', label: 'Provider' },
  { key: 'sideEffectsReadback', label: 'Readback' },
  { key: 'styleContext', label: 'Gaya' },
]

function branchLabel(branch: FeatureRowView['flowBranch']): string {
  if (!branch) return '—'
  if (branch === 'success') return 'Sukses'
  if (branch === 'fail') return 'Gagal'
  if (branch === 'expired') return 'Kedaluwarsa'
  if (branch === 'open') return 'Terbuka'
  return branch
}

function statusLabel(status: string | null): string {
  if (!status) return '—'
  const u = status.toLowerCase()
  if (u === 'blocked') return 'Terhambat'
  if (u === 'done' || u === 'completed') return 'Selesai'
  if (u === 'running' || u === 'in_progress' || u === 'active') return 'Berjalan'
  if (u === 'queued' || u === 'pending') return 'Antri'
  if (u === 'failed' || u === 'fail') return 'Gagal'
  if (u === 'expired') return 'Kedaluwarsa'
  return formatOperationalLabel(status)
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
 * Owner-facing summary + real progress nodes + progressive technical context.
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
          ← Fitur
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
          ← Fitur
        </a>
        <div
          className={`${styles.banner} ${styles.banner_error}`}
          role="alert"
          data-testid="feature-detail-not-found"
        >
          <p className={styles.bannerTitle}>Fitur tidak ditemukan</p>
          <p className={styles.bannerBody}>
            {error?.message ??
              'Id fitur tidak ada di set fitur control-center yang di-pin untuk board ini.'}
          </p>
          {onRetry ? (
            <button type="button" className={styles.retryBtn} onClick={onRetry}>
              Coba lagi
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

  const stageEntries = Object.entries(feature.stageCounts).sort((a, b) => b[1] - a[1])
  const nodes = feature.progressNodes

  return (
    <section
      className={[styles.root, className].filter(Boolean).join(' ')}
      data-testid="control-center-feature-detail"
      data-surface-state={surfaceState}
      data-board-id={boardId}
      data-feature-id={feature.featureId}
    >
      <a href={listHref} className={styles.linkBtn} data-testid="feature-detail-back">
        ← Fitur
      </a>

      <header className={styles.pageHead}>
        <div>
          <p className={styles.eyebrow}>IA · Detail fitur</p>
          <h1 id="feature-detail-title" className={styles.pageTitle} data-testid="feature-detail-title">
            {feature.name}
          </h1>
          <p className={styles.pageSub}>
            Ringkasan fitur dari pin control-center — progress node tugas nyata dan konteks alur
            (bukan checklist plan legacy).
          </p>
        </div>
        <div className={styles.summaryStrip}>
          <span className={`${styles.chip} ${styles.chipAccent}`} data-testid="feature-detail-id">
            {feature.featureId}
          </span>
          <span className={styles.chip} data-testid="feature-detail-phase">
            Fase {feature.phase ?? '—'}
          </span>
          <span className={styles.chip} data-testid="feature-detail-tasks">
            {feature.taskCount} tugas
          </span>
          <span className={styles.chip} data-testid="feature-detail-flow">
            Alur {branchLabel(feature.flowBranch)}
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
            <dt>Proyek</dt>
            <dd className={styles.idCell}>
              {feature.projectHref && feature.projectId ? (
                <a href={feature.projectHref}>{feature.projectId}</a>
              ) : (
                feature.projectId ?? '—'
              )}
            </dd>
          </div>
          <div>
            <dt>Tugas terhubung</dt>
            <dd className={styles.metric}>{feature.taskCount}</dd>
          </div>
          <div>
            <dt>Fase</dt>
            <dd>{feature.phase ?? '—'}</dd>
          </div>
          <div>
            <dt>Cabang alur</dt>
            <dd>{branchLabel(feature.flowBranch)}</dd>
          </div>
        </dl>
      </div>

      <div className={styles.card} data-testid="feature-detail-progress">
        <h2 className={styles.progressTitle}>Progress node tugas</h2>
        <p className={styles.pageSub} style={{ marginTop: 0, marginBottom: 12 }}>
          Node di bawah berasal dari tugas yang terhubung ke fitur ini (featureContractId) pada pin
          saat ini — bukan tebakan klien.
        </p>
        {stageEntries.length > 0 ? (
          <div
            className={styles.stageChipStrip}
            data-testid="feature-detail-stage-chips"
            aria-label="Ringkasan tahap lifecycle"
          >
            {stageEntries.map(([stage, count]) => (
              <span
                key={stage}
                className={styles.stageChip}
                data-stage={stage}
                title={stage}
              >
                {formatLifecycleStageLabel(stage)} · {count}
              </span>
            ))}
          </div>
        ) : null}
        {nodes.length === 0 ? (
          <p className={styles.empty} data-testid="feature-detail-progress-empty">
            Tidak ada tugas terhubung pada pin ini (jujur kosong — tidak diisi tebakan).
          </p>
        ) : (
          <ol className={styles.progressList} data-testid="feature-detail-progress-list">
            {nodes.map((n) => (
              <li
                key={n.taskId}
                className={styles.progressNode}
                data-testid="feature-progress-node"
                data-task-id={n.taskId}
                data-stage={n.lifecycleStage ?? undefined}
              >
                <div className={styles.progressNodeHead}>
                  <a href={n.detailHref} className={styles.progressNodeTitle}>
                    {n.title}
                  </a>
                  <code className={styles.progressNodeId}>{n.taskId}</code>
                </div>
                <div className={styles.progressNodeMeta}>
                  <span
                    className={styles.stageChip}
                    data-testid="feature-progress-stage"
                    title={n.lifecycleStage ?? ''}
                  >
                    {n.lifecycleStage
                      ? formatLifecycleStageLabel(n.lifecycleStage)
                      : 'Tahap tidak diketahui'}
                  </span>
                  <span className={styles.chip} data-testid="feature-progress-status">
                    {statusLabel(n.status)}
                  </span>
                  {n.blockedReason ? (
                    <span className={styles.progressBlocker} data-testid="feature-progress-blocker">
                      Hambatan: {n.blockedReason}
                    </span>
                  ) : null}
                </div>
              </li>
            ))}
          </ol>
        )}
      </div>

      <div className={styles.card} data-testid="feature-detail-context">
        <h2 className={styles.progressTitle}>Konteks alur</h2>
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
          Lihat daftar pekerjaan board di{' '}
          <a href={`/b/${encodeURIComponent(boardId)}/work`}>Pekerjaan</a> (filter bucket + tahap di
          baris tugas).
        </p>
      ) : null}
    </section>
  )
}
