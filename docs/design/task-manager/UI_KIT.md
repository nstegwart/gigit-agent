# Cairn UI Kit — Primitif (W-DS-FOUNDATION)

**Authority:** `SPEC-CAIRN-REDESIGN-V2` §1–§2  
**Import:** `import { … } from '#/components/ui'`  
**Tokens:** `design/tokens/task-manager.tokens.json` → CSS vars in `src/styles.css`  
**Rule:** layar dilarang hex mentah / styling ad-hoc; pakai primitif + token.

Referensi rasa: Linear / Height / Vercel dashboard — tenang, tajam, terstruktur.

## Token ringkas

| Domain | Nilai |
|---|---|
| Canvas / surface | `--bg` `#FAFAFA` · `--surface` `#FFFFFF` |
| Border | `--border` `#E4E4E7` · `--border-soft` `#ECECEC` (1px) |
| Teks | `--text` `#18181B` · `--text-dim` `#52525B` · `--text-faint` `#71717A` |
| Brand | `--accent` `#4F46E5` (hemat) |
| Semantik | done `#0A6E48` · ongoing `#1D4ED8` · warn `#9A3412` · blocked `#C62828` · queued · next (AA white + soft-12%) |
| Type | caption 12 · small 13 · body 14 · h2 16 · h1 20 · display 28 |
| Space | 4 / 8 / 12 / 16 / 24 / 32 / 48 |
| Radius | control 6 · card 8 · pill 999 |
| Shadow | hampir tidak ada; `shadow-sm` hanya overlay |

## Komponen

### `PageHeader`
```tsx
<PageHeader
  eyebrow="Ringkasan"
  title="Judul layar"
  subtitle="Satu kalimat apa ini."
  breadcrumb={<Breadcrumb items={[…]} />}
  actions={<Button>Aksi</Button>}
/>
```
Props: `title`, `subtitle?`, `eyebrow?`, `breadcrumb?`, `actions?`

### `Button` / `IconButton`
```tsx
<Button variant="primary|secondary|ghost|danger" size="sm|md">Simpan</Button>
<IconButton aria-label="Tutup" size="sm|md" variant="default|ghost">…</IconButton>
```

### `Card` / `Panel`
```tsx
<Card title="Judul" subtitle="…" headerActions={…} footer={…} flush={false}>
  body
</Card>
```

### `Table`
```tsx
<Table
  columns={[{ id, header, cell, sortable?, mono? }]}
  rows={data}
  rowKey={(r) => r.id}
  loading={false}
  empty="Tidak ada data."
  sortColumnId={…}
  sortDirection="asc"|"desc"|false
  onSort={(id) => …}
/>
```
Header sticky, skeleton loading, empty row, mono cells.

### `Badge` / `StatusChip` / `Pill`
```tsx
<Badge variant="neutral|brand" mono>pin</Badge>
<StatusChip variant="done|ongoing|warn|blocked|pending|next">Selesai</StatusChip>
<Pill active onClick={…}>Filter</Pill>
```
StatusChip = **hanya** status semantik (bukan dekorasi).

### `Tabs` / `SegmentedControl`
```tsx
<Tabs items={[{ id, label, panel }]} value={…} onValueChange={…} />
<SegmentedControl options={[{ value, label }]} value={…} onChange={…} />
```

### `ProgressBar` / `KpiStat`
```tsx
<ProgressBar value={x} max={y} ok label="x/y (z%)" />
<KpiStat value={42} label="Denom produk" hint="opsional" size="sm|md" />
```

### `EmptyState`
```tsx
<EmptyState title="Kosong" description="…" action={<Button>CTA</Button>} icon={…} />
```

### `Toolbar` / `Pagination`
```tsx
<Toolbar searchProps={{ value, onChange }} filters={<Pill>…</Pill>} actions={…} />
<Pagination page={1} pageSize={25} total={N} onPageChange={…} onPageSizeChange={…} />
```
Default page size disarankan **25**.

### `Disclosure` / `Tooltip` / `Skeleton` / `Breadcrumb`
```tsx
<Disclosure summary="Detail teknis">pin / hash / rev</Disclosure>
<Tooltip content="Bantuan"><Button variant="ghost">?</Button></Tooltip>
<Skeleton width="40%" height={14} />
<Breadcrumb items={[{ label, href? }]} />
```

## AppShell

`src/components/AppShell.tsx` — sidebar berkelompok (Ringkasan/Rebuild/Pekerjaan/Prioritas · Struktur · Operasi), header (judul bilingual + cmd-k search + UserMenu), konten max **1280px** (`.content-inner`).  
**Jangan** ubah route target / `CONTROL_CENTER_NAV_LABELS` (9 IA + Rebuild markup).

## Layar referensi

`Overview` (`src/components/control-center/overview/`) memakai primitif di atas sebagai patokan visual fase fan-out.

## Galeri

`UiGallery` di `src/components/ui/UiGallery.tsx` — komposisi statis untuk screenshot art director (`receipts/shots-ds/`).

## Larangan worker fan-out

1. Tidak menambah npm dep (ikon: `lucide-react` atau `#/lib/icons` / inline SVG stroke 1.5).  
2. Tidak mengubah logika bisnis/server di dalam `ui/`.  
3. Tidak raw hex di layar — hanya `var(--token)`.  
4. List panjang: Table + Pagination + Toolbar.  
5. Teknis (pin/hash/rev) → `Disclosure "Detail teknis"`.
