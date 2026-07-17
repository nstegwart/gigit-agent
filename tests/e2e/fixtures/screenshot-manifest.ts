/**
 * Screenshot-manifest schema + collector (UI_CONTRACT §13 / AC-UI-07).
 * Foundation stage: schema validation + row assembly only.
 * Do not fabricate staging pins (boardRev/lifecycleRev/canonical*) — mark MISSING.
 *
 * ART S01–S24 visual gate (01B RELEASE-BLOCKING): maxDiffPixelRatio 0.002;
 * baselines bound to full release SHA under qa/e2e/out/baselines/<fullSha>/.
 */
import fs from 'node:fs'
import path from 'node:path'

import {
  resolveFullSha,
  resolveSchemaVersion,
  resolveStagingUrl,
} from './env'

/** 01B / ART-UX-DIRECTION visual regression threshold — unexpected ratio above this fails. */
export const MAX_DIFF_PIXEL_RATIO = 0.002 as const

/** Default roots for promoted harness outputs. */
export const AXE_OUT_DIR = path.join(process.cwd(), 'qa/e2e/out/axe')
export const BASELINES_OUT_DIR = path.join(process.cwd(), 'qa/e2e/out/baselines')

/** ART S01–S24 ids (exact staging screenshot matrix). */
export const ART_SID_IDS = Array.from(
  { length: 24 },
  (_, i) => `S${String(i + 1).padStart(2, '0')}`,
) as readonly string[]

/** UI_CONTRACT §5 states. */
export const MANIFEST_STATES = [
  'populated',
  'loading',
  'empty',
  'zero-results',
  'partial',
  'stale',
  'disconnected',
  'error',
  'forbidden',
  'needs-human',
] as const

export type ManifestState = (typeof MANIFEST_STATES)[number]

export type ArtSidId = (typeof ART_SID_IDS)[number]

export type ScreenshotManifestRow = {
  route: string
  state: ManifestState
  viewport?: string
  zoom?: string
  stagingUrl: string
  fullSha: string
  schemaVersion: string
  canonicalSnapshotId: string
  canonicalHash: string
  boardRev: string
  lifecycleRev: string
  capturedAt: string
  browserTestId: string
  accessibilityResult: string
  missionQuestionLink: string | null
  visualDiff?: string
  /** Foundation marker when server pin fields are unavailable. */
  pinFields?: 'PRESENT' | 'MISSING'
  screenshotPath?: string
  /** ART matrix id S01–S24 when row maps to a visual/axe scenario. */
  artSid?: string
  /** Pixel-diff gate for SHA-bound baseline compare (default 0.002). */
  maxDiffPixelRatio?: number
  /** Path to SHA-bound baseline PNG when present. */
  baselinePath?: string
}

export type ScreenshotManifest = {
  schemaVersion: string
  generatedAt: string
  rows: ScreenshotManifestRow[]
  runId?: string | null
  version?: number
  rowCount?: number
}

export const MANIFEST_REQUIRED_FIELDS = [
  'route',
  'state',
  'stagingUrl',
  'fullSha',
  'schemaVersion',
  'canonicalSnapshotId',
  'canonicalHash',
  'boardRev',
  'lifecycleRev',
  'capturedAt',
  'browserTestId',
  'accessibilityResult',
  'missionQuestionLink',
] as const

export const PIN_MISSING = 'MISSING'

export type BuildRowInput = {
  route: string
  state: ManifestState
  viewport?: string
  zoom?: string
  browserTestId: string
  accessibilityResult: string
  missionQuestionLink?: string | null
  visualDiff?: string
  screenshotPath?: string
  artSid?: string
  maxDiffPixelRatio?: number
  baselinePath?: string
  /** When omitted, pin fields default to MISSING (fail-honest, no fabrication). */
  pins?: {
    canonicalSnapshotId?: string
    canonicalHash?: string
    boardRev?: string
    lifecycleRev?: string
  }
  stagingUrl?: string
  fullSha?: string
  schemaVersion?: string
}

/**
 * SHA-bound baseline directory for a release (qa/e2e/out/baselines/<fullSha>/).
 * @throws if fullSha is not 40-char hex
 */
export function baselineDirForFullSha(
  fullSha: string,
  baselinesRoot: string = BASELINES_OUT_DIR,
): string {
  const s = String(fullSha).trim().toLowerCase()
  if (!/^[0-9a-f]{40}$/.test(s)) {
    throw new Error(
      `baselineDirForFullSha: fullSha must be 40-char hex (got length=${fullSha?.length ?? 0})`,
    )
  }
  return path.join(baselinesRoot, s)
}

/**
 * Paths for one ART SID under a release SHA.
 */
export function artSidBaselinePaths(
  artSid: string,
  fullSha: string,
  baselinesRoot: string = BASELINES_OUT_DIR,
): { baselineDir: string; baselinePng: string; receiptPath: string } {
  if (!/^S\d{2}$/.test(artSid)) {
    throw new Error(`artSidBaselinePaths: invalid artSid ${artSid}`)
  }
  const baselineDir = baselineDirForFullSha(fullSha, baselinesRoot)
  return {
    baselineDir,
    baselinePng: path.join(baselineDir, `${artSid}.png`),
    receiptPath: path.join(baselineDir, `${artSid}.receipt.json`),
  }
}

/**
 * Default axe receipt path for an ART SID under qa/e2e/out/axe/.
 */
export function artSidAxePath(artSid: string, axeRoot: string = AXE_OUT_DIR): string {
  if (!/^S\d{2}$/.test(artSid)) {
    throw new Error(`artSidAxePath: invalid artSid ${artSid}`)
  }
  return path.join(axeRoot, `axe-${artSid}.json`)
}

export function buildManifestRow(input: BuildRowInput): ScreenshotManifestRow {
  if (!input.viewport && !input.zoom) {
    throw new Error('screenshot-manifest row requires viewport or zoom')
  }
  if (!MANIFEST_STATES.includes(input.state)) {
    throw new Error(`invalid manifest state: ${input.state}`)
  }
  if (input.artSid != null && !/^S\d{2}$/.test(input.artSid)) {
    throw new Error(`invalid artSid: ${input.artSid}`)
  }
  if (
    input.maxDiffPixelRatio != null &&
    input.maxDiffPixelRatio !== MAX_DIFF_PIXEL_RATIO
  ) {
    throw new Error(
      `maxDiffPixelRatio must be ${MAX_DIFF_PIXEL_RATIO} (got ${input.maxDiffPixelRatio})`,
    )
  }

  const pins = input.pins ?? {}
  const canonicalSnapshotId = pins.canonicalSnapshotId ?? PIN_MISSING
  const canonicalHash = pins.canonicalHash ?? PIN_MISSING
  const boardRev = pins.boardRev ?? PIN_MISSING
  const lifecycleRev = pins.lifecycleRev ?? PIN_MISSING
  const pinFields: 'PRESENT' | 'MISSING' =
    canonicalSnapshotId !== PIN_MISSING &&
    canonicalHash !== PIN_MISSING &&
    boardRev !== PIN_MISSING &&
    lifecycleRev !== PIN_MISSING
      ? 'PRESENT'
      : 'MISSING'

  return {
    route: input.route,
    state: input.state,
    viewport: input.viewport,
    zoom: input.zoom,
    stagingUrl: input.stagingUrl ?? resolveStagingUrl(),
    fullSha: input.fullSha ?? resolveFullSha(),
    schemaVersion: input.schemaVersion ?? resolveSchemaVersion(),
    canonicalSnapshotId,
    canonicalHash,
    boardRev,
    lifecycleRev,
    capturedAt: new Date().toISOString(),
    browserTestId: input.browserTestId,
    accessibilityResult: input.accessibilityResult,
    missionQuestionLink: input.missionQuestionLink ?? null,
    visualDiff: input.visualDiff,
    pinFields,
    screenshotPath: input.screenshotPath,
    artSid: input.artSid,
    maxDiffPixelRatio:
      input.maxDiffPixelRatio ?? (input.artSid ? MAX_DIFF_PIXEL_RATIO : undefined),
    baselinePath: input.baselinePath,
  }
}

export function validateManifestRow(row: ScreenshotManifestRow): string[] {
  const errors: string[] = []
  for (const key of MANIFEST_REQUIRED_FIELDS) {
    const v = row[key]
    // missionQuestionLink may be null (no Q1–Q8 link); empty string is invalid.
    if (key === 'missionQuestionLink') {
      if (v === undefined || v === '') {
        errors.push(`missing required field: ${key}`)
      }
      continue
    }
    if (v === undefined || v === null || v === '') {
      errors.push(`missing required field: ${key}`)
    }
  }
  if (!row.viewport && !row.zoom) {
    errors.push('missing viewport or zoom')
  }
  if (!MANIFEST_STATES.includes(row.state)) {
    errors.push(`invalid state: ${row.state}`)
  }
  return errors
}

export class ScreenshotManifestCollector {
  readonly rows: ScreenshotManifestRow[] = []
  runId: string | null
  version: number

  constructor(opts: { runId?: string | null; version?: number } = {}) {
    this.runId = opts.runId ?? null
    this.version = opts.version ?? 1
  }

  /** Fresh run: drop prior rows (never append stale). */
  clear(): this {
    this.rows.length = 0
    return this
  }

  add(input: BuildRowInput): ScreenshotManifestRow {
    const row = buildManifestRow(input)
    const errors = validateManifestRow(row)
    if (errors.length) {
      throw new Error(`invalid manifest row: ${errors.join('; ')}`)
    }
    this.rows.push(row)
    return row
  }

  toManifest(): ScreenshotManifest & { runId: string | null; version: number; rowCount: number } {
    return {
      schemaVersion: resolveSchemaVersion(),
      generatedAt: new Date().toISOString(),
      runId: this.runId,
      version: this.version,
      rowCount: this.rows.length,
      rows: [...this.rows],
    }
  }

  write(filePath: string): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    fs.writeFileSync(filePath, JSON.stringify(this.toManifest(), null, 2), 'utf8')
  }
}

export const DEFAULT_MANIFEST_PATH = path.join(
  process.cwd(),
  'qa/e2e/manifests/screenshot-manifest.latest.json',
)

export const DEFAULT_SCHEMA_PATH = path.join(
  process.cwd(),
  'qa/e2e/manifests/screenshot-manifest.schema.json',
)
