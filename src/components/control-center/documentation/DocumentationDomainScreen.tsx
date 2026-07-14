/**
 * ART S17 documentation domain export preview with citations (prop-driven).
 */
import type { DocumentationDomainViewModel } from '#/lib/control-center-route-adapters'

export type DocumentationDomainScreenProps = DocumentationDomainViewModel & {
  onRetry?: () => void
  className?: string
}

export function DocumentationDomainScreen({
  surfaceState,
  boardId,
  domain,
  availability,
  title,
  bodyMarkdown,
  citations,
  gaps,
  pin,
  error,
  onRetry,
  className,
}: DocumentationDomainScreenProps) {
  return (
    <section
      className={className}
      data-testid="control-center-documentation-domain"
      data-surface-state={surfaceState}
      data-board-id={boardId}
      data-domain={domain}
      data-availability={availability}
    >
      <header style={{ marginBottom: 16 }}>
        <p style={{ fontSize: 12, color: 'var(--text-faint)', margin: 0 }}>Dokumentasi domain</p>
        <h1 style={{ fontSize: 22, margin: '4px 0 8px' }} data-testid="documentation-title">
          {title}
        </h1>
        <p data-testid="documentation-availability">
          Status: <strong>{availability}</strong>
        </p>
        {onRetry ? (
          <button type="button" onClick={onRetry} data-testid="documentation-retry">
            Muat ulang
          </button>
        ) : null}
      </header>

      {error ? (
        <div role="alert" data-testid="documentation-error">
          {error.code}: {error.message}
        </div>
      ) : null}

      {availability === 'unavailable' ? (
        <div data-testid="documentation-unavailable" role="status">
          Dokumentasi domain tidak tersedia dari pin saat ini. Tidak mengekspor kesiapan palsu.
        </div>
      ) : (
        <pre
          data-testid="documentation-body"
          style={{
            whiteSpace: 'pre-wrap',
            fontFamily: 'inherit',
            background: 'var(--surface-2, #f0f1f5)',
            padding: 16,
            borderRadius: 8,
          }}
        >
          {bodyMarkdown}
        </pre>
      )}

      {citations.length ? (
        <section data-testid="documentation-citations" style={{ marginTop: 16 }}>
          <h2>Kutipan</h2>
          <ul>
            {citations.map((c, i) => (
              <li key={`${c.path}-${i}`}>
                <code>{c.path}</code> · {c.field}
                {c.note ? ` — ${c.note}` : ''}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {gaps.length ? (
        <section data-testid="documentation-gaps" style={{ marginTop: 16 }}>
          <h2>Gap jujur</h2>
          <ul>
            {gaps.map((g) => (
              <li key={g}>{g}</li>
            ))}
          </ul>
        </section>
      ) : null}

      {pin ? (
        <footer
          data-testid="documentation-pin"
          style={{ marginTop: 24, fontSize: 12, color: 'var(--text-faint)' }}
        >
          pin {pin.canonicalSnapshotId} · rev {pin.boardRev}/{pin.lifecycleRev}
          {pin.stale ? ` · STALE ${pin.staleReason ?? ''}` : ''}
        </footer>
      ) : null}
    </section>
  )
}
