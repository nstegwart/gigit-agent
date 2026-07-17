import type { HTMLAttributes, ReactNode } from 'react'
import { cx } from './cx'
import styles from './Tooltip.module.css'

export interface TooltipProps
  extends Omit<HTMLAttributes<HTMLSpanElement>, 'content'> {
  content: ReactNode
  children: ReactNode
}

/** CSS-only hover/focus tooltip — presentational. */
export function Tooltip({ content, children, className, ...rest }: TooltipProps) {
  return (
    <span className={cx(styles.wrap, className)} {...rest}>
      {children}
      <span className={styles.tip} role="tooltip">
        {content}
      </span>
    </span>
  )
}
