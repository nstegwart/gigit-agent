import type { HTMLAttributes, InputHTMLAttributes, ReactNode } from 'react'
import { cx } from './cx'
import styles from './Toolbar.module.css'

export interface ToolbarProps extends HTMLAttributes<HTMLDivElement> {
  searchProps?: InputHTMLAttributes<HTMLInputElement>
  searchIcon?: ReactNode
  filters?: ReactNode
  actions?: ReactNode
}

export function Toolbar({
  searchProps,
  searchIcon,
  filters,
  actions,
  className,
  children,
  ...rest
}: ToolbarProps) {
  const {
    className: searchClassName,
    placeholder = 'Cari…',
    'aria-label': searchAria = 'Cari',
    ...inputRest
  } = searchProps ?? {}

  return (
    <div className={cx(styles.root, className)} role="toolbar" {...rest}>
      {searchProps != null ? (
        <div className={styles.search}>
          {searchIcon != null ? (
            <span className={styles.searchIcon} aria-hidden="true">
              {searchIcon}
            </span>
          ) : null}
          <input
            className={searchClassName}
            placeholder={placeholder}
            aria-label={searchAria}
            {...inputRest}
          />
        </div>
      ) : null}
      {filters != null ? <div className={styles.filters}>{filters}</div> : null}
      {children}
      {actions != null ? <div className={styles.actions}>{actions}</div> : null}
    </div>
  )
}
