/**
 * ART S12 decision detail shell from pinned decisions envelope.
 * Direction B kit: PageHeader / Breadcrumb / Card / Disclosure / EmptyState / Button.
 * Page title uses owner humanDisplay (blockedShell when unreviewed) — never raw technical title alone.
 */
import {
  Breadcrumb,
  Button,
  Card,
  Disclosure,
  EmptyState,
  PageHeader,
} from '#/components/ui'
import type { DecisionDetailViewModel } from '#/lib/control-center-route-adapters'
import { DecisionCard } from './DecisionCard'
import { resolveDecisionOwnerDisplay } from './decisionActions'
import styles from './decisions.module.css'

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
  const techSecondary =
    owner && owner.technicalTitle && owner.technicalTitle !== owner.primaryTitle
      ? owner.technicalTitle
      : decisionId !== pageTitle
        ? decisionId
        : null
  const boardHref = `/b/${encodeURIComponent(boardId)}`

  return (
    <section
      className={[styles.detailRoot, className].filter(Boolean).join(' ')}
      data-testid="control-center-decision-detail"
      data-surface-state={surfaceState}
      data-board-id={boardId}
      data-decision-id={decisionId}
      data-content-review-required={
        owner?.contentReviewRequired ? 'true' : owner ? 'false' : undefined
      }
    >
      <PageHeader
        eyebrow="Detail keputusan"
        title={<span data-testid="decision-detail-title">{pageTitle}</span>}
        subtitle={
          owner?.statusSentence ? (
            <span data-testid="decision-detail-status-sentence">
              {owner.statusSentence}
            </span>
          ) : techSecondary ? (
            <span className={styles.techSecondary}>{techSecondary}</span>
          ) : null
        }
        breadcrumb={
          <Breadcrumb
            items={[
              { label: 'Board', href: boardHref },
              { label: 'Keputusan', href: listHref },
              { label: pageTitle },
            ]}
          />
        }
        actions={
          <>
            <Button
              variant="secondary"
              size="sm"
              data-testid="decision-detail-back"
              onClick={() => {
                window.location.assign(listHref)
              }}
            >
              Kotak masuk keputusan
            </Button>
            {onRetry ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={onRetry}
                data-testid="decision-detail-retry"
              >
                Muat ulang
              </Button>
            ) : null}
          </>
        }
      />

      {error && !item ? (
        <Card role="alert" data-testid="decision-detail-error" title="Kesalahan">
          <p className={styles.bannerBody}>
            {error.code}: {error.message}
          </p>
          {onRetry ? (
            <Button type="button" variant="primary" size="sm" onClick={onRetry}>
              Coba lagi
            </Button>
          ) : null}
        </Card>
      ) : null}

      {item ? (
        <div data-testid="decision-detail-body">
          <DecisionCard item={item} boardId={boardId} canAct={false} />
        </div>
      ) : (
        <EmptyState
          data-testid="decision-detail-missing"
          title="Keputusan tidak ada"
          description={`Keputusan ${decisionId} tidak ada di pin inbox saat ini.`}
          action={
            <Button
              variant="secondary"
              size="sm"
              onClick={() => window.location.assign(listHref)}
            >
              Kembali ke kotak masuk
            </Button>
          }
        />
      )}

      {pin ? (
        <Disclosure summary="Detail teknis" data-testid="decision-detail-pin">
          <dl className={styles.techDl}>
            <dt>pin</dt>
            <dd className={styles.mono}>{pin.canonicalSnapshotId}</dd>
            <dt>boardRev</dt>
            <dd className={styles.mono}>{pin.boardRev}</dd>
            <dt>lifecycleRev</dt>
            <dd className={styles.mono}>{pin.lifecycleRev}</dd>
            {pin.stale ? (
              <>
                <dt>stale</dt>
                <dd>{pin.staleReason ?? 'STALE'}</dd>
              </>
            ) : null}
            <dt>decisionId</dt>
            <dd className={styles.mono}>{decisionId}</dd>
          </dl>
        </Disclosure>
      ) : null}
    </section>
  )
}
