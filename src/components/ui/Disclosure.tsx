import type { DetailsHTMLAttributes, ReactNode } from 'react'
import { cx } from './cx'
import styles from './Disclosure.module.css'

export interface DisclosureProps
  extends DetailsHTMLAttributes<HTMLDetailsElement> {
  summary?: ReactNode
  children: ReactNode
}

/** Collapsible technical detail region. Default summary id-ID. */
export function Disclosure({
  summary = 'Detail teknis',
  className,
  children,
  ...rest
}: DisclosureProps) {
  return (
    <details className={cx(styles.root, className)} {...rest}>
      <summary className={styles.summary}>
        <span className={styles.chev} aria-hidden="true">
          ▶
        </span>
        {summary}
      </summary>
      <div className={styles.body}>{children}</div>
    </details>
  )
}
