/**
 * MCP registration for `export_documentation` (01A §HUMAN DOCUMENTATION EXPORT).
 *
 * TM-04 owns this module + the pure export service. TM-02 (or board-mcp integrator)
 * wires `registerExportDocumentationTool` into `registerBoardTools` via the injected
 * `secureTool` helper so RBAC/list filtering stays centralized.
 *
 * This module does not import board-mcp (avoids cycles); callers pass deps.
 */

import { z } from 'zod'

import {
  DOCUMENTATION_EXPORT_FORMATS,
  DOCUMENTATION_EXPORT_SCOPES,
  exportDocumentation,
} from '#/server/documentation-export'
import type {
  DocumentationExportBundle,
  DocumentationExportFormat,
  DocumentationExportPin,
  DocumentationExportRequest,
  DocumentationExportResult,
  DocumentationExportScope,
} from '#/server/documentation-export'

/** Canonical MCP tool name — must match MCP_TOOL_SPECS when catalog is extended. */
export const EXPORT_DOCUMENTATION_TOOL_NAME = 'export_documentation' as const

/** Wire aliases accepted at the MCP boundary (canonical formats stay in DOCUMENTATION_EXPORT_FORMATS). */
const FORMAT_ALIASES: Record<string, DocumentationExportFormat> = {
  md: 'markdown',
  'text/markdown': 'markdown',
  markdown: 'markdown',
  html: 'html',
  pdf: 'pdf',
  csv: 'csv',
  json: 'json',
}

/** Wire-level format tokens (canonical + short aliases). Kept as a plain enum for MCP JSON Schema. */
const EXPORT_FORMAT_WIRE = [
  ...DOCUMENTATION_EXPORT_FORMATS,
  'md',
] as const

function normalizeExportFormat(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw
  const key = raw.trim().toLowerCase()
  return FORMAT_ALIASES[key] ?? raw
}

export const exportDocumentationInputSchema = {
  boardId: z.string().optional(),
  // Accept short alias "md" at the wire; handler normalizes to canonical "markdown".
  format: z.enum(EXPORT_FORMAT_WIRE),
  scope: z.enum(DOCUMENTATION_EXPORT_SCOPES).optional(),
  scopeId: z.string().optional(),
  /** Pinned SSOT identity (required unless deps.resolveBundle supplies pin). */
  snapshotId: z.string().optional(),
  sourceHash: z.string().optional(),
  boardRev: z.number().int().optional(),
  lifecycleRev: z.number().int().optional(),
  /** DomainKnowledgeBundle-shaped or documentation domain export payload. */
  bundle: z.record(z.string(), z.unknown()).optional(),
  /** Declared generation time (ISO). Omit for fixed deterministic sentinel. */
  generatedAt: z.string().optional(),
  /** Optional previous pin+bundle for changelog/delta. */
  previous: z
    .object({
      snapshotId: z.string(),
      sourceHash: z.string(),
      boardRev: z.number().int().optional(),
      lifecycleRev: z.number().int().optional(),
      bundle: z.record(z.string(), z.unknown()),
    })
    .optional(),
  /** When true, refuse if pin is known stale (default true). */
  refuseStale: z.boolean().optional(),
}

export type ExportDocumentationToolArgs = {
  boardId?: string
  /** Canonical format or wire alias (e.g. "md"); handler normalizes to DocumentationExportFormat. */
  format: DocumentationExportFormat | 'md'
  scope?: DocumentationExportScope
  scopeId?: string
  snapshotId?: string
  sourceHash?: string
  boardRev?: number
  lifecycleRev?: number
  bundle?: Record<string, unknown>
  generatedAt?: string
  previous?: {
    snapshotId: string
    sourceHash: string
    boardRev?: number
    lifecycleRev?: number
    bundle: Record<string, unknown>
  }
  refuseStale?: boolean
}

export type ResolvedExportSource = {
  pin: DocumentationExportPin
  bundle: DocumentationExportBundle
  scope: DocumentationExportScope
  scopeId: string
}

export type ExportDocumentationRegisterDeps = {
  /**
   * Same signature as board-mcp `secureTool` — name, meta, handler.
   * Handler return should match MCP content shape from jsonText.
   */
  secureTool: (
    name: string,
    meta: {
      title: string
      description: string
      inputSchema: Record<string, unknown> | object
    },
    handler: (args: ExportDocumentationToolArgs) => Promise<unknown> | unknown,
  ) => void
  /** Serialize tool result into MCP content (usually board-mcp jsonText). */
  jsonText: (value: unknown) => unknown
  /**
   * Optional loader for DomainKnowledgeBundle / domain docs from pinned SSOT.
   * When provided and args.bundle is omitted, used to resolve content.
   */
  resolveBundle?: (args: {
    boardId?: string
    scope: DocumentationExportScope
    scopeId: string
    snapshotId?: string
    sourceHash?: string
  }) => Promise<ResolvedExportSource | null> | ResolvedExportSource | null
}

function asString(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback
}

function asStringArray(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined
  return v.map((x) => String(x))
}

function mapCitation(c: unknown): {
  field: string
  path: string
  note?: string
} {
  const row = (c ?? {}) as Record<string, unknown>
  return {
    field: asString(row.field),
    path: asString(row.path),
    note: typeof row.note === 'string' ? row.note : undefined,
  }
}

/**
 * Normalize a loose DomainKnowledgeBundle / documentation payload into export bundle.
 */
export function normalizeExportBundle(
  raw: Record<string, unknown>,
): DocumentationExportBundle {
  const human =
    raw.humanDisplay && typeof raw.humanDisplay === 'object'
      ? (raw.humanDisplay as Record<string, unknown>)
      : null

  const title =
    asString(raw.title) ||
    asString(human?.title) ||
    asString(raw.domainId) ||
    asString(raw.domain) ||
    'Documentation export'

  const projects = Array.isArray(raw.projects)
    ? raw.projects.map((p) => {
        const row = (p ?? {}) as Record<string, unknown>
        return {
          id: asString(row.id ?? row.projectId),
          name: asString(row.name ?? row.title ?? row.id),
          status: typeof row.status === 'string' ? row.status : undefined,
        }
      })
    : undefined

  const features = Array.isArray(raw.features)
    ? raw.features.map((f) => {
        const row = (f ?? {}) as Record<string, unknown>
        return {
          id: asString(row.id ?? row.featureId),
          name: asString(row.name ?? row.title ?? row.id),
          status: typeof row.status === 'string' ? row.status : undefined,
        }
      })
    : undefined

  const flows = Array.isArray(raw.flows)
    ? raw.flows.map((fl) => {
        const row = (fl ?? {}) as Record<string, unknown>
        const nodes = Array.isArray(row.nodes)
          ? row.nodes.map((n) => {
              if (typeof n === 'string') return n
              const nr = (n ?? {}) as Record<string, unknown>
              return asString(nr.name ?? nr.title ?? nr.id)
            })
          : undefined
        return {
          id: asString(row.id ?? row.flowId),
          name: asString(row.name ?? row.title ?? row.id),
          nodes,
        }
      })
    : undefined

  const tasks = Array.isArray(raw.tasks)
    ? raw.tasks.map((t) => {
        const row = (t ?? {}) as Record<string, unknown>
        return {
          id: asString(row.id ?? row.taskId),
          title: asString(row.title ?? row.ownerPrimaryTitle ?? row.id),
          status: typeof row.status === 'string' ? row.status : undefined,
        }
      })
    : undefined

  const decisions = Array.isArray(raw.decisions)
    ? raw.decisions.map((d) => {
        const row = (d ?? {}) as Record<string, unknown>
        return {
          id: asString(row.id ?? row.decisionId),
          title: asString(row.title ?? row.id),
        }
      })
    : undefined

  const blockers = Array.isArray(raw.blockers)
    ? raw.blockers.map((b) => {
        const row = (b ?? {}) as Record<string, unknown>
        return {
          id: asString(row.id ?? row.blockerId ?? row.taskId),
          title: asString(row.title ?? row.reason ?? row.id),
        }
      })
    : undefined

  const gaps =
    asStringArray(raw.gaps) ?? asStringArray(raw.knowledgeGaps) ?? undefined

  const citations = Array.isArray(raw.citations)
    ? raw.citations.map(mapCitation)
    : undefined

  const redactions = Array.isArray(raw.redactions)
    ? raw.redactions.map((r) => {
        const row = (r ?? {}) as Record<string, unknown>
        return {
          field: asString(row.field),
          reason: asString(row.reason ?? row.note ?? 'redacted'),
        }
      })
    : undefined

  const relations = Array.isArray(raw.relations)
    ? raw.relations.map((r) => {
        const row = (r ?? {}) as Record<string, unknown>
        return {
          fromId: asString(row.fromId ?? row.from),
          toId: asString(row.toId ?? row.to),
          type: asString(row.type ?? row.relationType ?? 'related'),
        }
      })
    : undefined

  const statusBuckets =
    raw.statusBuckets &&
    typeof raw.statusBuckets === 'object' &&
    !Array.isArray(raw.statusBuckets)
      ? (raw.statusBuckets as Record<string, number>)
      : raw.statusRollup &&
          typeof raw.statusRollup === 'object' &&
          !Array.isArray(raw.statusRollup)
        ? Object.fromEntries(
            Object.entries(raw.statusRollup as Record<string, unknown>).map(
              ([k, v]) => [k, typeof v === 'number' ? v : Number(v) || 0],
            ),
          )
        : undefined

  const technicalAppendix =
    raw.technicalAppendix && typeof raw.technicalAppendix === 'object'
      ? (raw.technicalAppendix as Record<string, unknown>)
      : raw.coverageManifest && typeof raw.coverageManifest === 'object'
        ? { coverageManifest: raw.coverageManifest }
        : undefined

  const bodyMarkdown =
    asString(raw.bodyMarkdown) ||
    asString(raw.markdown) ||
    (typeof human?.outcome === 'string' ? String(human.outcome) : '')

  return {
    title,
    domainId: asString(raw.domainId || raw.domain) || undefined,
    executiveSummary:
      asString(raw.executiveSummary) ||
      asString(human?.outcome) ||
      asString(human?.current) ||
      undefined,
    bodyMarkdown: bodyMarkdown || undefined,
    projects,
    features,
    flows,
    tasks,
    decisions,
    blockers,
    gaps,
    citations,
    redactions,
    relations,
    statusBuckets,
    technicalAppendix,
    filters:
      raw.filters && typeof raw.filters === 'object'
        ? (raw.filters as Record<string, unknown>)
        : undefined,
    deepLinks: Array.isArray(raw.deepLinks)
      ? raw.deepLinks.map((d) => {
          const row = (d ?? {}) as Record<string, unknown>
          return { label: asString(row.label), href: asString(row.href) }
        })
      : undefined,
    knowledgeState:
      raw.knowledgeState === 'PROVEN' ||
      raw.knowledgeState === 'UNKNOWN' ||
      raw.knowledgeState === 'CONFLICT' ||
      raw.knowledgeState === 'STALE'
        ? raw.knowledgeState
        : undefined,
  }
}

export function buildExportRequestFromToolArgs(
  args: ExportDocumentationToolArgs,
  resolved?: ResolvedExportSource | null,
): DocumentationExportRequest | DocumentationExportResult {
  const formatNorm = normalizeExportFormat(args.format)
  const format = (
    typeof formatNorm === 'string' &&
    (DOCUMENTATION_EXPORT_FORMATS as readonly string[]).includes(formatNorm)
      ? formatNorm
      : args.format
  ) as DocumentationExportFormat
  const scope: DocumentationExportScope =
    args.scope ?? resolved?.scope ?? 'domain'
  const scopeId =
    args.scopeId ??
    resolved?.scopeId ??
    (asString(args.bundle?.domainId) ||
      asString(args.bundle?.domain) ||
      asString(args.boardId) ||
      'unknown')

  let pin: DocumentationExportPin | null = resolved?.pin ?? null
  if (!pin && args.snapshotId && args.sourceHash) {
    pin = {
      snapshotId: args.snapshotId,
      sourceHash: args.sourceHash,
      boardRev: args.boardRev,
      lifecycleRev: args.lifecycleRev,
    }
  }
  if (!pin && args.bundle) {
    const snap =
      asString(args.bundle.snapshotId) ||
      asString(args.bundle.canonicalSnapshotId)
    const hash =
      asString(args.bundle.sourceHash) || asString(args.bundle.canonicalHash)
    if (snap && hash) {
      pin = {
        snapshotId: snap,
        sourceHash: hash,
        boardRev:
          typeof args.bundle.boardRev === 'number'
            ? args.bundle.boardRev
            : args.boardRev,
        lifecycleRev:
          typeof args.bundle.lifecycleRev === 'number'
            ? args.bundle.lifecycleRev
            : args.lifecycleRev,
      }
    }
  }

  if (!pin) {
    return {
      ok: false,
      tool: 'export_documentation',
      code: 'MISSING_PIN',
      error:
        'pin required: pass snapshotId+sourceHash, embed in bundle, or wire resolveBundle (pinned SSOT)',
    }
  }

  const bundleRaw = args.bundle ?? resolved?.bundle
  if (!bundleRaw && !resolved?.bundle) {
    return {
      ok: false,
      tool: 'export_documentation',
      code: 'MISSING_BUNDLE',
      error:
        'bundle required or resolveBundle must supply DomainKnowledgeBundle content',
    }
  }

  const bundle = resolved?.bundle
    ? resolved.bundle
    : normalizeExportBundle(bundleRaw as Record<string, unknown>)

  let previous: DocumentationExportRequest['previous']
  if (args.previous) {
    previous = {
      pin: {
        snapshotId: args.previous.snapshotId,
        sourceHash: args.previous.sourceHash,
        boardRev: args.previous.boardRev,
        lifecycleRev: args.previous.lifecycleRev,
      },
      bundle: normalizeExportBundle(args.previous.bundle),
    }
  }

  return {
    format,
    scope: resolved?.scope ?? scope,
    scopeId: resolved?.scopeId ?? scopeId,
    pin,
    bundle,
    generatedAt: args.generatedAt,
    previous,
  }
}

/**
 * Core handler used by MCP tool registration and unit tests.
 */
export async function handleExportDocumentationTool(
  args: ExportDocumentationToolArgs,
  deps: Pick<ExportDocumentationRegisterDeps, 'resolveBundle'> = {},
): Promise<DocumentationExportResult> {
  // Normalize wire aliases (e.g. "md" → "markdown") even when called outside Zod parse.
  const normalizedFormat = normalizeExportFormat(args.format)
  if (
    typeof normalizedFormat === 'string' &&
    (DOCUMENTATION_EXPORT_FORMATS as readonly string[]).includes(normalizedFormat)
  ) {
    args = { ...args, format: normalizedFormat as DocumentationExportFormat }
  }
  const runtimeArgs = args as Partial<ExportDocumentationToolArgs>
  if (!runtimeArgs.format) {
    return {
      ok: false,
      tool: 'export_documentation',
      code: 'INVALID_FORMAT',
      error: `format required (one of ${DOCUMENTATION_EXPORT_FORMATS.join(', ')})`,
    }
  }

  const scope: DocumentationExportScope = args.scope ?? 'domain'
  const scopeId =
    args.scopeId ||
    asString(args.bundle?.domainId) ||
    asString(args.bundle?.domain) ||
    args.boardId ||
    'unknown'

  let resolved: ResolvedExportSource | null = null
  if (!args.bundle && deps.resolveBundle) {
    resolved =
      (await deps.resolveBundle({
        boardId: args.boardId,
        scope,
        scopeId,
        snapshotId: args.snapshotId,
        sourceHash: args.sourceHash,
      })) ?? null
  }

  const built = buildExportRequestFromToolArgs(args, resolved)
  if ('ok' in built && built.ok === false) return built

  return exportDocumentation(built as DocumentationExportRequest)
}

/**
 * Register the `export_documentation` MCP tool via injected secureTool.
 * Call from board-mcp `registerBoardTools` (TM-02 wiring).
 */
export function registerExportDocumentationTool(
  deps: ExportDocumentationRegisterDeps,
): void {
  const { secureTool, jsonText, resolveBundle } = deps

  secureTool(
    EXPORT_DOCUMENTATION_TOOL_NAME,
    {
      title: 'Export documentation',
      description:
        'Deterministic snapshot-pinned documentation export (markdown|md | html | pdf-print | csv | json). ' +
        'Exports from pinned SSOT / DomainKnowledgeBundle only — never screen scrapes. ' +
        'Two snapshots yield human changelog + machine delta. Stale pins fail closed when refuseStale.',
      inputSchema: exportDocumentationInputSchema,
    },
    async (args) => {
      const result = await handleExportDocumentationTool(args, {
        resolveBundle,
      })
      return jsonText(result)
    },
  )
}

/** Alias matching the MCP tool id for greppable acceptance. */
export const export_documentation = EXPORT_DOCUMENTATION_TOOL_NAME
