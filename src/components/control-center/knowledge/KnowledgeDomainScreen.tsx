/**
 * ART S13–S14 / S21 domain knowledge — honest unavailable/partial from pin only.
 */
import type { KnowledgeDomainViewModel } from '#/lib/control-center-route-adapters'

export type KnowledgeDomainScreenProps = KnowledgeDomainViewModel & {
  onRetry?: () => void
  className?: string
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
}: KnowledgeDomainScreenProps) {
  return (
    <section
      className={className}
      data-testid="control-center-knowledge-domain"
      data-surface-state={surfaceState}
      data-board-id={boardId}
      data-domain={domain}
      data-availability={availability}
    >
      <header style={{ marginBottom: 16 }}>
        <p style={{ fontSize: 12, color: 'var(--text-faint)', margin: 0 }}>Pengetahuan domain</p>
        <h1 style={{ fontSize: 22, margin: '4px 0 8px' }} data-testid="knowledge-title">
          {title}
        </h1>
        <p data-testid="knowledge-summary">{summary}</p>
        <p data-testid="knowledge-availability">
          Status: <strong>{availability}</strong>
        </p>
        {onRetry ? (
          <button type="button" onClick={onRetry} data-testid="knowledge-retry">
            Muat ulang
          </button>
        ) : null}
      </header>

      {error ? (
        <div role="alert" data-testid="knowledge-error">
          {error.code}: {error.message}
        </div>
      ) : null}

      {availability === 'unavailable' ? (
        <div data-testid="knowledge-unavailable" role="status">
          Domain ini tidak punya data ter-pin. Tidak menampilkan kesiapan palsu.
        </div>
      ) : (
        <div data-testid="knowledge-body">
          <section>
            <h2>Proyek ({projects.length})</h2>
            <ul data-testid="knowledge-projects">
              {projects.map((p) => (
                <li key={p.id}>
                  {p.name ?? p.id} · {p.taskCount} tugas
                </li>
              ))}
            </ul>
          </section>
          <section>
            <h2>Fitur ({features.length})</h2>
            <ul data-testid="knowledge-features">
              {features.map((f) => (
                <li key={f.id}>{f.name ?? f.id}</li>
              ))}
            </ul>
          </section>
          <section>
            <h2>Tugas ({tasks.length})</h2>
            <ul data-testid="knowledge-tasks">
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
            <h2>Keputusan ({decisions.length})</h2>
            <ul data-testid="knowledge-decisions">
              {decisions.map((d) => (
                <li key={d.decisionId}>
                  <a href={`/decisions/${encodeURIComponent(d.decisionId)}`}>{d.title}</a> ·{' '}
                  {d.status}
                </li>
              ))}
            </ul>
          </section>
          <section>
            <h2>Bukti ({evidence.length})</h2>
            <ul data-testid="knowledge-evidence">
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
        <div data-testid="knowledge-gaps" style={{ marginTop: 16 }}>
          <h2>Gap jujur</h2>
          <ul>
            {gaps.map((g) => (
              <li key={g}>{g}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {pin ? (
        <footer
          data-testid="knowledge-pin"
          style={{ marginTop: 24, fontSize: 12, color: 'var(--text-faint)' }}
        >
          pin {pin.canonicalSnapshotId} · rev {pin.boardRev}/{pin.lifecycleRev}
          {pin.stale ? ` · STALE ${pin.staleReason ?? ''}` : ''}
        </footer>
      ) : null}
    </section>
  )
}
