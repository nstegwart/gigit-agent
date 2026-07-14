# Public consumer sync handoff (contract-only)

Versioned handoff for a **separate** MFS sync worker that consumes task-manager
`GET /api/public-snapshot` and (when authorized elsewhere) publishes public-consumer
assets atomically.

| Artifact | Role |
|---|---|
| `MFS_PUBLIC_CONSUMER_SYNC_CONTRACT_V1.md` | Narrative normative contract |
| `MFS_PUBLIC_CONSUMER_SYNC_V1.openapi.yaml` | OpenAPI 3.1 machine schema |
| `MFS_PUBLIC_CONSUMER_WORKER_PACKET.md` | Human packet; deploy authority **unresolved** |
| `examples/*` | Non-secret examples |
| `../../../qa/fixtures/public-consumer-sync/*` | Conformance fixtures + validators |
| `../../../qa/fixtures/public-consumer-sync/conformance-lib.mjs` | Pure ESM validators (runtime) |
| `../../../qa/fixtures/public-consumer-sync/conformance-lib.d.mts` | Adjacent types for unit/typecheck (no emit) |
| `../../../qa/e2e/flows/public-consumer-conformance.mjs` | Executable conformance self-test |
| `../../../tests/unit/public-consumer-sync-contract.test.ts` | Unit gates |

**Promoted flow index note:** consumer-side harness entry is
`qa/e2e/flows/public-consumer-conformance.mjs` (fixture mode; no deploy).
When updating the global flow table, index it under `qa/e2e/README.md` → Flow index
(row not writable from this package pathspec alone).

**Not in scope:** `/opt/mfs/workspace/CONTRACT`, `/var/www/contract`, nginx, deploy, consumer mutation.

```bash
node qa/e2e/flows/public-consumer-conformance.mjs
pnpm test:unit -- tests/unit/public-consumer-sync-contract.test.ts
```
