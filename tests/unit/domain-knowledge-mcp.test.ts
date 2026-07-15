/**
 * TM-02: DomainKnowledgeBundle contract + domain knowledge MCP tool handlers.
 * Pure handlers + registration wiring (no live MCP / RBAC catalog required).
 */
import { afterEach, describe, expect, it } from 'vitest'

import {
  DOMAIN_KNOWLEDGE_MCP_TOOL_NAMES,
  DOMAIN_KNOWLEDGE_SCHEMA_VERSION,
  DomainKnowledgeError,
  getChangeHistory,
  getDomainKnowledgeBundle,
  getDomainOverview,
  getFeatureDocumentation,
  getFeatureFlow,
  getRelatedEntities,
  isDomainKnowledgeBundle,
  listDomainFeatures,
  listRegisteredDomainIds,
  loadDomainBundle,
  registerDomainPack,
  resetDomainPacksForTests,
  searchKnowledge,
} from '#/server/domain-knowledge'
import type { DomainKnowledgeBundle } from '#/server/domain-knowledge'
import {
  DOMAIN_KNOWLEDGE_MCP_TOOL_NAMES as MCP_NAMES_FROM_MCP,
  get_change_history,
  get_domain_overview,
  get_feature_documentation,
  get_feature_flow,
  get_related_entities,
  handleGetChangeHistoryTool,
  handleGetDomainOverviewTool,
  handleGetFeatureDocumentationTool,
  handleGetFeatureFlowTool,
  handleGetRelatedEntitiesTool,
  handleListDomainFeaturesTool,
  handleSearchKnowledgeTool,
  list_domain_features,
  listDomainKnowledgeToolNames,
  registerDomainKnowledgeTools,
  search_knowledge,
} from '#/server/domain-knowledge-mcp'
import {
  DOMAIN_KNOWLEDGE_TOOLS_WIRED,
  registerBoardTools,
  search_knowledge as boardSearchKnowledge,
  get_domain_overview as boardGetDomainOverview,
  list_domain_features as boardListDomainFeatures,
  get_feature_documentation as boardGetFeatureDocumentation,
  get_feature_flow as boardGetFeatureFlow,
  get_related_entities as boardGetRelatedEntities,
  get_change_history as boardGetChangeHistory,
} from '#/server/board-mcp'
import {
  defaultScopesForRole,
  isToolListable,
  listHumanSafeToolNames,
} from '#/server/rbac'
import type { Principal } from '#/server/rbac'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

afterEach(() => {
  resetDomainPacksForTests()
})

function boardAgent(): Principal {
  return {
    actorId: 'knowledge-agent',
    role: 'AGENT',
    scopes: defaultScopesForRole('AGENT'),
    channel: 'bearer',
    boards: ['mfs-rebuild'],
    boardId: 'mfs-rebuild',
    agentId: 'knowledge-agent',
  }
}

describe('live MCP knowledge catalog wiring', () => {
  it('registers and lists the exact seven knowledge tools plus export', () => {
    const principal = boardAgent()
    const expected = [
      ...DOMAIN_KNOWLEDGE_MCP_TOOL_NAMES,
      'export_documentation',
    ]
    const registered: Array<string> = []
    registerBoardTools(
      {
        registerTool(name: string) {
          registered.push(name)
        },
        registerResource() {},
      } as never,
      { principal, mechanism: { kind: 'OK' }, bearerPresent: true },
    )

    for (const name of expected) {
      expect(registered).toContain(name)
      expect(isToolListable(principal, name)).toBe(true)
      expect(listHumanSafeToolNames(principal)).toContain(name)
    }
    expect(isToolListable(null, 'search_knowledge')).toBe(false)
    expect(isToolListable(null, 'export_documentation')).toBe(false)
  })
})

describe('DomainKnowledgeBundle contract', () => {
  it('loads AFFILIATE pack with required schema fields', () => {
    const bundle = getDomainKnowledgeBundle('AFFILIATE')
    expect(isDomainKnowledgeBundle(bundle)).toBe(true)
    expect(bundle.schemaVersion).toBe(DOMAIN_KNOWLEDGE_SCHEMA_VERSION)
    expect(bundle.domainId).toBe('AFFILIATE')
    expect(bundle.humanDisplay.ownerLanguage).toBe('id-ID')
    expect(bundle.humanDisplay.title).toBeTruthy()
    expect(bundle.boundaries.length).toBeGreaterThan(0)
    expect(bundle.projects.length).toBeGreaterThan(0)
    expect(bundle.features.length).toBeGreaterThan(0)
    expect(bundle.flows.length).toBeGreaterThan(0)
    expect(bundle.coverageManifest.length).toBeGreaterThan(0)
    expect(bundle.citations.length).toBeGreaterThan(0)
    expect(typeof bundle.snapshotId).toBe('string')
    expect(typeof bundle.revision).toBe('number')
    expect(typeof bundle.sourceHash).toBe('string')
    expect(bundle.freshness).toEqual(
      expect.objectContaining({
        stale: expect.any(Boolean),
      }),
    )
    expect(['available', 'partial', 'unavailable']).toContain(
      bundle.availability,
    )
  })

  it('resolves affiliate aliases', () => {
    expect(loadDomainBundle('aff').domainId).toBe('AFFILIATE')
    expect(loadDomainBundle('afiliasi').domainId).toBe('AFFILIATE')
    expect(listRegisteredDomainIds()).toContain('AFFILIATE')
  })

  it('fails closed on mixed revision', () => {
    const b = getDomainKnowledgeBundle('AFFILIATE')
    expect(() =>
      loadDomainBundle('AFFILIATE', { expectedRevision: b.revision + 99 }),
    ).toThrow(DomainKnowledgeError)
    try {
      loadDomainBundle('AFFILIATE', { expectedRevision: b.revision + 99 })
    } catch (e) {
      expect(e).toBeInstanceOf(DomainKnowledgeError)
      expect((e as DomainKnowledgeError).code).toBe('MIXED_REVISION')
    }
  })

  it('fails closed on stale pin when refuseStale', () => {
    registerDomainPack('STALE_TEST', () => {
      const base = getDomainKnowledgeBundle('AFFILIATE')
      return {
        ...base,
        domainId: 'STALE_TEST',
        freshness: {
          ageSeconds: 999,
          stale: true,
          staleReason: 'fixture stale',
        },
      }
    })
    expect(() => loadDomainBundle('STALE_TEST', { refuseStale: true })).toThrow(
      DomainKnowledgeError,
    )
    const ok = loadDomainBundle('STALE_TEST', { refuseStale: false })
    expect(ok.freshness.stale).toBe(true)
  })
})

describe('search_knowledge', () => {
  it('exact / keyword / alias / semantic modes return cited hits', () => {
    const exact = searchKnowledge({ query: 'AFFILIATE', mode: 'exact' })
    expect(exact.ok).toBe(true)
    expect(exact.hits.length).toBeGreaterThan(0)
    expect(exact.hits[0]?.citation.path).toBeTruthy()
    expect(exact.revision).toEqual(expect.any(Number))

    const keyword = searchKnowledge({
      query: 'komisi',
      mode: 'keyword',
      domainId: 'AFFILIATE',
    })
    expect(keyword.hits.length).toBeGreaterThan(0)
    expect(keyword.hits.every((h) => h.domainId === 'AFFILIATE')).toBe(true)

    const alias = searchKnowledge({ query: 'aff', mode: 'alias' })
    expect(alias.hits.some((h) => h.domainId === 'AFFILIATE')).toBe(true)

    const semantic = searchKnowledge({
      query: 'afiliasi mitra',
      mode: 'semantic',
    })
    expect(semantic.hits.length).toBeGreaterThan(0)
    expect(semantic.hits[0]?.matchReason).toBeTruthy()
  })

  it('paginates and preserves totals', () => {
    const page1 = searchKnowledge({
      query: 'a',
      mode: 'keyword',
      domainId: 'AFFILIATE',
      pageSize: 2,
    })
    expect(page1.hits.length).toBeLessThanOrEqual(2)
    expect(page1.total).toBeGreaterThanOrEqual(page1.hits.length)
    if (page1.nextCursor) {
      const page2 = searchKnowledge({
        query: 'a',
        mode: 'keyword',
        domainId: 'AFFILIATE',
        pageSize: 2,
        cursor: page1.nextCursor,
      })
      expect(page2.hits.length).toBeGreaterThan(0)
      // Distinct pages
      const ids1 = new Set(page1.hits.map((h) => `${h.kind}:${h.id}`))
      expect(page2.hits.some((h) => !ids1.has(`${h.kind}:${h.id}`))).toBe(true)
    }
  })

  it('handler returns INVALID_INPUT for empty query', () => {
    const r = handleSearchKnowledgeTool({ query: '' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('INVALID_INPUT')
  })
})

describe('get_domain_overview', () => {
  it('returns boundaries, coverage, gaps, freshness', () => {
    const overview = getDomainOverview('AFFILIATE')
    expect(overview.ok).toBe(true)
    expect(overview.boundaries.length).toBeGreaterThan(0)
    expect(overview.coverageManifest.length).toBeGreaterThan(0)
    expect(overview.statusRollup.featureCount).toBeGreaterThan(0)
    expect(overview.knowledgeGaps).toEqual(expect.any(Array))
    expect(overview.freshness).toBeDefined()
    expect(overview.humanDisplay.title).toBeTruthy()

    const tool = handleGetDomainOverviewTool({ domainId: 'AFFILIATE' })
    expect(tool.ok).toBe(true)
  })

  it('handler requires domainId', () => {
    const r = handleGetDomainOverviewTool({})
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('INVALID_INPUT')
  })
})

describe('list_domain_features', () => {
  it('returns complete paginated cross-project inventory', () => {
    const all = listDomainFeatures('AFFILIATE', { pageSize: 200 })
    expect(all.ok).toBe(true)
    expect(all.crossProject).toBe(true)
    expect(all.total).toBeGreaterThan(0)
    expect(all.features.length).toBe(all.total)
    const projects = new Set(all.features.map((f) => f.projectId))
    expect(projects.size).toBeGreaterThan(1)

    const page = listDomainFeatures('AFFILIATE', { pageSize: 1 })
    expect(page.features).toHaveLength(1)
    expect(page.nextCursor).toBe('1')

    const tool = handleListDomainFeaturesTool({
      domainId: 'AFFILIATE',
      pageSize: 5,
    })
    expect(tool.ok).toBe(true)
  })
})

describe('get_feature_documentation / get_feature_flow', () => {
  it('returns cited human docs + technical appendix', () => {
    const features = listDomainFeatures('AFFILIATE', { pageSize: 1 })
    const featureId = features.features[0].id
    const doc = getFeatureDocumentation('AFFILIATE', featureId)
    expect(doc.ok).toBe(true)
    expect(doc.humanDocumentation).toBeTruthy()
    expect(doc.technicalAppendix.featureId).toBe(featureId)
    expect(doc.citations.length).toBeGreaterThan(0)

    const tool = handleGetFeatureDocumentationTool({
      domainId: 'AFFILIATE',
      featureId,
    })
    expect(tool.ok).toBe(true)
  })

  it('returns ordered flow nodes and outcomes', () => {
    const bundle = getDomainKnowledgeBundle('AFFILIATE')
    const flow = bundle.flows[0]
    const got = getFeatureFlow('AFFILIATE', { flowId: flow.id })
    expect(got.ok).toBe(true)
    expect(got.orderedNodes.length).toBe(flow.nodes.length)
    for (let i = 1; i < got.orderedNodes.length; i++) {
      expect(got.orderedNodes[i].order).toBeGreaterThanOrEqual(
        got.orderedNodes[i - 1].order,
      )
    }
    expect(got.outcomes.length).toBeGreaterThan(0)

    const byFeature = handleGetFeatureFlowTool({
      domainId: 'AFFILIATE',
      featureId: flow.featureId,
    })
    expect(byFeature.ok).toBe(true)
  })
})

describe('get_related_entities / get_change_history', () => {
  it('returns typed relations and dependency graph', () => {
    const bundle = getDomainKnowledgeBundle('AFFILIATE')
    const rel = bundle.relations[0]
    const got = getRelatedEntities('AFFILIATE', rel.fromId)
    expect(got.ok).toBe(true)
    expect(got.outgoing.length + got.incoming.length).toBeGreaterThan(0)
    expect(got.dependencyGraph.nodes.length).toBeGreaterThan(0)
    expect(got.dependencyGraph.edges.length).toBeGreaterThan(0)

    const tool = handleGetRelatedEntitiesTool({
      domainId: 'AFFILIATE',
      entityId: rel.fromId,
    })
    expect(tool.ok).toBe(true)
  })

  it('returns actor-attributed revision-consistent history', () => {
    const hist = getChangeHistory('AFFILIATE', { pageSize: 10 })
    expect(hist.ok).toBe(true)
    expect(hist.entries.length).toBeGreaterThan(0)
    expect(hist.entries[0]?.actor).toBeTruthy()
    expect(hist.entries[0]?.revision).toBe(hist.revision)
    expect(hist.sourceHash).toBeTruthy()

    const tool = handleGetChangeHistoryTool({ domainId: 'AFFILIATE' })
    expect(tool.ok).toBe(true)
  })
})

describe('MCP tool registry wiring', () => {
  it('exports all 7 required tool name constants', () => {
    expect(DOMAIN_KNOWLEDGE_MCP_TOOL_NAMES).toEqual([
      'search_knowledge',
      'get_domain_overview',
      'list_domain_features',
      'get_feature_documentation',
      'get_feature_flow',
      'get_related_entities',
      'get_change_history',
    ])
    expect(listDomainKnowledgeToolNames()).toEqual(
      DOMAIN_KNOWLEDGE_MCP_TOOL_NAMES,
    )
    expect(MCP_NAMES_FROM_MCP).toEqual(DOMAIN_KNOWLEDGE_MCP_TOOL_NAMES)
    expect(DOMAIN_KNOWLEDGE_TOOLS_WIRED).toEqual([
      ...DOMAIN_KNOWLEDGE_MCP_TOOL_NAMES,
    ])
    expect(search_knowledge).toBe('search_knowledge')
    expect(get_domain_overview).toBe('get_domain_overview')
    expect(list_domain_features).toBe('list_domain_features')
    expect(get_feature_documentation).toBe('get_feature_documentation')
    expect(get_feature_flow).toBe('get_feature_flow')
    expect(get_related_entities).toBe('get_related_entities')
    expect(get_change_history).toBe('get_change_history')
    // board-mcp re-exports
    expect(boardSearchKnowledge).toBe('search_knowledge')
    expect(boardGetDomainOverview).toBe('get_domain_overview')
    expect(boardListDomainFeatures).toBe('list_domain_features')
    expect(boardGetFeatureDocumentation).toBe('get_feature_documentation')
    expect(boardGetFeatureFlow).toBe('get_feature_flow')
    expect(boardGetRelatedEntities).toBe('get_related_entities')
    expect(boardGetChangeHistory).toBe('get_change_history')
  })

  it('registerDomainKnowledgeTools registers all 7 names via secureTool', () => {
    const registered: string[] = []
    registerDomainKnowledgeTools({
      secureTool: (name, _meta, _handler) => {
        registered.push(name)
      },
      jsonText: (v) => v,
    })
    expect(registered).toEqual([...DOMAIN_KNOWLEDGE_MCP_TOOL_NAMES])
  })

  it('board-mcp.ts re-exports the canonical modular tool-name contract', () => {
    const path = resolve(process.cwd(), 'src/server/board-mcp.ts')
    const text = readFileSync(path, 'utf8')
    for (const n of DOMAIN_KNOWLEDGE_MCP_TOOL_NAMES) {
      expect(text.includes(n)).toBe(true)
    }
    expect(text.includes("from '#/server/domain-knowledge-mcp'")).toBe(true)
  })

  it('registerDomainKnowledgeTools handlers return JSON-serializable results', async () => {
    const handlers = new Map<
      string,
      (args: Record<string, unknown>) => Promise<unknown> | unknown
    >()
    registerDomainKnowledgeTools({
      secureTool: (name, _meta, handler) => {
        handlers.set(name, handler)
      },
      jsonText: (v) => ({
        content: [{ type: 'text', text: JSON.stringify(v) }],
      }),
    })
    const search = await handlers.get('search_knowledge')!({
      query: 'affiliate',
      mode: 'keyword',
    })
    const searchText = (search as { content: Array<{ text: string }> })
      .content[0].text
    const searchBody = JSON.parse(searchText) as {
      ok: boolean
      hits: unknown[]
    }
    expect(searchBody.ok).toBe(true)
    expect(Array.isArray(searchBody.hits)).toBe(true)

    const overview = await handlers.get('get_domain_overview')!({
      domainId: 'AFFILIATE',
    })
    const overviewBody = JSON.parse(
      (overview as { content: Array<{ text: string }> }).content[0].text,
    ) as { ok: boolean; domainId: string }
    expect(overviewBody.ok).toBe(true)
    expect(overviewBody.domainId).toBe('AFFILIATE')
  })
})

describe('custom domain pack registration', () => {
  it('supports additional packs without dropping AFFILIATE', () => {
    const custom: DomainKnowledgeBundle = {
      ...getDomainKnowledgeBundle('AFFILIATE'),
      domainId: 'CUSTOM',
      humanDisplay: {
        title: 'Custom',
        summary: 'Custom domain pack',
        boundarySentence: 'Test only',
        ownerLanguage: 'id-ID',
      },
      aliases: ['custom', 'cst'],
    }
    registerDomainPack('CUSTOM', () => custom)
    expect(listRegisteredDomainIds()).toEqual(
      expect.arrayContaining(['AFFILIATE', 'CUSTOM']),
    )
    const hit = searchKnowledge({
      query: 'Custom',
      mode: 'exact',
      domainId: 'CUSTOM',
    })
    expect(hit.hits.some((h) => h.domainId === 'CUSTOM')).toBe(true)
  })
})
