/**
 * ART-017 Evidence & Citation drawer.
 * Opens from any evidence/citation link without losing page context.
 * Prop-driven only — parents supply EvidenceDrawerViewModel; no server fetches.
 */
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from 'react'

import styles from './evidence.module.css'
import type { EvidenceDrawerProps } from './types'

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'textarea:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

function getFocusable(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (el) => !el.hasAttribute('disabled') && el.getAttribute('aria-hidden') !== 'true',
  )
}

async function defaultCopy(text: string): Promise<void> {
  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text)
    return
  }
  // Fail-soft fallback for older environments / jsdom without clipboard mock.
  if (typeof document === 'undefined') return
  const ta = document.createElement('textarea')
  ta.value = text
  ta.setAttribute('readonly', '')
  ta.style.position = 'fixed'
  ta.style.left = '-9999px'
  document.body.appendChild(ta)
  ta.select()
  try {
    document.execCommand('copy')
  } finally {
    document.body.removeChild(ta)
  }
}

export function EvidenceDrawer({
  open,
  model,
  onClose,
  returnFocusRef,
  deepLinkHref,
  className,
  onCopyCitation,
}: EvidenceDrawerProps) {
  const titleId = useId()
  const descId = useId()
  const panelRef = useRef<HTMLElement>(null)
  const closeBtnRef = useRef<HTMLButtonElement>(null)
  const previouslyFocused = useRef<HTMLElement | null>(null)
  const [copyStatus, setCopyStatus] = useState<'idle' | 'copied' | 'error'>('idle')

  // Capture focus target when opening; restore on close.
  useLayoutEffect(() => {
    if (open) {
      previouslyFocused.current =
        (document.activeElement as HTMLElement | null) ?? null
      closeBtnRef.current?.focus()
      return
    }

    const restore =
      returnFocusRef?.current ?? previouslyFocused.current
    if (restore && typeof restore.focus === 'function') {
      restore.focus()
    }
    previouslyFocused.current = null
    setCopyStatus('idle')
  }, [open, returnFocusRef])

  // Body scroll lock while open.
  useEffect(() => {
    if (!open || typeof document === 'undefined') return
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = prev
    }
  }, [open])

  const handleKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLElement>) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        onClose()
        return
      }
      if (event.key !== 'Tab' || !panelRef.current) return

      const focusable = getFocusable(panelRef.current)
      if (focusable.length === 0) {
        event.preventDefault()
        panelRef.current.focus()
        return
      }
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      const active = document.activeElement as HTMLElement | null

      if (event.shiftKey) {
        if (active === first || !panelRef.current.contains(active)) {
          event.preventDefault()
          last.focus()
        }
      } else if (active === last) {
        event.preventDefault()
        first.focus()
      }
    },
    [onClose],
  )

  // Global Escape when focus is outside (backdrop click path still focuses panel).
  useEffect(() => {
    if (!open) return
    const onWindowKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
      }
    }
    window.addEventListener('keydown', onWindowKey)
    return () => window.removeEventListener('keydown', onWindowKey)
  }, [open, onClose])

  const handleBackdropClick = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (event.target === event.currentTarget) onClose()
  }

  const handleCopy = async () => {
    if (!model) return
    const text = model.citationText
    try {
      if (onCopyCitation) await onCopyCitation(text)
      else await defaultCopy(text)
      setCopyStatus('copied')
    } catch {
      setCopyStatus('error')
    }
  }

  if (!open) return null

  const hasModel = model != null
  const warnings = model?.warnings ?? []

  return (
    <div
      className={styles.backdrop}
      data-testid="evidence-drawer-backdrop"
      onClick={handleBackdropClick}
    >
      <aside
        ref={panelRef}
        className={[styles.drawer, styles.drawerWidth, className]
          .filter(Boolean)
          .join(' ')}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={hasModel ? descId : undefined}
        tabIndex={-1}
        data-testid="evidence-drawer"
        data-evidence-id={model?.id ?? undefined}
        data-drawer-width="desktop-480-640"
        onKeyDown={handleKeyDown}
      >
        <header className={styles.head}>
          <div>
            <p className={styles.eyebrow}>Bukti &amp; Kutipan</p>
            <h2 id={titleId} className={styles.title} data-testid="evidence-drawer-title">
              {hasModel ? 'Detail bukti' : 'Bukti tidak tersedia'}
            </h2>
          </div>
          <div className={styles.headActions}>
            {hasModel ? (
              <button
                type="button"
                className={styles.btn}
                onClick={() => void handleCopy()}
                data-testid="evidence-drawer-copy"
              >
                Salin kutipan
              </button>
            ) : null}
            <button
              ref={closeBtnRef}
              type="button"
              className={`${styles.btn} ${styles.closeBtn}`}
              onClick={onClose}
              data-testid="evidence-drawer-close"
              aria-label="Tutup laci bukti"
            >
              Tutup
              <kbd aria-hidden="true">Esc</kbd>
            </button>
          </div>
        </header>

        <div className={styles.body} data-testid="evidence-drawer-body">
          {!hasModel ? (
            <p className={styles.empty} role="status">
              Tidak ada model bukti untuk ditampilkan. Buka dari tautan kutipan
              yang valid.
            </p>
          ) : (
            <>
              <section className={styles.section} aria-labelledby={`${titleId}-proof`}>
                <p id={`${titleId}-proof`} className={styles.sectionLabel}>
                  Ringkasan bukti
                </p>
                <p
                  id={descId}
                  className={styles.sectionValue}
                  data-testid="evidence-drawer-proof"
                >
                  {model.proofSummary}
                </p>
              </section>

              <section className={styles.section}>
                <p className={styles.sectionLabel}>Klaim yang didukung</p>
                <p
                  className={styles.sectionValue}
                  data-testid="evidence-drawer-claim"
                >
                  {model.claimSupported}
                </p>
              </section>

              <div className={styles.metaGrid}>
                <div className={styles.metaCell}>
                  <p className={styles.sectionLabel}>Verifikator independen</p>
                  <p
                    className={styles.sectionValue}
                    data-testid="evidence-drawer-verifier"
                  >
                    {model.verifier ?? 'Belum tercatat'}
                  </p>
                </div>
                <div className={styles.metaCell}>
                  <p className={styles.sectionLabel}>Waktu verifikasi</p>
                  <p
                    className={styles.sectionValue}
                    data-testid="evidence-drawer-verified-at"
                  >
                    {model.verifiedAt ? (
                      <time dateTime={model.verifiedAt}>{model.verifiedAt}</time>
                    ) : (
                      'Belum tercatat'
                    )}
                  </p>
                </div>
                <div className={styles.metaCell}>
                  <p className={styles.sectionLabel}>Kesegaran</p>
                  <p
                    className={styles.sectionValue}
                    data-testid="evidence-drawer-freshness"
                  >
                    {model.freshness ?? 'Tidak diketahui'}
                  </p>
                </div>
                <div className={styles.metaCell}>
                  <p className={styles.sectionLabel}>Revisi / Snapshot</p>
                  <p
                    className={styles.sectionValue}
                    data-testid="evidence-drawer-revision"
                  >
                    {[model.revision, model.snapshotId]
                      .filter(Boolean)
                      .join(' · ') || 'Tidak diketahui'}
                  </p>
                </div>
              </div>

              <section className={styles.section}>
                <p className={styles.sectionLabel}>Jangkar sumber</p>
                <p
                  className={styles.sectionValue}
                  data-testid="evidence-drawer-source-anchor"
                >
                  {model.sourceAnchor ?? 'Tidak ada jangkar'}
                </p>
                {model.sourceHref ? (
                  <a
                    className={styles.sourceLink}
                    href={model.sourceHref}
                    data-testid="evidence-drawer-source-link"
                  >
                    Buka tautan sumber
                  </a>
                ) : null}
              </section>

              {warnings.length > 0 ? (
                <div
                  className={styles.warnings}
                  role="alert"
                  data-testid="evidence-drawer-warnings"
                >
                  {warnings.map((w, i) => (
                    <p
                      key={`${w.kind}-${i}`}
                      className={styles.warning}
                      data-kind={w.kind}
                      data-testid={`evidence-drawer-warning-${w.kind}`}
                    >
                      <strong>
                        {w.kind === 'conflict'
                          ? 'Konflik'
                          : w.kind === 'stale'
                            ? 'Basi'
                            : 'Redaksi'}
                        :
                      </strong>{' '}
                      {w.message}
                    </p>
                  ))}
                </div>
              ) : null}

              {deepLinkHref ? (
                <p className={styles.deepLink} data-testid="evidence-drawer-deep-link">
                  Tautan dalam: <code>{deepLinkHref}</code>
                </p>
              ) : null}

              {copyStatus === 'copied' ? (
                <p
                  className={styles.copyStatus}
                  role="status"
                  data-testid="evidence-drawer-copy-status"
                >
                  Kutipan disalin.
                </p>
              ) : null}
              {copyStatus === 'error' ? (
                <p
                  className={styles.copyStatus}
                  role="status"
                  data-testid="evidence-drawer-copy-status"
                  style={{ color: 'var(--blocked, #b42318)' }}
                >
                  Gagal menyalin kutipan.
                </p>
              ) : null}

              {model.rawReceipt ? (
                <details
                  className={styles.disclosure}
                  data-testid="evidence-drawer-raw-disclosure"
                >
                  <summary>Detail teknis (resi mentah)</summary>
                  <pre
                    className={styles.rawReceipt}
                    data-testid="evidence-drawer-raw-receipt"
                  >
                    {model.rawReceipt}
                  </pre>
                </details>
              ) : null}
            </>
          )}
        </div>
      </aside>
    </div>
  )
}

export type { EvidenceDrawerProps, EvidenceDrawerViewModel } from './types'
