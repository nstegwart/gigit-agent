// Board readiness — overall ready-to-production %, a stacked stage funnel, and a
// compact legend. All figures come from the server-computed lifecycle rollup
// (computeRollup) — the single source of truth used across every page.
import { useRollup } from '#/lib/board-query'

export function RollupBar() {
  const r = useRollup()
  if (!r.active && !r.hold) return null
  const total = r.active || 1
  const seg = (n: number) => `${(n / total) * 100}%`

  return (
    <div className="rup">
      <div className="rup-head">
        <div className="rup-pct">
          <b>{r.readinessPercent}%</b>
          <span>ready-production</span>
        </div>
        <div className="rup-meta">
          <span><b>{r.active}</b> active</span>
          {r.milestone ? <span><b>{r.atMilestone}</b>/{r.active} {r.milestone}</span> : null}
          {r.uninitialized ? <span className="rup-warn"><b>{r.uninitialized}</b> uninit</span> : null}
          {r.hold ? <span className="rup-muted"><b>{r.hold}</b> on hold</span> : null}
        </div>
      </div>

      <div className="rup-bar" role="img" aria-label={`${r.readinessPercent}% ready`}>
        {r.stages.map((s) => {
          const c = r.counts[s.key] ?? 0
          return c ? <span key={s.key} className={`rup-seg tone-${s.color ?? 'indigo'}`} style={{ width: seg(c) }} title={`${s.label}: ${c}`} /> : null
        })}
        {r.uninitialized ? <span className="rup-seg is-uninit" style={{ width: seg(r.uninitialized) }} title={`Uninitialized: ${r.uninitialized}`} /> : null}
      </div>

      <div className="rup-legend">
        {r.stages.map((s) => (
          <span key={s.key} className={`rup-leg tone-${s.color ?? 'indigo'} ${r.counts[s.key] ? '' : 'is-empty'}`}>
            <span className="rup-dot" />{s.label}<b>{r.counts[s.key] ?? 0}</b>
          </span>
        ))}
        {r.uninitialized ? <span className="rup-leg is-uninit"><span className="rup-dot" />Uninitialized<b>{r.uninitialized}</b></span> : null}
        {r.hold ? <span className="rup-leg tone-parked"><span className="rup-dot" />On hold<b>{r.hold}</b></span> : null}
      </div>
    </div>
  )
}
