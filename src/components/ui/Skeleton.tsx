import type { HTMLAttributes, CSSProperties } from 'react'
import { cx } from './cx'
import styles from './Skeleton.module.css'

export interface SkeletonProps extends HTMLAttributes<HTMLSpanElement> {
  width?: number | string
  height?: number | string
  circle?: boolean
  text?: boolean
}

export function Skeleton({
  width,
  height = 12,
  circle = false,
  text = false,
  className,
  style,
  ...rest
}: SkeletonProps) {
  const dim: CSSProperties = {
    width: width == null ? (circle ? height : '100%') : width,
    height,
    ...style,
  }
  return (
    <span
      className={cx(
        styles.root,
        circle && styles.circle,
        text && styles.text,
        className,
      )}
      style={dim}
      aria-hidden="true"
      {...rest}
    />
  )
}
