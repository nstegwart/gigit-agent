/**
 * Pure deep-link helpers for Evidence drawer (`?evidence=`).
 * Parent route owns URL search params; this module only encode/decode.
 */

const EVIDENCE_PARAM = 'evidence'

/**
 * Read evidence id from a search-param record or URLSearchParams-like object.
 * Returns null when absent/empty — never invents an id.
 */
export function parseEvidenceDeepLink(
  search:
    | Record<string, unknown>
    | URLSearchParams
    | { get?: (key: string) => string | null }
    | null
    | undefined,
): string | null {
  if (search == null) return null
  let raw: unknown
  if (typeof (search as URLSearchParams).get === 'function') {
    raw = (search as URLSearchParams).get(EVIDENCE_PARAM)
  } else if (typeof search === 'object') {
    raw = (search as Record<string, unknown>)[EVIDENCE_PARAM]
  }
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  return trimmed.length > 0 ? trimmed : null
}

/**
 * Merge `evidence` into an existing search-param record.
 * Pass null/empty to omit the param (close deep-link).
 */
export function encodeEvidenceDeepLink(
  base: Record<string, string | undefined | null> = {},
  evidenceId: string | null | undefined,
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(base)) {
    if (key === EVIDENCE_PARAM) continue
    if (typeof value === 'string' && value.length > 0) out[key] = value
  }
  if (typeof evidenceId === 'string' && evidenceId.trim().length > 0) {
    out[EVIDENCE_PARAM] = evidenceId.trim()
  }
  return out
}

/**
 * Build a relative path that opens the drawer via query param without losing page path.
 * Example: `/b/mfs-rebuild/evidence?evidence=ev-1&cursor=abc`
 */
export function evidenceDeepLinkPath(
  pathname: string,
  evidenceId: string,
  existingSearch: Record<string, string | undefined | null> = {},
): string {
  const params = new URLSearchParams(
    encodeEvidenceDeepLink(existingSearch, evidenceId),
  )
  const qs = params.toString()
  const path = pathname.startsWith('/') ? pathname : `/${pathname}`
  return qs ? `${path}?${qs}` : path
}

export { EVIDENCE_PARAM }
