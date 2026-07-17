#!/usr/bin/env node
/**
 * High-confidence repository secret scanner for the CP0 release gate.
 *
 * It deliberately reports only path, line and rule id. Matched values are never
 * printed. Placeholders and environment-variable references remain allowed.
 */
import { readFileSync, statSync } from 'node:fs'
import { extname, basename } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const TEXT_EXTENSIONS = new Set([
  '.cjs',
  '.css',
  '.env',
  '.example',
  '.html',
  '.js',
  '.json',
  '.jsx',
  '.md',
  '.mjs',
  '.sh',
  '.sql',
  '.ts',
  '.tsx',
  '.txt',
  '.yaml',
  '.yml',
])

const SKIP_PREFIXES = [
  '.git/',
  'dist/',
  'node_modules/',
  'playwright-report/',
  'test-results/',
  'tests/',
  'qa/evidence/public-live-axe/',
  'qa/evidence/public-live-shots/',
  'qa/cp0/secret-scan.mjs',
]

const RULES = [
  {
    id: 'PRIVATE_KEY',
    re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/,
  },
  { id: 'AWS_ACCESS_KEY', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  {
    id: 'GITHUB_TOKEN',
    re: /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{50,})\b/,
  },
  { id: 'OPENAI_TOKEN', re: /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{32,}\b/ },
  { id: 'GOOGLE_API_KEY', re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  {
    id: 'LITERAL_BEARER',
    re: /\bAuthorization\s*:\s*Bearer\s+[A-Za-z0-9._~-]{24,}/i,
  },
  { id: 'CREDENTIAL_URL', re: /\bhttps?:\/\/[^\s/@:]+:[^\s/@]+@[^\s/]+/i },
]

const SENSITIVE_ENV =
  /^(?:export\s+)?(?:CAIRN_WRITE_TOKEN|CAIRN_HEALTH_BEARER|STAGING_BEARER_TOKEN|STAGING_ROOT_BEARER_TOKEN|STAGING_AGENT_BEARER_TOKEN|CAIRN_DB_PASSWORD)\s*=\s*(.+)$/
const SAFE_VALUE =
  /^(?:$|["']?$|["']?<[^>]+>|["']?\$\{|["']?\$[A-Z_]|REPLACE[-_]?ME|CHANGE[-_]?ME|DUMMY|EXAMPLE|TEST_|LOCAL_|REDACTED|MASKED|UNSET)/i

function isSafeAssignedValue(raw) {
  const value = raw.trim()
  if (SAFE_VALUE.test(value)) return true
  const unquoted = value.replace(/^["']|["']$/g, '')
  if (/\s/.test(unquoted)) return true // documentation prose, not an opaque token
  return /(?:^|[-_])(?:dev|local|test|dummy|example|sample|replace)(?:[-_]|$)/i.test(
    unquoted,
  )
}

function isTextCandidate(path) {
  if (SKIP_PREFIXES.some((prefix) => path.startsWith(prefix))) return false
  const ext = extname(path).toLowerCase()
  return TEXT_EXTENSIONS.has(ext) || basename(path).startsWith('.env')
}

export function scanText(path, text) {
  const findings = []
  const lines = String(text).split(/\r?\n/)
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (line.includes('secret-scan-allow-fixture')) continue
    for (const rule of RULES) {
      if (rule.re.test(line))
        findings.push({ path, line: index + 1, rule: rule.id })
    }
    const env = line.trim().match(SENSITIVE_ENV)
    if (env && !isSafeAssignedValue(env[1])) {
      findings.push({ path, line: index + 1, rule: 'HARDCODED_SENSITIVE_ENV' })
    }
  }
  return findings
}

function repositoryFiles(cwd) {
  const git = spawnSync(
    'git',
    ['ls-files', '-co', '--exclude-standard', '-z'],
    { cwd, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
  )
  if (git.status !== 0) throw new Error('git file inventory failed')
  return git.stdout.split('\0').filter(Boolean).sort()
}

export function scanRepository(cwd = process.cwd()) {
  const findings = []
  let scanned = 0
  for (const path of repositoryFiles(cwd)) {
    if (!isTextCandidate(path)) continue
    let stat
    try {
      stat = statSync(`${cwd}/${path}`)
    } catch {
      continue
    }
    if (!stat.isFile() || stat.size > 2 * 1024 * 1024) continue
    let text
    try {
      text = readFileSync(`${cwd}/${path}`, 'utf8')
    } catch {
      continue
    }
    if (text.includes('\0')) continue
    scanned += 1
    findings.push(...scanText(path, text))
  }
  return { ok: findings.length === 0, scanned, findings }
}

export function runSelfTest() {
  const bad = scanText(
    'bad.env',
    'CAIRN_WRITE_TOKEN=abcdefghijklmnopqrstuvwx\n-----BEGIN PRIVATE KEY-----',
  ) // secret-scan-allow-fixture
  const safe = scanText(
    'safe.example',
    'CAIRN_WRITE_TOKEN=REPLACE_ME\nCAIRN_DB_PASSWORD=${CAIRN_DB_PASSWORD}\nAuthorization: Bearer <secret>',
  )
  return {
    ok: bad.length === 2 && safe.length === 0,
    badRules: bad.map((f) => f.rule).sort(),
  }
}

function main(argv) {
  if (argv.includes('--self-test')) {
    const result = runSelfTest()
    console.log(JSON.stringify({ mode: 'SELF_TEST', ...result }))
    return result.ok ? 0 : 2
  }
  const result = scanRepository(process.cwd())
  for (const finding of result.findings) {
    console.error(
      `SECRET_FINDING ${finding.path}:${finding.line} rule=${finding.rule}`,
    )
  }
  console.log(
    JSON.stringify({
      gate: 'CP0_SECRET_SCAN_V1',
      ok: result.ok,
      scannedFiles: result.scanned,
      findingCount: result.findings.length,
    }),
  )
  return result.ok ? 0 : 2
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = main(process.argv.slice(2))
}
