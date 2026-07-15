/**
 * MCP registration for domain knowledge retrieval tools
 * (01A §DOMAIN KNOWLEDGE + MCP RETRIEVAL).
 *
 * Pattern mirrors mcp-register-export-documentation.ts (TM-04): pure handlers +
 * inject secureTool/jsonText from board-mcp so RBAC/list stays centralized.
 *
 * Tool names (required):
 *   search_knowledge, get_domain_overview, list_domain_features,
 *   get_feature_documentation, get_feature_flow, get_related_entities,
 *   get_change_history
 *
 * Note: live tools/list visibility also needs MCP_TOOL_SPECS entries in rbac.ts
 * (out of TM-02 write scope). Handlers here are fully unit-testable.
 */

import { z } from 'zod'

import {
  DOMAIN_KNOWLEDGE_MCP_TOOL_NAMES,
  DomainKnowledgeError,
  getChangeHistory,
  getDomainOverview,
  getFeatureDocumentation,
  getFeatureFlow,
  getRelatedEntities,
  listDomainFeatures,
  searchKnowledge,
} from '#/server/domain-knowledge'
import type {
  DomainKnowledgeMcpToolName,
  KnowledgeSearchMode,
} from '#/server/domain-knowledge'

export { DOMAIN_KNOWLEDGE_MCP_TOOL_NAMES }
export type { DomainKnowledgeMcpToolName }

/** Greppable aliases matching MCP tool ids (board-mcp + acceptance string scan). */
export const search_knowledge = 'search_knowledge' as const
export const get_domain_overview = 'get_domain_overview' as const
export const list_domain_features = 'list_domain_features' as const
export const get_feature_documentation = 'get_feature_documentation' as const
export const get_feature_flow = 'get_feature_flow' as const
export const get_related_entities = 'get_related_entities' as const
export const get_change_history = 'get_change_history' as const

const SEARCH_MODES = ['exact', 'keyword', 'semantic', 'alias', 'all'] as const

export const domainKnowledgeBoardArg = {
  boardId: z
    .string()
    .optional()
    .describe('Board id (default = the first board); scopes pin context'),
}

export const searchKnowledgeInputSchema = {
  ...domainKnowledgeBoardArg,
  query: z
    .string()
    .describe('Search string (human id-ID / English / technical id / alias)'),
  mode: z
    .enum(SEARCH_MODES)
    .optional()
    .describe('exact | keyword | semantic | alias | all (default)'),
  domainId: z
    .string()
    .optional()
    .describe('Optional domain scope (e.g. AFFILIATE); omit = all packs'),
  pageSize: z.number().int().optional(),
  cursor: z.string().optional(),
  expectedRevision: z
    .number()
    .int()
    .optional()
    .describe('Fail closed on mixed revision'),
  refuseStale: z.boolean().optional(),
}

export const getDomainOverviewInputSchema = {
  ...domainKnowledgeBoardArg,
  domainId: z.string().describe('Domain id (e.g. AFFILIATE)'),
  expectedRevision: z.number().int().optional(),
  refuseStale: z.boolean().optional(),
  snapshotId: z.string().optional(),
  sourceHash: z.string().optional(),
  revision: z.number().int().optional(),
}

export const listDomainFeaturesInputSchema = {
  ...domainKnowledgeBoardArg,
  domainId: z.string(),
  projectId: z
    .string()
    .optional()
    .describe('Optional filter; default is complete cross-project inventory'),
  pageSize: z.number().int().optional(),
  cursor: z.string().optional(),
  expectedRevision: z.number().int().optional(),
  refuseStale: z.boolean().optional(),
}

export const getFeatureDocumentationInputSchema = {
  ...domainKnowledgeBoardArg,
  domainId: z.string(),
  featureId: z.string(),
  expectedRevision: z.number().int().optional(),
  refuseStale: z.boolean().optional(),
}

export const getFeatureFlowInputSchema = {
  ...domainKnowledgeBoardArg,
  domainId: z.string(),
  flowId: z.string().optional(),
  featureId: z
    .string()
    .optional()
    .describe('When flowId omitted, first flow for this feature'),
  expectedRevision: z.number().int().optional(),
  refuseStale: z.boolean().optional(),
}

export const getRelatedEntitiesInputSchema = {
  ...domainKnowledgeBoardArg,
  domainId: z.string(),
  entityId: z
    .string()
    .describe('Feature / flow / entity / project / relation endpoint id'),
  expectedRevision: z.number().int().optional(),
  refuseStale: z.boolean().optional(),
}

export const getChangeHistoryInputSchema = {
  ...domainKnowledgeBoardArg,
  domainId: z.string(),
  entityId: z.string().optional(),
  pageSize: z.number().int().optional(),
  cursor: z.string().optional(),
  expectedRevision: z.number().int().optional(),
  refuseStale: z.boolean().optional(),
}

export type DomainKnowledgeToolError = {
  ok: false
  tool: string
  code: string
  error: string
  details?: Record<string, unknown>
}

function toolError(tool: string, e: unknown): DomainKnowledgeToolError {
  if (e instanceof DomainKnowledgeError) {
    return {
      ok: false,
      tool,
      code: e.code,
      error: e.message,
      details: e.details,
    }
  }
  const msg = e instanceof Error ? e.message : String(e)
  return { ok: false, tool, code: 'INVALID_INPUT', error: msg }
}

function asMode(v: unknown): KnowledgeSearchMode | 'all' | undefined {
  if (v == null || v === '') return undefined
  const s = String(v)
  if (
    s === 'exact' ||
    s === 'keyword' ||
    s === 'semantic' ||
    s === 'alias' ||
    s === 'all'
  ) {
    return s
  }
  return undefined
}

export type SearchKnowledgeToolArgs = {
  boardId?: string
  query?: string
  mode?: string
  domainId?: string
  pageSize?: number
  cursor?: string
  expectedRevision?: number
  refuseStale?: boolean
}

export function handleSearchKnowledgeTool(
  args: SearchKnowledgeToolArgs = {},
): ReturnType<typeof searchKnowledge> | DomainKnowledgeToolError {
  try {
    const mode = asMode(args.mode)
    if (args.mode != null && args.mode !== '' && mode == null) {
      return {
        ok: false,
        tool: search_knowledge,
        code: 'UNKNOWN_SEARCH_MODE',
        error: `unknown search mode: ${args.mode}`,
      }
    }
    return searchKnowledge({
      query: args.query ?? '',
      mode: mode ?? 'all',
      domainId: args.domainId,
      pageSize: args.pageSize,
      cursor: args.cursor,
      expectedRevision: args.expectedRevision,
      refuseStale: args.refuseStale,
    })
  } catch (e) {
    return toolError(search_knowledge, e)
  }
}

export type GetDomainOverviewToolArgs = {
  boardId?: string
  domainId?: string
  expectedRevision?: number
  refuseStale?: boolean
  snapshotId?: string
  sourceHash?: string
  revision?: number
}

export function handleGetDomainOverviewTool(
  args: GetDomainOverviewToolArgs = {},
): ReturnType<typeof getDomainOverview> | DomainKnowledgeToolError {
  try {
    if (!args.domainId?.trim()) {
      return {
        ok: false,
        tool: get_domain_overview,
        code: 'INVALID_INPUT',
        error: 'domainId is required',
      }
    }
    return getDomainOverview(args.domainId, {
      expectedRevision: args.expectedRevision,
      refuseStale: args.refuseStale,
      snapshotId: args.snapshotId,
      sourceHash: args.sourceHash,
      revision: args.revision,
    })
  } catch (e) {
    return toolError(get_domain_overview, e)
  }
}

export type ListDomainFeaturesToolArgs = {
  boardId?: string
  domainId?: string
  projectId?: string
  pageSize?: number
  cursor?: string
  expectedRevision?: number
  refuseStale?: boolean
}

export function handleListDomainFeaturesTool(
  args: ListDomainFeaturesToolArgs = {},
): ReturnType<typeof listDomainFeatures> | DomainKnowledgeToolError {
  try {
    if (!args.domainId?.trim()) {
      return {
        ok: false,
        tool: list_domain_features,
        code: 'INVALID_INPUT',
        error: 'domainId is required',
      }
    }
    return listDomainFeatures(args.domainId, {
      projectId: args.projectId,
      pageSize: args.pageSize,
      cursor: args.cursor,
      expectedRevision: args.expectedRevision,
      refuseStale: args.refuseStale,
    })
  } catch (e) {
    return toolError(list_domain_features, e)
  }
}

export type GetFeatureDocumentationToolArgs = {
  boardId?: string
  domainId?: string
  featureId?: string
  expectedRevision?: number
  refuseStale?: boolean
}

export function handleGetFeatureDocumentationTool(
  args: GetFeatureDocumentationToolArgs = {},
): ReturnType<typeof getFeatureDocumentation> | DomainKnowledgeToolError {
  try {
    if (!args.domainId?.trim() || !args.featureId?.trim()) {
      return {
        ok: false,
        tool: get_feature_documentation,
        code: 'INVALID_INPUT',
        error: 'domainId and featureId are required',
      }
    }
    return getFeatureDocumentation(args.domainId, args.featureId, {
      expectedRevision: args.expectedRevision,
      refuseStale: args.refuseStale,
    })
  } catch (e) {
    return toolError(get_feature_documentation, e)
  }
}

export type GetFeatureFlowToolArgs = {
  boardId?: string
  domainId?: string
  flowId?: string
  featureId?: string
  expectedRevision?: number
  refuseStale?: boolean
}

export function handleGetFeatureFlowTool(
  args: GetFeatureFlowToolArgs = {},
): ReturnType<typeof getFeatureFlow> | DomainKnowledgeToolError {
  try {
    if (!args.domainId?.trim()) {
      return {
        ok: false,
        tool: get_feature_flow,
        code: 'INVALID_INPUT',
        error: 'domainId is required',
      }
    }
    if (!args.flowId?.trim() && !args.featureId?.trim()) {
      return {
        ok: false,
        tool: get_feature_flow,
        code: 'INVALID_INPUT',
        error: 'flowId or featureId is required',
      }
    }
    return getFeatureFlow(args.domainId, {
      flowId: args.flowId,
      featureId: args.featureId,
      expectedRevision: args.expectedRevision,
      refuseStale: args.refuseStale,
    })
  } catch (e) {
    return toolError(get_feature_flow, e)
  }
}

export type GetRelatedEntitiesToolArgs = {
  boardId?: string
  domainId?: string
  entityId?: string
  expectedRevision?: number
  refuseStale?: boolean
}

export function handleGetRelatedEntitiesTool(
  args: GetRelatedEntitiesToolArgs = {},
): ReturnType<typeof getRelatedEntities> | DomainKnowledgeToolError {
  try {
    if (!args.domainId?.trim() || !args.entityId?.trim()) {
      return {
        ok: false,
        tool: get_related_entities,
        code: 'INVALID_INPUT',
        error: 'domainId and entityId are required',
      }
    }
    return getRelatedEntities(args.domainId, args.entityId, {
      expectedRevision: args.expectedRevision,
      refuseStale: args.refuseStale,
    })
  } catch (e) {
    return toolError(get_related_entities, e)
  }
}

export type GetChangeHistoryToolArgs = {
  boardId?: string
  domainId?: string
  entityId?: string
  pageSize?: number
  cursor?: string
  expectedRevision?: number
  refuseStale?: boolean
}

export function handleGetChangeHistoryTool(
  args: GetChangeHistoryToolArgs = {},
): ReturnType<typeof getChangeHistory> | DomainKnowledgeToolError {
  try {
    if (!args.domainId?.trim()) {
      return {
        ok: false,
        tool: get_change_history,
        code: 'INVALID_INPUT',
        error: 'domainId is required',
      }
    }
    return getChangeHistory(args.domainId, {
      entityId: args.entityId,
      pageSize: args.pageSize,
      cursor: args.cursor,
      expectedRevision: args.expectedRevision,
      refuseStale: args.refuseStale,
    })
  } catch (e) {
    return toolError(get_change_history, e)
  }
}

export type DomainKnowledgeRegisterDeps = {
  secureTool: (
    name: string,
    meta: {
      title: string
      description: string
      inputSchema: Record<string, unknown> | object
    },
    handler: (args: Record<string, unknown>) => Promise<unknown> | unknown,
  ) => void
  jsonText: (value: unknown) => unknown
}

/**
 * Register all 01A domain-knowledge MCP tools via injected secureTool.
 * Call from board-mcp `registerBoardTools`.
 */
export function registerDomainKnowledgeTools(
  deps: DomainKnowledgeRegisterDeps,
): void {
  const { secureTool, jsonText } = deps

  secureTool(
    search_knowledge,
    {
      title: 'Search domain knowledge',
      description:
        'Exact / keyword / semantic / alias search across the authorized domain knowledge graph ' +
        '(features, flows, entities, relations, projects). Returns cited hits with match reason, ' +
        'pagination, revision token. Mixed-revision / stale pins fail closed.',
      inputSchema: searchKnowledgeInputSchema,
    },
    async (args) => jsonText(handleSearchKnowledgeTool(args)),
  )

  secureTool(
    get_domain_overview,
    {
      title: 'Get domain overview',
      description:
        'Human domain boundaries, coverage manifest, status rollup, gaps, freshness, ' +
        'blockers/decisions/evidence, redactions — from DomainKnowledgeBundle.',
      inputSchema: getDomainOverviewInputSchema,
    },
    async (args) => jsonText(handleGetDomainOverviewTool(args)),
  )

  secureTool(
    list_domain_features,
    {
      title: 'List domain features',
      description:
        'Complete paginated cross-project feature inventory for a domain (not a single project filter). ' +
        'Optional projectId narrows; default is full cross-project set with stable ordering.',
      inputSchema: listDomainFeaturesInputSchema,
    },
    async (args) => jsonText(handleListDomainFeaturesTool(args)),
  )

  secureTool(
    get_feature_documentation,
    {
      title: 'Get feature documentation',
      description:
        'Cited human documentation plus technical appendix for one feature, with related flows/entities.',
      inputSchema: getFeatureDocumentationInputSchema,
    },
    async (args) => jsonText(handleGetFeatureDocumentationTool(args)),
  )

  secureTool(
    get_feature_flow,
    {
      title: 'Get feature flow',
      description:
        'Ordered flow nodes, variants, dependencies, outcomes, and readbacks for a feature/flow id.',
      inputSchema: getFeatureFlowInputSchema,
    },
    async (args) => jsonText(handleGetFeatureFlowTool(args)),
  )

  secureTool(
    get_related_entities,
    {
      title: 'Get related entities',
      description:
        'Typed incoming/outgoing relations and dependency graph neighborhood for an entity id.',
      inputSchema: getRelatedEntitiesInputSchema,
    },
    async (args) => jsonText(handleGetRelatedEntitiesTool(args)),
  )

  secureTool(
    get_change_history,
    {
      title: 'Get knowledge change history',
      description:
        'Actor-attributed revision-consistent history/delta for a domain (optional entity filter).',
      inputSchema: getChangeHistoryInputSchema,
    },
    async (args) => jsonText(handleGetChangeHistoryTool(args)),
  )
}

/** Tool name list for tests / catalog checks. */
export function listDomainKnowledgeToolNames(): readonly DomainKnowledgeMcpToolName[] {
  return DOMAIN_KNOWLEDGE_MCP_TOOL_NAMES
}
