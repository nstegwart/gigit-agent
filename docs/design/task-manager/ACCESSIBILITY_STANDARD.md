# Accessibility Standard — Task Manager

**Document class:** A11Y STANDARD
**Authority:** ART-UX-DIRECTION § ACCESSIBILITY RELEASE GATE; WCAG 2.2 AA
**Tokens:** `design/tokens/task-manager.tokens.json` (contrast matrix)
**Status:** foundation + program contrast only (no axe/browser claim this task)

## 1. Target

Meet **WCAG 2.2 AA** across named routes/states:

- Contrast (text + non-text UI)
- Keyboard + visible focus
- Landmarks / headings
- Names / roles / states
- Screen-reader updates (restrained; no freshness thrash)
- Errors, reduced motion, touch targets, reflow, 200% zoom
- **Color is never the sole signal**

## 2. Contrast (foundation — program proven)

Program: Node relative-luminance (WCAG sRGB) → `.artifact/art-token-contrast-proof.json`.

| Pair class | Gate | Result (this session) |
|---|---|---|
| Body/UI text on surface/canvas/subtle | ≥4.5:1 | **PASS** (textStrong/Default/Muted, action, status FGs) |
| Semantic FG on semantic BG | ≥4.5:1 | **PASS** (done, ongoing, next, queued, blocked, reconcile) |
| Focus ring `#2E90FA` on white | ≥3:1 non-text UI | **PASS** (3.24:1); not used as body text |

`reviewer: pending` remains on token metadata until independent design review.

## 3. Focus

- Visible focus using `--focus-ring` (`#2E90FA`) ring tokens.
- Focus order follows visual narrative (Overview story order).
- Drawers: focus trap, Escape, focus return (component contract).

## 4. Keyboard

- All primary actions reachable without pointer.
- Tables: keyboard sort + visible sort state.
- Command palette (ART): `/` and Cmd/Ctrl+K — **not implemented this task** (residual).
- Graph/dependency views: keyboard path + text tree alternative (residual).

## 5. Touch

- Minimum **44×44** interactive targets on mobile shell (product CSS @ ≤900px).
- Sticky bars must not cover required content.

## 6. Motion

Honor `prefers-reduced-motion: reduce` (shell already zeroes transitions / blink).
No pulsing status as permanent language.

## 7. Screen reader

- Landmarks: shell aside + main.
- Live regions for critical errors only; freshness updates do not spam.
- Status uses text label, not color alone.

## 8. Language / locale

- Default owner language **id-ID** for human copy.
- Technical IDs secondary.
- Dates: `id-ID`; absolute in detail, relative in summary (content system residual).

## 9. Verification ladder

| Layer | This foundation | Ship gate |
|---|---|---|
| Token contrast program | **yes** | required |
| Typecheck / build | **yes** | required |
| axe on routes | no | required |
| Manual keyboard / SR | no | required |
| Visual pair / screenshot | no | required |

## 10. Residual gaps

- Historical axe serious/critical findings on prior SHA (see audit workers) not re-run on HEAD.
- Four-cue shapes incomplete in components.
- Theme toggle still present in AppShell while CSS is light-locked (document for a11y testers: appearance stays light).
