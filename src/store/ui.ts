// Global UI state (theme + search) via TanStack Store.
import { Store } from '@tanstack/store'

export type ThemeMode = 'auto' | 'light' | 'dark'

export interface UiState {
  theme: ThemeMode
  search: string
}

export const uiStore = new Store<UiState>({ theme: 'auto', search: '' })

export function setSearch(q: string) {
  uiStore.setState((s) => ({ ...s, search: q }))
}

export function setTheme(t: ThemeMode) {
  uiStore.setState((s) => ({ ...s, theme: t }))
  applyTheme(t)
}

/** Reflect the theme onto <html data-theme> + persist. Safe to call on client only. */
export function applyTheme(t: ThemeMode) {
  if (typeof document === 'undefined') return
  const root = document.documentElement
  if (t === 'auto') root.removeAttribute('data-theme')
  else root.setAttribute('data-theme', t)
  try {
    localStorage.setItem('cairn-theme', t)
  } catch {
    /* ignore */
  }
}

export function resolvedIsDark(): boolean {
  if (typeof document === 'undefined') return true
  const attr = document.documentElement.getAttribute('data-theme')
  if (attr === 'dark') return true
  if (attr === 'light') return false
  return window.matchMedia('(prefers-color-scheme: dark)').matches
}

/** Read persisted theme on boot. */
export function initTheme(): ThemeMode {
  if (typeof window === 'undefined') return 'auto'
  let saved: string | null = null
  try {
    saved = localStorage.getItem('cairn-theme')
  } catch {
    /* ignore */
  }
  const url =
    typeof location !== 'undefined'
      ? new URLSearchParams(location.search).get('theme')
      : null
  const t = (url === 'dark' || url === 'light' ? url : saved) as ThemeMode | null
  const mode: ThemeMode = t === 'dark' || t === 'light' || t === 'auto' ? t : 'auto'
  uiStore.setState((s) => ({ ...s, theme: mode }))
  applyTheme(mode)
  return mode
}
