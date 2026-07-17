# Component Inventory — Task Manager

**Document class:** COMPONENT / STATE INVENTORY
**Authority:** ART-UX-DIRECTION 01B § REQUIRED ARTIFACTS
**Tokens:** `design/tokens/task-manager.tokens.json`
**Standards:** `COMPONENT_STANDARDS.md`, `ART_DIRECTION.md`
**Status:** Inventory of **implemented** control-center surfaces (code + screenshot matrix cross-ref). Not a visual ship claim.

## 1. Purpose

Enumerate primary UI components, their required states, four-cue status coverage, and which ART screenshot IDs (S01–S24) exercise them. Coverage is **inventory + capture cross-ref**, not independent visual acceptance.

## 2. Shell & chrome

| Component                | Path                                                     | Role                                                                   | States                                                                   | S-ids                |
| ------------------------ | -------------------------------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------ | -------------------- |
| AppShell                 | `src/components/AppShell.tsx`                            | Nine-IA nav, board chrome, `initTheme()` boot                          | desktop sidebar / responsive top rail reflow @900/560; no drawer control | all board routes     |
| ControlCenterShellSearch | `src/components/AppShell.tsx`                            | Control-center command palette wiring plus legacy compatibility bridge | palette-only / compatibility producer / route reset                      | S15, S16 related     |
| CommandSearch            | `src/components/control-center/search/CommandSearch.tsx` | Search and navigation command dialog                                   | closed / open / query / recent / role-gated commands                     | S15, S16 related     |
| BoardLink                | `src/components/BoardLink.tsx`                           | Board-scoped links                                                     | default                                                                  | —                    |
| UserMenu                 | `src/components/UserMenu.tsx`                            | Session / account                                                      | open / closed                                                            | —                    |
| PageLoading              | `src/components/PageLoading.tsx`                         | Route-level load                                                       | loading                                                                  | S19 (related)        |
| PinnedSurface            | `src/components/control-center/PinnedSurface.tsx`        | Pin / revision envelope shell                                          | pinned / unpinned / partial                                              | S01–S24 (where used) |

**IA note:** Product nav is nine English destinations. ART five-nav id-ID labels (Ringkasan, Pekerjaan, …) are owner aliases — see `BRAND_DESIGN_SYSTEM_AUDIT.md` §5.

### 2.1 Command palette implementation inventory

| Dimension      | Current source-backed behavior                                                                                                                                                            | Acceptance boundary                                                                                       |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Components     | `AppShell` renders `ControlCenterShellSearch`, which wraps `CommandSearch` as the control-center shell trigger/dialog.                                                                    | Implemented in the current main tree; no stable production-build render is claimed.                       |
| Keyboard       | Opens with `/`, Ctrl+K, or Meta+K; ArrowUp / ArrowDown wrap selection; Enter activates; Escape closes. Slash is ignored while typing in an editable field.                                | Local source and unit-test support only; no manual keyboard filmstrip or accessibility-tree proof.        |
| Focus          | Opening focuses the combobox; closing or activation restores focus to the trigger.                                                                                                        | Rendered clipping, stacking, and full focus-order behavior remain unproven.                               |
| Recent queries | Stores and replays up to five local queries under **Terbaru**.                                                                                                                            | Browser persistence across real sessions was not exercised for this receipt.                              |
| RBAC           | Commands are navigation-only; members receive authenticated board navigation and admin-only `/admin/users` is exposed only to admins.                                                     | No provider, mutation, deploy, approve, or delete command is represented.                                 |
| Route safety   | Search links carry a validated same-board `returnTo` including filters, revision query, and fragment; cross-origin/cross-board values fail closed to the board root.                      | Real router navigation and public/staging parity were not exercised.                                      |
| Compatibility  | `/log`, `/tasks`, and project detail routes mirror palette typing into `uiStore.search`, then clear on close, activation, or route change; other control-center routes stay palette-only. | Compatibility behavior has unit support; prior-content survival still needs stable rendered verification. |

This inventory records implemented local behavior, not independent UI-B2 acceptance or shipment. No production build, stable server, screenshot, DOM/accessibility-tree traversal, or release-SHA visual proof is claimed.

## 3. Overview (Ringkasan)

| Component                | Path                                         | Role                                | Required states           | Four-cue      | S-ids            |
| ------------------------ | -------------------------------------------- | ----------------------------------- | ------------------------- | ------------- | ---------------- |
| Overview                 | `overview/Overview.tsx`                      | 5-second narrative home             | populated, stale          | n/a (compose) | S01, S02, S18    |
| AppSummaryBar            | `overview/AppSummaryBar.tsx`                 | Stage / freshness strip             | fresh, stale, error copy  | text primary  | S01, S02, S18    |
| SurfaceBanner            | `overview/SurfaceBanner.tsx`                 | Connection / data integrity banners | stale, integrity fail     | text + color  | S01, S18         |
| BucketStrip              | `overview/BucketStrip.tsx`                   | Work bucket counts                  | counts / zero             | pill + label  | S01, S02         |
| PriorityCard             | `overview/PriorityCard.tsx`                  | Priority outcome card               | ready / not / gap         | partial       | S01              |
| OngoingZeroClick         | `overview/OngoingZeroClick.tsx`              | Active work cards                   | populated / empty         | status cues   | S01              |
| NeedsYourDecision        | `overview/NeedsYourDecision.tsx`             | Decision asks                       | populated / empty         | text          | S01, S11 related |
| GlobalCard / LowerPanels | `overview/GlobalCard.tsx`, `LowerPanels.tsx` | Supporting panels                   | default                   | —             | S01              |
| OwnerHumanFields         | `overview/OwnerHumanFields.tsx`              | humanDisplay fields                 | present / MISSING_DISPLAY | text          | S01              |
| SemanticIcon             | `overview/SemanticIcon.tsx`                  | Stable status icons                 | per bucket                | **icon cue**  | S01, S07         |

## 4. Work (Pekerjaan)

| Component           | Path                           | Role                           | Required states                        | Four-cue                                    | S-ids                  |
| ------------------- | ------------------------------ | ------------------------------ | -------------------------------------- | ------------------------------------------- | ---------------------- |
| WorkScreen          | `work/WorkScreen.tsx`          | Work surface root              | loaded / loading / error / empty query | compose                                     | S03–S08, S19, S20, S24 |
| BucketTabs          | `work/BucketTabs.tsx`          | DONE…RECONCILIATION tabs       | selected per bucket                    | label + count                               | S03–S08                |
| WorkList            | `work/WorkList.tsx`            | Row list                       | populated / empty                      | —                                           | S03–S08, S24           |
| WorkRow             | `work/WorkRow.tsx`             | Task row                       | all buckets                            | text + icon + color + shape (partial shape) | S03, S07               |
| WorkStates          | `work/WorkStates.tsx`          | Loading skeleton, error, empty | loading, error, empty                  | text                                        | S19, S20, S24          |
| WorkPagination      | `work/WorkPagination.tsx`      | Page cursor                    | has-next / end                         | —                                           | residual               |
| OwnerHumanFields    | `work/OwnerHumanFields.tsx`    | Human title/outcome            | present / review required              | text                                        | S09                    |
| PinnedRevisionBadge | `work/PinnedRevisionBadge.tsx` | Pin hash badge                 | pinned                                 | mono secondary                              | —                      |
| StaleOverlayFilter  | `work/StaleOverlayFilter.tsx`  | Stale filter control           | on/off                                 | —                                           | residual               |
| labels              | `work/labels.ts`               | Bucket / state copy map        | id-ID + EN                             | —                                           | S03–S08                |

**Bucket → visual contract** (from `COMPONENT_STANDARDS.md` §5):

| Bucket                   | Owner label (id-ID) | Tokens                           | Shape cue         | Matrix |
| ------------------------ | ------------------- | -------------------------------- | ----------------- | ------ |
| DONE                     | Selesai             | `--done` / `--done-bg`           | solid left        | S03    |
| ONGOING                  | Sedang dikerjakan   | `--ongoing` / `--ongoing-bg`     | double left       | S04    |
| NEXT                     | Berikutnya          | `--next` / `--next-bg`           | notch / outline   | S05    |
| QUEUED                   | Menunggu giliran    | `--queued` / `--queued-bg`       | dashed left       | S06    |
| BLOCKED                  | Terhambat           | `--blocked` / `--blocked-bg`     | solid + reason    | S07    |
| RECONCILIATION(_PENDING) | Sedang dicocokkan   | `--reconcile` / `--reconcile-bg` | striped / outline | S08    |

## 5. Task detail

| Component        | Path                               | Role                               | States                                        | S-ids              |
| ---------------- | ---------------------------------- | ---------------------------------- | --------------------------------------------- | ------------------ |
| TaskDetailScreen | `task-detail/TaskDetailScreen.tsx` | Human-first task; technical expand | human default, `?mode=technical`, focus, zoom | S09, S10, S22, S23 |

## 6. Decisions (Keputusan)

| Component            | Path                                 | Role                                       | States            | S-ids |
| -------------------- | ------------------------------------ | ------------------------------------------ | ----------------- | ----- |
| DecisionsScreen      | `decisions/DecisionsScreen.tsx`      | Decision inbox                             | populated / empty | S11   |
| DecisionCard         | `decisions/DecisionCard.tsx`         | Inbox card                                 | pending actions   | S11   |
| DecisionDetailScreen | `decisions/DecisionDetailScreen.tsx` | Detail + actions                           | mobile detail     | S12   |
| decisionActions      | `decisions/decisionActions.ts`       | Setujui / Tolak / Minta penjelasan / Tunda | action set        | S12   |

## 7. Knowledge / Search / Documentation (ART routes)

| Component                 | Path                                          | Role                        | States                            | S-ids                                            |
| ------------------------- | --------------------------------------------- | --------------------------- | --------------------------------- | ------------------------------------------------ |
| KnowledgeDomainScreen     | `knowledge/KnowledgeDomainScreen.tsx`         | Domain knowledge            | available / unavailable / loading | S13, S14, S21                                    |
| KnowledgeConflictPanel    | `knowledge/KnowledgeConflictPanel.tsx`        | Conflict / redact           | conflict present / absent         | S21 (**residual:** not distinctly proven on pin) |
| SearchScreen              | `search/SearchScreen.tsx`                     | Semantic + technical search | results / empty                   | S15, S16                                         |
| DocumentationDomainScreen | `documentation/DocumentationDomainScreen.tsx` | Export / citations preview  | available / unavailable           | S17                                              |

## 8. Nine-IA surfaces (not ART S-ids; extras captured)

| Component               | Path                          | Role               | Extra PNG                     |
| ----------------------- | ----------------------------- | ------------------ | ----------------------------- |
| PriorityScreen + panels | `priority/*`                  | Portfolio priority | `extra-priority-1440x900.png` |
| ProjectsScreen          | `projects/ProjectsScreen.tsx` | Projects list      | `extra-projects-1440x900.png` |
| FeaturesScreen          | `features/FeaturesScreen.tsx` | Features / flows   | not captured this matrix      |
| AgentsScreen            | `agents/AgentsScreen.tsx`     | Agents / runs      | `extra-agents-1440x900.png`   |
| OpsScreen               | `ops/OpsScreen.tsx`           | Ops / accounts     | not captured                  |

## 9. Shared primitives & legacy (non–control-center)

| Component                  | Path                              | Notes                                                 |
| -------------------------- | --------------------------------- | ----------------------------------------------------- |
| primitives                 | `src/components/primitives.tsx`   | Shared UI atoms                                       |
| icons / BrandMark          | `src/lib/icons.tsx`               | Inline SVG; BrandMark ≠ approved logo                 |
| DecisionCard (legacy)      | `src/components/DecisionCard.tsx` | Pre–control-center; prefer `control-center/decisions` |
| TasksTable, ProjectCard, … | `src/components/*`                | Older surfaces; not primary ART matrix                |

## 10. State coverage matrix (ART release states)

| State                           | Primary components            | Captured?       | Notes                                          |
| ------------------------------- | ----------------------------- | --------------- | ---------------------------------------------- |
| Populated overview              | Overview compose              | **yes** S01/S02 | Content may still leak technical enums         |
| Work buckets (5 + reconcile)    | WorkScreen + tabs             | **yes** S03–S08 | S04–S06/S08 empty on pin (fail-closed BLOCKED) |
| Task human / technical          | TaskDetailScreen              | **yes** S09/S10 |                                                |
| Decision inbox / detail         | Decisions*                    | **yes** S11/S12 |                                                |
| Domain knowledge mobile/desktop | KnowledgeDomainScreen         | **yes** S13/S14 | content unavailable AFFILIATE                  |
| Search semantic / technical     | SearchScreen                  | **yes** S15/S16 |                                                |
| Documentation domain            | DocumentationDomainScreen     | **yes** S17     | content unavailable                            |
| Stale banner                    | SurfaceBanner / AppSummaryBar | **yes** S18     | Playwright fixture                             |
| Loading skeleton                | WorkStates                    | **yes** S19     | throttle fixture                               |
| Safe API error                  | WorkStates                    | **yes** S20     | forced error fixture                           |
| Knowledge conflict              | KnowledgeConflictPanel        | **partial** S21 | no distinct conflict UI on pin                 |
| Keyboard focus                  | TaskDetailScreen              | **partial** S22 | Tab×8 end-state only                           |
| Zoom 200%                       | TaskDetailScreen              | **yes** S23     | CSS zoom=2                                     |
| Empty query                     | WorkStates / WorkList         | **yes** S24     | 320×568                                        |

## 11. Four-cue status coverage (honest)

| Cue                                | Foundation              | Component reality                        |
| ---------------------------------- | ----------------------- | ---------------------------------------- |
| Text label                         | tokens + labels.ts      | present (often EN chrome; id-ID partial) |
| Icon                               | SemanticIcon + CSS      | present on key rows                      |
| Color pair FG/BG                   | ART tokens in CSS       | present                                  |
| Shape (left-rule / notch / dashed) | documented in standards | **partial** — residual component pass    |

## 12. Residual gaps (inventory-level)

1. Four-cue shapes incomplete in some Work/Overview rows.
2. humanDisplay still falls back to `CONTENT_REVIEW_REQUIRED` / `MISSING_DISPLAY` / raw enums (see prior capture MANIFESTs).
3. S21 conflict panel not distinctly exercised on staging pin.
4. Features / Ops / Evidence lack matrix PNGs (nine-IA extras only Priority/Projects/Agents).
5. Module CSS may still hard-code hex outside global tokens (audit residual).
6. Command palette source and unit support exist, but stable rendered, accessibility, and shipment acceptance remain unproven.

## 13. Related docs

- `COMPONENT_STANDARDS.md` — class API, motion, empty/error/stale
- `INTERACTION_NOTES.md` — keyboard, focus, motion, touch
- `RESPONSIVE_SCREENSHOT_MANIFEST.md` — unified S01–S24 machine manifest
- `SCREENSHOT_SPEC.md` — capture rules + route map
- `ACCESSIBILITY_STANDARD.md` — WCAG 2.2 AA target

## 14. UI-B6 token-lint coverage

The component inventory is now coupled to `scripts/design-token-lint.mjs`, which scans all ten CSS files rather than treating the global token block as proof of component adoption.

| CSS consumer                                    | Exact residual count | UI-B6 writable? |
| ----------------------------------------------- | -------------------: | --------------- |
| `src/styles.css`                                |                  498 | yes             |
| `control-center/agents/agents.module.css`       |                   68 | no              |
| `control-center/control-center-shell.css`       |                   36 | no              |
| `control-center/decisions/decisions.module.css` |                   80 | no              |
| `control-center/features/features.module.css`   |                   68 | no              |
| `control-center/ops/ops.module.css`             |                   55 | no              |
| `control-center/overview/overview.module.css`   |                   95 | no              |
| `control-center/priority/priority.module.css`   |                   80 | no              |
| `control-center/projects/projects.module.css`   |                   56 | no              |
| `control-center/work/work.module.css`           |                  209 | no              |

These are lint findings, not rendered-state verdicts. The current deterministic total remains 1,245 CSS residuals, including 747 across the nine module paths. Those module paths require a separately authorized cleanup packet and stable-render regression proof.

**Non-claim:** this inventory is not a stable production-build render, screenshot receipt, independent visual PASS, or shipment verdict.
