// The task's PRIMARY progress = the whole delivery path (§4 of the readiness
// contract), not the M01–M20 mapping alone. Header (ready%, proven stage, next
// gate, required proof) + a vertical stage timeline with per-stage readiness %,
// and the mapping checklist nested under the "mapping" stage.
//
// Stage advances are V3-only and authority-gated: the UI never fabricates
// owner/human evidence or partial envelopes. Mutation fires only when a
// server/agent-provided complete V3 packet is explicitly supplied.
import { useState } from 'react'
import {
  isCompleteAdvanceV3Packet,
  toAdvancePayload,
  useAdvanceTask,
  useBoardId,
  useCanEdit,
  useLifecycle,
  useTaskLifecycle,
  type AdvanceV3Packet,
} from '#/lib/board-query'
import { deriveCheckpoints, nextEvidence, resolvedReadiness } from '#/lib/readiness'
import { Icon } from '#/lib/icons'
import { fmtDate } from '#/lib/format'
import type { LifecycleHistoryEntry, LifecycleStage, TaskCheckpoint } from '#/lib/types'

const tone = (s: LifecycleStage) => `tone-${s.color ?? 'indigo'}`

/** Owner-readable reason when UI lacks a complete V3 advance packet. */
export const ADVANCE_NEEDS_AGENT_REASON =
  'Stage advance needs a complete agent V3 packet (registered author/verifier runs, entity/board/lifecycle revs, task+canonical hashes, idempotency key, programmatic receipt). Owner UI cannot invent these. Use an agent via Agents / Runs, or open Decision if a human decision is required.'

export type LifecycleRailProps = {
  taskId: string
  checkpoints?: Array<TaskCheckpoint>
  fallbackStage?: string | null
  /**
   * Explicit server/agent-provided V3 advance packet. When missing or incomplete,
   * mutation controls stay disabled (fail-closed). Never fabricate this in UI.
   */
  advancePacket?: AdvanceV3Packet | null
}

export function LifecycleRail({
  taskId,
  checkpoints,
  fallbackStage,
  advancePacket = null,
}: LifecycleRailProps) {
  const boardId = useBoardId()
  const cfg = useLifecycle()
  const canEdit = useCanEdit()
  const { data: lc } = useTaskLifecycle(taskId)
  const advance = useAdvanceTask()
  const [err, setErr] = useState<string | null>(null)
  const [showCk, setShowCk] = useState(false)
  const [openRows, setOpenRows] = useState<Set<string>>(new Set())
  const stages = cfg.stages
  if (!stages.length) return null

  const readiness = resolvedReadiness(cfg)
  const current = lc?.stage ?? fallbackStage ?? null // SSR-safe: fall back to the light summary's stage
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
  const cps = checkpoints ?? []
  const ckTotal = cps.length
  // §2: R01–R20 are readiness milestones — DERIVED from the proven stage (shared with MCP).
  const dc = deriveCheckpoints(readyPct, cps)
  const ckDone = dc.done

  const packetOk =
    isCompleteAdvanceV3Packet(advancePacket) &&
    advancePacket.taskId === taskId
  const agentsHref = boardId ? `/b/${boardId}/agents` : '/login'
  const decisionsHref = boardId ? `/b/${boardId}/decisions` : '/login'

  const move = (toStage: string) => {
    setErr(null)
    // Fail-closed: never call mutation without a complete current V3 packet.
    if (!packetOk || !advancePacket) {
      setErr(ADVANCE_NEEDS_AGENT_REASON)
      return
    }
    try {
      const payload = toAdvancePayload(advancePacket, toStage)
      advance.mutate(payload, {
        onError: (e) => setErr(e instanceof Error ? e.message : String(e)),
      })
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <section className="section" data-testid="lifecycle-rail">
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

      {!packetOk ? (
        <div
          className="rail-needs-agent"
          data-testid="lifecycle-advance-needs-agent"
          role="status"
        >
          <Icon name="lock" size={13} />{' '}
          <span data-testid="lifecycle-advance-needs-agent-reason">{ADVANCE_NEEDS_AGENT_REASON}</span>
          {' '}
          <a href={agentsHref} data-testid="lifecycle-advance-agents-link">
            Agents / Runs
          </a>
          {' · '}
          <a href={decisionsHref} data-testid="lifecycle-advance-decisions-link">
            Decision
          </a>
        </div>
      ) : null}

      <div className="rail">
        {stages.map((s, i) => {
          const state = i < curIdx ? 'done' : i === curIdx ? 'current' : 'todo'
          // Clickable only when admin + complete V3 packet + non-gated + not current.
          const clickable = canEdit && packetOk && i !== curIdx && !s.gated && !advance.isPending
          const isLive = i > milestoneIdx && (readiness[s.key] ?? 0) >= 100
          const pctLabel = isLive ? 'LIVE' : `${readiness[s.key] ?? 0}%`
          const stageHist = history.filter((h) => h.stage === s.key)
          const req = [...(s.requiresEvidence ?? []), ...(s.verifierRole ? [`${s.verifierRole} verdict`] : [])]
          const needsAgentForStage = canEdit && !packetOk && i !== curIdx && !s.gated
          const hasDetail = !clickable && (req.length > 0 || stageHist.length > 0 || needsAgentForStage || (s.gated && i !== curIdx))
          const cls = `rail-step ${tone(s)} is-${state}${clickable ? ' is-click' : ''}${hasDetail ? ' is-click' : ''}${s.gated && i !== curIdx ? ' is-gated' : ''}${needsAgentForStage ? ' is-gated' : ''}`
          const inner = (
            <>
              <span className="rail-dot">{state === 'done' ? <Icon name="check" size={11} /> : null}</span>
              <span className="rail-name">{s.label}{s.gated || needsAgentForStage ? <Icon name="lock" size={11} className="rail-lock" /> : null}</span>
              <span className={`rail-pct ${isLive ? 'is-live' : ''}`}>{pctLabel}</span>
            </>
          )
          return (
            <div key={s.key}>
              {clickable ? (
                <button
                  type="button"
                  className={cls}
                  data-testid={`lifecycle-advance-${s.key}`}
                  onClick={() => move(s.key)}
                  title={`Move to ${s.label}`}
                >
                  {inner}
                </button>
              ) : hasDetail ? (
                <button
                  type="button"
                  className={cls}
                  data-testid={`lifecycle-stage-${s.key}`}
                  onClick={() => setOpenRows((p) => { const n = new Set(p); if (n.has(s.key)) n.delete(s.key); else n.add(s.key); return n })}
                >
                  {inner}
                </button>
              ) : (
                <div className={cls} data-testid={`lifecycle-stage-${s.key}`}>{inner}</div>
              )}
              {hasDetail && openRows.has(s.key) ? (
                <div className="rail-detail">
                  {req.length ? <div className="rail-req">Required proof: {req.join(', ')}</div> : null}
                  {i > curIdx && s.gated ? <div className="rail-lockreason"><Icon name="lock" size={11} /> Locked — advance from {stages[i - 1]?.label ?? '—'} with a program-emitted receipt (advance_task)</div> : null}
                  {needsAgentForStage ? (
                    <div className="rail-lockreason" data-testid={`lifecycle-stage-needs-agent-${s.key}`}>
                      <Icon name="lock" size={11} /> Needs agent action — complete V3 packet required (see Agents / Runs or Decision)
                    </div>
                  ) : null}
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
                      {cps.map((c, ci) => {
                        const d = dc.checkpoints[ci].done
                        return (
                          <div className={`ts-check-item ${d ? 'done' : ''}`} key={c.id}>
                            <span className="ts-box">{d ? <Icon name="check" size={10} /> : null}</span>
                            <span className="ts-check-label">{c.label}</span>
                            {c.category ? <span className="cp-cat">{c.category}</span> : null}
                          </div>
                        )
                      })}
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>
          )
        })}
      </div>
      {err ? <p className="rail-err" data-testid="lifecycle-rail-err"><Icon name="alert" size={13} /> {err}</p> : null}

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
