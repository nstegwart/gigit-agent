/**
 * Public features layout — unauthenticated surface (Outlet only).
 */
import { Outlet, createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/public/features')({
  component: PublicFeaturesLayout,
})

function PublicFeaturesLayout() {
  return <Outlet />
}
