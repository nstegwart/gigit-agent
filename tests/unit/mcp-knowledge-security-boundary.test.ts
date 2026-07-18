/**
 * TM-IMPL-MCP-SECURITY-BOUNDARY-R1 — product knowledge tools security boundary.
 *
 * Proves:
 * - Unauth registration/list never includes knowledge tools (public-only)
 * - Auth principals with board:read list knowledge tools once (no duplicates)
 * - Registration goes through secureTool (isToolListable + authorizeToolCall)
 * - Production path is sole registerBoardTools (no bare registerKnowledgeTools in mcp.ts)
 * - AGENT scopes unchanged (board:read already grants knowledge tools)
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

import { registerBoardTools } from '#/server/board-mcp'
import {
  KNOWLEDGE_TOOL_NAMES,
  registerKnowledgeTools,
} from '#/server/knowledge-tools'
import {
  authorizeToolCall,
  defaultScopesForRole,
  isPublicTool,
  isToolListable,
  type Principal,
  type V3Role,
} from '#/server/rbac'
import { authGate } from '#/routes/mcp'

const KNOWLEDGE = [...KNOWLEDGE_TOOL_NAMES] as const

function registeredNames(server: McpServer): string[] {
  return Object.keys(
    (server as unknown as { _registeredTools?: Record<string, unknown> })._registeredTools ?? {},
  ).sort()
}

function principalFor(role: V3Role, extra: Partial<Principal> = {}): Principal {
  return {
    actorId: `${role.toLowerCase()}-ksb`,
    role,
    scopes: defaultScopesForRole(role),
    channel: 'bearer',
    boards: role === 'AGENT' || role === 'INTEGRATOR' ? ['mfs-rebuild'] : [],
    agentId: role === 'AGENT' ? 'agent-ksb' : null,
    boardId: role === 'AGENT' || role === 'INTEGRATOR' ? 'mfs-rebuild' : null,
    ...extra,
  }
}

function authCtx(principal: Principal | null) {
  return {
    principal,
    mechanism: principal
      ? ({ kind: 'OK' as const })
      : ({ kind: 'DECISION_AUTH_MECHANISM_REQUIRED' as const, reason: 'none' }),
    bearerPresent: !!principal,
  }
}

describe('MCP knowledge security boundary (list + register)', () => {
  it('unauth registerBoardTools exposes only public tools (get_public_snapshot)', () => {
    const server = new McpServer({ name: 'cairn-board', version: '1.3.0' })
    registerBoardTools(server, authCtx(null))
    const names = registeredNames(server)
    expect(names).toContain('get_public_snapshot')
    for (const n of names) {
      expect(isPublicTool(n), `unauth registered non-public: ${n}`).toBe(true)
    }
    for (const n of KNOWLEDGE) {
      expect(names).not.toContain(n)
      expect(isToolListable(null, n)).toBe(false)
    }
  })

  it('OWNER registerBoardTools lists each knowledge tool exactly once', () => {
    const server = new McpServer({ name: 'cairn-board', version: '1.3.0' })
    registerBoardTools(server, authCtx(principalFor('OWNER')))
    const names = registeredNames(server)
    for (const n of KNOWLEDGE) {
      const count = names.filter((x) => x === n).length
      expect(count, `duplicate or missing ${n}`).toBe(1)
      expect(isToolListable(principalFor('OWNER'), n)).toBe(true)
    }
  })

  it('AGENT lists knowledge tools via existing board:read (no scope broadening)', () => {
    const agent = principalFor('AGENT')
    expect(agent.scopes).toContain('board:read')
    // Explicit: AGENT maxima must not gain new scopes for this repair
    expect(agent.scopes).toEqual(defaultScopesForRole('AGENT'))

    const server = new McpServer({ name: 'cairn-board', version: '1.3.0' })
    registerBoardTools(server, authCtx(agent))
    const names = registeredNames(server)
    for (const n of KNOWLEDGE) {
      expect(names).toContain(n)
      expect(isToolListable(agent, n)).toBe(true)
      expect(authorizeToolCall(agent, n, {}).ok).toBe(true)
    }
  })

  it('authorizeToolCall denies unauth knowledge tools/call', () => {
    for (const n of KNOWLEDGE) {
      const r = authorizeToolCall(null, n, {})
      expect(r.ok).toBe(false)
      expect(r.code).toBe('AUTHORIZATION_REQUIRED')
    }
  })

  it('authGate blocks unauth tools/call for all four knowledge tools', async () => {
    for (const name of KNOWLEDGE) {
      const req = new Request('http://127.0.0.1:3000/mcp', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: {
            name,
            arguments: {
              query: 'period',
              idOrName: 'x',
              methodPath: 'GET /x',
              project: 'rn',
            },
          },
        }),
      })
      const gated = await authGate(req)
      expect(gated instanceof Response, name).toBe(true)
      if (gated instanceof Response) {
        expect(gated.status, name).toBe(401)
        const body = (await gated.json()) as {
          error?: { data?: { code?: string }; message?: string }
        }
        const code = body?.error?.data?.code ?? body?.error?.message ?? ''
        expect(String(code)).toMatch(/AUTHORIZATION_REQUIRED/)
      }
    }
  })

  it('registerKnowledgeTools requires secureTool injector (no bare McpServer API)', () => {
    const offered: string[] = []
    registerKnowledgeTools({
      secureTool: (name) => {
        offered.push(name)
      },
      jsonText: (v) => v,
    })
    expect(offered).toEqual([...KNOWLEDGE])
  })

  it('source: mcp.ts does not bare-register knowledge tools; board-mcp wires secure path', () => {
    const mcpSrc = readFileSync(join(process.cwd(), 'src/routes/mcp.ts'), 'utf8')
    const boardSrc = readFileSync(join(process.cwd(), 'src/server/board-mcp.ts'), 'utf8')
    const knowSrc = readFileSync(join(process.cwd(), 'src/server/knowledge-tools.ts'), 'utf8')

    expect(mcpSrc).not.toMatch(/registerKnowledgeTools\s*\(/)
    expect(mcpSrc).toMatch(/registerBoardTools\s*\(\s*server/)
    expect(boardSrc).toMatch(/registerKnowledgeTools\s*\(\s*\{\s*secureTool/)
    // Product knowledge before domain-knowledge (corpus ownership of search_knowledge)
    const k = boardSrc.indexOf('registerKnowledgeTools({ secureTool')
    const d = boardSrc.indexOf('registerDomainKnowledgeTools({ secureTool')
    expect(k).toBeGreaterThan(0)
    expect(d).toBeGreaterThan(k)
    // No bare server.registerTool in knowledge-tools registration
    expect(knowSrc).not.toMatch(/server\.registerTool\s*\(/)
    expect(knowSrc).toMatch(/secureTool\s*\(/)
  })
})
