#!/usr/bin/env node
/**
 * Post-vite SSR ↔ client global stylesheet URL aligner (A3).
 *
 * Problem class (Linux Docker no-cache):
 *   Vite/TanStack dual-env build can embed `/assets/styles-<ssr-hash>.css` into
 *   dist/server text assets while only the client env emits
 *   dist/client/assets/styles-<client-hash>.css. Assert then fail-closes correctly.
 *
 * This script NEVER copies/renames/creates CSS files. It only rewrites absolute
 * public style URL strings in dist/server text assets to the single client emit
 * basename, then exits so assert-build-assets can re-verify fail-closed.
 *
 * Fail closed:
 *   - zero or multiple client `styles-*.css` files
 *   - zero absolute `/assets/styles-*.css` refs in dist/server
 *   - missing dist layout
 *
 * Safety:
 *   - only absolute `/assets/styles-<token>.css` (no traversal, no relative paths)
 *   - only rewrites under dist/server text assets
 *   - idempotent when already aligned
 *
 * Env:
 *   DIST_ROOT   default: <repo>/dist
 */
import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const REPO_ROOT = resolve(__dirname, '..')

/** Absolute public global stylesheet URLs only (no traversal, no relative). */
export const ABSOLUTE_STYLES_URL_RE =
  /["'`](\/assets\/styles-[A-Za-z0-9._@%-]+\.css)["'`]/g

/** Replacement pattern for rewrite: capture quote + path structure. */
export const ABSOLUTE_STYLES_REPLACE_RE =
  /(["'`])(\/assets\/styles-[A-Za-z0-9._@%-]+\.css)\1/g

const TEXT_SCAN_EXTS = new Set([
  '.js',
  '.mjs',
  '.cjs',
  '.html',
  '.json',
  '.map',
  '.css',
  '.txt',
])

/**
 * @param {string} text
 * @returns {string[]} unique absolute /assets/styles-*.css paths
 */
export function extractAbsoluteStyleUrls(text) {
  if (!text || typeof text !== 'string') return []
  const found = new Set()
  for (const m of text.matchAll(ABSOLUTE_STYLES_URL_RE)) {
    found.add(m[1])
  }
  return [...found].sort()
}

/**
 * Rewrite absolute styles URLs to a single client basename.
 * Non-target paths (relative, traversal, other assets) are left unchanged.
 *
 * @param {string} text
 * @param {string} clientBasename e.g. styles-B_tDQ5es.css
 * @returns {{ text: string, replacements: number, beforeUrls: string[] }}
 */
export function rewriteAbsoluteStyleUrls(text, clientBasename) {
  if (!clientBasename || typeof clientBasename !== 'string') {
    throw new Error('clientBasename required')
  }
  if (
    !/^styles-[A-Za-z0-9._@%-]+\.css$/.test(clientBasename) ||
    clientBasename.includes('..') ||
    clientBasename.includes('/')
  ) {
    throw new Error(`invalid client styles basename: ${clientBasename}`)
  }
  const target = `/assets/${clientBasename}`
  const beforeUrls = extractAbsoluteStyleUrls(text)
  let replacements = 0
  const next = text.replace(ABSOLUTE_STYLES_REPLACE_RE, (full, quote, url) => {
    if (url === target) return full
    replacements += 1
    return `${quote}${target}${quote}`
  })
  return { text: next, replacements, beforeUrls }
}

/**
 * @param {string} dir
 * @param {{ maxDepth?: number }} [opts]
 * @returns {string[]} absolute file paths
 */
export function listServerTextFiles(dir, opts = {}) {
  const maxDepth = opts.maxDepth ?? 12
  /** @type {string[]} */
  const out = []
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return out

  /**
   * @param {string} current
   * @param {number} depth
   */
  function walk(current, depth) {
    if (depth > maxDepth) return
    let entries
    try {
      entries = readdirSync(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const ent of entries) {
      const full = join(current, ent.name)
      if (ent.isDirectory()) {
        if (ent.name === 'node_modules' || ent.name === '.git') continue
        // Hard refuse path escape via weird names
        if (ent.name === '..' || ent.name.includes('..')) continue
        walk(full, depth + 1)
      } else if (ent.isFile()) {
        const dot = ent.name.lastIndexOf('.')
        const ext = dot >= 0 ? ent.name.slice(dot).toLowerCase() : ''
        if (TEXT_SCAN_EXTS.has(ext) || ent.name.startsWith('router')) {
          out.push(full)
        }
      }
    }
  }
  walk(dir, 0)
  return out.sort()
}

/**
 * List client global styles emits: styles-*.css under client/assets (flat only).
 * @param {string} clientAssetsDir
 * @returns {string[]} basenames sorted
 */
export function listClientStyleBasenames(clientAssetsDir) {
  if (!existsSync(clientAssetsDir) || !statSync(clientAssetsDir).isDirectory()) {
    return []
  }
  return readdirSync(clientAssetsDir)
    .filter((n) => {
      if (!/^styles-[A-Za-z0-9._@%-]+\.css$/.test(n)) return false
      if (n.includes('..') || n.includes('/') || n.includes('\\')) return false
      try {
        return statSync(join(clientAssetsDir, n)).isFile()
      } catch {
        return false
      }
    })
    .sort()
}

/**
 * Align SSR absolute styles URLs to the single client emit.
 *
 * @param {{ distRoot?: string }} [options]
 * @returns {{
 *   ok: boolean
 *   exitCode: number
 *   distRoot: string
 *   clientBasename?: string
 *   clientStyleCount: number
 *   serverStyleRefCount: number
 *   serverStyleRefs: string[]
 *   filesTouched: string[]
 *   totalReplacements: number
 *   error?: string
 *   alreadyAligned?: boolean
 * }}
 */
export function alignSsrStyleUrls(options = {}) {
  const distRoot = resolve(options.distRoot ?? join(REPO_ROOT, 'dist'))
  const serverDir = join(distRoot, 'server')
  const clientAssetsDir = join(distRoot, 'client', 'assets')

  /** @type {ReturnType<typeof alignSsrStyleUrls>} */
  const base = {
    ok: false,
    exitCode: 1,
    distRoot,
    clientStyleCount: 0,
    serverStyleRefCount: 0,
    serverStyleRefs: [],
    filesTouched: [],
    totalReplacements: 0,
  }

  if (!existsSync(serverDir) || !statSync(serverDir).isDirectory()) {
    return {
      ...base,
      error: `missing dist/server at ${serverDir}`,
    }
  }
  if (!existsSync(clientAssetsDir) || !statSync(clientAssetsDir).isDirectory()) {
    return {
      ...base,
      error: `missing dist/client/assets at ${clientAssetsDir}`,
    }
  }

  const clientStyles = listClientStyleBasenames(clientAssetsDir)
  base.clientStyleCount = clientStyles.length

  if (clientStyles.length === 0) {
    return {
      ...base,
      error:
        'zero client global styles emits (expected exactly one dist/client/assets/styles-*.css)',
    }
  }
  if (clientStyles.length > 1) {
    return {
      ...base,
      error: `multiple client global styles emits (${clientStyles.length}): ${clientStyles.join(', ')} — refuse rewrite`,
    }
  }

  const clientBasename = clientStyles[0]
  const targetUrl = `/assets/${clientBasename}`

  const files = listServerTextFiles(serverDir)
  /** @type {Set<string>} */
  const allRefs = new Set()
  /** @type {string[]} */
  const filesTouched = []
  let totalReplacements = 0

  for (const file of files) {
    // Refuse rewriting outside dist/server (path traversal defense)
    const rel = relative(serverDir, file)
    if (rel.startsWith('..') || rel.includes(`..${join('/', '..')}`)) {
      continue
    }
    let text
    try {
      text = readFileSync(file, 'utf8')
    } catch {
      continue
    }
    const urls = extractAbsoluteStyleUrls(text)
    for (const u of urls) allRefs.add(u)
    if (urls.length === 0) continue

    const { text: next, replacements } = rewriteAbsoluteStyleUrls(
      text,
      clientBasename,
    )
    if (replacements > 0 || next !== text) {
      // Only write when content actually changes
      if (next !== text) {
        writeFileSync(file, next, 'utf8')
        filesTouched.push(relative(distRoot, file) || file)
        totalReplacements += replacements
      }
    }
  }

  const serverStyleRefs = [...allRefs].sort()
  if (serverStyleRefs.length === 0) {
    return {
      ...base,
      clientBasename,
      serverStyleRefCount: 0,
      serverStyleRefs,
      error:
        'zero absolute /assets/styles-*.css refs in dist/server — refuse (broken SSR emit)',
    }
  }

  // After rewrite, verify all refs would be target (re-scan)
  /** @type {Set<string>} */
  const afterRefs = new Set()
  for (const file of files) {
    let text
    try {
      text = readFileSync(file, 'utf8')
    } catch {
      continue
    }
    for (const u of extractAbsoluteStyleUrls(text)) afterRefs.add(u)
  }
  const afterList = [...afterRefs].sort()
  const badAfter = afterList.filter((u) => u !== targetUrl)
  if (badAfter.length > 0) {
    return {
      ...base,
      clientBasename,
      serverStyleRefCount: serverStyleRefs.length,
      serverStyleRefs,
      filesTouched,
      totalReplacements,
      error: `post-rewrite residual non-target styles refs: ${badAfter.join(', ')}`,
    }
  }

  const alreadyAligned =
    totalReplacements === 0 &&
    serverStyleRefs.length === 1 &&
    serverStyleRefs[0] === targetUrl

  return {
    ok: true,
    exitCode: 0,
    distRoot,
    clientBasename,
    clientStyleCount: 1,
    serverStyleRefCount: serverStyleRefs.length,
    serverStyleRefs,
    filesTouched,
    totalReplacements,
    alreadyAligned,
  }
}

/**
 * CLI entry. Returns process exit code.
 * @param {string[]} [argv]
 */
export function main(argv = process.argv.slice(2)) {
  if (argv.includes('-h') || argv.includes('--help')) {
    console.log(`Usage: node scripts/align-ssr-style-urls.mjs [options]

  --dist <path>   dist root (default: ./dist)

Env: DIST_ROOT

Requires exactly one client styles-*.css; rewrites absolute /assets/styles-*.css
in dist/server text assets to that basename. Fail closed on zero/multiple styles
or zero server refs. Never copies CSS files.
`)
    return 0
  }

  let distRoot = process.env.DIST_ROOT || join(REPO_ROOT, 'dist')
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--dist' && argv[i + 1]) {
      distRoot = resolve(argv[++i])
    }
  }

  const report = alignSsrStyleUrls({ distRoot })

  if (report.ok) {
    console.log(
      `SSR_STYLE_ALIGN OK dist=${report.distRoot} client=${report.clientBasename} refs_before=${report.serverStyleRefCount} replacements=${report.totalReplacements} files=${report.filesTouched.length}${report.alreadyAligned ? ' already_aligned=1' : ''}`,
    )
    if (report.filesTouched.length) {
      console.log(`  rewritten=${report.filesTouched.join('|')}`)
    }
    console.log(`  target=/assets/${report.clientBasename}`)
    return 0
  }

  console.error(
    `SSR_STYLE_ALIGN FAIL dist=${report.distRoot} client_styles=${report.clientStyleCount} server_style_refs=${report.serverStyleRefCount}`,
  )
  if (report.clientBasename) {
    console.error(`  client_basename=${report.clientBasename}`)
  }
  if (report.serverStyleRefs.length) {
    console.error(`  server_refs=${report.serverStyleRefs.join(',')}`)
  }
  console.error(`ERROR: ${report.error}`)
  console.error(
    'HINT: do not copy stale styles hashes; fix client emit or dual-env CSS split source. Assert remains fail-closed.',
  )
  return 1
}

const isDirect =
  process.argv[1] && resolve(process.argv[1]) === __filename

if (isDirect) {
  process.exit(main())
}

export const meta = {
  REPO_ROOT,
  version: 1,
  contract:
    'exactly one client styles-*.css; rewrite absolute /assets/styles-*.css in dist/server to that basename; never invent files',
}
