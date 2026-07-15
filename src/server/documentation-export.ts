/**
 * Deterministic documentation export from pinned SSOT (01A §HUMAN DOCUMENTATION EXPORT).
 *
 * Formats: Markdown, semantic HTML, print-ready PDF (print HTML), CSV, canonical JSON.
 * Same input → same content (except declared generation time when caller omits it).
 * Never scrapes the screen or invents a second datastore — caller supplies pinned bundle.
 */

export const DOCUMENTATION_EXPORT_FORMATS = [
  'markdown',
  'html',
  'pdf',
  'csv',
  'json',
] as const

export type DocumentationExportFormat =
  (typeof DOCUMENTATION_EXPORT_FORMATS)[number]

export const DOCUMENTATION_EXPORT_SCOPES = [
  'board',
  'portfolio',
  'domain',
  'project',
  'feature',
  'flow',
  'task',
  'selected',
] as const

export type DocumentationExportScope =
  (typeof DOCUMENTATION_EXPORT_SCOPES)[number]

export type DocumentationExportCitation = {
  field: string
  path: string
  note?: string
}

export type DocumentationExportRelation = {
  fromId: string
  toId: string
  type: string
}

export type DocumentationExportEntity = {
  id: string
  kind: string
  title: string
  status?: string
  parentId?: string | null
}

export type DocumentationExportPin = {
  snapshotId: string
  sourceHash: string
  boardRev?: number
  lifecycleRev?: number
  stale?: boolean
  staleReason?: string | null
}

export type DocumentationExportBundle = {
  /** Human title for the export root (domain / feature / …). */
  title: string
  executiveSummary?: string
  scopeNotes?: {
    hold?: string[]
    exclude?: string[]
    include?: string[]
  }
  bodyMarkdown?: string
  hierarchy?: DocumentationExportEntity[]
  projects?: Array<{ id: string; name: string; status?: string }>
  features?: Array<{ id: string; name: string; status?: string }>
  flows?: Array<{ id: string; name: string; nodes?: string[] }>
  tasks?: Array<{ id: string; title: string; status?: string }>
  decisions?: Array<{ id: string; title: string }>
  blockers?: Array<{ id: string; title: string }>
  gaps?: string[]
  citations?: DocumentationExportCitation[]
  redactions?: Array<{ field: string; reason: string }>
  filters?: Record<string, unknown>
  relations?: DocumentationExportRelation[]
  statusBuckets?: Record<string, number>
  deepLinks?: Array<{ label: string; href: string }>
  technicalAppendix?: Record<string, unknown>
  knowledgeState?: 'PROVEN' | 'UNKNOWN' | 'CONFLICT' | 'STALE'
  /** DomainKnowledgeBundle domainId when scope is domain. */
  domainId?: string
}

export type DocumentationExportRequest = {
  format: DocumentationExportFormat
  scope: DocumentationExportScope
  scopeId: string
  pin: DocumentationExportPin
  bundle: DocumentationExportBundle
  /**
   * Declared generation time. When omitted, export uses a fixed sentinel so
   * repeated pure calls stay byte-identical (determinism proof). Callers that
   * need wall-clock time must pass an explicit ISO string.
   */
  generatedAt?: string
  /** Optional previous pin+bundle for human changelog + machine delta. */
  previous?: {
    pin: DocumentationExportPin
    bundle: DocumentationExportBundle
  }
}

export type DocumentationExportSuccess = {
  ok: true
  tool: 'export_documentation'
  format: DocumentationExportFormat
  mimeType: string
  filename: string
  content: string
  pin: DocumentationExportPin
  scope: DocumentationExportScope
  scopeId: string
  generatedAt: string
  deterministic: true
  redactions: Array<{ field: string; reason: string }>
  citationCount: number
  gapCount: number
  /** Present when previous snapshot was supplied. */
  changelog?: string
  delta?: {
    added: string[]
    removed: string[]
    changed: string[]
  }
}

export type DocumentationExportFailure = {
  ok: false
  tool: 'export_documentation'
  code:
    | 'INVALID_FORMAT'
    | 'INVALID_SCOPE'
    | 'MISSING_PIN'
    | 'MISSING_BUNDLE'
    | 'STALE_PIN_REFUSED'
  error: string
}

export type DocumentationExportResult =
  DocumentationExportSuccess | DocumentationExportFailure

const FIXED_GENERATED_AT = '1970-01-01T00:00:00.000Z'

const MIME: Record<DocumentationExportFormat, string> = {
  markdown: 'text/markdown; charset=utf-8',
  html: 'text/html; charset=utf-8',
  pdf: 'text/html; charset=utf-8',
  csv: 'text/csv; charset=utf-8',
  json: 'application/json; charset=utf-8',
}

const EXT: Record<DocumentationExportFormat, string> = {
  markdown: 'md',
  html: 'html',
  pdf: 'print.html',
  csv: 'csv',
  json: 'json',
}

function isFormat(v: unknown): v is DocumentationExportFormat {
  return (
    typeof v === 'string' &&
    (DOCUMENTATION_EXPORT_FORMATS as readonly string[]).includes(v)
  )
}

function isScope(v: unknown): v is DocumentationExportScope {
  return (
    typeof v === 'string' &&
    (DOCUMENTATION_EXPORT_SCOPES as readonly string[]).includes(v)
  )
}

function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeys(value))
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(obj).sort()) {
      out[k] = sortKeys(obj[k])
    }
    return out
  }
  return value
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function escapeCsv(s: string): string {
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`
  return s
}

function slugify(s: string): string {
  return (
    s
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80) || 'export'
  )
}

function entityKey(kind: string, id: string): string {
  return `${kind}:${id}`
}

function collectEntityKeys(bundle: DocumentationExportBundle): string[] {
  const keys: string[] = []
  for (const p of bundle.projects ?? []) keys.push(entityKey('project', p.id))
  for (const f of bundle.features ?? []) keys.push(entityKey('feature', f.id))
  for (const fl of bundle.flows ?? []) keys.push(entityKey('flow', fl.id))
  for (const t of bundle.tasks ?? []) keys.push(entityKey('task', t.id))
  for (const d of bundle.decisions ?? []) keys.push(entityKey('decision', d.id))
  for (const b of bundle.blockers ?? []) keys.push(entityKey('blocker', b.id))
  for (const h of bundle.hierarchy ?? []) keys.push(entityKey(h.kind, h.id))
  return keys.sort()
}

function computeDelta(
  previous: DocumentationExportBundle,
  current: DocumentationExportBundle,
): { added: string[]; removed: string[]; changed: string[] } {
  const prev = new Set(collectEntityKeys(previous))
  const curr = new Set(collectEntityKeys(current))
  const added = [...curr].filter((k) => !prev.has(k)).sort()
  const removed = [...prev].filter((k) => !curr.has(k)).sort()
  const changed: string[] = []
  // Title / status drift for shared ids (tasks only for stable surface).
  const prevTasks = new Map((previous.tasks ?? []).map((t) => [t.id, t]))
  for (const t of current.tasks ?? []) {
    const p = prevTasks.get(t.id)
    if (p && (p.title !== t.title || p.status !== t.status)) {
      changed.push(entityKey('task', t.id))
    }
  }
  return { added, removed, changed: changed.sort() }
}

function humanChangelog(
  prevPin: DocumentationExportPin,
  currPin: DocumentationExportPin,
  delta: { added: string[]; removed: string[]; changed: string[] },
): string {
  const lines = [
    '## Changelog',
    '',
    `- From snapshot \`${prevPin.snapshotId}\` (hash ${prevPin.sourceHash.slice(0, 12)}…)`,
    `- To snapshot \`${currPin.snapshotId}\` (hash ${currPin.sourceHash.slice(0, 12)}…)`,
    '',
    `Added (${delta.added.length}):`,
    ...(delta.added.length ? delta.added.map((k) => `- ${k}`) : ['- (none)']),
    '',
    `Removed (${delta.removed.length}):`,
    ...(delta.removed.length
      ? delta.removed.map((k) => `- ${k}`)
      : ['- (none)']),
    '',
    `Changed (${delta.changed.length}):`,
    ...(delta.changed.length
      ? delta.changed.map((k) => `- ${k}`)
      : ['- (none)']),
    '',
  ]
  return lines.join('\n')
}

function pinDisclosure(
  pin: DocumentationExportPin,
  generatedAt: string,
): string[] {
  return [
    '## Revision / pin',
    '',
    `- snapshotId: \`${pin.snapshotId}\``,
    `- sourceHash: \`${pin.sourceHash}\``,
    pin.boardRev != null ? `- boardRev: ${pin.boardRev}` : null,
    pin.lifecycleRev != null ? `- lifecycleRev: ${pin.lifecycleRev}` : null,
    pin.stale ? `- STALE: ${pin.staleReason ?? 'stale'}` : `- stale: false`,
    `- generatedAt: ${generatedAt}`,
    '',
  ].filter((x): x is string => x != null)
}

function redactionDisclosure(
  redactions: Array<{ field: string; reason: string }>,
): string[] {
  if (!redactions.length) {
    return [
      '## Filters / redaction disclosure',
      '',
      '- No redactions fields in this export.',
      '',
    ]
  }
  return [
    '## Filters / redaction disclosure',
    '',
    ...redactions.map((r) => `- \`${r.field}\`: ${r.reason}`),
    '',
  ]
}

function buildMarkdownSections(
  req: DocumentationExportRequest,
  generatedAt: string,
  changelog?: string,
): string {
  const { scope, scopeId, pin, bundle } = req
  const redactions = bundle.redactions ?? []
  const lines: string[] = [
    `# ${bundle.title}`,
    '',
    `_Export scope: **${scope}** · id \`${scopeId}\` · format markdown_`,
    '',
  ]

  if (bundle.executiveSummary) {
    lines.push('## Executive summary', '', bundle.executiveSummary, '')
  }

  const sn = bundle.scopeNotes
  if (sn && (sn.include?.length || sn.hold?.length || sn.exclude?.length)) {
    lines.push('## Scope / HOLD / EXCLUDE', '')
    if (sn.include?.length) {
      lines.push('### Include', ...sn.include.map((x) => `- ${x}`), '')
    }
    if (sn.hold?.length) {
      lines.push('### HOLD', ...sn.hold.map((x) => `- ${x}`), '')
    }
    if (sn.exclude?.length) {
      lines.push('### EXCLUDE', ...sn.exclude.map((x) => `- ${x}`), '')
    }
  }

  if (bundle.bodyMarkdown && bundle.bodyMarkdown.trim()) {
    lines.push('## Documentation body', '', bundle.bodyMarkdown.trim(), '')
  }

  if (bundle.hierarchy?.length) {
    lines.push(
      '## Readable hierarchy',
      '',
      ...bundle.hierarchy.map(
        (h) =>
          `- [${h.kind}] **${h.title}** (\`${h.id}\`)${h.status ? ` — ${h.status}` : ''}${
            h.parentId ? ` · parent \`${h.parentId}\`` : ''
          }`,
      ),
      '',
    )
  }

  if (bundle.projects?.length) {
    lines.push(
      '## Projects',
      '',
      ...bundle.projects.map(
        (p) => `- ${p.name} (\`${p.id}\`)${p.status ? ` — ${p.status}` : ''}`,
      ),
      '',
    )
  }

  if (bundle.features?.length) {
    lines.push(
      '## Features',
      '',
      ...bundle.features.map(
        (f) => `- ${f.name} (\`${f.id}\`)${f.status ? ` — ${f.status}` : ''}`,
      ),
      '',
    )
  }

  if (bundle.flows?.length) {
    lines.push('## End-to-end flows / outcomes', '')
    for (const fl of bundle.flows) {
      lines.push(`### ${fl.name} (\`${fl.id}\`)`)
      if (fl.nodes?.length) {
        lines.push(...fl.nodes.map((n, i) => `${i + 1}. ${n}`))
      }
      lines.push('')
    }
  }

  if (bundle.statusBuckets && Object.keys(bundle.statusBuckets).length) {
    const keys = Object.keys(bundle.statusBuckets).sort()
    lines.push(
      '## Current status buckets / readiness',
      '',
      ...keys.map((k) => `- ${k}: ${bundle.statusBuckets![k]}`),
      '',
    )
  }

  if (bundle.tasks?.length) {
    lines.push(
      '## Tasks',
      '',
      ...bundle.tasks.map(
        (t) => `- ${t.title} (\`${t.id}\`)${t.status ? ` — ${t.status}` : ''}`,
      ),
      '',
    )
  }

  if (bundle.blockers?.length) {
    lines.push(
      '## Blockers',
      '',
      ...bundle.blockers.map((b) => `- ${b.title} (\`${b.id}\`)`),
      '',
    )
  }

  if (bundle.decisions?.length) {
    lines.push(
      '## Decisions',
      '',
      ...bundle.decisions.map((d) => `- ${d.title} (\`${d.id}\`)`),
      '',
    )
  }

  if (bundle.relations?.length) {
    lines.push(
      '## Dependencies / relations',
      '',
      ...bundle.relations.map(
        (r) => `- \`${r.fromId}\` —[${r.type}]→ \`${r.toId}\``,
      ),
      '',
    )
  }

  if (bundle.gaps?.length) {
    lines.push('## Gaps', '', ...bundle.gaps.map((g) => `- ${g}`), '')
  }

  if (bundle.citations?.length) {
    lines.push(
      '## Evidence / citations',
      '',
      ...bundle.citations.map(
        (c) => `- \`${c.path}\` · ${c.field}${c.note ? ` — ${c.note}` : ''}`,
      ),
      '',
    )
  }

  lines.push(...pinDisclosure(pin, generatedAt))
  lines.push(...redactionDisclosure(redactions))

  if (bundle.filters && Object.keys(bundle.filters).length) {
    lines.push(
      '## Applied filters',
      '',
      '```json',
      stableStringify(bundle.filters),
      '```',
      '',
    )
  }

  if (bundle.deepLinks?.length) {
    lines.push(
      '## Deep links',
      '',
      ...bundle.deepLinks.map((d) => `- [${d.label}](${d.href})`),
      '',
    )
  }

  if (
    bundle.technicalAppendix &&
    Object.keys(bundle.technicalAppendix).length
  ) {
    lines.push(
      '## Technical appendix',
      '',
      '```json',
      stableStringify(bundle.technicalAppendix),
      '```',
      '',
    )
  }

  if (changelog) {
    lines.push(changelog)
  }

  lines.push(
    '---',
    '',
    `_export_documentation · deterministic · pin ${pin.snapshotId}_`,
    '',
  )

  return lines.join('\n')
}

function markdownToSemanticHtml(
  md: string,
  title: string,
  printReady: boolean,
): string {
  // Minimal deterministic markdown→HTML (headings, lists, code, paragraphs, hr, emphasis).
  const blocks = md.replace(/\r\n/g, '\n').split('\n')
  const htmlParts: string[] = []
  let inUl = false
  let inOl = false
  let inPre = false
  let preLines: string[] = []

  const closeLists = () => {
    if (inUl) {
      htmlParts.push('</ul>')
      inUl = false
    }
    if (inOl) {
      htmlParts.push('</ol>')
      inOl = false
    }
  }

  const inline = (s: string): string => {
    let t = escapeHtml(s)
    t = t.replace(/`([^`]+)`/g, '<code>$1</code>')
    t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    t = t.replace(/_([^_]+)_/g, '<em>$1</em>')
    t = t.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>')
    return t
  }

  for (const raw of blocks) {
    const line = raw
    if (line.startsWith('```')) {
      if (inPre) {
        htmlParts.push(
          `<pre><code>${escapeHtml(preLines.join('\n'))}</code></pre>`,
        )
        preLines = []
        inPre = false
      } else {
        closeLists()
        inPre = true
      }
      continue
    }
    if (inPre) {
      preLines.push(line)
      continue
    }

    if (line.trim() === '---') {
      closeLists()
      htmlParts.push('<hr />')
      continue
    }

    const h = /^(#{1,6})\s+(.*)$/.exec(line)
    if (h) {
      closeLists()
      const level = h[1].length
      htmlParts.push(`<h${level}>${inline(h[2])}</h${level}>`)
      continue
    }

    const ul = /^[-*]\s+(.*)$/.exec(line)
    if (ul) {
      if (inOl) {
        htmlParts.push('</ol>')
        inOl = false
      }
      if (!inUl) {
        htmlParts.push('<ul>')
        inUl = true
      }
      htmlParts.push(`<li>${inline(ul[1])}</li>`)
      continue
    }

    const ol = /^(\d+)\.\s+(.*)$/.exec(line)
    if (ol) {
      if (inUl) {
        htmlParts.push('</ul>')
        inUl = false
      }
      if (!inOl) {
        htmlParts.push('<ol>')
        inOl = true
      }
      htmlParts.push(`<li>${inline(ol[2])}</li>`)
      continue
    }

    if (line.trim() === '') {
      closeLists()
      continue
    }

    closeLists()
    htmlParts.push(`<p>${inline(line)}</p>`)
  }
  closeLists()
  if (inPre) {
    htmlParts.push(`<pre><code>${escapeHtml(preLines.join('\n'))}</code></pre>`)
  }

  const printCss = printReady
    ? `@media print { body { font-size: 11pt; } a[href]::after { content: " (" attr(href) ")"; font-size: 0.85em; } .no-print { display: none; } }`
    : ''

  return [
    '<!DOCTYPE html>',
    '<html lang="id">',
    '<head>',
    '<meta charset="utf-8" />',
    `<title>${escapeHtml(title)}</title>`,
    '<meta name="viewport" content="width=device-width, initial-scale=1" />',
    `<style>
body { font-family: system-ui, sans-serif; line-height: 1.5; max-width: 52rem; margin: 1.5rem auto; padding: 0 1rem; color: #111; }
h1,h2,h3,h4 { line-height: 1.25; }
code, pre { font-family: ui-monospace, monospace; font-size: 0.92em; }
pre { background: #f4f5f7; padding: 0.75rem 1rem; overflow-x: auto; border-radius: 6px; }
ul, ol { padding-left: 1.4rem; }
hr { border: none; border-top: 1px solid #ccc; margin: 2rem 0; }
a { color: #0b57d0; }
${printCss}
</style>`,
    '</head>',
    '<body>',
    printReady
      ? '<p class="no-print"><em>Print-ready export — use browser Print → Save as PDF.</em></p>'
      : '',
    `<article data-export="documentation">`,
    ...htmlParts,
    '</article>',
    '</body>',
    '</html>',
    '',
  ].join('\n')
}

function buildCsv(
  req: DocumentationExportRequest,
  generatedAt: string,
): string {
  const { pin, bundle, scope, scopeId } = req
  const header = [
    'row_type',
    'id',
    'title',
    'status',
    'parent_id',
    'relation_type',
    'to_id',
    'path',
    'field',
    'note',
    'snapshot_id',
    'source_hash',
    'board_rev',
    'lifecycle_rev',
    'scope',
    'scope_id',
    'generated_at',
  ]
  const rows: string[][] = []

  const pinCols = [
    pin.snapshotId,
    pin.sourceHash,
    pin.boardRev != null ? String(pin.boardRev) : '',
    pin.lifecycleRev != null ? String(pin.lifecycleRev) : '',
    scope,
    scopeId,
    generatedAt,
  ]

  const push = (cols: string[]) => {
    rows.push([...cols, ...pinCols])
  }

  push([
    'meta',
    scopeId,
    bundle.title,
    bundle.knowledgeState ?? '',
    '',
    '',
    '',
    '',
    '',
    '',
  ])

  for (const p of bundle.projects ?? []) {
    push(['project', p.id, p.name, p.status ?? '', '', '', '', '', '', ''])
  }
  for (const f of bundle.features ?? []) {
    push(['feature', f.id, f.name, f.status ?? '', '', '', '', '', '', ''])
  }
  for (const fl of bundle.flows ?? []) {
    push([
      'flow',
      fl.id,
      fl.name,
      '',
      '',
      '',
      '',
      '',
      '',
      (fl.nodes ?? []).join(' > '),
    ])
  }
  for (const t of bundle.tasks ?? []) {
    push(['task', t.id, t.title, t.status ?? '', '', '', '', '', '', ''])
  }
  for (const d of bundle.decisions ?? []) {
    push(['decision', d.id, d.title, '', '', '', '', '', '', ''])
  }
  for (const b of bundle.blockers ?? []) {
    push(['blocker', b.id, b.title, '', '', '', '', '', '', ''])
  }
  for (const h of bundle.hierarchy ?? []) {
    push([
      'hierarchy',
      h.id,
      h.title,
      h.status ?? '',
      h.parentId ?? '',
      h.kind,
      '',
      '',
      '',
      '',
    ])
  }
  for (const r of bundle.relations ?? []) {
    push(['relation', r.fromId, '', '', '', r.type, r.toId, '', '', ''])
  }
  for (const c of bundle.citations ?? []) {
    push([
      'citation',
      '',
      c.note ?? '',
      '',
      '',
      '',
      '',
      c.path,
      c.field,
      c.note ?? '',
    ])
  }
  for (const g of bundle.gaps ?? []) {
    push(['gap', '', g, '', '', '', '', '', '', ''])
  }
  for (const r of bundle.redactions ?? []) {
    push(['redaction', '', r.reason, '', '', '', '', '', r.field, r.reason])
  }

  return (
    [header, ...rows].map((r) => r.map(escapeCsv).join(',')).join('\n') + '\n'
  )
}

function buildJson(
  req: DocumentationExportRequest,
  generatedAt: string,
  delta?: { added: string[]; removed: string[]; changed: string[] },
  changelog?: string,
): string {
  const payload = {
    tool: 'export_documentation',
    format: 'json' as const,
    scope: req.scope,
    scopeId: req.scopeId,
    pin: req.pin,
    generatedAt,
    deterministic: true as const,
    title: req.bundle.title,
    domainId: req.bundle.domainId ?? null,
    knowledgeState: req.bundle.knowledgeState ?? null,
    executiveSummary: req.bundle.executiveSummary ?? null,
    scopeNotes: req.bundle.scopeNotes ?? null,
    bodyMarkdown: req.bundle.bodyMarkdown ?? null,
    hierarchy: req.bundle.hierarchy ?? [],
    projects: req.bundle.projects ?? [],
    features: req.bundle.features ?? [],
    flows: req.bundle.flows ?? [],
    tasks: req.bundle.tasks ?? [],
    decisions: req.bundle.decisions ?? [],
    blockers: req.bundle.blockers ?? [],
    relations: req.bundle.relations ?? [],
    statusBuckets: req.bundle.statusBuckets ?? {},
    gaps: req.bundle.gaps ?? [],
    citations: req.bundle.citations ?? [],
    redactions: req.bundle.redactions ?? [],
    filters: req.bundle.filters ?? {},
    deepLinks: req.bundle.deepLinks ?? [],
    technicalAppendix: req.bundle.technicalAppendix ?? {},
    changelog: changelog ?? null,
    delta: delta ?? null,
  }
  return `${stableStringify(payload)}\n`
}

/**
 * Build a DocumentationExportBundle from the control-center documentation domain view.
 * Pure — used by DocumentationDomainScreen client export and tests.
 */
export function bundleFromDocumentationDomainView(view: {
  domain: string
  title: string
  bodyMarkdown: string
  citations: ReadonlyArray<{ field: string; path: string; note?: string }>
  gaps: ReadonlyArray<string>
  pin: {
    canonicalSnapshotId: string
    canonicalHash: string
    boardRev: number
    lifecycleRev: number
    stale: boolean
    staleReason: string | null
  } | null
  availability: string
}): { pin: DocumentationExportPin; bundle: DocumentationExportBundle } | null {
  if (!view.pin) return null
  return {
    pin: {
      snapshotId: view.pin.canonicalSnapshotId,
      sourceHash: view.pin.canonicalHash,
      boardRev: view.pin.boardRev,
      lifecycleRev: view.pin.lifecycleRev,
      stale: view.pin.stale,
      staleReason: view.pin.staleReason,
    },
    bundle: {
      title: view.title,
      domainId: view.domain,
      bodyMarkdown: view.bodyMarkdown,
      citations: view.citations.map((c) => ({
        field: c.field,
        path: c.path,
        note: c.note,
      })),
      gaps: [...view.gaps],
      knowledgeState:
        view.availability === 'available'
          ? 'PROVEN'
          : view.availability === 'partial'
            ? 'UNKNOWN'
            : 'UNKNOWN',
    },
  }
}

/**
 * Deterministic multi-format documentation export (MCP + UI shared).
 * Prefer `exportDocumentation` name for callers; `export_documentation` alias for MCP tool parity.
 */
export function exportDocumentation(
  req: DocumentationExportRequest,
): DocumentationExportResult {
  const runtimeRequest: unknown = req
  if (!runtimeRequest || typeof runtimeRequest !== 'object') {
    return {
      ok: false,
      tool: 'export_documentation',
      code: 'MISSING_BUNDLE',
      error: 'export request required',
    }
  }
  if (!isFormat(req.format)) {
    return {
      ok: false,
      tool: 'export_documentation',
      code: 'INVALID_FORMAT',
      error: `format must be one of ${DOCUMENTATION_EXPORT_FORMATS.join(', ')}`,
    }
  }
  if (!isScope(req.scope)) {
    return {
      ok: false,
      tool: 'export_documentation',
      code: 'INVALID_SCOPE',
      error: `scope must be one of ${DOCUMENTATION_EXPORT_SCOPES.join(', ')}`,
    }
  }
  const runtimePin = (req as Partial<DocumentationExportRequest>).pin
  if (!runtimePin?.snapshotId || !runtimePin.sourceHash) {
    return {
      ok: false,
      tool: 'export_documentation',
      code: 'MISSING_PIN',
      error: 'pin.snapshotId and pin.sourceHash required (pinned SSOT only)',
    }
  }
  const runtimeBundle = (req as Partial<DocumentationExportRequest>).bundle
  if (
    !runtimeBundle ||
    typeof runtimeBundle.title !== 'string' ||
    !runtimeBundle.title.trim()
  ) {
    return {
      ok: false,
      tool: 'export_documentation',
      code: 'MISSING_BUNDLE',
      error: 'bundle.title required',
    }
  }
  if (req.pin.stale === true) {
    return {
      ok: false,
      tool: 'export_documentation',
      code: 'STALE_PIN_REFUSED',
      error: `stale pin refused: ${req.pin.staleReason ?? 'STALE'}`,
    }
  }

  const generatedAt = req.generatedAt ?? FIXED_GENERATED_AT
  const redactions = req.bundle.redactions ?? []
  const citations = req.bundle.citations ?? []
  const gaps = req.bundle.gaps ?? []

  let delta:
    { added: string[]; removed: string[]; changed: string[] } | undefined
  let changelog: string | undefined
  if (req.previous) {
    delta = computeDelta(req.previous.bundle, req.bundle)
    changelog = humanChangelog(req.previous.pin, req.pin, delta)
  }

  const md = buildMarkdownSections(req, generatedAt, changelog)
  let content: string
  switch (req.format) {
    case 'markdown':
      content = md
      break
    case 'html':
      content = markdownToSemanticHtml(md, req.bundle.title, false)
      break
    case 'pdf':
      content = markdownToSemanticHtml(md, req.bundle.title, true)
      break
    case 'csv':
      content = buildCsv(req, generatedAt)
      break
    case 'json':
      content = buildJson(req, generatedAt, delta, changelog)
      break
  }

  const filename = `doc-${req.scope}-${slugify(req.scopeId)}-${slugify(req.pin.snapshotId)}.${EXT[req.format]}`

  return {
    ok: true,
    tool: 'export_documentation',
    format: req.format,
    mimeType: MIME[req.format],
    filename,
    content,
    pin: req.pin,
    scope: req.scope,
    scopeId: req.scopeId,
    generatedAt,
    deterministic: true,
    redactions,
    citationCount: citations.length,
    gapCount: gaps.length,
    ...(changelog ? { changelog } : {}),
    ...(delta ? { delta } : {}),
  }
}

/** MCP tool name alias — same implementation as exportDocumentation. */
export const export_documentation = exportDocumentation

export function isDocumentationExportFormat(
  v: unknown,
): v is DocumentationExportFormat {
  return isFormat(v)
}

export function isDocumentationExportScope(
  v: unknown,
): v is DocumentationExportScope {
  return isScope(v)
}
