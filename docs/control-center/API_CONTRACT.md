# Authenticated API / MCP Contract (C0 Design Freeze)

**Document class:** DESIGN CONTRACT
**Checkpoint:** C0
**Schema version:** `TM_API_CONTRACT_V1`
**Source SHA:** `3c8a855dabd68a1d8a701597da16969756ee6511`

## DESIGN CONTRACT vs IMPLEMENTATION PROOF

| Layer | Status in this document |
|---|---|
| **DESIGN CONTRACT** | Binding. Normative. |
| **Implemented / runtime proof** | **Not claimed** by C0 docs alone. |

### Explicit non-claims

- Staging gate only: `TASK_MANAGER_STAGING_VERIFIED`
- Live: `AWAITING_PRODUCTION_APPROVAL_DEPLOY_READBACK`
- No live P0 PASS, no mass-refill unlock, no FABLE PASS
- Production / public-consumer writes excluded
- Synthetic staging default without dual approvals
- Production HTTP 502 / historical open-read MCP = G0 **observed facts**, not implementation success


## 1. Transport surfaces

| Surface | Auth | Notes |
|---|---|---|
| Browser server functions / HTTP API | Session cookie + CSRF on writes | Existing Cairn session reuse preferred |
| MCP Streamable HTTP `/mcp` | Scoped token / agent identity for sensitive ops | Fail-closed reads for unauth |
| Public snapshot HTTP | None | Allowlisted + rate limited |

## 2. Canonical authenticated reads

| Method | Purpose |
|---|---|
| `get_overview` | Mission rollups, buckets, G5, decisions summary, freshness |
| `list_work_items` | Bucket-filtered work with cursor |
| `list_projects` / `get_project` | Project rollups |
| `list_features` / `get_feature` | Feature Flow |
| `list_tasks` / `get_task` | Task detail |
| `list_runs` / `get_run` | Agents/runs |
| `list_accounts` / `get_account` | Masked accounts/ops |
| `list_decisions` / `get_decision` | Decision inbox |
| `list_activity` | Material activity |
| `list_audit` | Immutable audit |
| `get_priority_portfolio` | SALES_WEB_RELATED_BACKEND truth |
| `get_g5` | Nine-domain G5 |
| `get_prod` | Production-readiness view fields |
| `get_guide` | Operator guide content |

### Compatibility aliases

Existing names such as `get_rollup`, `get_lifecycle`, `get_board_hash`, and other current aliases remain **versioned compatibility aliases** to the same authorization, pinned aggregation, filters, cursor, and schema contract. Aliases MUST NOT recompute independently.

## 3. Common envelope (all authenticated reads)

```json
{
  "schemaVersion": "TM_PINNED_ENVELOPE_V1",
  "boardId": "mfs-rebuild",
  "canonicalSnapshotId": "...",
  "canonicalHash": "...",
  "boardRev": 0,
  "lifecycleRev": 0,
  "generatedAt": "RFC3339",
  "freshnessAgeSeconds": 0,
  "stale": false,
  "staleReason": null,
  "data": {},
  "nextCursor": null
}
```

No read surface independently recomputes counts or readiness.

## 4. Filters, cursor, pinned revision

- Every read uses authorized scope + **pinned** query/snapshot revision.
- Filters validated against schema; invalid filter → typed validation error (fail-closed).
- Cursor pagination:
  - stable key: `createdAt`, `id`
  - default order: `createdAt DESC`, `id DESC`
  - **default page size: 50**
  - **maximum page size: 200**
  - cursor: opaque encoding of last `createdAt,id`
- Oversized page request clamped or rejected (implementation chooses fail-closed reject preferred).

## 5. Mutations — concurrency and idempotency

Every mutation requires:

| Field | Rule |
|---|---|
| `entityExpectedRev` | Monotonic integer; mismatch → `STALE_REVISION` |
| `expectedBoardRev` | Monotonic integer; mismatch → `STALE_REVISION` |
| subject/canonical hash | Must match current |
| idempotency key | Required |
| authorized role/scope | RBAC |

### Idempotency

| Rule | Behavior |
|---|---|
| Scope | `actor + board + endpoint + key` |
| TTL | **24 hours** |
| Same key + same canonical request hash | Replay original status/body |
| Same key + different request hash | **409** `IDEMPOTENCY_CONFLICT` |
| `register_run` | Also unique/idempotent on `runId` |

On `STALE_REVISION`, return current safe revision metadata (boardRev, entity rev, hashes) without applying mutation.

## 6. Typed error codes (complete set)

| Code | Typical HTTP | When |
|---|---|---|
| `STALE_REVISION` | 409/403/401/422 as appropriate | See V3 fail-closed semantics |
| `INVALID_TRANSITION` | 409/403/401/422 as appropriate | See V3 fail-closed semantics |
| `MISSING_EVIDENCE` | 409/403/401/422 as appropriate | See V3 fail-closed semantics |
| `STALE_HASH` | 409/403/401/422 as appropriate | See V3 fail-closed semantics |
| `SELF_VERIFICATION` | 409/403/401/422 as appropriate | See V3 fail-closed semantics |
| `INVALID_VERIFIER_ROLE` | 409/403/401/422 as appropriate | See V3 fail-closed semantics |
| `RUN_NOT_REGISTERED` | 409/403/401/422 as appropriate | See V3 fail-closed semantics |
| `LEASE_EXPIRED` | 409/403/401/422 as appropriate | See V3 fail-closed semantics |
| `FENCED` | 409/403/401/422 as appropriate | See V3 fail-closed semantics |
| `CLAIM_COLLISION` | 409/403/401/422 as appropriate | See V3 fail-closed semantics |
| `INTEGRATION_LOCKED` | 409/403/401/422 as appropriate | See V3 fail-closed semantics |
| `HOLD_OR_EXCLUDE` | 409/403/401/422 as appropriate | See V3 fail-closed semantics |
| `UNCLASSIFIED_SCOPE` | 409/403/401/422 as appropriate | See V3 fail-closed semantics |
| `AUTHORIZATION_REQUIRED` | 409/403/401/422 as appropriate | See V3 fail-closed semantics |
| `DECISION_EXPIRED` | 409/403/401/422 as appropriate | See V3 fail-closed semantics |
| `IDEMPOTENCY_CONFLICT` | 409/403/401/422 as appropriate | See V3 fail-closed semantics |
| `DATA_INTEGRITY` | 409/403/401/422 as appropriate | See V3 fail-closed semantics |

Additional HTTP: **429** + `Retry-After` for public rate limit (not a mutation typed code, but required).

## 7. RBAC, scopes, CSRF

Roles: `OWNER`, `ROOT_ORCHESTRATOR`, `AGENT`, `INTEGRATOR`, `PUBLIC`

Read scopes: `board:read` `task:read` `run:read` `account:read` `decision:read` `evidence:read` `audit:read`
Write scopes: `dispatch:write` `lifecycle:write` `run:write` `decision:write` `import:write` `reconcile:write` `account:sync` `integration:write` `policy:write`

- Browser writes **require CSRF**.
- Owner/high-risk actions use step-up auth when existing mechanism supports it.
- If no adequate auth mechanism: open `DECISION_AUTH_MECHANISM_REQUIRED` — do not invent production auth silently.

## 8. Public materialization

- Materialize from **one** aggregation result at pinned `canonicalSnapshotId/hash`, `boardRev`, `lifecycleRev`, `serializerVersion`.
- ETag = SHA-256(pinned revision tuple + payload).
- Conditional GET: matching `If-None-Match` → **304**.
- Policy `PUBLIC_SNAPSHOT_RATE_LIMIT_V1`: **60 requests/minute/IP** sustained, **burst 20**, response **429 + Retry-After**.
- Allowlist: board/global rollup, priority rollup, completion fields, project/feature/task summaries, bucket/STALE counts, sanitized runs, masked accounts, public decision **count** only, G5, revisions/hash/generatedAt/freshness.
- Exclude: tokens/secrets, private decision titles/text, owner comments, raw env/process, sensitive evidence bodies, unmasked identity.

## 9. Domain contracts (mutations / control plane)

### 9.1 Dispatch — `publish_dispatch_plan`

- Caller: **ROOT_ORCHESTRATOR** only (`dispatch:write`).
- Payload: boardId, planId/version/hash, canonicalSnapshotId/hash, expectedBoardRev, issuedAt/expiresAt, stage, ranked items.
- Item: rank, taskId, targetGate, role, selectionReason, priorityPortfolioId, dependency proof, collisionScopeLockIds, expectedEntityRev, expectedBoardRev.
- **Sole source** of `selectedForNextDispatch` / NEXT. UI/agent MUST NOT compute NEXT.

### 9.2 Run — `register_run` / `heartbeat_run`

- `register_run` (AGENT): binds runId, plan item, task/gate/role, agent/model/effort, masked account ref, canonical hash, locks, expected revs; idempotent runId+key.
- `heartbeat_run` (owning AGENT): fencing token, heartbeat sequence, materialProgressAt when material, expected revs; duplicate sequence → replay.
- Fail-closed: unknown run → `RUN_NOT_REGISTERED`; bad fence → `FENCED`; expired → `LEASE_EXPIRED`; lock conflict → `CLAIM_COLLISION`.

### 9.3 Account — `sync_accounts`

- Caller: ROOT_ORCHESTRATOR or separately authorized MFS sync (`account:sync`).
- Masked fields only; statuses ACTIVE/OK/LIMIT/BAN/403/AUTH_EXPIRED/quarantine/REMOVED; physical slots/20 display-only.
- SLA: publish to MCP/API/UI/Ops within 30s same source revision/generatedAt; periodic ≥60s.
- Miss/stale: `stale=true`, alert ACCOUNT_SYNC_STALE, `usableCapacity=0`, fail-closed until multi-surface readback parity.
- **Never** transmit account tokens.

### 9.4 Decision

- Create/update/resolve with expected revs; blocking flag; snoozedUntil rules; severity ordering server-side.
- Expired decision mutation → `DECISION_EXPIRED`.

### 9.5 Import / lifecycle

- Canonical import: `import:write`; hash/schema/DISTINCT/cycle validation; no fabricated lifecycle evidence.
- Lifecycle advance: `lifecycle:write`; stage machine; rejections map to INVALID_TRANSITION, MISSING_EVIDENCE, STALE_HASH, SELF_VERIFICATION, INVALID_VERIFIER_ROLE, UNCLASSIFIED_SCOPE, HOLD_OR_EXCLUDE, DATA_INTEGRITY.

### 9.6 G5

- Domains read via `get_g5`; domain evidence submission is server-validated; **`g5Pass` is read-only derived** — any client write attempt rejected.

### 9.7 Reconciler

- `reconcile:write`; dry-run produces dryRunHash; apply requires same dryRunHash + current revs; leader fencing; maxActionsPerRun default 100.

### 9.8 Health

- Authenticated `/healthz`: service status, deployed full SHA, schema version, migration status, canonical snapshot ID, board/lifecycle revision, dependency health.
- Staging deploy pass requires /healthz SHA/schema match expected.

## 10. Capacity / priority fail-closed (API fields)

- Spark ≤10; SOL ≤10 global; Grok 5–10 per healthy account starting 5; Grok majority; combined ≤200.
- ≥60 live floor only if ≥60 genuine unique ready collision-safe packets and health permit; else `BELOW_FLOOR` + count + reason.
- Priority portfolio `SALES_WEB_RELATED_BACKEND`; majorityAllocationPass only when frontier exists and share > 0.5; zero capacity / empty frontier N-A semantics (never false PASS as majority success).

## 11. Fail-closed summary

| Condition | Behavior |
|---|---|
| Unauth sensitive MCP read | Deny (401/403); public snapshot only if allowlisted route |
| Missing CSRF on browser write | Reject |
| Scope missing | AUTHORIZATION_REQUIRED |
| Rev mismatch | STALE_REVISION |
| Idempotency conflict | IDEMPOTENCY_CONFLICT |
| Unclassified product claim | UNCLASSIFIED_SCOPE / DATA_INTEGRITY |
| Account sync stale | usableCapacity=0; stale flags |
| Integration second writer | INTEGRATION_LOCKED |

## 12. Related

- Adapter for external MFS: `MFS_CONTROL_PLANE_SYNC_API_V1.md` + OpenAPI YAML.
- UI consumes these envelopes only: `UI_CONTRACT.md`.
