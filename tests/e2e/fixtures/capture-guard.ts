/**
 * Screenshot integrity guards (TS mirror of qa/e2e/lib/capture-guard.mjs).
 */
import fs from 'node:fs'

export function readPngDimensions(filePath: string): {
  width: number
  height: number
  bytes: number
} {
  const buf = fs.readFileSync(filePath)
  if (buf.length < 24) throw new Error(`PNG too small: ${filePath}`)
  const sig = buf.subarray(0, 8)
  const expected = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
  if (!sig.equals(expected)) throw new Error(`not a PNG: ${filePath}`)
  const type = buf.toString('ascii', 12, 16)
  if (type !== 'IHDR') throw new Error(`PNG missing IHDR: ${filePath}`)
  return {
    width: buf.readUInt32BE(16),
    height: buf.readUInt32BE(20),
    bytes: buf.length,
  }
}

export function assessPngHealth(
  filePath: string,
  expected?: {
    width?: number
    height?: number
    exactHeight?: boolean
    fullPage?: boolean
  },
): { ok: boolean; errors: string[]; dimensions: { width: number; height: number; bytes: number } } {
  const dim = readPngDimensions(filePath)
  const errors: string[] = []
  if (expected?.width && dim.width !== expected.width) {
    errors.push(`width ${dim.width} !== expected ${expected.width}`)
  }
  if (expected?.height) {
    if (expected.exactHeight && dim.height !== expected.height) {
      errors.push(`height ${dim.height} !== expected ${expected.height}`)
    } else if (!expected.fullPage && dim.height !== expected.height) {
      errors.push(`height ${dim.height} !== expected ${expected.height}`)
    } else if (expected.fullPage && dim.height < expected.height) {
      errors.push(`fullPage height ${dim.height} < viewport ${expected.height}`)
    }
  }
  if (dim.bytes < 800) {
    errors.push(`file too small (${dim.bytes} bytes) — likely blank/corrupt`)
  }
  return { ok: errors.length === 0, errors, dimensions: dim }
}

export function assertScreenshotHealthy(
  filePath: string,
  expected?: {
    width?: number
    height?: number
    exactHeight?: boolean
    fullPage?: boolean
  },
): ReturnType<typeof assessPngHealth> {
  const r = assessPngHealth(filePath, expected)
  if (!r.ok) {
    throw new Error(
      `CAPTURE_GUARD FAIL: ${filePath} — ${r.errors.join('; ')} dims=${r.dimensions.width}x${r.dimensions.height}`,
    )
  }
  return r
}

export function assertNotLoginCapture(row: {
  url?: string
  filename?: string
  path?: string
  loginFormPresent?: boolean
  allowLoginUrl?: boolean
  allowLoginName?: boolean
}): void {
  const name = String(row.filename || row.path || '')
  if (/login|setup-auth|unauth-login/i.test(name) && row.allowLoginName) return
  if (row.url && /\/login|\/setup/.test(row.url) && !row.allowLoginUrl) {
    throw new Error(`CAPTURE_GUARD FAIL: login URL captured as authenticated proof: ${row.url}`)
  }
  if (row.loginFormPresent) {
    throw new Error(
      `CAPTURE_GUARD FAIL: login form present in authenticated capture ${name || row.url}`,
    )
  }
}
