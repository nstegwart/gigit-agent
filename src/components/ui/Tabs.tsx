import type { HTMLAttributes, ReactNode } from 'react'
import { useId, useState } from 'react'
import { cx } from './cx'
import styles from './Tabs.module.css'

export interface TabItem {
  id: string
  label: ReactNode
  panel: ReactNode
  disabled?: boolean
}

export interface TabsProps extends HTMLAttributes<HTMLDivElement> {
  items: TabItem[]
  value?: string
  defaultValue?: string
  onValueChange?: (id: string) => void
}

export function Tabs({
  items,
  value,
  defaultValue,
  onValueChange,
  className,
  ...rest
}: TabsProps) {
  const reactId = useId()
  const [uncontrolled, setUncontrolled] = useState(
    defaultValue ?? items[0]?.id ?? '',
  )
  const active = value ?? uncontrolled
  const setActive = (id: string) => {
    if (value == null) setUncontrolled(id)
    onValueChange?.(id)
  }
  const activeItem = items.find((item) => item.id === active) ?? items[0]

  return (
    <div className={cx(styles.root, className)} {...rest}>
      <div className={styles.list} role="tablist">
        {items.map((item) => {
          const selected = item.id === activeItem?.id
          return (
            <button
              key={item.id}
              type="button"
              role="tab"
              id={`${reactId}-tab-${item.id}`}
              aria-selected={selected}
              aria-controls={`${reactId}-panel-${item.id}`}
              tabIndex={selected ? 0 : -1}
              disabled={item.disabled}
              className={cx(styles.tab, selected && styles.active)}
              onClick={() => setActive(item.id)}
            >
              {item.label}
            </button>
          )
        })}
      </div>
      {activeItem ? (
        <div
          className={styles.panel}
          role="tabpanel"
          id={`${reactId}-panel-${activeItem.id}`}
          aria-labelledby={`${reactId}-tab-${activeItem.id}`}
        >
          {activeItem.panel}
        </div>
      ) : null}
    </div>
  )
}
