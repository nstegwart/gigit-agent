// Delivery lifecycle for a task — the board's configurable rail (mapping → delivery),
// current stage, and the gated-transition history. Makes clear that "mapping complete"
// is a stage, NOT a finished task. Stage only advances via advance_task (evidence/verifier).
import { useState } from 'react'
import { useAdvanceTask, useLifecycle, useTaskLifecycle } from '#/lib/board-query'
import { Icon } from '#/lib/icons'
import { fmtDate } from '#/lib/format'
import type { LifecycleHistoryEntry, LifecycleStage } from '#/lib/types'

const tone = (s: LifecycleStage) => `tone-${s.color ?? 'indigo'}`

export function LifecycleRail({ taskId }: { taskId: string }) {
  const cfg = useLifecycle()
  const { data: lc } = useTaskLifecycle(taskId)
  const advance = useAdvanceTask()
  const [err, setErr] = useState<string | null>(null)
  const stages = cfg.stages
  if (!stages.length) return null
  const current = lc?.stage ?? stages[0].key
  const curIdx = Math.max(0, stages.findIndex((s) => s.key === current))
  const cur = stages[curIdx]
  const history = (((lc?.lifecycle as { history?: Array<LifecycleHistoryEntry> } | null)?.history) ?? []) as Array<LifecycleHistoryEntry>
  const inMapping = (cur.group ?? '').toLowerCase() === 'mapping'

  const move = (toStage: string) => {
    setErr(null)
    advance.mutate(
      { taskId, toStage, byRunId: 'human', expectedRev: lc?.rev },
      { onError: (e) => setErr(e instanceof Error ? e.message : String(e)) },
    )
  }

  return (
    <section className="section">
      <div className="sec-head">
        <Icon name="branch" className="nav-ico" />
        <h2>Delivery lifecycle</h2>
        <span className="desc">click a non-gated stage to move · gated stages need an agent receipt</span>
      </div>

      <div className="rail">
        {stages.map((s, i) => {
          const state = i < curIdx ? 'done' : i === curIdx ? 'current' : 'todo'
          const clickable = i !== curIdx && !s.gated && !advance.isPending
          const cls = `rail-step ${tone(s)} is-${state}${clickable ? ' is-click' : ''}${s.gated && i !== curIdx ? ' is-gated' : ''}`
          const inner = (
            <>
              <span className="rail-dot">{state === 'done' ? <Icon name="check" size={11} /> : null}</span>
              <span className="rail-name">
                {s.label}
                {s.gated ? <Icon name="lock" size={11} className="rail-lock" /> : null}
              </span>
            </>
          )
          return clickable ? (
            <button key={s.key} type="button" className={cls} onClick={() => move(s.key)} title={`Move to ${s.label}`}>{inner}</button>
          ) : (
            <div key={s.key} className={cls} title={s.gated ? 'gated — advance via advance_task with a receipt' : undefined}>{inner}</div>
          )
        })}
      </div>
      {err ? <p className="rail-err"><Icon name="alert" size={13} /> {err}</p> : null}

      {inMapping ? (
        <p className="rail-note">
          <Icon name="alert" size={13} /> Mapping structurally complete — delivery not started. Checkpoints below are the
          mapping contract, not a shipped task.
        </p>
      ) : null}

      {history.length ? (
        <div className="lc-history">
          {[...history].reverse().map((h, i) => (
            <div className="lc-entry" key={i}>
              <span className="lc-stage">{h.stage}</span>
              {h.verdict ? <span className="lc-verdict">{h.verdict}</span> : null}
              {h.byRunId ? <span className="lc-run">{h.byRunId}{h.role ? ` · ${h.role}` : ''}</span> : null}
              {h.commitSha ? <span className="chip chip-mono">{h.commitSha.slice(0, 10)}</span> : null}
              {h.deployReceipt ? <span className="chip chip-mono">deploy ✓</span> : null}
              <span className="lc-ts">{fmtDate(h.ts)}</span>
            </div>
          ))}
        </div>
      ) : null}
    </section>
  )
}
