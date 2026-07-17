import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { cx } from './cx'
import styles from './IconButton.module.css'

export interface IconButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Accessible name — required (icon-only). */
  'aria-label': string
  size?: 'sm' | 'md'
  variant?: 'default' | 'ghost'
  children: ReactNode
}

export function IconButton({
  size = 'md',
  variant = 'default',
  className,
  type = 'button',
  children,
  ...rest
}: IconButtonProps) {
  return (
    <button
      type={type}
      className={cx(
        styles.iconBtn,
        size === 'sm' && styles.sm,
        variant === 'ghost' && styles.ghost,
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  )
}
