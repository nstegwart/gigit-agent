// Activity feed — recent ActivityEvent list rendered as a timeline.
import { fmtDate } from '#/lib/format'
import type { ActivityEvent } from '#/lib/types'

export function ActivityFeed({ activity, limit }: { activity: Array<ActivityEvent>; limit?: number }) {
  const items = activity.slice(0, limit ?? 20)
  if (items.length === 0) {
    return <div style={{ color: 'var(--text-faint)' }}>No activity.</div>
  }
  return (
    <div className="timeline">
      {items.map((ev, i) => (
        <div className="tl-item" key={i}>
          <div className="tl-date">{fmtDate(ev.ts)}</div>
          <div className="tl-text">
            <span className="act-kind">{ev.kind}</span> {ev.actor}: {ev.text}
          </div>
        </div>
      ))}
    </div>
  )
}
