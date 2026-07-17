/**
 * FAN-FITUR — Fitur 360 (produk, id-ID) · Direction B.
 * Header + 3 ProgressBar (Pemetaan / Terbukti / Siap produksi) +
 * Tabs Isi/Progres/Dokumen/Lineage + Table isi.
 * Technical noise → Disclosure "Detail teknis".
 */
import { useMemo, useState } from 'react'

import type {
  Feature360Available,
  Feature360BarUi,
  Feature360UiData,
  Feature360UnitRow,
  Feature360TaskRow,
  Feature360DocRef,
  Feature360LineageRow,
} from '#/server/control-center-rebuild-fns'
import {
  Badge,
  Breadcrumb,
  Button,
  Card,
  Disclosure,
  EmptyState,
  MonoCell,
  PageHeader,
  ProgressBar,
  StatusChip,
  Table,
  Tabs,
  type StatusChipVariant,
  type TableColumn,
} from '#/components/ui'
import type { FiturSurfaceState } from './FeatureDirectoryScreen'
import styles from './fitur.module.css'

export type Feature360ScreenProps = {
  boardId: string
  featureId: string
  data: Feature360UiData | null
  surfaceState: FiturSurfaceState
  errorMessage?: string | null
  onRetry?: () => void
  className?: string
}

type TabId = 'isi' | 'progres' | 'dokumen' | 'lineage'

const PLATFORM_LABEL: Record<string, string> = {
  rn: 'React Native',
  backend: 'Backend',
  web: 'Web',
  admin: 'Admin',
  jobs: 'Jobs',
  service: 'Service',
  api: 'API',
  other: 'Lainnya',
}

function verdictVariant(
  tone: 'ok' | 'warn' | 'blocked' | 'muted',
): StatusChipVariant {
  if (tone === 'ok') return 'done'
  if (tone === 'warn') return 'warn'
  if (tone === 'blocked') return 'blocked'
  return 'pending'
}

function FeatureBar({ bar }: { bar: Feature360BarUi }) {
  const max = bar.denominator > 0 ? bar.denominator : 1
  const label =
    bar.pct != null
      ? `${bar.numerator}/${bar.denominator} (${bar.pct}%)`
      : `${bar.numerator}/${bar.denominator}`
  return (
    <Card
      data-testid={`fitur360-bar-${bar.key}`}
      data-bar={bar.key}
      title={bar.labelId}
      subtitle={label}
    >
      <div className={styles.barBlock}>
        <ProgressBar value={bar.numerator} max={max} label={label} />
        {bar.placeholder && bar.noteId ? (
          <p className={styles.barNote} data-testid="fitur360-bar-placeholder-note">
            {bar.noteId}
          </p>
        ) : null}
      </div>
    </Card>
  )
}

function TabIsi({ data }: { data: Feature360Available }) {
  const platforms = Object.keys(data.unitsByPlatform).sort((a, b) =>
    a.localeCompare(b, 'id'),
  )
  if (platforms.length === 0) {
    return (
      <EmptyState
        data-testid="fitur360-isi-empty"
        title="Belum ada unit inventory"
        description="Belum ada unit inventory untuk fitur ini."
      />
    )
  }

  const unitColumns: Array<TableColumn<Feature360UnitRow>> = [
    {
      id: 'tipe',
      header: 'Tipe',
      cell: (u) => u.unitType ?? '—',
    },
    {
      id: 'identifier',
      header: 'Identifier',
      cell: (u) => u.identifier ?? '—',
    },
    {
      id: 'anchor',
      header: 'Anchor',
      mono: true,
      cell: (u) => u.anchor ?? '—',
    },
    {
      id: 'status',
      header: 'Status',
      cell: (u) =>
        u.coverageStatus ? (
          <Badge variant="neutral">{u.coverageStatus}</Badge>
        ) : (
          '—'
        ),
    },
  ]

  return (
    <div data-testid="fitur360-tab-isi" className={styles.stack}>
      {platforms.map((platform) => {
        const units = data.unitsByPlatform[platform] ?? []
        return (
          <div
            key={platform}
            className={styles.platformBlock}
            data-platform={platform}
          >
            <h3 className={styles.platformTitle}>
              {PLATFORM_LABEL[platform] ?? platform}
            </h3>
            <Table
              columns={unitColumns}
              rows={units}
              rowKey={(u) => u.unitId}
              caption={`Unit ${PLATFORM_LABEL[platform] ?? platform}`}
              aria-label={`Tabel unit ${PLATFORM_LABEL[platform] ?? platform}`}
              empty="Tidak ada unit."
            />
            <Disclosure summary="Detail teknis">
              <ul className={styles.evidenceList}>
                {units.map((u) => (
                  <li key={`tech-${u.unitId}`} className={styles.techMono}>
                    {u.unitId}
                    {u.repo ? ` · ${u.repo}` : ''}
                  </li>
                ))}
              </ul>
            </Disclosure>
          </div>
        )
      })}
    </div>
  )
}

function TabProgres({ data }: { data: Feature360Available }) {
  if (data.tasks.length === 0) {
    return (
      <EmptyState
        data-testid="fitur360-progres-empty"
        title="Belum ada task"
        description="Belum ada task terhubung ke fitur ini."
      />
    )
  }

  const columns: Array<TableColumn<Feature360TaskRow>> = [
    {
      id: 'task',
      header: 'Task',
      cell: (t) => (
        <div>
          <MonoCell>{t.taskId}</MonoCell>
          <span className={styles.joinMeta}>
            {t.joinSource}
            {Number.isFinite(t.confidence)
              ? ` · conf ${Math.round(t.confidence * 100) / 100}`
              : ''}
          </span>
        </div>
      ),
    },
    {
      id: 'verdict',
      header: 'Verdict',
      cell: (t) => (
        <StatusChip
          variant={verdictVariant(t.verdictTone)}
          data-testid="fitur360-verdict-chip"
          data-tone={t.verdictTone}
        >
          {t.verdictLabelId}
        </StatusChip>
      ),
    },
  ]

  return (
    <div data-testid="fitur360-tab-progres">
      <Table
        columns={columns}
        rows={data.tasks}
        rowKey={(t) => t.taskId}
        caption="Progres task fitur"
        aria-label="Tabel progres task"
      />
    </div>
  )
}

function TabDokumen({ data }: { data: Feature360Available }) {
  if (data.docs.length === 0) {
    return (
      <EmptyState
        data-testid="fitur360-dokumen-empty"
        title="Belum ada dokumen"
        description="Belum ada referensi dokumen FC untuk fitur ini."
      />
    )
  }
  return (
    <div data-testid="fitur360-tab-dokumen" className={styles.stack}>
      {data.docs.map((d: Feature360DocRef) => (
        <Card
          key={d.featureContractId}
          data-testid="fitur360-doc-card"
          title={d.judulId ?? 'Dokumen fitur'}
          subtitle={`Status: ${d.deliveryStatus ?? '—'} · docs ${d.hasDocMd ? '✓' : '–'}`}
        >
          {d.docMd ? (
            <pre className={styles.docBody} data-testid="fitur360-doc-md">
              {d.docMd}
            </pre>
          ) : (
            <p className={styles.metaMuted}>Isi markdown belum tersedia.</p>
          )}
          <Disclosure summary="Detail teknis">
            <p className={styles.techMono}>{d.featureContractId}</p>
          </Disclosure>
        </Card>
      ))}
    </div>
  )
}

function TabLineage({ data }: { data: Feature360Available }) {
  if (data.lineage.length === 0) {
    return (
      <EmptyState
        data-testid="fitur360-lineage-empty"
        title="Belum ada lineage"
        description="Belum ada lineage untuk task fitur ini."
      />
    )
  }
  return (
    <div data-testid="fitur360-tab-lineage" className={styles.stack}>
      {data.lineage.map((row: Feature360LineageRow) => (
        <Disclosure
          key={row.taskId}
          data-testid="fitur360-lineage-item"
          summary={
            <span className={styles.lineageMeta}>
              <MonoCell>{row.taskId}</MonoCell>
              {row.origin ? (
                <span className={styles.metaMuted}>asal: {row.origin}</span>
              ) : null}
              {row.gapClass ? (
                <span className={styles.metaMuted}>gap: {row.gapClass}</span>
              ) : null}
            </span>
          }
        >
          <div className={styles.lineageBody}>
            <div>
              <strong>Verifier:</strong> {row.verifier ?? '—'}
            </div>
            <div>
              <strong>Diverifikasi:</strong> {row.verifiedAt ?? '—'}
            </div>
            <div>
              <strong>Verdict:</strong> {row.parityVerdict ?? '—'}
            </div>
            {row.evidence.length > 0 ? (
              <div>
                <strong>Evidence (file:line)</strong>
                <ul className={styles.evidenceList}>
                  {row.evidence.map((e, i) => (
                    <li key={`${e.file}-${e.line ?? 'x'}-${i}`}>
                      {e.file}
                      {e.line != null ? `:${e.line}` : ''}
                      {e.side ? ` (${e.side})` : ''}
                    </li>
                  ))}
                </ul>
              </div>
            ) : (
              <p className={styles.metaMuted}>Tidak ada sample evidence.</p>
            )}
            {row.featureContractId ? (
              <Disclosure summary="Detail teknis">
                <p className={styles.techMono}>{row.featureContractId}</p>
              </Disclosure>
            ) : null}
          </div>
        </Disclosure>
      ))}
    </div>
  )
}

/**
 * Fitur 360 detail screen.
 */
export function Feature360Screen({
  boardId,
  featureId,
  data,
  surfaceState,
  errorMessage,
  onRetry,
  className,
}: Feature360ScreenProps) {
  const [tab, setTab] = useState<TabId>('isi')

  const directoryHref = useMemo(() => {
    if (data) return data.directoryHref
    return `/b/${encodeURIComponent(boardId)}/fitur`
  }, [data, boardId])

  const technicalHref = useMemo(() => {
    if (data) return data.technicalFcHref
    return `/b/${encodeURIComponent(boardId)}/features`
  }, [data, boardId])

  const rootClass = [styles.root, className].filter(Boolean).join(' ')

  if (surfaceState === 'loading' && !data) {
    return (
      <div className={rootClass} data-testid="fitur-360" data-surface="loading">
        <div className={styles.liveRegion} aria-live="polite">
          Memuat Fitur 360…
        </div>
        <PageHeader eyebrow="Fitur 360" title="Memuat…" />
      </div>
    )
  }

  if (
    surfaceState === 'error' ||
    surfaceState === 'forbidden' ||
    surfaceState === 'disconnected'
  ) {
    const title =
      surfaceState === 'forbidden'
        ? 'Akses ditolak'
        : surfaceState === 'disconnected'
          ? 'Koneksi terputus'
          : 'Gagal memuat'
    return (
      <div className={rootClass} data-testid="fitur-360" data-surface={surfaceState}>
        <PageHeader eyebrow="Fitur 360" title="Fitur" />
        <EmptyState
          title={title}
          description={errorMessage ?? 'Fitur 360 tidak dapat dimuat.'}
          action={
            onRetry ? (
              <Button type="button" variant="secondary" onClick={onRetry}>
                Coba lagi
              </Button>
            ) : undefined
          }
        />
      </div>
    )
  }

  if (data && !data.available) {
    return (
      <div
        className={rootClass}
        data-testid="fitur-360"
        data-surface="empty-migrated"
        data-available="false"
        data-feature-id={featureId}
      >
        <div className={styles.liveRegion} aria-live="polite">
          {data.emptyStateLabelId}
        </div>
        <PageHeader
          eyebrow="Fitur 360"
          title="Fitur"
          breadcrumb={
            <Breadcrumb
              items={[
                { label: 'Direktori fitur', href: directoryHref },
                { label: 'Fitur' },
              ]}
            />
          }
          actions={
            <a
              className={styles.metaMuted}
              href={technicalHref}
              data-testid="fitur360-technical-fc-link"
            >
              Kontrak teknis (FC)
            </a>
          }
        />
        <EmptyState
          data-testid="fitur360-empty-state"
          title={data.emptyStateLabelId}
          description="Halaman Fitur 360 siap menampilkan isi unit, progres task, dokumen, dan lineage setelah data rebuild diaktifkan."
        />
      </div>
    )
  }

  if (!data || !data.available) {
    return (
      <div className={rootClass} data-testid="fitur-360" data-surface="empty">
        <EmptyState
          data-testid="fitur360-empty-state"
          title="Data fitur belum tersedia."
          description="Halaman Fitur 360 siap menampilkan isi unit, progres task, dokumen, dan lineage setelah data rebuild diaktifkan."
        />
      </div>
    )
  }

  const tabItems = [
    {
      id: 'isi',
      label: <span data-testid="fitur360-tab-btn-isi">Isi</span>,
      panel: <TabIsi data={data} />,
    },
    {
      id: 'progres',
      label: <span data-testid="fitur360-tab-btn-progres">Progres</span>,
      panel: <TabProgres data={data} />,
    },
    {
      id: 'dokumen',
      label: <span data-testid="fitur360-tab-btn-dokumen">Dokumen</span>,
      panel: <TabDokumen data={data} />,
    },
    {
      id: 'lineage',
      label: <span data-testid="fitur360-tab-btn-lineage">Lineage</span>,
      panel: <TabLineage data={data} />,
    },
  ]

  return (
    <div
      className={rootClass}
      data-testid="fitur-360"
      data-surface="populated"
      data-available="true"
      data-board-id={boardId}
      data-feature-id={data.featureId}
    >
      <div className={styles.liveRegion} aria-live="polite">
        {data.namaId} · {data.domainBisnis}
      </div>

      <PageHeader
        breadcrumb={
          <Breadcrumb
            items={[
              {
                label: 'Direktori fitur',
                href: data.directoryHref,
              },
              { label: data.namaId },
            ]}
          />
        }
        eyebrow={data.domainBisnis}
        title={
          <span data-testid="fitur360-nama" className={styles.entityName}>
            {data.namaId}
          </span>
        }
        subtitle={
          data.ringkasanId ? (
            <span data-testid="fitur360-ringkasan">{data.ringkasanId}</span>
          ) : undefined
        }
        actions={
          <a
            className={styles.metaMuted}
            href={data.technicalFcHref}
            data-testid="fitur360-technical-fc-link"
          >
            Kontrak teknis (FC)
          </a>
        }
      />

      {/* Hidden back link for legacy deep-link tests */}
      <a
        href={data.directoryHref}
        data-testid="fitur360-back-directory"
        className="sr-only"
      >
        ← Direktori fitur
      </a>

      <section
        className={styles.barsRow}
        aria-label="Tiga bar progres fitur"
        data-testid="fitur360-bars"
      >
        <FeatureBar bar={data.bars.pemetaan} />
        <FeatureBar bar={data.bars.terbukti_pindah} />
        <FeatureBar bar={data.bars.siap_produksi} />
      </section>

      <Disclosure summary="Detail teknis">
        <p className={styles.techMono}>
          featureId: {data.featureId}
          {data.rollup
            ? ` · task ${data.rollup.taskCount} · lineage ${data.rollup.lineageCount}`
            : ''}
        </p>
      </Disclosure>

      <div data-testid="fitur360-tabs">
        <Tabs
          items={tabItems}
          value={tab}
          onValueChange={(id) => setTab(id as TabId)}
        />
      </div>
    </div>
  )
}
