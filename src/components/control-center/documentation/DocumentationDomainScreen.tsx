/**
 * ART S17 documentation domain export preview with citations (prop-driven).
 * Client export uses the same pure exportDocumentation path as MCP (pinned SSOT only).
 */
import { useCallback, useMemo, useState } from 'react'

import type { DocumentationDomainViewModel } from '#/lib/control-center-route-adapters'
import {
  DOCUMENTATION_EXPORT_FORMATS,
  bundleFromDocumentationDomainView,
  exportDocumentation
  
  
} from '#/server/documentation-export'
import type {DocumentationExportFormat, DocumentationExportResult} from '#/server/documentation-export';
import {
  EvidenceDrawer,
  citationToDrawerModel
  
} from '#/components/control-center/evidence'
import type {EvidenceDrawerViewModel} from '#/components/control-center/evidence';

export type DocumentationDomainScreenProps = DocumentationDomainViewModel & {
  onRetry?: () => void
  className?: string
}

const HUMAN_FORMAT_LABEL: Record<DocumentationExportFormat, string> = {
  markdown: 'Markdown',
  html: 'HTML',
  pdf: 'Print/PDF',
  csv: 'CSV',
  json: 'JSON',
}

export function DocumentationDomainScreen({
  surfaceState,
  boardId,
  domain,
  availability,
  title,
  bodyMarkdown,
  citations,
  gaps,
  pin,
  error,
  onRetry,
  className,
}: DocumentationDomainScreenProps) {
  const [format, setFormat] = useState<DocumentationExportFormat>('markdown')
  const [exportResult, setExportResult] = useState<DocumentationExportResult | null>(null)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [drawerModel, setDrawerModel] = useState<EvidenceDrawerViewModel | null>(
    null,
  )

  const canExport = availability !== 'unavailable' && pin != null

  const openCitation = useCallback(
    (citation: { field: string; path: string; note?: string }, index: number) => {
      setDrawerModel(
        citationToDrawerModel(citation, {
          id: `doc-cite-${domain}-${index}`,
          claimSupported: `Dokumentasi domain ${domain}`,
        }),
      )
      setDrawerOpen(true)
    },
    [domain],
  )

  const closeDrawer = useCallback(() => {
    setDrawerOpen(false)
  }, [])

  const viewForExport = useMemo(
    () => ({
      domain,
      title,
      bodyMarkdown,
      citations,
      gaps,
      pin,
      availability,
    }),
    [domain, title, bodyMarkdown, citations, gaps, pin, availability],
  )

  const runExport = useCallback(() => {
    const mapped = bundleFromDocumentationDomainView(viewForExport)
    if (!mapped) {
      setExportResult({
        ok: false,
        tool: 'export_documentation',
        code: 'MISSING_PIN',
        error: 'Tidak ada pin SSOT — ekspor ditolak (bukan screen scrape).',
      })
      return
    }
    const result = exportDocumentation({
      format,
      scope: 'domain',
      scopeId: domain,
      pin: mapped.pin,
      bundle: mapped.bundle,
    })
    setExportResult(result)
  }, [domain, format, viewForExport])

  const downloadExport = useCallback(() => {
    if (!exportResult || !exportResult.ok) return
    if (typeof document === 'undefined') return
    const blob = new Blob([exportResult.content], { type: exportResult.mimeType })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = exportResult.filename
    a.rel = 'noopener'
    document.body.appendChild(a)
    a.click()
    a.remove()
    URL.revokeObjectURL(url)
  }, [exportResult])

  return (
    <section
      className={className}
      data-testid="control-center-documentation-domain"
      data-surface-state={surfaceState}
      data-board-id={boardId}
      data-domain={domain}
      data-availability={availability}
    >
      <header style={{ marginBottom: 16 }}>
        <p style={{ fontSize: 12, color: 'var(--text-faint)', margin: 0 }}>Dokumentasi domain</p>
        <h1 style={{ fontSize: 22, margin: '4px 0 8px' }} data-testid="documentation-title">
          {title}
        </h1>
        <p data-testid="documentation-availability">
          Status: <strong>{availability}</strong>
        </p>
        {onRetry ? (
          <button type="button" onClick={onRetry} data-testid="documentation-retry">
            Muat ulang
          </button>
        ) : null}
      </header>

      {error ? (
        <div role="alert" data-testid="documentation-error">
          {error.code}: {error.message}
        </div>
      ) : null}

      {availability === 'unavailable' ? (
        <div data-testid="documentation-unavailable" role="status">
          Dokumentasi domain tidak tersedia dari pin saat ini. Tidak mengekspor kesiapan palsu.
        </div>
      ) : (
        <pre
          data-testid="documentation-body"
          style={{
            whiteSpace: 'pre-wrap',
            fontFamily: 'inherit',
            background: 'var(--surface-2, #f0f1f5)',
            padding: 16,
            borderRadius: 8,
          }}
        >
          {bodyMarkdown}
        </pre>
      )}

      <section
        data-testid="documentation-export"
        style={{ marginTop: 20, padding: 12, border: '1px solid var(--border, #d0d4dc)', borderRadius: 8 }}
        aria-label="Ekspor dokumentasi"
      >
        <h2 style={{ fontSize: 16, marginTop: 0 }}>Ekspor dokumentasi (pin SSOT)</h2>
        <p style={{ fontSize: 13, color: 'var(--text-faint)', marginTop: 0 }}>
          Deterministik dari pin — bukan screen scrape. Format: Markdown, HTML, Print/PDF, CSV, JSON.
        </p>
        <div
          role="group"
          aria-label="Format ekspor"
          style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 12 }}
        >
          {DOCUMENTATION_EXPORT_FORMATS.map((f) => (
            <button
              key={f}
              type="button"
              data-testid={`documentation-export-format-${f}`}
              aria-pressed={format === f}
              disabled={!canExport}
              onClick={() => {
                setFormat(f)
                setExportResult(null)
              }}
              style={{
                padding: '8px 12px',
                minHeight: 44,
                minWidth: 44,
                fontWeight: format === f ? 600 : 400,
                border:
                  format === f
                    ? '2px solid var(--accent, #0b57d0)'
                    : '1px solid var(--border, #c5c9d2)',
                borderRadius: 6,
                background: format === f ? 'var(--surface-2, #eef1f6)' : 'transparent',
                cursor: canExport ? 'pointer' : 'not-allowed',
              }}
            >
              {HUMAN_FORMAT_LABEL[f]}
            </button>
          ))}
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          <button
            type="button"
            data-testid="documentation-export-run"
            disabled={!canExport}
            onClick={runExport}
            style={{ padding: '10px 16px', minHeight: 44, minWidth: 44 }}
          >
            Buat ekspor ({HUMAN_FORMAT_LABEL[format]})
          </button>
          <button
            type="button"
            data-testid="documentation-export-download"
            disabled={!exportResult || !exportResult.ok}
            onClick={downloadExport}
            style={{ padding: '10px 16px', minHeight: 44, minWidth: 44 }}
          >
            Unduh
          </button>
        </div>
        {!canExport ? (
          <p data-testid="documentation-export-disabled" role="status" style={{ marginTop: 8 }}>
            Ekspor dinonaktifkan: dokumentasi tidak tersedia atau pin hilang.
          </p>
        ) : null}
        {exportResult ? (
          <div data-testid="documentation-export-result" style={{ marginTop: 12 }}>
            {exportResult.ok ? (
              <>
                <p data-testid="documentation-export-meta" style={{ fontSize: 13 }}>
                  {exportResult.filename} · {exportResult.mimeType} · pin{' '}
                  <code>{exportResult.pin.snapshotId}</code> · sitasi {exportResult.citationCount} ·
                  gap {exportResult.gapCount}
                </p>
                <pre
                  data-testid="documentation-export-content"
                  style={{
                    whiteSpace: 'pre-wrap',
                    maxHeight: 320,
                    overflow: 'auto',
                    background: 'var(--surface-2, #f0f1f5)',
                    padding: 12,
                    borderRadius: 6,
                    fontSize: 12,
                  }}
                >
                  {exportResult.content.slice(0, 12_000)}
                  {exportResult.content.length > 12_000 ? '\n…' : ''}
                </pre>
              </>
            ) : (
              <div role="alert" data-testid="documentation-export-error">
                {exportResult.code}: {exportResult.error}
              </div>
            )}
          </div>
        ) : null}
      </section>

      {citations.length ? (
        <section data-testid="documentation-citations" style={{ marginTop: 16 }}>
          <h2>Kutipan</h2>
          <ul>
            {citations.map((c, i) => (
              <li key={`${c.path}-${i}`}>
                <button
                  type="button"
                  data-testid={`documentation-citation-open-${i}`}
                  onClick={() => openCitation(c, i)}
                  style={{
                    background: 'none',
                    border: 'none',
                    padding: 0,
                    color: 'var(--accent, #175cd3)',
                    cursor: 'pointer',
                    font: 'inherit',
                    textAlign: 'left',
                    minHeight: 44,
                  }}
                >
                  <code>{c.path}</code> · {c.field}
                  {c.note ? ` — ${c.note}` : ''}
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <EvidenceDrawer
        open={drawerOpen}
        model={drawerModel}
        onClose={closeDrawer}
        deepLinkHref={
          drawerModel
            ? `?evidence=${encodeURIComponent(drawerModel.id)}`
            : null
        }
      />

      {gaps.length ? (
        <section data-testid="documentation-gaps" style={{ marginTop: 16 }}>
          <h2>Gap jujur</h2>
          <ul>
            {gaps.map((g) => (
              <li key={g}>{g}</li>
            ))}
          </ul>
        </section>
      ) : null}

      {pin ? (
        <footer
          data-testid="documentation-pin"
          style={{ marginTop: 24, fontSize: 12, color: 'var(--text-faint)' }}
        >
          pin {pin.canonicalSnapshotId} · rev {pin.boardRev}/{pin.lifecycleRev}
          {pin.stale ? ` · STALE ${pin.staleReason ?? ''}` : ''}
        </footer>
      ) : null}
    </section>
  )
}
