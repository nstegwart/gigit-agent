// Guide view — renders GuideData sections as .guide-sec cards.
import type { GuideData } from '#/lib/types'

export function GuideView({ guide }: { guide: GuideData }) {
  if (guide.sections.length === 0) {
    return <div style={{ color: 'var(--text-faint)' }}>No guide content.</div>
  }
  return (
    <div>
      {guide.sections.map((sec, i) => (
        <div className="guide-sec" key={i}>
          <h3>{sec.title}</h3>
          <p>{sec.body}</p>
        </div>
      ))}
    </div>
  )
}
