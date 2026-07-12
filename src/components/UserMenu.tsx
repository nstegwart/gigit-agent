// Signed-in human chip: username + role, admin → Users link, and sign out.
import { Link, useNavigate } from '@tanstack/react-router'
import { useState } from 'react'

import { useLogout, useMe } from '#/lib/board-query'
import { Icon } from '#/lib/icons'

export function UserMenu() {
  const me = useMe()
  const logout = useLogout()
  const nav = useNavigate()
  const [open, setOpen] = useState(false)
  if (!me) return null
  const initial = me.username.charAt(0).toUpperCase()

  return (
    <div className="usermenu">
      <button className="usermenu-btn" onClick={() => setOpen((v) => !v)} aria-haspopup="menu" aria-expanded={open}>
        <span className="usermenu-avatar">{initial}</span>
        <span className="usermenu-name">{me.username}</span>
        <span className={`chip ${me.role === 'admin' ? 'chip-admin' : 'chip-member'}`}>{me.role}</span>
        <Icon name="chevL" size={13} className="switcher-caret" />
      </button>
      {open ? (
        <div className="usermenu-pop" role="menu">
          {me.role === 'admin' ? (
            <Link to="/admin/users" className="usermenu-item" onClick={() => setOpen(false)}>
              <Icon name="users" size={15} /> Manage users
            </Link>
          ) : null}
          <button
            className="usermenu-item"
            onClick={() => {
              setOpen(false)
              logout.mutate(undefined, { onSuccess: () => nav({ to: '/login' }) })
            }}
          >
            <Icon name="log" size={15} /> Sign out
          </button>
        </div>
      ) : null}
    </div>
  )
}
