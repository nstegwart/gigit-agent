/**
 * W-UI-3 — Panel "Lineage Rebuild" di detail task control-center.
 * Direction B: Card + StatusChip + Disclosure. id-ID; teknis di disclosure.
 * Prop-driven (no client formulas).
 */
import type {
  TaskLineageAvailable,
  TaskLineageChipTone,
  TaskLineageData,
} from '#/server/control-center-rebuild-fns'
import {
  Badge,
  Card,
  Disclosure,
  StatusChip,
  type StatusChipVariant,
} from '#/components/ui'
import styles from './lineage-panel.module.css'

export type LineagePanelSurface = 'loading' | 'ready' | 'unavailable'

export type LineagePanelProps = {
  data: TaskLineageData | null
  surfaceState?: LineagePanelSurface
  className?: string
}

function toneToVariant(tone: TaskLineageChipTone): StatusChipVariant {
  if (tone === 'ok') return 'done'
  if (tone === 'warn') return 'warn'
  if (tone === 'blocked') return 'blocked'
  return 'pending'
}

function EvidenceColumn({
  title,
  items,
  testId,
}: {
  title: string
  items: ReadonlyArray<string>
  testId: string
}) {
  return (
    <div className={styles.evidenceCol} data-testid={testId}>
      <p className={styles.evidenceColTitle}>{title}</p>
      {items.length === 0 ? (
        <p className={styles.muted}>Tidak ada entri</p>
      ) : (
        <ul className={styles.evidenceList}>
          {items.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      )}
    </div>
  )
}

function LineageBody({ data }: { data: TaskLineageAvailable }) {
  const { origin, evidence, implementation } = data

  return (
    <Card
      className={styles.panel}
      data-testid="task-lineage-panel"
      data-available="true"
      data-verdict={data.parityVerdict ?? 'null'}
      data-chip={data.chip.key}
      title="Lineage Rebuild"
      subtitle={data.summarySentenceId}
      headerActions={
        <span data-testid="task-lineage-verdict-chip" data-tone={data.chip.tone}>
          <StatusChip variant={toneToVariant(data.chip.tone)} showDot>
            {data.chip.labelId}
          </StatusChip>
        </span>
      }
    >
      <div className={styles.summaryRow} data-testid="task-lineage-summary">
        <p className={styles.summarySentence} data-testid="task-lineage-summary-sentence">
          {data.summarySentenceId}
        </p>
      </div>

      <ol className={styles.stepper} data-testid="task-lineage-stepper">
        <li className={styles.step} data-testid="task-lineage-step-asal">
          <div className={styles.rail} aria-hidden="true">
            <span className={styles.dot} />
            <span className={styles.line} />
          </div>
          <div className={styles.stepBody}>
            <h3 className={styles.stepTitle}>Asal-usul</h3>
            <p className={styles.stepLead}>
              Origin: <span className={styles.metaStrong}>{origin.labelId}</span>
            </p>
            <p className={styles.metaLine}>{origin.denominatorReasonId}</p>
            <p className={styles.metaLine} data-testid="task-lineage-covered-count">
              Unit legacy dicover:{' '}
              <span className={styles.metaStrong}>{origin.coveredUnitCount}</span>
            </p>
            {origin.coveredUnits.length > 0 || origin.legacyAnchors.length > 0 ? (
              <Disclosure
                summary="Detail unit & anchor legacy"
                data-testid="task-lineage-asal-disclosure"
              >
                {origin.coveredUnits.length > 0 ? (
                  <ul className={styles.anchorList} data-testid="task-lineage-covered-units">
                    {origin.coveredUnits.map((u) => (
                      <li key={u}>
                        <code className={styles.shaCode}>{u}</code>
                      </li>
                    ))}
                  </ul>
                ) : null}
                {origin.legacyAnchors.length > 0 ? (
                  <ul className={styles.anchorList} data-testid="task-lineage-legacy-anchors">
                    {origin.legacyAnchors.map((a) => (
                      <li key={a.label}>
                        <code className={styles.shaCode}>{a.label}</code>
                        {a.fact ? (
                          <span className={styles.anchorFact}>{a.fact}</span>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </Disclosure>
            ) : null}
          </div>
        </li>

        <li className={styles.step} data-testid="task-lineage-step-bukti">
          <div className={styles.rail} aria-hidden="true">
            <span className={styles.dot} />
            <span className={styles.line} />
          </div>
          <div className={styles.stepBody}>
            <h3 className={styles.stepTitle}>Bukti pindah</h3>
            <p className={styles.stepLead}>
              Evidence file:line dua sisi (legacy vs rebuild).
            </p>
            <div className={styles.evidenceGrid} data-testid="task-lineage-evidence-grid">
              <EvidenceColumn
                title="Legacy"
                items={evidence.legacy}
                testId="task-lineage-evidence-legacy"
              />
              <EvidenceColumn
                title="Rebuild"
                items={evidence.rebuild}
                testId="task-lineage-evidence-rebuild"
              />
            </div>
            {evidence.gaps.length > 0 ? (
              <div className={styles.gapsBlock} data-testid="task-lineage-gaps">
                <p className={styles.gapsTitle}>
                  Gap <Badge variant="neutral">{evidence.gaps.length}</Badge>
                </p>
                <ul className={styles.gapsList}>
                  {evidence.gaps.map((g) => (
                    <li key={g.slice(0, 120)}>{g}</li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
        </li>

        <li className={styles.step} data-testid="task-lineage-step-impl">
          <div className={styles.rail} aria-hidden="true">
            <span className={styles.dot} />
            <span className={styles.line} />
          </div>
          <div className={styles.stepBody}>
            <h3 className={styles.stepTitle}>Implementasi</h3>
            <p className={styles.stepLead} data-testid="task-lineage-impl-output">
              {implementation.hasRealOutputLabelId}
            </p>
            {implementation.commitSha ? (
              <p className={styles.metaLine} data-testid="task-lineage-impl-sha">
                Commit/SHA:{' '}
                <code className={styles.shaCode}>{implementation.commitSha}</code>
              </p>
            ) : (
              <p className={styles.muted} data-testid="task-lineage-impl-sha-absent">
                Commit/SHA tidak tercatat pada data lineage.
              </p>
            )}
            {implementation.commits.length > 1 ? (
              <Disclosure summary={`Semua SHA (${implementation.commits.length})`}>
                <ul className={styles.anchorList}>
                  {implementation.commits.map((c) => (
                    <li key={c}>
                      <code className={styles.shaCode}>{c}</code>
                    </li>
                  ))}
                </ul>
              </Disclosure>
            ) : null}
            {implementation.noteId ? (
              <p className={styles.metaLine}>{implementation.noteId}</p>
            ) : null}
          </div>
        </li>
      </ol>

      <Disclosure summary="Detail teknis" data-testid="task-lineage-technical">
        <ul className={styles.anchorList}>
          <li>
            taskId: <code className={styles.shaCode}>{data.taskId}</code>
          </li>
          <li>
            parityVerdict:{' '}
            <code className={styles.shaCode}>{data.parityVerdict ?? '—'}</code>
          </li>
          <li>
            disposition:{' '}
            <code className={styles.shaCode}>{data.disposition ?? '—'}</code>
          </li>
          <li>
            repository:{' '}
            <code className={styles.shaCode}>{data.technical.repository ?? '—'}</code>
          </li>
          <li>
            featureContractId:{' '}
            <code className={styles.shaCode}>
              {data.technical.featureContractId ?? '—'}
            </code>
          </li>
          <li>
            verifierModel:{' '}
            <code className={styles.shaCode}>{data.verifierModel ?? '—'}</code>
          </li>
          <li>
            verifiedAt:{' '}
            <code className={styles.shaCode}>{data.verifiedAt ?? '—'}</code>
          </li>
          <li>
            acceptanceCovered:{' '}
            <code className={styles.shaCode}>
              {data.technical.acceptanceCovered ?? '—'}
            </code>
          </li>
          <li>
            sourceHash:{' '}
            <code className={styles.shaCode}>{data.technical.sourceHash ?? '—'}</code>
          </li>
        </ul>
      </Disclosure>
    </Card>
  )
}

/**
 * Graceful: available:false / null data → small line, not a large empty panel.
 * loading → quiet line until data arrives.
 */
export function LineagePanel({
  data,
  surfaceState,
  className,
}: LineagePanelProps) {
  const resolved: LineagePanelSurface =
    surfaceState ??
    (data == null ? 'loading' : data.available ? 'ready' : 'unavailable')

  const rootClass = [styles.root, className].filter(Boolean).join(' ')

  if (resolved === 'loading' && data == null) {
    return (
      <div
        className={rootClass}
        data-testid="task-lineage-root"
        data-surface="loading"
      >
        <p className={styles.loading} data-testid="task-lineage-loading">
          Memuat lineage…
        </p>
      </div>
    )
  }

  if (!data || !data.available) {
    const label =
      data && !data.available
        ? data.emptyStateLabelId
        : 'Data lineage belum tersedia untuk task ini'
    return (
      <div
        className={rootClass}
        data-testid="task-lineage-root"
        data-surface="unavailable"
        data-reason={data && !data.available ? data.reason : 'NO_DATA'}
      >
        <p className={styles.unavailable} data-testid="task-lineage-unavailable">
          {label}
        </p>
      </div>
    )
  }

  return (
    <div className={rootClass} data-testid="task-lineage-root" data-surface="ready">
      <LineageBody data={data} />
    </div>
  )
}
