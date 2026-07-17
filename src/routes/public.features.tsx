/**
 * Public features layout — unauthenticated surface (Outlet only).
 * Direction B: content column max 1280, token padding only.
 */
import { Outlet, createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/public/features')({
  component: PublicFeaturesLayout,
})

function PublicFeaturesLayout() {
  return (
    <div
      className="wrap content-inner"
      style={{
        padding: 'var(--sp-5) var(--sp-4)',
        minHeight: '100vh',
        background: 'var(--bg)',
        color: 'var(--text)',
      }}
    >
      <Outlet />
    </div>
  )
}
