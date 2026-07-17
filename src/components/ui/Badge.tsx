import type { HTMLAttributes, ReactNode } from 'react'
import { cx } from './cx'
import styles from './Badge.module.css'

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  variant?: 'neutral' | 'brand'
  mono?: boolean
  children: ReactNode
}

export function Badge({
  variant = 'neutral',
  mono = false,
  className,
  children,
  ...rest
}: BadgeProps) {
  return (
    <span
      className={cx(
        styles.badge,
        styles[variant],
        mono && styles.mono,
        className,
      )}
      {...rest}
    >
      {children}
    </span>
  )
}
