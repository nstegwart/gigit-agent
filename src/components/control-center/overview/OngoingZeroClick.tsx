import styles from './overview.module.css'
import type { OverviewOngoingItem, ProductiveState } from './types'
import { EmptySlot } from './SurfaceBanner'
import { SemanticIcon } from './SemanticIcon'
import { resolveOwnerDisplay } from './ownerDisplay'
import { OwnerHumanFields } from './OwnerHumanFields'

function productiveClass(state: ProductiveState): string {
  if (state === 'PRODUCTIVE') return styles.prodProductive
  if (state === 'STALLED') return styles.prodStalled
  return styles.prodIdle
}

function ProductiveBadge({ state }: { state: ProductiveState }) {
  const isProd = state === 'PRODUCTIVE'
  return (
    <span
      className={`${styles.prodState} ${productiveClass(state)}`}
      data-productive-state={state}
      role="status"
      aria-label={`Work state: ${state}`}
    >
      {isProd ? (
        <span className={`${styles.pulseDot} ${styles.pulseDotLive}`} aria-hidden="true" />
      ) : (
        <span className={styles.hollowDot} aria-hidden="true" />
      )}
      <SemanticIcon kind={state} />
      <span>{state}</span>
    </span>
  )
}

export function OngoingCard({ item }: { item: OverviewOngoingItem }) {
  const display = resolveOwnerDisplay({
    technicalTitle: item.title,
    ownerPrimaryTitle: item.ownerPrimaryTitle,
    statusSentence: item.statusSentence,
    ownerAction: item.ownerAction,
    whyItMatters: item.whyItMatters,
    next: item.next,
    blocker: item.blocker,
    contentReviewRequired: item.contentReviewRequired,
    effectiveReviewStatus: item.effectiveReviewStatus,
    citations: item.citations,
    ownerHumanDisplay: item.ownerHumanDisplay,
  })

  return (
    <li
      className={styles.ongoingCard}
      data-testid="overview-ongoing-card"
      data-task-id={item.taskId}
      data-productive-state={item.productiveState}
      data-content-review-required={display.contentReviewRequired ? 'true' : 'false'}
      data-owner-primary-title={display.primaryTitle}
    >
      <div className={styles.ongoingTop}>
        <div style={{ minWidth: 0 }}>
          <div className={styles.taskId}>{item.taskId}</div>
          <h3
            className={styles.ongoingTitle}
            data-testid="overview-ongoing-owner-title"
            data-field="ownerPrimaryTitle"
          >
            {display.primaryTitle}
          </h3>
          {/* Technical title secondary only — never owner primary. */}
          {display.technicalTitle && display.technicalTitle !== display.primaryTitle ? (
            <div
              className={styles.technicalSecondary}
              data-testid="overview-ongoing-technical-title"
              data-field="technicalTitle"
              title={display.technicalTitle}
            >
              {display.technicalTitle}
            </div>
          ) : null}
        </div>
        <ProductiveBadge state={item.productiveState} />
      </div>

      <OwnerHumanFields display={display} testIdPrefix="overview-ongoing" />

      <div className={styles.ongoingMeta}>
        <span className={styles.chip}>
          gate <strong>{item.targetGate}</strong>
        </span>
        <span className={styles.chip}>
          agent <strong>{item.agentId}</strong>
        </span>
        <span className={styles.chip}>
          role <strong>{item.role}</strong>
        </span>
        <span className={`${styles.chip} ${styles.chipMono}`}>{item.model}</span>
        <span className={styles.chip}>effort {item.effort}</span>
        <span className={`${styles.chip} ${styles.chipMono}`} data-field="masked-account">
          {item.maskedAccount}
        </span>
      </div>

      <div className={styles.ages} data-testid="ongoing-ages">
        <div>
          <span className={styles.ageLabel}>Started</span>
          <span data-field="started-age">{item.startedAge}</span>
        </div>
        <div>
          <span className={styles.ageLabel}>Heartbeat</span>
          <span data-field="heartbeat-age">{item.heartbeatAge}</span>
        </div>
        <div>
          <span className={styles.ageLabel}>Material progress</span>
          <span data-field="material-age">{item.materialProgressAge}</span>
        </div>
      </div>

      <div>
        {item.evidenceHref ? (
          <a
            className={styles.linkBtn}
            href={item.evidenceHref}
            data-field="evidence"
          >
            <SemanticIcon kind="check" />
            {item.evidenceLabel}
          </a>
        ) : (
          <span className={styles.chip} data-field="evidence">
            {item.evidenceLabel}
          </span>
        )}
      </div>
    </li>
  )
}

export function OngoingZeroClick({
  items,
  emptyLabel = 'No ONGOING work.',
}: {
  items: OverviewOngoingItem[]
  emptyLabel?: string
}) {
  return (
    <section data-testid="overview-ongoing" aria-labelledby="ov-ongoing-title">
      <h2 id="ov-ongoing-title" className={styles.sectionLabel}>
        ONGOING (zero-click)
      </h2>
      {items.length === 0 ? (
        <EmptySlot>{emptyLabel}</EmptySlot>
      ) : (
        <ul className={styles.ongoingList}>
          {items.map((item) => (
            <OngoingCard key={item.taskId} item={item} />
          ))}
        </ul>
      )}
    </section>
  )
}
