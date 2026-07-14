# MFS Public Consumer Worker Packet (Handoff)

**Document class:** HUMAN + MACHINE WORKER PACKET — **authorization UNRESOLVED**  
**Packet schema:** `TM_MFS_PUBLIC_CONSUMER_WORKER_PACKET_V1`  
**Contract:** `MFS_PUBLIC_CONSUMER_SYNC_CONTRACT_V1`  
**OpenAPI:** `MFS_PUBLIC_CONSUMER_SYNC_V1.openapi.yaml`  
**Related:** `../MFS_SYNC_WORKER_PACKET.md` (control-plane mutation template; complementary)

## 0. Hard status

| Item | Value |
|---|---|
| `writeAuthority` | **EXCLUDED** for gigit-agent product workers |
| `sourcePath` | `/opt/mfs/workspace/CONTRACT` — **named, not granted** |
| `servedPath` | `/var/www/contract` — **named, not granted** |
| `deployAuthority` | **UNRESOLVED** — separate MFS sync worker + owner/root packet required |
| `deployMechanism (observed)` | `publish-grok-accounts.mjs` emits sudo rsync/chown/nginx-reload (do not run from this packet alone) |
| `nginx` / `/etc/nginx/**` | **FORBIDDEN** without separate grant |
| This file alone as run authority | **INVALID** — critical failure if treated as unlock |

### Explicit non-claims

- Not permission to `rsync`, `nginx -s reload`, chown, or edit CONTRACT.
- Not permission to treat consumer MOCK inventory (639 tasks / `MOCK_LABEL`) as TM readiness.
- Not production deploy approval for task-manager.
- Never embed tokens, pool secrets, raw emails, or cookies in receipts.

---

## 1. Mission (when later authorized)

A finite MFS-side worker will:

1. `GET {TM_BASE}/api/public-snapshot?boardId={BOARD_ID}`
2. Honor **ETag / 304** (skip rewrite when unchanged).
3. Honor **429** with backoff (`retry-after` / `retryAfterSeconds`); policy `PUBLIC_SNAPSHOT_RATE_LIMIT_V1`.
4. Validate pin: `canonicalHash`, `boardRev`, `lifecycleRev`, `canonicalSnapshotId`, `serializerVersion=PUBLIC_SNAPSHOT_V1`, `schemaVersion=MFS_PUBLIC_SNAPSHOT_V1`.
5. Validate freshness shape, counts consistency, redaction/masking.
6. **Atomic publish** to serve root without mock labels.
7. Emit publish receipt + keep rollback generation.

---

## 2. Required inputs (future preflight)

| # | Input | Pass |
|---:|---|---|
| P1 | Fresh `RESOLVED_TARGET` listing **exact** external pathspecs for source + serve | non-empty + owner-signed |
| P2 | Root unlock / `SOURCE_EDIT_UNLOCK` for this wave | id recorded |
| P3 | `MFS_PUBLIC_CONSUMER_SYNC_CONTRACT_V1` + OpenAPI SHA-256 | program hash |
| P4 | TM base URL for intended env (staging vs prod) | health or snapshot probe |
| P5 | `BOARD_ID` allowlisted on that env | 200 not 503 STALE_OR_MISSING |
| P6 | Secret material only via env — never committed | grep clean |
| P7 | Capacity accounting for the MFS worker account | root accounting |
| P8 | WORKER_CONTRACT v1 embedded | present |

Preflight exits **BLOCKED** if any of P1–P5 fail.

---

## 3. Exact no-secret boundary

| Allowed in logs/receipts/assets | Forbidden |
|---|---|
| Masked account ids `acc_***XXXX` | Passwords, cookies, bearer tokens, API keys |
| Pin fields, etag, payloadSha256, counts | Raw email / phone / unmasked identity |
| Public task titles already on public snapshot | Private decision text, comments, evidence bodies |
| SHA-256 of configs | Full secret values in WORKER_RESULT |
| Env var **names** for credentials | Env var **values** committed to git |

On accidental secret exposure: **stop**, rotate out-of-band with owner, do not copy secret into evidence files.

Forbidden JSON keys (any depth) include: `password`, `token`, `secret`, `authorization`, `cookie`, `api_key`/`apiKey`, `accessToken`, `refreshToken`, `sessionId`, `rawIdentity`, `credentials`, comment/evidence/private decision fields.

---

## 4. Algorithm (normative)

```
loop or cron (respect rate limit):
  etag_prev = read last receipt etag or empty
  headers = { Accept: application/json }
  if etag_prev: headers[If-None-Match] = quote(etag_prev)

  res = GET /api/public-snapshot?boardId=BOARD_ID

  if res.status == 304:
    record "unchanged"; exit 0 without rewrite
  if res.status == 429:
    sleep(retry-after); retry with budget; never tight-loop
  if res.status == 503:
    BLOCKED or skip publish; never invent payload
  if res.status != 200:
    fail closed

  payload = JSON(res.body)
  validate_schema_and_pin(payload)          # fail → no publish
  validate_freshness(payload)
  validate_counts(payload)
  validate_redaction(payload)               # fail → no publish
  assert header etag == payload.etag
  assert no mock labels in mapped assets

  staging = create_temp_dir(publishId)
  write_all_assets(staging, map(payload))
  fsync(staging)
  atomic_swap(staging → SERVE_ROOT)
  write_receipt(pin, etag, counts, fetchedAt, publishId)
  retain SERVE_ROOT.prev for rollback
```

### 4.1 Atomic publish rules

- **mode** must be `atomic_rename` (or equivalent all-or-nothing swap).
- **noMockLabels** must be `true`.
- Reject asset content matching mock/preview gates, e.g.:
  - `MOCK_LABEL`
  - `MOCK —`
  - `status_cap` presenting `LOCAL ONLY` / `NOT SHIPPABLE` as live board readiness
  - Manifest task counts from static inventory that disagree with validated public-snapshot counts **without** an explicit `contentClass: inventory_placeholder` (placeholders must not replace pin truth).

### 4.2 Rollback

| Trigger | Action |
|---|---|
| Validation failure before swap | Delete staging; leave live tree untouched |
| Partial write / swap failure | Restore `.prev` generation if swap incomplete |
| Post-publish redaction discovery | Restore `.prev`; open incident; rotate if secrets |

Receipt field `rollback.strategy` must document previous-generation retention.

---

## 5. Source / deploy authority (unresolved checklist)

Owner must answer before any mutation run:

1. **Who** owns deploy? (named human/role — not "the orchestrator by default")
2. **Which** pathspecs are writable this wave?
3. **Which** TM base (staging tunnel vs production) is the pin authority?
4. Is production TM out of 502 / approved for live public-snapshot readback?
5. Is nginx reload in-scope or forbidden?
6. What is the rollback owner on-call?

Until answered, status for consumer mutation remains **BLOCKED** / **EXCLUDED**.

---

## 6. Conformance before first publish

```bash
# Offline gates (always)
node qa/e2e/flows/public-consumer-conformance.mjs
pnpm test:unit -- tests/unit/public-consumer-sync-contract.test.ts

# Live gates against authorized TM base only
WEB_BASE=$TM_BASE BOARD_ID=mfs-rebuild \
  node qa/e2e/flows/public-consumer-conformance.mjs
```

LIVE mode must print `OWNER_TARGET:` and must not claim consumer publish success.

---

## 7. Receipts required (future terminal)

| Field | Required |
|---|---|
| `status` | NOT READY / LOCAL ONLY / FUNCTIONAL / DONE / BLOCKED |
| `run_id` | controller-issued |
| `authorization_basis` | root unlock id — **not** this packet alone |
| `resolved_target_sha` | hash of RESOLVED_TARGET used |
| `openapi_sha256` | of `MFS_PUBLIC_CONSUMER_SYNC_V1.openapi.yaml` |
| `tm_base` / `boardId` | exact |
| `pin` | full pin object from validated 200 |
| `etag` | from 200 or 304 retained |
| `counts` | tasks/runs/accounts/buckets/usableCapacity |
| `publish_paths` | exact pathspecs touched |
| `forbidden_paths_untouched` | proof command |
| `conformance_exits` | command + exit code |
| `secrets_absent` | program check |
| `rollback` | strategy + whether invoked |
| `residual_gaps` | required if status ≥ FUNCTIONAL |
| `WORKER_RESULT_END` | final line |

Never claim **DONE** from schema/docs existence alone.  
Never claim **DONE** for consumer shippability without real serve-path publish proof **and** pin parity.

---

## 8. Investigation anchors (read-only)

- `WORKER_RESULT_investigate-final-public-parity-r3.md` — consumer mock vs staging pin vs prod 502
- `.artifact/evidence/TM-P0-ULTIMATE-CONTROL-CENTER-V3/RESOLVED_TARGET.json` → `publicConsumer`
- Fixtures under `qa/fixtures/public-consumer-sync/`

---

## 9. Status of this packet

| Layer | Status |
|---|---|
| Packet document exists | Yes |
| External mutation authorized | **No** |
| Deploy authority | **Unresolved** |
| Source/serve path mutation | **Excluded** |
