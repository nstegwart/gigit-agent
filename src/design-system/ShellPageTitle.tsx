/**
 * Sync AppShell sticky topbar h1 (#page-title) for drill-down routes that are
 * not primary CC nav items (e.g. /tasks). Keeps id-ID primary chrome correct
 * without editing AppShell (owned by other packets).
 */
import { useEffect } from 'react'

export interface ShellPageTitleProps {
  /** Full sticky title, e.g. "Tasks · Tugas" or "Tasks · Tugas / judul". */
  title: string
  /** Optional shell subtitle under h1 (control-center only). */
  subtitle?: string
}

export function ShellPageTitle({ title, subtitle }: ShellPageTitleProps) {
  useEffect(() => {
    const h1 = document.getElementById('page-title')
    const prevTitle = h1?.textContent ?? null
    const prevAttr = h1?.getAttribute('title') ?? null
    if (h1) {
      h1.textContent = title
      h1.setAttribute('title', title)
    }

    const subEl = document.querySelector<HTMLElement>(
      '[data-testid="shell-page-subtitle"]',
    )
    const prevSub = subEl?.textContent ?? null
    if (subEl && subtitle != null) {
      subEl.textContent = subtitle
    }

    return () => {
      if (h1) {
        if (prevTitle != null) h1.textContent = prevTitle
        if (prevAttr != null) h1.setAttribute('title', prevAttr)
        else h1.removeAttribute('title')
      }
      if (subEl && prevSub != null) subEl.textContent = prevSub
    }
  }, [title, subtitle])

  return null
}
