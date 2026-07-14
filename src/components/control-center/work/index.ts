/** Control-center Work components (C3-F3) — prop-driven, no route/query wiring. */

export { BucketTabs } from './BucketTabs'
export type { BucketTabsProps } from './BucketTabs'

export { StaleOverlayFilter } from './StaleOverlayFilter'
export type { StaleOverlayFilterProps } from './StaleOverlayFilter'

export { PinnedRevisionBadge } from './PinnedRevisionBadge'
export type { PinnedRevisionBadgeProps } from './PinnedRevisionBadge'

export { WorkPagination } from './WorkPagination'
export type { WorkPaginationProps } from './WorkPagination'

export { WorkRow } from './WorkRow'
export type { WorkRowProps } from './WorkRow'

export { OwnerHumanFields } from './OwnerHumanFields'
export { resolveOwnerDisplay } from './ownerDisplay'
export type {
  OwnerDisplayCitation,
  OwnerDisplayInput,
  OwnerDisplayResolved,
} from './ownerDisplay'

export { WorkList } from './WorkList'
export type { WorkListProps } from './WorkList'

export { WorkStates, WorkLoadingState, WorkEmptyState } from './WorkStates'
export type { WorkStatesProps } from './WorkStates'

export { WorkScreen } from './WorkScreen'

export {
  parseWorkDeepLink,
  encodeWorkDeepLink,
  workDeepLinkPath,
  isPrimaryBucket,
  normalizeWorkBucketToken,
} from './deepLink'
export type { WorkSearchParamsLike } from './deepLink'

export {
  WORK_PRIMARY_BUCKETS,
} from './types'
export type {
  WorkSurfaceState,
  WorkRunLiveness,
  WorkReconciliationDisplay,
  WorkOngoingDisplay,
  WorkItemRow,
  WorkOwnerHumanFields,
  WorkOwnerCitation,
  WorkPageState,
  WorkDeepLinkFilters,
  WorkBucketCounts,
  WorkStaleOverlaySummary,
  WorkScreenError,
  WorkScreenProps,
  PrimaryBucket,
  StaleOverlayKind,
  BlockReasonCode,
  PinnedRevisionTuple,
} from './types'

export {
  BUCKET_SEMANTICS,
  OVERLAY_LABELS,
  STALE_FAMILY_OVERLAYS,
  formatAgeSeconds,
  livenessLabel,
} from './labels'
