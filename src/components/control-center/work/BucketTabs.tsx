import { useCallback, useId, useRef, type KeyboardEvent } from 'react'
import { Icon } from '#/lib/icons'
import type { PrimaryBucket } from '#/lib/control-plane-types'
import { BUCKET_SEMANTICS } from './labels'
import { WORK_PRIMARY_BUCKETS, type WorkBucketCounts } from './types'
import styles from './work.module.css'

type BucketSemanticTone = (typeof BUCKET_SEMANTICS)[PrimaryBucket]['tone']

const TONE_CLASS: Record<BucketSemanticTone, string> = {
  done: styles.toneDone,
  recon: styles.toneRecon,
  ongoing: styles.toneOngoing,
  next: styles.toneNext,
  queued: styles.toneQueued,
  blocked: styles.toneBlocked,
}

export interface BucketTabsProps {
  activeBucket: PrimaryBucket
  counts?: WorkBucketCounts | null
  onChange?: (bucket: PrimaryBucket) => void
  disabled?: boolean
  idPrefix?: string
}

export function BucketTabs({
  activeBucket,
  counts,
  onChange,
  disabled = false,
  idPrefix,
}: BucketTabsProps) {
  const autoId = useId()
  // Sanitize useId() (e.g. ":r1:") so aria-controls IDREFs are always valid.
  const rawPrefix = idPrefix ?? autoId
  const prefix = rawPrefix.replace(/[^A-Za-z0-9_-]/g, '')
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([])

  const focusIndex = useCallback((index: number) => {
    const el = tabRefs.current[index]
    el?.focus()
  }, [])

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
      const last = WORK_PRIMARY_BUCKETS.length - 1
      let next = index
      if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
        event.preventDefault()
        next = index === last ? 0 : index + 1
      } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
        event.preventDefault()
        next = index === 0 ? last : index - 1
      } else if (event.key === 'Home') {
        event.preventDefault()
        next = 0
      } else if (event.key === 'End') {
        event.preventDefault()
        next = last
      } else {
        return
      }
      const bucket = WORK_PRIMARY_BUCKETS[next]
      onChange?.(bucket)
      // focus after selection for roving tabindex
      requestAnimationFrame(() => focusIndex(next))
    },
    [focusIndex, onChange],
  )

  return (
    <div className={styles.tablist} role="tablist" aria-label="Work primary buckets">
      {WORK_PRIMARY_BUCKETS.map((bucket, index) => {
        const sem = BUCKET_SEMANTICS[bucket]
        const selected = bucket === activeBucket
        const count = counts?.[bucket]
        const tabId = `${prefix}-tab-${bucket}`
        const panelId = `${prefix}-panel`
        return (
          <button
            key={bucket}
            ref={(el) => {
              tabRefs.current[index] = el
            }}
            type="button"
            role="tab"
            id={tabId}
            aria-selected={selected}
            aria-controls={panelId}
            tabIndex={selected ? 0 : -1}
            disabled={disabled}
            data-bucket={bucket}
            data-testid={`work-tab-${bucket}`}
            className={[styles.tab, TONE_CLASS[sem.tone], selected ? styles.tabSelected : '']
              .filter(Boolean)
              .join(' ')}
            onClick={() => onChange?.(bucket)}
            onKeyDown={(e) => onKeyDown(e, index)}
          >
            <Icon name={sem.icon} size={14} />
            <span className={styles.tabLabelFull}>{sem.label}</span>
            <span className={styles.tabLabelShort}>{sem.shortLabel}</span>
            {typeof count === 'number' ? (
              <span className={styles.tabCount} aria-label={`${count} items`}>
                {count}
              </span>
            ) : null}
          </button>
        )
      })}
    </div>
  )
}
