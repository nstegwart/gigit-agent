# Screen Copy Inventory — Task Manager

**Document class:** SCREEN COPY INVENTORY
**Authority:** ART-UX-DIRECTION 01A (humanDisplay, id-ID) + UI_CONTRACT nine-IA
**Locale default:** `id-ID`
**Status:** inventory / alias map (content backfill not executed this task)

## 1. Scope conflict (explicit)

| Layer | Nav / labels |
|---|---|
| **Parent nine-IA (implemented)** | English: Overview, Work, Priority, Projects, Features / Flows, Agents / Runs, Ops / Accounts, Decisions, Evidence / Audit |
| **ART five-nav (owner aliases)** | id-ID: Ringkasan, Pekerjaan, Keputusan, Pengetahuan, Operasi |

This inventory lists **both**. Product strings today are predominantly English chrome; owner-facing humanDisplay content must be id-ID per 01A. Foundation does **not** rewrite AppShell labels.

## 2. Primary surfaces × copy roles

| # | Nine-IA (EN) | ART alias (id-ID) | Route pattern | Primary owner questions | Required human fields |
|---:|---|---|---|---|---|
| 1 | Overview | Ringkasan | `/b/$boardId/` | Stage now? Priority? Ongoing? Next? Blocker/decision? | stage sentence, priority outcome, ongoing cards, next reason, decision ask |
| 2 | Work | Pekerjaan | `/b/$boardId/work` | Bucket truth + denominators | human title, status sentence, owner, next, blocker |
| 3 | Priority | *(under Ringkasan / Operasi partial)* | `/b/$boardId/priority` | Sales/web/backend priority honest? | portfolio labels, reason, capacity prose |
| 4 | Projects | *(structure)* | `/b/$boardId/projects` | Project outcomes | human project name, stage, readiness prose |
| 5 | Features / Flows | *(structure; Pengetahuan partial)* | `/b/$boardId/features` | Flow coverage | feature title, branch meaning |
| 6 | Agents / Runs | *(Operasi partial)* | `/b/$boardId/agents` | Who works now? | role prose, not model as headline |
| 7 | Ops / Accounts | Operasi | `/b/$boardId/ops` | Capacity / quarantine | masked ops prose |
| 8 | Decisions | Keputusan | `/b/$boardId/decisions` | What needs owner? | question heading, context, Setujui/Tolak/Minta penjelasan/Tunda |
| 9 | Evidence / Audit | *(Operasi / Bukti)* | `/b/$boardId/evidence` | What proves it? | plain proof summary first |

**Drill-downs:** task detail `/b/$boardId/tasks/$taskId` — human title first; technical mode secondary.

**ART-only routes (S13–S17 etc.):** `/knowledge/*`, `/search`, `/documentation/*` — aliases may not exist yet; SCREENSHOT_SPEC records mapping gaps.

## 3. Work-bucket labels (id-ID primary)

| Code | Owner label (id-ID) | EN chrome (current) |
|---|---|---|
| DONE | Selesai | Done |
| ONGOING | Sedang dikerjakan | Ongoing |
| NEXT | Berikutnya | Next |
| QUEUED | Menunggu giliran | Queued |
| BLOCKED | Terhambat | Blocked |
| RECONCILIATION / RECONCILIATION_PENDING | Sedang dicocokkan | Reconciliation |
| HOLD | Ditahan | Hold |
| EXCLUDE | Dikecualikan | Exclude |

## 4. humanDisplay contract (required fields)

Every owner-visible entity: `locale`, `title`, `outcome`, `whyItMatters`, `currentState`, `remainingWork`, `nextAction`, `blockerSummary`, `doneWhen`, `ownerAction`, `parentFeatureTitle`, `businessArea`, `actor`, `sourceHash`, `reviewedAt`, `reviewStatus`.

`reviewStatus`: REVIEWED | GENERATED_NEEDS_REVIEW | BLOCKED_MISSING_SOURCE | CONFLICT | CONTENT_REVIEW_REQUIRED.

**Release rule:** missing/stale primary copy → CONTENT_REVIEW_REQUIRED; never show raw ID/JSON as primary title.

## 5. Decision actions (id-ID)

| Action | Copy |
|---|---|
| Approve | Setujui |
| Reject | Tolak |
| Clarify | Minta penjelasan |
| Defer | Tunda |
| None needed | Tidak ada tindakan yang diperlukan |

## 6. Empty / error / stale copy patterns

| State | id-ID pattern |
|---|---|
| Empty work | “Tidak ada pekerjaan di bucket ini” + why + safe next |
| Empty search | Teach human + technical terms |
| Error | Human cause + impact + retry; trace secondary |
| Stale | “Data mungkin usang” + last valid time + refresh |
| Permission | “Anda tidak punya akses…” not blank page |

## 7. Residual (this task)

- No mass content backfill.
- Chrome remains English nine-IA until i18n task.
- Inventory is the alias + required-field contract only.
