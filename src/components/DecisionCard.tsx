// Single decision row — ported from prototype `vDecisions(m)` decision item (app.js).
import { Icon } from '#/lib/icons'
import { fmtDate } from '#/lib/format'
import type { Decision } from '#/lib/types'

export function DecisionCard({ decision }: { decision: Decision }) {
  return (
    <div className="decision">
      <div className="decision-top">
        <span className="decision-id">{decision.id}</span>
        <span className="decision-q">{decision.teks}</span>
        <span className={`badge-status bs-${decision.status}`}>{decision.status}</span>
      </div>
      {decision.keputusan ? (
        <div className="decision-ans">
          <Icon name="check" className="nav-ico" />
          <span>
            <b>Decided:</b> {decision.keputusan}
            {decision.tanggal_putus ? (
              <span style={{ color: 'var(--text-faint)' }}> · {fmtDate(decision.tanggal_putus)}</span>
            ) : null}
          </span>
        </div>
      ) : decision.aksi ? (
        <div className="decision-ans">
          <Icon name="arrow" className="nav-ico" />
          <span>{decision.aksi}</span>
        </div>
      ) : null}
    </div>
  )
}
