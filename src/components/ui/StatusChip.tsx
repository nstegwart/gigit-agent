import type { HTMLAttributes, ReactNode } from 'react'
import { cx } from './cx'
import styles from './StatusChip.module.css'

/** Semantic status only — SPEC §1.1. */
export type StatusChipVariant =
  | 'done'
  | 'ongoing'
  | 'warn'
  | 'blocked'
  | 'pending'
  | 'next'

export interface StatusChipProps extends HTMLAttributes<HTMLSpanElement> {
  variant?: StatusChipVariant
  showDot?: boolean
  children: ReactNode
}

export function StatusChip({
  variant = 'pending',
  showDot = true,
  className,
  children,
  ...rest
}: StatusChipProps) {
  return (
    <span className={cx(styles.chip, styles[variant], className)} {...rest}>
      {showDot ? <span className={styles.dot} aria-hidden="true" /> : null}
      {children}
    </span>
  )
}
