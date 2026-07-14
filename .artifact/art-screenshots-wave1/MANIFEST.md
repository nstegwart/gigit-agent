# ART Screenshot Capture — wave1 (2026-07-14)

**Status:** Wave1 real capture of remaining ART S-ids against live staging.
**Prior evidence:** `.artifact/art-screenshots-2026-07-14/` holds S01, S02, S03, S07, S11 + 3 nine-IA extras.
**This folder:** S04–S06, S08–S10, S12–S24 (19 PNGs). Combined with prior folder → **24/24** S-ids have at least one real PNG.

## Capture parameters (all shots)

- **OWNER_TARGET:** `{base_url=http://127.0.0.1:33211, port=33211, account=e2e_owner_ba1f2754, device=chromium-playwright}`
- Target: `http://127.0.0.1:33211` (isolated staging Docker stack `cairn-tm-v3-app`, image tag `867b9b57cccfe79aebbd6b8858aac52e624241f4`)
- Release SHA at capture time: `867b9b57cccfe79aebbd6b8858aac52e624241f4` (matches container `CAIRN_DEPLOYED_SHA` / authenticated `/api/healthz` `deployedSha` + `release.match=true`)
- Board: `mfs-rebuild` (SYNTH STAGING) — synthetic fixture data only, no real user data
- Auth: real session cookie (`cairn_session`), seeded via a fresh `sessions` row bound to the pre-existing staging e2e admin user `e2e_owner_ba1f2754` (role `admin`) — no password reset, no new identity created; token discarded after capture (local file removed; DB sessions for that user cleared)
- Browser: Playwright `1.61.1`, Chromium (Chrome for Testing **149.0.7827.55**)
- Locale: `id-ID` · Timezone: `Asia/Jakarta` (pinned via Playwright context)
- Role / redaction: admin on synth board only; no production; canary tokens appear only as already-seeded synth fixtures
- Captured: 2026-07-14T11:56–12:02 UTC
- HTTP: document navigation returned 200 on all routes attempted (overview uses 307→200 trailing-slash redirect)
- Console `pageerror`: none observed on populated captures

Health probe (authenticated) excerpt:

```json
{"schemaVersion":"MFS_HEALTHZ_V1","status":"ok","deployedSha":"867b9b57cccfe79aebbd6b8858aac52e624241f4","release":{"sha":"867b9b57cccfe79aebbd6b8858aac52e624241f4","match":true},"schema":{"version":"007","match":true}}
```

## Files

| File | ART id | Route | Viewport | State fixture method | Payload hash |
|---|---|---|---|---|---|
| S04-work-ongoing-1280x800.png | S04 | `/b/mfs-rebuild/work?bucket=ONGOING` | 1280×800 | none — real staging work envelope | — |
| S05-work-next-1280x800.png | S05 | `/b/mfs-rebuild/work?bucket=NEXT` | 1280×800 | none — real staging work envelope | — |
| S06-work-queued-1280x800.png | S06 | `/b/mfs-rebuild/work?bucket=QUEUED` | 1280×800 | none — real staging work envelope | — |
| S08-work-reconciliation-390x844.png | S08 | `/b/mfs-rebuild/work?bucket=RECONCILIATION_PENDING` | 390×844 | none — product canonical bucket (ART alias `RECONCILIATION` also HTTP 200) | — |
| S09-work-task-human-1280x800.png | S09 | `/b/mfs-rebuild/work/task-ongoing-1` | 1280×800 | none — real task pin | — |
| S10-work-task-technical-1280x800.png | S10 | `/b/mfs-rebuild/work/task-ongoing-1?mode=technical` | 1280×800 | none — `mode=technical` on work task route | — |
| S12-decision-detail-390x844.png | S12 | `/b/mfs-rebuild/decisions/dec-v3-001` | 390×844 | none — real synth decision `dec-v3-001` | — |
| S13-knowledge-affiliate-1440x900.png | S13 | `/b/mfs-rebuild/knowledge/domains/AFFILIATE` | 1440×900 | none — live knowledge domain projection | — |
| S14-knowledge-affiliate-390x844.png | S14 | `/b/mfs-rebuild/knowledge/domains/AFFILIATE` | 390×844 | none — live knowledge domain projection | — |
| S15-search-semantic-1280x800.png | S15 | `/b/mfs-rebuild/search?q=checkout` | 1280×800 | none — real search over pinned board data | — |
| S16-search-technical-alias-1280x800.png | S16 | `/b/mfs-rebuild/search?q=task-ongoing-1` | 1280×800 | none — real search technical id | — |
| S17-documentation-affiliate-1280x800.png | S17 | `/b/mfs-rebuild/documentation/domains/AFFILIATE` | 1280×800 | none — live documentation domain projection | — |
| S18-overview-stale-1280x800.png | S18 | `/b/mfs-rebuild/` | 1280×800 | Playwright document + `_serverFn` rewrite: SSR `stale:!1→!0`, `freshnessAgeSeconds:0→99999`, `staleReason` string; seroval special-ref false(`s:3`)→true(`s:2`) | `1ffafdda50c6c8cd580e919c9ccb0be49f42164168cb84d8c1ffd46ce28dba73` |
| S19-work-loading-1280x800.png | S19 | `/b/mfs-rebuild/work?bucket=ONGOING` | 1280×800 | Playwright route: delay fetch/xhr 15s; screenshot at t≈1.5s (skeleton) | `4a9aba72d91992b653a7256d6496228f0f5285cc5f6d7049168353452c6ec72f` |
| S20-work-error-1280x800.png | S20 | `/b/mfs-rebuild/work?bucket=ONGOING` | 1280×800 | Playwright `_serverFn`: force `result.error={code:ART_S20_FORCED_ERROR,message}` + `surfaceState=error` (seroval); HTTP 200 | `20e2cc1f04bf405b069ecca84473aadbdeb80228a7120d587ab348fb632d8cc7` |
| S21-knowledge-conflict-1280x800.png | S21 | `/b/mfs-rebuild/knowledge/domains/AFFILIATE` | 1280×800 | none successful for conflict injection (no `conflicts[]` field in live envelope) — captured live knowledge domain | `df6fb3cff0f8d6fcd5c25103b66f163ff102e54b96d1485414a21c600d78d3ef` (no-mutation) |
| S22-task-keyboard-focus-1280x800.png | S22 | `/b/mfs-rebuild/work/task-ongoing-1` | 1280×800 | Playwright `keyboard.press('Tab')` ×8 end-state (not multi-frame filmstrip) | `sha256(Tabx8@work/task-ongoing-1)` |
| S23-task-zoom-200-1280x800.png | S23 | `/b/mfs-rebuild/work/task-ongoing-1` | 1280×800 | `document.body.style.zoom = 2` via `page.evaluate` | `sha256(css-zoom:2)` |
| S24-work-empty-query-320x568.png | S24 | `/b/mfs-rebuild/work?query=zero-match-xyz-noresults` | 320×568 | none — real work route free-text query zero match | — |

PNG sha256 (this session):

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

## Route-gap corrections (stale doc claims refuted live)

These product routes **exist and return HTTP 200** on the running stack (SHA `867b9b57…`). Route files:

| ART | Claimed gap (old SCREENSHOT_SPEC) | Verified product route | Route file | Live check |
|---|---|---|---|---|
| S12 | decision detail route gap | `/b/mfs-rebuild/decisions/dec-v3-001` | `src/routes/b.$boardId.decisions.$decisionId.tsx` | HTTP 200, decision detail UI renders |
| S13/S14/S21 | no product route / knowledge gap | `/b/mfs-rebuild/knowledge/domains/AFFILIATE` | `src/routes/b.$boardId.knowledge.domains.$domain.tsx` | HTTP 200, honest unavailable domain surface |
| S15/S16 | search route gap | `/b/mfs-rebuild/search?q=…` | `src/routes/b.$boardId.search.tsx` | HTTP 200, results list renders |
| S17 | documentation route gap | `/b/mfs-rebuild/documentation/domains/AFFILIATE` | `src/routes/b.$boardId.documentation.domains.$domain.tsx` | HTTP 200, domain surface renders |
| S09/S10 | tasks path / mode param gap | `/b/mfs-rebuild/work/$taskId` (+ `?mode=technical`) | `src/routes/b.$boardId.work.$taskId.tsx` | HTTP 200; technical mode expands ids |
| S08 | RECONCILIATION alias gap | product bucket `RECONCILIATION_PENDING` | work search schema + `normalizeStatusBucket` | HTTP 200 for both alias and canonical |

## Findings (this session)

1. **Bucket content is fail-closed BLOCKED:** ONGOING/NEXT/QUEUED/RECONCILIATION counts are 0; BLOCKED=8. Staging synth tasks exist (`task-ongoing-1`, etc.) but control-plane classification fail-closed (`DATA_INTEGRITY: No valid V3 classification receipts…`) maps them into BLOCKED. S04–S06/S08 screenshots are **truthful empty-bucket surfaces**, not populated owner worklists.
2. **S10 technical mode works** on `/work/$taskId?mode=technical` (shows taskId, bucket, projectId, lifecycleStage, etc.). Spec’s old `tasks/…?mode=technical` param-gap is obsolete for the ART-aligned work route.
3. **S18/S19/S20 fixtures verified visually:** stale banner + CONNECTION Stale + FRESHNESS 1d; work skeleton rows; “Could not load work” + `ART_S20_FORCED_ERROR`.
4. **S13/S14/S17 content gap:** routes live, but AFFILIATE domain has no pinned domain data (`Status: unavailable` / honest gap list). Not a route gap.
5. **S21 residual:** no dedicated conflict/redact UI observable; capture is the knowledge domain surface (same as S13 at 1280). Conflict injection found no `conflicts[]` field to mutate.
6. **S22 residual:** single end-state after Tab×8, not a multi-frame focus-sequence filmstrip.
7. **Content contract gap (unchanged from prior pass):** `CONTENT_REVIEW_REQUIRED` / `MISSING_DISPLAY` still dominate human-facing titles on task/decision surfaces.

## Non-claims

- NOT production (`task-manager.mfsdev.net` never touched).
- NOT a claim that ONGOING/NEXT/QUEUED buckets show populated rows on this staging pin — they do not (fail-closed BLOCKED).
- NOT multi-frame keyboard filmstrip (S22) or OS-level browser zoom chrome (S23 uses CSS zoom).
- NOT that knowledge/documentation AFFILIATE domains have rich content — they honestly report unavailable.
- Capture helper scripts / raw JSON in this folder are session artifacts; PNGs + this MANIFEST are the proof set.
