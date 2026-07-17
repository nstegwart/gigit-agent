# Interaction Notes — Task Manager

**Document class:** INTERACTION / MICROINTERACTION NOTES
**Authority:** ART-UX-DIRECTION 01B § REQUIRED ARTIFACTS; WCAG 2.2 AA
**Related:** `COMPONENT_STANDARDS.md` §6–7, `ACCESSIBILITY_STANDARD.md`, `RESPONSIVE_BEHAVIOR.md`
**Status:** Design contract + code-aligned notes. Runtime a11y/axe ship gate is separate.

## 1. Principles

1. **Calm operations** — motion supports comprehension; never decorative pulse as status.
2. **One primary action** per card or decision row.
3. **Keyboard parity** — every primary owner action reachable without a pointer.
4. **Visible focus** — `--focus-ring`; its programmatically recomputed 3.24:1 surface contrast passes the non-text UI threshold.
5. **Reduced motion** — honor `prefers-reduced-motion: reduce`.
6. **No thrash** — freshness/live updates must not steal screen-reader focus repeatedly.

## 2. Timing & easing

| Event                         | Duration  | Easing   | Notes                              |
| ----------------------------- | --------- | -------- | ---------------------------------- |
| hover / focus / press         | 120–160ms | ease-out | color/border only preferred        |
| expand / collapse             | 160–200ms | ease     | task technical disclosure, details |
| drawer / page context         | 200–240ms | ease     | mobile nav drawer                  |
| max without functional reason | ≤300ms    | —        | hard ceiling                       |
| reduced motion                | 0–80ms    | none     | no transform animation             |

**Forbidden motion:** permanent pulsing live status, parallax, post-load shimmer, confetti, auto-carousel.

Shell zeroes interactive transitions and disables spinner transforms/animation under `prefers-reduced-motion: reduce` (`src/styles.css`). Permanent status pulse was removed from the global stylesheet.

## 3. Focus model

| Rule                     | Detail                                                                                                   |
| ------------------------ | -------------------------------------------------------------------------------------------------------- |
| Ring                     | `outline` / soft ring via `--focus-ring`; never remove outline without replacement                       |
| Order                    | Overview: stage → priority → ongoing → next → blocker/decision; Work: tabs → filters → rows → pagination |
| Skip links               | Prefer main landmark; residual if missing on a route                                                     |
| Drawers                  | Focus trap + Escape + restore focus to opener (component contract)                                       |
| Modal / decision actions | Initial focus on primary safe action or heading; trap while open                                         |

**Matrix proof:** S22 captures Tab×8 end-state on task detail (single frame — not a multi-frame filmstrip). Full focus-order filmstrip remains residual.

## 4. Keyboard map (product + ART target)

| Context                | Key                                | Behavior                                                                                                                     |
| ---------------------- | ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Global                 | Tab / Shift+Tab                    | Move focus along narrative order                                                                                             |
| Global                 | Enter / Space                      | Activate focused control                                                                                                     |
| Global                 | Escape                             | Close drawer / dismiss overlay; return focus                                                                                 |
| Work list              | Enter on row                       | Open task detail                                                                                                             |
| Task detail            | Tab                                | Cycle primary actions → human fields → technical expander                                                                    |
| Task detail technical  | Enter on expander                  | Expand/collapse technical IDs (`?mode=technical` deep-link also works)                                                       |
| Decisions              | Enter on card                      | Open detail; actions via buttons                                                                                             |
| Search                 | Enter in field                     | Submit query                                                                                                                 |
| Tables (Features etc.) | keyboard sort + visible sort state | residual completeness per surface                                                                                            |
| ART command palette    | `/`, Ctrl+K, or Meta+K             | Implemented locally; opens the command/search dialog. Stable rendered and release-bound accessibility proof remain residual. |

## 5. Pointer / touch

| Rule                 | Detail                                                               |
| -------------------- | -------------------------------------------------------------------- |
| Mobile targets       | ≥ **44×44** interactive hit area @ product shell ≤900px              |
| Desktop icon buttons | ≥36×36; prefer 44 where possible                                     |
| Sticky bars          | Must not cover required human content (title, blocker, owner action) |
| Hover                | Never the only way to reveal blocker/owner action                    |

## 6. Surface-specific interactions

### Overview

- Cards are zero-click readable: title, status sentence, next action visible without expand.
- Decision section links into Decisions inbox/detail.
- Stale: amber banner (`--warn` / `--warn-bg`) + last valid time + refresh; **does not** auto-steal focus (S18).

### Work

- Bucket tabs are the primary filter; URL `?bucket=` is the deep link contract.
- Empty bucket: honest empty copy + safe next (not fake rows) — S04–S06/S08 on current pin.
- Loading: skeleton matching final row layout (S19).
- Error: human cause/impact/retry; trace ID secondary (S20).
- Free-text `?query=` zero-result: teach human + technical search (S24 @ 320×568).

### Task detail

- Default = human-first fields; technical IDs behind expander or `?mode=technical` (S09/S10).
- Zoom 200%: no required content clip / page-level overflow (S23 via CSS zoom=2).
- Keyboard focus sequence residual beyond single end-state (S22).

### Decisions

- Actions (id-ID): Setujui, Tolak, Minta penjelasan, Tunda.
- Mobile detail (S12 @ 390×844): actions remain tappable ≥44×44.

### Knowledge / Documentation

- Unavailable domain: honest gap list, not blank or spinner forever (S13/S14/S17).
- Conflict: show both sources; block certainty claims — **component exists** (`KnowledgeConflictPanel`); **not distinctly proven** on AFFILIATE pin (S21 residual).

### Search

- Semantic query (S15) and technical id/alias (S16) share one results surface.
- Empty results: instructional copy, not hard error.

### Command palette / shell search

- `AppShell` renders `ControlCenterShellSearch`, which wraps `CommandSearch` as the single visible control-center search trigger.
- Open from `/`, Ctrl+K, or Meta+K. Slash does not steal input while a person is typing in an editable field.
- ArrowUp / ArrowDown wrap through commands; Enter activates; Escape closes; focus moves into the combobox on open and returns to the trigger on close.
- Up to five recent queries are stored locally and replayed from the **Terbaru** group.
- Commands are navigation-only. Member sessions receive authenticated board navigation; admin-only chrome such as `/admin/users` is omitted unless the role is admin.
- Search navigation preserves same-board path, filters, revision query, and fragment through a validated `returnTo`; cross-origin or cross-board values fail closed to the current board root.
- Compatibility routes (`/log`, `/tasks`, and project detail routes) mirror palette typing into the legacy search store and clear it on close, activation, or route change. Other control-center routes remain palette-only.
- These behaviors have local source and unit-test support only. No stable production-build render, screenshot, manual focus traversal, accessibility-tree proof, or shipment verdict is claimed here.

## 7. Live regions & screen readers

| Event               | Live region policy                 |
| ------------------- | ---------------------------------- |
| Critical load error | `role="alert"` or assertive once   |
| Stale banner        | `role="status"` polite             |
| Freshness tick      | **do not** announce every second   |
| Bucket count change | polite optional; not on every poll |

Landmarks: shell `aside` (nav) + `main`. Headings hierarchical per page (`h1` page title).

## 8. Form / filter interactions

| Control              | Behavior                                                 |
| -------------------- | -------------------------------------------------------- |
| Search field         | Submit on Enter; clear control restores default list     |
| Bucket tabs          | Update URL + list without full app remount when possible |
| Pagination           | Preserve bucket + query; announce page change politely   |
| Stale overlay filter | Explicit user control; default shows truth               |

## 9. Error recovery paths

| Failure                      | Owner-visible path                            |
| ---------------------------- | --------------------------------------------- |
| Network / API envelope error | Message + Retry (S20)                         |
| Stale pin / data             | Banner + Refresh (S18)                        |
| Permission denied            | Explicit “no access” copy — never blank       |
| Conflict knowledge           | Both sources + blocked certainty (S21 target) |

## 10. Reduced motion checklist

- [x] No continuous pulse in `src/styles.css`
- [x] Global reduced-motion block removes transforms and continuous animation
- [x] Global loader animation is disabled under reduced motion
- [ ] Module CSS is clean — deterministic lint still finds two pulsing-status rules and ten >300ms motions outside the UI-B6 write fence

## 11. Matrix cross-ref (interaction-heavy S-ids)

| ID  | Interaction under test                    |
| --- | ----------------------------------------- |
| S18 | Stale banner persistent + non-destructive |
| S19 | Loading skeleton under throttle           |
| S20 | Error + recovery affordance               |
| S22 | Keyboard focus end-state                  |
| S23 | 200% zoom reflow                          |
| S24 | Empty query honesty @ 320                 |

## 12. Residual gaps

1. Command palette is implemented locally, but stable production-build rendering, release-bound accessibility verification, and shipment acceptance remain unproven.
2. Multi-frame keyboard filmstrip not captured (S22 single frame).
3. Full axe + manual SR pass bound to release SHA not claimed here.
4. Graph/dependency keyboard path residual (`WireGraph` legacy).
5. S21 conflict interaction not proven on current staging pin.
6. Deterministic design lint still reports 1,245 CSS residuals, including 747 across nine module paths outside the UI-B6 write fence.

## 13. Non-claims

- Not an independent accessibility verifier receipt.
- Not a claim that all nine-IA screens meet ship gate.
- Not a stable production-build render or screenshot receipt; the documented command palette is not accepted for shipment.
- Interaction durations are the **design contract**; CSS may still differ in module styles until cleanup.
