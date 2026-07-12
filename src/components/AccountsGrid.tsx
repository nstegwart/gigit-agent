// Ops/accounts view body: vault summary tiles + low-account alert + per-account cards.
import { Icon } from '#/lib/icons'
import { EmptyState } from '#/components/primitives'
import type { OpsData } from '#/lib/types'

export function AccountsGrid({ ops }: { ops: OpsData }) {
  const { vault, accounts, alert } = ops

  const usableCount = vault.usableCount ?? accounts.filter((a) => a.usable).length
  const limitCount = vault.limitCount ?? accounts.filter((a) => !a.usable).length
  const accountCount = vault.accountCount ?? accounts.length

  const tiles: Array<{ num: React.ReactNode; lbl: string }> = [
    { num: accountCount, lbl: 'Accounts' },
    { num: usableCount, lbl: 'Usable' },
    { num: limitCount, lbl: 'At limit' },
  ]
  if (vault.sessionsPerAccount != null) {
    tiles.push({ num: vault.sessionsPerAccount, lbl: 'Sessions / account' })
  }
  if (vault.minWorkers != null && vault.maxWorkers != null) {
    tiles.push({ num: `${vault.minWorkers}–${vault.maxWorkers}`, lbl: 'Workers (min–max)' })
  }

  const lowThreshold = alert?.lowThreshold
  const showAlert =
    alert?.enabled !== false &&
    lowThreshold != null &&
    usableCount < lowThreshold

  return (
    <>
      <div className="vault">
        {tiles.map((t, i) => (
          <div className="vault-tile" key={i}>
            <div className="vault-num">{t.num}</div>
            <div className="vault-lbl">{t.lbl}</div>
          </div>
        ))}
      </div>

      {vault.capacityNote ? <p className="vault-lbl">{vault.capacityNote}</p> : null}

      {showAlert ? (
        <div className="alert-banner">
          <Icon name="alert" size={15} />
          <span>
            Only {usableCount} usable account{usableCount === 1 ? '' : 's'} left
            {lowThreshold != null ? ` (threshold ${lowThreshold})` : ''}
            {alert?.email ? ` — notify ${alert.email}` : ''}.
          </span>
        </div>
      ) : null}

      {accounts.length ? (
        <div className="account-grid">
          {accounts.map((a) => {
            const cls = a.usable ? 'usable' : 'limit'
            return (
              <div className={`account-card ${cls}`} key={a.id}>
                <div className="account-top">
                  <span className="account-label" title={a.label}>
                    {a.label}
                  </span>
                  <span className={`account-badge ${cls}`}>
                    {a.usable ? 'usable' : 'limit'}
                  </span>
                </div>
                <div className="account-slots">
                  {a.slotsInUse}/{a.slotsCapacity} slots in use
                </div>
                {a.reason ? <div className="account-reason">{a.reason}</div> : null}
              </div>
            )
          })}
        </div>
      ) : (
        <EmptyState icon="users">No accounts in the vault.</EmptyState>
      )}
    </>
  )
}
