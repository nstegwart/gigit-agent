import type { HTMLAttributes, ReactNode } from 'react'
import { cx } from './cx'
import styles from './PageHeader.module.css'

export interface PageHeaderProps
  extends Omit<HTMLAttributes<HTMLElement>, 'title'> {
  title: ReactNode
  subtitle?: ReactNode
  eyebrow?: ReactNode
  breadcrumb?: ReactNode
  actions?: ReactNode
}

export function PageHeader({
  title,
  subtitle,
  eyebrow,
  breadcrumb,
  actions,
  className,
  ...rest
}: PageHeaderProps) {
  return (
    <header className={cx(styles.root, className)} {...rest}>
      <div className={styles.main}>
        {breadcrumb ? <div className={styles.crumbSlot}>{breadcrumb}</div> : null}
        {eyebrow != null ? <p className={styles.eyebrow}>{eyebrow}</p> : null}
        <h1 className={styles.title}>{title}</h1>
        {subtitle != null ? (
          <div className={styles.subtitle}>{subtitle}</div>
        ) : null}
      </div>
      {actions != null ? <div className={styles.actions}>{actions}</div> : null}
    </header>
  )
}
