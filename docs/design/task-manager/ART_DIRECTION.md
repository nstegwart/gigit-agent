# ART Direction — Task Manager (Human Operations Editorial Control Center)

**Document class:** ART DIRECTION
**Authority:** `ART-UX-DIRECTION.md` PART 2
**Token source:** `design/tokens/task-manager.tokens.json`
**CSS entry:** `src/styles.css`
**Brand audit:** `BRAND_DESIGN_SYSTEM_AUDIT.md`
**Status:** FOUNDATION (LOCAL ONLY — no visual ship claim)

## 1. Named concept

**Human Operations Editorial Control Center**

Feel: calm, trustworthy, premium, clear, humane, focused.
Premium = disciplined type, spacing, alignment, language — not effects.

## 2. Expressly reject (primary visual language)

- Generic admin-dashboard template
- Cyberpunk / NOC / war-room / terminal aesthetic
- Neon accents, glowing or **pulsing** status lights
- Glassmorphism, translucent cards, blurred backplates
- **Decorative gradients**
- KPI-wall clutter / equally loud metric tiles
- Tiny dense “power user” type as primary
- Raw JSON / log / code-editor aesthetic as primary
- Excessive pills, shadows, borders, competing accents

## 3. Color mode

- **Light-first required.**
- Dark mode is optional only with full parity (every route, component, state, chart, evidence, focus, screenshot, contrast gate).
- **This foundation:** incomplete dark is **not** shipped. `src/styles.css` reasserts light ART tokens for `data-theme="dark"` and non-light roots so the existing AppShell toggle does not produce a half-mapped dark UI.
- AppShell toggle **not edited** (write scope). Full dark map = future task.

## 4. Fallback tokens applied

| Role | Hex | CSS var |
|---|---|---|
| canvas | `#F7F8FA` | `--bg` |
| surface | `#FFFFFF` | `--surface` |
| surfaceSubtle | `#F1F4F7` | `--surface-2` |
| textStrong | `#17202A` | `--text` |
| textDefault | `#344054` | `--text-dim` |
| textMuted | `#52606D` | `--text-faint` |
| borderDefault | `#CDD5DF` | `--border` |
| borderStrong | `#98A2B3` | `--border-strong` |
| action | `#175CD3` | `--accent` |
| actionHover | `#1849A9` | `--accent-2` |
| focusRing | `#2E90FA` | `--focus-ring` / `--accent-bright` |
| done | `#067647` / `#ECFDF3` | `--done` / `--done-bg` (+ `--ok`) |
| ongoing | `#175CD3` / `#EFF8FF` | `--ongoing` / `--info` |
| next | `#6941C6` / `#F4F3FF` | `--next` / `--next-bg` |
| queued | `#344054` / `#F2F4F7` | `--queued` / `--parked` |
| blocked | `#B42318` / `#FEF3F2` | `--blocked` |
| reconcile | `#B54708` / `#FFFAEB` | `--reconcile` / `--warn` |

Every token metadata: `source=fallback`, `reviewer=pending`, contrast ratio recorded programmatically.

## 5. Typography

- Stack: Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif
- Body default: **16px / 1.5**
- Weights: 400 body, 500 emphasis, **≤600 headings/status** (no 700)
- Mono only for technical disclosure

## 6. Spacing / grid / width

- 4px base: 4, 8, 12, 16, 24, 32, 48, 64
- Desktop ≥1200: 12 col / 32 gutter / 32 margin
- Tablet 768–1199: 8 / 24
- Mobile ≤767: 4 / 16
- App content max: **1440px** (`.wrap`)
- Reading column max: 760px (component-level)

## 7. Shape / elevation

- Controls 8px, cards 12px, panels 16px
- Elevation none by default; restrained shadow for floating chrome
- No decorative hero gradient (`--bg-hero: none`)

## 8. Semantic status (four cues)

Each work state: plain text + stable icon + semantic color pair + shape/pattern. Never color-only dots.

| State (id-ID) | Colors | Shape cue |
|---|---|---|
| Selesai | done | solid left rule |
| Sedang dikerjakan | ongoing | double left rule |
| Berikutnya | next | top notch / outlined |
| Menunggu giliran | queued | dashed left rule |
| Terhambat | blocked | solid border + reason |
| Sedang dicocokkan | reconcile | striped / outlined |

HOLD / EXCLUDE: labelled dispositions, quieter, never hidden.
Work bucket ≠ mapping/product/program readiness.

## 9. Shell / IA conflict (mandatory)

ART primary nav (id-ID): Ringkasan, Pekerjaan, Keputusan, Pengetahuan, Operasi.
**Implemented parent IA:** nine English screens (see audit §5).

**Conflict is explicit:** this foundation does **not** rewrite AppShell. Owner id-ID names are aliases/documentation for copy and future i18n. Nine-IA routes and class API remain.

## 10. Path map (required ART artifacts ↔ this repo)

| ART required path | This foundation path | Status |
|---|---|---|
| `docs/design/task-manager/BRAND_DESIGN_SYSTEM_AUDIT.md` | same | written |
| `docs/design/task-manager/ART_DIRECTION.md` | same | written |
| `design/tokens/task-manager.tokens.json` | same | written |
| `docs/design/task-manager/COMPONENT_INVENTORY.md` | `COMPONENT_STANDARDS.md` | mapped (allowed write) |
| `docs/design/task-manager/INTERACTION_NOTES.md` | section in `COMPONENT_STANDARDS.md` + `ACCESSIBILITY_STANDARD.md` | mapped |
| `docs/design/task-manager/RESPONSIVE_SCREENSHOT_MANIFEST.md` | `RESPONSIVE_BEHAVIOR.md` + `SCREENSHOT_SPEC.md` | mapped |
| `docs/design/task-manager/BEFORE_AFTER.md` | residual in audit + this file §4 | foundation only |

## 11. Non-claims

- Not visual DONE. No staging screenshot matrix this task.
- Not independent FABLE critique.
- Not dark-mode ship.
- Module CSS hex cleanup out of scope.
- `NOT SHIPPABLE: no visual proof`
