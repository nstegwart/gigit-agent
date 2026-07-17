#!/usr/bin/env node
/**
 * Plain-language (id-ID) release-blocking lint gate.
 *
 * Spec: 01A §PLAIN-LANGUAGE RELEASE GATE
 * Blocks:
 *   - title starts with ID / FC / repository / Parity / Integration closure / Map
 *   - unexplained acronym / jargon
 *   - raw enum / snake_case as owner-primary copy
 *   - vague "integration/parity/mapping/fix/closure" without observable outcome
 *   - duplicated boilerplate
 *   - missing humanDisplay fields
 *   - unsupported certainty / percent / timing claims
 *   - excessive length
 *   - placeholder, uncited, fabricated, or stale content
 * Exceptions require reason, reviewer, expiry, and audit — no blanket suppression.
 *
 * Usage:
 *   node scripts/plain-language-lint.mjs --self-test
 *   node scripts/plain-language-lint.mjs --json [--fixture path|stdin]
 *   node scripts/plain-language-lint.mjs --lint-file <json>
 *
 * Exit 0 = pass (or self-test pass). Exit 1 = lint findings / self-test fail. Exit 2 = usage.
 */

import { readFileSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
export const REPO_ROOT = resolve(__dirname, '..')

export const LINT_SCHEMA_VERSION = 'TM_PLAIN_LANGUAGE_LINT_V1'
export const DEFAULT_LOCALE = 'id-ID'

/** Compact HumanDisplayV1 required copy fields (src/server/human-display.ts). */
export const REQUIRED_COPY_FIELDS = Object.freeze([
  'title',
  'outcome',
  'why',
  'current',
  'remaining',
  'next',
  'doneWhen',
  'blocker',
  'ownerAction',
])

/** ART long-name aliases accepted as equivalent to compact fields. */
export const FIELD_ALIASES = Object.freeze({
  whyItMatters: 'why',
  currentState: 'current',
  remainingWork: 'remaining',
  nextAction: 'next',
  blockerSummary: 'blocker',
})

export const REQUIRED_ART_BINDINGS = Object.freeze([
  'parentFeatureTitle',
  'businessArea',
  'actor',
])

export const MAX_TITLE_CHARS = 120
export const MAX_FIELD_CHARS = 600
export const MAX_OUTCOME_CHARS = 800

/** Debt title prefixes (align with lintHumanTitle in human-display.ts). */
export const TITLE_LINT_CODES = Object.freeze([
  'EMPTY',
  'STARTS_WITH_ID',
  'STARTS_WITH_FC',
  'STARTS_WITH_PARITY',
  'STARTS_WITH_INTEGRATION_CLOSURE',
  'STARTS_WITH_MAP',
  'STARTS_WITH_REPOISH',
])

/** Known orchestration / domain jargon that must not appear raw as owner primary. */
export const JARGON_TOKENS = Object.freeze([
  'MCP',
  'SSR',
  'RBAC',
  'CSRF',
  'SHA',
  'TTL',
  'SLA',
  'ETA',
  'POC',
  'WIP',
  'DTO',
  'ORM',
  'JWT',
  'OAuth',
  'webhook',
  'readback',
  'heartbeat',
  'worktree',
  'snapshotId',
  'sourceHash',
  'boardRev',
  'lifecycleRev',
  'humanDisplay',
  'CONTROL_PLANE',
  'CONTENT_REVIEW_REQUIRED',
  'GENERATED_NEEDS_REVIEW',
  'BLOCKED_MISSING_SOURCE',
  'RECONCILIATION_PENDING',
])

/** Vague tokens that need an observable outcome nearby (title/outcome). */
export const VAGUE_TOKENS = Object.freeze([
  'integration',
  'parity',
  'mapping',
  'fix',
  'closure',
  'integrate',
  'refactor',
  'cleanup',
  'misc',
  'various',
  'stuff',
  'things',
])

const PLACEHOLDER_RE =
  /\b(TODO|FIXME|TBD|XXX|PLACEHOLDER|lorem\s+ipsum|n\/a\s+pending|coming soon|fill me|hapus ini|ganti ini)\b/i

const RAW_SNAKE_RE = /\b[a-z][a-z0-9]*(_[a-z0-9]+){1,}\b/
const RAW_ENUM_RE = /\b[A-Z][A-Z0-9]*(_[A-Z0-9]+){1,}\b/
const UNSUPPORTED_CERTAINTY_RE =
  /\b(100\s*%\s*(sure|yakin|complete|done)|pasti\s*100|~?\d{1,3}\s*%\s*(done|selesai|complete)|ETA\s*[:\-]?\s*\d|probably\s+done|maybe\s+done|kira[- ]kira\s*selesai)\b/i
const HASHISH_RE = /\b[a-f0-9]{32,64}\b/i
const FABRICATED_RE =
  /\b(fabricated|invented|asumsi tanpa sumber|dibuat-buat|hand-typed PASS|fictional)\b/i

const REPOISH_START_RE =
  /^(sales-rebuild|rebuild-backend|affiliate-rebuild|mfs-web|mfs-web-original-upgrade)\b/i

/**
 * @typedef {{
 *   code: string,
 *   field?: string,
 *   message: string,
 *   severity: 'error' | 'warn',
 *   sample?: string,
 * }} LintFinding
 */

/**
 * @typedef {{
 *   ok: boolean,
 *   schemaVersion: string,
 *   findings: LintFinding[],
 *   suppressed: LintFinding[],
 *   entityId?: string | null,
 * }} LintResult
 */

/**
 * Normalize a partial humanDisplay record: map ART long names → compact.
 * @param {Record<string, unknown> | null | undefined} raw
 * @returns {Record<string, unknown> | null}
 */
export function normalizeHumanDisplay(raw) {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) return null
  /** @type {Record<string, unknown>} */
  const out = { ...raw }
  for (const [alias, compact] of Object.entries(FIELD_ALIASES)) {
    if (
      (out[compact] == null || out[compact] === '') &&
      typeof out[alias] === 'string'
    ) {
      out[compact] = out[alias]
    }
  }
  return out
}

/**
 * Title quality floor — mirrors lintHumanTitle + release-gate expansions.
 * @param {string | null | undefined} title
 * @returns {{ ok: boolean, codes: string[] }}
 */
export function lintTitle(title) {
  if (title == null || String(title).trim() === '') {
    return { ok: false, codes: ['EMPTY'] }
  }
  const t = String(title).trim()
  /** @type {string[]} */
  const codes = []
  if (/^T-[A-Z0-9-]+/i.test(t) || /^[A-Z]+-\d+/.test(t)) codes.push('STARTS_WITH_ID')
  if (/^\[?FC-/i.test(t) || /^FC\b/i.test(t)) codes.push('STARTS_WITH_FC')
  if (/^parity\b/i.test(t)) codes.push('STARTS_WITH_PARITY')
  if (/^integration(\/|\s+)?closure\b/i.test(t)) {
    codes.push('STARTS_WITH_INTEGRATION_CLOSURE')
  }
  if (/^map\b/i.test(t)) codes.push('STARTS_WITH_MAP')
  if (REPOISH_START_RE.test(t)) codes.push('STARTS_WITH_REPOISH')
  return { ok: codes.length === 0, codes }
}

/**
 * @param {string} field
 * @param {string} text
 * @param {{ isTitle?: boolean }} [opts]
 * @returns {LintFinding[]}
 */
export function lintTextField(field, text, opts = {}) {
  /** @type {LintFinding[]} */
  const findings = []
  const t = String(text ?? '')
  const trimmed = t.trim()
  if (!trimmed) return findings

  const max =
    field === 'title'
      ? MAX_TITLE_CHARS
      : field === 'outcome'
        ? MAX_OUTCOME_CHARS
        : MAX_FIELD_CHARS
  if (trimmed.length > max) {
    findings.push({
      code: 'EXCESSIVE_LENGTH',
      field,
      severity: 'error',
      message: `${field} exceeds ${max} characters (${trimmed.length})`,
      sample: trimmed.slice(0, 80),
    })
  }

  if (PLACEHOLDER_RE.test(trimmed)) {
    findings.push({
      code: 'PLACEHOLDER',
      field,
      severity: 'error',
      message: `${field} contains placeholder / TODO-style content`,
      sample: trimmed.slice(0, 80),
    })
  }

  if (FABRICATED_RE.test(trimmed)) {
    findings.push({
      code: 'FABRICATED',
      field,
      severity: 'error',
      message: `${field} contains fabricated/invented markers`,
      sample: trimmed.slice(0, 80),
    })
  }

  // Raw SCREAMING_SNAKE enums (allow common Indonesian phrases? none match this pattern)
  const enumHits = trimmed.match(new RegExp(RAW_ENUM_RE.source, 'g')) ?? []
  // Allow short all-caps words that are not snake (handled by JARGON separately)
  for (const hit of enumHits) {
    // Single token without underscore already excluded by RAW_ENUM_RE requiring _
    findings.push({
      code: 'RAW_ENUM',
      field,
      severity: 'error',
      message: `${field} exposes raw enum/token "${hit}"`,
      sample: hit,
    })
  }

  const snakeHits = trimmed.match(new RegExp(RAW_SNAKE_RE.source, 'g')) ?? []
  for (const hit of snakeHits) {
    // Skip common non-technical underscores in id-ID? none expected.
    findings.push({
      code: 'RAW_SNAKE_CASE',
      field,
      severity: 'error',
      message: `${field} exposes raw snake_case "${hit}"`,
      sample: hit,
    })
  }

  if (UNSUPPORTED_CERTAINTY_RE.test(trimmed)) {
    findings.push({
      code: 'UNSUPPORTED_CERTAINTY',
      field,
      severity: 'error',
      message: `${field} contains unsupported certainty/percent/timing claim`,
      sample: trimmed.slice(0, 80),
    })
  }

  // Long hex hashes must not appear in owner primary copy
  if (HASHISH_RE.test(trimmed)) {
    findings.push({
      code: 'RAW_HASH',
      field,
      severity: 'error',
      message: `${field} contains raw hash-like token`,
      sample: (trimmed.match(HASHISH_RE) ?? [''])[0].slice(0, 16) + '…',
    })
  }

  // Jargon / unexplained acronyms (token boundary)
  for (const token of JARGON_TOKENS) {
    const re = new RegExp(`\\b${escapeRegExp(token)}\\b`, 'i')
    if (re.test(trimmed)) {
      findings.push({
        code: 'UNEXPLAINED_JARGON',
        field,
        severity: 'error',
        message: `${field} contains unexplained jargon/acronym "${token}"`,
        sample: token,
      })
    }
  }

  // Vague without observable outcome (title + outcome only)
  if (opts.isTitle || field === 'title' || field === 'outcome') {
    const lower = trimmed.toLowerCase()
    const hasVague = VAGUE_TOKENS.some((v) => {
      const re = new RegExp(`\\b${escapeRegExp(v)}\\b`, 'i')
      return re.test(lower)
    })
    if (hasVague) {
      // Observable outcome heuristics: concrete verbs / user-visible nouns (id-ID + en)
      const hasObservable =
        /\b(menampilkan|memastikan|mencegah|memperbarui|mencabut|pelanggan|pengguna|harga|tagihan|checkout|sesi|login|komisi|pembayaran|user|customer|invoice|price|session|token|revoke|display|show|prevent)\b/i.test(
          trimmed,
        ) || trimmed.split(/\s+/).length >= 6
      // Short vague-only titles like "Parity fix" / "Integration closure" fail
      if (!hasObservable || trimmed.split(/\s+/).length < 4) {
        findings.push({
          code: 'VAGUE_WITHOUT_OUTCOME',
          field,
          severity: 'error',
          message: `${field} uses vague integration/parity/mapping/fix/closure language without a concrete observable outcome`,
          sample: trimmed.slice(0, 80),
        })
      }
    }
  }

  return findings
}

/**
 * Validate a single exception entry. Blanket suppressions are rejected.
 * @param {unknown} exception
 * @returns {{ ok: boolean, findings: LintFinding[] }}
 */
export function validateException(exception) {
  /** @type {LintFinding[]} */
  const findings = []
  if (exception == null || typeof exception !== 'object' || Array.isArray(exception)) {
    findings.push({
      code: 'INVALID_EXCEPTION',
      severity: 'error',
      message: 'exception must be an object with reason, reviewer, expiry, audit',
    })
    return { ok: false, findings }
  }
  const ex = /** @type {Record<string, unknown>} */ (exception)
  for (const key of ['reason', 'reviewer', 'expiry', 'audit']) {
    if (ex[key] == null || String(ex[key]).trim() === '') {
      findings.push({
        code: 'INVALID_EXCEPTION',
        severity: 'error',
        message: `exception missing required "${key}"`,
      })
    }
  }
  if (ex.blanket === true || ex.all === true || ex.codes === '*') {
    findings.push({
      code: 'BLANKET_SUPPRESSION',
      severity: 'error',
      message: 'blanket exception suppression is forbidden',
    })
  }
  if (typeof ex.expiry === 'string' && ex.expiry.trim()) {
    const exp = Date.parse(ex.expiry)
    if (Number.isNaN(exp)) {
      findings.push({
        code: 'INVALID_EXCEPTION',
        severity: 'error',
        message: `exception.expiry is not a parseable date: ${ex.expiry}`,
      })
    } else if (exp < Date.now()) {
      findings.push({
        code: 'EXPIRED_EXCEPTION',
        severity: 'error',
        message: `exception expired at ${ex.expiry}`,
      })
    }
  }
  return { ok: findings.length === 0, findings }
}

/**
 * @param {unknown} display
 * @param {{
 *   now?: number,
 *   exceptions?: unknown[],
 *   peerDisplays?: unknown[],
 * }} [opts]
 * @returns {LintResult}
 */
export function lintHumanDisplay(display, opts = {}) {
  /** @type {LintFinding[]} */
  const findings = []
  /** @type {LintFinding[]} */
  const suppressed = []

  if (display == null) {
    return {
      ok: false,
      schemaVersion: LINT_SCHEMA_VERSION,
      findings: [
        {
          code: 'MISSING_HUMAN_DISPLAY',
          severity: 'error',
          message: 'humanDisplay is missing (null/undefined)',
        },
      ],
      suppressed: [],
      entityId: null,
    }
  }

  const d = normalizeHumanDisplay(/** @type {Record<string, unknown>} */ (display))
  if (!d) {
    return {
      ok: false,
      schemaVersion: LINT_SCHEMA_VERSION,
      findings: [
        {
          code: 'MISSING_HUMAN_DISPLAY',
          severity: 'error',
          message: 'humanDisplay is not an object',
        },
      ],
      suppressed: [],
      entityId: null,
    }
  }

  const entityId =
    d.entityId != null ? String(d.entityId) : d.id != null ? String(d.id) : null

  // Required copy fields
  for (const field of REQUIRED_COPY_FIELDS) {
    if (!(field in d) || d[field] == null) {
      findings.push({
        code: 'MISSING_REQUIRED_FIELD',
        field,
        severity: 'error',
        message: `missing required humanDisplay field "${field}"`,
      })
    } else if (typeof d[field] === 'string' && String(d[field]).trim() === '') {
      findings.push({
        code: 'EMPTY_REQUIRED_FIELD',
        field,
        severity: 'error',
        message: `required humanDisplay field "${field}" is empty`,
      })
    }
  }

  // ART bindings (fail closed for owner primary completeness)
  for (const field of REQUIRED_ART_BINDINGS) {
    if (!(field in d) || d[field] == null || String(d[field]).trim() === '') {
      findings.push({
        code: 'MISSING_ART_BINDING',
        field,
        severity: 'error',
        message: `missing ART binding "${field}"`,
      })
    }
  }

  // Locale
  if (d.locale != null && String(d.locale) !== DEFAULT_LOCALE) {
    findings.push({
      code: 'INVALID_LOCALE',
      field: 'locale',
      severity: 'error',
      message: `locale must be ${DEFAULT_LOCALE} for release gate (got ${d.locale})`,
      sample: String(d.locale),
    })
  }

  // Title start-token ban
  if (typeof d.title === 'string') {
    const titleLint = lintTitle(d.title)
    for (const code of titleLint.codes) {
      findings.push({
        code,
        field: 'title',
        severity: 'error',
        message: `title lint: ${code}`,
        sample: String(d.title).slice(0, 80),
      })
    }
  }

  // Per-field text lint
  for (const field of REQUIRED_COPY_FIELDS) {
    if (typeof d[field] === 'string' && String(d[field]).trim() !== '') {
      findings.push(
        ...lintTextField(field, String(d[field]), { isTitle: field === 'title' }),
      )
    }
  }
  for (const field of REQUIRED_ART_BINDINGS) {
    if (typeof d[field] === 'string' && String(d[field]).trim() !== '') {
      // parentFeatureTitle must not be only an FC alias
      if (field === 'parentFeatureTitle') {
        const p = String(d[field]).trim()
        if (/^\[?FC-/i.test(p) || /^T-[A-Z0-9-]+/i.test(p)) {
          findings.push({
            code: 'TECHNICAL_FEATURE_ALIAS',
            field,
            severity: 'error',
            message: 'parentFeatureTitle must be a human feature name, not FC/ID alias',
            sample: p.slice(0, 80),
          })
        }
      }
      findings.push(...lintTextField(field, String(d[field])))
    }
  }

  // Intra-record boilerplate: identical non-trivial prose across copy fields
  const fieldTexts = REQUIRED_COPY_FIELDS.map((f) => ({
    field: f,
    text: typeof d[f] === 'string' ? String(d[f]).trim().toLowerCase() : '',
  })).filter((x) => x.text.length >= 24)
  for (let i = 0; i < fieldTexts.length; i++) {
    for (let j = i + 1; j < fieldTexts.length; j++) {
      if (fieldTexts[i].text === fieldTexts[j].text) {
        findings.push({
          code: 'DUPLICATE_BOILERPLATE',
          field: `${fieldTexts[i].field},${fieldTexts[j].field}`,
          severity: 'error',
          message: `duplicated boilerplate between ${fieldTexts[i].field} and ${fieldTexts[j].field}`,
          sample: fieldTexts[i].text.slice(0, 80),
        })
      }
    }
  }

  // Stale / uncited / review gate
  const reviewStatus = d.reviewStatus != null ? String(d.reviewStatus) : ''
  if (reviewStatus === 'REVIEWED') {
    if (d.reviewedAt == null || String(d.reviewedAt).trim() === '') {
      findings.push({
        code: 'STALE_CONTENT',
        field: 'reviewedAt',
        severity: 'error',
        message: 'REVIEWED humanDisplay missing reviewedAt (stale/invalid review)',
      })
    }
    const citations = d.citations
    if (!Array.isArray(citations) || citations.length === 0) {
      findings.push({
        code: 'UNCITED',
        field: 'citations',
        severity: 'error',
        message: 'REVIEWED humanDisplay lacks source citations',
      })
    }
    if (d.sourceHash == null || String(d.sourceHash).trim() === '') {
      findings.push({
        code: 'STALE_CONTENT',
        field: 'sourceHash',
        severity: 'error',
        message: 'REVIEWED humanDisplay missing sourceHash binding',
      })
    }
  }

  // Cross-record boilerplate with peers
  if (Array.isArray(opts.peerDisplays) && opts.peerDisplays.length > 0) {
    const myTitle =
      typeof d.title === 'string' ? d.title.trim().toLowerCase() : ''
    const myOutcome =
      typeof d.outcome === 'string' ? d.outcome.trim().toLowerCase() : ''
    for (const peer of opts.peerDisplays) {
      const p = normalizeHumanDisplay(
        /** @type {Record<string, unknown>} */ (peer),
      )
      if (!p) continue
      const peerId =
        p.entityId != null ? String(p.entityId) : p.id != null ? String(p.id) : null
      if (peerId && entityId && peerId === entityId) continue
      const pTitle = typeof p.title === 'string' ? p.title.trim().toLowerCase() : ''
      const pOutcome =
        typeof p.outcome === 'string' ? p.outcome.trim().toLowerCase() : ''
      if (myTitle && pTitle && myTitle === pTitle && myTitle.length >= 16) {
        findings.push({
          code: 'DUPLICATE_BOILERPLATE',
          field: 'title',
          severity: 'error',
          message: `title duplicates peer ${peerId ?? '(unknown)'}`,
          sample: myTitle.slice(0, 80),
        })
      }
      if (myOutcome && pOutcome && myOutcome === pOutcome && myOutcome.length >= 24) {
        findings.push({
          code: 'DUPLICATE_BOILERPLATE',
          field: 'outcome',
          severity: 'error',
          message: `outcome duplicates peer ${peerId ?? '(unknown)'}`,
          sample: myOutcome.slice(0, 80),
        })
      }
    }
  }

  // Exceptions: only suppress matching codes when valid + unexpired
  const exceptions = Array.isArray(opts.exceptions) ? opts.exceptions : []
  /** @type {Set<string>} */
  const suppressCodes = new Set()
  for (const ex of exceptions) {
    const v = validateException(ex)
    if (!v.ok) {
      findings.push(...v.findings)
      continue
    }
    const codes = /** @type {Record<string, unknown>} */ (ex).codes
    if (Array.isArray(codes)) {
      for (const c of codes) suppressCodes.add(String(c))
    } else if (typeof codes === 'string' && codes !== '*') {
      suppressCodes.add(codes)
    }
  }

  /** @type {LintFinding[]} */
  const kept = []
  for (const f of findings) {
    if (suppressCodes.has(f.code)) {
      suppressed.push(f)
    } else {
      kept.push(f)
    }
  }

  const errors = kept.filter((f) => f.severity === 'error')
  return {
    ok: errors.length === 0,
    schemaVersion: LINT_SCHEMA_VERSION,
    findings: kept,
    suppressed,
    entityId,
  }
}

/**
 * Lint a batch of humanDisplay records (detects cross-record boilerplate).
 * @param {unknown[]} displays
 * @param {{ exceptions?: unknown[] }} [opts]
 * @returns {{
 *   ok: boolean,
 *   schemaVersion: string,
 *   results: LintResult[],
 *   errorCount: number,
 *   findingCount: number,
 * }}
 */
export function lintHumanDisplayBatch(displays, opts = {}) {
  const list = Array.isArray(displays) ? displays : []
  /** @type {LintResult[]} */
  const results = []
  for (let i = 0; i < list.length; i++) {
    const peers = list.filter((_, j) => j !== i)
    results.push(
      lintHumanDisplay(list[i], {
        exceptions: opts.exceptions,
        peerDisplays: peers,
      }),
    )
  }
  const errorCount = results.reduce(
    (n, r) => n + r.findings.filter((f) => f.severity === 'error').length,
    0,
  )
  const findingCount = results.reduce((n, r) => n + r.findings.length, 0)
  return {
    ok: results.every((r) => r.ok),
    schemaVersion: LINT_SCHEMA_VERSION,
    results,
    errorCount,
    findingCount,
  }
}

/**
 * Quality-floor good fixture (ART title transformation).
 * @returns {Record<string, unknown>}
 */
export function goodHumanDisplayFixture() {
  return {
    schemaVersion: 'TM_HUMAN_DISPLAY_V1',
    locale: 'id-ID',
    entityKind: 'task',
    entityId: 'T-NODE-FC-WEB-PREMIUM-E2E-A02-API-CHECKOUT-QUOTE',
    title: 'Menampilkan harga checkout dan membuat tagihan yang menunggu pembayaran',
    outcome:
      'Pelanggan melihat rincian harga yang benar. Saat melanjutkan, sistem membuat satu tagihan menunggu pembayaran tanpa duplikasi.',
    why: 'Kesalahan harga merugikan pendapatan dan kepercayaan pelanggan.',
    current: 'Pemetaan selesai; implementasi dan peninjauan salinan berjalan.',
    remaining: 'Uji staging dan bukti independen untuk harga di semua permukaan.',
    next: 'Kirim bukti FUNCTIONAL ke peninjau independen setelah staging hijau.',
    doneWhen: 'Bukti staging mengonfirmasi harga cocok di kartu, checkout, dan tagihan.',
    blocker: 'Tidak ada',
    ownerAction: 'Tidak ada tindakan yang diperlukan',
    parentFeatureTitle: 'Alur checkout premium',
    businessArea: 'Panel Sales dan Website',
    actor: 'Implementer',
    reviewStatus: 'REVIEWED',
    reviewedAt: '2026-07-13T12:00:00.000Z',
    sourceHash: 'a'.repeat(64),
    citations: [
      { field: 'title', path: 'task/T-NODE-FC-WEB-PREMIUM-E2E-A02-API-CHECKOUT-QUOTE' },
    ],
    acceptanceLinks: [{ path: 'task/acceptance', summary: 'harga cocok' }],
    missionQuestionLinks: [{ questionId: 'Q1', field: 'outcome' }],
  }
}

/**
 * @returns {Array<{ name: string, display: unknown, expectOk: boolean, expectCodes?: string[] }>}
 */
export function selfTestCases() {
  const good = goodHumanDisplayFixture()
  return [
    {
      name: 'ART quality-floor title passes',
      display: good,
      expectOk: true,
    },
    {
      name: 'title starts with task ID',
      display: { ...good, title: 'T-BE-ID-REFRESH-REVOKE' },
      expectOk: false,
      expectCodes: ['STARTS_WITH_ID'],
    },
    {
      name: 'title starts with FC',
      display: { ...good, title: '[FC-WEB-PREMIUM-E2E] Checkout quote' },
      expectOk: false,
      expectCodes: ['STARTS_WITH_FC'],
    },
    {
      name: 'title starts with Parity',
      display: { ...good, title: 'Parity refresh_token + revoke' },
      expectOk: false,
      expectCodes: ['STARTS_WITH_PARITY'],
    },
    {
      name: 'title Integration/closure',
      display: { ...good, title: 'Integration/closure: landing price variants' },
      expectOk: false,
      expectCodes: ['STARTS_WITH_INTEGRATION_CLOSURE'],
    },
    {
      name: 'raw snake_case in outcome',
      display: { ...good, outcome: 'Harus memanggil refresh_token endpoint.' },
      expectOk: false,
      expectCodes: ['RAW_SNAKE_CASE'],
    },
    {
      name: 'raw enum in current',
      display: { ...good, current: 'Status PRIORITY_FRONTIER_EMPTY masih berlaku.' },
      expectOk: false,
      expectCodes: ['RAW_ENUM'],
    },
    {
      name: 'missing required fields',
      display: {
        locale: 'id-ID',
        title: 'Judul valid yang cukup panjang untuk lolos',
      },
      expectOk: false,
      expectCodes: ['MISSING_REQUIRED_FIELD', 'MISSING_ART_BINDING'],
    },
    {
      name: 'placeholder content',
      display: { ...good, remaining: 'TODO: isi sisa pekerjaan' },
      expectOk: false,
      expectCodes: ['PLACEHOLDER'],
    },
    {
      name: 'boilerplate duplicate fields',
      display: {
        ...good,
        why: 'Pelanggan melihat rincian harga yang benar di setiap permukaan.',
        current: 'Pelanggan melihat rincian harga yang benar di setiap permukaan.',
      },
      expectOk: false,
      expectCodes: ['DUPLICATE_BOILERPLATE'],
    },
    {
      name: 'unsupported certainty',
      display: { ...good, current: 'Fitur ini 100% sure complete tanpa bukti.' },
      expectOk: false,
      expectCodes: ['UNSUPPORTED_CERTAINTY'],
    },
    {
      name: 'REVIEWED without citations is uncited/stale',
      display: { ...good, citations: [] },
      expectOk: false,
      expectCodes: ['UNCITED'],
    },
    {
      name: 'null humanDisplay',
      display: null,
      expectOk: false,
      expectCodes: ['MISSING_HUMAN_DISPLAY'],
    },
  ]
}

/**
 * Deterministic self-test. Exit 0 only if every case matches expectOk/codes.
 * @returns {{ ok: boolean, cases: Array<{ name: string, ok: boolean, detail?: string }>, report: object }}
 */
export function runSelfTest() {
  const cases = selfTestCases()
  /** @type {Array<{ name: string, ok: boolean, detail?: string }>} */
  const results = []

  for (const c of cases) {
    const r = lintHumanDisplay(c.display)
    let ok = r.ok === c.expectOk
    let detail = ''
    if (c.expectCodes && c.expectCodes.length) {
      const codes = new Set(r.findings.map((f) => f.code))
      const missing = c.expectCodes.filter((code) => !codes.has(code))
      if (missing.length) {
        ok = false
        detail = `missing expected codes: ${missing.join(', ')}; got: ${[...codes].join(', ')}`
      }
    }
    if (r.ok !== c.expectOk) {
      detail =
        (detail ? detail + '; ' : '') +
        `ok=${r.ok} expected ${c.expectOk}; findings=${r.findings.map((f) => f.code).join(',')}`
    }
    results.push({ name: c.name, ok, detail: detail || undefined })
  }

  // Exception validation self-checks
  const badEx = validateException({ reason: 'x' })
  results.push({
    name: 'exception missing reviewer/expiry/audit fails',
    ok: badEx.ok === false,
    detail: badEx.ok ? 'expected fail' : undefined,
  })
  const blanket = validateException({
    reason: 'all',
    reviewer: 'r',
    expiry: '2099-01-01T00:00:00.000Z',
    audit: 'a',
    blanket: true,
  })
  results.push({
    name: 'blanket suppression rejected',
    ok:
      blanket.ok === false &&
      blanket.findings.some((f) => f.code === 'BLANKET_SUPPRESSION'),
  })
  const goodEx = validateException({
    reason: 'temporary brand term',
    reviewer: 'content-reviewer-1',
    expiry: '2099-12-31T00:00:00.000Z',
    audit: 'AUD-1',
    codes: ['UNEXPLAINED_JARGON'],
  })
  results.push({
    name: 'valid exception accepted',
    ok: goodEx.ok === true,
  })

  // Batch boilerplate across peers
  const g1 = goodHumanDisplayFixture()
  const g2 = {
    ...goodHumanDisplayFixture(),
    entityId: 'T-OTHER',
    title: g1.title,
  }
  const batch = lintHumanDisplayBatch([g1, g2])
  results.push({
    name: 'batch detects cross-record title boilerplate',
    ok:
      batch.ok === false &&
      batch.results.some((r) =>
        r.findings.some((f) => f.code === 'DUPLICATE_BOILERPLATE'),
      ),
  })

  // lintTitle unit parity with known debt titles
  const debtTitles = [
    ['T-BE-ID-REFRESH-REVOKE', 'STARTS_WITH_ID'],
    ['[FC-WEB] Checkout', 'STARTS_WITH_FC'],
    ['Parity refresh_token', 'STARTS_WITH_PARITY'],
    ['Integration closure FC-X', 'STARTS_WITH_INTEGRATION_CLOSURE'],
    ['Map domain graph', 'STARTS_WITH_MAP'],
    ['sales-rebuild pricing', 'STARTS_WITH_REPOISH'],
  ]
  for (const [title, code] of debtTitles) {
    const lr = lintTitle(title)
    results.push({
      name: `lintTitle rejects ${code}`,
      ok: lr.ok === false && lr.codes.includes(code),
      detail: lr.codes.join(','),
    })
  }
  const goodTitle = lintTitle(
    'Menampilkan harga checkout dan membuat tagihan yang menunggu pembayaran',
  )
  results.push({
    name: 'lintTitle accepts ART quality-floor title',
    ok: goodTitle.ok === true,
  })

  const allOk = results.every((r) => r.ok)
  const report = {
    schemaVersion: LINT_SCHEMA_VERSION,
    selfTest: true,
    ok: allOk,
    passed: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length,
    cases: results,
  }
  return { ok: allOk, cases: results, report }
}

/**
 * @param {string} s
 */
function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * CLI entry. Returns exit code.
 * @param {string[]} [argv]
 * @returns {number}
 */
export function main(argv = process.argv.slice(2)) {
  if (argv.includes('-h') || argv.includes('--help')) {
    console.log(`Usage: node scripts/plain-language-lint.mjs [options]

  --self-test         run deterministic fixture suite (exit 0 = all pass)
  --json              print full JSON report
  --lint-file <path>  lint a JSON file (object or array of humanDisplay)
  --fixture <path>    alias of --lint-file

Spec: 01A §PLAIN-LANGUAGE RELEASE GATE (id-ID)
Schema: ${LINT_SCHEMA_VERSION}
`)
    return 0
  }

  const asJson = argv.includes('--json')
  const selfTest = argv.includes('--self-test')

  if (selfTest) {
    const { ok, report } = runSelfTest()
    if (asJson) {
      console.log(JSON.stringify(report, null, 2))
    } else {
      console.log(
        `plain-language-lint self-test: ${ok ? 'PASS' : 'FAIL'} (${report.passed}/${report.passed + report.failed})`,
      )
      for (const c of report.cases) {
        console.log(`  ${c.ok ? 'ok' : 'FAIL'}  ${c.name}${c.detail ? ' — ' + c.detail : ''}`)
      }
      console.log(`schemaVersion: ${LINT_SCHEMA_VERSION}`)
    }
    return ok ? 0 : 1
  }

  let filePath = null
  for (let i = 0; i < argv.length; i++) {
    if ((argv[i] === '--lint-file' || argv[i] === '--fixture') && argv[i + 1]) {
      filePath = resolve(argv[++i])
    }
  }

  if (!filePath) {
    console.error(
      'error: provide --self-test or --lint-file <path> (see --help)',
    )
    return 2
  }

  if (!existsSync(filePath)) {
    console.error(`error: file not found: ${filePath}`)
    return 2
  }

  let parsed
  try {
    parsed = JSON.parse(readFileSync(filePath, 'utf8'))
  } catch (e) {
    console.error(`error: invalid JSON: ${/** @type {Error} */ (e).message}`)
    return 2
  }

  const list = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === 'object' && Array.isArray(parsed.displays)
      ? parsed.displays
      : [parsed]

  const batch = lintHumanDisplayBatch(list)
  if (asJson) {
    console.log(JSON.stringify(batch, null, 2))
  } else {
    console.log(
      `plain-language-lint: ${batch.ok ? 'PASS' : 'FAIL'} records=${batch.results.length} errors=${batch.errorCount} findings=${batch.findingCount}`,
    )
    for (const r of batch.results) {
      if (!r.ok) {
        console.log(`  entity ${r.entityId ?? '?'}:`)
        for (const f of r.findings) {
          console.log(`    [${f.severity}] ${f.code}${f.field ? ' @' + f.field : ''}: ${f.message}`)
        }
      }
    }
  }
  return batch.ok ? 0 : 1
}

const isMain =
  process.argv[1] &&
  resolve(process.argv[1]) === resolve(__filename)

if (isMain) {
  process.exit(main())
}
