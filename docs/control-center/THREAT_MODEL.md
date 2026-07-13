# Threat Model (C0 Design Freeze)

**Document class:** DESIGN CONTRACT
**Checkpoint:** C0
**Schema version:** `TM_THREAT_MODEL_V1`
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


## 1. Actors

| Actor | Trust | Capabilities (design) |
|---|---|---|
| OWNER | High | Sensitive read; resolve Decisions; exact approvals/policy; cannot impersonate agent evidence |
| ROOT_ORCHESTRATOR | High (automation) | Dispatch plan; lifecycle acceptance; reconcile auth; account sync auth; dispatch verifiers/integrators; **no** owner-only production approval |
| AGENT | Medium | Bounded read; register/heartbeat own run; submit evidence; request Decision; no final acceptance/dispatch/raw accounts |
| INTEGRATOR | Medium | Read accepted checkpoint/pathspecs; integration lock; commit/push receipt; no lifecycle self-acceptance |
| PUBLIC | Low | Sanitized public snapshot only |
| Malicious network client | Untrusted | Probe UI/MCP/public; attempt injection/DoS |
| Compromised agent process | Untrusted code | Malicious evidence text, forged receipts, lock abuse |
| MFS sync identity | Separate authorization | Masked account sync only when granted; never tokens |
| Staging operator | Medium | Deploy/migrate staging only |
| Production host / Cairn | External | Read-only probes; no secret exfiltration into this repo |

## 2. Assets

| Asset | Sensitivity |
|---|---|
| Board/task/lifecycle truth | High |
| Dispatch plans / NEXT | High (integrity) |
| Run claims / locks / fencing tokens | High |
| Account state (masked) | Medium; tokens **critical — never store/transmit** |
| Decision private text / owner comments | High |
| Evidence bodies / verifier receipts | High |
| Canonical snapshot / revisions / hashes | High integrity |
| Session cookies / CSRF tokens / MCP tokens | Critical |
| Deployed SHA / schema / /healthz | Medium |
| Public snapshot | Low (allowlisted only) |
| Audit log | High integrity / non-repudiation |

## 3. Trust boundaries

1. Browser ↔ authenticated UI/API (session + CSRF)
2. Agent runners ↔ MCP/API (scoped tokens / agent identity)
3. Public internet ↔ public snapshot endpoint (rate limited)
4. Source laptop ↔ staging Docker (SSH tunnel 33211)
5. Source laptop ↔ production (HTTPS read-only; currently 502 observed)
6. Task-manager control plane ↔ MFS pool/runner (adapter; out of write scope)
7. Task-manager ↔ public consumer rsync path (excluded writes)
8. Import pipeline ↔ external canonical snapshot producer

## 4. STRIDE-style threats

| ID | Category | Threat | Impact | Mitigation (design) | Test (later) |
|---|---|---|---|---|---|
| T-S1 | Spoofing | Unauth MCP tools/list/read exposes board/lifecycle/run/account | Data disclosure | Auth gate all sensitive reads; public allowlist only | AC-AUTH-01/02 |
| T-S2 | Spoofing | Agent impersonates another agent/run | False progress | Run registration binds agent ID; fencing; role checks | AC-INGEST-04 AC-LOCK-* |
| T-S3 | Spoofing | Forged integrator commit | False INTEGRATED | Integration lock + root acceptance + pathspecs + dedicated role | AC-LOCK-03 AC-LIFE-* |
| T-T1 | Tampering | Client recomputes readiness/buckets | Inflated progress | Server-only pinned aggregation | AC-READY-* AC-BUCKET-* AC-API-04 |
| T-T2 | Tampering | Stale rev overwrite | Lost updates / skip gates | entityExpectedRev + expectedBoardRev → STALE_REVISION | AC-API-03 |
| T-T3 | Tampering | Lifecycle skip / self-verify | False PROD_READY | allowSkip=false; opposite model; independent verifier | AC-LIFE-03/04 |
| T-T4 | Tampering | Duplicate joins inflate denominators | False readiness | DISTINCT + import reject | AC-COUNT-01/02 |
| T-R1 | Repudiation | Missing audit for material events | Cannot attribute | Immutable material audit; retention policy | AC-OPS-04 |
| T-R2 | Repudiation | Hand-typed PASS | False DONE | Program-emitted receipts only; claim-audit | AC-CLAIM-* |
| T-I1 | Info disclosure | Public snapshot leaks private decisions/tokens | Privacy breach | Field allowlist; redaction | AC-PUBLIC-03 |
| T-I2 | Info disclosure | Logs contain secrets | Credential leak | Structured log redaction | AC-OPS-02 |
| T-I3 | Info disclosure | SSRF via import/URL fields | Internal pivot | No arbitrary fetch from user URLs; allowlisted producers | security suite C4 |
| T-D1 | DoS | Public snapshot flood | Availability | 60/min burst20 429 | AC-AUTH-05 |
| T-D2 | DoS | Heartbeat storm fills audit | Storage/latency | Heartbeat ≠ immutable audit; sampling | AC-OPS-04/05 |
| T-D3 | DoS | Unbounded reconciler | CPU thrash | maxActionsPerRun 100; cursor/time budget | AC-OPS-05 |
| T-E1 | Elevation | Member elevates to lifecycle write | Unauthorized transition | RBAC roles/scopes | AC-AUTH-03/04 |
| T-E2 | Elevation | Decision broadens production authority | Unauthorized prod deploy | Explicit rule: Decision never broadens prod/HOLD/provider | AC-GATE-02/03 |
| T-E3 | Elevation | Path traversal via collision lock IDs / pathspecs | Write outside scope | Canonical lock IDs; pathspec allowlist at integrate | AC-LOCK-01 AC-GIT-03 |

## 5. Required attack classes (explicit)

| Class | Design control |
|---|---|
| XSS | Escape/encode agent text & decision titles; CSP where stack supports; never `dangerouslySetInnerHTML` for untrusted |
| CSRF | Browser mutations require CSRF token; MCP uses non-cookie auth |
| SSRF | Import/producer only from authorized control-plane paths; no user-supplied fetch targets |
| Injection (SQL/command) | Parameterized queries; no shell with user data |
| Path traversal | Normalize pathspecs; reject `..`; integrate only allowed pathspecs |
| Replay | Idempotency 24h; fencing tokens; sequence numbers on heartbeat |
| Stale revision | STALE_REVISION on mismatch; return safe current revs |
| Receipt forgery | Bind receipt hashes to task/canonical/board/lifecycle revs; independent verifier |
| Malicious agent text | Treat as untrusted UI content; store length limits; no script execution |
| Public leakage | Allowlist fields; no tokens/raw identity/private decision bodies |
| DoS | Rate limits; reconciler bounds; payload size limits |
| Elevation | Five-role matrix; scopes; step-up where supported |

## 6. Known open MCP baseline (G0 observed facts)

Prior / preflight baseline (not current success):

- Unauthenticated UI redirected to `/login` (when app healthy).
- Unauthenticated MCP `tools/list` / read could expose board, lifecycle, run, account data.
- Production UI/MCP observed **HTTP 502** at `2026-07-13T07:40:56Z` (app process absent) — recheck when process returns; do not treat 502 as security PASS.

**Remediation requirement:** unauthenticated access = sanitized allowlisted public snapshot only.

## 7. Role / scope matrix

### Roles

`OWNER`, `ROOT_ORCHESTRATOR`, `AGENT`, `INTEGRATOR`, `PUBLIC`

### Read scopes

`board:read`, `task:read`, `run:read`, `account:read`, `decision:read`, `evidence:read`, `audit:read`

### Write scopes

`dispatch:write`, `lifecycle:write`, `run:write`, `decision:write`, `import:write`, `reconcile:write`, `account:sync`, `integration:write`, `policy:write`

| Role | Representative allows | Hard denials |
|---|---|---|
| OWNER | decision:write (resolve), policy approvals, sensitive read | Impersonate agent evidence; silent prod deploy without approvalId |
| ROOT_ORCHESTRATOR | dispatch:write, lifecycle:write, reconcile:write, account:sync | Owner-only productionApprovalId |
| AGENT | run:write (own), evidence submit, decision:write (request) | dispatch:write, final lifecycle accept, raw account |
| INTEGRATOR | integration:write | lifecycle self-accept |
| PUBLIC | public snapshot GET | All sensitive MCP/API |

## 8. Residual blockers (design-visible)

| Residual | Why open at C0 |
|---|---|
| Production process down (502) | No live auth re-probe until process exists or staging proves model |
| Existing UI roles admin/member | Must map/evolve to five-role matrix without inventing silent production auth — may need DECISION_AUTH_MECHANISM_REQUIRED |
| MFS pool/runner excluded | Account truth depends on separate authorized worker |
| FABLE future unavailability | BLOCKED_FABLE_UNAVAILABLE path at C5; no substitution |

## 9. Mitigations → acceptance / checkpoint

Security-relevant AC: AC-AUTH-01..05, AC-API-02/03, AC-LOCK-*, AC-PUBLIC-*, AC-OPS-02, AC-LIFE-03, AC-GATE-02/03, AC-GIT-03, AC-CLAIM-*.
Implementation checkpoint primarily **C2** (auth/RBAC/rate-limit) + **C4** security suite + **C5** independent verifier.
