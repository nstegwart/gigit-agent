import type { HTMLAttributes, ReactNode } from 'react'
import { cx } from './cx'
import styles from './EmptyState.module.css'

export interface EmptyStateProps
  extends Omit<HTMLAttributes<HTMLDivElement>, 'title'> {
  icon?: ReactNode
  title: ReactNode
  description?: ReactNode
  action?: ReactNode
}

export function EmptyState({
  icon,
  title,
  description,
  action,
  className,
  ...rest
}: EmptyStateProps) {
  return (
    <div className={cx(styles.root, className)} role="status" {...rest}>
      {icon != null ? <div className={styles.icon}>{icon}</div> : null}
      <h3 className={styles.title}>{title}</h3>
      {description != null ? (
        <p className={styles.description}>{description}</p>
      ) : null}
      {action != null ? <div className={styles.action}>{action}</div> : null}
    </div>
  )
}
