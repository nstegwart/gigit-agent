import type { FlowStatusClass } from './types'

/** Scrub technical IDs/enums/repo slugs for owner-facing id-ID display. */
export function scrubTechIds(s: string): string {
  return String(s || '')
    .replace(/\bFEAT-[A-Z0-9-]+\b/g, 'fitur terkait')
    .replace(/\bT-[A-Z0-9-]+\b/g, 'tugas terkait')
    .replace(/\bFC-[A-Z0-9-]+\b/g, 'kontrak fitur')
    .replace(/\bMAPPED_100\b/g, 'terbukti penuh')
    .replace(/\bPROD_READY\b/g, 'siap produksi')
    .replace(/\bMISSING\b/g, 'belum')
    .replace(
      /\b(mfs-web-original-upgrade|sales-rebuild|rebuild-backend|affiliate-rebuild|legacy\/[a-z0-9-]+)\b/g,
      'repo terkait',
    )
}

export function statusClass(st: string | undefined | null): FlowStatusClass {
  if (st === 'terbukti' || st === 'ok' || st === 'MAPPED_100') return 'ok'
  if (st === 'belum' || st === 'bad' || st === 'MISSING' || st === 'blocked')
    return 'bad'
  return 'warn'
}

export function statusLabel(st: string | undefined | null): string {
  const c = statusClass(st)
  if (c === 'ok') return 'Terbukti'
  if (c === 'bad') return 'Belum'
  return 'Sebagian'
}

export function verdictLabel(v: string | undefined | null): string {
  if (!v) return 'Sebagian'
  if (v === 'MAPPED_100' || /terbukti|ok|proven|verified/i.test(v)) return 'Terbukti'
  if (/MISSING|belum|blocked|missing/i.test(v)) return 'Belum'
  return 'Sebagian'
}

/** Canonical node-card meta line (id-ID). */
export function formatNodeMeta(
  screens: number,
  pct: number | undefined | null,
): string {
  const p = pct == null || Number.isNaN(Number(pct)) ? 0 : Number(pct)
  if (screens > 0) return `${screens} layar · ${p}% terverifikasi`
  return `${p}% terverifikasi`
}

/**
 * Convert graph-built EN meta leftovers to id-ID for visible display.
 * Does not touch API METHOD + /path blocks (those never appear in meta).
 */
export function humanizeNodeMeta(meta: string | undefined | null): string {
  let s = String(meta || '').trim()
  if (!s) return ''
  // "3 screens · 80%" → "3 layar · 80% terverifikasi"
  s = s.replace(/\b(\d+)\s+screens?\b/gi, '$1 layar')
  if (/\d+\s*%/.test(s) && !/%\s*terverifikasi/i.test(s)) {
    s = s.replace(/(\d+)\s*%/g, '$1% terverifikasi')
  }
  // already-id or bare percent
  if (/^\d+\s*%\s*$/.test(s)) {
    s = s.replace(/(\d+)\s*%/, '$1% terverifikasi')
  }
  return s.replace(/\s+/g, ' ').trim()
}

export function humanizeScreen(raw: string | undefined | null): string {
  if (!raw) return 'Layar'
  let s = scrubTechIds(String(raw))
    .replace(/^\/+/, '')
    .replace(/\[.*?\]/g, '')
    .replace(/\{.*?\}/g, '')
    .replace(/[_/.-]+/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim()
  if (!s) return 'Layar'
  const map: Record<string, string> = {
    login: 'Masuk',
    register: 'Daftar',
    auth: 'Autentikasi',
    premium: 'Premium',
    checkout: 'Checkout',
    meditation: 'Meditasi',
    workout: 'Latihan',
    admin: 'Admin',
    sales: 'Sales',
    affiliate: 'Afiliasi',
    home: 'Beranda',
    profile: 'Profil',
    payment: 'Pembayaran',
    success: 'Berhasil',
    account: 'Akun',
    dashboard: 'Dasbor',
    discover: 'Jelajah',
    listing: 'Daftar',
    detail: 'Detail',
    settings: 'Pengaturan',
    voucher: 'Voucher',
    promo: 'Promo',
  }
  const words = s.split(' ').map((w) => {
    const low = w.toLowerCase()
    if (map[low]) return map[low]
    if (/^[A-Z0-9]{2,}$/.test(w) && w.length > 4) {
      return w.charAt(0) + w.slice(1).toLowerCase()
    }
    if (/^[a-z]/.test(w)) return w.charAt(0).toUpperCase() + w.slice(1)
    return w
  })
  return words.join(' ')
}

export function humanizeTaskTitle(t: string | undefined | null): string {
  if (!t) return 'Tugas'
  let s = scrubTechIds(String(t))
    .replace(/^T-[A-Z0-9-]+\s*/i, '')
    .replace(/[_/]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (s === s.toUpperCase() && /[A-Z]{4,}/.test(s)) {
    s = s
      .toLowerCase()
      .split(' ')
      .map((w) =>
        w.length <= 3 ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1),
      )
      .join(' ')
  }
  return s || 'Tugas'
}

export function humanizeTitle(raw: string | undefined | null): string {
  if (!raw) return 'Langkah'
  let s = scrubTechIds(String(raw).trim())
  s = s.replace(/^\/[a-zA-Z0-9._\-\[\]{}/*]+(?:\s*[—–-]\s*)?/, (m) => {
    const pathPart = m
      .replace(/[—–-]\s*$/, '')
      .replace(/^\/+/, '')
      .split('/')[0]
    return humanizeScreen(pathPart) + (m.match(/[—–-]/) ? ' — ' : ' ')
  })
  s = s.replace(/\s+/g, ' ').trim()
  if (s && /^[a-z]/.test(s)) s = s.charAt(0).toUpperCase() + s.slice(1)
  return s || 'Langkah'
}

/** Allowed technical surface: HTTP METHOD + absolute path. */
const API_ENDPOINT_RE =
  /\b(GET|POST|PUT|PATCH|DELETE)\s+(\/[A-Za-z0-9._~\-/{}\[\]:*]+)/gi

/** Strip allowed API METHOD + /path blocks before leak scanning. */
export function stripAllowedApiEndpoints(text: string): string {
  return String(text || '').replace(API_ENDPOINT_RE, ' ')
}

/** True when a display string still exposes technical IDs (gate helper). */
export function hasTechIdLeak(text: string): boolean {
  const t = String(text || '')
  return (
    /\bFEAT-[A-Z0-9-]+\b/.test(t) ||
    /\bT-[A-Z0-9-]{4,}\b/.test(t) ||
    /\bFC-[A-Z0-9-]+\b/.test(t) ||
    /\bMAPPED_100\b/.test(t) ||
    /\bPROD_READY\b/.test(t) ||
    /\bMISSING\b/.test(t) ||
    /\b(mfs-web-original-upgrade|sales-rebuild|rebuild-backend|affiliate-rebuild|legacy\/[a-z0-9-]+)\b/.test(
      t,
    )
  )
}

/**
 * Scan visible owner text for forbidden technical IDs, ignoring allowed
 * API METHOD + /path endpoints.
 */
export function hasVisibleTechIdLeak(text: string): boolean {
  return hasTechIdLeak(stripAllowedApiEndpoints(text))
}
