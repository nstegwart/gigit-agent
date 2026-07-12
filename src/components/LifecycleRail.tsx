// Delivery lifecycle for a task — the board's configurable rail (mapping → delivery),
// current stage, and the gated-transition history. Makes clear that "mapping complete"
// is a stage, NOT a finished task. Stage only advances via advance_task (evidence/verifier).
import { Fragment } from 'react'
import { useLifecycle, useTaskLifecycle } from '#/lib/board-query'
import { Icon } from '#/lib/icons'
import { fmtDate } from '#/lib/format'
import type { LifecycleHistoryEntry, LifecycleStage } from '#/lib/types'

const tone = (s: LifecycleStage) => `tone-${s.color ?? 'indigo'}`

export function LifecycleRail({ taskId }: { taskId: string }) {
  const cfg = useLifecycle()
  const { data: lc } = useTaskLifecycle(taskId)
  const stages = cfg.stages
  if (!stages.length) return null
  const current = lc?.stage ?? stages[0].key
  const curIdx = Math.max(0, stages.findIndex((s) => s.key === current))
  const cur = stages[curIdx]
  const history = (((lc?.lifecycle as { history?: Array<LifecycleHistoryEntry> } | null)?.history) ?? []) as Array<LifecycleHistoryEntry>
  const inMapping = (cur.group ?? '').toLowerCase() === 'mapping'

  return (
    <section className="section">
      <div className="sec-head">
        <Icon name="branch" className="nav-ico" />
        <h2>Delivery lifecycle</h2>
        <span className="desc">stage advances only via evidence / verifier receipts</span>
      </div>

      <div className="rail">
        {stages.map((s, i) => {
          const state = i < curIdx ? 'done' : i === curIdx ? 'current' : 'todo'
          const groupBreak = i > 0 && (s.group ?? '') !== (stages[i - 1].group ?? '')
          return (
            <Fragment key={s.key}>
              {groupBreak ? <span className="rail-div" title={s.group ?? ''} /> : null}
              <div className={`rail-step ${tone(s)} is-${state}`}>
                <span className="rail-dot">{state === 'done' ? <Icon name="check" size={11} /> : null}</span>
                <span className="rail-name">{s.label}</span>
                {s.gated ? <Icon name="lock" size={9} className="rail-lock" /> : null}
              </div>
            </Fragment>
          )
        })}
      </div>

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
