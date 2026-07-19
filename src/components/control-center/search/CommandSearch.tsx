import { useEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'

import { Icon } from '#/lib/icons'
import type { Role } from '#/lib/types'

const RECENT_SEARCH_KEY = 'cairn.command-search.recent.v1'
const MAX_RECENT_SEARCHES = 5

export interface SafeCommand {
  id: string
  label: string
  description: string
  href: string
  keywords: string
  access: 'authenticated' | 'admin'
}

interface PaletteItem extends SafeCommand {
  group: 'Cari' | 'Terbaru' | 'Navigasi'
  query?: string
}

export interface CommandSearchProps {
  boardId: string
  currentHref: string
  role: Role
  onNavigate?: (href: string) => void
  /**
   * Optional command list override. AppShell passes canon Alur+Ops(+admin) so
   * control-center chrome does not advertise demoted multi-page product IA.
   * When omitted, buildRbacSafeCommands remains the default (unit-test path).
   */
  commands?: Array<SafeCommand>
}

function boardRoot(boardId: string) {
  return `/b/${encodeURIComponent(boardId)}`
}

/** Keep the originating board URL (including filters/revision) without allowing open redirects. */
export function safeBoardReturnHref(boardId: string, href: string): string {
  const root = boardRoot(boardId)
  try {
    const parsed = new URL(href, 'https://cairn.invalid')
    if (parsed.origin !== 'https://cairn.invalid') return root
    const relative = `${parsed.pathname}${parsed.search}${parsed.hash}`
    if (
      relative === root ||
      relative.startsWith(`${root}/`) ||
      relative.startsWith(`${root}?`) ||
      relative.startsWith(`${root}#`)
    ) {
      return relative
    }
  } catch {
    // Invalid or non-relative input fails closed to the current board root.
  }
  return root
}

export function buildBoardSearchHref({
  boardId,
  query,
  currentHref,
}: {
  boardId: string
  query: string
  currentHref: string
}): string {
  const params = new URLSearchParams()
  params.set('q', query.trim())
  params.set('returnTo', safeBoardReturnHref(boardId, currentHref))
  return `${boardRoot(boardId)}/search?${params.toString()}`
}

/** Every command is navigation-only. Admin chrome is omitted for member sessions. */
export function buildRbacSafeCommands(
  boardId: string,
  role: Role,
): Array<SafeCommand> {
  const root = boardRoot(boardId)
  const commands: Array<SafeCommand> = [
    {
      id: 'overview',
      label: 'Buka Ringkasan',
      description: 'Kembali ke gambaran program saat ini',
      href: root,
      keywords: 'overview ringkasan home program',
      access: 'authenticated',
    },
    {
      id: 'work',
      label: 'Buka Pekerjaan',
      description: 'Lihat lima bucket kerja dan filter aktif',
      href: `${root}/work`,
      keywords: 'work pekerjaan task tugas bucket filter',
      access: 'authenticated',
    },
    {
      id: 'priority',
      label: 'Buka Prioritas',
      description: 'Lihat portofolio prioritas dan kesiapan',
      href: `${root}/priority`,
      keywords: 'priority prioritas readiness kesiapan',
      access: 'authenticated',
    },
    {
      id: 'projects',
      label: 'Buka Proyek',
      description: 'Telusuri proyek pada board ini',
      href: `${root}/projects`,
      keywords: 'projects proyek struktur',
      access: 'authenticated',
    },
    {
      id: 'features',
      label: 'Buka Fitur / Alur',
      description: 'Telusuri fitur dan alur produk',
      href: `${root}/features`,
      keywords: 'features fitur flows alur',
      access: 'authenticated',
    },
    {
      id: 'agents',
      label: 'Buka Agen / Run',
      description: 'Lihat pekerjaan agen dan run aktif',
      href: `${root}/agents`,
      keywords: 'agents agen runs worker',
      access: 'authenticated',
    },
    {
      id: 'ops',
      label: 'Buka Operasi / Akun',
      description: 'Lihat status operasi dan akun yang diizinkan',
      href: `${root}/ops`,
      keywords: 'ops operasi accounts akun',
      access: 'authenticated',
    },
    {
      id: 'decisions',
      label: 'Buka Keputusan',
      description: 'Tinjau keputusan dan kebutuhan pemilik',
      href: `${root}/decisions`,
      keywords: 'decisions keputusan approval persetujuan',
      access: 'authenticated',
    },
    {
      id: 'evidence',
      label: 'Buka Bukti / Audit',
      description: 'Telusuri bukti dan riwayat audit',
      href: `${root}/evidence`,
      keywords: 'evidence bukti audit receipts',
      access: 'authenticated',
    },
  ]

  if (role === 'admin') {
    commands.push({
      id: 'admin-users',
      label: 'Kelola pengguna',
      description: 'Buka administrasi pengguna',
      href: '/admin/users',
      keywords: 'admin users pengguna role access',
      access: 'admin',
    })
  }

  return commands
}

function readRecentSearches(): Array<string> {
  if (typeof window === 'undefined') return []
  try {
    const value = JSON.parse(
      window.localStorage.getItem(RECENT_SEARCH_KEY) ?? '[]',
    )
    return Array.isArray(value)
      ? value
          .filter((item): item is string => typeof item === 'string')
          .slice(0, MAX_RECENT_SEARCHES)
      : []
  } catch {
    return []
  }
}

function writeRecentSearch(
  query: string,
  existing: Array<string>,
): Array<string> {
  const trimmed = query.trim()
  if (!trimmed) return existing
  const next = [trimmed, ...existing.filter((item) => item !== trimmed)].slice(
    0,
    MAX_RECENT_SEARCHES,
  )
  try {
    window.localStorage.setItem(RECENT_SEARCH_KEY, JSON.stringify(next))
  } catch {
    // Search remains available when storage is unavailable.
  }
  return next
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  return (
    target.isContentEditable ||
    target.tagName === 'INPUT' ||
    target.tagName === 'TEXTAREA' ||
    target.tagName === 'SELECT'
  )
}

export function CommandSearch({
  boardId,
  currentHref,
  role,
  onNavigate,
  commands: commandsProp,
}: CommandSearchProps) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const [recent, setRecent] = useState<Array<string>>([])
  const triggerRef = useRef<HTMLButtonElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const wasOpenRef = useRef(false)
  const commands = useMemo(
    () => commandsProp ?? buildRbacSafeCommands(boardId, role),
    [boardId, role, commandsProp],
  )

  useEffect(() => {
    setRecent(readRecentSearches())
  }, [])

  useEffect(() => {
    const onShortcut = (event: KeyboardEvent) => {
      const commandK =
        event.key.toLowerCase() === 'k' && (event.metaKey || event.ctrlKey)
      const slash =
        event.key === '/' && !event.metaKey && !event.ctrlKey && !event.altKey
      if (!commandK && (!slash || isEditableTarget(event.target))) return
      event.preventDefault()
      setOpen(true)
    }
    window.addEventListener('keydown', onShortcut)
    return () => window.removeEventListener('keydown', onShortcut)
  }, [])

  useEffect(() => {
    if (open) {
      wasOpenRef.current = true
      inputRef.current?.focus()
      return
    }
    if (wasOpenRef.current) {
      wasOpenRef.current = false
      triggerRef.current?.focus()
    }
  }, [open])

  const items = useMemo<Array<PaletteItem>>(() => {
    const normalized = query.trim().toLocaleLowerCase('id-ID')
    if (normalized) {
      const searchItem: PaletteItem = {
        id: 'search-query',
        label: `Cari “${query.trim()}”`,
        description:
          'Cari istilah manusia, sinonim, atau ID teknis pada board ini',
        href: buildBoardSearchHref({ boardId, query, currentHref }),
        keywords: query,
        access: 'authenticated',
        group: 'Cari',
        query: query.trim(),
      }
      const matches = commands
        .filter((command) =>
          `${command.label} ${command.description} ${command.keywords}`
            .toLocaleLowerCase('id-ID')
            .includes(normalized),
        )
        .map((command) => ({ ...command, group: 'Navigasi' as const }))
      return [searchItem, ...matches]
    }

    return [
      ...recent.map((item, index) => ({
        id: `recent-${index}`,
        label: item,
        description: 'Ulangi pencarian terakhir',
        href: buildBoardSearchHref({ boardId, query: item, currentHref }),
        keywords: item,
        access: 'authenticated' as const,
        group: 'Terbaru' as const,
        query: item,
      })),
      ...commands.map((command) => ({
        ...command,
        group: 'Navigasi' as const,
      })),
    ]
  }, [boardId, commands, currentHref, query, recent])

  useEffect(() => {
    setActiveIndex(0)
  }, [query, open])

  const close = () => {
    setOpen(false)
    setQuery('')
  }

  const activate = (item: PaletteItem | undefined) => {
    if (!item) return
    if (item.query)
      setRecent((current) => writeRecentSearch(item.query ?? '', current))
    close()
    if (onNavigate) onNavigate(item.href)
    else window.location.assign(item.href)
  }

  const onPaletteKeyDown = (event: ReactKeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      close()
    } else if (event.key === 'ArrowDown') {
      event.preventDefault()
      setActiveIndex((index) => (items.length ? (index + 1) % items.length : 0))
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setActiveIndex((index) =>
        items.length ? (index - 1 + items.length) % items.length : 0,
      )
    } else if (event.key === 'Enter') {
      event.preventDefault()
      activate(items[activeIndex])
    }
  }

  return (
    <div className="command-search" data-testid="command-search">
      <button
        ref={triggerRef}
        type="button"
        className="command-search-trigger"
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-keyshortcuts="/ Control+K Meta+K"
        data-testid="command-search-trigger"
      >
        <Icon name="search" />
        <span className="command-search-trigger-copy">
          <span>Cari pekerjaan, fitur, keputusan, atau bukti…</span>
          <small>Istilah Indonesia, English, atau ID teknis</small>
        </span>
        <kbd aria-hidden="true">/</kbd>
        <kbd aria-hidden="true">⌘K</kbd>
      </button>

      {open ? (
        <div
          className="command-palette-backdrop"
          data-testid="command-palette-backdrop"
        >
          <section
            className="command-palette"
            role="dialog"
            aria-modal="true"
            aria-labelledby="command-palette-title"
            onKeyDown={onPaletteKeyDown}
            data-testid="command-palette"
          >
            <div className="command-palette-head">
              <Icon name="search" />
              <label
                className="sr-only"
                htmlFor="command-palette-input"
                id="command-palette-title"
              >
                Cari dan jalankan perintah aman
              </label>
              <input
                id="command-palette-input"
                ref={inputRef}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                role="combobox"
                aria-expanded="true"
                aria-controls="command-palette-options"
                aria-activedescendant={
                  items[activeIndex]
                    ? `command-option-${items[activeIndex].id}`
                    : undefined
                }
                aria-autocomplete="list"
                autoComplete="off"
                placeholder="Cari pekerjaan atau ketik perintah…"
              />
              <button
                type="button"
                className="command-palette-close"
                onClick={close}
              >
                <span>Tutup</span>
                <kbd>Esc</kbd>
              </button>
            </div>

            <p className="command-palette-help" id="command-palette-help">
              Ketik istilah seperti “pembayaran affiliate” atau ID seperti
              “T-AFF-…”. Semua perintah hanya membuka halaman yang diizinkan
              untuk peran Anda.
            </p>

            <div
              className="command-palette-options"
              id="command-palette-options"
              role="listbox"
              aria-label="Hasil dan perintah"
            >
              {items.length ? (
                items.map((item, index) => {
                  const showGroup =
                    index === 0 || items[index - 1]?.group !== item.group
                  return (
                    <div className="command-palette-option-wrap" key={item.id}>
                      {showGroup ? (
                        <div className="command-palette-group">
                          {item.group}
                        </div>
                      ) : null}
                      <button
                        id={`command-option-${item.id}`}
                        type="button"
                        className={`command-palette-option ${index === activeIndex ? 'active' : ''}`}
                        role="option"
                        aria-selected={index === activeIndex}
                        onMouseEnter={() => setActiveIndex(index)}
                        onClick={() => activate(item)}
                        data-command-id={item.id}
                        data-access={item.access}
                      >
                        <span>
                          <strong>{item.label}</strong>
                          <small>{item.description}</small>
                        </span>
                        <span
                          className="command-palette-enter"
                          aria-hidden="true"
                        >
                          ↵
                        </span>
                      </button>
                    </div>
                  )
                })
              ) : (
                <p className="command-palette-empty" role="status">
                  Tidak ada perintah yang cocok. Tekan Enter untuk mencari
                  istilah ini.
                </p>
              )}
            </div>
          </section>
        </div>
      ) : null}
    </div>
  )
}
