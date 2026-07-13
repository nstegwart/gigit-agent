# Responsive Behavior — Task Manager

**Document class:** RESPONSIVE CONTRACT
**Authority:** ART-UX-DIRECTION (grid, mobile/tablet, zoom) + product shell CSS
**Tokens:** content width / spacing from `design/tokens/task-manager.tokens.json`

## 1. Breakpoints (ART grid)

| Band | Width | Columns | Gutter / margin |
|---|---|---|---|
| Desktop | ≥1200px | 12 | 32px / 32px |
| Tablet | 768–1199px | 8 | 24px / 24px |
| Mobile | ≤767px | 4 | 16px / 16px |

**Product shell today (implementation):** primary mobile shell at `max-width: 900px` and denser `560px` in `src/styles.css`. ART 767/1200 are the design target; product media queries are residual alignment work (not silently claimed equal).

## 2. Content width

| Role | Max width |
|---|---|
| App content (`.wrap`) | **1440px** |
| Overview working canvas | ~1200px (component) |
| Narrative / detail reading | 760px |

## 3. Shell behavior

| Viewport | Navigation | Chrome |
|---|---|---|
| Desktop | fixed ~240px left rail | full labels (nine-IA English today) |
| Tablet | collapse rail (product) | labels + 44×44 targets |
| Mobile | top bar + drawer / destinations | never icon-only mystery menu; touch ≥44×44 |

## 4. Mobile content rules (ART)

On mobile / narrow:

1. Stack narrative **before** metrics.
2. Preserve title / status / blocker / owner action / next / freshness.
3. One-column cards; vertical readiness rail.
4. Drawers full-screen.
5. Tables → labelled cards or explicit contained scroller (never page overflow).
6. Sticky actions must not obscure required content.
7. id-ID copy: flexible height + **~30% expansion** allowance; never ellipsize decisions, blockers, evidence meaning, or status sentences.

## 5. Tablet

At ~768px: two columns **only** when each column remains readable.

## 6. Zoom & reflow proof targets

Prove (separate E2E task — not this foundation):

- Widths: **320, 360, 390, 768, 1280, 1440**
- Browser zoom **200%**
- Zero clipped required human content; zero page-level unintended overflow

Harness pointers (reuse-first): `playwright.config.ts` projects 1440/1024/390/360; `qa/e2e/flows/viewports-matrix.mjs`, `zoom-200.mjs`.

## 7. Residual gaps (foundation)

- Product 900/560 breakpoints ≠ ART 767/1199 named bands.
- Playwright projects omit 320/768/1280 as first-class projects (documented residual).
- No runtime reflow proof in this task → **LOCAL ONLY**.
