#!/usr/bin/env node
/**
 * Post-build SSR ↔ client asset coherence verifier.
 *
 * Root class (investigate-final-login-assets-r2):
 *   SSR router/server output can embed absolute browser URLs like
 *   "/assets/styles-<hash>.css" that must exist under dist/client/assets.
 *   A client/server hash split yields HTML 404 for CSS while client JS is fine.
 *
 * Rule:
 *   Every quoted absolute `/assets/<file>` referenced by dist/server (and optional
 *   extra roots) must exist as dist/client/assets/<file>. Relative `./assets/*`
 *   server-only imports are ignored (they are Node import paths, not public URLs).
 *
 * Also records a deterministic client asset manifest + hash for clean rebuild
 * comparison (same SHA → content-addressed names; hash of sorted name list).
 *
 * Exit 0 = coherent. Exit 1 = missing public assets or invalid dist layout.
 * Env:
 *   DIST_ROOT          default: <repo>/dist
 *   ASSERT_WRITE_MANIFEST=1  write dist/asset-coherence-manifest.json
 *   ASSERT_JSON=1      print full JSON report to stdout
 *   ASSERT_STRICT_EMPTY=1  fail if zero /assets/ refs found (default on when dist/server exists)
 */
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
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

/** Quoted absolute public asset URLs: "/assets/foo-HASH.css" etc. Not ./assets. */
export const ABSOLUTE_ASSET_URL_RE =
  /["'`](\/assets\/[A-Za-z0-9._@%-]+)["'`]/g

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
 * @returns {string[]} unique absolute /assets/... paths (with leading slash)
 */
export function extractAbsoluteAssetUrls(text) {
  if (!text || typeof text !== 'string') return []
  const found = new Set()
  for (const m of text.matchAll(ABSOLUTE_ASSET_URL_RE)) {
    found.add(m[1])
  }
  return [...found].sort()
}

/**
 * @param {string} dir
 * @param {{ maxDepth?: number }} [opts]
 * @returns {string[]} absolute file paths
 */
export function listTextFilesRecursive(dir, opts = {}) {
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
 * @param {string} clientAssetsDir
 * @returns {{ names: string[], byName: Map<string, { size: number }> }}
 */
export function indexClientAssets(clientAssetsDir) {
  /** @type {Map<string, { size: number }>} */
  const byName = new Map()
  if (!existsSync(clientAssetsDir) || !statSync(clientAssetsDir).isDirectory()) {
    return { names: [], byName }
  }
  for (const name of readdirSync(clientAssetsDir)) {
    const full = join(clientAssetsDir, name)
    try {
      const st = statSync(full)
      if (st.isFile()) byName.set(name, { size: st.size })
    } catch {
      /* skip */
    }
  }
  return { names: [...byName.keys()].sort(), byName }
}

/**
 * Deterministic fingerprint of client asset inventory (names + sizes).
 * Content-addressed Vite hashes mean same emit → same names; sizes catch empty stubs.
 * @param {string[]} names
 * @param {Map<string, { size: number }>} byName
 */
export function computeClientManifestHash(names, byName) {
  // Sort so callers can pass unsorted inventory; fingerprint stays stable.
  const lines = [...names]
    .sort()
    .map((n) => `${n}\t${byName.get(n)?.size ?? 0}`)
  const body = lines.join('\n') + (lines.length ? '\n' : '')
  return createHash('sha256').update(body, 'utf8').digest('hex')
}

/**
 * @param {{
 *   distRoot?: string
 *   serverRoots?: string[]
 *   clientAssetsDir?: string
 *   writeManifest?: boolean
 *   strictEmpty?: boolean
 * }} [options]
 */
export function assertBuildAssetCoherence(options = {}) {
  const distRoot = resolve(options.distRoot ?? join(REPO_ROOT, 'dist'))
  const serverDir = join(distRoot, 'server')
  const clientDir = join(distRoot, 'client')
  const clientAssetsDir = resolve(
    options.clientAssetsDir ?? join(clientDir, 'assets'),
  )
  const serverRoots = (options.serverRoots ?? [serverDir]).map((p) =>
    resolve(p),
  )
  const writeManifest =
    options.writeManifest === true ||
    process.env.ASSERT_WRITE_MANIFEST === '1'
  const strictEmpty =
    options.strictEmpty !== undefined
      ? options.strictEmpty
      : process.env.ASSERT_STRICT_EMPTY !== '0'

  /** @type {{ file: string, urls: string[] }[]} */
  const scanned = []
  /** @type {Map<string, Set<string>>} url -> relative sources */
  const urlSources = new Map()

  for (const root of serverRoots) {
    if (!existsSync(root)) continue
    const files = listTextFilesRecursive(root)
    for (const file of files) {
      let text
      try {
        text = readFileSync(file, 'utf8')
      } catch {
        continue
      }
      const urls = extractAbsoluteAssetUrls(text)
      if (urls.length === 0) continue
      const rel = relative(distRoot, file) || file
      scanned.push({ file: rel, urls })
      for (const u of urls) {
        if (!urlSources.has(u)) urlSources.set(u, new Set())
        urlSources.get(u).add(rel)
      }
    }
  }

  const { names: clientNames, byName } = indexClientAssets(clientAssetsDir)
  const manifestHash = computeClientManifestHash(clientNames, byName)

  /** @type {string[]} */
  const referenced = [...urlSources.keys()].sort()
  /** @type {{ url: string, basename: string, sources: string[] }[]} */
  const missing = []
  /** @type {{ url: string, basename: string, size: number }[]} */
  const present = []

  for (const url of referenced) {
    const basename = url.replace(/^\/assets\//, '')
    if (!basename || basename.includes('..') || basename.includes('/')) {
      missing.push({
        url,
        basename,
        sources: [...(urlSources.get(url) ?? [])].sort(),
      })
      continue
    }
    const meta = byName.get(basename)
    if (!meta) {
      missing.push({
        url,
        basename,
        sources: [...(urlSources.get(url) ?? [])].sort(),
      })
    } else {
      present.push({ url, basename, size: meta.size })
    }
  }

  const serverExists = existsSync(serverDir)
  const clientAssetsExist = existsSync(clientAssetsDir)
  const layoutOk = serverExists && clientAssetsExist

  let emptyRefsFail = false
  if (strictEmpty && layoutOk && referenced.length === 0) {
    // Router/SSR builds always emit at least styles or preload URLs when dist is real.
    emptyRefsFail = true
  }

  const ok = layoutOk && missing.length === 0 && !emptyRefsFail

  const report = {
    ok,
    distRoot,
    clientAssetsDir,
    serverRoots,
    layout: {
      serverExists,
      clientAssetsExist,
      clientAssetCount: clientNames.length,
    },
    referencedCount: referenced.length,
    presentCount: present.length,
    missingCount: missing.length,
    missing,
    emptyRefsFail,
    // Sample present (styles + first few) for logs — full list in manifest
    stylesRefs: referenced.filter((u) => /\/styles-[^/]+\.css$/.test(u)),
    clientManifest: {
      hash: manifestHash,
      hashAlgo: 'sha256',
      assetCount: clientNames.length,
      // names only in write path to keep CLI summary small
    },
    scannedFileCount: scanned.length,
  }

  if (writeManifest) {
    const manifestPath = join(distRoot, 'asset-coherence-manifest.json')
    const payload = {
      generatedAt: new Date().toISOString(),
      ok,
      clientManifestHash: manifestHash,
      clientAssetCount: clientNames.length,
      clientAssets: clientNames.map((n) => ({
        name: n,
        size: byName.get(n)?.size ?? 0,
      })),
      referencedPublicAssets: referenced.map((url) => ({
        url,
        basename: url.replace(/^\/assets\//, ''),
        present: byName.has(url.replace(/^\/assets\//, '')),
        sources: [...(urlSources.get(url) ?? [])].sort(),
      })),
      missing,
    }
    mkdirSync(distRoot, { recursive: true })
    writeFileSync(manifestPath, JSON.stringify(payload, null, 2) + '\n', 'utf8')
    report.manifestPath = manifestPath
  }

  return report
}

/**
 * CLI entry. Returns process exit code.
 */
export function main(argv = process.argv.slice(2)) {
  if (argv.includes('-h') || argv.includes('--help')) {
    console.log(`Usage: node scripts/assert-build-assets.mjs [options]

  --dist <path>       dist root (default: ./dist)
  --write-manifest    write dist/asset-coherence-manifest.json
  --json              print full JSON report
  --no-strict-empty   do not fail when zero /assets/ refs found

Env: DIST_ROOT, ASSERT_WRITE_MANIFEST=1, ASSERT_JSON=1, ASSERT_STRICT_EMPTY=0
`)
    return 0
  }

  let distRoot = process.env.DIST_ROOT || join(REPO_ROOT, 'dist')
  let writeManifest = process.env.ASSERT_WRITE_MANIFEST === '1'
  let asJson = process.env.ASSERT_JSON === '1'
  let strictEmpty = process.env.ASSERT_STRICT_EMPTY !== '0'

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--dist' && argv[i + 1]) {
      distRoot = resolve(argv[++i])
    } else if (a === '--write-manifest') {
      writeManifest = true
    } else if (a === '--json') {
      asJson = true
    } else if (a === '--no-strict-empty') {
      strictEmpty = false
    }
  }

  const report = assertBuildAssetCoherence({
    distRoot,
    writeManifest,
    strictEmpty,
  })

  if (asJson) {
    console.log(JSON.stringify(report, null, 2))
  } else {
    console.log(
      `ASSET_COHERENCE ${report.ok ? 'OK' : 'FAIL'} dist=${report.distRoot}`,
    )
    console.log(
      `  layout server=${report.layout.serverExists} client_assets=${report.layout.clientAssetsExist} client_files=${report.layout.clientAssetCount}`,
    )
    console.log(
      `  public_refs=${report.referencedCount} present=${report.presentCount} missing=${report.missingCount}`,
    )
    if (report.stylesRefs.length) {
      console.log(`  styles_refs=${report.stylesRefs.join(',')}`)
    }
    console.log(
      `  client_manifest_hash=${report.clientManifest.hash.slice(0, 16)}… (${report.clientManifest.hashAlgo}, ${report.clientManifest.assetCount} files)`,
    )
    if (report.manifestPath) {
      console.log(`  manifest_written=${report.manifestPath}`)
    }
    if (report.emptyRefsFail) {
      console.error(
        'ERROR: zero absolute /assets/* URLs found in dist/server — expected SSR router/manifest preload refs',
      )
    }
    if (!report.layout.serverExists) {
      console.error(`ERROR: missing dist/server at ${join(report.distRoot, 'server')}`)
    }
    if (!report.layout.clientAssetsExist) {
      console.error(
        `ERROR: missing dist/client/assets at ${report.clientAssetsDir}`,
      )
    }
    for (const m of report.missing) {
      console.error(
        `MISSING_PUBLIC_ASSET ${m.url} (basename=${m.basename}) sources=${m.sources.join('|')}`,
      )
    }
    if (!report.ok) {
      console.error(
        'HINT: SSR embedded a public /assets/* URL not emitted under dist/client/assets. Rebuild clean (rm -rf dist) — do not copy stale hashed files or disable hashes.',
      )
    }
  }

  return report.ok ? 0 : 1
}

const isDirect =
  process.argv[1] &&
  resolve(process.argv[1]) === __filename

if (isDirect) {
  process.exit(main())
}

// Allow `node --eval` / tests to import without side effects.
export const meta = {
  REPO_ROOT,
  version: 1,
  contract:
    'quoted absolute /assets/* in dist/server must exist under dist/client/assets',
}
