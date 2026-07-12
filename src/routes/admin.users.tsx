// Admin-only: create accounts, assign which boards each member can see, reset
// passwords, promote/demote, delete. Renders bare with a back link to the boards.
import { Link, createFileRoute, redirect } from '@tanstack/react-router'
import { useState } from 'react'

import {
  boardsQueryOptions,
  useBoards,
  useCreateUser,
  useDeleteUser,
  useResetPassword,
  useSetUserBoards,
  useSetUserRole,
  useUsers,
  usersQueryOptions,
} from '#/lib/board-query'
import { BrandMark, Icon } from '#/lib/icons'
import { fmtDate } from '#/lib/format'
import type { Role, UserRow } from '#/lib/types'

export const Route = createFileRoute('/admin/users')({
  beforeLoad: ({ context }) => {
    if (!context.me) throw redirect({ to: '/login' })
    if (context.me.role !== 'admin') throw redirect({ to: '/' })
  },
  loader: async ({ context }) => {
    await Promise.all([
      context.queryClient.ensureQueryData(usersQueryOptions()),
      context.queryClient.ensureQueryData(boardsQueryOptions()),
    ])
  },
  component: AdminUsers,
})

function AdminUsers() {
  const users = useUsers()
  const boards = useBoards()

  return (
    <div className="home">
      <header className="home-head">
        <Link to="/" className="brand" title="All boards">
          <BrandMark size={34} />
          <div>
            <div className="brand-name" style={{ fontSize: 18 }}>Cairn</div>
            <div className="brand-sub">User management</div>
          </div>
        </Link>
        <Link to="/" className="btn btn-ghost"><Icon name="chevL" size={14} /> Boards</Link>
      </header>

      <div className="home-wrap">
        <h1 className="home-title">Users</h1>
        <p className="home-sub">Create accounts and choose which boards each person can see. Members are read-only.</p>

        <CreateUser boards={boards} />

        <div className="users-list">
          {users.map((u) => (
            <UserCard key={u.id} user={u} boards={boards} />
          ))}
        </div>
      </div>
    </div>
  )
}

function CreateUser({ boards }: { boards: Array<{ id: string; name: string }> }) {
  const create = useCreateUser()
  const [open, setOpen] = useState(false)
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [role, setRole] = useState<Role>('member')
  const [picked, setPicked] = useState<Array<string>>([])
  const [err, setErr] = useState<string | null>(null)

  const canCreate = username.trim().length > 0 && password.length >= 6 && !create.isPending
  const submit = () => {
    setErr(null)
    create.mutate(
      { username: username.trim(), password, role, boards: role === 'member' ? picked : [] },
      {
        onSuccess: () => {
          setUsername(''); setPassword(''); setRole('member'); setPicked([]); setOpen(false)
        },
        onError: (e) => setErr(e instanceof Error ? e.message : String(e)),
      },
    )
  }

  if (!open) {
    return (
      <button className="btn btn-primary" style={{ marginBottom: 18 }} onClick={() => setOpen(true)}>
        <Icon name="users" size={15} /> New user
      </button>
    )
  }
  return (
    <div className="card user-create">
      <div className="user-create-grid">
        <label className="auth-label">Username
          <input className="field" autoFocus value={username} onChange={(e) => setUsername(e.target.value)} />
        </label>
        <label className="auth-label">Password
          <input className="field" type="text" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="min 6 chars" />
        </label>
        <label className="auth-label">Role
          <select className="field" value={role} onChange={(e) => setRole(e.target.value as Role)}>
            <option value="member">Member (read-only)</option>
            <option value="admin">Admin (full access)</option>
          </select>
        </label>
      </div>
      {role === 'member' ? (
        <div className="user-boards">
          <div className="user-boards-label">Boards this member can see</div>
          <div className="chip-picker">
            {boards.map((b) => {
              const on = picked.includes(b.id)
              return (
                <button
                  key={b.id}
                  type="button"
                  className={`chip-toggle ${on ? 'on' : ''}`}
                  onClick={() => setPicked((p) => (on ? p.filter((x) => x !== b.id) : [...p, b.id]))}
                >
                  {on ? <Icon name="check" size={11} /> : null} {b.name}
                </button>
              )
            })}
            {!boards.length ? <span className="desc">No boards yet.</span> : null}
          </div>
        </div>
      ) : (
        <div className="desc" style={{ marginTop: 8 }}>Admins see every board and manage users.</div>
      )}
      {err ? <div className="auth-err">{err}</div> : null}
      <div className="user-create-actions">
        <button className="btn btn-ghost" onClick={() => setOpen(false)}>Cancel</button>
        <button className="btn btn-primary" disabled={!canCreate} onClick={submit}>
          {create.isPending ? 'Creating…' : 'Create user'}
        </button>
      </div>
    </div>
  )
}

function UserCard({ user, boards }: { user: UserRow; boards: Array<{ id: string; name: string }> }) {
  const setBoards = useSetUserBoards()
  const setRole = useSetUserRole()
  const del = useDeleteUser()
  const reset = useResetPassword()
  const [editing, setEditing] = useState(false)
  const [pw, setPw] = useState('')
  const [msg, setMsg] = useState<string | null>(null)

  const toggleBoard = (id: string) => {
    const has = user.boards.includes(id)
    setBoards.mutate({ userId: user.id, boards: has ? user.boards.filter((b) => b !== id) : [...user.boards, id] })
  }

  return (
    <div className="card user-card">
      <div className="user-card-head">
        <span className="usermenu-avatar lg">{user.username.charAt(0).toUpperCase()}</span>
        <div className="user-card-id">
          <div className="user-card-name">{user.username}</div>
          <div className="desc">joined {fmtDate(user.createdAt)}</div>
        </div>
        <span className={`chip ${user.role === 'admin' ? 'chip-admin' : 'chip-member'}`}>{user.role}</span>
        <div className="topbar-spacer" />
        <button
          className="btn btn-ghost btn-sm"
          onClick={() => setRole.mutate({ userId: user.id, role: user.role === 'admin' ? 'member' : 'admin' })}
        >
          {user.role === 'admin' ? 'Make member' : 'Make admin'}
        </button>
        <button className="btn btn-ghost btn-sm" onClick={() => setEditing((v) => !v)}>Password</button>
        <button
          className="btn btn-danger btn-sm"
          onClick={() => {
            if (confirm(`Delete user "${user.username}"? This cannot be undone.`)) del.mutate({ userId: user.id })
          }}
        >
          Delete
        </button>
      </div>

      {editing ? (
        <div className="user-pw-row">
          <input className="field" type="text" placeholder="new password (min 6)" value={pw} onChange={(e) => setPw(e.target.value)} />
          <button
            className="btn"
            disabled={pw.length < 6 || reset.isPending}
            onClick={() =>
              reset.mutate({ userId: user.id, password: pw }, { onSuccess: () => { setPw(''); setEditing(false); setMsg('Password updated — the user must sign in again.') } })
            }
          >
            Set password
          </button>
        </div>
      ) : null}
      {msg ? <div className="desc" style={{ marginTop: 6 }}>{msg}</div> : null}

      {user.role === 'admin' ? (
        <div className="desc" style={{ marginTop: 10 }}>Sees every board.</div>
      ) : (
        <div className="user-boards">
          <div className="user-boards-label">Can see</div>
          <div className="chip-picker">
            {boards.map((b) => {
              const on = user.boards.includes(b.id)
              return (
                <button key={b.id} type="button" className={`chip-toggle ${on ? 'on' : ''}`} onClick={() => toggleBoard(b.id)}>
                  {on ? <Icon name="check" size={11} /> : null} {b.name}
                </button>
              )
            })}
            {!boards.length ? <span className="desc">No boards yet.</span> : null}
          </div>
        </div>
      )}
    </div>
  )
}
