// Path-to-production gate list — ported from prototype gate rows (app.js).
import { Icon } from '#/lib/icons'
import type { ProdData } from '#/lib/types'

export function ProdGates({ prod }: { prod: ProdData }) {
  return (
    <div>
      {prod.mockLabel ? (
        <div className="mock-banner">
          <Icon name="alert" className="nav-ico" />
          <span>{prod.mockLabel}</span>
        </div>
      ) : null}
      {prod.headline ? <p style={{ color: 'var(--text-dim)', fontSize: 13, marginBottom: 14 }}>{prod.headline}</p> : null}
      <div className="card">
        {prod.gates.map((g) => (
          <div className="gate" key={g.id}>
            <div className="gate-id">{g.id}</div>
            <div className="gate-body">
              <div className="gate-title">{g.title}</div>
              {g.meaning ? <div className="gate-meaning">{g.meaning}</div> : null}
              {g.agent || g.doneWhen ? (
                <div className="gate-meta">
                  {g.agent ? <b>{g.agent}</b> : null}
                  {g.agent && g.doneWhen ? ' · ' : null}
                  {g.doneWhen ? <>done when: {g.doneWhen}</> : null}
                </div>
              ) : null}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
