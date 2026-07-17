/**
 * CSP header contract — explicit script-src (and style-src) must be present and
 * must not be looser than the historical default-src source list.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CONTENT_SECURITY_POLICY } from '../../vite.config'

const ROOT = join(process.cwd())

describe('Content-Security-Policy (vite preview/server headers)', () => {
  it('exports an explicit script-src matching default-src sources', () => {
    expect(CONTENT_SECURITY_POLICY).toMatch(/default-src\s+'self'/)
    expect(CONTENT_SECURITY_POLICY).toMatch(/script-src\s+'self'/)
    expect(CONTENT_SECURITY_POLICY).toMatch(/style-src\s+'self'/)
    expect(CONTENT_SECURITY_POLICY).toMatch(/frame-ancestors\s+'self'/)

    // Same safety as historical default-src (do not loosen).
    for (const token of [
      "'self'",
      'http:',
      'https:',
      'ws:',
      'wss:',
      'data:',
      'blob:',
      "'unsafe-inline'",
    ]) {
      expect(CONTENT_SECURITY_POLICY).toContain(token)
    }

    // No eval relaxation.
    expect(CONTENT_SECURITY_POLICY).not.toMatch(/unsafe-eval/)
  })

  it('wires Content-Security-Policy into vite preview headers', () => {
    const src = readFileSync(join(ROOT, 'vite.config.ts'), 'utf8')
    expect(src).toMatch(/Content-Security-Policy/)
    expect(src).toMatch(/preview:\s*\{[\s\S]*headers:/)
    expect(src).toMatch(/script-src/)
    expect(src).toMatch(/style-src/)
  })

  it('registers configurePreviewServer middleware so SSR routes get CSP', () => {
    const src = readFileSync(join(ROOT, 'vite.config.ts'), 'utf8')
    expect(src).toMatch(/configurePreviewServer/)
    expect(src).toMatch(/configureServer/)
    expect(src).toMatch(/task-manager-csp-headers/)
    expect(src).toMatch(/setHeader/)
  })
})
