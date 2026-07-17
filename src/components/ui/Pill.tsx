import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { cx } from './cx'
import styles from './Pill.module.css'

export interface PillProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  active?: boolean
  children: ReactNode
}

/** Filter pill — presentational toggle chrome only. */
export function Pill({
  active = false,
  className,
  type = 'button',
  children,
  ...rest
}: PillProps) {
  return (
    <button
      type={type}
      className={cx(styles.pill, active && styles.active, className)}
      aria-pressed={active}
      {...rest}
    >
      {children}
    </button>
  )
}
