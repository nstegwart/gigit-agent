/**
 * Additive V3 principal / role / scope model (AC-AUTH-01..05).
 * Does NOT replace legacy Role 'admin'|'member' in shared types —
 * maps session roles → V3 principals at the auth boundary.
 *
 * Fail-closed: missing principal / missing scope → AUTHORIZATION_REQUIRED.
 * Missing adequate bearer config → DECISION_AUTH_MECHANISM_REQUIRED.
 * Cookie session identity NEVER authenticates MCP bearer actions.
 */

import { timingSafeEqual } from 'node:crypto'

import type { SessionUser } from '#/lib/types'

// ---- V3 roles (additive; never rewrite legacy Role) ----

export type V3Role =
  | 'OWNER'
  | 'ROOT_ORCHESTRATOR'
  | 'AGENT'
  | 'INTEGRATOR'
  | 'PUBLIC'

export type ReadScope =
  | 'board:read'
  | 'task:read'
  | 'run:read'
  | 'account:read'
  | 'decision:read'
  | 'evidence:read'
  | 'audit:read'

export type WriteScope =
  | 'dispatch:write'
  | 'lifecycle:write'
  | 'run:write'
  | 'decision:write'
  | 'import:write'
  | 'reconcile:write'
  | 'account:sync'
  | 'integration:write'
  | 'policy:write'

export type Scope = ReadScope | WriteScope

export const ALL_READ_SCOPES: ReadonlyArray<ReadScope> = [
  'board:read',
  'task:read',
  'run:read',
  'account:read',
  'decision:read',
  'evidence:read',
  'audit:read',
] as const

export const ALL_WRITE_SCOPES: ReadonlyArray<WriteScope> = [
  'dispatch:write',
  'lifecycle:write',
  'run:write',
  'decision:write',
  'import:write',
  'reconcile:write',
  'account:sync',
  'integration:write',
  'policy:write',
] as const

export type AuthErrorCode =
  | 'AUTHORIZATION_REQUIRED'
  | 'DECISION_AUTH_MECHANISM_REQUIRED'
  | 'FORBIDDEN_SCOPE'
  | 'FORBIDDEN_ROLE'
  | 'COOKIE_ELEVATION_DENIED'
  | 'OWN_RUN_ONLY'
  | 'OWNER_EVIDENCE_IMPERSONATION_DENIED'
  | 'ROOT_PRODUCTION_APPROVAL_DENIED'
  | 'INTEGRATOR_PATH_BOUNDED'
  | 'PUBLIC_ONLY'

export class RbacError extends Error {
  readonly code: AuthErrorCode
  readonly status: number
  readonly details: Readonly<Record<string, unknown>>
  constructor(
    code: AuthErrorCode,
    message: string,
    status = 403,
    details: Record<string, unknown> = {},
  ) {
    super(message)
    this.name = 'RbacError'
    this.code = code
    this.status = status
    this.details = details
  }
}

export type PrincipalChannel = 'session' | 'bearer' | 'public' | 'none'

export interface Principal {
  actorId: string
  role: V3Role
  scopes: ReadonlyArray<Scope>
  /** Legacy session role when channel=session. */
  legacyRole?: 'admin' | 'member' | null
  channel: PrincipalChannel
  /** Board allowlist for member-class principals; empty = all (OWNER/admin). */
  boards: ReadonlyArray<string>
  /** AGENT binding — own assigned runs only. */
  agentId?: string | null
  /** Optional bound board for agent/integrator tokens. */
  boardId?: string | null
  /** INTEGRATOR pathspec allowlist. */
  pathspecs?: ReadonlyArray<string>
  /** INTEGRATOR/agent checkpoint bound. */
  checkpointId?: string | null
  /** Display name (never a credential). */
  label?: string | null
}

export type AuthMechanismState =
  | { kind: 'OK' }
  | { kind: 'DECISION_AUTH_MECHANISM_REQUIRED'; reason: string }

/** Default scope matrix from V3 THREAT_MODEL / API_CONTRACT. */
export function defaultScopesForRole(role: V3Role): Scope[] {
  switch (role) {
    case 'OWNER':
      // Sensitive read + decision resolve + policy + board admin mutations.
      // NOT dispatch:write (ROOT), NOT run:write as agent evidence, NOT account:sync raw, NOT integration:write.
      return [
        ...ALL_READ_SCOPES,
        'decision:write',
        'policy:write',
        'lifecycle:write',
        'import:write',
        // Board admin mutations historically owned by admin UI — map via lifecycle/import + decision.
      ]
    case 'ROOT_ORCHESTRATOR':
      return [
        'board:read',
        'task:read',
        'run:read',
        'account:read',
        'decision:read',
        'audit:read',
        'dispatch:write',
        'lifecycle:write',
        'reconcile:write',
        'account:sync',
        'import:write',
      ]
    case 'AGENT':
      return [
        'board:read',
        'task:read',
        'run:read',
        'decision:read',
        'run:write',
        'decision:write', // request only — resolve gated by role checks
      ]
    case 'INTEGRATOR':
      return ['board:read', 'task:read', 'integration:write']
    case 'PUBLIC':
      return []
    default: {
      const _exhaustive: never = role
      void _exhaustive
      // Runtime fail-closed if a non-V3 role string is forced in.
      throw new RbacError('FORBIDDEN_ROLE', `unknown V3 role: ${String(role)}`, 403)
    }
  }
}

/**
 * Immutable role maxima = defaultScopesForRole.
 * Configured bearer custom scopes are INTERSECTED with maxima — never elevated.
 * Omitted / empty configured list → full role maxima (not "no scopes").
 */
export function intersectScopesWithRoleMaxima(
  role: V3Role,
  configured: ReadonlyArray<Scope> | null | undefined,
): Scope[] {
  const maxima = defaultScopesForRole(role)
  if (!configured || configured.length === 0) return maxima
  const maxSet = new Set<Scope>(maxima)
  // Preserve maxima order; drop any hostile extras (e.g. AGENT + dispatch:write).
  return maxima.filter((s) => configured.includes(s) && maxSet.has(s))
}

/** AGENT / INTEGRATOR require an explicit board binding. OWNER/ROOT may be unbound. */
export function requiresBoardBinding(role: V3Role): boolean {
  return role === 'AGENT' || role === 'INTEGRATOR'
}

export function hasBoardBinding(
  boardId: string | null | undefined,
  boards?: ReadonlyArray<string> | null,
): boolean {
  if (boardId && String(boardId).trim()) return true
  if (boards && boards.some((b) => !!b && String(b).trim())) return true
  return false
}

/**
 * Map legacy session user → V3 principal.
 * admin → OWNER only (never silently ROOT/AGENT/INTEGRATOR).
 * member → board:read allowlist only.
 */
export function principalFromSession(user: SessionUser | null | undefined): Principal | null {
  if (!user) return null
  if (user.role === 'admin') {
    return {
      actorId: user.id,
      role: 'OWNER',
      scopes: defaultScopesForRole('OWNER'),
      legacyRole: 'admin',
      channel: 'session',
      boards: [],
      label: user.username,
    }
  }
  // member — proven board-read allowlist only
  return {
    actorId: user.id,
    role: 'PUBLIC', // not true PUBLIC surface; constrained member reader
    scopes: ['board:read', 'task:read'],
    legacyRole: 'member',
    channel: 'session',
    boards: [...user.boards],
    label: user.username,
  }
}

/** Explicit public principal (unauthenticated allowlist surface). */
export function publicPrincipal(): Principal {
  return {
    actorId: 'public',
    role: 'PUBLIC',
    scopes: [],
    channel: 'public',
    boards: [],
  }
}

export function hasScope(principal: Principal | null | undefined, scope: Scope): boolean {
  if (!principal) return false
  return principal.scopes.includes(scope)
}

export function requireScope(principal: Principal | null | undefined, scope: Scope): Principal {
  if (!principal) {
    throw new RbacError('AUTHORIZATION_REQUIRED', 'authentication required', 401)
  }
  if (!hasScope(principal, scope)) {
    throw new RbacError('FORBIDDEN_SCOPE', `missing scope ${scope}`, 403, {
      role: principal.role,
      scope,
    })
  }
  return principal
}

export function requireRole(
  principal: Principal | null | undefined,
  roles: ReadonlyArray<V3Role>,
): Principal {
  if (!principal) {
    throw new RbacError('AUTHORIZATION_REQUIRED', 'authentication required', 401)
  }
  if (!roles.includes(principal.role)) {
    throw new RbacError('FORBIDDEN_ROLE', `role ${principal.role} not in ${roles.join(',')}`, 403, {
      role: principal.role,
      allowed: roles,
    })
  }
  return principal
}

/**
 * Board visibility (fail-closed):
 * - OWNER: all boards
 * - ROOT_ORCHESTRATOR: unbound → all; optional boardId/boards restrict
 * - AGENT / INTEGRATOR: MUST be board-bound; unbound → deny every board
 * - member session: boards[] allowlist only
 * - true PUBLIC: none
 */
export function canAccessBoard(principal: Principal | null | undefined, boardId: string): boolean {
  if (!principal) return false
  if (principal.role === 'OWNER') return true
  if (principal.role === 'PUBLIC' && principal.legacyRole !== 'member') return false

  // AGENT / INTEGRATOR: fail closed when unbound; never "any board".
  if (principal.role === 'AGENT' || principal.role === 'INTEGRATOR') {
    if (principal.boardId) return principal.boardId === boardId
    if (principal.boards.length > 0) return principal.boards.includes(boardId)
    return false
  }

  // ROOT: optional binding; unbound may access any board (dispatch authority).
  if (principal.role === 'ROOT_ORCHESTRATOR') {
    if (principal.boardId) return principal.boardId === boardId
    if (principal.boards.length > 0) return principal.boards.includes(boardId)
    return true
  }

  if (principal.boards.length === 0 && principal.legacyRole === 'admin') return true
  if (principal.boards.includes(boardId)) return true
  if (principal.boardId && principal.boardId === boardId) return true
  return false
}

export function requireBoardAccess(principal: Principal | null | undefined, boardId: string): Principal {
  const p = requireScope(
    principal,
    principal?.scopes.includes('task:read') && !principal.scopes.includes('board:read')
      ? 'task:read'
      : 'board:read',
  )
  // members need board:read which they have; still check allowlist
  if (!canAccessBoard(p, boardId)) {
    throw new RbacError('FORBIDDEN_SCOPE', 'no access to this board', 403, { boardId })
  }
  return p
}

/** OWNER cannot impersonate agent evidence. */
export function assertNotOwnerEvidenceImpersonation(
  principal: Principal,
  opts: { asAgentEvidence?: boolean },
): void {
  if (principal.role === 'OWNER' && opts.asAgentEvidence) {
    throw new RbacError(
      'OWNER_EVIDENCE_IMPERSONATION_DENIED',
      'OWNER cannot impersonate agent evidence',
      403,
    )
  }
}

/** ROOT cannot grant owner production approval. */
export function assertNotRootProductionApproval(
  principal: Principal,
  opts: { productionApprovalId?: string | null; grantOwnerProductionApproval?: boolean },
): void {
  if (
    principal.role === 'ROOT_ORCHESTRATOR' &&
    (opts.grantOwnerProductionApproval || (opts.productionApprovalId != null && opts.productionApprovalId !== ''))
  ) {
    throw new RbacError(
      'ROOT_PRODUCTION_APPROVAL_DENIED',
      'ROOT_ORCHESTRATOR cannot grant owner production approval',
      403,
    )
  }
}

/** AGENT may only mutate own assigned run. */
export function assertAgentOwnRun(
  principal: Principal,
  runAgentId: string | null | undefined,
): void {
  if (principal.role !== 'AGENT') return
  if (!principal.agentId || !runAgentId || principal.agentId !== runAgentId) {
    throw new RbacError('OWN_RUN_ONLY', 'AGENT may only act on own assigned run', 403, {
      agentId: principal.agentId ?? null,
      runAgentId: runAgentId ?? null,
    })
  }
}

/** INTEGRATOR pathspec/checkpoint bounded. */
export function assertIntegratorBounds(
  principal: Principal,
  opts: { pathspec?: string | null; checkpointId?: string | null },
): void {
  if (principal.role !== 'INTEGRATOR') return
  if (opts.checkpointId && principal.checkpointId && opts.checkpointId !== principal.checkpointId) {
    throw new RbacError('INTEGRATOR_PATH_BOUNDED', 'checkpoint outside integrator binding', 403)
  }
  if (opts.pathspec && principal.pathspecs && principal.pathspecs.length > 0) {
    const ok = principal.pathspecs.some(
      (p) => opts.pathspec === p || opts.pathspec!.startsWith(p.replace(/\*\*$/, '')),
    )
    if (!ok) {
      throw new RbacError('INTEGRATOR_PATH_BOUNDED', 'pathspec outside integrator binding', 403, {
        pathspec: opts.pathspec,
      })
    }
  }
}

// ---- MCP tool catalog scopes ----

export type ToolKind = 'public' | 'read' | 'write'

export interface ToolAuthSpec {
  name: string
  kind: ToolKind
  /** Any-of scopes required to list/call (empty = public). */
  scopes: ReadonlyArray<Scope>
  /** Extra role constraints (any-of). Empty = any role with scope. */
  roles?: ReadonlyArray<V3Role>
  /** Decision resolve is OWNER-only even with decision:write. */
  decisionResolve?: boolean
  /** Decision request is AGENT/OWNER. */
  decisionRequest?: boolean
  /** Agent own-run enforcement. */
  ownRun?: boolean
  /** Alias of another tool (same auth). */
  aliasOf?: string
}

/**
 * API_CONTRACT §2 authenticated read method names that MUST appear in MCP_TOOL_SPECS.
 * Exact set — used by catalog integrity tests / human-safe list filters.
 */
export const CANONICAL_MCP_READ_TOOL_NAMES = [
  'get_overview',
  'list_work_items',
  'list_projects',
  'get_project',
  'list_features',
  'get_feature',
  'list_tasks',
  'get_task',
  'list_runs',
  'get_run',
  'list_accounts',
  'get_account',
  'list_decisions',
  'get_decision',
  'list_activity',
  'list_audit',
  'get_priority_portfolio',
  'get_g5',
  'get_prod',
  'get_guide',
] as const

export type CanonicalMcpReadToolName = (typeof CANONICAL_MCP_READ_TOOL_NAMES)[number]

/**
 * Canonical + legacy compatibility tool names → auth.
 * Unauthenticated tools/list may only expose public tools.
 * Human-safe catalog: every entry is a named operator/agent method (no internal dumps).
 */
export const MCP_TOOL_SPECS: ReadonlyArray<ToolAuthSpec> = [
  // Public
  { name: 'get_public_snapshot', kind: 'public', scopes: [] },

  // ---- API_CONTRACT §2 canonical authenticated reads (least-privilege scopes) ----
  { name: 'get_overview', kind: 'read', scopes: ['board:read'] },
  { name: 'list_work_items', kind: 'read', scopes: ['board:read', 'task:read'] },
  { name: 'list_projects', kind: 'read', scopes: ['board:read'] },
  { name: 'get_project', kind: 'read', scopes: ['board:read'] },
  { name: 'list_features', kind: 'read', scopes: ['board:read'] },
  { name: 'get_feature', kind: 'read', scopes: ['board:read'] },
  { name: 'list_tasks', kind: 'read', scopes: ['task:read', 'board:read'] },
  { name: 'get_task', kind: 'read', scopes: ['task:read', 'board:read'] },
  { name: 'list_runs', kind: 'read', scopes: ['run:read'] },
  { name: 'get_run', kind: 'read', scopes: ['run:read'] },
  { name: 'list_accounts', kind: 'read', scopes: ['account:read'] },
  { name: 'get_account', kind: 'read', scopes: ['account:read'] },
  { name: 'list_decisions', kind: 'read', scopes: ['decision:read'] },
  { name: 'get_decision', kind: 'read', scopes: ['decision:read'] },
  { name: 'list_activity', kind: 'read', scopes: ['audit:read', 'board:read'] },
  { name: 'list_audit', kind: 'read', scopes: ['audit:read'] },
  { name: 'get_priority_portfolio', kind: 'read', scopes: ['board:read'] },
  { name: 'get_g5', kind: 'read', scopes: ['board:read'] },
  { name: 'get_prod', kind: 'read', scopes: ['board:read'] },
  { name: 'get_guide', kind: 'read', scopes: ['board:read'] },

  // ---- Compatibility / legacy reads (aliases preserve auth of target) ----
  { name: 'get_work', kind: 'read', scopes: ['board:read', 'task:read'], aliasOf: 'list_work_items' },
  { name: 'get_priority', kind: 'read', scopes: ['board:read'], aliasOf: 'get_priority_portfolio' },
  { name: 'get_rollup', kind: 'read', scopes: ['board:read'], aliasOf: 'get_overview' },
  { name: 'get_lifecycle', kind: 'read', scopes: ['board:read'], aliasOf: 'get_overview' },
  { name: 'get_board_hash', kind: 'read', scopes: ['board:read'], aliasOf: 'get_overview' },
  { name: 'get_task_lifecycle', kind: 'read', scopes: ['task:read', 'board:read'] },
  { name: 'list_boards', kind: 'read', scopes: ['board:read'] },
  { name: 'list_queue', kind: 'read', scopes: ['board:read'] },
  { name: 'get_conventions', kind: 'read', scopes: ['board:read'] },
  { name: 'get_workspace', kind: 'read', scopes: ['board:read'] },
  { name: 'get_design', kind: 'read', scopes: ['board:read'] },
  // NEXT projection is sole plan source — any authenticated board reader may observe it.
  { name: 'get_next', kind: 'read', scopes: ['board:read'] },
  { name: 'get_dispatch_next', kind: 'read', scopes: ['board:read'], aliasOf: 'get_next' },

  // Legacy writes
  { name: 'create_board', kind: 'write', scopes: ['import:write', 'lifecycle:write'], roles: ['OWNER', 'ROOT_ORCHESTRATOR'] },
  { name: 'toggle_task', kind: 'write', scopes: ['lifecycle:write'], roles: ['OWNER', 'ROOT_ORCHESTRATOR'] },
  { name: 'set_feature_phase', kind: 'write', scopes: ['lifecycle:write'], roles: ['OWNER', 'ROOT_ORCHESTRATOR'] },
  // Run evidence mutation — AGENT own-run or ROOT lifecycle only; OWNER denied (evidence impersonation).
  { name: 'upsert_run', kind: 'write', scopes: ['run:write', 'lifecycle:write'], roles: ['AGENT', 'ROOT_ORCHESTRATOR'], ownRun: true },
  { name: 'set_run_status', kind: 'write', scopes: ['run:write', 'lifecycle:write'], roles: ['AGENT', 'ROOT_ORCHESTRATOR'], ownRun: true },
  { name: 'add_comment', kind: 'write', scopes: ['board:read'], roles: ['OWNER', 'AGENT', 'ROOT_ORCHESTRATOR'] },
  { name: 'open_decision', kind: 'write', scopes: ['decision:write'], decisionRequest: true },
  { name: 'set_blocked', kind: 'write', scopes: ['lifecycle:write'], roles: ['OWNER', 'ROOT_ORCHESTRATOR', 'AGENT'] },
  { name: 'set_project_design', kind: 'write', scopes: ['import:write', 'lifecycle:write'], roles: ['OWNER', 'ROOT_ORCHESTRATOR'] },
  { name: 'add_component', kind: 'write', scopes: ['import:write'], roles: ['OWNER', 'ROOT_ORCHESTRATOR'] },
  { name: 'upsert_task', kind: 'write', scopes: ['import:write', 'lifecycle:write'], roles: ['OWNER', 'ROOT_ORCHESTRATOR'] },
  { name: 'delete_task', kind: 'write', scopes: ['import:write'], roles: ['OWNER', 'ROOT_ORCHESTRATOR'] },
  { name: 'upsert_feature', kind: 'write', scopes: ['import:write'], roles: ['OWNER', 'ROOT_ORCHESTRATOR'] },
  { name: 'delete_feature', kind: 'write', scopes: ['import:write'], roles: ['OWNER', 'ROOT_ORCHESTRATOR'] },
  { name: 'set_prod', kind: 'write', scopes: ['policy:write', 'lifecycle:write'], roles: ['OWNER'] },
  { name: 'set_guide', kind: 'write', scopes: ['import:write'], roles: ['OWNER', 'ROOT_ORCHESTRATOR'] },
  { name: 'replace_accounts', kind: 'write', scopes: ['account:sync'], roles: ['ROOT_ORCHESTRATOR'] },
  { name: 'replace_board_snapshot', kind: 'write', scopes: ['import:write'], roles: ['OWNER', 'ROOT_ORCHESTRATOR'] },
  { name: 'set_lifecycle', kind: 'write', scopes: ['lifecycle:write'], roles: ['OWNER', 'ROOT_ORCHESTRATOR'] },
  { name: 'advance_task', kind: 'write', scopes: ['lifecycle:write'], roles: ['OWNER', 'ROOT_ORCHESTRATOR', 'AGENT'] },
  { name: 'add_task_section', kind: 'write', scopes: ['import:write', 'lifecycle:write'], roles: ['OWNER', 'ROOT_ORCHESTRATOR', 'AGENT'] },
  { name: 'set_task_sections', kind: 'write', scopes: ['import:write'], roles: ['OWNER', 'ROOT_ORCHESTRATOR'] },
  { name: 'update_task_section', kind: 'write', scopes: ['import:write'], roles: ['OWNER', 'ROOT_ORCHESTRATOR', 'AGENT'] },
  { name: 'remove_task_section', kind: 'write', scopes: ['import:write'], roles: ['OWNER', 'ROOT_ORCHESTRATOR'] },
  { name: 'init_lifecycle', kind: 'write', scopes: ['lifecycle:write'], roles: ['OWNER', 'ROOT_ORCHESTRATOR'] },
  { name: 'upsert_project', kind: 'write', scopes: ['import:write'], roles: ['OWNER', 'ROOT_ORCHESTRATOR'] },
  { name: 'delete_project', kind: 'write', scopes: ['import:write'], roles: ['OWNER', 'ROOT_ORCHESTRATOR'] },
  { name: 'update_board', kind: 'write', scopes: ['import:write'], roles: ['OWNER', 'ROOT_ORCHESTRATOR'] },
  { name: 'delete_board', kind: 'write', scopes: ['import:write'], roles: ['OWNER'] },
  { name: 'decide_decision', kind: 'write', scopes: ['decision:write'], roles: ['OWNER'], decisionResolve: true },
  { name: 'set_queue', kind: 'write', scopes: ['dispatch:write', 'lifecycle:write'], roles: ['OWNER', 'ROOT_ORCHESTRATOR'] },

  // V3 control-plane writes
  { name: 'publish_dispatch_plan', kind: 'write', scopes: ['dispatch:write'], roles: ['ROOT_ORCHESTRATOR'] },
  { name: 'register_run', kind: 'write', scopes: ['run:write'], roles: ['AGENT', 'ROOT_ORCHESTRATOR'], ownRun: true },
  { name: 'heartbeat_run', kind: 'write', scopes: ['run:write'], roles: ['AGENT', 'ROOT_ORCHESTRATOR'], ownRun: true },
  { name: 'sync_accounts', kind: 'write', scopes: ['account:sync'], roles: ['ROOT_ORCHESTRATOR'] },
  { name: 'reconcile_dry_run', kind: 'write', scopes: ['reconcile:write'], roles: ['ROOT_ORCHESTRATOR'] },
  { name: 'reconcile_apply', kind: 'write', scopes: ['reconcile:write'], roles: ['ROOT_ORCHESTRATOR'] },
  { name: 'open_decision_v3', kind: 'write', scopes: ['decision:write'], decisionRequest: true },
  { name: 'resolve_decision_v3', kind: 'write', scopes: ['decision:write'], roles: ['OWNER'], decisionResolve: true },
  { name: 'integration_lock', kind: 'write', scopes: ['integration:write'], roles: ['INTEGRATOR', 'ROOT_ORCHESTRATOR'] },
]

const TOOL_SPEC_BY_NAME = new Map(MCP_TOOL_SPECS.map((t) => [t.name, t]))

/** Detect duplicate catalog names at module load (fail loud in tests). */
export function assertMcpToolCatalogIntegrity(): void {
  const names = MCP_TOOL_SPECS.map((t) => t.name)
  if (new Set(names).size !== names.length) {
    throw new RbacError('FORBIDDEN_SCOPE', 'MCP_TOOL_SPECS contains duplicate tool names', 500)
  }
  for (const required of CANONICAL_MCP_READ_TOOL_NAMES) {
    if (!TOOL_SPEC_BY_NAME.has(required)) {
      throw new RbacError(
        'FORBIDDEN_SCOPE',
        `MCP_TOOL_SPECS missing canonical read tool: ${required}`,
        500,
      )
    }
  }
  // Aliases must point at a registered target (including get_dispatch_next → get_next).
  for (const spec of MCP_TOOL_SPECS) {
    if (spec.aliasOf && !TOOL_SPEC_BY_NAME.has(spec.aliasOf)) {
      throw new RbacError(
        'FORBIDDEN_SCOPE',
        `MCP_TOOL_SPECS alias ${spec.name} → missing target ${spec.aliasOf}`,
        500,
      )
    }
  }
}

export function getToolSpec(name: string): ToolAuthSpec | undefined {
  return TOOL_SPEC_BY_NAME.get(name)
}

export function isPublicTool(name: string): boolean {
  const s = TOOL_SPEC_BY_NAME.get(name)
  return !!s && s.kind === 'public'
}

/**
 * Tools that enumerate boards globally (no boardId required by contract).
 * Board-bound AGENT/INTEGRATOR must not list or call these — board scope used to
 * be checked only when args.boardId was present, which left list_boards open.
 */
export const UNSCOPED_BOARD_ENUMERATION_TOOLS: ReadonlyArray<string> = ['list_boards'] as const

export function isUnscopedBoardEnumerationTool(name: string): boolean {
  return (UNSCOPED_BOARD_ENUMERATION_TOOLS as ReadonlyArray<string>).includes(name)
}

/**
 * AGENT/INTEGRATOR are board-bound by design (unbound → null at bearer resolve).
 * They must not access unscoped global board enumeration. OWNER/ROOT/member session
 * retain list_boards; public tools stay on the public path.
 */
export function deniesUnscopedBoardEnumeration(principal: Principal): boolean {
  return principal.role === 'AGENT' || principal.role === 'INTEGRATOR'
}

/** tools/list visibility for a principal (null = unauthenticated). */
export function isToolListable(principal: Principal | null, name: string): boolean {
  const spec = TOOL_SPEC_BY_NAME.get(name)
  if (!spec) return false
  if (spec.kind === 'public') return true
  if (!principal) return false
  // True PUBLIC (unauthenticated surface principal) lists only public tools.
  if (principal.role === 'PUBLIC' && principal.legacyRole !== 'member') return false
  // Member session: safe read-only allowlist (board/task read tools only).
  if (principal.legacyRole === 'member') {
    if (spec.kind === 'write') return false
    return spec.scopes.some((s) => s === 'board:read' || s === 'task:read')
  }
  if (spec.scopes.length === 0) return true
  // any-of scopes
  if (!spec.scopes.some((s) => hasScope(principal, s))) return false
  // Strict role gate: if tool declares roles, principal.role must be included.
  // (Avoids prior OWNER-narrowing TS error and accidental list elevation.)
  if (spec.roles && spec.roles.length > 0 && !spec.roles.includes(principal.role)) {
    return false
  }
  // Hide unscoped board enumeration from tools/list for board-bound AGENT/INTEGRATOR.
  // tools/call also denies via authorizeToolCall (defense in depth). ROOT/OWNER/member retain.
  if (isUnscopedBoardEnumerationTool(name) && deniesUnscopedBoardEnumeration(principal)) {
    return false
  }
  return true
}

/**
 * Human-safe tools/list catalog for a principal.
 * Only returns entries from MCP_TOOL_SPECS that pass isToolListable —
 * never invents tools, never leaks unknown/internal names.
 * Unauthenticated → public tools only.
 */
export function listHumanSafeToolCatalog(
  principal: Principal | null,
): ReadonlyArray<ToolAuthSpec> {
  return MCP_TOOL_SPECS.filter((spec) => isToolListable(principal, spec.name))
}

/** Human-safe tool names only (order stable = MCP_TOOL_SPECS order). */
export function listHumanSafeToolNames(principal: Principal | null): string[] {
  return listHumanSafeToolCatalog(principal).map((s) => s.name)
}

/** Resolve alias target name, or self when not an alias. Unknown → null. */
export function resolveToolAliasTarget(name: string): string | null {
  const spec = TOOL_SPEC_BY_NAME.get(name)
  if (!spec) return null
  return spec.aliasOf ?? spec.name
}

export interface ToolAuthResult {
  ok: boolean
  code?: AuthErrorCode
  message?: string
  principal?: Principal
}

/**
 * tools/call authorization recheck (never trust tools/list alone).
 */
export function authorizeToolCall(
  principal: Principal | null,
  name: string,
  args: Record<string, unknown> = {},
): ToolAuthResult {
  const spec = TOOL_SPEC_BY_NAME.get(name)
  if (!spec) {
    return { ok: false, code: 'AUTHORIZATION_REQUIRED', message: `unknown tool: ${name}` }
  }
  if (spec.kind === 'public') {
    return { ok: true, principal: principal ?? publicPrincipal() }
  }
  if (!principal) {
    return {
      ok: false,
      code: 'AUTHORIZATION_REQUIRED',
      message: 'AUTHORIZATION_REQUIRED',
    }
  }
  // OWNER evidence impersonation — explicit code before generic scope/role deny
  if (
    principal.role === 'OWNER' &&
    (name === 'register_run' ||
      name === 'heartbeat_run' ||
      name === 'upsert_run' ||
      name === 'set_run_status')
  ) {
    return {
      ok: false,
      code: 'OWNER_EVIDENCE_IMPERSONATION_DENIED',
      message: 'OWNER cannot impersonate agent run evidence',
    }
  }
  if (principal.role === 'ROOT_ORCHESTRATOR' && (args.productionApprovalId || args.grantOwnerProductionApproval)) {
    return {
      ok: false,
      code: 'ROOT_PRODUCTION_APPROVAL_DENIED',
      message: 'ROOT cannot grant owner production approval',
    }
  }
  if (principal.channel === 'session' && principal.role !== 'OWNER' && principal.legacyRole === 'member') {
    // member: only board-read tools on allowlisted boards
    if (spec.kind === 'write') {
      return { ok: false, code: 'FORBIDDEN_SCOPE', message: 'member cannot write' }
    }
    if (!spec.scopes.some((s) => s === 'board:read' || s === 'task:read')) {
      return { ok: false, code: 'FORBIDDEN_SCOPE', message: 'member board-read allowlist only' }
    }
  }
  if (spec.scopes.length > 0 && !spec.scopes.some((s) => hasScope(principal, s))) {
    return { ok: false, code: 'FORBIDDEN_SCOPE', message: `missing scope for ${name}` }
  }
  if (spec.roles && spec.roles.length > 0 && !spec.roles.includes(principal.role)) {
    return { ok: false, code: 'FORBIDDEN_ROLE', message: `role ${principal.role} cannot call ${name}` }
  }
  if (spec.decisionResolve && principal.role !== 'OWNER') {
    return { ok: false, code: 'FORBIDDEN_ROLE', message: 'only OWNER may resolve decisions' }
  }
  if (spec.decisionRequest && principal.role === 'ROOT_ORCHESTRATOR') {
    // ROOT may not use decision request as owner resolve path
  }
  // Unscoped global board enumeration (e.g. list_boards): never for board-bound
  // AGENT/INTEGRATOR — previously bypassed because board scope ran only when boardId present.
  if (isUnscopedBoardEnumerationTool(name) && deniesUnscopedBoardEnumeration(principal)) {
    return {
      ok: false,
      code: 'FORBIDDEN_SCOPE',
      message: 'board-bound principal cannot access unscoped board enumeration',
    }
  }
  // Cross-board / board allowlist: enforce whenever boardId is present (non-empty).
  // OWNER always has board access (canAccessBoard); keep explicit short-circuit for clarity.
  const boardId =
    typeof args.boardId === 'string' && args.boardId.trim() !== '' ? args.boardId : null
  if (boardId && !canAccessBoard(principal, boardId) && principal.role !== 'OWNER') {
    return { ok: false, code: 'FORBIDDEN_SCOPE', message: 'no access to this board' }
  }
  // Board-bound AGENT/INTEGRATOR with boards allowlist: also reject non-string / wrong-type
  // boardId attempts that would otherwise skip the check (fail closed on hostile args).
  if (
    (principal.role === 'AGENT' || principal.role === 'INTEGRATOR') &&
    args.boardId != null &&
    boardId === null
  ) {
    // Present but empty/non-string boardId is not a valid scoped call — treat as unscoped.
    // Tools that do not need boardId (run/decision by id) omit the field entirely.
    // If caller sends boardId: "" / whitespace, deny rather than open unscoped path.
    if (typeof args.boardId === 'string') {
      return { ok: false, code: 'FORBIDDEN_SCOPE', message: 'no access to this board' }
    }
  }
  // AGENT own-run: missing binding is deny (fail-closed). Soft-pass when agentId unbound is forbidden.
  if (spec.ownRun && principal.role === 'AGENT') {
    const agentId = typeof args.agentId === 'string' ? args.agentId : principal.agentId
    if (!principal.agentId || !agentId || principal.agentId !== agentId) {
      return { ok: false, code: 'OWN_RUN_ONLY', message: 'AGENT own assigned run only' }
    }
  }
  return { ok: true, principal }
}

// ---- Bearer principal resolution (injectable, fail-closed) ----

export interface BearerTokenRecord {
  /** Opaque token id — NEVER log the raw secret. */
  tokenId: string
  /** Timing-safe compared secret (test/dev inject only; production uses external resolver). */
  secret: string
  role: Exclude<V3Role, 'PUBLIC'>
  actorId: string
  scopes?: ReadonlyArray<Scope>
  agentId?: string | null
  boardId?: string | null
  pathspecs?: ReadonlyArray<string>
  checkpointId?: string | null
  label?: string | null
}

export type BearerResolver = (token: string) => Promise<Principal | null> | Principal | null

let injectedBearerResolver: BearerResolver | null = null
let injectedBearerRecords: ReadonlyArray<BearerTokenRecord> | null = null

/** Test / wiring inject — does not enable production registry by itself. */
export function setBearerResolver(resolver: BearerResolver | null): void {
  injectedBearerResolver = resolver
}

export function setBearerTokenRecords(records: ReadonlyArray<BearerTokenRecord> | null): void {
  injectedBearerRecords = records
}

/**
 * Parse envBearerJson into principal records. Returns null when malformed or not an array.
 * Mechanism is OK only after valid parse of usable principal entries (secret + role).
 */
export function parseEnvBearerJson(
  raw: string | null | undefined,
): ReadonlyArray<BearerTokenRecord> | null {
  if (raw == null || !String(raw).trim()) return null
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return null
    const usable: BearerTokenRecord[] = []
    for (const rec of parsed) {
      if (!rec || typeof rec !== 'object') continue
      const r = rec as Partial<BearerTokenRecord>
      if (!r.secret || typeof r.secret !== 'string') continue
      const role = r.role
      if (
        role !== 'OWNER' &&
        role !== 'ROOT_ORCHESTRATOR' &&
        role !== 'AGENT' &&
        role !== 'INTEGRATOR'
      ) {
        continue
      }
      usable.push(r as BearerTokenRecord)
    }
    return usable
  } catch {
    return null
  }
}

export function getBearerAuthMechanismState(opts?: {
  envWriteToken?: string | null
  envBearerJson?: string | null
  resolverSet?: boolean
}): AuthMechanismState {
  if (injectedBearerResolver || (injectedBearerRecords && injectedBearerRecords.length > 0)) {
    return { kind: 'OK' }
  }
  if (opts?.resolverSet) return { kind: 'OK' }
  // Malformed / empty / non-array envBearerJson must NOT report OK (mechanism honesty).
  if (opts?.envBearerJson && opts.envBearerJson.trim()) {
    const records = parseEnvBearerJson(opts.envBearerJson)
    if (records && records.length > 0) return { kind: 'OK' }
    // fall through — invalid JSON is not an adequate bearer source
  }
  // Legacy CAIRN_WRITE_TOKEN alone is NOT adequate for full V3 matrix — still allows
  // a constrained AGENT bearer, but sensitive ROOT ops need explicit config.
  if (opts?.envWriteToken && opts.envWriteToken.trim()) {
    return { kind: 'OK' } // constrained agent only — see resolveBearerPrincipal
  }
  return {
    kind: 'DECISION_AUTH_MECHANISM_REQUIRED',
    reason: 'no injectable/configured bearer principal source',
  }
}

function timingSafeEqualStr(a: string, b: string): boolean {
  try {
    const ba = Buffer.from(a, 'utf8')
    const bb = Buffer.from(b, 'utf8')
    if (ba.length !== bb.length) {
      // Length mismatch: still run a dummy compare to avoid easy short-circuit oracle,
      // then fail closed.
      timingSafeEqual(ba, ba)
      return false
    }
    return timingSafeEqual(ba, bb)
  } catch {
    return false
  }
}

/**
 * Cookie browser identity cannot authenticate MCP bearer actions.
 * Call at MCP edge when a session principal is presented as if it were bearer.
 */
export function assertBearerChannel(principal: Principal | null | undefined): Principal {
  if (!principal) {
    throw new RbacError('AUTHORIZATION_REQUIRED', 'authentication required', 401)
  }
  if (principal.channel === 'session') {
    throw new RbacError(
      'COOKIE_ELEVATION_DENIED',
      'cookie browser identity cannot authenticate MCP bearer actions',
      403,
    )
  }
  return principal
}

/** Reset injectable bearer state (tests only). */
export function resetBearerInjection(): void {
  injectedBearerResolver = null
  injectedBearerRecords = null
}

/**
 * Build a fail-closed bearer principal from a token record.
 * - scopes ∩ role maxima (hostile custom scopes cannot elevate)
 * - AGENT/INTEGRATOR without board binding → null (disabled)
 */
export function principalFromBearerRecord(rec: BearerTokenRecord): Principal | null {
  const role = rec.role
  const boardId = rec.boardId?.trim() || null
  if (requiresBoardBinding(role) && !hasBoardBinding(boardId)) {
    return null
  }
  const scopes = intersectScopesWithRoleMaxima(role, rec.scopes)
  return {
    actorId: rec.actorId || rec.tokenId,
    role,
    scopes,
    channel: 'bearer',
    boards: boardId ? [boardId] : [],
    agentId: rec.agentId ?? (role === 'AGENT' ? rec.actorId || rec.tokenId : null),
    boardId,
    pathspecs: rec.pathspecs,
    checkpointId: rec.checkpointId ?? null,
    label: rec.label ?? rec.tokenId,
  }
}

/**
 * Clamp any principal (incl. custom resolver) to immutable role maxima + board binding rules.
 * Returns null when AGENT/INTEGRATOR is unbound.
 */
export function clampBearerPrincipal(principal: Principal): Principal | null {
  if (principal.channel === 'session' || principal.channel === 'public') {
    // Not a bearer clamp target — return as-is (session path has its own mapping).
    return principal
  }
  if (requiresBoardBinding(principal.role) && !hasBoardBinding(principal.boardId, principal.boards)) {
    return null
  }
  const boardId = principal.boardId?.trim() || null
  const boards =
    boardId && principal.boards.length === 0
      ? [boardId]
      : principal.boards.filter((b) => !!b && String(b).trim())
  return {
    ...principal,
    scopes: intersectScopesWithRoleMaxima(principal.role, principal.scopes),
    boardId: boardId ?? (boards[0] ?? null),
    boards: boardId ? (boards.includes(boardId) ? boards : [boardId, ...boards]) : boards,
  }
}

/**
 * Resolve MCP bearer principal. Never elevates from cookies.
 * Legacy CAIRN_WRITE_TOKEN → constrained AGENT only when board-bound
 * (CAIRN_WRITE_TOKEN_BOARD_ID / opts.envWriteTokenBoardId); unbound → disabled.
 */
export async function resolveBearerPrincipal(
  rawToken: string | null | undefined,
  opts?: {
    envWriteToken?: string | null
    /** Required for legacy write token — unbound legacy is disabled. */
    envWriteTokenBoardId?: string | null
    envBearerJson?: string | null
  },
): Promise<{ principal: Principal | null; mechanism: AuthMechanismState }> {
  const mechanism = getBearerAuthMechanismState({
    envWriteToken: opts?.envWriteToken,
    envBearerJson: opts?.envBearerJson,
    resolverSet: !!injectedBearerResolver || !!(injectedBearerRecords && injectedBearerRecords.length),
  })

  if (!rawToken) {
    return { principal: null, mechanism }
  }

  if (injectedBearerResolver) {
    const p = await injectedBearerResolver(rawToken)
    if (!p) return { principal: null, mechanism }
    const clamped = clampBearerPrincipal(p)
    return { principal: clamped, mechanism: clamped ? { kind: 'OK' } : mechanism }
  }

  if (injectedBearerRecords) {
    for (const rec of injectedBearerRecords) {
      if (timingSafeEqualStr(rec.secret, rawToken)) {
        const principal = principalFromBearerRecord(rec)
        return {
          principal,
          mechanism: principal ? { kind: 'OK' } : mechanism,
        }
      }
    }
  }

  // Optional JSON map from env (dev/test). Shape: [{tokenId,secret,role,actorId,...}]
  // NEVER log secrets. Empty/malformed → ignore principal; mechanism stays non-OK if sole source.
  if (opts?.envBearerJson) {
    const parsed = parseEnvBearerJson(opts.envBearerJson)
    if (parsed) {
      for (const rec of parsed) {
        if (rec?.secret && timingSafeEqualStr(String(rec.secret), rawToken)) {
          const principal = principalFromBearerRecord(rec)
          return {
            principal,
            mechanism: principal ? { kind: 'OK' } : mechanism,
          }
        }
      }
    }
  }

  // Legacy write token → constrained AGENT only when board-bound; otherwise disabled.
  // Explicit deny of owner/root/account/audit/evidence authority even if defaults change.
  if (opts?.envWriteToken && timingSafeEqualStr(opts.envWriteToken, rawToken)) {
    const boardId = (
      opts.envWriteTokenBoardId ??
      process.env.CAIRN_WRITE_TOKEN_BOARD_ID ??
      ''
    )
      .toString()
      .trim()
    if (!boardId) {
      // Unbound legacy write token is disabled (fail closed).
      return { principal: null, mechanism: { kind: 'OK' } }
    }
    const agentScopes = intersectScopesWithRoleMaxima(
      'AGENT',
      defaultScopesForRole('AGENT').filter(
        (s) =>
          s !== 'account:read' &&
          s !== 'audit:read' &&
          s !== 'evidence:read' &&
          s !== 'dispatch:write' &&
          s !== 'account:sync' &&
          s !== 'policy:write' &&
          s !== 'reconcile:write',
      ),
    )
    return {
      principal: {
        actorId: 'legacy-write-token',
        role: 'AGENT',
        scopes: agentScopes,
        channel: 'bearer',
        boards: [boardId],
        boardId,
        agentId: 'legacy-write-token',
        label: 'legacy-cairn-write-token',
      },
      mechanism: { kind: 'OK' },
    }
  }

  return { principal: null, mechanism }
}

/** Extract bearer from Authorization: Bearer or X-Cairn-Token (legacy). */
export function extractBearerFromHeaders(headers: Headers): string | null {
  const auth = headers.get('authorization')
  if (auth && /^Bearer\s+/i.test(auth)) {
    const t = auth.replace(/^Bearer\s+/i, '').trim()
    return t || null
  }
  const legacy = headers.get('x-cairn-token')
  return legacy && legacy.trim() ? legacy.trim() : null
}

/**
 * Safe auth error envelope for MCP tool responses — never includes credentials.
 */
export function authErrorEnvelope(code: AuthErrorCode | string, message?: string) {
  return {
    ok: false,
    error: message ?? code,
    code,
  }
}
