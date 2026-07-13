/**
 * Owner-facing humanDisplay field block for Work surfaces.
 * Renders projected status/why/next/blocker/action/citations only.
 * Never invents copy; CONTENT_REVIEW_REQUIRED shell chrome when review required.
 */
import styles from './work.module.css'
import type { OwnerDisplayResolved } from './ownerDisplay'

export function OwnerHumanFields({
  display,
  testIdPrefix = 'owner-human',
}: {
  display: OwnerDisplayResolved
  testIdPrefix?: string
}) {
  const {
    contentReviewRequired,
    statusSentence,
    whyItMatters,
    next,
    blocker,
    ownerAction,
    citations,
    effectiveReviewStatus,
  } = display

  return (
    <div
      className={styles.ownerHumanBlock}
      data-testid={`${testIdPrefix}-fields`}
      data-content-review-required={contentReviewRequired ? 'true' : 'false'}
      data-effective-review-status={effectiveReviewStatus}
    >
      {contentReviewRequired ? (
        <span
          className={styles.contentReviewBadge}
          data-testid={`${testIdPrefix}-review-badge`}
          role="status"
        >
          CONTENT_REVIEW_REQUIRED
        </span>
      ) : null}

      {statusSentence ? (
        <p
          className={styles.ownerField}
          data-testid={`${testIdPrefix}-status`}
          data-field="statusSentence"
        >
          <span className={styles.ownerFieldLabel}>Status</span>
          {statusSentence}
        </p>
      ) : null}

      {whyItMatters ? (
        <p
          className={styles.ownerField}
          data-testid={`${testIdPrefix}-why`}
          data-field="whyItMatters"
        >
          <span className={styles.ownerFieldLabel}>Why</span>
          {whyItMatters}
        </p>
      ) : null}

      {next ? (
        <p className={styles.ownerField} data-testid={`${testIdPrefix}-next`} data-field="next">
          <span className={styles.ownerFieldLabel}>Next</span>
          {next}
        </p>
      ) : null}

      {blocker ? (
        <p
          className={styles.ownerField}
          data-testid={`${testIdPrefix}-blocker`}
          data-field="blocker"
        >
          <span className={styles.ownerFieldLabel}>Blocker</span>
          {blocker}
        </p>
      ) : null}

      {ownerAction ? (
        <div
          className={styles.ownerAction}
          data-testid={`${testIdPrefix}-action`}
          data-field="ownerAction"
        >
          <span className={styles.ownerActionLabel}>Owner action</span>
          {ownerAction}
        </div>
      ) : null}

      {citations.length > 0 ? (
        <ul
          className={styles.ownerCitations}
          data-testid={`${testIdPrefix}-citations`}
          aria-label="Citations"
        >
          {citations.map((c, i) => (
            <li
              key={`${c.field}:${c.path}:${i}`}
              className={styles.ownerCitationItem}
              data-field={c.field}
              data-path={c.path}
            >
              <span className={styles.citationMono}>
                {c.field}
                {c.path ? ` · ${c.path}` : ''}
              </span>
              {c.note ? <span className={styles.citationNote}> — {c.note}</span> : null}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}
