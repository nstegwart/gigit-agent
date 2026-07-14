/**
 * Unit + fixture self-tests for SSR ↔ client build asset coherence.
 * Does not require a live build (uses temp dist trees). Optional live check
 * when dist/ already present from a prior build.
 */
import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const ROOT = process.cwd()
const SCRIPT = join(ROOT, 'scripts/assert-build-assets.mjs')
const ALIGN_SCRIPT = join(ROOT, 'scripts/align-ssr-style-urls.mjs')

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AlignMod = {
  extractAbsoluteStyleUrls: (text: string) => string[]
  rewriteAbsoluteStyleUrls: (
    text: string,
    clientBasename: string,
  ) => { text: string; replacements: number; beforeUrls: string[] }
  listClientStyleBasenames: (dir: string) => string[]
  alignSsrStyleUrls: (opts?: { distRoot?: string }) => {
    ok: boolean
    exitCode: number
    distRoot: string
    clientBasename?: string
    clientStyleCount: number
    serverStyleRefCount: number
    serverStyleRefs: string[]
    filesTouched: string[]
    totalReplacements: number
    error?: string
    alreadyAligned?: boolean
  }
  main: (argv?: string[]) => number
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AssertMod = {
  extractAbsoluteAssetUrls: (text: string) => string[]
  computeClientManifestHash: (
    names: string[],
    byName: Map<string, { size: number }>,
  ) => string
  indexClientAssets: (dir: string) => {
    names: string[]
    byName: Map<string, { size: number }>
  }
  assertClientBundleNoServerRuntime: (clientAssetsDir: string) => {
    ok: boolean
    scanned: string[]
    hits: { file: string; id: string; sample: string }[]
    skipped?: string
  }
  assertBuildAssetCoherence: (opts?: {
    distRoot?: string
    writeManifest?: boolean
    strictEmpty?: boolean
  }) => {
    ok: boolean
    missingCount: number
    missing: { url: string; basename: string }[]
    referencedCount: number
    emptyRefsFail?: boolean
    clientBoundary?: {
      ok: boolean
      scanned: string[]
      hits: { file: string; id: string; sample: string }[]
    }
    clientManifest: { hash: string; assetCount: number }
    manifestPath?: string
    stylesRefs: string[]
  }
  main: (argv?: string[]) => number
}

const tmpDirs: string[] = []

afterEach(() => {
  while (tmpDirs.length) {
    const d = tmpDirs.pop()
    if (d) rmSync(d, { recursive: true, force: true })
  }
})

async function loadMod(): Promise<AssertMod> {
  return (await import(pathToFileURL(SCRIPT).href)) as AssertMod
}

async function loadAlignMod(): Promise<AlignMod> {
  return (await import(pathToFileURL(ALIGN_SCRIPT).href)) as AlignMod
}

function makeDist(opts: {
  serverFiles?: Record<string, string>
  clientAssets?: Record<string, string | Buffer>
}): string {
  const dir = join(
    tmpdir(),
    `asset-coh-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  )
  mkdirSync(join(dir, 'server', 'assets'), { recursive: true })
  mkdirSync(join(dir, 'client', 'assets'), { recursive: true })
  tmpDirs.push(dir)
  for (const [rel, body] of Object.entries(opts.serverFiles ?? {})) {
    const full = join(dir, 'server', rel)
    mkdirSync(join(full, '..'), { recursive: true })
    writeFileSync(full, body, 'utf8')
  }
  for (const [name, body] of Object.entries(opts.clientAssets ?? {})) {
    writeFileSync(join(dir, 'client', 'assets', name), body)
  }
  return dir
}

describe('extractAbsoluteAssetUrls', () => {
  it('extracts quoted absolute /assets/* only (not ./assets relative)', async () => {
    const { extractAbsoluteAssetUrls } = await loadMod()
    const text = `
      var styles_default = "/assets/styles-B_tDQ5es.css";
      preloads: ['/assets/index-DCU-PDZY.js', \`/assets/foo-abc.css\`]
      import("./assets/router-CSrIPNQM.js");
      importer: () => import("./assets/auth-fns-BWDZRXeh.js")
      not: "/assets/../etc/passwd"
      skip: "assets/no-leading-slash.js"
    `
    const urls = extractAbsoluteAssetUrls(text)
    expect(urls).toEqual([
      '/assets/foo-abc.css',
      '/assets/index-DCU-PDZY.js',
      '/assets/styles-B_tDQ5es.css',
    ])
    expect(urls.join(' ')).not.toMatch(/router-CSrIPNQM/)
    expect(urls.join(' ')).not.toMatch(/auth-fns/)
  })

  it('dedupes and sorts', async () => {
    const { extractAbsoluteAssetUrls } = await loadMod()
    const urls = extractAbsoluteAssetUrls(
      `"/assets/z.js" "/assets/a.js" '/assets/z.js'`,
    )
    expect(urls).toEqual(['/assets/a.js', '/assets/z.js'])
  })
})

describe('computeClientManifestHash', () => {
  it('is deterministic for same inventory and changes when size/name changes', async () => {
    const { computeClientManifestHash } = await loadMod()
    const byName = new Map([
      ['styles-aaa.css', { size: 10 }],
      ['index-bbb.js', { size: 20 }],
    ])
    const names = ['index-bbb.js', 'styles-aaa.css']
    const h1 = computeClientManifestHash(names, byName)
    const h2 = computeClientManifestHash(names, byName)
    expect(h1).toBe(h2)
    expect(h1).toMatch(/^[0-9a-f]{64}$/)
    const byName2 = new Map(byName)
    byName2.set('styles-aaa.css', { size: 11 })
    expect(computeClientManifestHash(names, byName2)).not.toBe(h1)
    expect(
      computeClientManifestHash(['styles-aaa.css', 'index-bbb.js'], byName),
    ).toBe(h1)
  })
})

describe('assertClientBundleNoServerRuntime', () => {
  it('FAIL when index chunk embeds createPool/mysql2/safer-buffer/db.ts', async () => {
    const { assertClientBundleNoServerRuntime } = await loadMod()
    const dist = makeDist({
      clientAssets: {
        'index-LEAK.js':
          'var n=require("mysql2");createPool({});// safer-buffer src/server/db.ts\n',
      },
    })
    const r = assertClientBundleNoServerRuntime(join(dist, 'client', 'assets'))
    expect(r.ok).toBe(false)
    expect(r.hits.map((h) => h.id).sort()).toEqual(
      expect.arrayContaining(['createPool', 'mysql2', 'safer-buffer', 'src/server/db.ts']),
    )
  })

  it('PASS when index has no server runtime markers', async () => {
    const { assertClientBundleNoServerRuntime } = await loadMod()
    const dist = makeDist({
      clientAssets: {
        'index-CLEAN.js': 'console.log("hydrate");\n',
      },
    })
    const r = assertClientBundleNoServerRuntime(join(dist, 'client', 'assets'))
    expect(r.ok).toBe(true)
    expect(r.hits).toEqual([])
  })
})

describe('assertBuildAssetCoherence fixtures', () => {
  it('PASS when SSR styles + preloads exist on client', async () => {
    const { assertBuildAssetCoherence } = await loadMod()
    const dist = makeDist({
      serverFiles: {
        'assets/router-X.js':
          'var styles_default = "/assets/styles-HASH1.css";\n',
        'assets/_tanstack-start-manifest_v-Y.js':
          'preloads: ["/assets/index-HASH2.js","/assets/styles-HASH1.css"]\n',
      },
      clientAssets: {
        'styles-HASH1.css': '/* css */',
        'index-HASH2.js': 'console.log(1)',
      },
    })
    const r = assertBuildAssetCoherence({
      distRoot: dist,
      writeManifest: true,
      strictEmpty: true,
    })
    expect(r.ok).toBe(true)
    expect(r.missingCount).toBe(0)
    expect(r.referencedCount).toBe(2)
    expect(r.stylesRefs).toEqual(['/assets/styles-HASH1.css'])
    expect(r.clientManifest.hash).toMatch(/^[0-9a-f]{64}$/)
    expect(r.manifestPath).toBeTruthy()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((r as any).clientBoundary?.ok).toBe(true)
    const man = JSON.parse(readFileSync(r.manifestPath!, 'utf8'))
    expect(man.clientManifestHash).toBe(r.clientManifest.hash)
    expect(man.ok).toBe(true)
  })

  it('FAIL when SSR styles hash is absent from client (login 404 class)', async () => {
    const { assertBuildAssetCoherence } = await loadMod()
    const dist = makeDist({
      serverFiles: {
        'assets/router-X.js':
          'var styles_default = "/assets/styles-DzTIhR_A.css";\n',
      },
      clientAssets: {
        // client built a different hash — the live staging failure mode
        'styles-BSGBiAUS.css': '/* other hash */',
        'index-ok.js': '1',
      },
    })
    const r = assertBuildAssetCoherence({
      distRoot: dist,
      strictEmpty: true,
    })
    expect(r.ok).toBe(false)
    expect(r.missingCount).toBe(1)
    expect(r.missing[0]?.url).toBe('/assets/styles-DzTIhR_A.css')
    expect(r.missing[0]?.basename).toBe('styles-DzTIhR_A.css')
  })

  it('ignores relative ./assets server-only imports (not public URLs)', async () => {
    const { assertBuildAssetCoherence } = await loadMod()
    const dist = makeDist({
      serverFiles: {
        'server.js': `
          import("./assets/router-ONLY_SERVER.js");
          import("./assets/auth-fns-SERVER.js");
          var styles_default = "/assets/styles-OK.css";
        `,
      },
      clientAssets: {
        'styles-OK.css': 'body{}',
      },
    })
    const r = assertBuildAssetCoherence({ distRoot: dist, strictEmpty: true })
    expect(r.ok).toBe(true)
    expect(r.referencedCount).toBe(1)
    expect(r.missingCount).toBe(0)
  })

  it('FAIL on empty server refs when strictEmpty (broken dist)', async () => {
    const { assertBuildAssetCoherence } = await loadMod()
    const dist = makeDist({
      serverFiles: { 'noop.js': 'export default 1\n' },
      clientAssets: { 'orphan.js': '1' },
    })
    const r = assertBuildAssetCoherence({ distRoot: dist, strictEmpty: true })
    expect(r.ok).toBe(false)
    expect(r.emptyRefsFail).toBe(true)
  })

  it('CLI exits 1 on missing asset', async () => {
    const dist = makeDist({
      serverFiles: {
        'assets/router.js': 'var s = "/assets/styles-MISSING.css";\n',
      },
      clientAssets: { 'other.css': 'x' },
    })
    let status = 0
    let combined = ''
    try {
      combined = execFileSync(
        process.execPath,
        [SCRIPT, '--dist', dist, '--no-strict-empty'],
        { encoding: 'utf8', cwd: ROOT },
      )
    } catch (e: unknown) {
      const err = e as { status?: number; stdout?: string; stderr?: string }
      status = err.status ?? 1
      combined = `${err.stdout || ''}${err.stderr || ''}`
    }
    expect(status).not.toBe(0)
    expect(combined).toMatch(/ASSET_COHERENCE FAIL|MISSING_PUBLIC_ASSET/)
    expect(combined).toMatch(/styles-MISSING\.css/)
  })

  it('CLI exits 0 on coherent fixture + writes manifest', async () => {
    const dist = makeDist({
      serverFiles: {
        'assets/router.js': 'var s = "/assets/styles-OK.css";\n',
      },
      clientAssets: { 'styles-OK.css': 'body{}' },
    })
    const out = execFileSync(
      process.execPath,
      [SCRIPT, '--dist', dist, '--write-manifest'],
      { encoding: 'utf8', cwd: ROOT },
    )
    expect(out).toMatch(/ASSET_COHERENCE OK/)
    expect(out).toMatch(/client_manifest_hash=/)
    expect(existsSync(join(dist, 'asset-coherence-manifest.json'))).toBe(true)
  })
})

describe('align-ssr-style-urls (A3 adversarial)', () => {
  it('rewriteAbsoluteStyleUrls rewrites only absolute /assets/styles-*.css', async () => {
    const { rewriteAbsoluteStyleUrls, extractAbsoluteStyleUrls } =
      await loadAlignMod()
    const input = `
      var styles_default = "/assets/styles-DzTIhR_A.css";
      preloads: ['/assets/styles-OTHER.css', '/assets/index-DCU-PDZY.js']
      import("./assets/styles-relative.css");
      skip: "assets/styles-no-slash.css"
      evil: "/assets/../etc/passwd"
      map: "/assets/styles-DzTIhR_A.css.map"
      keep: \`/assets/styles-DzTIhR_A.css\`
    `
    const { text, replacements, beforeUrls } = rewriteAbsoluteStyleUrls(
      input,
      'styles-CLIENT.css',
    )
    expect(beforeUrls).toEqual([
      '/assets/styles-DzTIhR_A.css',
      '/assets/styles-OTHER.css',
    ])
    expect(replacements).toBe(3) // double, single, backtick of two distinct + third quote form of first
    expect(extractAbsoluteStyleUrls(text)).toEqual([
      '/assets/styles-CLIENT.css',
    ])
    // Non-targets preserved
    expect(text).toContain('/assets/index-DCU-PDZY.js')
    expect(text).toContain('./assets/styles-relative.css')
    expect(text).toContain('assets/styles-no-slash.css')
    expect(text).toContain('/assets/../etc/passwd')
    expect(text).toContain('/assets/styles-DzTIhR_A.css.map')
  })

  it('rewrite is idempotent when already on client basename', async () => {
    const { rewriteAbsoluteStyleUrls } = await loadAlignMod()
    const input = `var s = "/assets/styles-CLIENT.css";\n`
    const r1 = rewriteAbsoluteStyleUrls(input, 'styles-CLIENT.css')
    expect(r1.replacements).toBe(0)
    expect(r1.text).toBe(input)
    const r2 = rewriteAbsoluteStyleUrls(r1.text, 'styles-CLIENT.css')
    expect(r2.replacements).toBe(0)
    expect(r2.text).toBe(input)
  })

  it('align FAIL closed on zero client styles', async () => {
    const { alignSsrStyleUrls } = await loadAlignMod()
    const dist = makeDist({
      serverFiles: {
        'assets/router.js': 'var s = "/assets/styles-DzTIhR_A.css";\n',
      },
      clientAssets: { 'index-ok.js': '1' },
    })
    const r = alignSsrStyleUrls({ distRoot: dist })
    expect(r.ok).toBe(false)
    expect(r.exitCode).toBe(1)
    expect(r.clientStyleCount).toBe(0)
    expect(r.error).toMatch(/zero client global styles/i)
  })

  it('align FAIL closed on multiple client styles', async () => {
    const { alignSsrStyleUrls } = await loadAlignMod()
    const dist = makeDist({
      serverFiles: {
        'assets/router.js': 'var s = "/assets/styles-DzTIhR_A.css";\n',
      },
      clientAssets: {
        'styles-AAA.css': 'a',
        'styles-BBB.css': 'b',
        'index-ok.js': '1',
      },
    })
    const r = alignSsrStyleUrls({ distRoot: dist })
    expect(r.ok).toBe(false)
    expect(r.clientStyleCount).toBe(2)
    expect(r.error).toMatch(/multiple client global styles/i)
    // Must not rewrite on multi-emit
    const body = readFileSync(join(dist, 'server', 'assets', 'router.js'), 'utf8')
    expect(body).toContain('/assets/styles-DzTIhR_A.css')
  })

  it('align FAIL closed on zero server style refs', async () => {
    const { alignSsrStyleUrls } = await loadAlignMod()
    const dist = makeDist({
      serverFiles: { 'noop.js': 'export default 1\n' },
      clientAssets: { 'styles-ONLY.css': 'body{}' },
    })
    const r = alignSsrStyleUrls({ distRoot: dist })
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/zero absolute \/assets\/styles/i)
  })

  it('align rewrites SSR mismatch then assert passes (Linux fail class fixture)', async () => {
    const { alignSsrStyleUrls } = await loadAlignMod()
    const { assertBuildAssetCoherence } = await loadMod()
    const dist = makeDist({
      serverFiles: {
        'assets/router-X.js':
          'var styles_default = "/assets/styles-DzTIhR_A.css";\n',
        'assets/_tanstack-start-manifest_v-Y.js':
          'preloads: ["/assets/index-HASH2.js","/assets/styles-DzTIhR_A.css"]\n',
      },
      clientAssets: {
        'styles-BSGBiAUS.css': '/* client emit */',
        'index-HASH2.js': 'console.log(1)',
      },
    })
    // Pre: assert would fail
    const before = assertBuildAssetCoherence({
      distRoot: dist,
      strictEmpty: true,
    })
    expect(before.ok).toBe(false)
    expect(before.missingCount).toBe(1)

    const align = alignSsrStyleUrls({ distRoot: dist })
    expect(align.ok).toBe(true)
    expect(align.clientBasename).toBe('styles-BSGBiAUS.css')
    expect(align.totalReplacements).toBeGreaterThan(0)
    expect(align.filesTouched.length).toBeGreaterThan(0)

    const after = assertBuildAssetCoherence({
      distRoot: dist,
      writeManifest: true,
      strictEmpty: true,
    })
    expect(after.ok).toBe(true)
    expect(after.missingCount).toBe(0)
    expect(after.stylesRefs).toEqual(['/assets/styles-BSGBiAUS.css'])

    // Idempotent second align
    const align2 = alignSsrStyleUrls({ distRoot: dist })
    expect(align2.ok).toBe(true)
    expect(align2.alreadyAligned).toBe(true)
    expect(align2.totalReplacements).toBe(0)
  })

  it('align does not rewrite non-target /assets paths or relative imports', async () => {
    const { alignSsrStyleUrls } = await loadAlignMod()
    const dist = makeDist({
      serverFiles: {
        'assets/router.js': `
          var styles_default = "/assets/styles-OLD.css";
          import("./assets/router-ONLY_SERVER.js");
          preloads: ["/assets/index-OK.js"];
          evil: "/assets/../styles-OLD.css";
        `,
      },
      clientAssets: {
        'styles-NEW.css': 'body{}',
        'index-OK.js': '1',
      },
    })
    const r = alignSsrStyleUrls({ distRoot: dist })
    expect(r.ok).toBe(true)
    const body = readFileSync(join(dist, 'server', 'assets', 'router.js'), 'utf8')
    expect(body).toContain('/assets/styles-NEW.css')
    expect(body).not.toContain('/assets/styles-OLD.css')
    expect(body).toContain('./assets/router-ONLY_SERVER.js')
    expect(body).toContain('/assets/index-OK.js')
    expect(body).toContain('/assets/../styles-OLD.css')
  })

  it('CLI exits 1 on zero client styles; exits 0 after rewrite fixture', async () => {
    const bad = makeDist({
      serverFiles: {
        'assets/router.js': 'var s = "/assets/styles-MISS.css";\n',
      },
      clientAssets: { 'index.js': '1' },
    })
    let status = 0
    let combined = ''
    try {
      combined = execFileSync(
        process.execPath,
        [ALIGN_SCRIPT, '--dist', bad],
        { encoding: 'utf8', cwd: ROOT },
      )
    } catch (e: unknown) {
      const err = e as { status?: number; stdout?: string; stderr?: string }
      status = err.status ?? 1
      combined = `${err.stdout || ''}${err.stderr || ''}`
    }
    expect(status).not.toBe(0)
    expect(combined).toMatch(/SSR_STYLE_ALIGN FAIL|zero client/)

    const good = makeDist({
      serverFiles: {
        'assets/router.js': 'var s = "/assets/styles-OLD.css";\n',
      },
      clientAssets: { 'styles-NEW.css': 'x' },
    })
    const out = execFileSync(
      process.execPath,
      [ALIGN_SCRIPT, '--dist', good],
      { encoding: 'utf8', cwd: ROOT },
    )
    expect(out).toMatch(/SSR_STYLE_ALIGN OK/)
    expect(out).toMatch(/styles-NEW\.css/)
    const body = readFileSync(
      join(good, 'server', 'assets', 'router.js'),
      'utf8',
    )
    expect(body).toContain('/assets/styles-NEW.css')
  })
})

describe('package + deploy wiring (static contract)', () => {
  it('package.json build chains align then assert-build-assets', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
    expect(pkg.scripts.build).toMatch(/align-ssr-style-urls/)
    expect(pkg.scripts.build).toMatch(/assert-build-assets/)
    // Order: vite → align → assert
    const build: string = pkg.scripts.build
    expect(build.indexOf('align-ssr-style-urls')).toBeLessThan(
      build.indexOf('assert-build-assets'),
    )
    expect(pkg.scripts['assert-build-assets']).toMatch(
      /scripts\/assert-build-assets\.mjs/,
    )
    expect(pkg.scripts['align-ssr-style-urls']).toMatch(
      /scripts\/align-ssr-style-urls\.mjs/,
    )
  })

  it('staging Dockerfile copies align + assert scripts and runs pnpm build', () => {
    const df = readFileSync(join(ROOT, 'deploy/staging/Dockerfile'), 'utf8')
    // Scripts must be present before RUN pnpm build (package.json chains align+assert).
    expect(df).toMatch(/COPY scripts\/align-ssr-style-urls\.mjs/)
    expect(df).toMatch(/COPY scripts\/assert-build-assets\.mjs/)
    const alignIdx = df.indexOf('COPY scripts/align-ssr-style-urls.mjs')
    const copyIdx = df.indexOf('COPY scripts/assert-build-assets.mjs')
    const buildIdx = df.indexOf('pnpm build')
    expect(alignIdx).toBeGreaterThan(-1)
    expect(copyIdx).toBeGreaterThan(-1)
    expect(buildIdx).toBeGreaterThan(alignIdx)
    expect(buildIdx).toBeGreaterThan(copyIdx)
    // Coherence comments present so operators do not disable hashes to "fix".
    expect(df).toMatch(/asset coherence|content hashes|assert/i)
  })

  it('staging deploy supports no-cache clean rebuild path', () => {
    const deploy = readFileSync(
      join(ROOT, 'deploy/staging/scripts/deploy.sh'),
      'utf8',
    )
    expect(deploy).toMatch(/--no-cache|NO_CACHE/)
    expect(deploy).toMatch(/assert-build-assets|ASSET_COHERENCE|manifest/)
  })

  it('production build-install runs asset assert after build', () => {
    const bi = readFileSync(
      join(ROOT, 'deploy/production/scripts/build-install.sh'),
      'utf8',
    )
    expect(bi).toMatch(/assert-build-assets/)
  })

  it('runbooks document asset coherence + clean rebuild', () => {
    const st = readFileSync(join(ROOT, 'docs/runbook-staging.md'), 'utf8')
    const pr = readFileSync(join(ROOT, 'docs/runbook-production.md'), 'utf8')
    expect(st).toMatch(/assert-build-assets|asset coherence|ASSET_COHERENCE/i)
    expect(st).toMatch(/no-cache|clean rebuild/i)
    expect(pr).toMatch(/assert-build-assets|asset coherence|ASSET_COHERENCE/i)
  })
})

describe('live dist (optional support evidence)', () => {
  it('if dist/server+client exist, assert exits 0', () => {
    const server = join(ROOT, 'dist/server')
    const clientAssets = join(ROOT, 'dist/client/assets')
    if (!existsSync(server) || !existsSync(clientAssets)) {
      // Not a failure — clean trees may not have been built yet in unit-only runs.
      expect(true).toBe(true)
      return
    }
    const out = execFileSync(
      process.execPath,
      [SCRIPT, '--write-manifest'],
      { encoding: 'utf8', cwd: ROOT },
    )
    expect(out).toMatch(/ASSET_COHERENCE OK/)
  })
})
