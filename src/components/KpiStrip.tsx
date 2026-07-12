// KPI strip — ported from prototype `vBoard(m)` kpis block (docs/plan/assets/app.js).
import { Icon, type IconName } from '#/lib/icons'

export interface KpiItem {
  tone: string
  icon: IconName
  num: number
  label: string
}

export function KpiStrip({ items }: { items: KpiItem[] }) {
  return (
    <div className="kpis">
      {items.map((item, i) => (
        <div key={i} className={`kpi ${item.tone}`}>
          <div className="kpi-ico">
            <Icon name={item.icon} />
          </div>
          <div>
            <div className="kpi-num">{item.num}</div>
            <div className="kpi-lbl">{item.label}</div>
          </div>
        </div>
      ))}
    </div>
  )
}
