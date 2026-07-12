// Row for a single feature inside a features grid/list. Ported from prototype `featRow(m, f)`
// (docs/plan/assets/app.js) — same markup/classes, as a typed block Link.
import { BoardLink as Link } from '#/components/BoardLink'
import { Icon } from '#/lib/icons'
import { PhaseBadge, MiniAgent, ProgressBar } from '#/components/primitives'
import type { Feature, Model } from '#/lib/types'

export function FeatureRow({ feature: f, model: m }: { feature: Feature; model: Model }) {
  void m
  const ag = f.runs.filter((r) => r.status === 'running')
  return (
    <Link to="/features/$featureId" params={{ featureId: f.id }} className="feat-row">
      <PhaseBadge feature={f} />
      <div className="fr-name">
        {f.nama}
        <small>{f.id}</small>
      </div>
      {f.blocked ? (
        <span className="tag" style={{ color: 'var(--blocked)', background: 'var(--blocked-bg)' }}>
          <Icon name="lock" />
          blocked
        </span>
      ) : null}
      <div className="fr-agents">
        {ag.map((run) => (
          <MiniAgent key={run.id} run={run} />
        ))}
      </div>
      <div className="fr-prog">
        <ProgressBar pct={f.pct ?? 0} right={`${f.taskDone}/${f.taskTotal}`} />
      </div>
      <Icon name="arrow" className="nav-ico" />
    </Link>
  )
}
