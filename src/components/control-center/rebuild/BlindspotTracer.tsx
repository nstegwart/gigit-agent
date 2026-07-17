/**
 * FAN-REBUILD / W-UI-4 — Blindspot root-cause tracer (Feature B, §3.D).
 * Full human-readable id-ID UI on Rebuild dashboard. Prop-driven; injectable fetch.
 * Direction B: StatusChip / Card / Toolbar / Button / EmptyState / Disclosure / Badge.
 */
import {
  useCallback,
  useState,
  type FormEvent,
  type InputHTMLAttributes,
} from 'react'

import type { RebuildBlindspotWire } from '#/server/control-center-rebuild-fns'
import {
  Badge,
  Button,
  Card,
  Disclosure,
  EmptyState,
  StatusChip,
  Toolbar,
  type StatusChipVariant,
} from '#/components/ui'
import styles from './rebuild.module.css'

/** Spec §3.D + owner packet W-UI-4 id-ID labels. */
export type BlindspotClassificationKey =
  | 'STAGE1_ROW_BLINDSPOT'
  | 'STAGE1_VARIANT_BLINDSPOT'
  | 'STAGE2_NOT_IMPLEMENTED'
  | 'STAGE2_PARTIAL'
  | 'L2_FALSE_POSITIVE_OR_REGRESSION'

export type BlindspotClassTone = 'blocked' | 'warn' | 'muted'

export type BlindspotClassMeta = {
  key: BlindspotClassificationKey | string
  labelId: string
  tone: BlindspotClassTone
}

const CLASS_META: Record<BlindspotClassificationKey, BlindspotClassMeta> = {
  STAGE1_ROW_BLINDSPOT: {
    key: 'STAGE1_ROW_BLINDSPOT',
    labelId: 'Tidak ada di peta — inventory kelewat',
    tone: 'blocked',
  },
  STAGE1_VARIANT_BLINDSPOT: {
    key: 'STAGE1_VARIANT_BLINDSPOT',
    labelId: 'Varian tak ke-map',
    tone: 'warn',
  },
  STAGE2_NOT_IMPLEMENTED: {
    key: 'STAGE2_NOT_IMPLEMENTED',
    labelId: 'Terpetakan, belum dibangun',
    tone: 'warn',
  },
  STAGE2_PARTIAL: {
    key: 'STAGE2_PARTIAL',
    labelId: 'Sebagian',
    tone: 'warn',
  },
  L2_FALSE_POSITIVE_OR_REGRESSION: {
    key: 'L2_FALSE_POSITIVE_OR_REGRESSION',
    labelId: 'Diklaim beres tapi mungkin rusak — audit',
    tone: 'blocked',
  },
}

export function classifyBlindspotMeta(
  classification: string | null | undefined,
): BlindspotClassMeta {
  const key = String(classification ?? '').trim() as BlindspotClassificationKey
  if (key && CLASS_META[key]) return CLASS_META[key]
  return {
    key: key || 'UNKNOWN',
    labelId: key || 'Klasifikasi tidak diketahui',
    tone: 'muted',
  }
}

export function verdictChipMeta(verdict: string | null | undefined): {
  labelId: string
  tone: 'ok' | 'warn' | 'blocked' | 'muted'
} {
  const v = (verdict ?? '').trim().toUpperCase()
  if (v === 'MAPPED_100') return { labelId: 'Terbukti', tone: 'ok' }
  if (v === 'PARTIAL') return { labelId: 'Sebagian', tone: 'warn' }
  if (v === 'MISSING') return { labelId: 'Belum ada', tone: 'blocked' }
  if (v === 'PENDING' || v === 'L0') return { labelId: 'Belum diukur', tone: 'muted' }
  if (!v) return { labelId: 'Belum diukur', tone: 'muted' }
  return { labelId: v, tone: 'muted' }
}

function classToneToVariant(tone: BlindspotClassTone): StatusChipVariant {
  if (tone === 'blocked') return 'blocked'
  if (tone === 'warn') return 'warn'
  return 'pending'
}

function verdictToneToVariant(
  tone: 'ok' | 'warn' | 'blocked' | 'muted',
): StatusChipVariant {
  if (tone === 'ok') return 'done'
  if (tone === 'warn') return 'warn'
  if (tone === 'blocked') return 'blocked'
  return 'pending'
}

/** Parse wire gaps (JSON string or raw) into display strings. */
export function parseGapsList(gaps: unknown): Array<string> {
  if (gaps == null || gaps === '') return []
  let raw: unknown = gaps
  if (typeof gaps === 'string') {
    const t = gaps.trim()
    if (!t) return []
    try {
      raw = JSON.parse(t)
    } catch {
      return [t]
    }
  }
  if (Array.isArray(raw)) {
    return raw
      .map((g) => {
        if (g == null) return ''
        if (typeof g === 'string') return g
        if (typeof g === 'object') {
          const o = g as Record<string, unknown>
          return String(o.message ?? o.gap ?? o.text ?? o.reason ?? JSON.stringify(g))
        }
        return String(g)
      })
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, 12)
  }
  if (typeof raw === 'object') {
    return [JSON.stringify(raw)].slice(0, 1)
  }
  return [String(raw)]
}

/** Parse evidence_sample into file:line display lines. */
export function parseEvidenceLines(sample: unknown): Array<string> {
  if (sample == null || sample === '') return []
  let raw: unknown = sample
  if (typeof sample === 'string') {
    const t = sample.trim()
    if (!t) return []
    try {
      raw = JSON.parse(t)
    } catch {
      // plain "path:line" or free text
      return t.split(/\n+/).map((s) => s.trim()).filter(Boolean).slice(0, 20)
    }
  }

  const lines: Array<string> = []
  const pushItem = (item: unknown) => {
    if (item == null) return
    if (typeof item === 'string') {
      const s = item.trim()
      if (s) lines.push(s)
      return
    }
    if (typeof item !== 'object') {
      lines.push(String(item))
      return
    }
    const o = item as Record<string, unknown>
    const file =
      o.file ?? o.path ?? o.anchor ?? o['anchor_path:line'] ?? o.legacy ?? o.rebuild
    if (file == null) {
      const s = JSON.stringify(o)
      if (s && s !== '{}') lines.push(s)
      return
    }
    const lineRaw = o.line ?? o.lineno ?? o.line_number
    const line =
      lineRaw == null || lineRaw === ''
        ? null
        : Number.isFinite(Number(lineRaw))
          ? Number(lineRaw)
          : null
    const side = o.side != null ? String(o.side) : o.repo != null ? String(o.repo) : null
    const base = line != null ? `${String(file)}:${line}` : String(file)
    lines.push(side ? `${side} · ${base}` : base)
  }

  if (Array.isArray(raw)) {
    for (const item of raw) pushItem(item)
  } else if (typeof raw === 'object') {
    const o = raw as Record<string, unknown>
    if (Array.isArray(o.items)) {
      for (const item of o.items) pushItem(item)
    } else if (Array.isArray(o.legacy) || Array.isArray(o.rebuild)) {
      for (const item of (o.legacy as unknown[]) ?? []) pushItem(item)
      for (const item of (o.rebuild as unknown[]) ?? []) pushItem(item)
    } else {
      pushItem(raw)
    }
  } else {
    lines.push(String(raw))
  }
  return lines.slice(0, 24)
}

function featureHref(boardId: string, featureId: string): string {
  return `/b/${encodeURIComponent(boardId)}/fitur/${encodeURIComponent(featureId)}`
}

function taskHref(boardId: string, taskId: string): string {
  return `/b/${encodeURIComponent(boardId)}/tasks/${encodeURIComponent(taskId)}`
}

export type BlindspotTracerProps = {
  boardId: string
  /** Injectable for tests; default uses /api/rebuild-parity?view=blindspot */
  onTrace?: (term: string) => Promise<unknown>
  className?: string
}

type TraceState =
  | { kind: 'idle' }
  | { kind: 'loading'; term: string }
  | { kind: 'error'; term: string; message: string }
  | { kind: 'result'; term: string; data: TraceResult }

type BlindspotMatchWire = Extract<
  RebuildBlindspotWire,
  { available: true }
>['matches'][number]

/** Client match row — wire fields + optional human title when present. */
type TraceMatch = BlindspotMatchWire & { task_title?: string | null }

type TraceAvailable = Omit<Extract<RebuildBlindspotWire, { available: true }>, 'matches'> & {
  available: true
  matches: Array<TraceMatch>
}

type TraceResult = Extract<RebuildBlindspotWire, { available: false }> | TraceAvailable

function normalizeMatch(m: unknown): TraceMatch {
  if (!m || typeof m !== 'object') {
    return {
      task_id: '',
      classification: 'STAGE1_ROW_BLINDSPOT',
      parity_verdict: null,
      origin: null,
      disposition: null,
      feature_contract_id: null,
      gaps: null,
      evidence_sample: null,
      stage1_origin: null,
      task_title: null,
    }
  }
  const o = m as Record<string, unknown>
  const strOrNull = (v: unknown) => (v == null ? null : String(v))
  const gaps =
    o.gaps == null
      ? null
      : typeof o.gaps === 'string'
        ? o.gaps
        : JSON.stringify(o.gaps)
  const evidence =
    o.evidence_sample == null
      ? null
      : typeof o.evidence_sample === 'string'
        ? o.evidence_sample
        : JSON.stringify(o.evidence_sample)
  return {
    task_id: String(o.task_id ?? o.taskId ?? ''),
    classification: String(o.classification ?? ''),
    parity_verdict: strOrNull(o.parity_verdict ?? o.parityVerdict),
    origin: strOrNull(o.origin),
    disposition: strOrNull(o.disposition),
    feature_contract_id: strOrNull(o.feature_contract_id ?? o.featureContractId),
    gaps,
    evidence_sample: evidence,
    stage1_origin: strOrNull(o.stage1_origin ?? o.stage1Origin),
    task_title: strOrNull(o.task_title ?? o.taskTitle ?? o.title_id ?? o.titleId),
  }
}

function coerceMatches(raw: unknown): Array<TraceMatch> {
  if (!Array.isArray(raw)) return []
  return raw.map((m) => normalizeMatch(m))
}

function asBlindspotWire(body: unknown): TraceResult {
  if (!body || typeof body !== 'object') {
    return {
      available: false,
      reason: 'INVALID_RESPONSE',
      tool: 'trace_blindspot',
    }
  }
  const o = body as Record<string, unknown>
  if (o.available === false) {
    return {
      available: false,
      reason: String(o.reason ?? 'UNAVAILABLE'),
      tool: 'trace_blindspot',
      error: o.error != null ? String(o.error).slice(0, 200) : undefined,
    }
  }
  // available:true or payload-shaped success
  if (
    o.available === true ||
    typeof o.matchCount === 'number' ||
    o.primary_classification != null ||
    Array.isArray(o.matches)
  ) {
    return {
      available: true,
      term: String(o.term ?? ''),
      boardId: String(o.boardId ?? ''),
      matchCount: Number(o.matchCount ?? 0),
      primary_classification: String(
        o.primary_classification ?? 'STAGE1_ROW_BLINDSPOT',
      ),
      matches: coerceMatches(o.matches),
      related_feature_ids: Array.isArray(o.related_feature_ids)
        ? o.related_feature_ids.map(String)
        : [],
      note_id: String(o.note_id ?? ''),
    }
  }
  return {
    available: false,
    reason: 'INVALID_RESPONSE',
    tool: 'trace_blindspot',
  }
}

function MatchCard({
  boardId,
  match,
}: {
  boardId: string
  match: TraceMatch
}) {
  const classMeta = classifyBlindspotMeta(match.classification)
  const verdict = verdictChipMeta(match.parity_verdict)
  const gaps = parseGapsList(match.gaps)
  const evidence = parseEvidenceLines(match.evidence_sample)
  const title =
    match.task_title && match.task_title.trim()
      ? match.task_title.trim()
      : match.task_id

  return (
    <Card
      as="article"
      data-testid="rebuild-blindspot-match"
      data-task-id={match.task_id}
      data-classification={match.classification}
    >
      <div className={styles.matchHead}>
        <a
          className={styles.matchTaskLink}
          href={taskHref(boardId, match.task_id)}
          data-testid="rebuild-blindspot-task-link"
        >
          {title}
        </a>
        {title !== match.task_id ? (
          <code className={styles.matchTaskId}>{match.task_id}</code>
        ) : null}
      </div>

      <div className={styles.matchBadges}>
        <StatusChip
          variant={classToneToVariant(classMeta.tone)}
          showDot
          data-testid="rebuild-blindspot-class-badge"
          data-tone={classMeta.tone}
          data-class={classMeta.key}
        >
          {classMeta.labelId}
        </StatusChip>
        <StatusChip
          variant={verdictToneToVariant(verdict.tone)}
          showDot
          data-testid="rebuild-blindspot-verdict-chip"
          data-tone={verdict.tone}
        >
          {verdict.labelId}
        </StatusChip>
      </div>

      {match.feature_contract_id ? (
        <p className={styles.matchMeta}>
          Kontrak:{' '}
          <Badge mono variant="neutral">
            {match.feature_contract_id}
          </Badge>
        </p>
      ) : null}

      {gaps.length > 0 ? (
        <div className={styles.gapsBlock} data-testid="rebuild-blindspot-gaps">
          <p className={styles.gapsTitle}>Gap ({gaps.length})</p>
          <ul className={styles.gapsList}>
            {gaps.map((g) => (
              <li key={g}>{g}</li>
            ))}
          </ul>
        </div>
      ) : (
        <p className={styles.matchMetaMuted} data-testid="rebuild-blindspot-gaps-empty">
          Tidak ada gap tercatat.
        </p>
      )}

      <Disclosure
        summary={`Bukti file:line${evidence.length > 0 ? ` (${evidence.length})` : ''}`}
        data-testid="rebuild-blindspot-evidence"
      >
        {evidence.length > 0 ? (
          <ul className={styles.evidenceList}>
            {evidence.map((line) => (
              <li key={line}>
                <code className={styles.monoCode}>{line}</code>
              </li>
            ))}
          </ul>
        ) : (
          <p className={styles.matchMetaMuted}>Tidak ada cuplikan bukti.</p>
        )}
      </Disclosure>

      <Disclosure summary="Detail teknis">
        <dl className={styles.techDl}>
          <dt>classification</dt>
          <dd>{match.classification || '—'}</dd>
          <dt>parity_verdict</dt>
          <dd>{match.parity_verdict ?? '—'}</dd>
          <dt>origin</dt>
          <dd>{match.origin ?? '—'}</dd>
          <dt>disposition</dt>
          <dd>{match.disposition ?? '—'}</dd>
          <dt>stage1_origin</dt>
          <dd>{match.stage1_origin ?? '—'}</dd>
        </dl>
      </Disclosure>
    </Card>
  )
}

/**
 * Full Blindspot tracer UI (search + classification results).
 */
export function BlindspotTracer({ boardId, onTrace, className }: BlindspotTracerProps) {
  const [term, setTerm] = useState('')
  const [state, setState] = useState<TraceState>({ kind: 'idle' })

  const defaultTrace = useCallback(
    async (q: string) => {
      const params = new URLSearchParams({
        view: 'blindspot',
        boardId,
        term: q,
      })
      const res = await fetch(`/api/rebuild-parity?${params.toString()}`, {
        credentials: 'same-origin',
        headers: { accept: 'application/json' },
      })
      const body = (await res.json().catch(() => null)) as unknown
      return body
    },
    [boardId],
  )

  const runTrace = useCallback(
    async (e?: FormEvent) => {
      e?.preventDefault()
      const q = term.trim()
      if (!q) return
      setState({ kind: 'loading', term: q })
      try {
        const fn = onTrace ?? defaultTrace
        const body = await fn(q)
        const wire = asBlindspotWire(body)
        setState({ kind: 'result', term: q, data: wire })
      } catch {
        setState({
          kind: 'error',
          term: q,
          message: 'Gagal menelusuri blindspot. Coba lagi nanti.',
        })
      }
    },
    [term, onTrace, defaultTrace],
  )

  const loading = state.kind === 'loading'
  const result = state.kind === 'result' ? state.data : null
  const primaryMeta =
    result && result.available
      ? classifyBlindspotMeta(result.primary_classification)
      : null

  return (
    <Card
      className={className}
      data-testid="rebuild-blindspot-tracer"
      aria-labelledby="rebuild-tracer-title"
      title={<span id="rebuild-tracer-title">Pelacak blindspot</span>}
      subtitle="Telusuri akar masalah fitur, unit, atau path legacy — klasifikasi Stage-1 / Stage-2 / regresi L2."
    >
      <p className={styles.tracerLead}>
        Telusuri akar masalah fitur, unit, atau path legacy — klasifikasi Stage-1 /
        Stage-2 / regresi L2.
      </p>

      <form className={styles.tracerForm} onSubmit={runTrace}>
        <Toolbar
          searchProps={
            {
              id: 'rebuild-blindspot-input',
              type: 'search',
              value: term,
              onChange: (e) => setTerm(e.target.value),
              placeholder: 'Telusuri akar masalah fitur…',
              autoComplete: 'off',
              'aria-label': 'Telusuri akar masalah fitur',
              'data-testid': 'rebuild-blindspot-input',
            } as InputHTMLAttributes<HTMLInputElement> & {
              'data-testid'?: string
            }
          }
          actions={
            <Button
              type="submit"
              variant="primary"
              size="md"
              disabled={loading || !term.trim()}
              data-testid="rebuild-blindspot-submit"
            >
              {loading ? 'Menelusuri…' : 'Telusuri'}
            </Button>
          }
        />
      </form>

      {state.kind === 'error' ? (
        <p className={styles.matchMetaMuted} role="alert" data-testid="rebuild-blindspot-error">
          {state.message}
        </p>
      ) : null}

      {result && !result.available ? (
        <EmptyState
          data-testid="rebuild-blindspot-unavailable"
          title="Pelacak belum tersedia"
          description={
            result.reason === 'FORBIDDEN'
              ? 'Akses ditolak untuk papan ini.'
              : result.error
                ? String(result.error)
                : 'Data lineage rebuild belum diaktifkan atau term tidak valid.'
          }
        />
      ) : null}

      {result && result.available ? (
        <div
          className={styles.tracerResult}
          data-testid="rebuild-blindspot-result"
          data-match-count={result.matchCount}
          data-primary={result.primary_classification}
        >
          <div className={styles.tracerSummary} data-testid="rebuild-blindspot-summary">
            <div className={styles.summaryRow}>
              <span className={styles.summaryCount} data-testid="rebuild-blindspot-match-count">
                {result.matchCount} cocok
              </span>
              {primaryMeta ? (
                <StatusChip
                  variant={classToneToVariant(primaryMeta.tone)}
                  showDot
                  data-testid="rebuild-blindspot-primary-badge"
                  data-tone={primaryMeta.tone}
                  data-class={primaryMeta.key}
                >
                  {primaryMeta.labelId}
                </StatusChip>
              ) : null}
            </div>
            <p className={styles.summaryNote} data-testid="rebuild-blindspot-note">
              {result.matchCount === 0
                ? 'Tidak ada entitas yang cocok di denominator lineage — kemungkinan inventory Stage-1 kelewat.'
                : result.note_id ||
                  `Klasifikasi dominan: ${primaryMeta?.labelId ?? result.primary_classification}`}
            </p>

            {(result.related_feature_ids.length > 0 || result.matches.length > 0) && (
              <div
                className={styles.relatedBlock}
                data-testid="rebuild-blindspot-related"
              >
                <p className={styles.relatedTitle}>Entitas terkait</p>
                <ul className={styles.relatedList}>
                  {result.related_feature_ids.map((fid) => (
                    <li key={`f-${fid}`}>
                      <a
                        className={styles.relatedLink}
                        href={featureHref(boardId || result.boardId, fid)}
                        data-testid="rebuild-blindspot-feature-link"
                        data-feature-id={fid}
                      >
                        <Badge variant="neutral">Fitur {fid}</Badge>
                      </a>
                    </li>
                  ))}
                  {result.matches.slice(0, 12).map((m) => {
                    if (!m.task_id) return null
                    return (
                      <li key={`t-${m.task_id}`}>
                        <a
                          className={styles.relatedLink}
                          href={taskHref(boardId || result.boardId, m.task_id)}
                          data-testid="rebuild-blindspot-related-task"
                          data-task-id={m.task_id}
                        >
                          <Badge mono variant="neutral">
                            Task {m.task_id}
                          </Badge>
                        </a>
                      </li>
                    )
                  })}
                </ul>
              </div>
            )}
          </div>

          {result.matchCount === 0 || result.matches.length === 0 ? (
            <EmptyState
              data-testid="rebuild-blindspot-no-match"
              title="Tidak ada kecocokan"
              description={
                <>
                  Term &ldquo;{result.term}&rdquo; tidak ditemukan di peta lineage.
                  Klasifikasi: <strong>{primaryMeta?.labelId}</strong> — fitur/unit ini
                  kemungkinan belum masuk inventory Stage-1 (kelewat di peta).
                </>
              }
            />
          ) : (
            <div className={styles.matchList} data-testid="rebuild-blindspot-match-list">
              {result.matches.map((m, i) => (
                <MatchCard
                  key={m.task_id || `m-${i}`}
                  boardId={boardId || result.boardId}
                  match={m}
                />
              ))}
            </div>
          )}
        </div>
      ) : null}

      {state.kind === 'idle' ? (
        <p className={styles.tracerHint} data-testid="rebuild-blindspot-idle-hint">
          Masukkan nama fitur, unit legacy, path, atau id task untuk menelusuri akar
          masalah blindspot.
        </p>
      ) : null}
    </Card>
  )
}
