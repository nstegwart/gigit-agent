# MFS Sync Worker Packet (Future Authorization Template)

**Document class:** DESIGN CONTRACT — **future worker packet template only**
**Checkpoint:** C0 (authored as design handoff artifact)
**Schema version:** `TM_MFS_SYNC_WORKER_PACKET_V1`
**Source SHA:** `3c8a855dabd68a1d8a701597da16969756ee6511`

## DESIGN CONTRACT vs IMPLEMENTATION PROOF

| Layer | Status in this document |
|---|---|
| **DESIGN CONTRACT** | Template for a **separately authorized** future MFS mutation worker. |
| **Current authorization** | **NONE.** This packet is **not** permission to run, mutate, deploy, or edit MFS surfaces today. |
| **Implemented / runtime proof** | **Not claimed.** |

### Explicit non-claims (HARD)

- This file is **not** current write authority for any MFS path.
- Staging gate remains `TASK_MANAGER_STAGING_VERIFIED` only for the task-manager implementer track.
- Live remains `AWAITING_PRODUCTION_APPROVAL_DEPLOY_READBACK`.
- No live P0 PASS, no mass-refill unlock, no FABLE PASS.
- Production and public-consumer writes remain **excluded** until a **new** root-issued RESOLVED_TARGET / owner approval names them.
- Synthetic staging data remains default without dual production-read + staging-load approvals.
- Production HTTP 502 / open-read baselines are G0 observed facts, not implementation success.
- **Never** embed tokens, pool secrets, or raw account identity in this packet or its receipts.


## 1. Purpose

When (and only when) root/owner grants a finite external mutation package, this packet defines the bounded work for an MFS-side adapter worker that:

1. Publishes masked account state into the task-manager control plane via `MFS_CONTROL_PLANE_SYNC_API_V1`.
2. Optionally wires runner `register_run` / `heartbeat_run` clients against the same contract.
3. Optionally materializes public-consumer outputs **only** if RESOLVED_TARGET explicitly lists public-consumer pathspecs (currently **excluded**).

The control-plane server implementation lives in the **gigit-agent** task-manager repo under later C2 packages. This packet covers **external** MFS repos only when listed.


## 2. Explicit prohibition on treating this as current authorization

| Statement | Binding |
|---|---|
| C0 author wrote this file | Design freeze only |
| Orchestrator included path in C0_DESIGN writePaths | Document existence only |
| RESOLVED_TARGET.publicConsumer.writeAuthority | Currently `EXCLUDED` |
| externalAdapterScope | contract-only artifacts inside task-manager repo |

**Any worker that mutates MFS paths using only this document as authority has violated WORKER_CONTRACT and path boundary.** Required: a fresh root packet with:

- `TASK_ID` for the MFS mutation wave
- populated `RESOLVED_TARGET` listing exact external pathspecs
- `SOURCE_EDIT_UNLOCK` or equivalent for that wave
- capacity reservation and WORKER_CONTRACT v1


## 3. Finite external scope (when authorized)

### 3.1 Candidate path classes (must be explicitly listed to become live)

| Class | Example paths (illustrative only) | Default authority |
|---|---|---|
| Account pool publisher | `/opt/mfs/workspace/tools/grok-account-pool/**` | EXCLUDED |
| CONTRACT source | `/opt/mfs/workspace/CONTRACT/**` | EXCLUDED |
| Public served assets | `/var/www/contract/**` | EXCLUDED |
| nginx runtime | `/etc/nginx/**` | EXCLUDED |
| Runner clients | MFS runner repos (unnamed until granted) | EXCLUDED |

### 3.2 Always-forbidden without separate production approval

- Production task-manager deploy/restart/DB migration
- Mass-refill unlock
- Copying Cairn secrets into any repo
- Force-push, worktree, branch switch outside granted integration branch
- `--accounts all`


## 4. Required inputs (future preflight)

Before any external edit, the future worker must consume **read-only**:

1. Fresh `RESOLVED_TARGET` listing external pathspecs
2. `MFS_CONTROL_PLANE_SYNC_API_V1.md` + OpenAPI YAML (hashes recorded)
3. Staging control-plane base URL and auth material **injection via env** (never committed)
4. Live auth/DB preflight artifacts if read-only diagnosis needed
5. Capacity accounting IDs (Spark/SOL/Grok caps)
6. WORKER_CONTRACT v1 verbatim

Preflight exits BLOCKED if:

- external pathspec missing from RESOLVED_TARGET
- detached HEAD / wrong branch
- dirty overlap on forbidden paths
- control-plane healthz SHA mismatch for target env
- secret material present in working tree docs


## 5. Preflight checklist (machine-checkable)

| # | Check | Pass |
|---:|---|---|
| P1 | `RESOLVED_TARGET` includes this wave's external pathspecs | path list non-empty + signed |
| P2 | OpenAPI `info.version == MFS_CONTROL_PLANE_SYNC_API_V1` | parse OK |
| P3 | Control-plane `/healthz` SHA/schema match intended env | program-emitted |
| P4 | No secret-like strings in packet/receipts | grep clean |
| P5 | Synthetic or dual-approval data mode explicit | AC-DATA-01/02 |
| P6 | Capacity remaining under Spark≤10 / SOL≤10 / Grok 5–10 / ≤200 | root accounting |
| P7 | Public-consumer write still EXCLUDED unless listed | assert |


## 6. Conformance and readback matrix

| Surface | Operation | Readback proof |
|---|---|---|
| Control plane MCP/API | `sync_accounts` | same `sourceRevision`/`generatedAt` on MCP+API+UI+Ops ≤30s |
| Control plane | `publish_dispatch_plan` | NEXT parity rank/reason (if this worker is root-side; usually root keeps this) |
| Control plane | `register_run` / `heartbeat_run` | run visible ≤30s; fencing holds |
| Public consumer | materialization (if granted) | revision/hash/count parity; redaction allowlist |
| Fail-closed | missed publish | `ACCOUNT_SYNC_STALE`, usableCapacity=0 |

Conformance tests must live with the authorized repo(s) once granted; reference fixtures use synthetic IDs only.


## 7. Secret boundary

| Allowed | Forbidden |
|---|---|
| Env-injected short-lived credentials | Committing tokens to git |
| Masked account IDs in logs | Raw email/phone/password/API keys |
| SHA-256 of configs | Full secret values in WORKER_RESULT |
| Redacted export manifests | Private decision bodies in public artifacts |

On accidental secret exposure: stop, rotate out-of-band with owner, do not write the secret into evidence files.


## 8. Receipts required (future terminal)

Future worker result must include:

| Field | Required |
|---|---|
| `status` | NOT READY / LOCAL ONLY / FUNCTIONAL / DONE / BLOCKED only |
| `run_id` | controller-issued |
| `resolved_target_sha` | hash of RESOLVED_TARGET used |
| `openapi_sha256` | of sync OpenAPI file |
| `pathspecs_touched` | exact list |
| `forbidden_paths_untouched` | proof command |
| `conformance_exits` | command + exit code per row |
| `readback_proofs` | multi-surface timestamps |
| `secrets_absent` | program check |
| `authorization_basis` | root unlock ID — **not** this C0 file alone |
| `residual_gaps` | required if status ≥ FUNCTIONAL |
| `WORKER_RESULT_END` | final line |

Never claim DONE from schema existence alone.


## 9. SLA reminders (must match control-plane contract)

- Triggered account state multi-surface publish ≤ **30s**
- Periodic health ≥ every **60s**
- Public snapshot rate limit reference: **60/min/IP**, burst **20**
- Idempotency TTL **24h**
- Cursor default **50** / max **200**


## 10. Relationship to C0 design freeze

| Artifact | Role |
|---|---|
| This packet | Future external mutation template |
| `MFS_CONTROL_PLANE_SYNC_API_V1.md` + OpenAPI | Authoritative adapter schema (docs-only at C0) |
| `API_CONTRACT.md` | Control-plane authenticated surface |
| C2 package in GATE1_EDIT_SCOPE | Server implementation pathspecs inside gigit-agent |
| Public consumer deploy | Still EXCLUDED; live P0 owner-gated |

## 11. Status of this C0 artifact

`IMPLEMENTED_PENDING_VERIFICATION` applies **only** to the existence of this design template document.
Product/runtime/external mutation status remains **not implemented** and **not authorized**.
