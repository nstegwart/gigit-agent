/**
 * ART S13–S14 / S21 domain knowledge — honest unavailable/partial from pin only.
 * S21: distinct conflict/redaction surface (PROVEN|UNKNOWN|CONFLICT|STALE).
 */
import type { KnowledgeDomainViewModel } from '#/lib/control-center-route-adapters'
import {
  resolveKnowledgeConflictView,
  type KnowledgeConflictSourceView,
  type KnowledgeFactState,
  type KnowledgeRedactionView,
} from '#/lib/control-center-secondary-route-adapters'
import { KnowledgeConflictPanel } from './KnowledgeConflictPanel'
import styles from './knowledge.module.css'

export type KnowledgeDomainScreenProps = KnowledgeDomainViewModel & {
  onRetry?: () => void
  className?: string
  /**
   * Optional server-provided conflict sources (pass-through).
   * Never invent a second source when empty.
   */
  conflictSources?: ReadonlyArray<KnowledgeConflictSourceView>
  /** Optional server redaction disclosures (pass-through). */
  redactions?: ReadonlyArray<KnowledgeRedactionView>
  /** Optional server knowledgeState override when projected. */
  knowledgeState?: KnowledgeFactState | string | null
  /** Optional last-valid pin time when projected (pin VM may omit generatedAt). */
  lastValidGeneratedAt?: string | null
}

export function KnowledgeDomainScreen({
  surfaceState,
  boardId,
  domain,
  availability,
  title,
  summary,
  projects,
  features,
  tasks,
  decisions,
  evidence,
  gaps,
  pin,
  error,
  onRetry,
  className,
  conflictSources,
  redactions,
  knowledgeState,
  lastValidGeneratedAt,
}: KnowledgeDomainScreenProps) {
  const conflictModel = resolveKnowledgeConflictView({
    domain,
    availability,
    surfaceState,
    gaps,
    pin,
    sources: conflictSources ?? null,
    redactions: redactions ?? null,
    knowledgeState: knowledgeState ?? null,
    lastValidGeneratedAt: lastValidGeneratedAt ?? null,
  })

  return (
    <section
      className={[styles.root, className].filter(Boolean).join(' ')}
      data-testid="control-center-knowledge-domain"
      data-surface-state={surfaceState}
      data-board-id={boardId}
      data-domain={domain}
      data-availability={availability}
      data-knowledge-state={conflictModel.knowledgeState}
    >
      <header className={styles.header}>
        <p className={styles.eyebrow}>Pengetahuan domain</p>
        <h1 className={styles.title} data-testid="knowledge-title">
          {title}
        </h1>
        <p className={styles.summary} data-testid="knowledge-summary">
          {summary}
        </p>
        <p className={styles.meta} data-testid="knowledge-availability">
          Status: <strong>{availability}</strong>
          {' · '}
          pengetahuan: <strong data-testid="knowledge-fact-state">{conflictModel.knowledgeState}</strong>
        </p>
        {onRetry ? (
          <button
            type="button"
            className={styles.retryBtn}
            onClick={onRetry}
            data-testid="knowledge-retry"
          >
            Muat ulang
          </button>
        ) : null}
      </header>

      <KnowledgeConflictPanel model={conflictModel} onRetry={onRetry} />

      {error ? (
        <div className={styles.alert} role="alert" data-testid="knowledge-error">
          {error.code}: {error.message}
        </div>
      ) : null}

      {availability === 'unavailable' ? (
        <div className={styles.unavailable} data-testid="knowledge-unavailable" role="status">
          Domain ini tidak punya data ter-pin. Tidak menampilkan kesiapan palsu.
        </div>
      ) : (
        <div className={styles.body} data-testid="knowledge-body">
          <section>
            <h2 className={styles.sectionTitle}>Proyek ({projects.length})</h2>
            <ul className={styles.list} data-testid="knowledge-projects">
              {projects.map((p) => (
                <li key={p.id}>
                  {p.name ?? p.id} · {p.taskCount} tugas
                </li>
              ))}
            </ul>
          </section>
          <section>
            <h2 className={styles.sectionTitle}>Fitur ({features.length})</h2>
            <ul className={styles.list} data-testid="knowledge-features">
              {features.map((f) => (
                <li key={f.id}>{f.name ?? f.id}</li>
              ))}
            </ul>
          </section>
          <section>
            <h2 className={styles.sectionTitle}>Tugas ({tasks.length})</h2>
            <ul className={styles.list} data-testid="knowledge-tasks">
              {tasks.map((t) => (
                <li key={t.taskId}>
                  <a href={`/work/${encodeURIComponent(t.taskId)}`}>
                    {t.ownerPrimaryTitle ?? t.title}
                  </a>
                  {t.bucket ? ` · ${t.bucket}` : ''}
                </li>
              ))}
            </ul>
          </section>
          <section>
            <h2 className={styles.sectionTitle}>Keputusan ({decisions.length})</h2>
            <ul className={styles.list} data-testid="knowledge-decisions">
              {decisions.map((d) => (
                <li key={d.decisionId}>
                  <a href={`/decisions/${encodeURIComponent(d.decisionId)}`}>{d.title}</a> ·{' '}
                  {d.status}
                </li>
              ))}
            </ul>
          </section>
          <section>
            <h2 className={styles.sectionTitle}>Bukti ({evidence.length})</h2>
            <ul className={styles.list} data-testid="knowledge-evidence">
              {evidence.map((e) => (
                <li key={e.id}>
                  {e.kind}: {e.summary}
                </li>
              ))}
            </ul>
          </section>
        </div>
      )}

      {gaps.length ? (
        <div className={styles.gaps} data-testid="knowledge-gaps">
          <h2 className={styles.sectionTitle}>Gap jujur</h2>
          <ul className={styles.list}>
            {gaps.map((g) => (
              <li key={g}>{g}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {pin ? (
        <footer className={styles.footer} data-testid="knowledge-pin">
          pin {pin.canonicalSnapshotId} · rev {pin.boardRev}/{pin.lifecycleRev}
          {pin.stale ? ` · STALE ${pin.staleReason ?? ''}` : ''}
        </footer>
      ) : null}
    </section>
  )
}