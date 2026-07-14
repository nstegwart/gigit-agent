# ART Screenshot Capture — 2026-07-14 (first real captures)

**Status:** PARTIAL real capture. 8 of 24 ART S-ids + 3 additional nine-IA surfaces.
Not the full S01-S24 matrix — see `docs/design/task-manager/SCREENSHOT_SPEC.md` for
remaining gaps (several ART-canonical routes have no product route yet: knowledge
domains, search, documentation export; loading/error/stale-fixture states not
attempted this pass).

## Capture parameters (all shots)

- Target: `http://127.0.0.1:33211` (isolated staging Docker stack, `cairn-tm-v3`)
- Release SHA at capture time: `e23ff1cc67c26e9cfb23e362b7f01e7747ea4608` (current HEAD,
  proven via authenticated `/api/healthz` schema/deployedSha match immediately prior)
- Board: `mfs-rebuild` (SYNTH STAGING) — synthetic fixture data only, no real user data
- Auth: real session cookie (`cairn_session`), seeded via a fresh `sessions` row bound to
  the pre-existing staging e2e admin user `e2e_owner_ba1f2754` (role `admin`) — no
  password reset, no new identity created; token discarded after capture
- Browser: Playwright `1.61.1`, Chromium (Chrome for Testing 149.0.7827.55)
- Locale/timezone: container default (not pinned this pass — gap for future formal capture)
- Captured: 2026-07-14T10:5x UTC (see individual file mtimes)
- HTTP status: 200 on all 8 routes; zero browser console `pageerror` events on any route

## Files

| File | ART id | Route | Viewport |
|---|---|---|---|
| S01-overview-1440x900.png | S01 | `/b/mfs-rebuild/` | 1440×900 |
| S02-overview-390x844.png | S02 | `/b/mfs-rebuild/` | 390×844 |
| S03-work-done-1280x800.png | S03 | `/b/mfs-rebuild/work?bucket=DONE` | 1280×800 |
| S07-work-blocked-1280x800.png | S07 | `/b/mfs-rebuild/work?bucket=BLOCKED` | 1280×800 |
| S11-decisions-1280x800.png | S11 | `/b/mfs-rebuild/decisions` | 1280×800 |
| extra-priority-1440x900.png | n/a (nine-IA §3) | `/b/mfs-rebuild/priority` | 1440×900 |
| extra-projects-1440x900.png | n/a (nine-IA §3) | `/b/mfs-rebuild/projects` | 1440×900 |
| extra-agents-1440x900.png | n/a (nine-IA §3) | `/b/mfs-rebuild/agents` | 1440×900 |

## Findings (visual inspection, this session)

**Foundation confirmed live and working:**
- Light-first canvas/surface tokens, blue action color, no cyberpunk/neon/glass/pulse —
  matches `ART_DIRECTION.md` §2-4 reject list and fallback tokens.
- Nine-IA English nav labels + id-ID page-title aliases both render together
  ("Overview · Ringkasan", "Work · Pekerjaan", "Priority · Prioritas") — matches the
  documented alias-not-replace resolution in `BRAND_DESIGN_SYSTEM_AUDIT.md` §5.
  390px mobile reflow is clean, no overflow/broken layout observed.
- BLOCKED status uses an icon + colored pill + label (partial four-cue), not a bare dot.

**Real gap confirmed (this is the actual remaining ART-UX Part 1 work, not the token
layer)**: raw technical enum/error strings leak directly into primary user-facing copy
instead of being translated through the `humanDisplay` content contract:
- Decision card body shows literal `CONTENT_REVIEW_REQUIRED` as a pill AND the row title
  reads as a technical fragment, not a plain-language outcome sentence.
- Overview "NEEDS YOUR DECISION" section and the DATA_INTEGRITY block show raw
  `SCREAMING_SNAKE_CASE` reason codes and a raw sentence fragment
  ("DATA_INTEGRITY: No valid V3 classification receipts on board tasks; fail-closed
  UNCLASSIFIED → BLOCKED:DATA_INTEGRITY") directly as body copy.
- The Priority screen is markedly more raw/technical than Overview or Work — dense
  `snake_case`/`SCREAMING_CASE` field labels, unformatted denominator dumps, e.g.
  "productDenominator=0 — readiness must stay null / N-A ..." shown verbatim to the
  reader rather than through a human sentence.

**Conclusion:** the token/CSS/IA foundation (ART_DIRECTION.md, already committed at
`f4fd3c8`) is genuinely applied and visually coherent. The outstanding ART-UX Part 1 gap
is concentrated in **content**, not visual styling: per-entity `humanDisplay` fields
(title/outcome/whyItMatters/currentState/nextAction/blockerSummary/ownerAction) are not
yet computed/rendered for decisions, tasks, or the Priority rollup — components are
falling back to raw technical/control-plane strings. This narrows the remaining Part 1
scope precisely: it is a content-generation + template-application task per screen/entity
type, not a from-scratch visual design task.

## Non-claims

- NOT the full S01-S24 matrix (8/24 IDs + 3 extra; loading/error/stale-fixture/knowledge/
  search/documentation/keyboard/zoom states not attempted).
- NOT a FABLE critique.
- NOT an accessibility gate run.
- NOT a claim that Part 1 (human content) is done — this evidence identifies precisely
  where it is *not* done.
