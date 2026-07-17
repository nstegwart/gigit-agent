/**
 * ART S15–S16 human semantic + technical alias search results (prop-driven).
 */
import type { SearchResultViewModel } from '#/lib/control-center-route-adapters'

export type SearchScreenProps = SearchResultViewModel & {
  onRetry?: () => void
  returnHref?: string
  className?: string
}

export function SearchScreen({
  surfaceState,
  boardId,
  query,
  results,
  pin,
  error,
  onRetry,
  returnHref,
  className,
}: SearchScreenProps) {
  return (
    <section
      className={className}
      data-testid="control-center-search"
      data-surface-state={surfaceState}
      data-board-id={boardId}
      data-query={query}
    >
      <header style={{ marginBottom: 16 }}>
        <p style={{ fontSize: 12, color: 'var(--text-faint)', margin: 0 }}>
          Pencarian
        </p>
        <h1
          style={{ fontSize: 22, margin: '4px 0 8px' }}
          data-testid="search-title"
        >
          Hasil pencarian
        </h1>
        <p data-testid="search-query">
          Kueri: <strong>{query || '(kosong)'}</strong>
        </p>
        {returnHref ? (
          <a href={returnHref} data-testid="search-return-context">
            Kembali ke konteks sebelumnya
          </a>
        ) : null}
        {onRetry ? (
          <button type="button" onClick={onRetry} data-testid="search-retry">
            Muat ulang
          </button>
        ) : null}
      </header>

      {error ? (
        <div role="alert" data-testid="search-error">
          {error.code}: {error.message}
        </div>
      ) : null}

      {surfaceState === 'empty' ? (
        <p data-testid="search-empty" role="status">
          Masukkan kueri di <code>?q=</code>.
        </p>
      ) : null}

      {surfaceState === 'zero-results' ? (
        <p data-testid="search-zero-results" role="status">
          Tidak ada hasil untuk “{query}” pada data ter-pin.
        </p>
      ) : null}

      {results.length > 0 ? (
        <ul data-testid="search-results">
          {results.map((r) => (
            <li
              key={`${r.kind}:${r.id}`}
              data-testid="search-result-row"
              data-kind={r.kind}
              data-id={r.id}
            >
              <a href={r.href}>
                <span data-field="title">{r.title}</span>
              </a>
              {r.subtitle ? (
                <span
                  data-field="subtitle"
                  style={{ marginLeft: 8, color: 'var(--text-muted)' }}
                >
                  {r.subtitle}
                </span>
              ) : null}
              {r.technicalAlias ? (
                <code
                  data-field="technical-alias"
                  style={{
                    marginLeft: 8,
                    fontSize: 12,
                    color: 'var(--text-faint)',
                  }}
                >
                  {r.technicalAlias}
                </code>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}

      {pin ? (
        <footer
          data-testid="search-pin"
          style={{ marginTop: 24, fontSize: 12, color: 'var(--text-faint)' }}
        >
          pin {pin.canonicalSnapshotId} · rev {pin.boardRev}/{pin.lifecycleRev}
          {pin.stale ? ` · STALE ${pin.staleReason ?? ''}` : ''}
        </footer>
      ) : null}
    </section>
  )
}
