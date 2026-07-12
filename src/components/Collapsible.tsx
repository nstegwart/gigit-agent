import { useState, type ReactNode } from 'react'

import { Icon } from '#/lib/icons'

/** A section whose body can be folded. Header matches the .sec-head look. */
export function Collapsible({
  title,
  count,
  defaultOpen = true,
  right,
  children,
}: {
  title: string
  count?: number
  defaultOpen?: boolean
  right?: ReactNode
  children: ReactNode
}) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <section className="section">
      <button
        type="button"
        className="sec-head collapsible-head"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <Icon name="chevL" size={15} className={`collapse-caret ${open ? 'open' : ''}`} />
        <h2>{title}</h2>
        {count != null ? <span className="count">{count}</span> : null}
        {right ? <span style={{ marginLeft: 'auto' }}>{right}</span> : null}
      </button>
      {open ? <div className="collapsible-body">{children}</div> : null}
    </section>
  )
}
