/**
 * W-DS-FOUNDATION — static + optional live shots for art-director review.
 * Captures: primitive gallery (static, honest) + AppShell chrome mock + overview mock.
 * Port 3314 preview attempted for live shell if free; always kills afterward.
 */
import { chromium } from '@playwright/test'
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn, execSync } from 'node:child_process'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const OUT = join(ROOT, 'receipts/shots-ds')
mkdirSync(OUT, { recursive: true })

const PORT = 3314
const notes = []

function portInUse(port) {
  try {
    const out = execSync(`ss -ltn 2>/dev/null | grep -E ':${port}\\s' || true`, {
      encoding: 'utf8',
    })
    return out.trim().length > 0
  } catch {
    return false
  }
}

function killPort(port) {
  try {
    execSync(
      `fuser -k ${port}/tcp 2>/dev/null || (lsof -ti :${port} | xargs -r kill -9) 2>/dev/null || true`,
      { stdio: 'ignore' },
    )
  } catch {
    /* ignore */
  }
}

/** Extract :root token block from styles.css for static HTML fidelity. */
function extractRootCss() {
  const css = readFileSync(join(ROOT, 'src/styles.css'), 'utf8')
  const m = css.match(/:root\s*\{[\s\S]*?\n\}/)
  return m ? m[0] : ''
}

function galleryHtml() {
  const root = extractRootCss()
  return `<!doctype html>
<html lang="id">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Cairn UI Kit — W-DS-FOUNDATION</title>
<style>
${root}
* { box-sizing: border-box; }
body {
  margin: 0;
  font-family: var(--font);
  background: var(--bg);
  color: var(--text);
  font-size: var(--type-body-size);
  line-height: var(--type-body-line);
}
.app {
  display: grid;
  grid-template-columns: 248px 1fr;
  min-height: 100vh;
}
.sidebar {
  background: var(--surface);
  border-right: 1px solid var(--border);
  padding: 16px 12px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.brand { font-weight: 600; font-size: 16px; letter-spacing: -0.02em; }
.brand-sub { font-size: 11px; color: var(--text-dim); margin-top: 2px; }
.nav-label {
  font-size: 11px; letter-spacing: 0.06em; text-transform: uppercase;
  color: var(--text-faint); padding: 12px 10px 4px;
}
.nav-item {
  display: flex; align-items: center; gap: 10px;
  min-height: 40px; padding: 8px 10px; border-radius: 6px;
  color: var(--text); text-decoration: none; font-weight: 500; font-size: 14px;
}
.nav-item.active {
  background: var(--accent-soft);
  box-shadow: inset 2px 0 0 var(--accent);
  color: var(--accent); font-weight: 600;
}
.main { display: flex; flex-direction: column; min-width: 0; }
.topbar {
  min-height: 64px; padding: 12px 32px;
  border-bottom: 1px solid var(--border-soft);
  display: flex; align-items: center; gap: 16px;
  background: var(--surface);
}
.topbar h1 { margin: 0; font-size: 16px; line-height: 24px; font-weight: 600; letter-spacing: -0.02em; }
.topbar p { margin: 2px 0 0; font-size: 13px; color: var(--text-dim); }
.search {
  margin-left: auto; min-width: 280px; min-height: 40px;
  border: 1px solid var(--border); border-radius: 8px;
  padding: 8px 12px; color: var(--text-dim); background: var(--surface);
  display: flex; align-items: center; gap: 8px; font-size: 14px;
}
.kbd { border: 1px solid var(--border); border-radius: 6px; padding: 2px 6px; font-size: 11px; font-weight: 600; }
.content { padding: 24px 32px 64px; overflow: auto; }
.content-inner { max-width: 1280px; margin: 0 auto; }
.eyebrow {
  font-size: 12px; line-height: 16px; font-weight: 500;
  letter-spacing: 0.06em; text-transform: uppercase; color: var(--text-dim); margin: 0 0 4px;
}
.h1 { font-size: 20px; line-height: 28px; font-weight: 600; letter-spacing: -0.02em; margin: 0; }
.sub { margin: 6px 0 0; color: var(--text-dim); max-width: 42rem; }
.section { margin-top: 28px; }
.h2 { font-size: 16px; line-height: 24px; font-weight: 600; margin: 0 0 12px; }
.row { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.btn {
  display: inline-flex; align-items: center; justify-content: center;
  min-height: 36px; padding: 0 16px; border-radius: 6px; border: 1px solid transparent;
  font: 500 14px/20px var(--font); cursor: default;
}
.btn-primary { background: var(--accent); color: var(--on-action); border-color: var(--accent); }
.btn-secondary { background: var(--surface); color: var(--text); border-color: var(--border); }
.btn-ghost { background: transparent; color: var(--text-dim); }
.btn-danger { background: var(--blocked); color: #fff; }
.chip {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 2px 10px; border-radius: 6px; font-size: 12px; font-weight: 500;
  border: 1px solid transparent;
}
.chip .dot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
.chip-done { color: var(--done); background: var(--done-bg); }
.chip-ongoing { color: var(--ongoing); background: var(--ongoing-bg); }
.chip-warn { color: var(--warn); background: var(--warn-bg); }
.chip-blocked { color: var(--blocked); background: var(--blocked-bg); }
.chip-pending { color: var(--queued); background: var(--queued-bg); border-color: var(--border-soft); }
.kpi-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; margin-bottom: 12px; }
.kpi {
  border: 1px solid var(--border); border-radius: 8px; background: var(--surface);
  padding: 12px 16px;
}
.kpi .lbl { font-size: 12px; color: var(--text-dim); font-weight: 500; }
.kpi .val { font-size: 28px; line-height: 32px; font-weight: 600; font-variant-numeric: tabular-nums; letter-spacing: -0.02em; }
.bar {
  height: 8px; border-radius: 999px; background: var(--surface-2);
  border: 1px solid var(--border-soft); overflow: hidden; margin: 8px 0;
}
.bar > i { display: block; height: 100%; background: var(--accent); width: 42%; }
.bar.ok > i { background: var(--done); width: 100%; }
.card {
  border: 1px solid var(--border); border-radius: 8px; background: var(--surface);
  padding: 16px; min-width: 0;
}
.card h3 { margin: 0 0 4px; font-size: 16px; line-height: 24px; font-weight: 600; }
.card .muted { color: var(--text-dim); margin: 0; font-size: 13px; }
.card-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
table {
  width: 100%; border-collapse: separate; border-spacing: 0;
  border: 1px solid var(--border); border-radius: 8px; overflow: hidden;
  background: var(--surface); font-size: 14px;
}
th {
  text-align: left; padding: 12px 16px; background: var(--surface-2);
  border-bottom: 1px solid var(--border); font-size: 12px; color: var(--text-dim); font-weight: 600;
}
td { padding: 12px 16px; border-bottom: 1px solid var(--border-soft); }
tr:last-child td { border-bottom: 0; }
.mono { font-family: var(--mono); font-size: 13px; color: var(--text-dim); font-variant-numeric: tabular-nums; }
.pill {
  display: inline-flex; align-items: center; padding: 4px 12px; border-radius: 999px;
  border: 1px solid var(--border); background: var(--surface); font-size: 13px; font-weight: 500;
}
.pill.active { background: var(--accent-soft); border-color: color-mix(in srgb, var(--accent) 28%, transparent); color: var(--accent); }
.toolbar {
  display: flex; flex-wrap: wrap; gap: 8px; align-items: center;
  padding: 8px; border: 1px solid var(--border); border-radius: 8px; background: var(--surface);
  margin-bottom: 12px;
}
.toolbar input {
  flex: 1; min-width: 12rem; border: 0; outline: 0; font: inherit; background: transparent; padding: 6px 8px;
}
.empty {
  text-align: center; padding: 32px 16px; border: 1px dashed var(--border);
  border-radius: 8px; color: var(--text-dim);
}
.empty strong { display: block; color: var(--text); font-size: 16px; margin-bottom: 6px; }
details {
  border: 1px solid var(--border); border-radius: 8px; padding: 12px 16px; background: var(--surface);
}
summary { cursor: default; font-weight: 500; }
.note {
  margin-top: 24px; padding: 12px 16px; border-left: 3px solid var(--accent);
  background: var(--accent-soft); font-size: 13px; color: var(--text-dim);
}
@media (max-width: 900px) {
  .app { grid-template-columns: 1fr; }
  .sidebar { display: none; }
  .kpi-grid, .card-grid { grid-template-columns: 1fr; }
}
</style>
</head>
<body>
<div class="app" data-shell-version="cairn-v2" data-testid="ds-shell-mock">
  <aside class="sidebar" data-testid="ds-sidebar">
    <div>
      <div class="brand">Cairn</div>
      <div class="brand-sub">Pusat kendali</div>
    </div>
    <nav aria-label="Control center">
      <a class="nav-item active" href="#">Ringkasan</a>
      <a class="nav-item" href="#">Rebuild</a>
      <a class="nav-item" href="#">Pekerjaan</a>
      <a class="nav-item" href="#">Prioritas</a>
      <div class="nav-label">Struktur</div>
      <a class="nav-item" href="#">Proyek</a>
      <a class="nav-item" href="#">Fitur</a>
      <div class="nav-label">Operasi</div>
      <a class="nav-item" href="#">Agen</a>
      <a class="nav-item" href="#">Operasi</a>
      <a class="nav-item" href="#">Keputusan</a>
      <a class="nav-item" href="#">Bukti</a>
    </nav>
  </aside>
  <div class="main">
    <header class="topbar">
      <div>
        <h1>Overview · Ringkasan</h1>
        <p>Posisi program, prioritas, dan keputusan yang butuh perhatian.</p>
      </div>
      <div class="search" data-testid="ds-cmdk">
        <span>Cari…</span>
        <span class="kbd" style="margin-left:auto">⌘K</span>
      </div>
    </header>
    <main class="content" id="view">
      <div class="content-inner" data-testid="ui-gallery">
        <p class="eyebrow">Design system</p>
        <h1 class="h1">Kit primitif Cairn</h1>
        <p class="sub">Referensi visual W-DS-FOUNDATION — tenang, tajam, terstruktur (Linear/Height/Vercel).</p>

        <section class="section">
          <h2 class="h2">Tombol &amp; status</h2>
          <div class="row">
            <span class="btn btn-primary">Primary</span>
            <span class="btn btn-secondary">Secondary</span>
            <span class="btn btn-ghost">Ghost</span>
            <span class="btn btn-danger">Danger</span>
            <span class="chip chip-done"><span class="dot"></span>Selesai</span>
            <span class="chip chip-ongoing"><span class="dot"></span>Berjalan</span>
            <span class="chip chip-warn"><span class="dot"></span>Tinjauan</span>
            <span class="chip chip-blocked"><span class="dot"></span>Terhambat</span>
            <span class="chip chip-pending"><span class="dot"></span>Menunggu</span>
          </div>
        </section>

        <section class="section">
          <h2 class="h2">KPI &amp; progres</h2>
          <div class="kpi-grid">
            <div class="kpi"><div class="lbl">Prioritas PROD_READY</div><div class="val">316</div></div>
            <div class="kpi"><div class="lbl">Produk terlacak</div><div class="val">602</div></div>
            <div class="kpi"><div class="lbl">Domain G5</div><div class="val">9/9</div></div>
          </div>
          <div class="bar ok"><i></i></div>
          <div class="bar"><i></i></div>
        </section>

        <section class="section">
          <h2 class="h2">Toolbar &amp; filter</h2>
          <div class="toolbar">
            <input placeholder="Cari tugas…" readonly />
            <span class="pill active">Semua</span>
            <span class="pill">Terbuka</span>
            <span class="btn btn-secondary" style="min-height:32px;padding:0 12px;font-size:13px">Ekspor</span>
          </div>
        </section>

        <section class="section">
          <h2 class="h2">Kartu</h2>
          <div class="card-grid">
            <div class="card">
              <h3>Kartu prioritas</h3>
              <p class="muted">Portofolio SALES_WEB_RELATED_BACKEND — surface + border 1px.</p>
            </div>
            <div class="card">
              <h3>Panel</h3>
              <p class="muted">Footer opsional; shadow hampir tidak dipakai.</p>
            </div>
          </div>
        </section>

        <section class="section">
          <h2 class="h2">Tabel</h2>
          <table>
            <thead><tr><th>ID</th><th>Judul</th><th>Status</th></tr></thead>
            <tbody>
              <tr><td class="mono">TASK-01</td><td>AppShell redesign</td><td><span class="chip chip-done"><span class="dot"></span>Selesai</span></td></tr>
              <tr><td class="mono">TASK-02</td><td>Overview primitives</td><td><span class="chip chip-ongoing"><span class="dot"></span>Berjalan</span></td></tr>
              <tr><td class="mono">TASK-03</td><td>Token AA pass</td><td><span class="chip chip-warn"><span class="dot"></span>Tinjauan</span></td></tr>
            </tbody>
          </table>
        </section>

        <section class="section">
          <h2 class="h2">Ringkasan (mock referensi)</h2>
          <div class="card" data-testid="overview-mock" style="margin-bottom:12px">
            <p class="eyebrow">Ringkasan Program</p>
            <h3 style="margin:0">Di mana posisi program sekarang?</h3>
            <p class="muted" style="margin-top:6px">Program sedang berjalan. Posisi kesiapan mengikuti evidence; bucket dipisah dari readiness.</p>
          </div>
          <div class="card-grid">
            <div class="card">
              <h3>Prioritas + progres bukti</h3>
              <div class="bar ok"><i></i></div>
              <p class="muted">316/316 PROD_READY · Alokasi mayoritas PASS</p>
            </div>
            <div class="card">
              <h3>Kesiapan program (global)</h3>
              <div class="bar"><i style="width:70%"></i></div>
              <p class="muted">G5 9/9 · denom produk terlacak</p>
            </div>
          </div>
        </section>

        <section class="section">
          <div class="empty">
            <strong>Belum ada pekerjaan</strong>
            Saat data hadir, daftar tampil dengan Table + Pagination + Toolbar.
          </div>
        </section>

        <section class="section">
          <details open>
            <summary>Detail teknis</summary>
            <code class="mono">boardRev=12 · pin=abc123 · hash=deadbeef</code>
          </details>
        </section>

        <p class="note">
          <strong>Jujur:</strong> shot ini merender galeri + chrome AppShell secara <em>statis</em>
          dari token CSS (styles.css :root), bukan live React/DB. Komponen sumber ada di
          <code>src/components/ui/*</code> dan Overview memakai primitif yang sama.
        </p>
      </div>
    </main>
  </div>
</div>
</body>
</html>`
}

async function shotStatic(browser) {
  const htmlPath = join(OUT, '_gallery.html')
  writeFileSync(htmlPath, galleryHtml())
  const viewports = [
    { name: 'desktop', width: 1440, height: 900 },
    { name: 'mobile', width: 390, height: 844 },
  ]
  for (const vp of viewports) {
    const context = await browser.newContext({
      viewport: { width: vp.width, height: vp.height },
      deviceScaleFactor: 1,
    })
    const page = await context.newPage()
    await page.goto(`file://${htmlPath}`, { waitUntil: 'load' })
    await page.screenshot({
      path: join(OUT, `gallery-primitives-${vp.name}.png`),
      fullPage: true,
    })
    await page.locator('[data-testid="ds-shell-mock"]').screenshot({
      path: join(OUT, `appshell-chrome-${vp.name}.png`),
    })
    await page.locator('[data-testid="overview-mock"]').screenshot({
      path: join(OUT, `overview-mock-${vp.name}.png`),
    })
    notes.push(`static ${vp.name}: gallery + appshell + overview mock OK`)
    await context.close()
  }
}

async function tryLivePreview(browser) {
  if (portInUse(PORT)) {
    notes.push(`port ${PORT} busy before start — skip live preview`)
    return
  }
  const distClient = join(ROOT, 'dist/client')
  if (!existsSync(distClient)) {
    notes.push('no dist/client — skip live preview')
    return
  }

  const child = spawn(
    'npx',
    ['vite', 'preview', '--host', '127.0.0.1', '--port', String(PORT)],
    {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, FORCE_COLOR: '0' },
    },
  )
  let ready = false
  const onData = (buf) => {
    const s = String(buf)
    if (/Local:|preview/i.test(s) || /http:\/\/127\.0\.0\.1:3314/.test(s)) ready = true
  }
  child.stdout?.on('data', onData)
  child.stderr?.on('data', onData)

  const deadline = Date.now() + 20000
  while (!ready && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 250))
    if (portInUse(PORT)) ready = true
  }

  if (!ready) {
    notes.push('live preview did not become ready')
    child.kill('SIGTERM')
    killPort(PORT)
    return
  }

  try {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      deviceScaleFactor: 1,
    })
    const page = await context.newPage()
    const resp = await page.goto(`http://127.0.0.1:${PORT}/login`, {
      waitUntil: 'networkidle',
      timeout: 30000,
    })
    await page.waitForTimeout(800)
    await page.screenshot({
      path: join(OUT, 'live-login-desktop.png'),
      fullPage: true,
    })
    notes.push(`live login http=${resp?.status() ?? 'null'} captured`)
    // Overview typically needs auth+DB — try and record honestly
    const ov = await page.goto(`http://127.0.0.1:${PORT}/b/mfs-rebuild/`, {
      waitUntil: 'domcontentloaded',
      timeout: 20000,
    }).catch((e) => {
      notes.push(`live overview navigate failed: ${e.message}`)
      return null
    })
    if (ov) {
      await page.waitForTimeout(1500)
      const url = page.url()
      await page.screenshot({
        path: join(OUT, 'live-overview-or-auth-desktop.png'),
        fullPage: true,
      })
      notes.push(`live overview attempt url=${url} http=${ov.status()}`)
    }
    await context.close()
  } finally {
    child.kill('SIGTERM')
    await new Promise((r) => setTimeout(r, 500))
    killPort(PORT)
    const still = portInUse(PORT)
    notes.push(still ? `WARN port ${PORT} still busy after kill` : `port ${PORT} clean after kill`)
  }
}

const browser = await chromium.launch({ headless: true })
try {
  await shotStatic(browser)
  await tryLivePreview(browser)
} finally {
  await browser.close()
  killPort(PORT)
}

writeFileSync(join(OUT, 'NOTES.md'), notes.map((n) => `- ${n}`).join('\n') + '\n')
console.log(JSON.stringify({ out: OUT, notes }, null, 2))
