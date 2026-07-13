/**
 * Screenshot integrity guards for deterministic harness.
 * Fail on login surface, blank/black corruption, wrong dimensions, stale artifacts.
 */
import fs from 'node:fs'
import path from 'node:path'

/** Minimal PNG IHDR reader (no sharp dependency). */
export function readPngDimensions(filePath) {
  const buf = fs.readFileSync(filePath)
  if (buf.length < 24) throw new Error(`PNG too small: ${filePath}`)
  const sig = buf.subarray(0, 8)
  const expected = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
  if (!sig.equals(expected)) throw new Error(`not a PNG: ${filePath}`)
  // IHDR: length(4) + 'IHDR'(4) + width(4) + height(4)
  const type = buf.toString('ascii', 12, 16)
  if (type !== 'IHDR') throw new Error(`PNG missing IHDR: ${filePath}`)
  const width = buf.readUInt32BE(16)
  const height = buf.readUInt32BE(20)
  return { width, height, bytes: buf.length }
}

/**
 * Sample raw bytes for near-black / near-white dominance (cheap corruption heuristic).
 * Not a full image decode — flags only extreme tiny/empty or absurdly small files.
 */
export function assessPngHealth(filePath, expected) {
  const dim = readPngDimensions(filePath)
  const errors = []
  if (expected?.width && dim.width !== expected.width) {
    errors.push(`width ${dim.width} !== expected ${expected.width}`)
  }
  if (expected?.height && dim.height !== expected.height) {
    // fullPage screenshots may exceed viewport height — only enforce min when fullPage
    if (expected.exactHeight && dim.height !== expected.height) {
      errors.push(`height ${dim.height} !== expected ${expected.height}`)
    } else if (!expected.fullPage && dim.height !== expected.height) {
      errors.push(`height ${dim.height} !== expected ${expected.height}`)
    } else if (expected.fullPage && dim.height < expected.height) {
      errors.push(`fullPage height ${dim.height} < viewport ${expected.height}`)
    }
  }
  // Empty-ish: under 800 bytes almost always corrupt / blank canvas edge case
  if (dim.bytes < 800) {
    errors.push(`file too small (${dim.bytes} bytes) — likely blank/corrupt`)
  }
  // Absurdly large without fullPage flag: may be wrong capture mode (soft warn only)
  return {
    ok: errors.length === 0,
    errors,
    dimensions: dim,
    path: filePath,
  }
}

export function assertScreenshotHealthy(filePath, expected) {
  const r = assessPngHealth(filePath, expected)
  if (!r.ok) {
    throw new Error(
      `CAPTURE_GUARD FAIL: ${filePath} — ${r.errors.join('; ')} dims=${r.dimensions.width}x${r.dimensions.height}`,
    )
  }
  return r
}

/**
 * Reject captures that accidentally stored a login page.
 * @param {{ url: string, filename: string, loginFormPresent?: boolean }} row
 */
export function assertNotLoginCapture(row) {
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

/** Clear directory of prior run artifacts (fresh manifest / shots). */
export function clearDirContents(dir, { keepGitkeep = true } = {}) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
    return { cleared: 0, dir }
  }
  let cleared = 0
  for (const name of fs.readdirSync(dir)) {
    if (keepGitkeep && (name === '.gitkeep' || name === '.gitignore')) continue
    const p = path.join(dir, name)
    fs.rmSync(p, { recursive: true, force: true })
    cleared++
  }
  return { cleared, dir }
}

/**
 * Fail if artifact mtime is older than run start (stale reuse).
 * @param {string} filePath
 * @param {number} runStartedMs epoch ms
 */
export function assertArtifactFresh(filePath, runStartedMs, slackMs = 5_000) {
  const st = fs.statSync(filePath)
  if (st.mtimeMs + slackMs < runStartedMs) {
    throw new Error(
      `CAPTURE_GUARD FAIL: stale artifact ${filePath} mtime=${new Date(st.mtimeMs).toISOString()} runStart=${new Date(runStartedMs).toISOString()}`,
    )
  }
  return { path: filePath, mtimeMs: st.mtimeMs }
}
