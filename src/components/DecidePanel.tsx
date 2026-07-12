import { useState } from 'react'
import type { Decision } from '#/lib/types'
import { useDecideDecision } from '#/lib/board-query'

export function DecidePanel({ decision }: { decision: Decision }) {
  const decide = useDecideDecision()
  const [text, setText] = useState('')
  const opsi = decision.opsi ?? []

  return (
    <div className="decide">
      <h4>
        {decision.id} — needs a decision
      </h4>
      <p className="d-q">{decision.teks}</p>

      {opsi.length > 0 ? (
        <div className="decide-opts">
          {opsi.map((opt) => (
            <button
              key={opt.key}
              type="button"
              className={opt.rekomendasi ? 'decide-opt rec' : 'decide-opt'}
              disabled={decide.isPending}
              onClick={() =>
                decide.mutate({ id: decision.id, answer: opt.key, keputusan: opt.label })
              }
            >
              {opt.label}
            </button>
          ))}
        </div>
      ) : (
        <div className="decide-opts">
          <input
            className="field"
            placeholder="Your answer…"
            value={text}
            disabled={decide.isPending}
            onChange={(e) => setText(e.target.value)}
          />
          <button
            type="button"
            className="btn"
            disabled={decide.isPending || text.trim() === ''}
            onClick={() =>
              decide.mutate({ id: decision.id, answer: text.trim(), keputusan: text.trim() })
            }
          >
            Resolve
          </button>
        </div>
      )}
    </div>
  )
}
