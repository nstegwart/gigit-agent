# MFS Public Consumer Sync Contract V1

**Document class:** DESIGN + CONFORMANCE CONTRACT (handoff only)  
**Contract id:** `MFS_PUBLIC_CONSUMER_SYNC_CONTRACT_V1`  
**OpenAPI companion:** `MFS_PUBLIC_CONSUMER_SYNC_V1.openapi.yaml`  
**Parent adapter contract:** `../MFS_CONTROL_PLANE_SYNC_API_V1.md`  
**Serializer / schema:** `PUBLIC_SNAPSHOT_V1` / `MFS_PUBLIC_SNAPSHOT_V1`  
**Rate-limit policy:** `PUBLIC_SNAPSHOT_RATE_LIMIT_V1` (60/min sustained, burst 20 → 429 + Retry-After)

## DESIGN CONTRACT vs IMPLEMENTATION PROOF

| Layer | Status in this package |
|---|---|
| **DESIGN CONTRACT** | Binding handoff for a **separate** MFS sync worker that consumes TM `GET /api/public-snapshot` and publishes public-consumer assets **outside** this repo. |
| **Fixtures + executable conformance** | Present under `qa/fixtures/public-consumer-sync/**` and `qa/e2e/flows/public-consumer-conformance.mjs`. |
| **Public-consumer mutation** | **NOT authorized.** `writeAuthority=EXCLUDED`. No `/opt/mfs/workspace/CONTRACT`, `/var/www/contract`, nginx, or deploy from this workspace. |
| **Production TM readback** | Not required to close this package; prod may be 502 / awaiting deploy approval. |

### Explicit non-claims

- This package is **not** authority to edit MFS CONTRACT source or served assets.
- Consumer static inventory (e.g. 639 tasks, `MOCK_LABEL`, `status_cap: LOCAL ONLY`) is **not** TM board readiness.
- Staging public snapshot over synthetic board data is **not** production parity.
- Schema existence alone is never `DONE` for consumer deploy.

---

## 1. Purpose

Give a separately authorized MFS sync worker a versioned, testable contract to:

1. **Consume** task-manager `GET /api/public-snapshot?boardId=` (ETag / 304 / 429 / 503).
2. **Validate** pinned identity: `canonicalHash`, `boardRev`, `lifecycleRev`, `canonicalSnapshotId`, `serializerVersion`, plus `schemaVersion`, freshness, counts, redaction.
3. **Publish atomically** into the public-consumer serve tree **without** mock labels / LOCAL ONLY placeholders presented as live board truth.
4. **Fail closed** on pin incomplete, redaction failure, rate limit without backoff plan, or partial write.

Maps to investigation `WORKER_RESULT_investigate-final-public-parity-r3.md` §4 SEPARATE PACKET and `RESOLVED_TARGET.publicConsumer.requiredHandoff`.

---

## 2. Authority boundary (unresolved deploy)

| Surface | Class | Path / URL | Authority in this package |
|---|---|---|---|
| Task-manager source (this repo) | AUTHORITATIVE for contract artifacts | `docs/control-center/public-consumer-sync/**`, `qa/fixtures/public-consumer-sync/**`, `qa/e2e/flows/public-consumer-conformance.mjs`, related unit tests | **Allowed pathspecs only** |
| Staging public snapshot | STAGING API | e.g. `http://127.0.0.1:33211/api/public-snapshot?boardId=mfs-rebuild` | Read-only probe target for LIVE conformance |
| Production TM | PRODUCTION | `https://task-manager.mfsdev.net/` | Read-only when healthy; may be 502 |
| Public consumer source | LIVE_PUBLIC_CONSUMER | `/opt/mfs/workspace/CONTRACT` | **UNRESOLVED / EXCLUDED** |
| Public consumer serve | LIVE_PUBLIC_CONSUMER | `/var/www/contract` | **UNRESOLVED / EXCLUDED** |
| Deploy owner | separate MFS sync worker | e.g. `publish-grok-accounts.mjs` rsync/nginx path | **UNRESOLVED** — needs root/owner packet |

`sourcePath` and `servedPath` are **named for handoff** only. Workers in this repo must not mutate them.

Human packet: `MFS_PUBLIC_CONSUMER_WORKER_PACKET.md`.

---

## 3. Transport contract

### 3.1 Request

```
GET /api/public-snapshot?boardId={boardId}
Accept: application/json
If-None-Match: "{etag}"   # optional; enables 304
```

| Query | Rule |
|---|---|
| `boardId` | Required. Allowlisted server-side; unknown/denied → fail-closed `503` `STALE_OR_MISSING` (not a public board inventory). |
| Auth | None (public). Must never accept cookies as elevated identity for this path. |

### 3.2 Success `200`

| Header | Rule |
|---|---|
| `etag` | Opaque quoted SHA-256 hex of public payload identity |
| `x-public-serializer` | Must be `PUBLIC_SNAPSHOT_V1` |
| `cache-control` | `public, max-age=0, must-revalidate` (or equivalent revalidate) |
| `x-snapshot-stale` | `1` when `freshness.stale === true` (optional but observed) |
| `content-type` | `application/json` |

Body: `MFS_PUBLIC_SNAPSHOT_V1` object (see §4). `etag` field inside body MUST equal header etag (quotes stripped).

### 3.3 Not modified `304`

When `If-None-Match` matches current etag:

- Body empty
- Headers still carry `etag` + `x-public-serializer`
- Consumer worker **keeps** last validated payload; does not publish empty

### 3.4 Rate limited `429`

Policy id: `PUBLIC_SNAPSHOT_RATE_LIMIT_V1`

| Header | Example |
|---|---|
| `retry-after` | `1` (seconds) |
| `x-ratelimit-limit` | `20` (burst) |
| `x-ratelimit-remaining` | `0` |
| `x-ratelimit-policy` | `PUBLIC_SNAPSHOT_RATE_LIMIT_V1` |

Body:

```json
{
  "error": "public snapshot rate limit exceeded",
  "code": "RATE_LIMITED",
  "policyId": "PUBLIC_SNAPSHOT_RATE_LIMIT_V1",
  "retryAfterSeconds": 1
}
```

Worker MUST backoff using `retry-after` / `retryAfterSeconds`. Sustained design target: ≤60 req/min/IP after burst 20.

### 3.5 Unavailable `503`

```json
{
  "error": "public snapshot unavailable",
  "code": "STALE_OR_MISSING",
  "stale": true
}
```

Do **not** invent a public payload. Do **not** fall back to mock inventory as if it were the pin.

---

## 4. Payload schema (normative pin + counts)

### 4.1 Required top-level fields

| Field | Type | Rule |
|---|---|---|
| `schemaVersion` | string | Exactly `MFS_PUBLIC_SNAPSHOT_V1` |
| `boardId` | string | Non-empty; must match requested boardId |
| `pin` | object | See §4.2 |
| `freshness` | object | See §4.3 |
| `buckets` | object | Integer counts for DONE, RECONCILIATION_PENDING, ONGOING, NEXT, QUEUED, BLOCKED |
| `tasks` / `runs` / `accounts` | arrays | Lengths are the count proof |
| `usableCapacity` | integer ≥ 0 | Domain blockers / stale account-sync force 0 |
| `decisionCount` | integer ≥ 0 | Count only — never decision titles/text |
| `etag` / `payloadSha256` | 64-hex | Equal to each other after normalize |
| `boardRollup`, `completion`, `g5` | objects | Allowlisted public numbers only |
| `domainBlockers` | array | Allowlisted codes only |
| `projects`, `features`, `staleOverlays`, `priorityRollup` | as schema | No secret keys |

### 4.2 Pin (identity) — mandatory validation

```json
{
  "canonicalSnapshotId": "non-empty string",
  "canonicalHash": "64-char hex preferred / non-empty string",
  "boardRev": 125,
  "lifecycleRev": 3,
  "serializerVersion": "PUBLIC_SNAPSHOT_V1"
}
```

| Field | Fail closed if |
|---|---|
| `canonicalSnapshotId` | missing/empty |
| `canonicalHash` | missing/empty |
| `boardRev` | not integer |
| `lifecycleRev` | not integer |
| `serializerVersion` | ≠ `PUBLIC_SNAPSHOT_V1` |

Worker **pins** these values into the publish receipt. A later fetch with different pin is a new revision (atomic republish), never a silent merge with mock assets.

### 4.3 Freshness

| Field | Rule |
|---|---|
| `generatedAt` / `publishedAt` | ISO-8601 strings |
| `publicationIntervalMs` | positive number (reference 60000) |
| `stale` | boolean — true does **not** authorize inventing data; publish may still carry stale truth with `usableCapacity=0` |
| `ageMs` | number ≥ 0 |

### 4.4 Counts consistency

- `tasks.length` MUST equal sum of bucket counts when all tasks are listed (staging synth: 8 tasks, buckets.BLOCKED=8).
- Publish receipt MUST record `tasks`, `runs`, `accounts`, `buckets`, `usableCapacity` from the **same** validated payload (no mixing with CONTRACT_MANIFEST inventory counts).

### 4.5 Redaction (no-secret boundary)

Forbidden as JSON **keys** at any depth (non-exhaustive; see conformance lib):

`password`, `passwd`, `token`, `secret`, `authorization`, `cookie`, `apiKey` / `api_key`, `accessToken`, `refreshToken`, `sessionId`, `rawIdentity`, `credentials`, `comments`/`comment`, `evidence` bodies, private decision text fields.

Account fields:

- `accountIdMasked` / `accountRefMasked` MUST match `^acc_\*{3}[A-Za-z0-9]{4}$` when present (canonical mask).
- No raw emails, phones, passwords, cookies, or bearer tokens in string values of public payload.

`decisionCount` is allowed; decision titles/bodies are not.

---

## 5. Atomic publish (consumer side — excluded here)

When a **separate** worker is authorized:

1. Fetch + validate §3–§4.
2. Map validated payload → consumer asset set (never inject `MOCK_LABEL`, `MOCK —`, `status_cap: "LOCAL ONLY"` as live readiness).
3. Write entire asset set under a staging directory.
4. `fsync` / durability as platform allows.
5. Atomic rename/swap into serve root.
6. Write publish receipt including pin, etag, counts, `fetchedAt`, `publishId`.
7. Keep previous generation for rollback until next successful publish.

**Reject publish** if any asset contains mock/preview labels claiming live TM board state, or if pin/redaction validation failed.

Example receipt: `examples/atomic-publish-receipt.example.json`.  
Negative fixture: `qa/fixtures/public-consumer-sync/publish-with-mock-labels.json` (must fail gate).

---

## 6. Conformance matrix

| Check id | Fixture / mode | Pass criteria |
|---|---|---|
| `schema_and_pin` | golden 200 | schema + full pin + serializer |
| `etag_304` | fixture logic + optional LIVE | 200 etag → If-None-Match → 304 empty |
| `rate_limit_429` | fixture + optional LIVE burst | body code `RATE_LIMITED` + headers |
| `freshness_shape` | golden 200 | required freshness fields |
| `counts_consistency` | golden 200 | lengths vs buckets / usableCapacity int |
| `redaction` | golden pass; hostile fail | no forbidden keys; masks valid |
| `atomic_publish_no_mock` | good receipt pass; mock publish fail | no mock labels; atomic mode set |

Executable:

```bash
# Offline (default) — fixtures only
node qa/e2e/flows/public-consumer-conformance.mjs

# Optional LIVE (staging tunnel or local server)
WEB_BASE=http://127.0.0.1:33211 BOARD_ID=mfs-rebuild \
  node qa/e2e/flows/public-consumer-conformance.mjs

pnpm test:unit -- tests/unit/public-consumer-sync-contract.test.ts
```

---

## 7. Relationship to MFS_CONTROL_PLANE_SYNC_API_V1

| Artifact | Role |
|---|---|
| `MFS_CONTROL_PLANE_SYNC_API_V1` | Authenticated **mutations** into control plane (dispatch/run/accounts) |
| **This contract** | Unauthenticated **public read** + consumer **publish** handoff |
| Public snapshot rate limit / ETag | Shared semantics referenced by both |

This package does **not** implement `sync_accounts` / `register_run` / `publish_dispatch_plan`.

---

## 8. Examples (non-secret)

| File | Meaning |
|---|---|
| `examples/golden-public-snapshot-200.json` | Shape-stable synth snapshot |
| `examples/rate-limited-429.json` | Rate limit body |
| `examples/stale-or-missing-503.json` | Fail-closed unavailable |
| `examples/atomic-publish-receipt.example.json` | Atomic publish receipt shape |

---

## 9. Status of this package

| Claim | Allowed? |
|---|---|
| Contract + fixtures + offline conformance exist | Yes (this task) |
| Consumer stopped serving MOCK inventory | **No** — excluded write |
| Production parity closed | **No** — prod TM may be 502; deploy authority unresolved |
| Live E2E always green without WEB_BASE | **No** — LIVE mode optional |

Grade for this implementer wave: **LOCAL ONLY** for product-consumer shippability; contract package itself is complete under pathspec when offline conformance + unit tests pass.
