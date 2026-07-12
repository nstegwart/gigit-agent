// Feature task checklist card — ported from the prototype `vFeature` Tasks block
// (docs/plan/assets/app.js). Markup + classes reproduced exactly; rows are clickable
// to toggle done-state via useToggleTask() (writes data/plan.json, refreshes the board).
import { Icon } from '#/lib/icons'
import { useToggleTask } from '#/lib/board-query'
import type { Feature } from '#/lib/types'

export function Checklist({ feature }: { feature: Feature }) {
  const toggle = useToggleTask()
  const checks = feature.checklist ?? []
  const pct = feature.taskTotal ? Math.round((feature.taskDone / feature.taskTotal) * 100) : 0
  const allDone = feature.taskDone === feature.taskTotal && feature.taskTotal > 0

  return (
    <div className="card">
      <div className="card-head">
        <Icon name="features" className="nav-ico" />
        <h3>Tasks</h3>
        <span className="count">
          {feature.taskDone}/{feature.taskTotal} done
        </span>
        <div style={{ flex: 1, maxWidth: 160, marginLeft: 'auto' }}>
          <div className={`bar ${allDone ? 'ok' : ''}`}>
            <span style={{ width: `${pct}%` }} />
          </div>
        </div>
      </div>
      <div className="card-body">
        {checks.length ? (
          checks.map((c, index) => (
            <div
              key={index}
              className={`check ${c.done ? 'done' : ''}`}
              role="button"
              aria-disabled={toggle.isPending}
              style={{ cursor: 'pointer' }}
              onClick={() => {
                if (toggle.isPending) return
                toggle.mutate({ featureId: feature.id, index })
              }}
            >
              <span className="box">{c.done ? <Icon name="check" /> : null}</span>
              <span className="txt">{c.teks}</span>
            </div>
          ))
        ) : (
          <div className="empty">No tasks listed.</div>
        )}
      </div>
    </div>
  )
}
