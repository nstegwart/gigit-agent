import type { HTMLAttributes, ReactNode } from 'react'
import { cx } from './cx'
import styles from './Card.module.css'

export interface CardProps
  extends Omit<HTMLAttributes<HTMLElement>, 'title'> {
  as?: 'section' | 'div' | 'article'
  variant?: 'card' | 'panel'
  title?: ReactNode
  subtitle?: ReactNode
  headerActions?: ReactNode
  footer?: ReactNode
  /** When true, body has no padding (tables). */
  flush?: boolean
  children?: ReactNode
}

export function Card({
  as: Tag = 'section',
  variant = 'card',
  title,
  subtitle,
  headerActions,
  footer,
  flush = false,
  className,
  children,
  ...rest
}: CardProps) {
  const hasHeader = title != null || subtitle != null || headerActions != null
  return (
    <Tag
      className={cx(
        styles.card,
        variant === 'panel' && styles.panel,
        flush && styles.paddedNone,
        className,
      )}
      {...rest}
    >
      {hasHeader ? (
        <div className={styles.header}>
          <div>
            {title != null ? (
              <h2 className={styles.title}>{title}</h2>
            ) : null}
            {subtitle != null ? (
              <p className={styles.subtitle}>{subtitle}</p>
            ) : null}
          </div>
          {headerActions}
        </div>
      ) : null}
      {children != null ? <div className={styles.body}>{children}</div> : null}
      {footer != null ? <div className={styles.footer}>{footer}</div> : null}
    </Tag>
  )
}

/** Alias for denser chrome regions. */
export function Panel(props: CardProps) {
  return <Card {...props} variant="panel" />
}
