// Design links list (project or feature scope) + inline "add link" form.
import { useState } from 'react'

import { Icon } from '#/lib/icons'
import { useAddDesignLink, useCanEdit } from '#/lib/board-query'
import type { FeatureLink } from '#/lib/types'

export function DesignLinks({
  scope,
  id,
  links,
}: {
  scope: 'project' | 'feature'
  id: string
  links: Array<FeatureLink>
}) {
  const add = useAddDesignLink()
  const canEdit = useCanEdit()
  const [url, setUrl] = useState('')
  const [label, setLabel] = useState('')

  const submit = () => {
    const trimmedUrl = url.trim()
    if (!trimmedUrl) return
    const trimmedLabel = label.trim()
    add.mutate(
      { scope, id, url: trimmedUrl, label: trimmedLabel || undefined },
      {
        onSuccess: () => {
          setUrl('')
          setLabel('')
        },
      },
    )
  }

  return (
    <div>
      {links.length > 0 && (
        <div className="link-list">
          {links.map((l, i) => (
            <a key={`${l.url}-${i}`} href={l.url} target="_blank" rel="noreferrer">
              <Icon name="ext" size={13} />
              {l.label || l.url}
            </a>
          ))}
        </div>
      )}
      {!links.length && !canEdit ? <div className="empty">No design links.</div> : null}
      {canEdit ? (
        <div className="comment-form">
          <input
            className="field"
            placeholder="https://…"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            disabled={add.isPending}
          />
          <input
            className="field"
            placeholder="Label (optional)"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            disabled={add.isPending}
          />
          <button className="btn" onClick={submit} disabled={add.isPending || !url.trim()}>
            Add
          </button>
        </div>
      ) : null}
    </div>
  )
}
