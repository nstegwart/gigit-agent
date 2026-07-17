import { formatLifecycleStageLabel, formatOperationalLabel } from '#/lib/display-label'
import type {
  FeatureProgressNodeView,
  FeatureRowView,
  FeaturesPinView,
  FeaturesSurfaceState,
} from './types'
import styles from './features.module.css'

/** Server placeholder — never render as primary owner title (SPEC §4.5 / ADDENDUM C). */
const OWNER_CONTENT_PLACEHOLDER = 'Konten pemilik memerlukan peninjauan'

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
  const u = status.toLowerCase().replace(/_/g, ' ').trim()
  if (u === 'blocked') return 'Terhambat'
  if (u === 'done' || u === 'completed') return 'Selesai'
  if (u === 'running' || u === 'in progress' || u === 'active') return 'Berjalan'
  if (u === 'queued' || u === 'pending') return 'Antri'
  if (u === 'failed' || u === 'fail') return 'Gagal'
  if (u === 'expired') return 'Kedaluwarsa'
  if (u === 'not started' || u === 'notstarted' || u === 'todo' || u === 'idle') {
    return 'Belum mulai'
  }
  return formatOperationalLabel(status)
}

/** Strip technical ids (T-*, [FC-*]) and light-normalize for owner primary title. */
function cleanTechnicalTitle(raw: string): string {
  let s = raw.trim()
  if (!s) return s
  s = s.replace(/\[[^\]]*\]\s*/g, '')
  s = s.replace(/\b(?:T|FC|BE|WEB|RN|AFF|SALES)-[A-Z0-9._-]+\b/gi, '')
  s = s.replace(/[_/]+/g, ' ')
  s = s.replace(/\s+/g, ' ').trim()
  if (!s) return raw.trim()
  // Sentence-case first char; leave rest as source (often already mixed).
  return s.charAt(0).toUpperCase() + s.slice(1)
}

/**
 * Presentation-only title policy (ADDENDUM C):
 * reviewed human title → cleaned technicalTitle + badge → never placeholder as title.
 */
function ownerFacingNodeTitle(n: FeatureProgressNodeView): {
  title: string
  needsReview: boolean
} {
  const rawTitle = typeof n.title === 'string' ? n.title.trim() : ''
  const isPlaceholder =
    !rawTitle ||
    rawTitle === OWNER_CONTENT_PLACEHOLDER ||
    rawTitle.toLowerCase() === OWNER_CONTENT_PLACEHOLDER.toLowerCase()

  if (!isPlaceholder && !n.contentReviewRequired) {
    return { title: rawTitle, needsReview: false }
  }

  if (!isPlaceholder && rawTitle) {
    return { title: rawTitle, needsReview: n.contentReviewRequired === true }
  }

  const tech =
    typeof n.technicalTitle === 'string' && n.technicalTitle.trim()
      ? n.technicalTitle.trim()
      : ''
  if (tech && tech !== OWNER_CONTENT_PLACEHOLDER) {
    return { title: cleanTechnicalTitle(tech), needsReview: true }
  }

  return { title: cleanTechnicalTitle(n.taskId) || n.taskId, needsReview: true }
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
          <p className={styles.eyebrow}>Detail fitur</p>
          <h1 id="feature-detail-title" className={styles.pageTitle} data-testid="feature-detail-title">
            {feature.name}
          </h1>
          <p className={styles.pageSub}>
            {feature.taskCount} tugas terhubung
            {feature.phase ? ` · Fase ${feature.phase}` : ''}
            {feature.flowBranch ? ` · Alur ${branchLabel(feature.flowBranch)}` : ''}
            {feature.projectId ? ` · Proyek ${feature.projectId}` : ''}.
          </p>
        </div>
        <div className={styles.summaryStrip}>
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

      {/* pin / boardRev / STALE + IDs only under progressive disclosure (W-UI-QW D.3) */}
      <details className={styles.gapDisclosure} data-testid="feature-detail-technical">
        <summary className={styles.gapDisclosureSummary}>Detail teknis</summary>
        <div className={styles.gapDisclosureBody}>
          <p className={styles.technicalIdLine} data-testid="feature-detail-id">
            <span className={styles.technicalIdLabel}>featureId</span>
            <code>{feature.featureId}</code>
          </p>
          {feature.projectId ? (
            <p className={styles.technicalIdLine} data-testid="feature-detail-project-id">
              <span className={styles.technicalIdLabel}>projectId</span>
              <code>{feature.projectId}</code>
            </p>
          ) : null}
          {pin ? (
            <div data-testid="feature-detail-pin">
              <p className={styles.technicalIdLine}>
                <span className={styles.technicalIdLabel}>pin</span>
                <code>{pin.canonicalSnapshotId}</code>
              </p>
              <p className={styles.technicalIdLine}>
                <span className={styles.technicalIdLabel}>boardRev</span>
                <code>{pin.boardRev}</code>
              </p>
              {pin.lifecycleRev != null ? (
                <p className={styles.technicalIdLine}>
                  <span className={styles.technicalIdLabel}>lifecycleRev</span>
                  <code>{pin.lifecycleRev}</code>
                </p>
              ) : null}
              {pin.stale ? (
                <p className={`${styles.banner} ${styles.banner_stale}`} style={{ marginTop: 8 }}>
                  <span className={styles.bannerTitle}>STALE</span>{' '}
                  <span className={styles.bannerBody}>{pin.staleReason ?? 'snapshot usang'}</span>
                </p>
              ) : null}
            </div>
          ) : null}
        </div>
      </details>

      <div className={styles.card} data-testid="feature-detail-progress">
        <h2 className={styles.progressTitle}>Node progres tugas</h2>
        <p className={styles.progressLead}>
          Node di bawah berasal dari tugas yang terhubung ke fitur ini pada pin saat ini — bukan
          tebakan klien.
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
            {nodes.map((n) => {
              const facing = ownerFacingNodeTitle(n)
              return (
                <li
                  key={n.taskId}
                  className={styles.progressNode}
                  data-testid="feature-progress-node"
                  data-task-id={n.taskId}
                  data-stage={n.lifecycleStage ?? undefined}
                >
                  <div className={styles.progressNodeHead}>
                    <a href={n.detailHref} className={styles.progressNodeTitle}>
                      {facing.title}
                    </a>
                    {facing.needsReview ? (
                      <span
                        className={styles.progressContentReview}
                        data-testid="feature-progress-content-review"
                        title={n.technicalTitle ?? OWNER_CONTENT_PLACEHOLDER}
                      >
                        perlu tinjauan
                      </span>
                    ) : null}
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
                  <details className={styles.gapDisclosure} data-testid="feature-progress-technical">
                    <summary className={styles.gapDisclosureSummary}>Detail teknis</summary>
                    <div className={styles.gapDisclosureBody}>
                      <p className={styles.technicalIdLine}>
                        <span className={styles.technicalIdLabel}>taskId</span>
                        <code className={styles.progressNodeId}>{n.taskId}</code>
                      </p>
                      {n.technicalTitle ? (
                        <p className={styles.technicalIdLine}>
                          <span className={styles.technicalIdLabel}>Judul sumber</span>
                          <code>{n.technicalTitle}</code>
                        </p>
                      ) : null}
                      {facing.needsReview ? (
                        <p className={styles.technicalIdLine}>
                          <span className={styles.technicalIdLabel}>Status konten</span>
                          <span>{OWNER_CONTENT_PLACEHOLDER}</span>
                        </p>
                      ) : null}
                    </div>
                  </details>
                </li>
              )
            })}
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
