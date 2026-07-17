# Responsive Screenshot Manifest — Task Manager (S01–S24)

**Document class:** MACHINE / HUMAN UNIFIED MANIFEST  
**Authority:** ART-UX-DIRECTION 01B § EXACT STAGING SCREENSHOT MATRIX + § REQUIRED ARTIFACTS  
**Status:** Unified index of real PNG evidence across two capture folders.  
**This doc is the single S01–S24 machine manifest** for design/docs consumers.  
**Related:** `SCREENSHOT_SPEC.md` (rules + route map), folder MANIFESTs under `.artifact/`.

## 1. Capture identity (combined program)

| Field | Value |
|---|---|
| Product board | `mfs-rebuild` (SYNTH STAGING) |
| Product route prefix | `/b/mfs-rebuild` (ART top-level paths map 1:1 under board) |
| Locale target | `id-ID` |
| Timezone (wave1) | `Asia/Jakarta` |
| Browser | Playwright 1.61.1 · Chromium / Chrome for Testing **149.0.7827.55** |
| Auth role | admin e2e user `e2e_owner_ba1f2754` on synth board only |
| Prior capture folder | `.artifact/art-screenshots-2026-07-14/` |
| Wave1 capture folder | `.artifact/art-screenshots-wave1/` |
| Prior release SHA | `e23ff1cc67c26e9cfb23e362b7f01e7747ea4608` |
| Wave1 release SHA | `867b9b57cccfe79aebbd6b8858aac52e624241f4` |
| OWNER_TARGET (wave1) | `{base_url=http://127.0.0.1:33211, port=33211, account=e2e_owner_ba1f2754, device=chromium-playwright}` |

**SCOPE_CONTRADICTION:** ART canonical URLs are top-level (`/work`, `/knowledge`, …). Product implements board-scoped nine-IA (`/b/{boardId}/…`). Manifest records **both** ART URL and product route.

## 2. Unified matrix S01–S24

| ID | ART URL | Product route | Viewport | Intent | Folder | File | Capture SHA (container) | Fixture method | Payload hash | Content note |
|---|---|---|---|---|---|---|---|---|---|---|
| S01 | `/` | `/b/mfs-rebuild/` | 1440×900 | Overview fresh | prior | `S01-overview-1440x900.png` | e23ff1cc… | none — live | — | populated; enum leak residual |
| S02 | `/` | `/b/mfs-rebuild/` | 390×844 | Overview mobile | prior | `S02-overview-390x844.png` | e23ff1cc… | none — live | — | mobile reflow |
| S03 | `/work?bucket=DONE` | `/b/mfs-rebuild/work?bucket=DONE` | 1280×800 | Selesai | prior | `S03-work-done-1280x800.png` | e23ff1cc… | none — live | — | bucket surface |
| S04 | `/work?bucket=ONGOING` | `/b/mfs-rebuild/work?bucket=ONGOING` | 1280×800 | Active owner | wave1 | `S04-work-ongoing-1280x800.png` | 867b9b57… | none — live | — | **empty bucket** (fail-closed BLOCKED) |
| S05 | `/work?bucket=NEXT` | `/b/mfs-rebuild/work?bucket=NEXT` | 1280×800 | Next + reason | wave1 | `S05-work-next-1280x800.png` | 867b9b57… | none — live | — | **empty bucket** |
| S06 | `/work?bucket=QUEUED` | `/b/mfs-rebuild/work?bucket=QUEUED` | 1280×800 | Queue | wave1 | `S06-work-queued-1280x800.png` | 867b9b57… | none — live | — | **empty bucket** |
| S07 | `/work?bucket=BLOCKED` | `/b/mfs-rebuild/work?bucket=BLOCKED` | 1280×800 | Blocker | prior | `S07-work-blocked-1280x800.png` | e23ff1cc… | none — live | — | populated BLOCKED |
| S08 | `/work?bucket=RECONCILIATION` | `/b/mfs-rebuild/work?bucket=RECONCILIATION_PENDING` | 390×844 | Reconcile | wave1 | `S08-work-reconciliation-390x844.png` | 867b9b57… | none — live | — | empty; alias `RECONCILIATION` also 200 |
| S09 | `/work/<taskId>` | `/b/mfs-rebuild/work/task-ongoing-1` | 1280×800 | Human detail | wave1 | `S09-work-task-human-1280x800.png` | 867b9b57… | none — live | — | human-first |
| S10 | `/work/<taskId>?mode=technical` | `/b/mfs-rebuild/work/task-ongoing-1?mode=technical` | 1280×800 | Technical expand | wave1 | `S10-work-task-technical-1280x800.png` | 867b9b57… | none — live | — | mode works |
| S11 | `/decisions` | `/b/mfs-rebuild/decisions` | 1280×800 | Decision inbox | prior | `S11-decisions-1280x800.png` | e23ff1cc… | none — live | — | populated inbox |
| S12 | `/decisions/<id>` | `/b/mfs-rebuild/decisions/dec-v3-001` | 390×844 | Decision actions | wave1 | `S12-decision-detail-390x844.png` | 867b9b57… | none — live | — | route gap closed |
| S13 | `/knowledge/domains/AFFILIATE` | `/b/mfs-rebuild/knowledge/domains/AFFILIATE` | 1440×900 | Domain knowledge | wave1 | `S13-knowledge-affiliate-1440x900.png` | 867b9b57… | none — live | — | route OK; content unavailable |
| S14 | same as S13 | same | 390×844 | Domain mobile | wave1 | `S14-knowledge-affiliate-390x844.png` | 867b9b57… | none — live | — | mobile domain |
| S15 | `/search?q=pembayaran%20affiliate` | `/b/mfs-rebuild/search?q=checkout` | 1280×800 | Semantic result | wave1 | `S15-search-semantic-1280x800.png` | 867b9b57… | none — live | — | ART query string differs; product used seeded term |
| S16 | `/search?q=T-AFF-N16-…` | `/b/mfs-rebuild/search?q=task-ongoing-1` | 1280×800 | Technical alias | wave1 | `S16-search-technical-alias-1280x800.png` | 867b9b57… | none — live | — | technical id search |
| S17 | `/documentation/domains/AFFILIATE` | `/b/mfs-rebuild/documentation/domains/AFFILIATE` | 1280×800 | Export preview | wave1 | `S17-documentation-affiliate-1280x800.png` | 867b9b57… | none — live | — | content unavailable |
| S18 | `/` stale | `/b/mfs-rebuild/` + stale fixture | 1280×800 | Stale banner | wave1 | `S18-overview-stale-1280x800.png` | 867b9b57… | SSR/`_serverFn` rewrite stale | `1ffafdda50c6c8cd580e919c9ccb0be49f42164168cb84d8c1ffd46ce28dba73` | fixture |
| S19 | `/work` loading | work + throttle | 1280×800 | Skeleton | wave1 | `S19-work-loading-1280x800.png` | 867b9b57… | fetch delay 15s; shot ~1.5s | `4a9aba72d91992b653a7256d6496228f0f5285cc5f6d7049168353452c6ec72f` | fixture |
| S20 | `/work` error | work + API fail | 1280×800 | Safe error | wave1 | `S20-work-error-1280x800.png` | 867b9b57… | force envelope error | `20e2cc1f04bf405b069ecca84473aadbdeb80228a7120d587ab348fb632d8cc7` | fixture |
| S21 | knowledge conflict | `/b/mfs-rebuild/knowledge/domains/AFFILIATE` | 1280×800 | Conflict/redact | wave1 | `S21-knowledge-conflict-1280x800.png` | 867b9b57… | no conflict inject | `df6fb3cff0f8d6fcd5c25103b66f163ff102e54b96d1485414a21c600d78d3ef` | **no distinct conflict UI** |
| S22 | task keyboard | `/b/mfs-rebuild/work/task-ongoing-1` | 1280×800 | Focus sequence | wave1 | `S22-task-keyboard-focus-1280x800.png` | 867b9b57… | Tab×8 end-state | `sha256(Tabx8@work/task-ongoing-1)` | single frame |
| S23 | task zoom 200% | `/b/mfs-rebuild/work/task-ongoing-1` | 1280×800 | Zoom | wave1 | `S23-task-zoom-200-1280x800.png` | 867b9b57… | CSS zoom=2 | `sha256(css-zoom:2)` | not OS chrome zoom |
| S24 | `/work?query=<zero>` | `/b/mfs-rebuild/work?query=zero-match-xyz-noresults` | 320×568 | Empty | wave1 | `S24-work-empty-query-320x568.png` | 867b9b57… | none — live | — | honest empty |

### Path resolution (relative to repo root)

```
.artifact/art-screenshots-2026-07-14/S01-overview-1440x900.png
.artifact/art-screenshots-2026-07-14/S02-overview-390x844.png
.artifact/art-screenshots-2026-07-14/S03-work-done-1280x800.png
.artifact/art-screenshots-wave1/S04-work-ongoing-1280x800.png
.artifact/art-screenshots-wave1/S05-work-next-1280x800.png
.artifact/art-screenshots-wave1/S06-work-queued-1280x800.png
.artifact/art-screenshots-2026-07-14/S07-work-blocked-1280x800.png
.artifact/art-screenshots-wave1/S08-work-reconciliation-390x844.png
.artifact/art-screenshots-wave1/S09-work-task-human-1280x800.png
.artifact/art-screenshots-wave1/S10-work-task-technical-1280x800.png
.artifact/art-screenshots-2026-07-14/S11-decisions-1280x800.png
.artifact/art-screenshots-wave1/S12-decision-detail-390x844.png
.artifact/art-screenshots-wave1/S13-knowledge-affiliate-1440x900.png
.artifact/art-screenshots-wave1/S14-knowledge-affiliate-390x844.png
.artifact/art-screenshots-wave1/S15-search-semantic-1280x800.png
.artifact/art-screenshots-wave1/S16-search-technical-alias-1280x800.png
.artifact/art-screenshots-wave1/S17-documentation-affiliate-1280x800.png
.artifact/art-screenshots-wave1/S18-overview-stale-1280x800.png
.artifact/art-screenshots-wave1/S19-work-loading-1280x800.png
.artifact/art-screenshots-wave1/S20-work-error-1280x800.png
.artifact/art-screenshots-wave1/S21-knowledge-conflict-1280x800.png
.artifact/art-screenshots-wave1/S22-task-keyboard-focus-1280x800.png
.artifact/art-screenshots-wave1/S23-task-zoom-200-1280x800.png
.artifact/art-screenshots-wave1/S24-work-empty-query-320x568.png
```

**Count:** 24/24 S-ids have at least one PNG path above.

## 3. PNG sha256 (program-emitted at doc assembly)

### Prior folder (`.artifact/art-screenshots-2026-07-14/`)

```
b662c0bb98c7d8f213b15a9eee0b3bd938b594a1647849ae9769d24c6087aa93  S01-overview-1440x900.png
dfc8784aab48fd41cd3cc3b3bd5f0b4c32c6dc71023073606b15acdec5bc74f9  S02-overview-390x844.png
159af5a1de42973ca19eacaf20a6ae67ef56a75f5a5ca6f93012bb6db9bc3216  S03-work-done-1280x800.png
e16a304143c42430be6c0060778afcdc23f8773c91327d98734af846c8c3b545  S07-work-blocked-1280x800.png
b7f09f793e4bb2af1e7d577cb9a792ee243252d864022b342f17582b9e45c68f  S11-decisions-1280x800.png
f5c5831a7d9922a5d0009c328b30af03b874b854c76d669ba37f95f6a85e90f1  extra-agents-1440x900.png
9ccbac41e121cec5aa9c42143b5155add82a39d9956df71ff6659b03f121ccbd  extra-priority-1440x900.png
3320162394be722431191bd831b8cddde83d91a4f9a1194f89b0cefef5e110b3  extra-projects-1440x900.png
```

### Wave1 folder (`.artifact/art-screenshots-wave1/`)

```
9c38ebed0a07b5890604c7cbc24d61b402f4209b6983a356c7f731100e88dc5a  S04-work-ongoing-1280x800.png
5eea0f682aa70acda87859e0c149b43bffe13052dbbd477eacb44ced7e18cc3f  S05-work-next-1280x800.png
2cc15a58b90b1f1a89f24ee9528f8c4f5588ba74429f5f0dd2313159ec923f52  S06-work-queued-1280x800.png
636925b93cfa543ffd2746890c2f51199138d8af8a9dd733150480c3b20bed47  S08-work-reconciliation-390x844.png
a89c72d238283152da46badaf8ffb8055d240d885a11dc13a28b895125546a71  S09-work-task-human-1280x800.png
16416b4fc1444fdb814944ff8be77fb73bf747931249ab04cb3f97b0da9ae813  S10-work-task-technical-1280x800.png
ef1d9f78b9140f8033ef4157122273472771f9da5ee8bcdb27cf38bb967acfdb  S12-decision-detail-390x844.png
4ac3bce9f43cff6b86759638fcdb23d3a985d2b3bcfa61cfa1505df2dc072756  S13-knowledge-affiliate-1440x900.png
fbe3cb8a579350693102d601625632d9dd951783d0d944edb0de00db6c0dce08  S14-knowledge-affiliate-390x844.png
041bcf1e47185d716ed7c798a4033388661713d5aa7d07f18c1f321bc889816d  S15-search-semantic-1280x800.png
c9690bba81bd676a5ebeec17d9a47feac750160108fe7788de803fb0c7799478  S16-search-technical-alias-1280x800.png
012d23d8eddbc6723969fe3b9f9e5a9870c91d431463ef197728b9ed025feb63  S17-documentation-affiliate-1280x800.png
c6b8276535b546ca650653eccb9b5795b63e016b05ad2b8e2277d05427d91a98  S18-overview-stale-1280x800.png
7921c9693ef792cff2bb60067fdc65445139d2888def1836d4f678ab6f9d0e57  S19-work-loading-1280x800.png
0f3e082f105c744c31de748a16564b4d806fb818a489563b0425aa897fb5c025  S20-work-error-1280x800.png
d96c28315571a59d070571d33181e9cfa33e4bfde279b0f2a56657f02e992818  S21-knowledge-conflict-1280x800.png
88f3ff4ae02d165904e36fda219472a3d1c411e859f8f8a99509b0a0d59579e4  S22-task-keyboard-focus-1280x800.png
d936f4b014246ddc7024f3b8d7fc440bc3631cabd7f5b554edaa341bf0b2bb63  S23-task-zoom-200-1280x800.png
2bb658c729002908f19a84c16e2aa52352c60f8774622caf809973f9b2c153d0  S24-work-empty-query-320x568.png
```

## 4. Viewport band coverage

| Band | Widths in matrix | S-ids |
|---|---|---|
| Desktop wide | 1440 | S01, S13 |
| Desktop | 1280 | S03–S07, S09–S11, S15–S23 |
| Mobile large | 390 | S02, S08, S12, S14 |
| Mobile small | 320 | S24 |

**ART proof widths still residual as full automated reflow suite:** 360, 768 (see `RESPONSIVE_BEHAVIOR.md`). Matrix itself hits 320, 390, 1280, 1440.

## 5. Nine-IA extras (not S-ids)

| File | Route | Viewport | Folder |
|---|---|---|---|
| `extra-priority-1440x900.png` | `/b/mfs-rebuild/priority` | 1440×900 | prior |
| `extra-projects-1440x900.png` | `/b/mfs-rebuild/projects` | 1440×900 | prior |
| `extra-agents-1440x900.png` | `/b/mfs-rebuild/agents` | 1440×900 | prior |

Not captured: Features, Ops, Evidence (mobile variants for Priority/Projects/Agents also residual).

## 6. Source folder MANIFESTs

| Folder | Doc | Scope |
|---|---|---|
| `.artifact/art-screenshots-2026-07-14/MANIFEST.md` | Prior pass params + findings | S01, S02, S03, S07, S11 + extras |
| `.artifact/art-screenshots-wave1/MANIFEST.md` | Wave1 params, fixtures, hashes | S04–S06, S08–S10, S12–S24 |

This file **unifies** both into one S01–S24 table. Do not treat either folder alone as complete.

## 7. Visual regression gate (contract)

- Pinned Chromium / fonts / OS for future baseline compare.  
- Unexpected `maxDiffPixelRatio` > **0.002** fails.  
- Baseline replace only with reviewer receipt.  
- Pair proof: design reference + device/browser shot (VISUAL_GATE v1).  

**This manifest does not claim** that baselines are reviewer-approved for ship.

## 8. Residual gaps (content / quality — not missing S-id files)

1. S04–S06/S08 empty buckets on pin (DATA_INTEGRITY → BLOCKED).  
2. AFFILIATE knowledge/documentation unavailable content.  
3. S21 no distinct conflict/redact UI on capture.  
4. S22 single Tab end-state, not filmstrip.  
5. S15/S16 product query strings ≠ ART example strings (seeded board data).  
6. Prior pass locale/timezone not pinned (wave1 is).  
7. Prior vs wave1 **different release SHAs** — not a single-SHA full matrix recapture.  
8. Human copy enum leaks (`CONTENT_REVIEW_REQUIRED`, etc.) remain on several surfaces.

## 9. Verdict language

```
FUNCTIONAL: 24/24 S-ids have real PNG paths in this unified manifest;
content residual on buckets/domains/S21/S22; dual-SHA capture history.
NOT: independent visual ship gate, FABLE resolution, or production proof.
```

## 10. Machine checklist (S-ids present in this document)

S01 S02 S03 S04 S05 S06 S07 S08 S09 S10 S11 S12 S13 S14 S15 S16 S17 S18 S19 S20 S21 S22 S23 S24
