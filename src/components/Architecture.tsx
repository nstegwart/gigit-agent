// Architecture — renders project.komponen[] as an .arch-grid of .arch-card,
// plus project.docs (arsitektur note + baseline bullet list) when present.
import { Chip } from '#/components/primitives'
import type { Project } from '#/lib/types'

interface Komponen {
  nama?: string
  jenis?: string
  stack?: string
  status?: string
  ket?: string
}
interface ScreenPage {
  nama?: string
  route?: string
  status?: string
  feature?: string
}

export function Architecture({ project }: { project: Project }) {
  const komponen = (project.komponen ?? []) as Array<Komponen>
  const docs = (project.docs ?? {}) as Record<string, unknown>
  const arsitektur = typeof docs.arsitektur === 'string' ? docs.arsitektur : undefined
  const baseline = Array.isArray(docs.baseline) ? (docs.baseline as Array<string>) : undefined
  const pages = (Array.isArray(docs.pages) ? docs.pages : []).filter(
    (p): p is ScreenPage => !!p && typeof p === 'object' && !!(p as ScreenPage).route,
  )
  // group screens by feature when present (Personal/RN), else one flat group
  const grouped = pages.reduce<Record<string, Array<ScreenPage>>>((acc, p) => {
    const k = p.feature?.trim() || ''
    ;(acc[k] ??= []).push(p)
    return acc
  }, {})
  const groups = Object.entries(grouped)

  const foundation: Array<{ emoji: string; label: string; url?: string }> = [
    { emoji: '🎨', label: 'Design Foundation', url: project.design_foundation },
    { emoji: '🧩', label: 'Katalog Komponen', url: project.design_components },
    { emoji: '📄', label: 'Semua Halaman', url: project.design_pages },
  ].filter((f) => f.url)

  if (komponen.length === 0 && !arsitektur && !baseline && foundation.length === 0 && pages.length === 0) return null

  return (
    <div className="arch">
      {foundation.length > 0 && (
        <div className="arch-block">
          <div className="block-label">Design system</div>
          <div className="ds-links">
            {foundation.map((f) => (
              <a key={f.label} className="ds-link" href={f.url} target="_blank" rel="noopener">
                <span className="ds-emoji">{f.emoji}</span>
                {f.label} ↗
              </a>
            ))}
          </div>
        </div>
      )}
      {pages.length > 0 && (
        <div className="arch-block">
          <div className="block-label">Screens · {pages.length}</div>
          {groups.map(([feature, items]) => (
            <div className="ds-screens-group" key={feature || '_'}>
              {feature ? <div className="ds-screens-feat">{feature}</div> : null}
              <div className="ds-screens">
                {items.map((s, i) => (
                  <a className="ds-screen" key={s.route ?? i} href={s.route} target="_blank" rel="noopener">
                    <span className="ds-screen-name">{s.nama || s.route}</span>
                    <span className="ds-screen-go">↗</span>
                  </a>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
      {(arsitektur || (baseline && baseline.length > 0)) && (
        <div className="arch-block">
          <div className="block-label">Architecture</div>
          {arsitektur && <p className="note">{arsitektur}</p>}
          {baseline && baseline.length > 0 && (
            <ul className="arch-baseline">
              {baseline.map((item, i) => (
                <li key={i}>{item}</li>
              ))}
            </ul>
          )}
        </div>
      )}
      {komponen.length > 0 && (
        <div className="arch-block">
          <div className="block-label">Components · {komponen.length}</div>
          <div className="arch-grid">
            {komponen.map((k, i) => (
              <div className="arch-card" key={k.nama ?? i}>
                <div className="arch-card-top">
                  <h4>{k.nama}</h4>
                  {k.status && <span className={`arch-status st-${k.status}`}>{k.status}</span>}
                </div>
                {k.jenis && <div className="arch-jenis">{k.jenis}</div>}
                {k.stack && <Chip className="chip-mono">{k.stack}</Chip>}
                {k.ket && <div className="arch-ket">{k.ket}</div>}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
