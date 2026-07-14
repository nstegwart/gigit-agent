# Cairn MCP server

Cairn exposes itself as a **Model Context Protocol** server so AI agents can read and
drive the board — an agent connects, learns the conventions, sees what's in flight,
moves work along an evidence-gated lifecycle, and reports its own progress back, so it
never loses context across sessions.

- **Transport:** Streamable HTTP (MCP spec `2025-06-18`), Web-standard `Request`/`Response`.
- **Endpoint:** `/mcp` (dev `http://localhost:3000/mcp`; live `https://task-manager.mfsdev.net/mcp`).
- **Mode:** stateless, JSON responses. No session id. Each request is independent.
- **Auth:** READ tools are open. WRITE tools require the header `X-Cairn-Token: <CAIRN_WRITE_TOKEN>`
  when that env var is set (missing/wrong token on a write → HTTP 401). Ask the owner for the token.
- **Impl:** `src/routes/mcp.ts` (transport + auth gate) + `src/server/board-mcp.ts` (tools/resources).
- **Total:** 51 tools + `cairn://playbook` resource.

## Connect a client

**Claude Desktop / Cursor** — add to the MCP config:

```json
{ "mcpServers": { "cairn": { "type": "http", "url": "https://task-manager.mfsdev.net/mcp" } } }
```

**Claude Code:** `claude mcp add --transport http cairn https://task-manager.mfsdev.net/mcp`

**Raw POST** (every request):

```bash
curl -s https://task-manager.mfsdev.net/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H 'X-Cairn-Token: <token>'   # write tools only
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"get_rollup","arguments":{"boardId":"mfs-rebuild"}}}'
```

Every board tool takes an optional `boardId` (default = the first board). `list_boards` shows
them (e.g. `ibils`, `mfs-rebuild`).

## Tools

### Read
| Tool | Args | Returns |
|---|---|---|
| `list_boards` | — | boards (id, name, views) |
| `list_projects` | boardId? | projects + progress |
| `list_features` | boardId?, projectId?, status? | features (fase, blocked, task counts) |
| `get_feature` | boardId?, id | one feature incl checklist, runs, comments, design |
| `list_runs` | boardId?, status? | agent runs |
| `list_queue` | boardId? | now / next / catatan |
| `list_tasks` | boardId?, projectId?, scope? | tasks + **lifecycleStage, readinessPercent, nextGate, nextEvidence, blockedReason, lastReceiptAt, assignedRunId, lastRunId, lastVerifierRunId** |
| `get_task` | boardId?, id | one full task (20-point mapping + sections) + the same lifecycle readiness fields + rev |
| `get_task_lifecycle` | boardId?, id | stage, rev, implementer run, transition history (authoritative) |
| `get_lifecycle` | boardId? | this board's rail (stages + gate rules) |
| `get_rollup` | boardId? | `formulaVersion, readyStage, readinessPercent, active, hold, prodReady, liveVerified, uninitialized, counts, byProject, byFeature` |
| `get_board_hash` | boardId? | 16-char content hash (read before a bulk snapshot) |
| `list_audit` | boardId?, taskId?, limit? | audit log (gate changes + mutations), newest first |
| `list_accounts` | boardId? | agent-account vault + accounts |
| `get_prod` / `get_guide` / `get_design` / `get_conventions` / `get_workspace` / `list_activity` | see args in tool schema | gates / guide / design / playbook / workspace / activity |

### Lifecycle engine (evidence-gated delivery)
| Tool | Args | Effect |
|---|---|---|
| `set_lifecycle` | boardId?, stages[], allowSkip?, allowRegression?, formulaVersion? | (re)define the board's rail. Each stage: key, label, color, group, gated, requiresEvidence[], verifierRole, **readiness (0-100)**, milestone. **`allowSkip` is always forced false** (legacy rail skip denied on every board). Pin-complete boards must keep the V3 identity nine-stage rail. Requires fresh mutation envelope. |
| `advance_task` | boardId?, id, toStage, **byRunId (req)**, role?, evidence?, verdict?, commitSha?, deployReceipt?, blocker?, expectedRev? | move a task **one** ordered V3 stage (`allowSkip=false`). Requires registered unexpired unfenced byRunId, fresh revs/hashes, stage-specific programmatic receipt. Verifier stages enforce author≠verifier. |
| `init_lifecycle` | boardId?, stage?, onlyUninitialized? | bulk-seed **only first stage `MAPPING`** on a **truly empty** lifecycle (all tasks uninitialized), `onlyUninitialized=true`, fresh envelope. Pin-complete boards forbid init entirely (MAPPING still needs `advance_task`). Later stages require receipts. |
| `replace_accounts` | boardId?, ops | replace vault via durable account-sync **scheduler only**. Missing scheduler → typed `ACCOUNT_SYNC_SCHEDULER_MISSING` (no raw `syncAccounts` fallback / no authority write). |

### Task write suite
| Tool | Args | Effect |
|---|---|---|
| `upsert_task` | boardId?, task, expectedRev? | create/update a task (merge by id); lifecycle preserved; expectedRev = optimistic lock |
| `delete_task` | boardId?, id | remove a task |
| `toggle_task` | boardId?, featureId, index, done? | check a feature checklist item |
| `replace_board_snapshot` | boardId?, projects?/features?/tasks?/productionGates?/guide?/accounts?/runs?, dryRun?, expectedHash? | atomic bulk replace (dry-run + hash guard) |

### Task sections (fully custom task body)
| Tool | Args | Effect |
|---|---|---|
| `add_task_section` | boardId?, taskId, section | append any content block (type ∈ text/callout/fields/list/checklist/table/chips/anchors/variants/links) |
| `set_task_sections` | boardId?, taskId, sections[] | replace all blocks |
| `update_task_section` | boardId?, taskId, sectionId, patch | patch one block |
| `remove_task_section` | boardId?, taskId, sectionId | delete a block |

### Board / project / feature / design / queue
| Tool | Args | Effect |
|---|---|---|
| `create_board` / `update_board` / `delete_board` | see schema | manage boards (name/description/views) |
| `upsert_project` / `delete_project` | boardId?, project / id | manage projects (passthrough fields kept) |
| `upsert_feature` / `delete_feature` | boardId?, feature / id | manage features |
| `set_feature_phase` / `set_blocked` | boardId?, featureId, … | move phase / mark blocked |
| `set_prod` / `set_guide` / `replace_accounts` / `set_queue` | see schema | gates / guide / accounts / queue |
| `set_project_design` / `add_component` | boardId?, projectId, … | upload architecture / component catalog / design-system links |

### Runs & collaboration
| Tool | Args | Effect |
|---|---|---|
| `upsert_run` | boardId?, id, agent?, role?, agentType?, model?, effort?, task?, feature?, taskId?, account?, project?, status?, **targetGate?, evidencePath?, verdict?**, note? | claim/heartbeat a run. No task/gate/receipt → shows UNPRODUCTIVE |
| `set_run_status` | boardId?, id, status | **Legacy** board `runs` doc only (`running`→`done`). Does **not** terminal a V3 registry run or release collision locks. |
| `register_run` | boardId, runId, taskId, targetGate, agentId, model, envelope… | V3 run register (AGENT/ROOT; `run:write`; own-run) |
| `heartbeat_run` | boardId, runId, agentId, fencingToken, heartbeatSequence, envelope… | V3 lease renew + progress |
| `terminate_run` | boardId, runId, fencingToken, toState, reason, envelope… | V3 terminal: AGENT `SUCCEEDED\|FAILED\|CANCELLED`; ROOT may also `STALE\|SUPERSEDED`. Requires entityExpectedRev, expectedBoardRev, canonicalHash, idempotencyKey. Releases collision locks fail-closed. Principal agentId cannot be spoofed. |
| `add_comment` / `open_decision` / `decide_decision` | see schema | collaborate on features/decisions |

## Resource

- `cairn://playbook` — how to use Cairn + branch/worktree naming + status grades (markdown).

## Recommended agent loop (lifecycle-driven)

1. `get_conventions` / `cairn://playbook` — learn the rules. `get_lifecycle` — the board's rail.
2. `get_rollup` — board readiness; `list_tasks` (filter by stage/next-gate) — the work.
3. `list_accounts` — capacity before spawning workers.
4. V3: `register_run` (claim + collision scopes) then `heartbeat_run` while working. Legacy: `upsert_run` for board-doc runs only.
5. Do the work. `advance_task` with a real receipt when a gate is met
   (implementer builds; a **different** run verifies gated verifier stages with a verdict).
6. `get_rollup` / `list_audit` — readback proof. V3: `terminate_run` with fencing + full envelope (`toState=SUCCEEDED|FAILED|CANCELLED`). Legacy board-doc only: `set_run_status` → `done` (does not release V3 locks).

**100% = `PROD_READY`.** `LIVE_VERIFIED` is a post-100 live badge. Progress is the last
proven gate — never a manual %, checkpoint count, or process state. Full field reference and
recipes: the owner's `cairn-mcp-guide.txt`.
