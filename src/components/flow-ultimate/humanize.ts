import type { FlowStatusClass } from './types'

export function scrubTechIds(s: string): string {
  return String(s || '')
    .replace(/\bFEAT-[A-Z0-9-]+\b/g, 'related feature')
    .replace(/\bT-[A-Z0-9-]+\b/g, 'related task')
    .replace(/\bFC-[A-Z0-9-]+\b/g, 'feature contract')
    .replace(/\bMAPPED_100\b/g, 'fully proven')
    .replace(/\bPROD_READY\b/g, 'production ready')
    .replace(/\bMISSING\b/g, 'missing')
    .replace(
      /\b(mfs-web-original-upgrade|sales-rebuild|rebuild-backend|affiliate-rebuild|legacy\/[a-z0-9-]+)\b/g,
      'related repo',
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
  if (c === 'ok') return 'Proven'
  if (c === 'bad') return 'Missing'
  return 'Partial'
}

export function verdictLabel(v: string | undefined | null): string {
  if (!v) return 'Partial'
  if (v === 'MAPPED_100' || /terbukti|ok|proven/i.test(v)) return 'Proven'
  if (/MISSING|belum|blocked|missing/i.test(v)) return 'Missing'
  return 'Partial'
}

export function humanizeScreen(raw: string | undefined | null): string {
  if (!raw) return 'Screen'
  let s = scrubTechIds(String(raw))
    .replace(/^\/+/, '')
    .replace(/\[.*?\]/g, '')
    .replace(/\{.*?\}/g, '')
    .replace(/[_/.-]+/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim()
  if (!s) return 'Screen'
  const map: Record<string, string> = {
    login: 'Login',
    register: 'Register',
    auth: 'Auth',
    premium: 'Premium',
    checkout: 'Checkout',
    meditation: 'Meditation',
    workout: 'Workout',
    admin: 'Admin',
    sales: 'Sales',
    affiliate: 'Affiliate',
    home: 'Home',
    profile: 'Profile',
    payment: 'Payment',
    success: 'Success',
    account: 'Account',
    dashboard: 'Dashboard',
    discover: 'Discover',
    listing: 'Listing',
    detail: 'Detail',
    settings: 'Settings',
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
  if (!t) return 'Task'
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
  return s || 'Task'
}

export function humanizeTitle(raw: string | undefined | null): string {
  if (!raw) return 'Step'
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
  return s || 'Step'
}

/** True when a display string still exposes technical IDs (gate helper). */
export function hasTechIdLeak(text: string): boolean {
  return (
    /\bFEAT-[A-Z0-9-]+\b/.test(text) ||
    /\bT-[A-Z0-9-]{4,}\b/.test(text) ||
    /\bFC-[A-Z0-9-]+\b/.test(text) ||
    /\bMAPPED_100\b/.test(text) ||
    /\bPROD_READY\b/.test(text)
  )
}
