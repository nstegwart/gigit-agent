/**
 * Canon control-center AppShell nav + palette contract (LOCAL ONLY).
 * For isControlCenterBoard boards, chrome advertises Alur + Ops only among
 * board product destinations; classic NAV unchanged; admin cmd gated by role.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import {
  buildControlCenterCanonCommands,
  CONTROL_CENTER_CANON_NAV_IDS,
  CONTROL_CENTER_NAV,
  CONTROL_CENTER_NAV_LABELS_ID,
  ControlCenterShellSearch,
} from '#/components/AppShell'
import { isControlCenterBoard } from '#/lib/control-center-query'

const root = join(dirname(fileURLToPath(import.meta.url)), '../..')
const appShellSrc = readFileSync(join(root, 'src/components/AppShell.tsx'), 'utf8')

/** Demoted multi-page product IA — must not appear as CC nav destinations. */
const DEMOTED_NAV_HREFS = [
  '/',
  '/rebuild',
  '/work',
  '/priority',
  '/projects',
  '/fitur',
  '/features',
  '/tasks',
  '/map',
  '/agents',
  '/evidence',
  '/decisions',
  '/design',
  '/log',
  '/search',
  '/knowledge',
  '/documentation',
] as const

const DEMOTED_NAV_IDS = [
  'overview',
  'rebuild',
  'work',
  'priority',
  'projects',
  'features',
  'tasks',
  'map',
  'agents',
  'evidence',
  'decisions',
  'design',
  'log',
  'search',
  'knowledge',
  'documentation',
] as const

function sliceControlCenterNavBody(src: string): string {
  const start = src.indexOf('export const CONTROL_CENTER_NAV:')
  const end = src.indexOf('const SECTION_TITLE:')
  expect(start).toBeGreaterThan(-1)
  expect(end).toBeGreaterThan(start)
  return src.slice(start, end)
}

function sliceClassicNavBody(src: string): string {
  const start = src.indexOf('const NAV:')
  const end = src.indexOf('export const CONTROL_CENTER_NAV_LABELS')
  expect(start).toBeGreaterThan(-1)
  expect(end).toBeGreaterThan(start)
  return src.slice(start, end)
}

afterEach(() => {
  cleanup()
})

describe('canon CC AppShell nav contract — source', () => {
  it('CONTROL_CENTER_NAV is Alur + Ops only (product destinations)', () => {
    const items = CONTROL_CENTER_NAV.filter(
      (n): n is Exclude<typeof n, { sep: true; label: string }> => !('sep' in n),
    )
    expect(items.map((n) => n.id)).toEqual(['alur', 'ops'])
    expect([...CONTROL_CENTER_CANON_NAV_IDS]).toEqual(['alur', 'ops'])
    expect(items.map((n) => n.to)).toEqual(['/alur', '/ops'])
    for (const item of items) {
      expect(DEMOTED_NAV_HREFS).not.toContain(item.to)
      expect(DEMOTED_NAV_IDS).not.toContain(item.id)
    }
  })

  it('CONTROL_CENTER_NAV source body has no demoted hrefs or ids', () => {
    const body = sliceControlCenterNavBody(appShellSrc)
    for (const href of DEMOTED_NAV_HREFS) {
      if (href === '/') continue // root may appear only outside nav items
      expect(body).not.toMatch(new RegExp(`to:\\s*'${href.replace(/\//g, '\\/')}'`))
    }
    // Explicit demoted product paths forbidden as BoardLink targets
    for (const forbidden of [
      "to: '/rebuild'",
      "to: '/work'",
      "to: '/priority'",
      "to: '/projects'",
      "to: '/fitur'",
      "to: '/features'",
      "to: '/tasks'",
      "to: '/map'",
      "to: '/agents'",
      "to: '/evidence'",
      "to: '/decisions'",
      "to: '/design'",
      "to: '/log'",
      "to: '/search'",
      "to: '/'",
    ]) {
      expect(body).not.toContain(forbidden)
    }
    for (const id of DEMOTED_NAV_IDS) {
      expect(body).not.toMatch(new RegExp(`id:\\s*'${id}'`))
    }
    expect(body).toMatch(/id:\s*'alur'/)
    expect(body).toMatch(/id:\s*'ops'/)
    expect(body).toMatch(/to:\s*'\/alur'/)
    expect(body).toMatch(/to:\s*'\/ops'/)
  })

  it('classic NAV retains full multi-page product IA unchanged', () => {
    const classic = sliceClassicNavBody(appShellSrc)
    for (const id of [
      'board',
      'agents',
      'projects',
      'features',
      'tasks',
      'map',
      'alur',
      'design',
      'decisions',
      'log',
      'ops',
    ]) {
      expect(classic).toContain(`id: '${id}'`)
    }
    expect(classic).toContain("to: '/projects'")
    expect(classic).toContain("to: '/features'")
    expect(classic).toContain("to: '/tasks'")
    expect(classic).toContain("to: '/map'")
    expect(classic).toContain("to: '/design'")
    expect(classic).toContain("to: '/decisions'")
    expect(classic).toContain("to: '/log'")
  })

  it('board picker escape hatch remains in AppShell switcher', () => {
    expect(appShellSrc).toContain('href="/?boards=1"')
    expect(appShellSrc).toMatch(/All boards/)
  })

  it('CC boards still selected via isControlCenterBoard (not hard-coded only in nav)', () => {
    expect(isControlCenterBoard('mfs-rebuild')).toBe(true)
    expect(isControlCenterBoard('demo')).toBe(false)
    expect(appShellSrc).toMatch(/isControlCenterBoard\(boardId\)/)
    expect(appShellSrc).toMatch(/controlCenter \? CONTROL_CENTER_NAV : NAV/)
  })

  it('id-ID map still covers living Alur + Ops labels', () => {
    expect(CONTROL_CENTER_NAV_LABELS_ID.Alur).toBe('Alur')
    expect(CONTROL_CENTER_NAV_LABELS_ID['Ops / Accounts']).toBe('Operasi')
  })
})

describe('canon CC AppShell palette contract — commands', () => {
  it('member palette has Alur + Ops only among board product destinations', () => {
    const member = buildControlCenterCanonCommands('mfs-rebuild', 'member')
    expect(member.map((c) => c.id)).toEqual(['alur', 'ops'])
    expect(member.every((c) => c.access === 'authenticated')).toBe(true)
    expect(member.some((c) => c.href === '/admin/users')).toBe(false)
    for (const cmd of member) {
      expect(cmd.href).toMatch(/^\/b\/mfs-rebuild\/(alur|ops)$/)
    }
    const hrefs = member.map((c) => c.href).join('\n')
    for (const demoted of [
      '/work',
      '/priority',
      '/projects',
      '/features',
      '/fitur',
      '/rebuild',
      '/agents',
      '/evidence',
      '/decisions',
      '/design',
      '/log',
      '/search',
      '/tasks',
      '/map',
    ]) {
      expect(hrefs).not.toContain(demoted)
    }
  })

  it('admin palette keeps Kelola pengguna and does not add demoted product IA', () => {
    const admin = buildControlCenterCanonCommands('mfs-rebuild', 'admin')
    expect(admin.map((c) => c.id)).toEqual(['alur', 'ops', 'admin-users'])
    const adminCmd = admin.find((c) => c.id === 'admin-users')
    expect(adminCmd?.href).toBe('/admin/users')
    expect(adminCmd?.access).toBe('admin')
    expect(admin.some((c) => /work|priority|projects|agents|evidence|decisions/i.test(c.id))).toBe(
      false,
    )
  })
})

describe('canon CC AppShell palette contract — unit render', () => {
  it('ControlCenterShellSearch palette lists Alur+Ops only for members', () => {
    render(
      <ControlCenterShellSearch
        boardId="mfs-rebuild"
        currentHref="/b/mfs-rebuild/ops"
        currentPath="/ops"
        role="member"
      />,
    )
    fireEvent.click(screen.getByTestId('command-search-trigger'))
    const listbox = screen.getByRole('listbox')
    const commandButtons = within(listbox).getAllByRole('option')
    const navCommandIds = commandButtons
      .map((el) => el.getAttribute('data-command-id') ?? '')
      .filter((id) => id && !id.startsWith('recent-') && id !== 'search-query')
    expect(navCommandIds).toEqual(['alur', 'ops'])
    expect(within(listbox).queryByText(/Buka Pekerjaan|Buka Prioritas|Buka Proyek|Buka Agen|Buka Keputusan|Buka Bukti|Buka Ringkasan/i)).toBeNull()
    expect(within(listbox).getByText('Buka Alur')).toBeTruthy()
    expect(within(listbox).getByText('Buka Operasi / Akun')).toBeTruthy()
  })

  it('ControlCenterShellSearch admin session includes Kelola pengguna', () => {
    render(
      <ControlCenterShellSearch
        boardId="mfs-rebuild"
        currentHref="/b/mfs-rebuild/ops"
        currentPath="/ops"
        role="admin"
      />,
    )
    fireEvent.click(screen.getByTestId('command-search-trigger'))
    const listbox = screen.getByRole('listbox')
    const navCommandIds = within(listbox)
      .getAllByRole('option')
      .map((el) => el.getAttribute('data-command-id') ?? '')
      .filter((id) => id && !id.startsWith('recent-') && id !== 'search-query')
    expect(navCommandIds).toEqual(['alur', 'ops', 'admin-users'])
    expect(within(listbox).getByText('Kelola pengguna')).toBeTruthy()
  })
})
