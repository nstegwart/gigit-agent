# MFS Control Plane Sync API V1 (C0 Design Freeze)

**Document class:** DESIGN CONTRACT (adapter handoff)
**Checkpoint:** C0
**Contract version:** `MFS_CONTROL_PLANE_SYNC_API_V1`
**OpenAPI companion:** `MFS_CONTROL_PLANE_SYNC_API_V1.openapi.yaml`
**Source SHA:** `3c8a855dabd68a1d8a701597da16969756ee6511`

## DESIGN CONTRACT vs IMPLEMENTATION PROOF

| Layer | Status in this document |
|---|---|
| **DESIGN CONTRACT** | Binding adapter contract for excluded MFS consumer/runner repos. |
| **Implemented / runtime proof** | **Not claimed.** Control-plane surfaces land in C2; MFS-side adapters need separate authorization. |

### Explicit non-claims

- Staging gate only: `TASK_MANAGER_STAGING_VERIFIED`
- Live: `AWAITING_PRODUCTION_APPROVAL_DEPLOY_READBACK`
- No live P0 PASS, no mass-refill unlock, no FABLE PASS
- Production / public-consumer writes **excluded** from this task
- Pool/runner/MFS adapter edits are **outside** RESOLVED_TARGET write scope
- **Never include tokens or raw account identity** in payloads, examples, logs, or docs
- This document is **not** authorization to mutate MFS CONTRACT, account-pool tooling, nginx, or `/var/www/contract`


## 1. Purpose and scope

Authoritative adapter contract so external MFS systems can:

1. Publish a root-ranked **dispatch plan** (sole NEXT source)
2. **Register** and **heartbeat** agent runs with fencing
3. **Sync masked account** capacity state

…into the task-manager control plane **without** this repo editing MFS runner/pool/public-consumer code.

When external repos are excluded (current RESOLVED_TARGET), this package delivers:

- narrative contract (this file)
- OpenAPI YAML
- JSON examples (non-secret)
- conformance expectations
- separate future packet: `MFS_SYNC_WORKER_PACKET.md`

Maps to AC-INGEST-01..05, AC-ACCOUNT-01..07, AC-CAP-*, AC-AUTH-*, AC-API-*.


## 2. Auth model (adapter side)

| Caller | Role | Scopes | Identity |
|---|---|---|---|
| Root orchestrator | `ROOT_ORCHESTRATOR` | `dispatch:write`, optionally `account:sync` | Orchestrator credential / session |
| Agent runner | `AGENT` | `run:write` (+ assigned `task:read` / `run:read`) | Agent credential bound to agentId |
| Authorized MFS sync | dedicated sync identity | `account:sync` only | Separately issued; never reuses owner browser session |
| Public | `PUBLIC` | none of these mutations | N/A |

Browser CSRF does not apply to non-cookie agent/sync credentials.
Missing/invalid auth → `AUTHORIZATION_REQUIRED` fail-closed.


## 3. Common request constraints

Every mutation requires:

| Field | Rule |
|---|---|
| `boardId` | Target board (e.g. `mfs-rebuild`) |
| `entityExpectedRev` and/or `expectedBoardRev` | As applicable; mismatch → `STALE_REVISION` |
| subject / canonical hash | Must match current pinned snapshot when required |
| `Idempotency-Key` | Required header or body field |
| authorized role/scope | RBAC |

### Idempotency

| Rule | Value |
|---|---|
| Scope | `actor + board + endpoint + key` |
| TTL | **24 hours** |
| Same key + same request hash | Replay original status/body |
| Same key + different request hash | **409** `IDEMPOTENCY_CONFLICT` |
| `register_run` | Also unique on `runId` |

### Cursor (list readbacks)

- Key: `createdAt`, `id`
- Default page **50**, max **200**
- Opaque cursor


## 4. Operations

### 4.1 `publish_dispatch_plan`

| Property | Value |
|---|---|
| Caller | **ROOT_ORCHESTRATOR only** |
| Scope | `dispatch:write` |
| Semantics | Sole source of `selectedForNextDispatch` and bucket **NEXT** |
| Forbidden | UI/agent computing NEXT independently |

**Request (logical schema):**

```json
{
  "boardId": "mfs-rebuild",
  "planId": "plan-uuid",
  "planVersion": 1,
  "planHash": "sha256-of-canonical-plan",
  "canonicalSnapshotId": "snap-uuid",
  "canonicalHash": "sha256",
  "expectedBoardRev": 12,
  "issuedAt": "2026-07-13T08:00:00Z",
  "expiresAt": "2026-07-13T12:00:00Z",
  "stage": "MAP_VERIFIED",
  "items": [
    {
      "rank": 1,
      "taskId": "T-EXAMPLE",
      "targetGate": "FUNCTIONAL",
      "role": "PRODUCT",
      "selectionReason": "priority-closure-frontier",
      "priorityPortfolioId": "SALES_WEB_RELATED_BACKEND",
      "dependencyProof": { "satisfied": true, "refs": [] },
      "collisionScopeLockIds": ["repo:example:src/**"],
      "expectedEntityRev": 3,
      "expectedBoardRev": 12
    }
  ],
  "idempotencyKey": "dispatch-key-1"
}
```

**Success readback:** stored planId/version/hash, boardRev after apply, item count, `generatedAt`.
**Fail-closed:** STALE_REVISION, AUTHORIZATION_REQUIRED, DATA_INTEGRITY, IDEMPOTENCY_CONFLICT.

Parity rule (AC-INGEST-02): rank/reason/revisions must match NEXT in MCP/API/UI at the same pinned revision.


### 4.2 `register_run`

| Property | Value |
|---|---|
| Caller | `AGENT` |
| Scope | `run:write` |
| Idempotency | `runId` + idempotency key |

**Request (logical):**

```json
{
  "boardId": "mfs-rebuild",
  "runId": "run-uuid",
  "planId": "plan-uuid",
  "planItemRank": 1,
  "taskId": "T-EXAMPLE",
  "targetGate": "FUNCTIONAL",
  "role": "PRODUCT",
  "agentId": "agent-uuid",
  "model": "grok-4.5",
  "effort": "high",
  "maskedAccountRef": "acct-mask-001",
  "canonicalHash": "sha256",
  "collisionScopeLockIds": ["repo:example:src/**"],
  "expectedEntityRev": 3,
  "expectedBoardRev": 12,
  "idempotencyKey": "register-run-uuid"
}
```

**Success:** run state STARTING/RUNNING reservation, leaseExpiresAt, fencingToken, registeredAt.
**Fail-closed:** STALE_REVISION, CLAIM_COLLISION, FENCED, RUN_NOT_REGISTERED (on later ops), HOLD_OR_EXCLUDE, UNCLASSIFIED_SCOPE, AUTHORIZATION_REQUIRED, IDEMPOTENCY_CONFLICT.

Visibility SLA: real authorized runner registration appears in MCP/API/UI ≤ **30 seconds** (AC-INGEST-03).


### 4.3 `heartbeat_run`

| Property | Value |
|---|---|
| Caller | Owning `AGENT` only |
| Scope | `run:write` |

**Request (logical):**

```json
{
  "boardId": "mfs-rebuild",
  "runId": "run-uuid",
  "fencingToken": "fence-token",
  "heartbeatSequence": 42,
  "materialProgressAt": null,
  "expectedEntityRev": 3,
  "expectedBoardRev": 12,
  "idempotencyKey": "hb-run-uuid-42"
}
```

Rules:

- Heartbeat proves **liveness only**, not productivity/completion.
- Duplicate `heartbeatSequence` → replay prior response.
- Material progress sets `materialProgressAt` and may emit material audit event.
- Defaults: heartbeat ≤15s; lease 60s; reconciliation grace 30s; stalled after 10m without material progress.
- Heartbeats **do not** append immutable per-event audit (AC-OPS-04).

Fail-closed: FENCED, LEASE_EXPIRED, RUN_NOT_REGISTERED, STALE_REVISION.


### 4.4 `sync_accounts`

| Property | Value |
|---|---|
| Caller | `ROOT_ORCHESTRATOR` or separately authorized MFS sync identity |
| Scope | `account:sync` |
| Secrets | **Never** transmit tokens, passwords, cookies, or raw account identity |

**Request item (logical, masked only):**

```json
{
  "boardId": "mfs-rebuild",
  "sourceRevision": 1001,
  "generatedAt": "2026-07-13T08:00:00Z",
  "accounts": [
    {
      "maskedAccountId": "acct-mask-001",
      "status": "OK",
      "effectiveInUse": 2,
      "effectiveCap": 5,
      "physicalSlotsDisplay": "2/20",
      "adaptiveQuotaState": "HEALTHY",
      "reason": null,
      "statusChangedAt": "2026-07-13T07:59:00Z"
    }
  ],
  "expectedBoardRev": 12,
  "idempotencyKey": "acct-sync-1001"
}
```

**Status enum (masked):** `ACTIVE`, `OK`, `LIMIT`, `BAN`, `403`, `AUTH_EXPIRED`, `quarantine`, `REMOVED` (tombstone → usable capacity 0).

**Mandatory publication triggers:**

1. Orchestrator/wave/agent launch
2. Heartbeat or material assignment/status transition
3. LIMIT/BAN/403/AUTH_EXPIRED transition
4. Account rotation or work requeue
5. Checkpoint integration or wave close
6. Periodic health checkpoint (≥ every **60s**)

**Freshness SLA (AC-ACCOUNT-01..07):**

- Triggered state reaches MCP, API, authenticated UI, and Ops with the **same** `sourceRevision`/`generatedAt` within **30 seconds**.
- Heartbeat coalescing allowed if newest state still publishes within 30s.
- Periodic health publication at least every 60s.
- Missed/stale publication: `stale=true`, alert `ACCOUNT_SYNC_STALE`, `usableCapacity=0` for new dispatch, fail-closed until multi-surface same-revision readback passes.
- No server-local-only account transition.


## 5. Typed errors (subset + full set reference)

All codes from API_CONTRACT apply. Adapter-critical:

| Code | When |
|---|---|
| `STALE_REVISION` | expectedBoardRev / entityExpectedRev mismatch |
| `IDEMPOTENCY_CONFLICT` | same key, different payload hash |
| `AUTHORIZATION_REQUIRED` | missing/invalid caller |
| `CLAIM_COLLISION` | lock conflict |
| `FENCED` | fencing token invalid / superseded |
| `LEASE_EXPIRED` | run lease expired |
| `RUN_NOT_REGISTERED` | heartbeat/mutate unknown run |
| `DATA_INTEGRITY` | malformed plan/account batch |
| `HOLD_OR_EXCLUDE` | task disposition blocks claim |
| `UNCLASSIFIED_SCOPE` | classification blocks progress |
| `INTEGRATION_LOCKED` | second integrator |

Full list: see `API_CONTRACT.md` §6.


## 6. Rate limits

Public snapshot rate limit is **not** these mutation endpoints.

Mutation endpoints: enforce authenticated rate limits sufficient to protect control plane; public unauth must never reach these methods.

Public snapshot (reference): `PUBLIC_SNAPSHOT_RATE_LIMIT_V1` = **60/min/IP**, burst **20**, **429 + Retry-After**.


## 7. Readback / conformance requirements

Conformance harness (C2/C4; not C0 runtime proof) must demonstrate:

| Check | Pass criterion |
|---|---|
| NEXT sole source | Only plan items appear as NEXT |
| Rank parity | UI/MCP rank/reason match plan |
| Register ≤30s | Clock delta program-emitted |
| Heartbeat idempotency | Dup sequence replays |
| Account mask | No token/raw identity fields in response |
| Stale fail-closed | usableCapacity=0 + alert |
| Revision fencing | STALE_REVISION on mismatch |
| 24h idempotency TTL | Replay within TTL; conflict on hash change |

Example fixtures must use synthetic IDs only (`T-EXAMPLE`, `acct-mask-*`). Never real emails, tokens, or pool secrets.


## 8. Capacity policy fields (read-side for Ops)

Represented for consumer display/enforcement (control plane owns truth):

- gpt-5.3-codex-spark ≤10 live
- gpt-5.6-sol ≤10 live/reserved global
- Grok starts 5 / healthy account, remains 5–10
- Grok majority of safe live capacity
- Combined Grok+Spark+SOL ≤200
- Floor ≥60 only when ≥60 genuine unique ready collision-safe packets and health permit; else `BELOW_FLOOR` + count + reason
- CPU ≥90% stops new dispatch
- LIMIT/BAN/403/AUTH_EXPIRED quarantine without retry-hammer
- Tombstone usable=0
- physical slots/20 display-only
- Never `--accounts all`
- Never fabricate filler work


## 9. Boundary and handoff

| In this repo (allowed later packages) | Out of this task |
|---|---|
| Server handlers for the four operations | `/opt/mfs/workspace/tools/grok-account-pool/**` |
| Tests under `tests/unit` / `qa/` | `/opt/mfs/workspace/CONTRACT/**` |
| This OpenAPI + packet | `/var/www/contract/**`, nginx |
| Synthetic fixtures | Production deploy / mass refill |

Future external work uses `MFS_SYNC_WORKER_PACKET.md` under **separate** owner/root authorization. This C0 freeze is **not** that authorization.


## 10. Related

- `API_CONTRACT.md` — full authenticated surface
- `MFS_CONTROL_PLANE_SYNC_API_V1.openapi.yaml` — machine schema
- `MFS_SYNC_WORKER_PACKET.md` — future mutation worker packet
- `ARCHITECTURE.md` — ingestion model
- `THREAT_MODEL.md` — account/token leakage threats
