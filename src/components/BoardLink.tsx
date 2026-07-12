// Board-scoped Link. Write board-relative targets (to="/features/$featureId") and this
// injects the current boardId + the /b/$boardId prefix. Lets every component link without
// threading boardId. (Trades some of Router's link type-safety for far less churn.)
import { Link, useParams } from '@tanstack/react-router'
import type { ComponentProps, ReactNode } from 'react'

type Props = {
  to: string
  params?: Record<string, unknown>
  children?: ReactNode
} & Omit<ComponentProps<'a'>, 'href' | 'children'>

export function BoardLink({ to, params, children, ...rest }: Props) {
  const p = useParams({ strict: false }) as { boardId?: string }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const linkProps = {
    to: `/b/$boardId${to}`,
    params: { boardId: p.boardId, ...(params ?? {}) },
  } as any
  return (
    <Link {...linkProps} {...rest}>
      {children}
    </Link>
  )
}
