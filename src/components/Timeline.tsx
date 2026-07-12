// Activity log timeline — ported from prototype `vLog(m)` (app.js).
import { fmtDate } from '#/lib/format'
import type { LogEntry } from '#/lib/types'

export function Timeline({ log }: { log: Array<LogEntry> }) {
  return (
    <div className="timeline">
      {log.map((l, i) => (
        <div className="tl-item" key={i}>
          <div className="tl-date">{fmtDate(l.tanggal)}</div>
          <div className="tl-text">{l.teks}</div>
        </div>
      ))}
    </div>
  )
}
