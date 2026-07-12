// Board rollup — how many ACTIVE tasks sit at each lifecycle stage, plus HOLD
// (visible but outside the active denominator). Data from computeRollup (server).
import { useRollup } from '#/lib/board-query'

const tone = (color?: string) => `tone-${color ?? 'indigo'}`

export function RollupBar() {
  const r = useRollup()
  if (!r.active && !r.hold) return null
  return (
    <div className="rollup">
      {r.uninitialized ? (
        <div className="rollup-cell tone-parked is-uninit" title="Active tasks with no lifecycle stage yet — run init_lifecycle">
          <div className="rollup-n">{r.uninitialized}</div>
          <div className="rollup-lbl">Uninitialized</div>
          <div className="rollup-track" />
        </div>
      ) : null}
      {r.stages.map((s) => {
        const n = r.counts[s.key] ?? 0
        const pct = r.active ? Math.round((n / r.active) * 100) : 0
        return (
          <div key={s.key} className={`rollup-cell ${tone(s.color)} ${n ? '' : 'is-empty'}`} title={`${n} / ${r.active} active`}>
            <div className="rollup-n">{n}</div>
            <div className="rollup-lbl">{s.label}</div>
            <div className="rollup-track"><span style={{ width: `${pct}%` }} /></div>
          </div>
        )
      })}
      {r.hold ? (
        <div className="rollup-cell tone-parked is-hold" title="HOLD — outside the active denominator">
          <div className="rollup-n">{r.hold}</div>
          <div className="rollup-lbl">On hold</div>
          <div className="rollup-track" />
        </div>
      ) : null}
    </div>
  )
}
