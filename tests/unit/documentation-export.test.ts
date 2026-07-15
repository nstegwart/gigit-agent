/**
 * LOCAL ONLY — pure documentation export + MCP register module.
 * Deterministic MD/HTML/CSV/JSON from pinned SSOT (01A §HUMAN DOCUMENTATION EXPORT).
 */
import { describe, expect, it, vi } from 'vitest'

import {
  DOCUMENTATION_EXPORT_FORMATS,
  bundleFromDocumentationDomainView,
  exportDocumentation,
  export_documentation,
} from '#/server/documentation-export'
import type { DocumentationExportRequest } from '#/server/documentation-export'
import {
  EXPORT_DOCUMENTATION_TOOL_NAME,
  export_documentation as export_documentation_tool_name,
  handleExportDocumentationTool,
  normalizeExportBundle,
  registerExportDocumentationTool,
} from '#/server/mcp-register-export-documentation'

const PIN = {
  snapshotId: 'snap-aff-001',
  sourceHash: 'b'.repeat(64),
  boardRev: 12,
  lifecycleRev: 3,
}

function baseRequest(
  overrides: Partial<DocumentationExportRequest> = {},
): DocumentationExportRequest {
  return {
    format: 'markdown',
    scope: 'domain',
    scopeId: 'AFFILIATE',
    pin: { ...PIN },
    bundle: {
      title: 'Domain AFFILIATE',
      domainId: 'AFFILIATE',
      executiveSummary: 'Dokumentasi afiliasi lintas proyek (pinned).',
      bodyMarkdown: '# Body\n\nAlur pendaftaran affiliate.',
      projects: [{ id: 'sales', name: 'Sales' }],
      features: [
        { id: 'F-aff-reg', name: 'Registrasi affiliate', status: 'ACTIVE' },
      ],
      flows: [
        {
          id: 'flow-reg',
          name: 'Registrasi → aktivasi',
          nodes: ['Daftar', 'KYC', 'Aktif'],
        },
      ],
      tasks: [{ id: 'T-AFF-1', title: 'Portal affiliate', status: 'ONGOING' }],
      decisions: [{ id: 'D-1', title: 'Komisi tier' }],
      blockers: [{ id: 'B-1', title: 'Webhook payout pending' }],
      relations: [{ fromId: 'F-aff-reg', toId: 'T-AFF-1', type: 'implements' }],
      gaps: ['NO_PROVIDER_READBACK'],
      citations: [
        { field: 'task', path: 'workRows.T-AFF-1', note: 'Portal affiliate' },
      ],
      redactions: [
        { field: 'accounts.secret', reason: 'RBAC account:read denied' },
      ],
      statusBuckets: { ONGOING: 1, BLOCKED: 1 },
      deepLinks: [
        {
          label: 'Domain',
          href: '/b/mfs-rebuild/documentation/domains/AFFILIATE',
        },
      ],
      technicalAppendix: {
        coverageManifest: { expected: 3, included: 2, unknown: 1 },
      },
      knowledgeState: 'PROVEN',
    },
    ...overrides,
  }
}

describe('exportDocumentation (deterministic formats)', () => {
  it('exports markdown with pin, citations, gaps, redaction disclosure', () => {
    const r = exportDocumentation(baseRequest({ format: 'markdown' }))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.tool).toBe('export_documentation')
    expect(r.format).toBe('markdown')
    expect(r.mimeType).toContain('markdown')
    expect(r.pin.snapshotId).toBe(PIN.snapshotId)
    expect(r.content).toContain('# Domain AFFILIATE')
    expect(r.content).toContain('## Executive summary')
    expect(r.content).toContain(PIN.snapshotId)
    expect(r.content).toContain(PIN.sourceHash)
    expect(r.content).toContain('workRows.T-AFF-1')
    expect(r.content).toContain('NO_PROVIDER_READBACK')
    expect(r.content).toContain('accounts.secret')
    expect(r.content).toContain('RBAC account:read denied')
    expect(r.citationCount).toBe(1)
    expect(r.gapCount).toBe(1)
  })

  it('exports semantic html with article landmark', () => {
    const r = exportDocumentation(baseRequest({ format: 'html' }))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.content).toContain('<!DOCTYPE html>')
    expect(r.content).toContain('<article data-export="documentation">')
    expect(r.content).toContain('Domain AFFILIATE')
    expect(r.mimeType).toContain('text/html')
  })

  it('exports print-ready pdf format as print HTML', () => {
    const r = exportDocumentation(baseRequest({ format: 'pdf' }))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.content).toContain('@media print')
    expect(r.content).toContain('Print-ready export')
    expect(r.filename).toContain('.print.html')
  })

  it('exports csv with stable ids and pin columns', () => {
    const r = exportDocumentation(baseRequest({ format: 'csv' }))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const lines = r.content.trim().split('\n')
    expect(lines[0]).toContain('row_type')
    expect(lines[0]).toContain('snapshot_id')
    expect(r.content).toContain('T-AFF-1')
    expect(r.content).toContain('snap-aff-001')
    expect(r.content).toContain('feature')
    expect(r.content).toContain('citation')
  })

  it('exports canonical json with sorted keys and relations', () => {
    const r = exportDocumentation(baseRequest({ format: 'json' }))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const parsed = JSON.parse(r.content) as Record<string, unknown>
    expect(parsed.tool).toBe('export_documentation')
    expect(parsed.scopeId).toBe('AFFILIATE')
    expect(parsed.deterministic).toBe(true)
    expect(Array.isArray(parsed.relations)).toBe(true)
    // stable stringify: keys sorted at top level
    const keys = Object.keys(parsed)
    expect(keys).toEqual([...keys].sort())
  })

  it('is deterministic for identical input (fixed generatedAt sentinel)', () => {
    const a = exportDocumentation(baseRequest({ format: 'markdown' }))
    const b = exportDocumentation(baseRequest({ format: 'markdown' }))
    expect(a).toEqual(b)
    if (a.ok && b.ok) {
      expect(a.content).toBe(b.content)
      expect(a.generatedAt).toBe('1970-01-01T00:00:00.000Z')
    }
  })

  it('uses declared generatedAt when provided (only declared non-determinism)', () => {
    const r = exportDocumentation(
      baseRequest({ format: 'json', generatedAt: '2026-07-14T12:00:00.000Z' }),
    )
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.generatedAt).toBe('2026-07-14T12:00:00.000Z')
    expect(r.content).toContain('2026-07-14T12:00:00.000Z')
  })

  it('produces changelog + machine delta across two snapshots', () => {
    const prev = baseRequest()
    const next = baseRequest({
      pin: { ...PIN, snapshotId: 'snap-aff-002', sourceHash: 'c'.repeat(64) },
      bundle: {
        ...baseRequest().bundle,
        tasks: [
          { id: 'T-AFF-1', title: 'Portal affiliate v2', status: 'ONGOING' },
          { id: 'T-AFF-2', title: 'Payout job', status: 'QUEUED' },
        ],
      },
      previous: {
        pin: prev.pin,
        bundle: prev.bundle,
      },
    })
    const r = exportDocumentation({ ...next, format: 'markdown' })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.changelog).toBeTruthy()
    expect(r.delta?.added).toContain('task:T-AFF-2')
    expect(r.delta?.changed).toContain('task:T-AFF-1')
    expect(r.content).toContain('## Changelog')
  })

  it('refuses stale pin fail-closed', () => {
    const r = exportDocumentation(
      baseRequest({
        pin: { ...PIN, stale: true, staleReason: 'BOARD_REV_DRIFT' },
      }),
    )
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.code).toBe('STALE_PIN_REFUSED')
    expect(r.error).toContain('BOARD_REV_DRIFT')
  })

  it('rejects missing pin / invalid format', () => {
    const noPin = exportDocumentation(
      baseRequest({
        pin: { snapshotId: '', sourceHash: '' },
      }),
    )
    expect(noPin.ok).toBe(false)
    if (!noPin.ok) expect(noPin.code).toBe('MISSING_PIN')

    const badFmt = exportDocumentation({
      ...baseRequest(),
      format: 'xml' as 'markdown',
    })
    expect(badFmt.ok).toBe(false)
    if (!badFmt.ok) expect(badFmt.code).toBe('INVALID_FORMAT')
  })

  it('exposes export_documentation alias identical to exportDocumentation', () => {
    const a = exportDocumentation(baseRequest({ format: 'csv' }))
    const b = export_documentation(baseRequest({ format: 'csv' }))
    expect(a).toEqual(b)
  })

  it('supports all declared formats', () => {
    for (const format of DOCUMENTATION_EXPORT_FORMATS) {
      const r = exportDocumentation(baseRequest({ format }))
      expect(r.ok, format).toBe(true)
    }
  })
})

describe('bundleFromDocumentationDomainView', () => {
  it('maps screen view model into pin+bundle', () => {
    const mapped = bundleFromDocumentationDomainView({
      domain: 'AFFILIATE',
      title: 'AFFILIATE',
      bodyMarkdown: '# x',
      citations: [{ field: 'task', path: 'workRows.T1', note: 'n' }],
      gaps: ['G1'],
      availability: 'available',
      pin: {
        canonicalSnapshotId: 'snap-1',
        canonicalHash: 'a'.repeat(64),
        boardRev: 1,
        lifecycleRev: 0,
        stale: false,
        staleReason: null,
      },
    })
    expect(mapped).not.toBeNull()
    expect(mapped!.pin.snapshotId).toBe('snap-1')
    expect(mapped!.bundle.domainId).toBe('AFFILIATE')
    expect(mapped!.bundle.citations?.[0]?.path).toBe('workRows.T1')
  })

  it('returns null without pin', () => {
    expect(
      bundleFromDocumentationDomainView({
        domain: 'X',
        title: 'X',
        bodyMarkdown: '',
        citations: [],
        gaps: [],
        availability: 'unavailable',
        pin: null,
      }),
    ).toBeNull()
  })
})

describe('mcp-register-export-documentation', () => {
  it('tool name is export_documentation', () => {
    expect(EXPORT_DOCUMENTATION_TOOL_NAME).toBe('export_documentation')
    expect(export_documentation_tool_name).toBe('export_documentation')
  })

  it('normalizeExportBundle accepts DomainKnowledgeBundle-shaped payload', () => {
    const b = normalizeExportBundle({
      domainId: 'AFFILIATE',
      humanDisplay: { title: 'Afiliasi', outcome: 'Ringkas owner' },
      projects: [{ id: 'p1', name: 'P1' }],
      features: [{ id: 'f1', name: 'F1' }],
      knowledgeGaps: ['GAP-A'],
      citations: [{ field: 'feature', path: 'features.f1' }],
      statusRollup: { ONGOING: 2 },
      coverageManifest: { expected: 1, included: 1 },
      relations: [{ from: 'f1', to: 'p1', type: 'in_project' }],
    })
    expect(b.title).toBe('Afiliasi')
    expect(b.gaps).toEqual(['GAP-A'])
    expect(b.statusBuckets?.ONGOING).toBe(2)
    expect(b.technicalAppendix).toEqual({
      coverageManifest: { expected: 1, included: 1 },
    })
    expect(b.relations?.[0]).toEqual({
      fromId: 'f1',
      toId: 'p1',
      type: 'in_project',
    })
  })

  it('handleExportDocumentationTool runs via args.bundle pin fields', async () => {
    const result = await handleExportDocumentationTool({
      format: 'json',
      scope: 'domain',
      scopeId: 'AFFILIATE',
      bundle: {
        title: 'AFFILIATE',
        domainId: 'AFFILIATE',
        snapshotId: PIN.snapshotId,
        sourceHash: PIN.sourceHash,
        boardRev: PIN.boardRev,
        tasks: [{ id: 'T-1', title: 'One' }],
        citations: [{ field: 'task', path: 'workRows.T-1' }],
      },
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.format).toBe('json')
    expect(result.pin.snapshotId).toBe(PIN.snapshotId)
  })

  it('handleExportDocumentationTool uses resolveBundle when bundle omitted', async () => {
    const result = await handleExportDocumentationTool(
      { format: 'markdown', boardId: 'mfs-rebuild', scopeId: 'AFFILIATE' },
      {
        resolveBundle: () => ({
          scope: 'domain',
          scopeId: 'AFFILIATE',
          pin: { ...PIN },
          bundle: {
            title: 'Resolved AFFILIATE',
            bodyMarkdown: 'from resolveBundle',
            citations: [],
            gaps: [],
          },
        }),
      },
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.content).toContain('Resolved AFFILIATE')
    expect(result.content).toContain('from resolveBundle')
  })

  it('registerExportDocumentationTool registers export_documentation via secureTool', () => {
    const registered: string[] = []
    const jsonText = vi.fn((v: unknown) => ({
      content: [{ type: 'text', text: JSON.stringify(v) }],
    }))
    const secureTool = vi.fn(
      (
        name: string,
        _meta: { title: string; description: string; inputSchema: object },
        _handler: (args: never) => unknown,
      ) => {
        registered.push(name)
      },
    )

    registerExportDocumentationTool({ secureTool, jsonText })

    expect(registered).toContain('export_documentation')
    expect(secureTool).toHaveBeenCalledTimes(1)
    const [name, meta] = secureTool.mock.calls[0]
    expect(name).toBe('export_documentation')
    expect(String(meta.description)).toMatch(/snapshot-pinned/i)
  })

  it('registered handler returns export payload via jsonText', async () => {
    let handler:
      | ((args: {
          format: 'csv'
          snapshotId: string
          sourceHash: string
          bundle: Record<string, unknown>
        }) => Promise<unknown>)
      | null = null

    registerExportDocumentationTool({
      secureTool: (_n, _m, h) => {
        handler = h as typeof handler
      },
      jsonText: (v) => ({ wrapped: v }),
    })
    expect(handler).toBeTruthy()
    const out = (await handler!({
      format: 'csv',
      snapshotId: PIN.snapshotId,
      sourceHash: PIN.sourceHash,
      bundle: {
        title: 'T',
        domainId: 'AFFILIATE',
        tasks: [{ id: 't1', title: 'Task' }],
      },
    })) as { wrapped: { ok: boolean; format?: string } }
    expect(out.wrapped.ok).toBe(true)
    expect(out.wrapped.format).toBe('csv')
  })
})
