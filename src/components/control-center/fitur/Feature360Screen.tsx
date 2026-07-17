/**
 * W-UI-2 — Fitur 360 (produk, id-ID).
 * Header: nama_id + ringkasan_id + 3 bar (Pemetaan / Terbukti pindah / Siap produksi).
 * Tabs: Isi · Progres · Dokumen · Lineage.
 * Teknis (T-*, FC-*, hash) only inside disclosure/detail.
 * SPEC §3.B + §4 + ADDENDUM V1.1 §B.
 */
import { useMemo, useState } from 'react'

import type {
  Feature360Available,
  Feature360BarUi,
  Feature360UiData,
} from '#/server/control-center-rebuild-fns'
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

const TABS: Array<{ id: TabId; label: string }> = [
  { id: 'isi', label: 'Isi' },
  { id: 'progres', label: 'Progres' },
  { id: 'dokumen', label: 'Dokumen' },
  { id: 'lineage', label: 'Lineage' },
]

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

function barWidthPct(mappedPct: number | null | undefined): string {
  if (mappedPct == null || !Number.isFinite(mappedPct)) return '0%'
  return `${Math.max(0, Math.min(100, mappedPct))}%`
}

function chipClass(tone: 'ok' | 'warn' | 'blocked' | 'muted'): string {
  if (tone === 'ok') return `${styles.chip} ${styles.chipOk}`
  if (tone === 'warn') return `${styles.chip} ${styles.chipWarn}`
  if (tone === 'blocked') return `${styles.chip} ${styles.chipBlocked}`
  return `${styles.chip} ${styles.chipMuted}`
}

function barFillClass(key: Feature360BarUi['key']): string {
  if (key === 'terbukti_pindah') return styles.barFill
  if (key === 'pemetaan') return styles.barFill
  return `${styles.barFill} ${styles.barFillMuted}`
}

function ProgressBar({ bar }: { bar: Feature360BarUi }) {
  return (
    <div
      className={styles.barCard}
      data-testid={`fitur360-bar-${bar.key}`}
      data-bar={bar.key}
    >
      <div className={styles.barNums}>
        {bar.numerator}/{bar.denominator}
        {bar.pct != null ? (
          <span className={styles.muted}> ({bar.pct}%)</span>
        ) : null}
      </div>
      <p className={styles.barLabel}>{bar.labelId}</p>
      <div className={styles.barTrack} aria-hidden="true">
        <div
          className={barFillClass(bar.key)}
          style={{ width: barWidthPct(bar.pct) }}
        />
      </div>
      {bar.placeholder && bar.noteId ? (
        <p className={styles.barNote} data-testid="fitur360-bar-placeholder-note">
          {bar.noteId}
        </p>
      ) : null}
    </div>
  )
}

function EmptyMigratedState({ label }: { label: string }) {
  return (
    <div
      className={styles.emptyState}
      data-testid="fitur360-empty-state"
      role="status"
    >
      <div className={styles.emptyIcon} aria-hidden="true">
        ∅
      </div>
      <h2 className={styles.emptyTitle}>{label}</h2>
      <p className={styles.emptyBody}>
        Halaman Fitur 360 siap menampilkan isi unit, progres task, dokumen, dan
        lineage setelah data rebuild diaktifkan.
      </p>
    </div>
  )
}

function TabIsi({ data }: { data: Feature360Available }) {
  const platforms = Object.keys(data.unitsByPlatform).sort((a, b) =>
    a.localeCompare(b, 'id'),
  )
  if (platforms.length === 0) {
    return (
      <p className={styles.panelEmpty} data-testid="fitur360-isi-empty">
        Belum ada unit inventory untuk fitur ini.
      </p>
    )
  }
  return (
    <div data-testid="fitur360-tab-isi">
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
            <div className={styles.tableWrap}>
              <table className={styles.dataTable}>
                <thead>
                  <tr>
                    <th scope="col">Tipe</th>
                    <th scope="col">Identifier</th>
                    <th scope="col">Anchor</th>
                    <th scope="col">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {units.map((u) => (
                    <tr key={u.unitId} data-unit-id={u.unitId}>
                      <td>{u.unitType ?? '—'}</td>
                      <td>{u.identifier ?? '—'}</td>
                      <td className={styles.mono}>{u.anchor ?? '—'}</td>
                      <td>{u.coverageStatus ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <details className={styles.techDisclosure}>
              <summary>Detail teknis unit</summary>
              <ul className={styles.evidenceList}>
                {units.map((u) => (
                  <li key={`tech-${u.unitId}`}>
                    {u.unitId}
                    {u.repo ? ` · ${u.repo}` : ''}
                  </li>
                ))}
              </ul>
            </details>
          </div>
        )
      })}
    </div>
  )
}

function TabProgres({ data }: { data: Feature360Available }) {
  if (data.tasks.length === 0) {
    return (
      <p className={styles.panelEmpty} data-testid="fitur360-progres-empty">
        Belum ada task terhubung ke fitur ini.
      </p>
    )
  }
  return (
    <div data-testid="fitur360-tab-progres">
      <div className={styles.tableWrap}>
        <table className={styles.dataTable}>
          <thead>
            <tr>
              <th scope="col">Task</th>
              <th scope="col">Verdict</th>
            </tr>
          </thead>
          <tbody>
            {data.tasks.map((t) => (
              <tr key={t.taskId} data-task-id={t.taskId}>
                <td>
                  <span className={styles.mono}>{t.taskId}</span>
                  <span className={styles.joinMeta}>
                    {t.joinSource}
                    {Number.isFinite(t.confidence)
                      ? ` · conf ${Math.round(t.confidence * 100) / 100}`
                      : ''}
                  </span>
                </td>
                <td>
                  <span
                    className={chipClass(t.verdictTone)}
                    data-testid="fitur360-verdict-chip"
                    data-tone={t.verdictTone}
                  >
                    {t.verdictLabelId}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function TabDokumen({ data }: { data: Feature360Available }) {
  if (data.docs.length === 0) {
    return (
      <p className={styles.panelEmpty} data-testid="fitur360-dokumen-empty">
        Belum ada referensi dokumen FC untuk fitur ini.
      </p>
    )
  }
  return (
    <div data-testid="fitur360-tab-dokumen">
      {data.docs.map((d) => (
        <article
          key={d.featureContractId}
          className={styles.docCard}
          data-testid="fitur360-doc-card"
        >
          <h3 className={styles.docTitle}>{d.judulId ?? 'Dokumen fitur'}</h3>
          <p className={styles.muted}>
            Status: {d.deliveryStatus ?? '—'} · docs {d.hasDocMd ? '✓' : '–'}
          </p>
          {d.docMd ? (
            <pre className={styles.docBody} data-testid="fitur360-doc-md">
              {d.docMd}
            </pre>
          ) : (
            <p className={styles.panelEmpty}>Isi markdown belum tersedia.</p>
          )}
          <details className={styles.techDisclosure}>
            <summary>Detail teknis</summary>
            <p className={styles.mono}>{d.featureContractId}</p>
          </details>
        </article>
      ))}
    </div>
  )
}

function TabLineage({ data }: { data: Feature360Available }) {
  if (data.lineage.length === 0) {
    return (
      <p className={styles.panelEmpty} data-testid="fitur360-lineage-empty">
        Belum ada lineage untuk task fitur ini.
      </p>
    )
  }
  return (
    <div data-testid="fitur360-tab-lineage">
      {data.lineage.map((row) => (
        <details
          key={row.taskId}
          className={styles.lineageItem}
          data-testid="fitur360-lineage-item"
        >
          <summary className={styles.lineageSummary}>
            <span className={styles.mono}>{row.taskId}</span>
            {row.origin ? (
              <span className={styles.muted}>asal: {row.origin}</span>
            ) : null}
            {row.gapClass ? (
              <span className={styles.muted}>gap: {row.gapClass}</span>
            ) : null}
          </summary>
          <div className={styles.lineageBody}>
            <div>
              <strong>Verifier:</strong> {row.verifier ?? '—'}
            </div>
            <div>
              <strong>Verified at:</strong> {row.verifiedAt ?? '—'}
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
              <p className={styles.muted}>Tidak ada sample evidence.</p>
            )}
            {row.featureContractId ? (
              <details className={styles.techDisclosure}>
                <summary>Detail teknis</summary>
                <p className={styles.mono}>{row.featureContractId}</p>
              </details>
            ) : null}
          </div>
        </details>
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

  if (surfaceState === 'loading' && !data) {
    return (
      <div
        className={[styles.root, className].filter(Boolean).join(' ')}
        data-testid="fitur-360"
        data-surface="loading"
      >
        <div className={styles.liveRegion} aria-live="polite">
          Memuat Fitur 360…
        </div>
        <header className={styles.pageHead}>
          <div>
            <p className={styles.eyebrow}>Fitur 360</p>
            <h1 className={styles.pageTitle}>Memuat…</h1>
          </div>
        </header>
      </div>
    )
  }

  if (
    surfaceState === 'error' ||
    surfaceState === 'forbidden' ||
    surfaceState === 'disconnected'
  ) {
    return (
      <div
        className={[styles.root, className].filter(Boolean).join(' ')}
        data-testid="fitur-360"
        data-surface={surfaceState}
      >
        <div className={`${styles.banner} ${styles.banner_error}`} role="alert">
          <p className={styles.bannerTitle}>
            {surfaceState === 'forbidden'
              ? 'Akses ditolak'
              : surfaceState === 'disconnected'
                ? 'Koneksi terputus'
                : 'Gagal memuat'}
          </p>
          <p className={styles.bannerBody}>
            {errorMessage ?? 'Fitur 360 tidak dapat dimuat.'}
          </p>
          {onRetry ? (
            <button type="button" className={styles.retryBtn} onClick={onRetry}>
              Coba lagi
            </button>
          ) : null}
        </div>
      </div>
    )
  }

  if (data && !data.available) {
    return (
      <div
        className={[styles.root, className].filter(Boolean).join(' ')}
        data-testid="fitur-360"
        data-surface="empty-migrated"
        data-available="false"
        data-feature-id={featureId}
      >
        <div className={styles.liveRegion} aria-live="polite">
          {data.emptyStateLabelId}
        </div>
        <header className={styles.pageHead}>
          <div>
            <a className={styles.backLink} href={directoryHref}>
              ← Direktori fitur
            </a>
            <p className={styles.eyebrow}>Fitur 360</p>
            <h1 className={styles.pageTitle}>Fitur</h1>
          </div>
          <div className={styles.headMeta}>
            <a
              className={styles.secondaryLink}
              href={technicalHref}
              data-testid="fitur360-technical-fc-link"
            >
              Kontrak teknis (FC)
            </a>
          </div>
        </header>
        <EmptyMigratedState label={data.emptyStateLabelId} />
      </div>
    )
  }

  if (!data || !data.available) {
    return (
      <div
        className={[styles.root, className].filter(Boolean).join(' ')}
        data-testid="fitur-360"
        data-surface="empty"
      >
        <EmptyMigratedState label="Data fitur belum tersedia." />
      </div>
    )
  }

  return (
    <div
      className={[styles.root, className].filter(Boolean).join(' ')}
      data-testid="fitur-360"
      data-surface="populated"
      data-available="true"
      data-board-id={boardId}
      data-feature-id={data.featureId}
    >
      <div className={styles.liveRegion} aria-live="polite">
        {data.namaId} · {data.domainBisnis}
      </div>

      <header className={styles.pageHead}>
        <div>
          <a
            className={styles.backLink}
            href={data.directoryHref}
            data-testid="fitur360-back-directory"
          >
            ← Direktori fitur
          </a>
          <p className={styles.eyebrow}>{data.domainBisnis}</p>
          <h1 className={styles.pageTitleLg} data-testid="fitur360-nama">
            {data.namaId}
          </h1>
          {data.ringkasanId ? (
            <p className={styles.pageSub} data-testid="fitur360-ringkasan">
              {data.ringkasanId}
            </p>
          ) : null}
        </div>
        <div className={styles.headMeta}>
          <a
            className={styles.secondaryLink}
            href={data.technicalFcHref}
            data-testid="fitur360-technical-fc-link"
          >
            Kontrak teknis (FC)
          </a>
        </div>
      </header>

      <section
        className={styles.barsRow}
        aria-label="Tiga bar progres fitur"
        data-testid="fitur360-bars"
      >
        <ProgressBar bar={data.bars.pemetaan} />
        <ProgressBar bar={data.bars.terbukti_pindah} />
        <ProgressBar bar={data.bars.siap_produksi} />
      </section>

      <div
        className={styles.tabList}
        role="tablist"
        aria-label="Bag Fitur 360"
        data-testid="fitur360-tabs"
      >
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            id={`fitur360-tab-${t.id}`}
            aria-selected={tab === t.id}
            aria-controls={`fitur360-panel-${t.id}`}
            className={styles.tabBtn}
            data-testid={`fitur360-tab-btn-${t.id}`}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div
        className={styles.tabPanel}
        role="tabpanel"
        id={`fitur360-panel-${tab}`}
        aria-labelledby={`fitur360-tab-${tab}`}
        data-testid={`fitur360-panel-${tab}`}
      >
        {tab === 'isi' ? <TabIsi data={data} /> : null}
        {tab === 'progres' ? <TabProgres data={data} /> : null}
        {tab === 'dokumen' ? <TabDokumen data={data} /> : null}
        {tab === 'lineage' ? <TabLineage data={data} /> : null}
      </div>
    </div>
  )
}
