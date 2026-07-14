/**
 * ART S21 — Knowledge conflict / redaction surface.
 * Shows PROVEN|UNKNOWN|CONFLICT|STALE honestly; never picks a winning source.
 */
import type { KnowledgeConflictPanelModel } from '#/lib/control-center-secondary-route-adapters'

export type KnowledgeConflictPanelProps = {
  model: KnowledgeConflictPanelModel | null | undefined
  onRetry?: () => void
  className?: string
}

const STATE_BORDER: Record<KnowledgeConflictPanelModel['knowledgeState'], string> = {
  PROVEN: 'var(--ok, #1f7a4c)',
  UNKNOWN: 'var(--text-faint, #6b7280)',
  CONFLICT: 'var(--danger, #b42318)',
  STALE: 'var(--warn, #b54708)',
}

const STATE_BG: Record<KnowledgeConflictPanelModel['knowledgeState'], string> = {
  PROVEN: 'color-mix(in srgb, var(--ok, #1f7a4c) 10%, transparent)',
  UNKNOWN: 'color-mix(in srgb, var(--text-faint, #6b7280) 10%, transparent)',
  CONFLICT: 'color-mix(in srgb, var(--danger, #b42318) 12%, transparent)',
  STALE: 'color-mix(in srgb, var(--warn, #b54708) 14%, transparent)',
}

/**
 * Distinct conflict/redaction panel for knowledge domain (screenshot residual #3).
 * Returns null when model is absent or not visible (PROVEN without redactions).
 */
export function KnowledgeConflictPanel({
  model,
  onRetry,
  className,
}: KnowledgeConflictPanelProps) {
  if (!model || !model.visible) return null

  const {
    knowledgeState,
    certaintyBlocked,
    headline,
    detail,
    sources,
    redactions,
    staleReason,
    lastValidGeneratedAt,
    gaps,
    domain,
  } = model

  const role =
    knowledgeState === 'CONFLICT' || knowledgeState === 'STALE' ? 'alert' : 'status'

  return (
    <aside
      className={className}
      data-testid="knowledge-conflict"
      data-knowledge-state={knowledgeState}
      data-domain={domain}
      data-certainty-blocked={certaintyBlocked ? 'true' : 'false'}
      role={role}
      style={{
        marginBottom: 16,
        padding: '12px 14px',
        borderRadius: 8,
        border: `1px solid ${STATE_BORDER[knowledgeState]}`,
        background: STATE_BG[knowledgeState],
      }}
    >
      <header style={{ marginBottom: 8 }}>
        <p
          style={{
            margin: 0,
            fontSize: 11,
            letterSpacing: '0.04em',
            textTransform: 'uppercase',
            color: 'var(--text-faint)',
          }}
        >
          Status pengetahuan
        </p>
        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            alignItems: 'center',
            gap: 8,
            marginTop: 4,
          }}
        >
          <strong data-testid="knowledge-conflict-state" style={{ fontSize: 14 }}>
            {knowledgeState}
          </strong>
          <span style={{ fontSize: 15 }}>{headline}</span>
        </div>
        <p data-testid="knowledge-conflict-detail" style={{ margin: '6px 0 0', fontSize: 13 }}>
          {detail}
        </p>
      </header>

      {certaintyBlocked ? (
        <p
          data-testid="knowledge-conflict-certainty-blocked"
          style={{
            margin: '0 0 10px',
            fontSize: 13,
            fontWeight: 600,
            color: STATE_BORDER[knowledgeState === 'PROVEN' ? 'UNKNOWN' : knowledgeState],
          }}
        >
          Kepastian diblokir — tidak memilih sumber diam-diam.
        </p>
      ) : null}

      {knowledgeState === 'STALE' || staleReason ? (
        <div
          data-testid="knowledge-conflict-stale"
          style={{ marginBottom: 10, fontSize: 13 }}
        >
          <p style={{ margin: 0 }}>
            <strong>STALE</strong>
            {staleReason ? (
              <>
                {' '}
                · alasan: <code data-testid="knowledge-conflict-stale-reason">{staleReason}</code>
              </>
            ) : null}
          </p>
          <p style={{ margin: '4px 0 0', color: 'var(--text-faint)' }}>
            Waktu valid terakhir:{' '}
            {lastValidGeneratedAt ? (
              <time dateTime={lastValidGeneratedAt} data-testid="knowledge-conflict-last-valid">
                {lastValidGeneratedAt}
              </time>
            ) : (
              <span data-testid="knowledge-conflict-last-valid-missing">
                tidak di-pin (jujur kosong)
              </span>
            )}
          </p>
        </div>
      ) : null}

      {sources.length > 0 ? (
        <section data-testid="knowledge-conflict-sources" style={{ marginBottom: 10 }}>
          <h3 style={{ fontSize: 13, margin: '0 0 6px' }}>
            Sumber bentrok ({sources.length}) — keduanya ditampilkan
          </h3>
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            {sources.map((s) => (
              <li
                key={s.sourceId}
                data-testid="knowledge-conflict-source"
                data-source-id={s.sourceId}
                style={{ marginBottom: 4, fontSize: 13 }}
              >
                <strong>{s.label}</strong>
                {s.citation ? (
                  <>
                    {' '}
                    · sitasi <code>{s.citation}</code>
                  </>
                ) : null}
                {s.claim ? <> — {s.claim}</> : null}
              </li>
            ))}
          </ul>
        </section>
      ) : knowledgeState === 'CONFLICT' ? (
        <p
          data-testid="knowledge-conflict-sources-empty"
          style={{ margin: '0 0 10px', fontSize: 13, color: 'var(--text-faint)' }}
        >
          Konflik dilaporkan tanpa daftar sumber terstruktur — kepastian tetap diblokir.
        </p>
      ) : null}

      {redactions.length > 0 ? (
        <section data-testid="knowledge-conflict-redactions" style={{ marginBottom: 10 }}>
          <h3 style={{ fontSize: 13, margin: '0 0 6px' }}>
            Redaksi parsial — lingkup tersembunyi dijelaskan
          </h3>
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            {redactions.map((r) => (
              <li
                key={`${r.fieldPath}:${r.reason}`}
                data-testid="knowledge-conflict-redaction"
                data-field-path={r.fieldPath}
                style={{ marginBottom: 4, fontSize: 13 }}
              >
                <code>{r.fieldPath}</code> · {r.reason} — scope: {r.hiddenScope}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {gaps.length > 0 ? (
        <section data-testid="knowledge-conflict-gaps" style={{ marginBottom: 8 }}>
          <h3 style={{ fontSize: 13, margin: '0 0 6px' }}>Gap jujur terkait status</h3>
          <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13 }}>
            {gaps.map((g) => (
              <li key={g}>{g}</li>
            ))}
          </ul>
        </section>
      ) : null}

      {onRetry && certaintyBlocked ? (
        <button
          type="button"
          onClick={onRetry}
          data-testid="knowledge-conflict-retry"
          style={{ marginTop: 4 }}
        >
          Muat ulang / rekonsiliasi
        </button>
      ) : null}
    </aside>
  )
}
