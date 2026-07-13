import { Icon } from '#/lib/icons'
import type { WorkStaleOverlaySummary } from './types'
import styles from './work.module.css'

export interface StaleOverlayFilterProps {
  active: boolean
  summary?: WorkStaleOverlaySummary | null
  onChange?: (active: boolean) => void
  disabled?: boolean
}

/**
 * STALE is an overlay filter/chip — never a seventh primary bucket tab
 * (UI_CONTRACT §6, ARCHITECTURE §9.1).
 */
export function StaleOverlayFilter({
  active,
  summary,
  onChange,
  disabled = false,
}: StaleOverlayFilterProps) {
  const total = summary?.total
  const label =
    typeof total === 'number' ? `Stale overlay (${total})` : 'Stale overlay'

  return (
    <button
      type="button"
      role="switch"
      aria-checked={active}
      aria-label={label}
      data-testid="work-stale-overlay"
      disabled={disabled}
      className={[styles.staleChip, active ? styles.staleChipActive : '']
        .filter(Boolean)
        .join(' ')}
      onClick={() => onChange?.(!active)}
    >
      <Icon name="alert" size={14} />
      <span>STALE</span>
      {typeof total === 'number' ? (
        <span className={styles.tabCount} aria-hidden="true">
          {total}
        </span>
      ) : null}
    </button>
  )
}
