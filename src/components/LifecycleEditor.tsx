// Edit a board's lifecycle rail from the UI (stages + gate rules). Saves via
// set_lifecycle. Each board owns its own rail — this is the human-facing editor.
import { useState } from 'react'
import { useLifecycle, useSetLifecycle } from '#/lib/board-query'
import { Icon } from '#/lib/icons'
import type { LifecycleStage } from '#/lib/types'

const COLORS = ['indigo', 'blue', 'teal', 'green', 'amber', 'red', 'parked']
const swap = (a: Array<LifecycleStage>, i: number, j: number) => {
  const n = a.slice()
  ;[n[i], n[j]] = [n[j], n[i]]
  return n
}

export function LifecycleEditor({ onClose }: { onClose: () => void }) {
  const cfg = useLifecycle()
  const save = useSetLifecycle()
  const [rows, setRows] = useState<Array<LifecycleStage>>(() => cfg.stages.map((s) => ({ ...s })))
  const [err, setErr] = useState<string | null>(null)
  const upd = (i: number, patch: Partial<LifecycleStage>) => setRows((r) => r.map((s, j) => (j === i ? { ...s, ...patch } : s)))
  const add = () => setRows((r) => [...r, { key: '', label: '', group: 'delivery', color: 'indigo', gated: false }])
  const remove = (i: number) => setRows((r) => r.filter((_, j) => j !== i))

  const submit = () => {
    setErr(null)
    const clean = rows.map((s) => ({
      ...s,
      key: s.key.trim(),
      label: s.label.trim(),
      requiresEvidence: (s.requiresEvidence ?? []).map((x) => x.trim()).filter(Boolean),
      verifierRole: s.verifierRole?.trim() || undefined,
    }))
    save.mutate(clean, { onSuccess: onClose, onError: (e) => setErr(e instanceof Error ? e.message : String(e)) })
  }

  return (
    <div className="lc-editor-overlay" onClick={onClose}>
      <div className="lc-editor" onClick={(e) => e.stopPropagation()}>
        <div className="lc-editor-head">
          <h3>Edit lifecycle rail</h3>
          <span className="desc">stages are ordered top→bottom · gated = only via evidence/verifier receipt</span>
          <button className="lc-x" onClick={onClose} aria-label="Close">✕</button>
        </div>

        <div className="lc-rows">
          {rows.map((s, i) => (
            <div className="lc-row" key={i}>
              <div className="lc-move">
                <button disabled={i === 0} onClick={() => setRows((r) => swap(r, i, i - 1))} aria-label="Up"><Icon name="chevL" size={13} className="rot-up" /></button>
                <button disabled={i === rows.length - 1} onClick={() => setRows((r) => swap(r, i, i + 1))} aria-label="Down"><Icon name="chevL" size={13} className="rot-down" /></button>
              </div>
              <input className="lc-in lc-key" placeholder="KEY" value={s.key} onChange={(e) => upd(i, { key: e.target.value })} />
              <input className="lc-in lc-lbl" placeholder="Label" value={s.label} onChange={(e) => upd(i, { label: e.target.value })} />
              <select className="lc-in" value={s.group ?? ''} onChange={(e) => upd(i, { group: e.target.value })}>
                <option value="mapping">mapping</option>
                <option value="delivery">delivery</option>
                <option value="">—</option>
              </select>
              <select className="lc-in lc-color" value={s.color ?? 'indigo'} onChange={(e) => upd(i, { color: e.target.value })}>
                {COLORS.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
              <label className="lc-gate"><input type="checkbox" checked={!!s.gated} onChange={(e) => upd(i, { gated: e.target.checked })} /> gated</label>
              <input className="lc-in lc-verif" placeholder="verifierRole" value={s.verifierRole ?? ''} onChange={(e) => upd(i, { verifierRole: e.target.value })} disabled={!s.gated} />
              <input className="lc-in lc-ev" placeholder="requiresEvidence (csv)" value={(s.requiresEvidence ?? []).join(',')} onChange={(e) => upd(i, { requiresEvidence: e.target.value.split(',') })} disabled={!s.gated} />
              <button className="lc-del" onClick={() => remove(i)} aria-label="Remove">✕</button>
            </div>
          ))}
        </div>

        {err ? <p className="rail-err"><Icon name="alert" size={13} /> {err}</p> : null}
        <div className="lc-editor-foot">
          <button className="btn-ghost" onClick={add}><Icon name="sparkles" size={13} /> Add stage</button>
          <span style={{ flex: 1 }} />
          <button className="btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn-primary" onClick={submit} disabled={save.isPending}>{save.isPending ? 'Saving…' : 'Save rail'}</button>
        </div>
      </div>
    </div>
  )
}
