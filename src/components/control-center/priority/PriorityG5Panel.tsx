import { G5_REQUIRED_DOMAINS } from '#/lib/control-plane-types'
import type { G5DomainId } from '#/lib/control-plane-types'
import { Card, StatusChip, type StatusChipVariant } from '#/components/ui'
import { formatBoolean, humanBoolean, humanG5DomainLabel, humanG5Status } from './display'
import type { PriorityG5Props } from './types'
import styles from './priority.module.css'

function statusChipVariant(status: string): StatusChipVariant {
  switch (status) {
    case 'PASS':
      return 'done'
    case 'FAIL':
    case 'BLOCKED':
      return 'blocked'
    case 'IN_PROGRESS':
      return 'ongoing'
    case 'NOT_STARTED':
    default:
      return 'pending'
  }
}

/**
 * Nine-domain G5 matrix — server statuses only; never derive g5Pass client-side.
 */
export function PriorityG5Panel(props: PriorityG5Props) {
  const { g5Pass, domains, missingDomains = [] } = props

  const byId = new Map(domains.map((d) => [d.domainId, d]))

  // Render exact nine required domains; missing rows show as absent (fail-closed display).
  const rows = G5_REQUIRED_DOMAINS.map((domainId: G5DomainId) => {
    const row = byId.get(domainId)
    if (row) return row
    return {
      domainId,
      label: humanG5DomainLabel(domainId),
      status: 'NOT_STARTED' as const,
      pass: false,
      reason: missingDomains.includes(domainId)
        ? 'tidak ada di envelope server'
        : 'tidak disediakan',
      evidenceReceiptIds: [],
      blocker: null,
    }
  })

  return (
    <Card
      aria-labelledby="priority-g5-heading"
      data-testid="priority-g5"
      data-g5-pass={g5Pass ? 'true' : 'false'}
      title={
        <span id="priority-g5-heading">Domain G5 (sembilan gerbang kesiapan)</span>
      }
      headerActions={
        <span data-testid="priority-g5-pass">
          <StatusChip variant={g5Pass ? 'done' : 'blocked'}>
            {humanBoolean(g5Pass, 'G5 lolos', 'G5 belum lolos')} · g5Pass=
            {formatBoolean(g5Pass)}
          </StatusChip>
        </span>
      }
      flush
    >
      <div className={`${styles.stack} ${styles.g5Body}`}>
        {/* Desktop/table + mobile card reflow via CSS ≤768.
            tabIndex+named region: scrollable-region-focusable (axe). */}
        <div
          className={styles.g5TableWrap}
          role="region"
          aria-label="G5 domain matrix"
          tabIndex={0}
          data-testid="priority-g5-scroll"
        >
          <table className={styles.g5Table} data-testid="priority-g5-table">
            <thead>
              <tr>
                <th scope="col">Domain</th>
                <th scope="col">Status</th>
                <th scope="col">Lolos</th>
                <th scope="col">Alasan / pemblokir</th>
                <th scope="col">Bukti</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const label = humanG5DomainLabel(row.domainId, row.label)
                const reason = row.blocker || row.reason || '—'
                const evidenceCount = row.evidenceReceiptIds?.length ?? 0
                return (
                  <tr
                    key={row.domainId}
                    data-testid={`priority-g5-row-${row.domainId}`}
                    data-domain-status={row.status}
                    data-domain-pass={row.pass ? 'true' : 'false'}
                  >
                    <th scope="row">
                      <span className={styles.domainLabel}>{label}</span>
                      <code className={styles.domainId}>{row.domainId}</code>
                    </th>
                    <td>
                      <StatusChip
                        variant={statusChipVariant(row.status)}
                        title={row.status}
                      >
                        {humanG5Status(row.status)}
                      </StatusChip>
                    </td>
                    <td className={row.pass ? styles.semanticOk : styles.semanticFail}>
                      {humanBoolean(row.pass, 'Ya', 'Tidak')}{' '}
                      <code className={styles.mono}>{formatBoolean(row.pass)}</code>
                    </td>
                    <td className={styles.reasonCell}>{reason}</td>
                    <td data-testid={`priority-g5-evidence-${row.domainId}`}>
                      {evidenceCount}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>

          <ul className={styles.g5Cards} data-testid="priority-g5-cards">
            {rows.map((row) => {
              const label = humanG5DomainLabel(row.domainId, row.label)
              const reason = row.blocker || row.reason || '—'
              return (
                <li
                  key={row.domainId}
                  className={styles.g5Card}
                  data-testid={`priority-g5-card-${row.domainId}`}
                >
                  <div className={styles.g5CardHead}>
                    <span className={styles.domainLabel}>{label}</span>
                    <StatusChip
                      variant={statusChipVariant(row.status)}
                      title={row.status}
                    >
                      {humanG5Status(row.status)}
                    </StatusChip>
                  </div>
                  <dl className={styles.g5CardMeta}>
                    <div>
                      <dt>Lolos</dt>
                      <dd className={row.pass ? styles.semanticOk : styles.semanticFail}>
                        {humanBoolean(row.pass, 'Ya', 'Tidak')}{' '}
                        <code className={styles.mono}>{formatBoolean(row.pass)}</code>
                      </dd>
                    </div>
                    <div>
                      <dt>Alasan</dt>
                      <dd>{reason}</dd>
                    </div>
                    <div>
                      <dt>Bukti</dt>
                      <dd>{row.evidenceReceiptIds?.length ?? 0}</dd>
                    </div>
                  </dl>
                </li>
              )
            })}
          </ul>
        </div>

        {missingDomains.length > 0 ? (
          <p className={styles.warnLine} data-testid="priority-g5-missing">
            Domain yang hilang dari envelope server:{' '}
            {missingDomains.map((id) => (
              <code key={id} className={styles.mono}>
                {id}{' '}
              </code>
            ))}
          </p>
        ) : null}
      </div>
    </Card>
  )
}
