// Comment thread for a feature — render existing comments + a form to add one.
import { useState } from 'react'

import { useAddComment, useCanEdit } from '#/lib/board-query'
import { fmtDate } from '#/lib/format'
import type { Feature } from '#/lib/types'

export function CommentThread({ feature }: { feature: Feature }) {
  const [text, setText] = useState('')
  const add = useAddComment()
  const canEdit = useCanEdit()

  function submit() {
    const trimmed = text.trim()
    if (!trimmed || add.isPending) return
    add.mutate({ featureId: feature.id, author: 'you', authorType: 'human', text: trimmed })
    setText('')
  }

  return (
    <div>
      {feature.comments.length === 0 ? (
        <p style={{ color: 'var(--text-dim)', fontSize: 13 }}>No comments yet.</p>
      ) : (
        feature.comments.map((c) => (
          <div className="comment" key={c.id}>
            <div>
              <div className="c-head">
                <span className="c-author">{c.author}</span>
                <span className={`who who-${c.authorType}`}>{c.authorType}</span>
                <span className="c-when">{fmtDate(c.ts)}</span>
              </div>
              <div className="c-text">{c.text}</div>
            </div>
          </div>
        ))
      )}
      {canEdit ? (
        <div className="comment-form">
          <input
            className="field"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Add a comment…"
            disabled={add.isPending}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submit()
            }}
          />
          <button className="btn" onClick={submit} disabled={add.isPending || !text.trim()}>
            Comment
          </button>
        </div>
      ) : null}
    </div>
  )
}
