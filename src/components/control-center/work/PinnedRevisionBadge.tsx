import type { PinnedRevisionTuple } from '#/lib/control-plane-types'
import styles from './work.module.css'

export interface PinnedRevisionBadgeProps {
  pinned: PinnedRevisionTuple | null
}

/** Displays server-served pinned revision tuple — no client recompute. */
export function PinnedRevisionBadge({ pinned }: PinnedRevisionBadgeProps) {
  if (!pinned) {
    return (
      <div
        className={styles.pin}
        data-testid="work-pinned-revision"
        data-empty="true"
        title="No pinned revision on this response"
      >
        <span>pin</span>
        <strong>—</strong>
      </div>
    )
  }

  const shortHash =
    pinned.canonicalHash.length > 10
      ? `${pinned.canonicalHash.slice(0, 8)}…`
      : pinned.canonicalHash

  return (
    <div
      className={styles.pin}
      data-testid="work-pinned-revision"
      title={`snapshot ${pinned.canonicalSnapshotId} · hash ${pinned.canonicalHash} · taskHash ${pinned.taskHash}`}
    >
      <span>rev</span>
      <strong>
        b{pinned.boardRev}/L{pinned.lifecycleRev}
      </strong>
      <span aria-hidden="true">·</span>
      <span>{shortHash}</span>
    </div>
  )
}
