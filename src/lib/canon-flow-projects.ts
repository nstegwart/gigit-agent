/**
 * Canonical Task Manager flow project identity map.
 *
 * Pure source of truth for the five canon projects + cross mode across:
 * - UI ids (flow modes / data-bundle feature keys)
 * - app-flow file ids (data/app-flow/*.json project_id)
 * - platform keys (product feature platform_json / rebuild parity buckets)
 * - accepted MCP / human aliases
 * - id-ID display labels
 * - project color CSS custom-property token names
 *
 * Strict normalize/serialize: unknowns are rejected (no silent fallback).
 * Alias index is collision-checked at module load — no silent dual ownership.
 *
 * No I/O, no server imports, no consumer wiring.
 */

// ---------------------------------------------------------------------------
// Id unions
// ---------------------------------------------------------------------------

/** UI / flow-mode project ids (data-bundle features keys, FlowMode minus cross). */
export const CANON_UI_PROJECT_IDS = [
  'rn',
  'web-member',
  'panel-sales',
  'affiliate',
  'backend',
] as const
export type CanonUiProjectId = (typeof CANON_UI_PROJECT_IDS)[number]

/** data/app-flow/*.json project_id values. */
export const CANON_APP_FLOW_IDS = [
  'rn',
  'web',
  'sales',
  'affiliate',
  'backend',
] as const
export type CanonAppFlowId = (typeof CANON_APP_FLOW_IDS)[number]

/**
 * Stable platform bucket keys (platform_json / units_by_platform style).
 * Note: panel-sales maps to `admin` (sales panel / admin surface).
 */
export const CANON_PLATFORM_KEYS = [
  'rn',
  'web',
  'admin',
  'affiliate',
  'backend',
] as const
export type CanonPlatformKey = (typeof CANON_PLATFORM_KEYS)[number]

/** Flow modes = cross + five projects. */
export const CANON_FLOW_MODE_IDS = [
  'cross',
  'rn',
  'web-member',
  'panel-sales',
  'affiliate',
  'backend',
] as const
export type CanonFlowModeId = (typeof CANON_FLOW_MODE_IDS)[number]

/** CSS custom-property names (see flow-ultimate.css). */
export const CANON_COLOR_TOKEN_NAMES = [
  '--proj-rn',
  '--proj-web',
  '--proj-sales',
  '--proj-affiliate',
  '--proj-backend',
] as const
export type CanonColorTokenName = (typeof CANON_COLOR_TOKEN_NAMES)[number]

export type CanonSerializeForm =
  | 'ui'
  | 'appFlow'
  | 'platform'
  | 'colorToken'
  | 'labelId'

// ---------------------------------------------------------------------------
// Definitions
// ---------------------------------------------------------------------------

export interface CanonFlowProject {
  readonly uiId: CanonUiProjectId
  readonly appFlowId: CanonAppFlowId
  readonly platformKey: CanonPlatformKey
  /** Owner-facing id-ID label (matches FlowUltimate MODE_LABEL / PROJ_META). */
  readonly labelId: string
  readonly colorToken: CanonColorTokenName
  /**
   * Accepted MCP / human aliases for this project.
   * Matching is via {@link normalizeAliasKey}; listed forms are sources for the index.
   * Do not list an alias that another project already owns.
   */
  readonly mcpAliases: readonly string[]
}

export interface CanonCrossMode {
  readonly modeId: 'cross'
  readonly labelId: string
  readonly mcpAliases: readonly string[]
}

/**
 * Five canon projects — single ordered table (UI order matches FLOW_MODES
 * project pills after cross).
 */
export const CANON_FLOW_PROJECTS: readonly CanonFlowProject[] = [
  {
    uiId: 'rn',
    appFlowId: 'rn',
    platformKey: 'rn',
    labelId: 'React Native',
    colorToken: '--proj-rn',
    mcpAliases: ['rn', 'react native', 'mobile', 'react-native'],
  },
  {
    uiId: 'web-member',
    appFlowId: 'web',
    platformKey: 'web',
    labelId: 'Web Member',
    colorToken: '--proj-web',
    mcpAliases: ['web', 'web-member', 'web member', 'mfs-web', 'mfs web'],
  },
  {
    uiId: 'panel-sales',
    appFlowId: 'sales',
    platformKey: 'admin',
    labelId: 'Panel Sales',
    colorToken: '--proj-sales',
    mcpAliases: ['sales', 'panel-sales', 'panel sales', 'admin'],
  },
  {
    uiId: 'affiliate',
    appFlowId: 'affiliate',
    platformKey: 'affiliate',
    labelId: 'Afiliasi',
    colorToken: '--proj-affiliate',
    mcpAliases: ['affiliate', 'aff', 'afiliasi'],
  },
  {
    uiId: 'backend',
    appFlowId: 'backend',
    platformKey: 'backend',
    labelId: 'Backend',
    colorToken: '--proj-backend',
    mcpAliases: ['backend', 'be', 'api'],
  },
] as const

/** Cross / lintas mode (not a project; no app-flow file or platform key). */
export const CANON_CROSS_MODE: CanonCrossMode = {
  modeId: 'cross',
  labelId: 'Lintas Proyek',
  mcpAliases: [
    'cross',
    'lintas',
    'lintas-sistem',
    'cross-system',
    'lintas sistem',
    'cross system',
    'lintas proyek',
    'cross project',
    'cross-project',
  ],
} as const

// ---------------------------------------------------------------------------
// Errors / results
// ---------------------------------------------------------------------------

export type CanonProjectMapErrorCode =
  | 'EMPTY'
  | 'UNKNOWN'
  | 'INVALID_TYPE'
  | 'ALIAS_COLLISION'
  | 'NOT_A_PROJECT'

export class CanonProjectMapError extends Error {
  readonly code: CanonProjectMapErrorCode
  readonly input: unknown

  constructor(code: CanonProjectMapErrorCode, message: string, input?: unknown) {
    super(message)
    this.name = 'CanonProjectMapError'
    this.code = code
    this.input = input
  }
}

export type CanonNormalizeOk<T> = { ok: true; id: T }
export type CanonNormalizeErr = {
  ok: false
  code: Exclude<CanonProjectMapErrorCode, 'ALIAS_COLLISION'>
  message: string
  input: unknown
}
export type CanonNormalizeResult<T> = CanonNormalizeOk<T> | CanonNormalizeErr

// ---------------------------------------------------------------------------
// Key normalization (matching, not identity)
// ---------------------------------------------------------------------------

/**
 * Collapse a free-form alias into a comparable key.
 * Hyphens/underscores/slashes/dots → spaces; lowercased; diacritics stripped.
 * Exact key equality only — no substring / fuzzy match (avoids silent collisions).
 */
export function normalizeAliasKey(raw: string): string {
  return raw
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[_/.\-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

// ---------------------------------------------------------------------------
// Alias index (built once; collision-fail at load)
// ---------------------------------------------------------------------------

type AliasTarget =
  | { kind: 'project'; id: CanonUiProjectId }
  | { kind: 'mode'; id: 'cross' }

function registerAlias(
  map: Map<string, AliasTarget>,
  rawAlias: string,
  target: AliasTarget,
  ownerLabel: string,
): void {
  const key = normalizeAliasKey(rawAlias)
  if (!key) {
    throw new CanonProjectMapError(
      'ALIAS_COLLISION',
      `Empty alias after normalize for ${ownerLabel}`,
      rawAlias,
    )
  }
  const existing = map.get(key)
  if (existing) {
    const existingLabel =
      existing.kind === 'project' ? existing.id : existing.id
    if (
      existing.kind !== target.kind ||
      (existing.kind === 'project' &&
        target.kind === 'project' &&
        existing.id !== target.id) ||
      (existing.kind === 'mode' && target.kind === 'mode' && existing.id !== target.id) ||
      existing.kind !== target.kind
    ) {
      // Same target is fine (duplicate listing); different target is fatal.
      const sameProject =
        existing.kind === 'project' &&
        target.kind === 'project' &&
        existing.id === target.id
      const sameMode =
        existing.kind === 'mode' &&
        target.kind === 'mode' &&
        existing.id === target.id
      if (sameProject || sameMode) return
      throw new CanonProjectMapError(
        'ALIAS_COLLISION',
        `Alias "${key}" claimed by both ${existingLabel} and ${ownerLabel}`,
        rawAlias,
      )
    }
  }
  map.set(key, target)
}

function buildAliasIndex(): Map<string, AliasTarget> {
  const map = new Map<string, AliasTarget>()

  for (const p of CANON_FLOW_PROJECTS) {
    const owner = p.uiId
    const target: AliasTarget = { kind: 'project', id: p.uiId }
    // Identity forms always accepted (round-trip).
    registerAlias(map, p.uiId, target, owner)
    registerAlias(map, p.appFlowId, target, owner)
    registerAlias(map, p.platformKey, target, owner)
    registerAlias(map, p.colorToken, target, owner)
    registerAlias(map, p.labelId, target, owner)
    for (const a of p.mcpAliases) {
      registerAlias(map, a, target, owner)
    }
  }

  const crossTarget: AliasTarget = { kind: 'mode', id: 'cross' }
  registerAlias(map, CANON_CROSS_MODE.modeId, crossTarget, 'cross')
  registerAlias(map, CANON_CROSS_MODE.labelId, crossTarget, 'cross')
  for (const a of CANON_CROSS_MODE.mcpAliases) {
    registerAlias(map, a, crossTarget, 'cross')
  }

  return map
}

/** Canonical alias → target index. Built and collision-checked at module load. */
const ALIAS_INDEX: Map<string, AliasTarget> = buildAliasIndex()

/**
 * Re-run collision detection (for tests / integrity probes).
 * Throws {@link CanonProjectMapError} with code ALIAS_COLLISION on conflict.
 */
export function assertNoAliasCollisions(): void {
  // Rebuild from definitions; throws if any dual claim.
  buildAliasIndex()
}

/** Snapshot of every registered normalized alias key (tests / diagnostics). */
export function listRegisteredAliasKeys(): readonly string[] {
  return [...ALIAS_INDEX.keys()].sort()
}

// ---------------------------------------------------------------------------
// Lookup tables
// ---------------------------------------------------------------------------

const PROJECT_BY_UI: ReadonlyMap<CanonUiProjectId, CanonFlowProject> = new Map(
  CANON_FLOW_PROJECTS.map((p) => [p.uiId, p]),
)

const PROJECT_BY_APP_FLOW: ReadonlyMap<CanonAppFlowId, CanonFlowProject> =
  new Map(CANON_FLOW_PROJECTS.map((p) => [p.appFlowId, p]))

const PROJECT_BY_PLATFORM: ReadonlyMap<CanonPlatformKey, CanonFlowProject> =
  new Map(CANON_FLOW_PROJECTS.map((p) => [p.platformKey, p]))

// ---------------------------------------------------------------------------
// Type guards
// ---------------------------------------------------------------------------

export function isCanonUiProjectId(value: unknown): value is CanonUiProjectId {
  return (
    typeof value === 'string' &&
    (CANON_UI_PROJECT_IDS as readonly string[]).includes(value)
  )
}

export function isCanonAppFlowId(value: unknown): value is CanonAppFlowId {
  return (
    typeof value === 'string' &&
    (CANON_APP_FLOW_IDS as readonly string[]).includes(value)
  )
}

export function isCanonPlatformKey(value: unknown): value is CanonPlatformKey {
  return (
    typeof value === 'string' &&
    (CANON_PLATFORM_KEYS as readonly string[]).includes(value)
  )
}

export function isCanonFlowModeId(value: unknown): value is CanonFlowModeId {
  return (
    typeof value === 'string' &&
    (CANON_FLOW_MODE_IDS as readonly string[]).includes(value)
  )
}

export function isCanonColorTokenName(
  value: unknown,
): value is CanonColorTokenName {
  return (
    typeof value === 'string' &&
    (CANON_COLOR_TOKEN_NAMES as readonly string[]).includes(value)
  )
}

// ---------------------------------------------------------------------------
// Normalize (strict)
// ---------------------------------------------------------------------------

function fail(
  code: CanonNormalizeErr['code'],
  message: string,
  input: unknown,
): CanonNormalizeErr {
  return { ok: false, code, message, input }
}

/**
 * Normalize any accepted alias / id form to a canon UI project id.
 * Rejects cross mode, empty, non-string, and unknown aliases.
 */
export function normalizeCanonProjectId(
  input: unknown,
): CanonNormalizeResult<CanonUiProjectId> {
  if (input == null) {
    return fail('INVALID_TYPE', 'project id is null or undefined', input)
  }
  if (typeof input !== 'string') {
    return fail('INVALID_TYPE', 'project id must be a string', input)
  }
  const key = normalizeAliasKey(input)
  if (!key) {
    return fail('EMPTY', 'project id is empty', input)
  }
  const hit = ALIAS_INDEX.get(key)
  if (!hit) {
    return fail('UNKNOWN', `unknown project id or alias: ${input}`, input)
  }
  if (hit.kind === 'mode') {
    return fail(
      'NOT_A_PROJECT',
      `value resolves to flow mode "${hit.id}", not a project`,
      input,
    )
  }
  return { ok: true, id: hit.id }
}

/**
 * Normalize any accepted alias / id form to a flow mode id (cross or project).
 */
export function normalizeCanonFlowMode(
  input: unknown,
): CanonNormalizeResult<CanonFlowModeId> {
  if (input == null) {
    return fail('INVALID_TYPE', 'flow mode is null or undefined', input)
  }
  if (typeof input !== 'string') {
    return fail('INVALID_TYPE', 'flow mode must be a string', input)
  }
  const key = normalizeAliasKey(input)
  if (!key) {
    return fail('EMPTY', 'flow mode is empty', input)
  }
  const hit = ALIAS_INDEX.get(key)
  if (!hit) {
    return fail('UNKNOWN', `unknown flow mode id or alias: ${input}`, input)
  }
  return { ok: true, id: hit.kind === 'mode' ? hit.id : hit.id }
}

/** Throw on failure; return canon UI project id. */
export function requireCanonProjectId(input: unknown): CanonUiProjectId {
  const r = normalizeCanonProjectId(input)
  if (!r.ok) {
    throw new CanonProjectMapError(r.code, r.message, r.input)
  }
  return r.id
}

/** Throw on failure; return flow mode id. */
export function requireCanonFlowMode(input: unknown): CanonFlowModeId {
  const r = normalizeCanonFlowMode(input)
  if (!r.ok) {
    throw new CanonProjectMapError(r.code, r.message, r.input)
  }
  return r.id
}

// ---------------------------------------------------------------------------
// Serialize (strict; typed inputs only)
// ---------------------------------------------------------------------------

export function getCanonFlowProject(id: CanonUiProjectId): CanonFlowProject {
  const p = PROJECT_BY_UI.get(id)
  if (!p) {
    // Unreachable for typed callers; keep fail-closed for forged casts.
    throw new CanonProjectMapError(
      'UNKNOWN',
      `unknown canon UI project id: ${String(id)}`,
      id,
    )
  }
  return p
}

export function toUiId(id: CanonUiProjectId): CanonUiProjectId {
  // Validates membership for untyped cast sites.
  if (!isCanonUiProjectId(id)) {
    throw new CanonProjectMapError(
      'UNKNOWN',
      `cannot serialize unknown UI project id: ${String(id)}`,
      id,
    )
  }
  return id
}

export function toAppFlowId(id: CanonUiProjectId): CanonAppFlowId {
  return getCanonFlowProject(id).appFlowId
}

export function toPlatformKey(id: CanonUiProjectId): CanonPlatformKey {
  return getCanonFlowProject(id).platformKey
}

export function toColorToken(id: CanonUiProjectId): CanonColorTokenName {
  return getCanonFlowProject(id).colorToken
}

/** CSS `var(--proj-*)` form derived from the token name. */
export function toColorCssVar(id: CanonUiProjectId): string {
  return `var(${toColorToken(id)})`
}

export function toLabelId(id: CanonFlowModeId): string {
  if (id === 'cross') return CANON_CROSS_MODE.labelId
  return getCanonFlowProject(id).labelId
}

/**
 * Serialize a canon UI project id into one of the identity forms.
 * Throws on unknown form or unknown id.
 */
export function serializeCanonProject(
  id: CanonUiProjectId,
  form: CanonSerializeForm,
): string {
  if (!isCanonUiProjectId(id)) {
    throw new CanonProjectMapError(
      'UNKNOWN',
      `cannot serialize unknown UI project id: ${String(id)}`,
      id,
    )
  }
  switch (form) {
    case 'ui':
      return toUiId(id)
    case 'appFlow':
      return toAppFlowId(id)
    case 'platform':
      return toPlatformKey(id)
    case 'colorToken':
      return toColorToken(id)
    case 'labelId':
      return toLabelId(id)
    default: {
      const _exhaustive: never = form
      throw new CanonProjectMapError(
        'UNKNOWN',
        `unknown serialize form: ${String(_exhaustive)}`,
        form,
      )
    }
  }
}

/**
 * Serialize a flow mode. Project modes support all forms; cross only `ui` and
 * `labelId` (throws NOT_A_PROJECT for appFlow/platform/colorToken).
 */
export function serializeCanonFlowMode(
  id: CanonFlowModeId,
  form: CanonSerializeForm,
): string {
  if (!isCanonFlowModeId(id)) {
    throw new CanonProjectMapError(
      'UNKNOWN',
      `cannot serialize unknown flow mode: ${String(id)}`,
      id,
    )
  }
  if (id === 'cross') {
    if (form === 'ui') return 'cross'
    if (form === 'labelId') return CANON_CROSS_MODE.labelId
    throw new CanonProjectMapError(
      'NOT_A_PROJECT',
      `cross mode has no serialize form "${form}"`,
      form,
    )
  }
  return serializeCanonProject(id, form)
}

// ---------------------------------------------------------------------------
// Convenience reverse maps (typed exact ids only — no alias)
// ---------------------------------------------------------------------------

export function uiIdFromAppFlowId(appFlowId: CanonAppFlowId): CanonUiProjectId {
  const p = PROJECT_BY_APP_FLOW.get(appFlowId)
  if (!p) {
    throw new CanonProjectMapError(
      'UNKNOWN',
      `unknown app-flow id: ${String(appFlowId)}`,
      appFlowId,
    )
  }
  return p.uiId
}

export function uiIdFromPlatformKey(
  platformKey: CanonPlatformKey,
): CanonUiProjectId {
  const p = PROJECT_BY_PLATFORM.get(platformKey)
  if (!p) {
    throw new CanonProjectMapError(
      'UNKNOWN',
      `unknown platform key: ${String(platformKey)}`,
      platformKey,
    )
  }
  return p.uiId
}

/** MCP aliases listed on the definition (not the full expanded index). */
export function listMcpAliases(
  id: CanonUiProjectId | 'cross',
): readonly string[] {
  if (id === 'cross') return CANON_CROSS_MODE.mcpAliases
  return getCanonFlowProject(id).mcpAliases
}
