/**
 * C3 Overview composition — prop-driven only.
 * Mobile DOM order matches UI_CONTRACT §4.
 * No fetch, no bucket/readiness/priority recomputation.
 *
 * Sticky decision shelf (C3-C10): app summary + collapsed pill live in a
 * non-scrolling chrome band; mission body scrolls in a sibling region so
 * section boxes never geometrically intersect the pill (real flow reservation).
 */
import { useLayoutEffect, useRef } from 'react'
import { pinnedSurfaceDataAttrs } from '#/components/control-center/PinnedSurface'
import styles from './overview.module.css'
import type { OverviewProps } from './types'
import { AppSummaryBar } from './AppSummaryBar'
import { NeedsYourDecision } from './NeedsYourDecision'
import { PriorityCard } from './PriorityCard'
import { GlobalCard } from './GlobalCard'
import { BucketStrip } from './BucketStrip'
import { OngoingZeroClick } from './OngoingZeroClick'
import { LowerPanels } from './LowerPanels'
import { EmptySlot, OverviewSkeleton, SurfaceBanner } from './SurfaceBanner'

export function Overview({
  surfaceState,
  appSummary,
  pin,
  decision,
  priority,
  global,
  buckets,
  ongoing,
  lower,
  partialErrors,
  error,
  onRetry,
  onReconnect,
  pillCollapsed,
  onPillExpand,
  onPillCollapse,
  enableStickyPill = true,
  liveMessage,
  className,
}: OverviewProps) {
  /** Hard terminal surfaces: no mission body. disconnected/stale/partial still render data. */
  const hideMissionBody =
    surfaceState === 'error' || surfaceState === 'forbidden' || surfaceState === 'loading'

  const needsHuman =
    surfaceState === 'needs-human' ||
    (decision?.topItem?.blocking === true && (decision?.count ?? 0) > 0)

  const pinMeta =
    pin ??
    (appSummary
      ? {
          canonicalSnapshotId: appSummary.canonicalSnapshotId ?? null,
          canonicalHash: appSummary.canonicalHash ?? null,
          boardRev: typeof appSummary.boardRev === 'number' ? appSummary.boardRev : null,
          lifecycleRev:
            typeof appSummary.lifecycleRev === 'number' ? appSummary.lifecycleRev : null,
        }
      : null)

  const rootRef = useRef<HTMLDivElement | null>(null)
  const stickyShelfRef = useRef<HTMLDivElement | null>(null)

  // Fill #view client height so the mission region owns overflow (shelf stays fixed).
  useLayoutEffect(() => {
    const root = rootRef.current
    if (!root || typeof document === 'undefined') return
    const view = document.getElementById('view')
    if (!view) return
    const apply = () => {
      const h = view.clientHeight
      if (h > 40) root.style.height = `${h}px`
      else root.style.height = ''
    }
    apply()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(apply)
    ro.observe(view)
    return () => {
      ro.disconnect()
      root.style.height = ''
    }
  }, [surfaceState, hideMissionBody])

  // Legacy CSS var for fallback sticky top when shelf host is absent (unit tests).
  useLayoutEffect(() => {
    const root = rootRef.current
    if (!root || typeof ResizeObserver === 'undefined') return
    const bar = root.querySelector('[data-testid="overview-app-summary"]')
    const apply = () => {
      const h = bar instanceof HTMLElement ? Math.ceil(bar.getBoundingClientRect().height) : 0
      root.style.setProperty('--cc-sticky-pill-top', `${h}px`)
    }
    apply()
    if (!(bar instanceof HTMLElement)) return
    const ro = new ResizeObserver(apply)
    ro.observe(bar)
    return () => ro.disconnect()
  }, [surfaceState, appSummary, pillCollapsed, hideMissionBody])

  const shelfActive = enableStickyPill && !hideMissionBody && Boolean(appSummary)

  return (
    <div
      ref={rootRef}
      className={`${styles.root}${shelfActive ? ` ${styles.rootShelf}` : ''}${className ? ` ${className}` : ''}`}
      data-testid="control-center-overview"
      data-surface-state={surfaceState}
      data-needs-human={needsHuman ? 'true' : 'false'}
      data-shelf-layout={shelfActive ? 'true' : 'false'}
      data-pill-collapsed={pillCollapsed ? 'true' : 'false'}
      {...pinnedSurfaceDataAttrs(pinMeta)}
    >
      {/* Coalesced live updates: single polite region; parent supplies latest message */}
      <div
        className={styles.liveRegion}
        aria-live="polite"
        aria-atomic="true"
        data-testid="overview-live"
      >
        {liveMessage ?? ''}
      </div>

      <SurfaceBanner
        state={surfaceState}
        error={error}
        partialErrors={partialErrors}
        staleReason={appSummary?.staleReason ?? error?.message}
        onRetry={onRetry}
        onReconnect={onReconnect}
      />

      {surfaceState === 'loading' ? <OverviewSkeleton /> : null}

      {surfaceState === 'error' || surfaceState === 'forbidden' ? null : (
        <>
          {shelfActive ? (
            <>
              {/* Non-scrolling sticky chrome: app summary + collapsed decision pill.
                  Mission content scrolls in the sibling below — real flow reservation. */}
              <div
                ref={stickyShelfRef}
                className={styles.stickyChrome}
                data-testid="overview-sticky-chrome"
              >
                {appSummary ? <AppSummaryBar summary={appSummary} /> : null}
              </div>
              <div
                className={styles.missionScroll}
                data-testid="overview-mission-scroll"
                id="overview-mission-scroll"
              >
                <NeedsYourDecision
                  decision={decision}
                  pillCollapsed={pillCollapsed}
                  onPillExpand={onPillExpand}
                  onPillCollapse={onPillCollapse}
                  enableStickyPill={enableStickyPill}
                  elevated={needsHuman}
                  stickyShelfHostRef={stickyShelfRef}
                />

                {surfaceState === 'empty' && !decision?.count && !ongoing.length && !priority ? (
                  <EmptySlot>Overview is empty — no tracked mission data for this board.</EmptySlot>
                ) : null}

                <div className={styles.priorityGlobal}>
                  <PriorityCard data={priority} />
                  <GlobalCard data={global} />
                </div>

                <BucketStrip data={buckets} />

                <OngoingZeroClick
                  items={ongoing}
                  emptyLabel={
                    surfaceState === 'zero-results'
                      ? 'No ONGOING items match the current filters.'
                      : 'No ONGOING work.'
                  }
                />

                <LowerPanels data={lower} />
              </div>
            </>
          ) : (
            <>
              {appSummary && surfaceState !== 'loading' ? (
                <AppSummaryBar summary={appSummary} />
              ) : null}

              {!hideMissionBody ? (
                <>
                  <NeedsYourDecision
                    decision={decision}
                    pillCollapsed={pillCollapsed}
                    onPillExpand={onPillExpand}
                    onPillCollapse={onPillCollapse}
                    enableStickyPill={enableStickyPill}
                    elevated={needsHuman}
                  />

                  {surfaceState === 'empty' && !decision?.count && !ongoing.length && !priority ? (
                    <EmptySlot>Overview is empty — no tracked mission data for this board.</EmptySlot>
                  ) : null}

                  <div className={styles.priorityGlobal}>
                    <PriorityCard data={priority} />
                    <GlobalCard data={global} />
                  </div>

                  <BucketStrip data={buckets} />

                  <OngoingZeroClick
                    items={ongoing}
                    emptyLabel={
                      surfaceState === 'zero-results'
                        ? 'No ONGOING items match the current filters.'
                        : 'No ONGOING work.'
                    }
                  />

                  <LowerPanels data={lower} />
                </>
              ) : null}
            </>
          )}
        </>
      )}
    </div>
  )
}
