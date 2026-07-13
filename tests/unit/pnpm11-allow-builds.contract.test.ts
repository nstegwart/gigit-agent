/**
 * pnpm 11 allowBuilds contract (Docker deps stage).
 *
 * Remote proof failure: ERR_PNPM_IGNORED_BUILDS unrs-resolver@1.12.2 under pnpm@11.5.2
 * frozen install when project settings were missing from the image.
 *
 * Official pnpm 11: allowBuilds lives in pnpm-workspace.yaml (not onlyBuiltDependencies).
 * Forbid dangerouslyAllowAllBuilds / blanket install-script bypasses.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = process.cwd()
const WORKSPACE = join(ROOT, 'pnpm-workspace.yaml')
const DOCKERFILE = join(ROOT, 'deploy/staging/Dockerfile')
const NPMRC = join(ROOT, '.npmrc')

function nonCommentLines(text: string): string {
  return text
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n')
}

describe('pnpm 11 narrow allowBuilds + Dockerfile copy order', () => {
  it('pnpm-workspace.yaml allows unrs-resolver only as reviewed map (no all-builds)', () => {
    const raw = readFileSync(WORKSPACE, 'utf8')
    const body = nonCommentLines(raw)

    expect(body).toMatch(/allowBuilds\s*:/)
    expect(body).toMatch(/unrs-resolver\s*:\s*true/)
    // Narrow allowlist: no blanket bypass keys.
    expect(body).not.toMatch(/dangerouslyAllowAllBuilds\s*:\s*true/)
    expect(body).not.toMatch(/neverBuiltDependencies/)
    // Legacy package.json-style key must not reappear as the primary gate here.
    expect(body).not.toMatch(/onlyBuiltDependencies/)

    // Parse allowBuilds keys: every listed package must be explicitly true.
    const allowSection = body.match(/allowBuilds\s*:\s*\n((?:[ \t]+\S[^\n]*\n?)*)/)
    expect(allowSection, 'allowBuilds block present').toBeTruthy()
    const entries = (allowSection?.[1] ?? '')
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => {
        const m = l.match(/^([\w@/.-]+)\s*:\s*(true|false)\s*$/)
        return m ? { name: m[1], value: m[2] } : null
      })
      .filter((x): x is { name: string; value: string } => x !== null)

    expect(entries.some((e) => e.name === 'unrs-resolver' && e.value === 'true')).toBe(
      true,
    )
    // No false-entry noise; only explicit true allows.
    for (const e of entries) {
      expect(e.value, `${e.name} must be true when listed`).toBe('true')
    }
  })

  it('Dockerfile copies pnpm-workspace.yaml before pnpm install; no all-builds bypass', () => {
    const raw = readFileSync(DOCKERFILE, 'utf8')
    const body = nonCommentLines(raw)

    expect(body).not.toMatch(/dangerouslyAllowAllBuilds/)
    expect(body).not.toMatch(/PNPM_IGNORE_DEP_SCRIPTS/)
    expect(body).not.toMatch(/--config\.ignore-dep-scripts=false/)
    expect(body).not.toMatch(/approve-builds/)

    // Find first frozen install in deps path and require workspace file on a prior COPY.
    const installIdx = body.search(/RUN\s+pnpm\s+install\s+--frozen-lockfile/)
    expect(installIdx, 'frozen install present').toBeGreaterThanOrEqual(0)
    const beforeInstall = body.slice(0, installIdx)
    expect(beforeInstall).toMatch(/COPY[^\n]*pnpm-workspace\.yaml/)

    // Same COPY line (or preceding deps COPY) must include the workspace with package manifests.
    const copyLines = beforeInstall
      .split('\n')
      .filter((l) => /^\s*COPY\b/.test(l) && /pnpm-workspace\.yaml/.test(l))
    expect(copyLines.length).toBeGreaterThanOrEqual(1)
    const depsCopy = copyLines[0]
    expect(depsCopy).toMatch(/package\.json/)
    expect(depsCopy).toMatch(/pnpm-lock\.yaml/)
    expect(depsCopy).toMatch(/pnpm-workspace\.yaml/)
  })

  it('.npmrc does not enable all-builds / script-ignore bypass for this fix', () => {
    const npmrc = readFileSync(NPMRC, 'utf8')
    expect(npmrc).not.toMatch(/dangerouslyAllowAllBuilds\s*=\s*true/i)
    expect(npmrc).not.toMatch(/ignore-dep-scripts\s*=\s*false/i)
  })
})
