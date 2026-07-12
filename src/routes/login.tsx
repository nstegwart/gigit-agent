// Login (public). Redirects in when already signed in. When the instance has zero
// users it flips to a one-time "create the first admin" setup.
import { createFileRoute, redirect, useNavigate } from '@tanstack/react-router'
import { useState } from 'react'

import { useBootstrap, useLogin } from '#/lib/board-query'
import { BrandMark } from '#/lib/icons'
import { needsSetupFn } from '#/server/auth-fns'

export const Route = createFileRoute('/login')({
  beforeLoad: ({ context }) => {
    if (context.me) throw redirect({ to: '/' })
  },
  loader: async () => ({ needsSetup: await needsSetupFn() }),
  component: LoginPage,
})

function LoginPage() {
  const { needsSetup } = Route.useLoaderData()
  const nav = useNavigate()
  const login = useLogin()
  const bootstrap = useBootstrap()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [err, setErr] = useState<string | null>(null)

  const busy = login.isPending || bootstrap.isPending
  const submit = () => {
    setErr(null)
    const onError = (e: unknown) => setErr(e instanceof Error ? e.message : String(e))
    const onSuccess = () => nav({ to: '/' })
    if (needsSetup) bootstrap.mutate({ username, password }, { onError, onSuccess })
    else login.mutate({ username, password }, { onError, onSuccess })
  }
  const canSubmit = username.trim().length > 0 && password.length > 0 && (!needsSetup || password.length >= 6) && !busy

  return (
    <div className="auth-page">
      <div className="auth-card">
        <div className="auth-brand">
          <BrandMark size={40} />
          <div>
            <div className="brand-name" style={{ fontSize: 20 }}>Cairn</div>
            <div className="brand-sub">Agent work board</div>
          </div>
        </div>

        <h1 className="auth-title">{needsSetup ? 'Create the first admin' : 'Sign in'}</h1>
        <p className="auth-sub">
          {needsSetup
            ? 'This board has no accounts yet. Set up the admin — you can add teammates afterwards.'
            : 'Enter your account to continue.'}
        </p>

        <form
          className="auth-form"
          onSubmit={(e) => {
            e.preventDefault()
            if (canSubmit) submit()
          }}
        >
          <label className="auth-label">
            Username
            <input
              className="field"
              autoFocus
              autoComplete="username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
            />
          </label>
          <label className="auth-label">
            Password
            <input
              className="field"
              type="password"
              autoComplete={needsSetup ? 'new-password' : 'current-password'}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </label>
          {needsSetup ? <div className="auth-hint">Minimum 6 characters.</div> : null}
          {err ? <div className="auth-err">{err}</div> : null}
          <button className="btn btn-primary auth-submit" type="submit" disabled={!canSubmit}>
            {busy ? 'Please wait…' : needsSetup ? 'Create admin & sign in' : 'Sign in'}
          </button>
        </form>
      </div>
    </div>
  )
}
