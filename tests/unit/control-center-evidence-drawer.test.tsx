/**
 * ART-017 Evidence & Citation drawer — unit support evidence (LOCAL ONLY).
 * Covers open/close, Escape, focus trap basics, width class, raw receipt
 * progressive disclosure, a11y roles, deep-link helpers, and mappers.
 */
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  EvidenceDrawer,
  citationToDrawerModel,
  encodeEvidenceDeepLink,
  evidenceDeepLinkPath,
  materialEventToDrawerModel,
  parseEvidenceDeepLink,
  type EvidenceDrawerViewModel,
} from '#/components/control-center/evidence'

function sampleModel(
  over: Partial<EvidenceDrawerViewModel> = {},
): EvidenceDrawerViewModel {
  return {
    id: 'ev-sample-1',
    proofSummary: 'Readback staging lolos untuk gerbang G5.',
    claimSupported: 'Kesiapan staging terbukti lewat verifikator independen.',
    verifier: 'Spark verifier',
    verifiedAt: '2026-07-16T10:00:00.000Z',
    freshness: 'Segar (< 1 jam)',
    revision: 'boardRev 12 / lifecycleRev 4',
    snapshotId: 'snap-abc',
    sourceAnchor: '/.artifact/evidence/sample/receipt.json',
    sourceHref: '/.artifact/evidence/sample/receipt.json',
    warnings: [],
    rawReceipt: '{\n  "verdict": "PASS"\n}',
    citationText: 'ev-sample-1 · Spark verifier · snap-abc',
    ...over,
  }
}

afterEach(() => {
  cleanup()
})

describe('EvidenceDrawer a11y + open/close', () => {
  it('renders nothing when closed', () => {
    render(
      <EvidenceDrawer open={false} model={sampleModel()} onClose={() => {}} />,
    )
    expect(screen.queryByTestId('evidence-drawer')).toBeNull()
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('opens with dialog role, aria-modal, labelled title, and id-ID labels', () => {
    render(
      <EvidenceDrawer open model={sampleModel()} onClose={() => {}} />,
    )
    const dialog = screen.getByRole('dialog')
    expect(dialog.getAttribute('aria-modal')).toBe('true')
    expect(dialog.getAttribute('data-testid')).toBe('evidence-drawer')
    expect(dialog.getAttribute('data-evidence-id')).toBe('ev-sample-1')
    expect(screen.getByTestId('evidence-drawer-title').textContent).toContain(
      'Detail bukti',
    )
    expect(screen.getByText('Ringkasan bukti')).toBeTruthy()
    expect(screen.getByText('Klaim yang didukung')).toBeTruthy()
    expect(screen.getByText('Verifikator independen')).toBeTruthy()
    expect(screen.getByText('Jangkar sumber')).toBeTruthy()
    expect(screen.getByTestId('evidence-drawer-proof').textContent).toContain(
      'Readback staging',
    )
    expect(screen.getByTestId('evidence-drawer-verifier').textContent).toContain(
      'Spark verifier',
    )
  })

  it('calls onClose from Tutup button and Escape', () => {
    const onClose = vi.fn()
    const { rerender } = render(
      <EvidenceDrawer open model={sampleModel()} onClose={onClose} />,
    )
    fireEvent.click(screen.getByTestId('evidence-drawer-close'))
    expect(onClose).toHaveBeenCalledTimes(1)

    onClose.mockClear()
    rerender(<EvidenceDrawer open model={sampleModel()} onClose={onClose} />)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)

    onClose.mockClear()
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('closes when backdrop is clicked but not when drawer body is clicked', () => {
    const onClose = vi.fn()
    render(
      <EvidenceDrawer open model={sampleModel()} onClose={onClose} />,
    )
    fireEvent.click(screen.getByTestId('evidence-drawer-body'))
    expect(onClose).not.toHaveBeenCalled()
    fireEvent.click(screen.getByTestId('evidence-drawer-backdrop'))
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})

describe('EvidenceDrawer width class + progressive disclosure', () => {
  it('applies desktop width contract class (480–640)', () => {
    render(
      <EvidenceDrawer open model={sampleModel()} onClose={() => {}} />,
    )
    const drawer = screen.getByTestId('evidence-drawer')
    expect(drawer.getAttribute('data-drawer-width')).toBe('desktop-480-640')
    // CSS module hashes class names; assert the module class is present via classList length
    // and the known data attribute contract above.
    expect(drawer.className.length).toBeGreaterThan(0)
    // Module exports drawerWidth — className should include a hashed fragment.
    expect(drawer.className).toMatch(/drawerWidth|drawer/i)
  })

  it('keeps raw receipt nested under technical disclosure (closed by default)', () => {
    render(
      <EvidenceDrawer open model={sampleModel()} onClose={() => {}} />,
    )
    const disclosure = screen.getByTestId(
      'evidence-drawer-raw-disclosure',
    ) as HTMLDetailsElement
    expect(disclosure.tagName).toBe('DETAILS')
    expect(disclosure.open).toBe(false)
    expect(screen.getByText('Detail teknis (resi mentah)')).toBeTruthy()
    // Summary is visible; raw body is in closed details (still in DOM).
    const raw = screen.getByTestId('evidence-drawer-raw-receipt')
    expect(raw.textContent).toContain('PASS')
    fireEvent.click(within(disclosure).getByText('Detail teknis (resi mentah)'))
    expect(disclosure.open).toBe(true)
  })

  it('omits raw disclosure when rawReceipt is null', () => {
    render(
      <EvidenceDrawer
        open
        model={sampleModel({ rawReceipt: null })}
        onClose={() => {}}
      />,
    )
    expect(screen.queryByTestId('evidence-drawer-raw-disclosure')).toBeNull()
  })

  it('surfaces conflict/stale/redaction warnings with alert role', () => {
    render(
      <EvidenceDrawer
        open
        model={sampleModel({
          warnings: [
            { kind: 'conflict', message: 'Dua sumber tidak cocok.' },
            { kind: 'stale', message: 'Pin basi.' },
            { kind: 'redaction', message: 'Sebagian disembunyikan.' },
          ],
        })}
        onClose={() => {}}
      />,
    )
    const box = screen.getByTestId('evidence-drawer-warnings')
    expect(box.getAttribute('role')).toBe('alert')
    expect(screen.getByTestId('evidence-drawer-warning-conflict').textContent).toContain(
      'Konflik',
    )
    expect(screen.getByTestId('evidence-drawer-warning-stale').textContent).toContain(
      'Basi',
    )
    expect(
      screen.getByTestId('evidence-drawer-warning-redaction').textContent,
    ).toContain('Redaksi')
  })
})

describe('EvidenceDrawer focus trap + focus return', () => {
  it('moves focus into the drawer on open and returns on close', () => {
    const onClose = vi.fn()
    function Host({ open }: { open: boolean }) {
      return (
        <div>
          <button type="button" data-testid="opener">
            Buka
          </button>
          <EvidenceDrawer
            open={open}
            model={sampleModel()}
            onClose={onClose}
          />
        </div>
      )
    }

    const { rerender } = render(<Host open={false} />)
    const opener = screen.getByTestId('opener')
    opener.focus()
    expect(document.activeElement).toBe(opener)

    rerender(<Host open={true} />)
    // Close button is the initial focus target.
    expect(document.activeElement).toBe(
      screen.getByTestId('evidence-drawer-close'),
    )

    rerender(<Host open={false} />)
    expect(document.activeElement).toBe(opener)
  })

  it('traps Tab cycling within the drawer focusables', () => {
    render(
      <EvidenceDrawer open model={sampleModel()} onClose={() => {}} />,
    )
    const dialog = screen.getByRole('dialog')
    const closeBtn = screen.getByTestId('evidence-drawer-close')
    const copyBtn = screen.getByTestId('evidence-drawer-copy')
    const sourceLink = screen.getByTestId('evidence-drawer-source-link')

    // From last focusable, Tab wraps to first.
    sourceLink.focus()
    fireEvent.keyDown(dialog, { key: 'Tab' })
    expect(document.activeElement === copyBtn || document.activeElement === closeBtn).toBe(
      true,
    )

    // From first focusable, Shift+Tab wraps to last.
    copyBtn.focus()
    fireEvent.keyDown(dialog, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(sourceLink)
  })
})

describe('EvidenceDrawer copy citation', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('invokes onCopyCitation with citation text', async () => {
    const onCopy = vi.fn().mockResolvedValue(undefined)
    render(
      <EvidenceDrawer
        open
        model={sampleModel()}
        onClose={() => {}}
        onCopyCitation={onCopy}
      />,
    )
    fireEvent.click(screen.getByTestId('evidence-drawer-copy'))
    expect(onCopy).toHaveBeenCalledWith('ev-sample-1 · Spark verifier · snap-abc')
    // status may appear async; wait a tick
    await vi.waitFor(() => {
      expect(screen.getByTestId('evidence-drawer-copy-status').textContent).toContain(
        'disalin',
      )
    })
  })
})

describe('deep-link helpers', () => {
  it('parseEvidenceDeepLink reads evidence id from record and URLSearchParams', () => {
    expect(parseEvidenceDeepLink({ evidence: 'ev-1' })).toBe('ev-1')
    expect(parseEvidenceDeepLink({ evidence: '  ' })).toBeNull()
    expect(parseEvidenceDeepLink({})).toBeNull()
    expect(parseEvidenceDeepLink(null)).toBeNull()
    const params = new URLSearchParams('cursor=abc&evidence=ev-9')
    expect(parseEvidenceDeepLink(params)).toBe('ev-9')
  })

  it('encodeEvidenceDeepLink merges and clears evidence without inventing params', () => {
    expect(encodeEvidenceDeepLink({ cursor: 'c1' }, 'ev-2')).toEqual({
      cursor: 'c1',
      evidence: 'ev-2',
    })
    expect(encodeEvidenceDeepLink({ cursor: 'c1', evidence: 'old' }, null)).toEqual({
      cursor: 'c1',
    })
  })

  it('evidenceDeepLinkPath builds relative path with query', () => {
    expect(
      evidenceDeepLinkPath('/b/mfs-rebuild/evidence', 'ev-3', { cursor: 'x' }),
    ).toBe('/b/mfs-rebuild/evidence?cursor=x&evidence=ev-3')
  })
})

describe('mappers (honest, no invented verifier)', () => {
  it('materialEventToDrawerModel maps event + pin without inventing verifier', () => {
    const model = materialEventToDrawerModel(
      {
        id: 'e1',
        createdAt: '2026-07-16T12:00:00.000Z',
        kind: 'RECEIPT',
        summary: 'Gate lolos',
        materialHash: 'abc123def456',
      },
      {
        canonicalSnapshotId: 'snap-1',
        boardRev: 3,
        lifecycleRev: 1,
        stale: true,
        staleReason: 'Pin lebih dari SLA',
      },
    )
    expect(model.verifier).toBeNull()
    expect(model.proofSummary).toBe('Gate lolos')
    expect(model.snapshotId).toBe('snap-1')
    expect(model.warnings.some((w) => w.kind === 'stale')).toBe(true)
    expect(model.rawReceipt).toContain('abc123def456')
  })

  it('citationToDrawerModel maps field/path/note only', () => {
    const model = citationToDrawerModel({
      field: 'statusSentence',
      path: '/humanDisplay/statusSentence',
      note: 'Dari proyeksi REVIEWED',
    })
    expect(model.verifier).toBeNull()
    expect(model.proofSummary).toContain('REVIEWED')
    expect(model.sourceAnchor).toBe('/humanDisplay/statusSentence')
    expect(model.warnings).toEqual([])
  })
})
