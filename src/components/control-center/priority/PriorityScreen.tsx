import {
  Badge,
  Breadcrumb,
  Card,
  Disclosure,
  PageHeader,
  StatusChip,
  Tabs,
} from '#/components/ui'
import { NonPriorityReasonsPanel } from './NonPriorityReasonsPanel'
import { PriorityCapacityPanel } from './PriorityCapacityPanel'
import { PriorityDenominatorsPanel } from './PriorityDenominatorsPanel'
import { PriorityG5Panel } from './PriorityG5Panel'
import { PriorityMembershipPanel } from './PriorityMembershipPanel'
import { PriorityReadinessPanel } from './PriorityReadinessPanel'
import { PriorityStateShell } from './PriorityStateShell'
import { humanPortfolioLabel } from './display'
import { PRIORITY_PORTFOLIO_ID } from './constants'
import type { PriorityScreenProps } from './types'
import styles from './priority.module.css'

/**
 * Prop-driven SALES_WEB_RELATED_BACKEND Priority screen.
 * Composes membership, DISTINCT rollups, readiness/cappedBy, G5, capacity/majority,
 * and non-priority allowlist panels. No fetch, no allocation/readiness recompute.
 * Presentation: Direction B kit only (UI_KIT.md).
 */
export function PriorityScreen({
  uiState,
  pin,
  membership,
  denominators,
  readiness,
  g5,
  capacity,
  nonPriorityReasons,
  errorCode,
  errorMessage,
  onRetry,
  liveMessage,
}: PriorityScreenProps) {
  const showBody =
    uiState === 'populated' ||
    uiState === 'partial' ||
    uiState === 'stale' ||
    uiState === 'needs-human'

  const portfolioHuman = humanPortfolioLabel(PRIORITY_PORTFOLIO_ID)

  return (
    <PriorityStateShell
      uiState={uiState}
      errorCode={errorCode}
      errorMessage={errorMessage}
      onRetry={onRetry}
      liveMessage={liveMessage}
      staleReason={pin?.staleReason}
      pin={
        pin
          ? {
              canonicalSnapshotId: pin.canonicalSnapshotId,
              canonicalHash: pin.canonicalHash,
              boardRev: pin.boardRev,
              lifecycleRev: pin.lifecycleRev,
            }
          : null
      }
    >
      {showBody ? (
        <div className={styles.body} data-testid="priority-body">
          <PageHeader
            eyebrow="Misi Q7"
            title="Portofolio prioritas"
            subtitle={`${portfolioHuman} — hanya envelope server (tanpa hitung ulang di klien)`}
            breadcrumb={
              <Breadcrumb
                items={[
                  { label: 'Control center' },
                  { label: 'Prioritas' },
                ]}
              />
            }
            actions={
              pin?.stale ? (
                <StatusChip variant="warn" data-testid="priority-pin-stale-chip">
                  Data basi
                </StatusChip>
              ) : pin ? (
                <StatusChip variant="done">Pin aktif</StatusChip>
              ) : null
            }
          />

          {pin ? (
            <Card
              title="Pin envelope"
              subtitle={portfolioHuman}
              headerActions={
                <Badge mono variant="neutral" title={PRIORITY_PORTFOLIO_ID}>
                  {PRIORITY_PORTFOLIO_ID}
                </Badge>
              }
              data-testid="priority-pin"
            >
              <dl className={styles.pinRow}>
                <div>
                  <dt title="boardId">Board</dt>
                  <dd>
                    <code className={styles.mono}>{pin.boardId}</code>
                  </dd>
                </div>
                <div>
                  <dt title="canonicalSnapshotId">Snapshot</dt>
                  <dd>
                    <code className={styles.mono} title={pin.canonicalHash}>
                      {pin.canonicalSnapshotId}
                    </code>
                  </dd>
                </div>
                <div>
                  <dt title="boardRev">Revisi board</dt>
                  <dd data-testid="priority-board-rev">{pin.boardRev}</dd>
                </div>
                <div>
                  <dt title="lifecycleRev">Revisi lifecycle</dt>
                  <dd data-testid="priority-lifecycle-rev">{pin.lifecycleRev}</dd>
                </div>
                {pin.stale ? (
                  <div>
                    <dt title="stale">Data basi</dt>
                    <dd className={styles.semanticWarn} data-testid="priority-pin-stale">
                      ya
                      {pin.staleReason ? ` · ${pin.staleReason}` : ''}
                    </dd>
                  </div>
                ) : null}
              </dl>

              <Disclosure summary="Detail teknis — pin envelope">
                <ul className={styles.idList}>
                  <li>
                    portfolioId: <code className={styles.mono}>{PRIORITY_PORTFOLIO_ID}</code>
                  </li>
                  <li>
                    canonicalHash: <code className={styles.mono}>{pin.canonicalHash}</code>
                  </li>
                  <li>
                    boardRev={pin.boardRev}; lifecycleRev={pin.lifecycleRev}
                  </li>
                </ul>
              </Disclosure>
            </Card>
          ) : null}

          <div className={styles.grid}>
            {membership ? <PriorityMembershipPanel {...membership} /> : null}
            {denominators ? <PriorityDenominatorsPanel {...denominators} /> : null}
            {readiness ? <PriorityReadinessPanel {...readiness} /> : null}
            {capacity ? <PriorityCapacityPanel {...capacity} /> : null}
            {g5 ? (
              <div className={styles.gridFull}>
                <PriorityG5Panel {...g5} />
              </div>
            ) : null}
            {nonPriorityReasons ? (
              <div className={styles.gridFull}>
                <NonPriorityReasonsPanel {...nonPriorityReasons} />
              </div>
            ) : null}

            <Card
              className={styles.helpPanel}
              title="Panduan operator"
              subtitle="Cara membaca layar prioritas tanpa menghitung ulang di klien"
            >
              <Tabs
                defaultValue="baca"
                items={[
                  {
                    id: 'baca',
                    label: 'Cara baca',
                    panel: (
                      <p className={styles.muted}>
                        Judul entitas memakai label manusia id-ID; ID teknis portofolio
                        ditampilkan mono sebagai sekunder. Angka kesiapan, mayoritas, G5, dan
                        porsi kapasitas selalu dari envelope server — klien tidak
                        menghitung ulang.
                      </p>
                    ),
                  },
                  {
                    id: 'fail-closed',
                    label: 'Fail-closed',
                    panel: (
                      <p className={styles.muted}>
                        Cakupan produk kosong, kapasitas nol, frontier kosong, atau mayoritas
                        null ditampilkan N-A / FAIL — tidak pernah dibulatkan menjadi PASS atau
                        100%. Detail pin, hash, dan kode alasan ada di Disclosure «Detail
                        teknis».
                      </p>
                    ),
                  },
                ]}
              />
            </Card>
          </div>
        </div>
      ) : null}
    </PriorityStateShell>
  )
}
