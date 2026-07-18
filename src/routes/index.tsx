// Root (/) — canon-v3 primary: default human control center = mfs-rebuild Alur (Flow Ultimate).
// Board picker preserved at /?boards=1 (ops escape hatch; still reaches all boards).
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Link, createFileRoute, redirect, useNavigate } from '@tanstack/react-router'
import { useState } from 'react'

import { boardsQueryOptions, useBoards, useCanEdit } from '#/lib/board-query'
import { csrfServerCall } from '#/lib/csrf-client'
import { BrandMark, Icon } from '#/lib/icons'
import { DEFAULT_CONTROL_CENTER_BOARD_ID } from '#/lib/control-center-default-board'
import { createBoardFn } from '#/server/board'
import { UserMenu } from '#/components/UserMenu'

/** True when `/` should render the board picker instead of redirecting to primary Alur. */
export function wantsBoardPicker(search: unknown): boolean {
  if (!search || typeof search !== 'object' || Array.isArray(search)) return false
  const boards = (search as Record<string, unknown>).boards
  return boards === '1' || boards === 1 || boards === true || boards === 'true'
}

export const Route = createFileRoute('/')({
  beforeLoad: ({ context, location }) => {
    if (!context.me) throw redirect({ to: '/login' })
    // Canon-v3 default: control-center Alur canvas unless explicit board picker (?boards=1).
    if (!wantsBoardPicker(location.search)) {
      throw redirect({
        to: '/b/$boardId/alur',
        params: { boardId: DEFAULT_CONTROL_CENTER_BOARD_ID },
      })
    }
  },
  loader: async ({ context }) => {
    await context.queryClient.ensureQueryData(boardsQueryOptions())
  },
  component: Home,
})

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
}

function Home() {
  const boards = useBoards()
  const canEdit = useCanEdit()
  const qc = useQueryClient()
  const nav = useNavigate()
  const [name, setName] = useState('')
  const [open, setOpen] = useState(false)

  const create = useMutation({
    mutationFn: (v: { id: string; name: string }) => csrfServerCall(createBoardFn, v),
    onSuccess: (_res, v) => {
      qc.invalidateQueries({ queryKey: ['boards'] })
      nav({ to: '/b/$boardId', params: { boardId: v.id } })
    },
  })

  const id = slugify(name)
  const taken = boards.some((b) => b.id === id)
  const canCreate = id.length > 0 && !taken && !create.isPending

  return (
    <div className="home">
      <header className="home-head">
        <div className="brand">
          <BrandMark size={34} />
          <div>
            <div className="brand-name" style={{ fontSize: 18 }}>
              Cairn
            </div>
            <div className="brand-sub">Agent work board</div>
          </div>
        </div>
        <div className="home-head-actions">
          <Link
            to="/b/$boardId"
            params={{ boardId: DEFAULT_CONTROL_CENTER_BOARD_ID }}
            className="btn"
          >
            Control center
          </Link>
          {canEdit ? (
            <button className="btn" onClick={() => setOpen((v) => !v)}>
              <Icon name="board" /> New board
            </button>
          ) : null}
          <UserMenu />
        </div>
      </header>

      <div className="home-wrap">
        <h1 className="home-title">Boards</h1>
        <p className="home-sub">
          Each board is its own scope — projects, features, agents, and history. Pick one to
          open. Default control center is <code>{DEFAULT_CONTROL_CENTER_BOARD_ID}</code>.
        </p>

        {open && canEdit ? (
          <div className="card" style={{ padding: 16, marginBottom: 18 }}>
            <div className="comment-form">
              <input
                className="field"
                autoFocus
                placeholder="Board name — e.g. Rebuild, New features"
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && canCreate) create.mutate({ id, name })
                }}
              />
              <button
                className="btn"
                disabled={!canCreate}
                onClick={() => create.mutate({ id, name })}
              >
                {create.isPending ? 'Creating…' : 'Create'}
              </button>
            </div>
            {name ? (
              <div
                style={{
                  fontSize: 12,
                  color: taken ? 'var(--blocked)' : 'var(--text-faint)',
                  marginTop: 8,
                }}
              >
                {taken ? (
                  `Board "${id}" already exists`
                ) : (
                  <>
                    URL: <code>/b/{id}</code>
                  </>
                )}
              </div>
            ) : null}
          </div>
        ) : null}

        <div className="board-grid">
          {boards.map((b) => (
            <Link key={b.id} to="/b/$boardId" params={{ boardId: b.id }} className="board-card">
              <div className="board-ico">
                <Icon name="board" size={20} />
              </div>
              <div className="board-name">{b.name}</div>
              {b.description ? <div className="board-desc">{b.description}</div> : null}
              <div className="board-meta">
                <code>/b/{b.id}</code>
              </div>
            </Link>
          ))}
          {!boards.length ? (
            <div className="empty">
              {canEdit
                ? 'No boards yet — create one.'
                : 'No boards assigned yet. Ask an admin to give you access.'}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  )
}
