#!/usr/bin/env node
/**
 * Evidence harness for the id-ID plain-language release gate.
 *
 * Thin, non-mutating wrapper around scripts/plain-language-lint.mjs.
 * Writes optional JSON evidence under .artifact/ when --write-evidence is set.
 * Never mutates CONTRACT, tasks.json, or product UI sources.
 *
 * Usage:
 *   node qa/evidence/plain-language-lint.mjs --self-test
 *   node qa/evidence/plain-language-lint.mjs --lint-file <json> [--write-evidence]
 *   node qa/evidence/plain-language-lint.mjs --json --self-test
 *
 * Exit 0 = pass. Exit 1 = fail. Exit 2 = usage.
 */

import {
  existsSync,
  mkdirSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
export const REPO_ROOT = resolve(__dirname, '../..')
export const SCRIPT_REL = 'scripts/plain-language-lint.mjs'
export const EVIDENCE_DIR_REL = '.artifact/evidence/plain-language-lint'

/**
 * Dynamically load the authoritative lint module from scripts/.
 * @returns {Promise<typeof import('../../scripts/plain-language-lint.mjs')>}
 */
export async function loadLintModule() {
  const scriptPath = join(REPO_ROOT, SCRIPT_REL)
  if (!existsSync(scriptPath)) {
    throw new Error(`missing lint script: ${scriptPath}`)
  }
  return import(pathToFileURL(scriptPath).href)
}

/**
 * Write a deterministic evidence report (optional).
 * @param {object} report
 * @param {{ outDir?: string }} [opts]
 * @returns {string} path written
 */
export function writeEvidenceReport(report, opts = {}) {
  const outDir = opts.outDir
    ? resolve(opts.outDir)
    : join(REPO_ROOT, EVIDENCE_DIR_REL)
  mkdirSync(outDir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const path = join(outDir, `plain-language-lint-${stamp}.json`)
  const payload = {
    generatedAt: new Date().toISOString(),
    gate: 'PLAIN_LANGUAGE_RELEASE_GATE',
    locale: 'id-ID',
    script: SCRIPT_REL,
    ...report,
  }
  writeFileSync(path, JSON.stringify(payload, null, 2) + '\n', 'utf8')
  // Also write a stable "latest" pointer for orchestrator convenience.
  const latest = join(outDir, 'latest.json')
  writeFileSync(latest, JSON.stringify(payload, null, 2) + '\n', 'utf8')
  return path
}

/**
 * @param {string[]} [argv]
 * @returns {Promise<number>}
 */
export async function main(argv = process.argv.slice(2)) {
  if (argv.includes('-h') || argv.includes('--help')) {
    console.log(`Usage: node qa/evidence/plain-language-lint.mjs [options]

  --self-test          run scripts/plain-language-lint.mjs self-test
  --json               JSON report to stdout
  --lint-file <path>   lint humanDisplay JSON (object or array)
  --write-evidence     write report under ${EVIDENCE_DIR_REL}/

Delegates all rule logic to ${SCRIPT_REL} (single source of truth).
`)
    return 0
  }

  const mod = await loadLintModule()
  const asJson = argv.includes('--json')
  const writeEv = argv.includes('--write-evidence')
  const selfTest = argv.includes('--self-test')

  if (selfTest) {
    const { ok, report } = mod.runSelfTest()
    const enriched = {
      ...report,
      evidenceHarness: 'qa/evidence/plain-language-lint.mjs',
      authoritativeScript: SCRIPT_REL,
    }
    let evidencePath = null
    if (writeEv) {
      evidencePath = writeEvidenceReport(enriched)
      enriched.evidencePath = evidencePath
    }
    if (asJson) {
      console.log(JSON.stringify(enriched, null, 2))
    } else {
      console.log(
        `qa/evidence plain-language-lint self-test: ${ok ? 'PASS' : 'FAIL'} (${report.passed}/${report.passed + report.failed})`,
      )
      for (const c of report.cases) {
        console.log(
          `  ${c.ok ? 'ok' : 'FAIL'}  ${c.name}${c.detail ? ' — ' + c.detail : ''}`,
        )
      }
      if (evidencePath) console.log(`evidence: ${evidencePath}`)
    }
    return ok ? 0 : 1
  }

  // Delegate remaining CLI flags to the script main (filter evidence-only flags).
  const forwarded = argv.filter(
    (a) => a !== '--write-evidence',
  )
  // If only evidence flags, require lint target
  if (
    !forwarded.includes('--lint-file') &&
    !forwarded.includes('--fixture') &&
    !forwarded.includes('--self-test')
  ) {
    console.error(
      'error: provide --self-test or --lint-file <path> (see --help)',
    )
    return 2
  }

  // Prefer programmatic batch lint so we can attach evidence.
  let filePath = null
  for (let i = 0; i < forwarded.length; i++) {
    if (
      (forwarded[i] === '--lint-file' || forwarded[i] === '--fixture') &&
      forwarded[i + 1]
    ) {
      filePath = resolve(forwarded[++i])
    }
  }

  if (filePath) {
    const { readFileSync } = await import('node:fs')
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
    const batch = mod.lintHumanDisplayBatch(list)
    const report = {
      ...batch,
      input: filePath,
      evidenceHarness: 'qa/evidence/plain-language-lint.mjs',
      authoritativeScript: SCRIPT_REL,
    }
    if (writeEv) {
      report.evidencePath = writeEvidenceReport(report)
    }
    if (asJson) {
      console.log(JSON.stringify(report, null, 2))
    } else {
      console.log(
        `qa/evidence plain-language-lint: ${batch.ok ? 'PASS' : 'FAIL'} records=${batch.results.length} errors=${batch.errorCount}`,
      )
      if (report.evidencePath) console.log(`evidence: ${report.evidencePath}`)
    }
    return batch.ok ? 0 : 1
  }

  return mod.main(forwarded)
}

const isMain =
  process.argv[1] && resolve(process.argv[1]) === resolve(__filename)

if (isMain) {
  main().then((code) => process.exit(code))
}
