import type { HTMLAttributes, ReactNode } from 'react'
import { cx } from './cx'
import styles from './Breadcrumb.module.css'

export interface BreadcrumbItem {
  label: ReactNode
  href?: string
  onClick?: () => void
}

export interface BreadcrumbProps extends HTMLAttributes<HTMLElement> {
  items: BreadcrumbItem[]
  /** Accessible name. Default id-ID. */
  'aria-label'?: string
}

export function Breadcrumb({
  items,
  className,
  'aria-label': ariaLabel = 'Jelajah',
  ...rest
}: BreadcrumbProps) {
  return (
    <nav className={cx(styles.nav, className)} aria-label={ariaLabel} {...rest}>
      <ol className={styles.list}>
        {items.map((item, index) => {
          const last = index === items.length - 1
          return (
            <li key={index} className={styles.item}>
              {index > 0 ? (
                <span className={styles.sep} aria-hidden="true">
                  /
                </span>
              ) : null}{' '}
              {last || (!item.href && !item.onClick) ? (
                <span className={styles.current} aria-current={last ? 'page' : undefined}>
                  {item.label}
                </span>
              ) : item.href ? (
                <a className={styles.link} href={item.href} onClick={item.onClick}>
                  {item.label}
                </a>
              ) : (
                <button type="button" className={styles.link} onClick={item.onClick}>
                  {item.label}
                </button>
              )}
            </li>
          )
        })}
      </ol>
    </nav>
  )
}
