// Fully agent-defined task content. Each `section` is a block the agent added via
// MCP (set/add_task_section); this renders it by `type`. No fixed template — an
// agent can add any "menu" with any content inside a task.
import { useState } from 'react'
import { Chip } from '#/components/primitives'
import { Icon } from '#/lib/icons'
import type { TaskSection } from '#/lib/types'

function Block({ s }: { s: TaskSection }) {
  switch (s.type) {
    case 'text':
      return <p className="ts-text">{s.body}</p>
    case 'callout':
      return <p className={`ts-callout tone-${s.tone ?? 'indigo'}`}>{s.body}</p>
    case 'fields':
      return (
        <div className="ts-fields">
          {(s.fields ?? []).map((f, i) => (
            <div className="meta-row" key={i}><span className="k">{f.k}</span><span className="v">{f.v}</span></div>
          ))}
        </div>
      )
    case 'list':
      return <ul className="mf-list">{(s.items ?? []).map((x, i) => <li key={i}>{x}</li>)}</ul>
    case 'checklist':
      return (
        <div className="ts-check">
          {(s.checklist ?? []).map((c, i) => (
            <div className={`ts-check-item ${c.done ? 'done' : ''}`} key={c.id ?? i}>
              <span className="ts-box">{c.done ? <Icon name="check" size={11} /> : null}</span>
              <span className="ts-check-label">{c.label}</span>
            </div>
          ))}
        </div>
      )
    case 'chips':
    case 'badges':
      return <div className="mf-chips">{(s.chips ?? []).map((x, i) => <Chip key={i} className="chip-mono">{x}</Chip>)}</div>
    case 'table':
      return (
        <div className="ts-table-wrap">
          <table className="ts-table">
            {s.columns?.length ? <thead><tr>{s.columns.map((c, i) => <th key={i}>{c}</th>)}</tr></thead> : null}
            <tbody>{(s.rows ?? []).map((r, i) => <tr key={i}>{r.map((cell, j) => <td key={j}>{cell}</td>)}</tr>)}</tbody>
          </table>
        </div>
      )
    case 'anchors':
      return (
        <div className="mf-refs">
          {(s.anchors ?? []).map((a, i) => (
            <div className="anchor tone-indigo" key={i}>
              <div className="anchor-top">
                <span className="anchor-repo">{a.repo ?? '—'}</span>
                <span className="anchor-file">{a.file}{a.line != null ? `:${a.line}` : ''}{a.symbol ? ` · ${a.symbol}` : ''}</span>
              </div>
              {a.fact ? <div className="anchor-fact">{a.fact}</div> : null}
            </div>
          ))}
        </div>
      )
    case 'variants':
      return (
        <div className="mf-refs">
          {(s.variants ?? []).map((v, i) => (
            <div className="var" key={i}>
              <div className="var-top"><span className="var-id">{v.id ?? `#${i + 1}`}</span>{v.when ? <span className="var-when">{v.when}</span> : null}</div>
              {v.expect ? <div className="var-expect"><Icon name="arrow" size={12} /> {v.expect}</div> : null}
            </div>
          ))}
        </div>
      )
    case 'links':
      return (
        <div className="ds-links">
          {(s.links ?? []).map((l, i) => (
            <a className="ds-link" key={i} href={l.url} target="_blank" rel="noreferrer"><Icon name="link" size={13} /> {l.label ?? l.url}</a>
          ))}
        </div>
      )
    default:
      return <pre className="ts-raw">{JSON.stringify(s, null, 2)}</pre>
  }
}

function SectionCard({ s, n }: { s: TaskSection; n: number }) {
  const [open, setOpen] = useState(!s.collapsed)
  return (
    <div className={`map-sec tone-${s.tone ?? 'indigo'}`} data-open={open}>
      <button type="button" className="map-sec-head" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <span className="map-num">{n}</span>
        <span className="map-sec-title">{s.title ?? s.type}</span>
        <span className="map-sec-hint">{s.type}</span>
        <Icon name="chevL" size={15} className={`map-caret ${open ? 'open' : ''}`} />
      </button>
      {open ? <div className="map-sec-body"><Block s={s} /></div> : null}
    </div>
  )
}

export function TaskSections({ sections }: { sections?: Array<TaskSection> }) {
  if (!sections?.length) return null
  return (
    <section className="section">
      <div className="sec-head">
        <Icon name="layers" className="nav-ico" />
        <h2>Sections</h2>
        <span className="count">{sections.length}</span>
        <span className="desc">agent-defined — add any block via MCP</span>
      </div>
      <div className="map-secs">
        {sections.map((s, i) => <SectionCard key={s.id} s={s} n={i + 1} />)}
      </div>
    </section>
  )
}
