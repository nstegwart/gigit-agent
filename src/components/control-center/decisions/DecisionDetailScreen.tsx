/**
 * ART S12 decision detail shell from pinned decisions envelope.
 * Page title uses owner humanDisplay (blockedShell when unreviewed) — never raw technical title alone.
 */
import type { DecisionDetailViewModel } from '#/lib/control-center-route-adapters'
import { DecisionCard } from './DecisionCard'
import { resolveDecisionOwnerDisplay } from './decisionActions'

export type DecisionDetailScreenProps = DecisionDetailViewModel & {
  onRetry?: () => void
  className?: string
}

export function DecisionDetailScreen({
  surfaceState,
  boardId,
  decisionId,
  item,
  pin,
  error,
  listHref,
  onRetry,
  className,
}: DecisionDetailScreenProps) {
  const owner = item ? resolveDecisionOwnerDisplay(item) : null
  const pageTitle = owner?.primaryTitle ?? 'Keputusan tidak ditemukan'

  return (
    <section
      className={className}
      data-testid="control-center-decision-detail"
      data-surface-state={surfaceState}
      data-board-id={boardId}
      data-decision-id={decisionId}
      data-content-review-required={
        owner?.contentReviewRequired ? 'true' : owner ? 'false' : undefined
      }
    >
      <header style={{ marginBottom: 16 }}>
        <p style={{ fontSize: 12, color: 'var(--text-faint)', margin: 0 }}>Detail keputusan</p>
        <h1 style={{ fontSize: 22, margin: '4px 0 8px' }} data-testid="decision-detail-title">
          {pageTitle}
        </h1>
        {owner?.statusSentence ? (
          <p
            style={{ margin: '0 0 8px', color: 'var(--text-muted)' }}
            data-testid="decision-detail-status-sentence"
          >
            {owner.statusSentence}
          </p>
        ) : null}
        <a href={listHref} data-testid="decision-detail-back">
          ← Kotak masuk keputusan
        </a>
        {onRetry ? (
          <button
            type="button"
            onClick={onRetry}
            data-testid="decision-detail-retry"
            style={{ marginLeft: 12 }}
          >
            Muat ulang
          </button>
        ) : null}
      </header>

      {error && !item ? (
        <div role="alert" data-testid="decision-detail-error">
          {error.code}: {error.message}
        </div>
      ) : null}

      {item ? (
        <div data-testid="decision-detail-body">
          <DecisionCard item={item} boardId={boardId} canAct={false} />
        </div>
      ) : (
        <p data-testid="decision-detail-missing" role="status">
          Keputusan <code>{decisionId}</code> tidak ada di pin inbox saat ini.
        </p>
      )}

      {pin ? (
        <footer
          data-testid="decision-detail-pin"
          style={{ marginTop: 24, fontSize: 12, color: 'var(--text-faint)' }}
        >
          pin {pin.canonicalSnapshotId} · rev {pin.boardRev}/{pin.lifecycleRev}
          {pin.stale ? ` · STALE ${pin.staleReason ?? ''}` : ''}
        </footer>
      ) : null}
    </section>
  )
}
