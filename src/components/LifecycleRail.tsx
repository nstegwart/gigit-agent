// The task's PRIMARY progress = the whole delivery path (§4 of the readiness
// contract), not the M01–M20 mapping alone. Header (ready%, proven stage, next
// gate, required proof) + a vertical stage timeline with per-stage readiness %,
// and the mapping checklist nested under the "mapping" stage. Stages are
// engine/receipt-gated — clicking a non-gated stage advances it (human).
import { useState } from 'react'
import { useAdvanceTask, useLifecycle, useTaskLifecycle } from '#/lib/board-query'
import { nextEvidence, resolvedReadiness } from '#/lib/readiness'
import { Icon } from '#/lib/icons'
import { fmtDate } from '#/lib/format'
import type { LifecycleHistoryEntry, LifecycleStage, TaskCheckpoint } from '#/lib/types'

const tone = (s: LifecycleStage) => `tone-${s.color ?? 'indigo'}`

export function LifecycleRail({ taskId, checkpoints }: { taskId: string; checkpoints?: Array<TaskCheckpoint> }) {
  const cfg = useLifecycle()
  const { data: lc } = useTaskLifecycle(taskId)
  const advance = useAdvanceTask()
  const [err, setErr] = useState<string | null>(null)
  const [showCk, setShowCk] = useState(false)
  const [openRows, setOpenRows] = useState<Set<string>>(new Set())
  const stages = cfg.stages
  if (!stages.length) return null

  const readiness = resolvedReadiness(cfg)
  const current = lc?.stage ?? null
  const curIdx = current ? stages.findIndex((s) => s.key === current) : -1
  const ns = stages[curIdx + 1] ?? null
  const proof = nextEvidence(cfg, current)
  const readyPct = current ? readiness[current] ?? 0 : 0
  const milestoneIdx = (() => {
    const mi = stages.findIndex((s) => s.milestone)
    if (mi >= 0) return mi
    const ri = stages.findIndex((s) => (readiness[s.key] ?? 0) >= 100)
    return ri >= 0 ? ri : stages.length - 1
  })()
  const lastMappingIdx = stages.map((s, i) => ((s.group ?? '').toLowerCase() === 'mapping' ? i : -1)).filter((i) => i >= 0).pop() ?? -1
  // nest the M/R checklist under the CURRENT mapping stage ("Mapping complete"), else the last mapping stage
  const mappingIdx = curIdx >= 0 && (stages[curIdx].group ?? '').toLowerCase() === 'mapping' ? curIdx : lastMappingIdx
  const history = (((lc?.lifecycle as { history?: Array<LifecycleHistoryEntry> } | null)?.history) ?? []) as Array<LifecycleHistoryEntry>
  const ckDone = (checkpoints ?? []).filter((c) => c.done).length
  const ckTotal = (checkpoints ?? []).length

  const move = (toStage: string) => {
    setErr(null)
    advance.mutate({ taskId, toStage, byRunId: 'human', expectedRev: lc?.rev }, { onError: (e) => setErr(e instanceof Error ? e.message : String(e)) })
  }

  return (
    <section className="section">
      <div className="sec-head">
        <Icon name="branch" className="nav-ico" />
        <h2>Ready-production</h2>
        <span className="desc">stage advances only via evidence / verifier receipts</span>
      </div>

      <div className="rp-head">
        <div className="rp-pct"><b>{readyPct}%</b><span>ready-production</span></div>
        <div className="rp-facts">
          <div><span className="rp-k">Proven stage</span><span className="rp-v">{current ?? 'uninitialized'}</span></div>
          <div><span className="rp-k">Next gate</span><span className="rp-v">{ns?.key ?? '— (at ceiling)'}</span></div>
          <div><span className="rp-k">Required proof</span><span className="rp-v">{proof.length ? proof.join(', ') : '—'}</span></div>
        </div>
      </div>

      <div className="rail">
        {stages.map((s, i) => {
          const state = i < curIdx ? 'done' : i === curIdx ? 'current' : 'todo'
          const clickable = i !== curIdx && !s.gated && !advance.isPending
          const isLive = i > milestoneIdx && (readiness[s.key] ?? 0) >= 100
          const pctLabel = isLive ? 'LIVE' : `${readiness[s.key] ?? 0}%`
          const stageHist = history.filter((h) => h.stage === s.key)
          const req = [...(s.requiresEvidence ?? []), ...(s.verifierRole ? [`${s.verifierRole} verdict`] : [])]
          const hasDetail = !clickable && (req.length > 0 || stageHist.length > 0)
          const cls = `rail-step ${tone(s)} is-${state}${clickable ? ' is-click' : ''}${hasDetail ? ' is-click' : ''}${s.gated && i !== curIdx ? ' is-gated' : ''}`
          const inner = (
            <>
              <span className="rail-dot">{state === 'done' ? <Icon name="check" size={11} /> : null}</span>
              <span className="rail-name">{s.label}{s.gated ? <Icon name="lock" size={11} className="rail-lock" /> : null}</span>
              <span className={`rail-pct ${isLive ? 'is-live' : ''}`}>{pctLabel}</span>
            </>
          )
          return (
            <div key={s.key}>
              {clickable ? (
                <button type="button" className={cls} onClick={() => move(s.key)} title={`Move to ${s.label}`}>{inner}</button>
              ) : hasDetail ? (
                <button type="button" className={cls} onClick={() => setOpenRows((p) => { const n = new Set(p); if (n.has(s.key)) n.delete(s.key); else n.add(s.key); return n })}>{inner}</button>
              ) : (
                <div className={cls}>{inner}</div>
              )}
              {hasDetail && openRows.has(s.key) ? (
                <div className="rail-detail">
                  {req.length ? <div className="rail-req">Required proof: {req.join(', ')}</div> : null}
                  {i > curIdx && s.gated ? <div className="rail-lockreason"><Icon name="lock" size={11} /> Locked — advance from {stages[i - 1]?.label ?? '—'} with a program-emitted receipt (advance_task)</div> : null}
                  {stageHist.map((h, hi) => (
                    <div className="rail-hist" key={hi}>
                      {h.verdict ? <span className="lc-verdict">{h.verdict}</span> : null}
                      {h.byRunId ? <span className="lc-run">{h.byRunId}</span> : null}
                      {h.commitSha ? <span className="chip chip-mono">{h.commitSha.slice(0, 10)}</span> : null}
                      <span className="lc-ts">{fmtDate(h.ts)}</span>
                    </div>
                  ))}
                </div>
              ) : null}
              {i === mappingIdx && ckTotal ? (
                <div className="rail-nest">
                  <button type="button" className="rail-nest-head" onClick={() => setShowCk((v) => !v)}>
                    <Icon name="chevL" size={12} className={`collapse-caret ${showCk ? 'open' : ''}`} />
                    {s.label} — {ckDone}/{ckTotal} · {readiness[s.key] ?? 0}% ready-production
                  </button>
                  {showCk ? (
                    <div className="rail-ck">
                      {(checkpoints ?? []).map((c) => (
                        <div className={`ts-check-item ${c.done ? 'done' : ''}`} key={c.id}>
                          <span className="ts-box">{c.done ? <Icon name="check" size={10} /> : null}</span>
                          <span className="ts-check-label">{c.label}</span>
                          {c.category ? <span className="cp-cat">{c.category}</span> : null}
                        </div>
                      ))}
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>
          )
        })}
      </div>
      {err ? <p className="rail-err"><Icon name="alert" size={13} /> {err}</p> : null}

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
