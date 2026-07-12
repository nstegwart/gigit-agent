// Shown while a route's loader/queries are in flight — so navigation never blanks out.
export function PageLoading() {
  return (
    <div className="page-loading" role="status" aria-live="polite">
      <span className="spinner" />
      <span className="page-loading-txt">Loading…</span>
    </div>
  )
}
