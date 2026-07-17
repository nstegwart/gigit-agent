import { Badge } from '#/components/ui'
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
        className={styles.pinMeta}
        data-testid="work-pinned-revision"
        data-empty="true"
        title="Tidak ada revisi pin pada respons ini"
      >
        <Badge mono>pin —</Badge>
      </div>
    )
  }

  const shortHash =
    pinned.canonicalHash.length > 10
      ? `${pinned.canonicalHash.slice(0, 8)}…`
      : pinned.canonicalHash

  return (
    <div
      className={styles.pinMeta}
      data-testid="work-pinned-revision"
      title={`snapshot ${pinned.canonicalSnapshotId} · hash ${pinned.canonicalHash} · taskHash ${pinned.taskHash}`}
    >
      <Badge mono>
        rev b{pinned.boardRev}/L{pinned.lifecycleRev}
      </Badge>
      <Badge mono variant="neutral">
        {shortHash}
      </Badge>
    </div>
  )
}
