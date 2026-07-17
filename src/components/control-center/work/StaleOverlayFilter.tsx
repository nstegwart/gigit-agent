import { Pill } from '#/components/ui'
import type { WorkStaleOverlaySummary } from './types'

export interface StaleOverlayFilterProps {
  active: boolean
  summary?: WorkStaleOverlaySummary | null
  onChange?: (active: boolean) => void
  disabled?: boolean
}

/**
 * STALE is an overlay filter/chip — never a seventh primary bucket tab
 * (UI_CONTRACT §6, ARCHITECTURE §9.1). Direction B: Pill primitive.
 */
export function StaleOverlayFilter({
  active,
  summary,
  onChange,
  disabled = false,
}: StaleOverlayFilterProps) {
  const total = summary?.total
  const label =
    typeof total === 'number'
      ? `Tampilkan data basi (${total})`
      : 'Tampilkan data basi'

  return (
    <Pill
      active={active}
      role="switch"
      aria-checked={active}
      aria-label={label}
      data-testid="work-stale-overlay"
      disabled={disabled}
      onClick={() => onChange?.(!active)}
    >
      Data basi
      {typeof total === 'number' ? ` · ${total}` : ''}
    </Pill>
  )
}
