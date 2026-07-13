#!/usr/bin/env node
/**
 * Promoted flow: unauthenticated public snapshot API probe.
 * Extends unit public-snapshot contract to HTTP boundary.
 * Env: WEB_BASE
 */
import { printOwnerTarget, resolveWebBase } from '../lib/env.mjs'

async function main() {
  const base = resolveWebBase()
  printOwnerTarget({ flow: 'public-snapshot' })
  const url = `${base}/api/public-snapshot`
  try {
    const res = await fetch(url, { headers: { accept: 'application/json' } })
    const status = res.status
    const text = await res.text()
    let body
    try {
      body = JSON.parse(text)
    } catch {
      body = null
    }
    console.log(
      JSON.stringify(
        {
          url,
          status,
          ok: res.ok,
          hasBody: body !== null,
          keys: body && typeof body === 'object' ? Object.keys(body).slice(0, 20) : [],
        },
        null,
        2,
      ),
    )
    // Foundation: report status; 401/404/200 all useful — do not fabricate success.
    process.exitCode = res.ok ? 0 : 1
  } catch (e) {
    console.error(String(e?.stack || e))
    process.exitCode = 1
  }
}

main()
