import type {
  ButtonHTMLAttributes,
  HTMLAttributes,
  ReactNode,
} from 'react'
import { cx } from '#/components/ui'
import styles from './page-stack.module.css'

export interface PageStackProps extends HTMLAttributes<HTMLDivElement> {
  children?: ReactNode
}

/** Vertical content stack for AppShell main — Direction B spacing. */
export function PageStack({ className, children, ...rest }: PageStackProps) {
  return (
    <div className={cx(styles.root, className)} {...rest}>
      {children}
    </div>
  )
}

export function KpiRow({
  className,
  children,
  ...rest
}: HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cx(styles.kpiRow, className)} {...rest}>
      {children}
    </div>
  )
}

export function ToolbarSlot({
  className,
  children,
  ...rest
}: HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cx(styles.toolbarSlot, className)} {...rest}>
      {children}
    </div>
  )
}

export function PagerSlot({
  className,
  children,
  ...rest
}: HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cx(styles.pagerSlot, className)} {...rest}>
      {children}
    </div>
  )
}

export function FilterSep({
  className,
  ...rest
}: HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      className={cx(styles.filterSep, className)}
      aria-hidden="true"
      {...rest}
    />
  )
}

export function SubtitleRow({
  className,
  children,
  ...rest
}: HTMLAttributes<HTMLSpanElement>) {
  return (
    <span className={cx(styles.subtitleRow, className)} {...rest}>
      {children}
    </span>
  )
}

export function DetailGrid({
  className,
  children,
  ...rest
}: HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cx(styles.grid2, className)} {...rest}>
      {children}
    </div>
  )
}

export function DetailCol({
  className,
  children,
  ...rest
}: HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cx(styles.col, className)} {...rest}>
      {children}
    </div>
  )
}

export function Stack({
  className,
  children,
  ...rest
}: HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cx(styles.stack, className)} {...rest}>
      {children}
    </div>
  )
}

export function BodyText({
  className,
  children,
  ...rest
}: HTMLAttributes<HTMLParagraphElement>) {
  return (
    <p className={cx(styles.bodyText, className)} {...rest}>
      {children}
    </p>
  )
}

export function MetaRow({
  label,
  children,
  className,
}: {
  label: string
  children: ReactNode
  className?: string
}) {
  return (
    <div className={cx(styles.metaRow, className)}>
      <span className={styles.metaKey}>{label}</span>
      <span className={styles.metaVal}>{children}</span>
    </div>
  )
}

export function ChipRow({
  className,
  children,
  ...rest
}: HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cx(styles.chipRow, className)} {...rest}>
      {children}
    </div>
  )
}

/** Class for BoardLink / anchors that wrap chips (no underline). */
export const depLinkClassName = styles.depLink

export function TechDl({
  className,
  children,
  ...rest
}: HTMLAttributes<HTMLDListElement>) {
  return (
    <dl className={cx(styles.techDl, className)} {...rest}>
      {children}
    </dl>
  )
}

export function MonoCode({
  className,
  children,
  ...rest
}: HTMLAttributes<HTMLElement>) {
  return (
    <code className={cx(styles.mono, className)} {...rest}>
      {children}
    </code>
  )
}

export function TaskRowLink({
  className,
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button type="button" className={cx(styles.rowLink, className)} {...rest}>
      {children}
    </button>
  )
}

export function TaskTitle({
  className,
  children,
  ...rest
}: HTMLAttributes<HTMLSpanElement>) {
  return (
    <span className={cx(styles.taskTitle, className)} {...rest}>
      {children}
    </span>
  )
}

export function TaskMeta({
  className,
  children,
  ...rest
}: HTMLAttributes<HTMLSpanElement>) {
  return (
    <span className={cx(styles.taskMeta, className)} {...rest}>
      {children}
    </span>
  )
}

export function DomainHint({
  className,
  children,
  ...rest
}: HTMLAttributes<HTMLSpanElement>) {
  return (
    <span className={cx(styles.domainHint, className)} {...rest}>
      {children}
    </span>
  )
}

export function StageCell({
  className,
  children,
  ...rest
}: HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cx(styles.stageCell, className)} {...rest}>
      {children}
    </div>
  )
}

export function BlockedHint({
  className,
  children,
  ...rest
}: HTMLAttributes<HTMLSpanElement>) {
  return (
    <span className={cx(styles.blockedHint, className)} {...rest}>
      {children}
    </span>
  )
}

export function NextGate({
  className,
  children,
  ...rest
}: HTMLAttributes<HTMLSpanElement>) {
  return (
    <span className={cx(styles.nextGate, className)} {...rest}>
      {children}
    </span>
  )
}

export function DateCell({
  className,
  children,
  ...rest
}: HTMLAttributes<HTMLSpanElement>) {
  return (
    <span className={cx(styles.date, className)} {...rest}>
      {children}
    </span>
  )
}

export function Na({
  className,
  children = '—',
  ...rest
}: HTMLAttributes<HTMLSpanElement>) {
  return (
    <span className={cx(styles.na, className)} {...rest}>
      {children}
    </span>
  )
}
