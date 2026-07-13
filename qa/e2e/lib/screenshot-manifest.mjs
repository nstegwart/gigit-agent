/**
 * Screenshot-manifest collector (UI_CONTRACT §13). Never fabricates pin fields.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  resolveFullSha,
  resolveSchemaVersion,
  resolveStagingUrl,
} from './env.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

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
]

export const PIN_MISSING = 'MISSING'

export const DEFAULT_MANIFEST_PATH = path.resolve(
  __dirname,
  '../manifests/screenshot-manifest.latest.json',
)

export const DEFAULT_SCHEMA_PATH = path.resolve(
  __dirname,
  '../manifests/screenshot-manifest.schema.json',
)

export function buildManifestRow(input) {
  if (!input.viewport && !input.zoom) {
    throw new Error('screenshot-manifest row requires viewport or zoom')
  }
  if (!MANIFEST_STATES.includes(input.state)) {
    throw new Error(`invalid manifest state: ${input.state}`)
  }
  const pins = input.pins ?? {}
  const canonicalSnapshotId = String(pins.canonicalSnapshotId ?? PIN_MISSING)
  const canonicalHash = String(pins.canonicalHash ?? PIN_MISSING)
  const boardRev = String(pins.boardRev ?? PIN_MISSING)
  const lifecycleRev = String(pins.lifecycleRev ?? PIN_MISSING)
  const pinFields =
    [canonicalSnapshotId, canonicalHash, boardRev, lifecycleRev].every((v) => v !== PIN_MISSING)
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
    capturedAt: input.capturedAt ?? new Date().toISOString(),
    browserTestId: input.browserTestId,
    serverTestId: input.serverTestId ?? input.browserTestId,
    runId: input.runId,
    accessibilityResult: input.accessibilityResult,
    missionQuestionLink: input.missionQuestionLink ?? null,
    visualDiff: input.visualDiff,
    pinFields,
    screenshotPath: input.screenshotPath,
    fullPageScreenshotPath: input.fullPageScreenshotPath,
    /** Accurate capture dimensions (viewport-only shot). */
    width: input.width,
    height: input.height,
    captureMode: input.captureMode ?? (input.zoom ? 'zoom' : 'viewport'),
  }
}

export function validateManifestRow(row) {
  const required = [
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
  ]
  const errors = []
  for (const key of required) {
    if (row[key] === undefined || row[key] === null || row[key] === '') {
      // missionQuestionLink may be null
      if (key === 'missionQuestionLink' && row[key] === null) continue
      errors.push(`missing required field: ${key}`)
    }
  }
  if (!row.viewport && !row.zoom) errors.push('missing viewport or zoom')
  if (!MANIFEST_STATES.includes(row.state)) errors.push(`invalid state: ${row.state}`)
  return errors
}

export class ScreenshotManifestCollector {
  constructor(opts = {}) {
    this.rows = []
    this.runId = opts.runId ?? null
    this.version = opts.version ?? 1
  }

  /** Fresh run: drop prior rows (never append stale). */
  clear() {
    this.rows = []
    return this
  }

  add(input) {
    const row = buildManifestRow({
      ...input,
      runId: input.runId ?? this.runId,
    })
    const errors = validateManifestRow(row)
    if (errors.length) throw new Error(`invalid manifest row: ${errors.join('; ')}`)
    this.rows.push(row)
    return row
  }

  toManifest() {
    return {
      schemaVersion: resolveSchemaVersion(),
      generatedAt: new Date().toISOString(),
      runId: this.runId,
      version: this.version,
      rowCount: this.rows.length,
      rows: [...this.rows],
    }
  }

  write(filePath = DEFAULT_MANIFEST_PATH) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    // Always overwrite — fresh versioned manifest each run
    fs.writeFileSync(filePath, JSON.stringify(this.toManifest(), null, 2), 'utf8')
    return filePath
  }
}

/** Load pin fields from seed provenance (PRESENT for valid fixture). */
export function pinsFromProvenance(prov) {
  if (!prov?.pin) {
    return {
      canonicalSnapshotId: PIN_MISSING,
      canonicalHash: PIN_MISSING,
      boardRev: PIN_MISSING,
      lifecycleRev: PIN_MISSING,
    }
  }
  return {
    canonicalSnapshotId: String(prov.pin.canonicalSnapshotId ?? PIN_MISSING),
    canonicalHash: String(prov.pin.canonicalHash ?? PIN_MISSING),
    boardRev: String(prov.pin.boardRev ?? PIN_MISSING),
    lifecycleRev: String(prov.pin.lifecycleRev ?? PIN_MISSING),
  }
}
