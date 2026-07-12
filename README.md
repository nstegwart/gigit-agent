# Cairn — agent work board

A lightweight, **agent-native** work board: `Project → Feature → Task`, with a live
**agent runtime** panel (which agent is running, on what model, at what effort, on which task).
Built so AI agents don't lose context across sessions — read the board over **MCP**, report
progress back over MCP, and a human watches it all in a clean web UI.

Built on the [TanStack](https://tanstack.com/) stack: **Start** (SSR, server functions),
**Router** (type-safe file routes), **Query** (data), **Table** (features grid), **Store**
(theme/search) — React 19 + Vite + TypeScript (strict).

> Generic open-source tool. The bundled `data/` is seed/demo data; point it at your own board.

## Run

```bash
pnpm install
pnpm dev            # dev server (http://localhost:3000)
pnpm build          # production build
pnpm preview --port 3210   # serve the production build (SSR + server fns + MCP)
```

## Test

```bash
pnpm typecheck      # tsc --noEmit
pnpm test:unit      # vitest (model / format / data-store)
pnpm build && pnpm test:e2e   # Playwright against the production build
```

Current: **tsc 0 errors · 24 unit · 26 e2e**, all green.

## Data (SSOT)

Git-native JSON — humans and agents both edit; git is the history.

- `data/plan.json` — projects, features (with `checklist` tasks), decisions, queue, log.
- `data/runs.json` — live agent runtime (`agent · agentType · model · effort · task · status`).

`src/lib/model.ts` (`buildModel`) is the canonical adapter raw → typed UI model.
Server functions in `src/server/board.ts` read/write these files (atomically); the client
rebuilds the model from the raw board via TanStack Query.

## MCP

Cairn is a real **MCP server** (spec 2025-06-18, Streamable HTTP) at `/mcp`, so any MCP
client — Claude Desktop, Cursor, or the SDK — can drive the board. Stateless + JSON, no auth.
See **[docs/MCP.md](docs/MCP.md)** for the full tool reference + connection guide.

Connect (Claude Desktop / Cursor `mcp.json`):

```json
{ "mcpServers": { "cairn": { "type": "http", "url": "http://localhost:3000/mcp" } } }
```

Or bridge to a stdio-only client: `npx mcp-remote http://localhost:3000/mcp`.

Tools (all take an optional `boardId`, default = first board): `list_boards` · `create_board` ·
`list_projects` · `list_features` · `get_feature` · `list_runs` · `list_queue` · `toggle_task` ·
`set_feature_phase` · `upsert_run` · `set_run_status` · `get_conventions` · `get_workspace` ·
`get_design` · `add_comment` · `open_decision` · `set_blocked` · `list_activity` ·
`list_tasks` · `get_task` · `list_accounts` · `get_prod` · `get_guide`. Resource: `cairn://playbook`.

```bash
# raw JSON-RPC (initialize optional in stateless mode)
curl -s -X POST http://localhost:3000/mcp -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"list_boards","arguments":{}}}'
```

## Structure

```
data/                 plan.json + runs.json (SSOT)
src/lib/              types · model (adapter) · format · icons · board-query
src/store/ui.ts       theme + search (TanStack Store)
src/server/           board-store (fs, atomic) · board (server fns) · board-mcp (tools)
src/components/       AppShell · primitives · RunCard/QueueCard/ProjectCard/FeatureRow/
                      KpiStrip/Checklist/FeaturesTable/DecisionCard/Timeline
src/routes/           file routes: / agents projects[/$id] features[/$id] decisions log mcp
tests/unit/           vitest    tests/e2e/  Playwright
docs/AGENT_CONTRACTS.md   spine API + conventions
```
