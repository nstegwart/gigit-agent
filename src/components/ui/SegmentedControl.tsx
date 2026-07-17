import type { HTMLAttributes, ReactNode } from 'react'
import { cx } from './cx'
import styles from './SegmentedControl.module.css'

export interface SegmentedOption {
  value: string
  label: ReactNode
  disabled?: boolean
}

export interface SegmentedControlProps
  extends Omit<HTMLAttributes<HTMLDivElement>, 'onChange'> {
  options: SegmentedOption[]
  value: string
  onChange: (value: string) => void
  'aria-label'?: string
}

export function SegmentedControl({
  options,
  value,
  onChange,
  className,
  'aria-label': ariaLabel = 'Pilihan',
  ...rest
}: SegmentedControlProps) {
  return (
    <div
      className={cx(styles.root, className)}
      role="radiogroup"
      aria-label={ariaLabel}
      {...rest}
    >
      {options.map((opt) => {
        const selected = opt.value === value
        return (
          <button
            key={opt.value}
            type="button"
            role="radio"
            aria-checked={selected}
            disabled={opt.disabled}
            className={cx(styles.option, selected && styles.active)}
            onClick={() => onChange(opt.value)}
          >
            {opt.label}
          </button>
        )
      })}
    </div>
  )
}
