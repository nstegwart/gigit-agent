/**
 * Shell command/search behavior support evidence only. LOCAL ONLY; no rendered visual proof.
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
  buildBoardSearchHref,
  buildRbacSafeCommands,
  CommandSearch,
  safeBoardReturnHref,
} from '#/components/control-center/search/CommandSearch'
import {
  ControlCenterShellSearch,
  isControlCenterCompatibilitySearchPath,
  LegacyShellSearch,
} from '#/components/AppShell'
import { setSearch, uiStore } from '#/store/ui'

beforeEach(() => {
  window.localStorage.clear()
  setSearch('')
})

afterEach(() => {
  cleanup()
})

describe('control-center command palette', () => {
  it('opens from the generous trigger, slash, and platform command shortcut', () => {
    const { unmount } = render(
      <CommandSearch
        boardId="mfs-rebuild"
        currentHref="/b/mfs-rebuild/work"
        role="member"
      />,
    )
    const trigger = screen.getByTestId('command-search-trigger')
    expect(trigger.textContent).toContain(
      'Cari pekerjaan, fitur, keputusan, atau bukti',
    )
    expect(trigger.getAttribute('aria-keyshortcuts')).toBe('/ Control+K Meta+K')

    fireEvent.keyDown(window, { key: '/' })
    expect(screen.getByRole('dialog')).toBeTruthy()
    expect(document.activeElement).toBe(screen.getByRole('combobox'))
    unmount()

    render(
      <CommandSearch
        boardId="mfs-rebuild"
        currentHref="/b/mfs-rebuild/work"
        role="member"
      />,
    )
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true })
    expect(screen.getByRole('dialog')).toBeTruthy()
    cleanup()

    render(
      <CommandSearch
        boardId="mfs-rebuild"
        currentHref="/b/mfs-rebuild/work"
        role="member"
      />,
    )
    fireEvent.keyDown(window, { key: 'k', metaKey: true })
    expect(screen.getByRole('dialog')).toBeTruthy()
  })

  it('keeps the legacy shell input bound to the global search store', () => {
    const onSearchChange = vi.fn(setSearch)
    render(<LegacyShellSearch onSearchChange={onSearchChange} />)

    const input = screen.getByRole('textbox', {
      name: 'Search features and agents',
    }) as HTMLInputElement
    expect(input.placeholder).toBe('Search features, agents…')
    fireEvent.change(input, { target: { value: 'legacy agent filter' } })

    expect(onSearchChange).toHaveBeenCalledWith('legacy agent filter')
    expect(uiStore.state.search).toBe('legacy agent filter')
    expect(input.value).toBe('legacy agent filter')
  })

  it.each([
    ['activity log', '/log', { key: '/' }],
    ['task table', '/tasks', { key: 'k', ctrlKey: true }],
    ['project task table', '/projects/payments', { key: 'k', metaKey: true }],
  ] as const)(
    'bridges palette typing into uiStore on the authenticated control-center %s route',
    (_label, currentPath, shortcut) => {
      const value = `filter:${currentPath}`
      render(
        <ControlCenterShellSearch
          boardId="mfs-rebuild"
          currentHref={`/b/mfs-rebuild${currentPath}`}
          currentPath={currentPath}
          role="member"
        />,
      )

      expect(isControlCenterCompatibilitySearchPath(currentPath)).toBe(true)
      expect(
        screen
          .getByTestId('control-center-shell-search')
          .getAttribute('data-compatibility-producer'),
      ).toBe('true')
      expect(screen.queryByTestId('legacy-shell-search')).toBeNull()
      expect(screen.getAllByTestId('command-search-trigger')).toHaveLength(1)

      fireEvent.keyDown(window, shortcut)
      const input = screen.getByRole('combobox')
      expect(document.activeElement).toBe(input)
      fireEvent.change(input, { target: { value } })
      expect(uiStore.state.search).toBe(value)
    },
  )

  it('keeps unrelated control-center routes palette-only without a compatibility producer', () => {
    render(
      <ControlCenterShellSearch
        boardId="mfs-rebuild"
        currentHref="/b/mfs-rebuild/priority"
        currentPath="/priority"
        role="member"
      />,
    )

    expect(isControlCenterCompatibilitySearchPath('/priority')).toBe(false)
    expect(
      screen
        .getByTestId('control-center-shell-search')
        .getAttribute('data-compatibility-producer'),
    ).toBe('false')
    expect(screen.queryByTestId('legacy-shell-search')).toBeNull()
    expect(screen.getAllByTestId('command-search-trigger')).toHaveLength(1)

    fireEvent.click(screen.getByTestId('command-search-trigger'))
    fireEvent.change(screen.getByRole('combobox'), {
      target: { value: 'palette-only query' },
    })
    expect(uiStore.state.search).toBe('')
  })

  it('keeps compatibility store state synchronized across every palette close and reset path', () => {
    const onNavigate = vi.fn()
    const { rerender } = render(
      <ControlCenterShellSearch
        boardId="mfs-rebuild"
        currentHref="/b/mfs-rebuild/tasks"
        currentPath="/tasks"
        role="member"
        onNavigate={onNavigate}
      />,
    )
    const trigger = screen.getByTestId('command-search-trigger')

    fireEvent.click(trigger)
    let input = screen.getByRole('combobox') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'escape filter' } })
    expect(uiStore.state.search).toBe('escape filter')
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(uiStore.state.search).toBe('')
    expect(document.activeElement).toBe(trigger)

    fireEvent.click(trigger)
    input = screen.getByRole('combobox') as HTMLInputElement
    expect(input.value).toBe('')
    fireEvent.change(input, { target: { value: 'close button filter' } })
    expect(uiStore.state.search).toBe('close button filter')
    fireEvent.click(screen.getByRole('button', { name: /Tutup/ }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(uiStore.state.search).toBe('')

    fireEvent.click(trigger)
    input = screen.getByRole('combobox') as HTMLInputElement
    expect(input.value).toBe('')
    fireEvent.change(input, { target: { value: 'activation filter' } })
    expect(uiStore.state.search).toBe('activation filter')
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onNavigate).toHaveBeenCalledWith(
      buildBoardSearchHref({
        boardId: 'mfs-rebuild',
        query: 'activation filter',
        currentHref: '/b/mfs-rebuild/tasks',
      }),
    )
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(uiStore.state.search).toBe('')

    fireEvent.click(trigger)
    input = screen.getByRole('combobox') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'route change filter' } })
    expect(uiStore.state.search).toBe('route change filter')
    rerender(
      <ControlCenterShellSearch
        boardId="mfs-rebuild"
        currentHref="/b/mfs-rebuild/log"
        currentPath="/log"
        role="member"
        onNavigate={onNavigate}
      />,
    )
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(uiStore.state.search).toBe('')
  })

  it('does not steal slash while a human is typing in an editable field', () => {
    render(
      <>
        <input aria-label="Existing page filter" />
        <CommandSearch
          boardId="mfs-rebuild"
          currentHref="/b/mfs-rebuild/work"
          role="member"
        />
      </>,
    )
    fireEvent.keyDown(screen.getByLabelText('Existing page filter'), {
      key: '/',
    })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('supports arrow selection, Enter activation, Escape close, and focus return', () => {
    const onNavigate = vi.fn()
    render(
      <CommandSearch
        boardId="mfs-rebuild"
        currentHref="/b/mfs-rebuild/work?bucket=BLOCKED&revision=42"
        role="member"
        onNavigate={onNavigate}
      />,
    )
    const trigger = screen.getByTestId('command-search-trigger')
    fireEvent.click(trigger)
    const input = screen.getByRole('combobox')
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onNavigate).toHaveBeenCalledWith('/b/mfs-rebuild/work')
    expect(document.activeElement).toBe(trigger)

    fireEvent.click(trigger)
    const reopenedInput = screen.getByRole('combobox')
    fireEvent.keyDown(reopenedInput, { key: 'ArrowUp' })
    fireEvent.keyDown(reopenedInput, { key: 'Enter' })
    expect(onNavigate).toHaveBeenNthCalledWith(2, '/b/mfs-rebuild/evidence')
    expect(document.activeElement).toBe(trigger)

    fireEvent.click(trigger)
    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(trigger)
  })

  it('records and replays recent queries without losing route/filter/revision context', () => {
    const onNavigate = vi.fn()
    const currentHref =
      '/b/mfs-rebuild/work?bucket=ONGOING&overlay=STALE&revision=77'
    render(
      <CommandSearch
        boardId="mfs-rebuild"
        currentHref={currentHref}
        role="member"
        onNavigate={onNavigate}
      />,
    )
    fireEvent.click(screen.getByTestId('command-search-trigger'))
    const input = screen.getByRole('combobox')
    fireEvent.change(input, { target: { value: 'pembayaran affiliate' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onNavigate).toHaveBeenCalledWith(
      buildBoardSearchHref({
        boardId: 'mfs-rebuild',
        query: 'pembayaran affiliate',
        currentHref,
      }),
    )

    fireEvent.click(screen.getByTestId('command-search-trigger'))
    const listbox = screen.getByRole('listbox')
    expect(within(listbox).getByText('Terbaru')).toBeTruthy()
    expect(within(listbox).getByText('pembayaran affiliate')).toBeTruthy()
  })

  it('fails closed on cross-origin/cross-board return URLs and preserves same-board URLs exactly', () => {
    const sameBoard = '/b/mfs-rebuild/work?bucket=NEXT&revision=9#task-1'
    expect(safeBoardReturnHref('mfs-rebuild', sameBoard)).toBe(sameBoard)
    expect(
      safeBoardReturnHref(
        'mfs-rebuild',
        'https://evil.example/b/mfs-rebuild/work',
      ),
    ).toBe('/b/mfs-rebuild')
    expect(safeBoardReturnHref('mfs-rebuild', '/b/other/work?revision=9')).toBe(
      '/b/mfs-rebuild',
    )
  })

  it('exposes only read-only board navigation to members and gates admin chrome by role', () => {
    const member = buildRbacSafeCommands('mfs-rebuild', 'member')
    const admin = buildRbacSafeCommands('mfs-rebuild', 'admin')
    expect(member.every((command) => command.access === 'authenticated')).toBe(
      true,
    )
    expect(member.some((command) => command.href === '/admin/users')).toBe(
      false,
    )
    expect(
      admin.find((command) => command.href === '/admin/users')?.access,
    ).toBe('admin')
    expect(
      [...member, ...admin].some((command) =>
        /mutate|delete|deploy|approve/i.test(command.id),
      ),
    ).toBe(false)
  })
})
