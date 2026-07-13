import { useEffect, useId, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import styles from './overview.module.css'
import type { DecisionSeverity, OverviewDecisionSection } from './types'
import { EmptySlot } from './SurfaceBanner'
import { SemanticIcon } from './SemanticIcon'
import { resolveOwnerDisplay } from './ownerDisplay'
import { OwnerHumanFields } from './OwnerHumanFields'

function severityClass(sev: DecisionSeverity): string {
  if (sev === 'CRITICAL' || sev === 'HIGH') return styles.sevCritical
  if (sev === 'MEDIUM') return styles.sevMedium
  return styles.sevLow
}

function pillTone(section: OverviewDecisionSection): string {
  const top = section.topItem
  if (top?.blocking || section.topSeverity === 'CRITICAL' || section.topSeverity === 'HIGH') {
    return styles.stickyPillBlocking
  }
  return styles.stickyPillAmber
}

export function NeedsYourDecision({
  decision,
  pillCollapsed,
  onPillExpand,
  onPillCollapse,
  enableStickyPill = true,
  elevated = false,
  stickyShelfHostRef,
}: {
  decision: OverviewDecisionSection | null
  pillCollapsed?: boolean
  onPillExpand?: () => void
  onPillCollapse?: () => void
  enableStickyPill?: boolean
  elevated?: boolean
  /** Host in Overview sticky chrome; pill portals here so mission content never sits under it. */
  stickyShelfHostRef?: RefObject<HTMLElement | null>
}) {
  const cardRef = useRef<HTMLElement | null>(null)
  const [internalCollapsed, setInternalCollapsed] = useState(false)
  const [shelfHost, setShelfHost] = useState<HTMLElement | null>(null)
  const panelId = useId()
  const controlled = typeof pillCollapsed === 'boolean'
  const collapsed = controlled ? pillCollapsed : internalCollapsed
  // Stable callback refs: parent route passes inline setters every render; do not
  // resubscribe IntersectionObserver (would drop mid-scroll observations).
  const onPillExpandRef = useRef(onPillExpand)
  const onPillCollapseRef = useRef(onPillCollapse)
  onPillExpandRef.current = onPillExpand
  onPillCollapseRef.current = onPillCollapse

  useLayoutEffect(() => {
    setShelfHost(stickyShelfHostRef?.current ?? null)
  }, [stickyShelfHostRef, collapsed, enableStickyPill, decision])

  useEffect(() => {
    // Controlled mode must still observe: route always passes boolean pillCollapsed.
    // Skipping IO when controlled left the sticky pill permanently expanded (AC-UI-03).
    if (!enableStickyPill) return
    const el = cardRef.current
    if (!el || typeof IntersectionObserver === 'undefined') return

    // Prefer mission scrollport (non-obscuring shelf layout), then #view, else viewport.
    let scrollRoot: Element | null = null
    if (typeof document !== 'undefined') {
      const mission = document.querySelector('[data-testid="overview-mission-scroll"]')
      if (mission && mission.contains(el)) scrollRoot = mission
      else {
        const view = document.getElementById('view')
        if (view && view.contains(el)) scrollRoot = view
      }
    }

    // Dedupe consecutive identical visibility edges — no duplicate parent setState.
    let lastCollapsed: boolean | null = null

    const io = new IntersectionObserver(
      ([entry]) => {
        if (!entry) return
        const next = !entry.isIntersecting
        if (lastCollapsed === next) return
        lastCollapsed = next
        // Uncontrolled owns local state; controlled relies on parent via callbacks only.
        if (!controlled) setInternalCollapsed(next)
        if (next) onPillCollapseRef.current?.()
        else onPillExpandRef.current?.()
      },
      { root: scrollRoot, threshold: 0, rootMargin: '-8px 0px 0px 0px' },
    )
    io.observe(el)
    return () => io.disconnect()
  }, [enableStickyPill, controlled])

  if (!decision || decision.count === 0 || !decision.topItem) {
    return (
      <section aria-labelledby={`${panelId}-title`} data-testid="overview-decision-empty">
        <h2 id={`${panelId}-title`} className={styles.sectionLabel}>
          Needs Your Decision
        </h2>
        <EmptySlot>No decisions waiting on you.</EmptySlot>
      </section>
    )
  }

  const item = decision.topItem
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

  const showPill = enableStickyPill && collapsed
  const topSev = decision.topSeverity ?? item.severity
  // Avoid triple-repeat of raw id as title + question + id chip.
  const questionRaw = item.question?.trim() ?? ''
  const titleRaw = item.title?.trim() ?? ''
  const questionIsDuplicate =
    !questionRaw ||
    questionRaw === titleRaw ||
    questionRaw === item.decisionId ||
    (titleRaw === item.decisionId && questionRaw === item.decisionId)
  const questionDisplay = questionIsDuplicate
    ? 'Question not projected — open Decisions for the full inbox item.'
    : questionRaw

  // Owner primary = reviewed humanDisplay title (or CONTENT_REVIEW_REQUIRED shell).
  // Never raw technical title as owner primary.
  const titleDisplay = display.primaryTitle

  const pillNode = showPill ? (
    <div
      className={`${styles.stickyPill} ${pillTone(decision)}`}
      data-testid="overview-decision-pill"
      data-shelf={shelfHost ? 'true' : 'false'}
      role="region"
      aria-label={`Needs your decision: ${decision.count} open, ${topSev}${item.blocking ? ', blocking' : ''}`}
    >
      <SemanticIcon kind="alert" />
      <div className={styles.pillMeta}>
        <span data-testid="overview-decision-pill-count">
          {decision.count} decision{decision.count === 1 ? '' : 's'}
        </span>
        <span aria-hidden="true"> · </span>
        <span data-testid="overview-decision-pill-severity">{topSev}</span>
        {item.blocking ? (
          <>
            <span aria-hidden="true"> · </span>
            <span className={styles.pillBlockingLabel}>blocking</span>
          </>
        ) : null}
      </div>
      <button
        type="button"
        className={styles.pillBtn}
        onClick={() => {
          if (!controlled) setInternalCollapsed(false)
          onPillExpand?.()
          const node = cardRef.current
          if (node && typeof node.scrollIntoView === 'function') {
            const reduce =
              typeof window !== 'undefined' &&
              window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
            node.scrollIntoView({
              block: 'nearest',
              behavior: reduce ? 'auto' : 'smooth',
            })
          }
        }}
        aria-expanded="false"
        aria-controls={panelId}
      >
        Expand
      </button>
    </div>
  ) : null

  // Prefer portal into Overview sticky chrome (flow reservation): pill sits in a
  // non-scrolling shelf so mission sections never geometrically intersect it.
  // Fallback: inline sticky sibling when no shelf host (unit tests / edge shells).
  const pillRender =
    pillNode && shelfHost ? createPortal(pillNode, shelfHost) : pillNode

  return (
    <>
      {pillRender}

      <div
        className={styles.decisionStack}
        data-testid="overview-decision-stack"
        data-pill-collapsed={showPill ? 'true' : 'false'}
        data-blocking={item.blocking ? 'true' : 'false'}
      >
        <section
          ref={cardRef}
          id={panelId}
          className={`${styles.decisionCard}${elevated || item.blocking ? ` ${styles.cardElevated}` : ''}${showPill ? ` ${styles.decisionCardSpacer}` : ''}`}
          data-testid="overview-decision-card"
          data-blocking={item.blocking ? 'true' : 'false'}
          data-content-review-required={display.contentReviewRequired ? 'true' : 'false'}
          data-effective-review-status={display.effectiveReviewStatus}
          data-owner-primary-title={display.primaryTitle}
          aria-labelledby={`${panelId}-title`}
          // Keep full card name/description/actions in the accessibility tree when the
          // sticky pill is showing (visual one-line pill remains; never strip a11y content).
        >
          <h2 id={`${panelId}-title`} className={styles.cardTitle}>
            <SemanticIcon kind="alert" />
            Needs Your Decision
          </h2>
          <div className={styles.decisionHead}>
            <span className={`${styles.severity} ${severityClass(item.severity)}`}>
              <span aria-hidden="true">!</span>
              {item.severity}
            </span>
            {item.blocking ? (
              <span className={styles.blockingBadge}>
                <span aria-hidden="true">⛔</span> Blocking
              </span>
            ) : null}
            <span className={styles.taskId} title={item.decisionId}>
              {item.decisionId}
            </span>
            {decision.count > 1 ? (
              <span className={styles.chip}>{decision.count} open</span>
            ) : null}
          </div>
          <h3
            className={styles.decisionTitle}
            data-testid="overview-decision-owner-title"
            data-field="ownerPrimaryTitle"
          >
            {titleDisplay}
          </h3>
          {/* Technical title secondary only — never owner primary. */}
          {display.technicalTitle &&
          display.technicalTitle !== display.primaryTitle &&
          display.technicalTitle !== item.decisionId ? (
            <div
              className={styles.technicalSecondary}
              data-testid="overview-decision-technical-title"
              data-field="technicalTitle"
              title={display.technicalTitle}
            >
              {display.technicalTitle}
            </div>
          ) : null}
          <p
            className={`${styles.decisionQuestion}${
              questionIsDuplicate ? ` ${styles.decisionQuestionPartial}` : ''
            }`}
            data-testid="overview-decision-question"
          >
            {questionDisplay}
          </p>

          <OwnerHumanFields display={display} testIdPrefix="overview-decision" />

          {item.options?.length ? (
            <ul className={styles.panelList} style={{ marginTop: '0.75rem' }}>
              {item.options.map((o) => (
                <li key={o.optionId} className={styles.panelRow}>
                  <span>{o.label}</span>
                </li>
              ))}
            </ul>
          ) : null}
        </section>
      </div>
    </>
  )
}
