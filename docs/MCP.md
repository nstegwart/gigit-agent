# Cairn MCP server

Cairn exposes itself as a **Model Context Protocol** server so AI agents can read and
drive the board — the payoff of the whole project: an agent connects, learns the
conventions, sees what's in flight, and reports its own progress back, so it never
loses context across sessions.

- **Transport:** Streamable HTTP (MCP spec `2025-06-18`), Web-standard `Request`/`Response`.
- **Endpoint:** `/mcp` (e.g. `http://localhost:3000/mcp` in dev, or your deploy host).
- **Mode:** stateless, JSON responses. No session id, no auth. Each request is independent.
- **Impl:** `src/routes/mcp.ts` (transport) + `src/server/board-mcp.ts` (tools/resources).

## Connect a client

**Claude Desktop / Cursor** — add to the MCP config:

```json
{
  "mcpServers": {
    "cairn": { "type": "http", "url": "http://localhost:3000/mcp" }
  }
}
```

**stdio-only clients** — bridge with mcp-remote:

```json
{ "mcpServers": { "cairn": { "command": "npx", "args": ["mcp-remote", "http://localhost:3000/mcp"] } } }
```

**SDK** (Node):

```ts
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const client = new Client({ name: 'my-agent', version: '1.0.0' })
await client.connect(new StreamableHTTPClientTransport(new URL('http://localhost:3000/mcp')))
const { tools } = await client.listTools()
```

## Tools

Every board tool takes an optional `boardId` (default = the first board). Boards are the
top-level scope; `list_boards` shows them (e.g. `ibils`, `mfs-rebuild`).

### Read
| Tool | Args | Returns |
|---|---|---|
| `list_boards` | — | boards (id, name, views) |
| `create_board` | id, name, description? | creates an empty board |
| `list_projects` | boardId? | projects + progress |
| `list_features` | boardId?, projectId?, status? | features (fase, blocked, task counts) |
| `get_feature` | boardId?, id | one feature incl checklist, runs, comments, design |
| `list_runs` | boardId?, status? | agent runs |
| `list_queue` | boardId? | now / next / catatan |
| `list_tasks` | boardId?, projectId?, scope? | first-class tasks (checkpoint counts) |
| `get_task` | boardId?, id | one task incl checkpoints, deps, story, refs |
| `list_accounts` | boardId? | agent-account vault + accounts (check before spawning workers) |
| `get_prod` | boardId? | path-to-production gates (G0→G6) |
| `get_guide` | boardId? | board guide + rules |
| `get_design` | boardId?, projectId?/featureId? | architecture / design links |
| `get_conventions` | — | the playbook (branch/worktree/usage) |
| `get_workspace` | boardId?, featureId | canonical branch + worktree path + steps |
| `list_activity` | boardId?, limit? | activity feed |

### Write
| Tool | Args | Effect |
|---|---|---|
| `upsert_run` | boardId?, id, agentType?, model?, effort?, task?, feature?, project?, status? | register/update your own run — **claim your work so humans see it** |
| `set_run_status` | boardId?, id, status | running → done |
| `toggle_task` | boardId?, featureId, index, done? | check off a feature task (evidence only) |
| `set_feature_phase` | boardId?, featureId, fase | move a feature's phase |
| `add_comment` | boardId?, featureId, author, text, authorType? | leave a note for a human/agent |
| `open_decision` | boardId?, featureId, question, options?, openedBy? | raise a decision (blocks the feature until a human decides) |
| `set_blocked` | boardId?, featureId, reason | mark blocked → surfaces as "waiting on you" |

## Resource

- `cairn://playbook` — how to use Cairn + branch/worktree naming + status grades (markdown).

## Recommended agent loop

1. `get_conventions` (or read `cairn://playbook`) — learn the rules.
2. `list_queue` — what's active now/next. `get_feature`/`get_task` — the work + checkpoints.
3. `list_accounts` — capacity before spawning workers.
4. `upsert_run` — claim your work (agent · model · effort · task).
5. Work; `toggle_task` / `add_comment` with real evidence. `open_decision` / `set_blocked` if stuck.
6. `set_run_status` → `done`.
