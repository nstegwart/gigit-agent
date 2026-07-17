import type { HTMLAttributes, ReactNode } from 'react'
import { cx } from './cx'
import styles from './KpiStat.module.css'

export interface KpiStatProps extends HTMLAttributes<HTMLDivElement> {
  value: ReactNode
  label: ReactNode
  hint?: ReactNode
  size?: 'sm' | 'md'
}

export function KpiStat({
  value,
  label,
  hint,
  size = 'md',
  className,
  ...rest
}: KpiStatProps) {
  return (
    <div className={cx(styles.root, size === 'sm' && styles.sm, className)} {...rest}>
      {/* Label first in DOM (scan order + a11y); value remains the visual focus via type scale. */}
      <div className={styles.label}>{label}</div>
      <div className={styles.value}>{value}</div>
      {hint != null ? <div className={styles.hint}>{hint}</div> : null}
    </div>
  )
}
