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

| Pair class                            | Gate             | Result (this session)                                      |
| ------------------------------------- | ---------------- | ---------------------------------------------------------- |
| Body/UI text on surface/canvas/subtle | ≥4.5:1           | **PASS** (textStrong/Default/Muted, action, status FGs)    |
| Semantic FG on semantic BG            | ≥4.5:1           | **PASS** (done, ongoing, next, queued, blocked, reconcile) |
| Focus ring `#2E90FA` on white         | ≥3:1 non-text UI | **PASS** (3.24:1); not used as body text                   |

`reviewer: pending` remains on token metadata until independent design review.

## 3. Focus

- Visible focus using `--focus-ring` (`#2E90FA`) ring tokens.
- Focus order follows visual narrative (Overview story order).
- Drawers: focus trap, Escape, focus return (component contract).

## 4. Keyboard

- All primary actions reachable without pointer.
- Tables: keyboard sort + visible sort state.
- Command palette (implemented locally): `/`, Ctrl+K, or Meta+K opens the dialog;
  `/` does not steal focus from an editable field.
- Palette focus moves to the combobox on open and returns to its trigger on
  close. ArrowUp / ArrowDown wrap options, Enter activates, and Escape closes.
- Palette commands are navigation-only. Authenticated board navigation is
  available to members; `/admin/users` is added only for admins.
- Search routes preserve a validated same-board return path, filters, revision
  query, and fragment. Cross-origin or cross-board return values fail closed to
  the current board root.
- Palette behavior has source and focused unit-test support only; manual browser
  keyboard, focus, screen-reader, and accessibility-tree proof remains residual.
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

| Layer                    | This foundation | Ship gate |
| ------------------------ | --------------- | --------- |
| Token contrast program   | **yes**         | required  |
| Typecheck / build        | **yes**         | required  |
| axe on routes            | no              | required  |
| Manual keyboard / SR     | no              | required  |
| Visual pair / screenshot | no              | required  |

## 10. Residual gaps

- Historical axe serious/critical findings on prior SHA (see audit workers) not re-run on HEAD.
- Four-cue shapes incomplete in components.
- AppShell calls `initTheme()` but renders no source-owned theme toggle. CSS
  remains light-locked; a user-facing theme control and full dark-mode
  accessibility parity are future work.
- Deterministic design lint still reports 1,245 CSS residual rows, including 747
  across nine separately fenced control-center module styles.
- No stable production-build render, screenshot, manual keyboard/focus traversal,
  accessibility-tree proof, or shipment acceptance is claimed by this document.
