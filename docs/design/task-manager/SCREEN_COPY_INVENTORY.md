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

## 7. Priority surface copy map (id-ID primary)

Route: `/b/$boardId/priority` · component tree under `src/components/control-center/priority/`.

| Panel / chrome | Primary owner copy (id-ID) | Technical secondary |
|---|---|---|
| Page title | Portofolio prioritas | portfolioId `SALES_WEB_RELATED_BACKEND` |
| Portfolio human name | Prioritas Utama — Panel Sales, Website, dan Backend Terkait | ART HUMAN TAXONOMY |
| Membership | Keanggotaan portofolio; penyebut; receipt valid/invalid | task IDs under Detail teknis |
| Denominators | Penyebut terpisah (DISTINCT); label field id-ID | raw field names on `title`; task ID lists in Detail teknis |
| Readiness | Kesiapan board/tugas; complete; dibatasi oleh (cappedBy sentence) | raw `cappedBy` enum + policy versions in Detail teknis |
| Capacity | Kapasitas & alokasi mayoritas; frontier/reason sentences | PASS/FAIL/N-A tokens + raw frontier/reason codes |
| G5 | Domain G5 (sembilan gerbang); status Lolos/Gagal/… | domainId slug; g5Pass boolean |
| Non-priority | Alasan di luar prioritas (4 allowlist sentences) | raw reason codes; allowlist codes in Detail teknis |
| UI states | Memuat / kosong / partial / basi / terputus / gagal / akses ditolak / keputusan manusia | errorCode under Detail teknis |

**Invariant:** numeric denominators, share, readiness %, majority boolean, and G5 pass are server envelope only — copy layer never recomputes them.

**Known residual:** empty-product warning block on denominators is owned by a separate root fix (`productDenominator=0` → human sentence + Detail teknis); do not fork that block in this pass.

## 8. Overview / Work chrome banners (id-ID primary — TM-11)

Owner-mode surface chrome for Overview `SurfaceBanner` / `AppSummaryBar` and Work
`WorkStates` / bucket-overlay `labels` is plain **id-ID**. Wiring (stale flags,
envelope source, data attrs) is unchanged.

| Surface | State / chrome | Owner copy (id-ID) |
|---|---|---|
| Overview banner | loading | Memuat ringkasan |
| Overview banner | zero-results | Tidak ada hasil yang cocok |
| Overview banner | partial | Ringkasan sebagian |
| Overview banner | stale | Data basi |
| Overview banner | disconnected | Terputus |
| Overview banner | error | Ringkasan gagal |
| Overview banner | forbidden | Akses ditolak |
| Overview app bar | connection live/stale/disconnected | Langsung / Basi / Terputus |
| Overview app bar | stale chip | BASI (+ server reason) |
| Work states | loading / empty / zero-results | Memuat… / Tidak ada pekerjaan… |
| Work states | partial / stale / disconnected / error / forbidden / needs-human | Data sebagian / Envelope basi / Terputus / … |
| Work buckets | DONE…BLOCKED | Selesai / Sedang dicocokkan / Sedang dikerjakan / Berikutnya / Menunggu giliran / Terhambat |
| Work overlays | STALE_* family | Sumber data basi, Klaim basi, … (see `labels.ts`) |
| Work liveness | PRODUCTIVE/IDLE/STALLED/EXPIRED | Produktif / Menganggur / Macet / Kedaluwarsa |

## 9. Residual (this task)

- No mass content backfill of task humanDisplay rows.
- AppShell chrome remains English nine-IA until i18n task (nav: Overview, Work, …).
- Work `StaleOverlayFilter` chip label and other surfaces outside Overview/Work
  banners (Features/Agents/Decisions “Stale pin”, etc.) may still show EN chrome.
- Inventory is the alias + required-field contract plus Priority + Overview/Work
  banner maps above.
