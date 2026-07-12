// Inline SVG icon set (ported from the Cairn prototype). One component, theme-aware
// via currentColor. Kept local instead of lucide so the marks match the design exactly.
import type { SVGProps } from 'react'

export type IconName =
  | 'board' | 'agents' | 'projects' | 'features' | 'decisions' | 'log' | 'search'
  | 'sun' | 'moon' | 'arrow' | 'chevL' | 'play' | 'link' | 'ext' | 'check' | 'alert'
  | 'lock' | 'clock' | 'branch' | 'sparkles' | 'bolt' | 'terminal' | 'dot' | 'folder'
  | 'inbox' | 'layers' | 'flag' | 'users'

const PATHS: Record<IconName, string> = {
  board: '<path d="M4 4h7v7H4zM13 4h7v4h-7zM13 10h7v10h-7zM4 13h7v7H4z"/>',
  agents:
    '<rect x="4" y="4" width="16" height="16" rx="3"/><path d="M9 9h6v6H9z"/><path d="M9 2v2M15 2v2M9 20v2M15 20v2M2 9h2M2 15h2M20 9h2M20 15h2"/>',
  projects:
    '<path d="M12 3 3 8l9 5 9-5-9-5z"/><path d="m3 13 9 5 9-5M3 18l9 5 9-5" opacity=".55"/>',
  features:
    '<path d="M4 6h16M4 12h16M4 18h10"/><circle cx="19" cy="18" r="1.6" fill="currentColor" stroke="none"/>',
  decisions:
    '<circle cx="6" cy="6" r="2.4"/><circle cx="6" cy="18" r="2.4"/><path d="M6 8.5v7M8.4 6H15a3 3 0 0 1 3 3v1"/><circle cx="18" cy="12" r="2.4"/>',
  log: '<path d="M3 12h4l2 6 4-14 2 8h6"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.2-3.2"/>',
  sun: '<circle cx="12" cy="12" r="4.2"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M19.1 4.9l-1.4 1.4M6.3 17.7l-1.4 1.4"/>',
  moon: '<path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z"/>',
  arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  chevL: '<path d="M15 6l-6 6 6 6"/>',
  play: '<path d="M6 4l14 8-14 8z" fill="currentColor" stroke="none"/>',
  link: '<path d="M9 15l6-6M11 6l1-1a4 4 0 0 1 6 6l-1 1M13 18l-1 1a4 4 0 0 1-6-6l1-1"/>',
  ext: '<path d="M14 4h6v6M20 4l-9 9M18 13v6a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h6"/>',
  check: '<path d="M4 12l5 5 11-12"/>',
  alert: '<path d="M12 3 2 20h20L12 3z"/><path d="M12 10v4M12 17.5v.5" stroke-width="2"/>',
  lock: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 8v4.5l3 2"/>',
  branch:
    '<circle cx="6" cy="6" r="2.4"/><circle cx="6" cy="18" r="2.4"/><circle cx="18" cy="7" r="2.4"/><path d="M6 8.4v7.2M8.3 6.7c6 .6 6 3.3 6 5.3"/>',
  sparkles: '<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3z"/>',
  bolt: '<path d="M13 2 4 14h7l-1 8 9-12h-7l1-8z"/>',
  terminal: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="m7 9 3 3-3 3M13 15h4"/>',
  dot: '<circle cx="12" cy="12" r="4" fill="currentColor" stroke="none"/>',
  folder:
    '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  inbox:
    '<path d="M4 13h4l2 3h4l2-3h4"/><path d="M4 13 6 5h12l2 8v5a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z"/>',
  layers: '<path d="M12 3 3 8l9 5 9-5-9-5z"/>',
  flag: '<path d="M5 21V4M5 4h11l-2 3 2 3H5"/>',
  users:
    '<circle cx="9" cy="8" r="3"/><path d="M3 20a6 6 0 0 1 12 0M16 5.5a3 3 0 0 1 0 5.5M21 20a6 6 0 0 0-4-5.6"/>',
}

interface IconProps extends Omit<SVGProps<SVGSVGElement>, 'name'> {
  name: IconName
  size?: number
}

export function Icon({ name, size = 15, className, ...rest }: IconProps) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      dangerouslySetInnerHTML={{ __html: PATHS[name] }}
      {...rest}
    />
  )
}

export function BrandMark({ size = 30 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" aria-hidden="true">
      <ellipse cx="16" cy="25" rx="10" ry="3.2" fill="var(--accent)" opacity=".28" />
      <rect x="8" y="18" width="16" height="5" rx="2.5" fill="var(--accent)" />
      <rect x="10" y="12" width="12" height="5" rx="2.5" fill="var(--accent-2)" />
      <rect x="12" y="6.5" width="8" height="4.5" rx="2.25" fill="var(--accent)" />
    </svg>
  )
}
