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

describe('package + deploy wiring (static contract)', () => {
  it('package.json build chains assert-build-assets', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
    expect(pkg.scripts.build).toMatch(/assert-build-assets/)
    expect(pkg.scripts['assert-build-assets']).toMatch(
      /scripts\/assert-build-assets\.mjs/,
    )
  })

  it('staging Dockerfile copies assert script and runs pnpm build (package chains assert)', () => {
    const df = readFileSync(join(ROOT, 'deploy/staging/Dockerfile'), 'utf8')
    // Script must be present before RUN pnpm build (package.json chains the assert).
    expect(df).toMatch(/COPY scripts\/assert-build-assets\.mjs/)
    const copyIdx = df.indexOf('COPY scripts/assert-build-assets.mjs')
    const buildIdx = df.indexOf('pnpm build')
    expect(copyIdx).toBeGreaterThan(-1)
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
