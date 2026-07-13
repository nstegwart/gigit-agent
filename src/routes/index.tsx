// Boards home (/) — Trello-style: pick a board (each = its own scope) or create one.
// Renders bare (no AppShell); the board layout /b/$boardId adds the sidebar chrome.
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Link, createFileRoute, redirect, useNavigate } from '@tanstack/react-router'
import { useState } from 'react'

import { boardsQueryOptions, useBoards, useCanEdit } from '#/lib/board-query'
import { csrfServerCall } from '#/lib/csrf-client'
import { BrandMark, Icon } from '#/lib/icons'
import { createBoardFn } from '#/server/board'
import { UserMenu } from '#/components/UserMenu'

export const Route = createFileRoute('/')({
  beforeLoad: ({ context }) => {
    if (!context.me) throw redirect({ to: '/login' })
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
            <div className="brand-name" style={{ fontSize: 18 }}>Cairn</div>
            <div className="brand-sub">Agent work board</div>
          </div>
        </div>
        <div className="home-head-actions">
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
        <p className="home-sub">Each board is its own scope — projects, features, agents, and history. Pick one to open.</p>

        {open && canEdit ? (
          <div className="card" style={{ padding: 16, marginBottom: 18 }}>
            <div className="comment-form">
              <input
                className="field"
                autoFocus
                placeholder="Board name — e.g. Rebuild, New features"
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && canCreate) create.mutate({ id, name }) }}
              />
              <button className="btn" disabled={!canCreate} onClick={() => create.mutate({ id, name })}>
                {create.isPending ? 'Creating…' : 'Create'}
              </button>
            </div>
            {name ? (
              <div style={{ fontSize: 12, color: taken ? 'var(--blocked)' : 'var(--text-faint)', marginTop: 8 }}>
                {taken ? `Board "${id}" already exists` : <>URL: <code>/b/{id}</code></>}
              </div>
            ) : null}
          </div>
        ) : null}

        <div className="board-grid">
          {boards.map((b) => (
            <Link key={b.id} to="/b/$boardId" params={{ boardId: b.id }} className="board-card">
              <div className="board-ico"><Icon name="board" size={20} /></div>
              <div className="board-name">{b.name}</div>
              {b.description ? <div className="board-desc">{b.description}</div> : null}
              <div className="board-meta"><code>/b/{b.id}</code></div>
            </Link>
          ))}
          {!boards.length ? (
            <div className="empty">
              {canEdit ? 'No boards yet — create one.' : 'No boards assigned yet. Ask an admin to give you access.'}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  )
}
