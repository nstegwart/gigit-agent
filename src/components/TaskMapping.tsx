// The 20-point rebuild mapping for a task — the contract an implementer needs so they
// never guess. Renders only the sections that have data, as tone-coded collapsible cards.
import { useState } from 'react'
import { Chip } from '#/components/primitives'
import { Icon } from '#/lib/icons'
import type { TaskAnchor, TaskVariant, WorkTask } from '#/lib/types'

type Tone = 'indigo' | 'amber' | 'green' | 'blue' | 'teal' | 'red'

const has = (...v: Array<unknown>) => v.some((x) => (Array.isArray(x) ? x.length : x != null && x !== ''))

/** legacy → amber, rebuild/mfs-web → green, else indigo. Colors code references by origin. */
function repoTone(repo?: string): Tone {
  const r = (repo ?? '').toLowerCase()
  if (r.includes('legacy')) return 'amber'
  if (r.includes('rebuild') || r.includes('mfs-web') || r.includes('sales')) return 'green'
  return 'indigo'
}

function Field({ label, children }: { label?: string; children: React.ReactNode }) {
  return (
    <div className="mf">
      {label ? <div className="mf-k">{label}</div> : null}
      {children}
    </div>
  )
}
function List({ items, label }: { items?: Array<string>; label?: string }) {
  if (!items?.length) return null
  return (
    <Field label={label}>
      <ul className="mf-list">{items.map((x, i) => <li key={i}>{x}</li>)}</ul>
    </Field>
  )
}
function Note({ v, label }: { v?: string | null; label?: string }) {
  if (!v) return null
  return (
    <Field label={label}>
      <p className="mf-note">{v}</p>
    </Field>
  )
}
function Chips({ items, label }: { items?: Array<string>; label?: string }) {
  if (!items?.length) return null
  return (
    <Field label={label}>
      <div className="mf-chips">{items.map((x, i) => <Chip key={i} className="chip-mono">{x}</Chip>)}</div>
    </Field>
  )
}
function Anchors({ items, label }: { items?: Array<TaskAnchor>; label: string }) {
  if (!items?.length) return null
  return (
    <Field label={label}>
      <div className="mf-refs">
        {items.map((a, i) => (
          <div className={`anchor tone-${repoTone(a.repo)}`} key={i}>
            <div className="anchor-top">
              <span className="anchor-repo"><Icon name="branch" size={11} /> {a.repo ?? '—'}</span>
              {a.file ? (
                <span className="anchor-file">
                  {a.file}
                  {a.line != null ? <span className="anchor-line">:{a.line}</span> : null}
                </span>
              ) : null}
              {a.symbol ? <span className="anchor-sym">{a.symbol}</span> : null}
            </div>
            {a.fact ? <div className="anchor-fact">{a.fact}</div> : null}
          </div>
        ))}
      </div>
    </Field>
  )
}
function Variants({ items, label }: { items?: Array<TaskVariant>; label: string }) {
  if (!items?.length) return null
  return (
    <Field label={label}>
      <div className="mf-refs">
        {items.map((v, i) => (
          <div className="var" key={i}>
            <div className="var-top">
              <span className="var-id">{v.id ?? `#${i + 1}`}</span>
              {v.when ? <span className="var-when">{v.when}</span> : null}
            </div>
            {v.expect ? (
              <div className="var-expect"><Icon name="arrow" size={12} /> {v.expect}</div>
            ) : null}
          </div>
        ))}
      </div>
    </Field>
  )
}

interface Sec {
  n: string
  title: string
  tone: Tone
  open?: boolean
  hint?: string
  show: boolean
  body: React.ReactNode
}

function MapSection({ s }: { s: Sec }) {
  const [open, setOpen] = useState(!!s.open)
  return (
    <div className={`map-sec tone-${s.tone}`} data-open={open}>
      <button type="button" className="map-sec-head" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <span className="map-num">{s.n}</span>
        <span className="map-sec-title">{s.title}</span>
        {s.hint ? <span className="map-sec-hint">{s.hint}</span> : null}
        <Icon name="chevL" size={15} className={`map-caret ${open ? 'open' : ''}`} />
      </button>
      {open ? <div className="map-sec-body">{s.body}</div> : null}
    </div>
  )
}

export function TaskMapping({ task: t }: { task: WorkTask }) {
  const cnt = (a?: Array<unknown>) => (a?.length ? `${a.length}` : undefined)
  const secs: Array<Sec> = [
    {
      n: '1', title: 'Identity & scope', tone: 'indigo', open: true,
      show: has(t.featureContractId, t.actor, t.repository, t.nodeIds, t.forbidden_scope, t.unlock_conditions, t.blockers),
      body: (
        <>
          <div className="mf-chips">
            {t.featureContractId ? <Chip className="chip-mono">FC {t.featureContractId}</Chip> : null}
            {t.repository ? <Chip>repo: {t.repository}</Chip> : null}
            {t.scope ? <Chip>{t.scope}</Chip> : null}
            {typeof t.unlocked === 'boolean' ? <Chip>{t.unlocked ? 'unlocked' : 'locked'}</Chip> : null}
          </div>
          <Note v={t.actor} label="Actor" />
          <Chips items={t.nodeIds} label="Nodes" />
          <List items={t.forbidden_scope} label="Forbidden scope (EXCLUDE)" />
          <List items={t.unlock_conditions} label="Unlock conditions" />
          <List items={t.blockers} label="Blockers" />
        </>
      ),
    },
    {
      n: '2', title: 'Legacy source of truth', tone: 'amber', open: true, hint: cnt(t.legacy_anchors),
      show: has(t.legacy_contract, t.legacy_anchors),
      body: (<><Note v={t.legacy_contract} /><Anchors items={t.legacy_anchors} label="Legacy anchors (repo · file:line · fact)" /></>),
    },
    {
      n: '3', title: 'Target rebuild', tone: 'green', open: true, hint: cnt(t.rebuild_anchors),
      show: has(t.target_scope, t.target_files_or_discovery_scope, t.current_gap, t.rebuild_anchors),
      body: (<><Note v={t.target_scope} label="Target scope" /><List items={t.target_files_or_discovery_scope} label="Target files / discovery scope" /><Note v={t.current_gap} label="Current gap" /><Anchors items={t.rebuild_anchors} label="Rebuild anchors" /></>),
    },
    {
      n: '4', title: 'User journey', tone: 'blue', show: has(t.page_routes, t.state_lifecycle, t.outcome_variants),
      body: (<><Chips items={t.page_routes} label="Routes / pages" /><List items={t.state_lifecycle} label="State lifecycle" /><List items={t.outcome_variants} label="Outcomes (success/fail/expired/cancel…)" /></>),
    },
    {
      n: '5', title: 'API contract', tone: 'indigo', show: has(t.api_endpoints, t.inputs_outputs),
      body: (<><Chips items={t.api_endpoints} label="Endpoints" /><List items={t.inputs_outputs} label="Inputs / outputs" /></>),
    },
    {
      n: '6', title: 'Business rules & state', tone: 'teal', show: has(t.logic_rules, t.compensation_idempotency),
      body: (<><List items={t.logic_rules} label="Logic rules / invariants" /><List items={t.compensation_idempotency} label="Idempotency / compensation" /></>),
    },
    {
      n: '7', title: 'Data lineage', tone: 'amber', show: has(t.sales_table_fields, t.data_migration),
      body: (<><Chips items={t.sales_table_fields} label="Tables / fields" /><Note v={t.data_migration} label="Migration / backfill" /></>),
    },
    {
      n: '8', title: 'Callers & blast radius', tone: 'red', show: has(t.callers_consumers, t.blast_radius, t.compatibility, t.regression_matrix),
      body: (<><List items={t.callers_consumers} label="Callers / consumers" /><List items={t.blast_radius} label="Blast radius" /><List items={t.compatibility} label="Compatibility (old clients)" /><List items={t.regression_matrix} label="Regression surface" /></>),
    },
    {
      n: '9', title: 'Side effects & readback', tone: 'blue', show: has(t.side_effects_readback),
      body: (<List items={t.side_effects_readback} label="Side effects (DB / UI / email / webhook)" />),
    },
    {
      n: '11', title: 'Provider branch', tone: 'indigo', show: has(t.provider_variants),
      body: (<Variants items={t.provider_variants} label="Providers (Cleeng / Xendit / RevenueCat)" />),
    },
    {
      n: '12', title: 'Geo & regional', tone: 'teal', show: has(t.geo_variants),
      body: (<Variants items={t.geo_variants} label="Geo variants (ID vs non-ID)" />),
    },
    {
      n: '14-15', title: 'Security & performance', tone: 'red', show: has(t.security_perf),
      body: (<List items={t.security_perf} label="Security / performance" />),
    },
    {
      n: '16-17', title: 'Reliability, migration & rollback', tone: 'amber', show: has(t.rollback),
      body: (<Note v={t.rollback} label="Rollback / compensation" />),
    },
    {
      n: '19-20', title: 'Acceptance, evidence & deployment', tone: 'green', open: true,
      show: has(t.implementation_steps, t.acceptance_criteria, t.acceptance, t.proof_required, t.evidence, t.evidence_path, t.history),
      body: (
        <>
          <List items={t.implementation_steps} label="Implementation steps" />
          <List items={t.acceptance_criteria ?? t.acceptance} label="Acceptance criteria" />
          <List items={t.proof_required} label="Proof required" />
          <List items={t.evidence} label="Evidence" />
          {t.evidence_path ? <Chips items={[t.evidence_path]} label="Evidence path" /> : null}
          <List items={t.history} label="History" />
        </>
      ),
    },
  ]
  const visible = secs.filter((s) => s.show)
  if (!visible.length) return null
  return (
    <section className="section map">
      <div className="map-head">
        <div className="map-head-ico"><Icon name="layers" size={20} /></div>
        <div>
          <h2>Rebuild mapping</h2>
          <p className="map-head-sub">The contract an implementer needs — no guessing.</p>
        </div>
        <div className="map-head-count"><b>{visible.length}</b>of 20 points</div>
      </div>
      <div className="map-secs">
        {visible.map((s) => <MapSection key={s.n} s={s} />)}
      </div>
    </section>
  )
}
