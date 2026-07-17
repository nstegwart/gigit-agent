/**
 * Unit tests for the id-ID plain-language release gate (01A §PLAIN-LANGUAGE RELEASE GATE).
 * Loads scripts/plain-language-lint.mjs (single source of truth) via dynamic import.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const ROOT = process.cwd()
const SCRIPT = join(ROOT, 'scripts/plain-language-lint.mjs')
const EVIDENCE = join(ROOT, 'qa/evidence/plain-language-lint.mjs')

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type LintMod = {
  LINT_SCHEMA_VERSION: string
  DEFAULT_LOCALE: string
  REQUIRED_COPY_FIELDS: readonly string[]
  REQUIRED_ART_BINDINGS: readonly string[]
  lintTitle: (title: string | null | undefined) => {
    ok: boolean
    codes: string[]
  }
  lintTextField: (
    field: string,
    text: string,
    opts?: { isTitle?: boolean },
  ) => Array<{ code: string; field?: string; severity: string; message: string }>
  lintHumanDisplay: (
    display: unknown,
    opts?: { exceptions?: unknown[]; peerDisplays?: unknown[] },
  ) => {
    ok: boolean
    schemaVersion: string
    findings: Array<{ code: string; field?: string; severity: string }>
    suppressed: Array<{ code: string }>
    entityId?: string | null
  }
  lintHumanDisplayBatch: (displays: unknown[]) => {
    ok: boolean
    results: Array<{ ok: boolean; findings: Array<{ code: string }> }>
    errorCount: number
  }
  validateException: (exception: unknown) => {
    ok: boolean
    findings: Array<{ code: string }>
  }
  goodHumanDisplayFixture: () => Record<string, unknown>
  runSelfTest: () => { ok: boolean; report: { passed: number; failed: number } }
  main: (argv?: string[]) => number
  normalizeHumanDisplay: (
    raw: Record<string, unknown> | null | undefined,
  ) => Record<string, unknown> | null
}

const tmpDirs: string[] = []

afterEach(() => {
  while (tmpDirs.length) {
    const d = tmpDirs.pop()
    if (d) rmSync(d, { recursive: true, force: true })
  }
})

async function loadMod(): Promise<LintMod> {
  return (await import(pathToFileURL(SCRIPT).href)) as LintMod
}

describe('plain-language-lint module presence', () => {
  it('ships scripts and evidence harness paths', () => {
    expect(existsSync(SCRIPT)).toBe(true)
    expect(existsSync(EVIDENCE)).toBe(true)
  })
})

describe('lintTitle quality floor (FC/Parity/Integration/ID/repo)', () => {
  it('rejects technical debt prefixes from 01A quality floor', async () => {
    const { lintTitle } = await loadMod()
    expect(lintTitle('T-BE-ID-REFRESH-REVOKE').ok).toBe(false)
    expect(lintTitle('T-BE-ID-REFRESH-REVOKE').codes).toContain('STARTS_WITH_ID')
    expect(lintTitle('[FC-WEB] Checkout').codes).toContain('STARTS_WITH_FC')
    expect(lintTitle('Parity refresh_token').codes).toContain('STARTS_WITH_PARITY')
    expect(lintTitle('Integration closure FC-X').codes).toContain(
      'STARTS_WITH_INTEGRATION_CLOSURE',
    )
    expect(lintTitle('Integration/closure: landing price variants').codes).toContain(
      'STARTS_WITH_INTEGRATION_CLOSURE',
    )
    expect(lintTitle('Map domain graph').codes).toContain('STARTS_WITH_MAP')
    expect(lintTitle('sales-rebuild pricing').codes).toContain('STARTS_WITH_REPOISH')
    expect(lintTitle(null).codes).toContain('EMPTY')
    expect(lintTitle('').codes).toContain('EMPTY')
  })

  it('accepts ART quality-floor human titles', async () => {
    const { lintTitle } = await loadMod()
    expect(
      lintTitle(
        'Menampilkan harga checkout dan membuat tagihan yang menunggu pembayaran',
      ).ok,
    ).toBe(true)
    expect(
      lintTitle('Memastikan semua harga promo diteruskan dengan benar hingga checkout')
        .ok,
    ).toBe(true)
    expect(
      lintTitle('Memperbarui sesi login dan mencabut akses secara aman').ok,
    ).toBe(true)
    expect(
      lintTitle(
        'Mencegah komisi dicairkan dari pembayaran kedaluwarsa atau belum dibayar',
      ).ok,
    ).toBe(true)
  })
})

describe('raw enum / snake_case / jargon / placeholder', () => {
  it('flags snake_case and SCREAMING_SNAKE enums', async () => {
    const { lintTextField } = await loadMod()
    const snake = lintTextField('outcome', 'Harus memanggil refresh_token endpoint')
    expect(snake.some((f) => f.code === 'RAW_SNAKE_CASE')).toBe(true)
    const en = lintTextField('current', 'Status PRIORITY_FRONTIER_EMPTY')
    expect(en.some((f) => f.code === 'RAW_ENUM')).toBe(true)
  })

  it('flags unexplained jargon and placeholders', async () => {
    const { lintTextField } = await loadMod()
    const jargon = lintTextField('why', 'Perlu RBAC dan CSRF di surface ini')
    expect(jargon.some((f) => f.code === 'UNEXPLAINED_JARGON')).toBe(true)
    const ph = lintTextField('remaining', 'TODO: isi sisa pekerjaan')
    expect(ph.some((f) => f.code === 'PLACEHOLDER')).toBe(true)
  })

  it('flags unsupported certainty/percent claims', async () => {
    const { lintTextField } = await loadMod()
    const c = lintTextField('current', 'Fitur ini 100% sure complete')
    expect(c.some((f) => f.code === 'UNSUPPORTED_CERTAINTY')).toBe(true)
  })
})

describe('lintHumanDisplay required fields + stale/uncited', () => {
  it('fails closed on missing humanDisplay and missing required fields', async () => {
    const { lintHumanDisplay } = await loadMod()
    expect(lintHumanDisplay(null).findings.some((f) => f.code === 'MISSING_HUMAN_DISPLAY'))
      .toBe(true)
    const partial = lintHumanDisplay({
      locale: 'id-ID',
      title: 'Judul valid yang cukup panjang untuk lolos',
    })
    expect(partial.ok).toBe(false)
    expect(
      partial.findings.some((f) => f.code === 'MISSING_REQUIRED_FIELD'),
    ).toBe(true)
    expect(partial.findings.some((f) => f.code === 'MISSING_ART_BINDING')).toBe(
      true,
    )
  })

  it('accepts good ART fixture and rejects REVIEWED without citations', async () => {
    const { lintHumanDisplay, goodHumanDisplayFixture } = await loadMod()
    const good = goodHumanDisplayFixture()
    const pass = lintHumanDisplay(good)
    expect(pass.ok).toBe(true)
    expect(pass.findings).toEqual([])

    const uncited = lintHumanDisplay({ ...good, citations: [] })
    expect(uncited.ok).toBe(false)
    expect(uncited.findings.some((f) => f.code === 'UNCITED')).toBe(true)
  })

  it('maps ART long-name aliases to compact required fields', async () => {
    const { lintHumanDisplay, goodHumanDisplayFixture, normalizeHumanDisplay } =
      await loadMod()
    const base = goodHumanDisplayFixture()
    const { why: _w, current: _c, remaining: _r, next: _n, blocker: _b, ...rest } =
      base as Record<string, unknown>
    const aliased = {
      ...rest,
      whyItMatters: base.why,
      currentState: base.current,
      remainingWork: base.remaining,
      nextAction: base.next,
      blockerSummary: base.blocker,
    }
    const norm = normalizeHumanDisplay(aliased)
    expect(norm?.why).toBe(base.why)
    const r = lintHumanDisplay(aliased)
    expect(r.ok).toBe(true)
  })

  it('detects intra-record and cross-record boilerplate', async () => {
    const {
      lintHumanDisplay,
      lintHumanDisplayBatch,
      goodHumanDisplayFixture,
    } = await loadMod()
    const g = goodHumanDisplayFixture()
    const dup = {
      ...g,
      why: 'Pelanggan melihat rincian harga yang benar di setiap permukaan.',
      current: 'Pelanggan melihat rincian harga yang benar di setiap permukaan.',
    }
    expect(
      lintHumanDisplay(dup).findings.some((f) => f.code === 'DUPLICATE_BOILERPLATE'),
    ).toBe(true)

    const a = goodHumanDisplayFixture()
    const b = {
      ...goodHumanDisplayFixture(),
      entityId: 'T-OTHER',
      title: a.title,
    }
    const batch = lintHumanDisplayBatch([a, b])
    expect(batch.ok).toBe(false)
    expect(
      batch.results.some((r) =>
        r.findings.some((f) => f.code === 'DUPLICATE_BOILERPLATE'),
      ),
    ).toBe(true)
  })
})

describe('exceptions (no blanket suppression)', () => {
  it('requires reason, reviewer, expiry, audit; rejects blanket', async () => {
    const { validateException, lintHumanDisplay, goodHumanDisplayFixture } =
      await loadMod()
    expect(validateException({ reason: 'x' }).ok).toBe(false)
    expect(
      validateException({
        reason: 'all',
        reviewer: 'r',
        expiry: '2099-01-01T00:00:00.000Z',
        audit: 'a',
        blanket: true,
      }).findings.some((f) => f.code === 'BLANKET_SUPPRESSION'),
    ).toBe(true)

    const good = goodHumanDisplayFixture()
    const withJargon = {
      ...good,
      why: 'Perlu penyesuaian RBAC untuk peran owner.',
    }
    const blocked = lintHumanDisplay(withJargon)
    expect(blocked.ok).toBe(false)

    const allowed = lintHumanDisplay(withJargon, {
      exceptions: [
        {
          reason: 'temporary technical term pending glossary',
          reviewer: 'content-reviewer-1',
          expiry: '2099-12-31T00:00:00.000Z',
          audit: 'AUD-PL-1',
          codes: ['UNEXPLAINED_JARGON'],
        },
      ],
    })
    expect(allowed.ok).toBe(true)
    expect(allowed.suppressed.some((f) => f.code === 'UNEXPLAINED_JARGON')).toBe(
      true,
    )
  })
})

describe('CLI --self-test and package wiring', () => {
  it('runSelfTest passes programmatically', async () => {
    const { runSelfTest, LINT_SCHEMA_VERSION, main } = await loadMod()
    const { ok, report } = runSelfTest()
    expect(ok).toBe(true)
    expect(report.failed).toBe(0)
    expect(LINT_SCHEMA_VERSION).toBe('TM_PLAIN_LANGUAGE_LINT_V1')
    expect(main(['--self-test'])).toBe(0)
  })

  it('node scripts/plain-language-lint.mjs --self-test exits 0', () => {
    const out = execFileSync(process.execPath, [SCRIPT, '--self-test'], {
      cwd: ROOT,
      encoding: 'utf8',
    })
    expect(out).toMatch(/PASS/)
    expect(out).toMatch(/plain-language-lint self-test/)
  })

  it('lints a temp JSON file of good fixtures to PASS', async () => {
    const { goodHumanDisplayFixture } = await loadMod()
    const dir = join(
      tmpdir(),
      `pl-lint-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    )
    mkdirSync(dir, { recursive: true })
    tmpDirs.push(dir)
    const file = join(dir, 'displays.json')
    const a = goodHumanDisplayFixture()
    const b = {
      ...goodHumanDisplayFixture(),
      entityId: 'T-BE-ID-REFRESH-REVOKE',
      title: 'Memperbarui sesi login dan mencabut akses secara aman',
      outcome:
        'Sesi sah dapat diperbarui, sedangkan token yang dicabut tidak dapat dipakai lagi.',
    }
    writeFileSync(file, JSON.stringify([a, b]), 'utf8')
    const out = execFileSync(
      process.execPath,
      [SCRIPT, '--lint-file', file],
      { cwd: ROOT, encoding: 'utf8' },
    )
    expect(out).toMatch(/PASS/)
  })

  it('evidence harness self-test exits 0', () => {
    const out = execFileSync(process.execPath, [EVIDENCE, '--self-test'], {
      cwd: ROOT,
      encoding: 'utf8',
    })
    expect(out).toMatch(/PASS/)
  })
})
