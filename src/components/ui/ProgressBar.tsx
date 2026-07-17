import type { HTMLAttributes, ReactNode } from 'react'
import { cx } from './cx'
import styles from './ProgressBar.module.css'

export interface ProgressBarProps extends HTMLAttributes<HTMLDivElement> {
  /** Completed count (x). */
  value: number
  /** Total (y). When 0, bar is empty. */
  max: number
  /** Override right label; default `x/y (z%)`. */
  label?: ReactNode
  ok?: boolean
}

export function ProgressBar({
  value,
  max,
  label,
  ok = false,
  className,
  ...rest
}: ProgressBarProps) {
  const safeMax = Number.isFinite(max) && max > 0 ? max : 0
  const safeVal = Number.isFinite(value) ? Math.max(0, value) : 0
  const pct = safeMax === 0 ? 0 : Math.min(100, Math.round((safeVal / safeMax) * 100))
  const defaultLabel = `${safeVal}/${safeMax} (${pct}%)`
  return (
    <div
      className={cx(styles.root, className)}
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={safeMax || 100}
      aria-valuenow={safeVal}
      aria-valuetext={typeof label === 'string' ? label : defaultLabel}
      {...rest}
    >
      <div className={styles.track}>
        <div
          className={cx(styles.fill, ok && styles.fillOk)}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className={styles.label}>{label ?? defaultLabel}</span>
    </div>
  )
}
