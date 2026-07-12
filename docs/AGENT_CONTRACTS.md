# Cairn build — agent contracts (READ FIRST)

You are building **Cairn**, an agent work board, on **TanStack Start** (React 19 + Router + Query + Table + Store, Vite 8, TypeScript strict). Port the finished prototype into this typed React app. Match the prototype's markup + CSS classes EXACTLY.

- Project root: `/Users/user/Project/ibils-orchestrator/gigit-project-orchestration`
- **Prototype source of truth (READ the function you are porting):**
  `/Users/user/Project/ibils-orchestrator/ibils-budget-tracker/docs/plan/assets/app.js`
  (view builders: `vBoard`, `vAgents`, `vProjects`, `vProject`, `vFeature`, `vFeatures`, `vDecisions`, `vLog`; card builders: `runCard`, `qcard`, `projCard`, `featRow`). CSS already ported → `src/styles.css` (all classes exist: `.run .qcard .proj .kpi .section .sec-head .runs-grid .qgrid .proj-grid .feat-row .ftable .decision .timeline .card .grid-2 .check .meta-row .banner .wrap .queue-rail .queue-lbl .phase .chip .tag .mini-ag .run-status .bar .progress .detail-head .back` …). DO NOT add CSS unless a class is genuinely missing.

## Spine (already built — IMPORT, never modify)

```ts
// types
import type { Model, Project, Feature, Run, Decision, LogEntry, Task, FeatureLink } from '#/lib/types'
// adapter (server+client): buildModel(raw)
// format helpers
import { fmtDate, dur, PALETTE, PHASE_CLS, STATUS_LBL, PROJ_STATUS, AGENT_ICON, ACTIVE_PHASES } from '#/lib/format'
// icons: <Icon name="board|agents|projects|features|decisions|log|play|lock|check|arrow|chevL|branch|link|ext|folder|inbox|layers|sparkles|bolt|terminal|dot|alert|clock|users|flag" size={15} className="" />, <BrandMark/>
import { Icon, BrandMark } from '#/lib/icons'
// DATA: the ONLY way to get board data in a component
import { useBoard, boardQueryOptions, useToggleTask } from '#/lib/board-query'
//   const m: Model = useBoard()   // suspense-backed; always present
// UI store (search box lives in AppShell)
import { uiStore, setSearch } from '#/store/ui'
import { useStore } from '@tanstack/react-store'
//   const q = useStore(uiStore, (s) => s.search)   // filter your lists by this (lowercased includes)
// shared primitives (IMPORT these; do NOT re-implement chips)
import {
  Chip, PhaseBadge, EffortChip, ModelChip, TypeTag, MiniAgent, RunStatusPill,
  ProgressBar, ProjectPill, EmptyState, RunFooter,
} from '#/components/primitives'
```

### Model shape (from `#/lib/types`)
- `Model`: `{ projects, projById, features, featById, runs, queue:{now:Feature[], next:Feature[], catatan?}, blocked:Feature[], active:Feature[], parked:Feature[], runningAgents:Run[], decisions:Decision[], log:LogEntry[], docs, updated? }`
- `Feature`: raw fields (`id, nama, kelompok?, track?, tier?, fase, impact?, catatan?, checklist?:Task[], deps?, blocked?, links?:{label?,url}[], branch?, bucket?, updated?`) **plus derived** `projectId, taskTotal, taskDone, parked, isBlocked, isDone, pct:number|null, phaseLabel, phaseCls, runs:Run[]`.
- `Project`: raw (`id, nama, status, tracks?, ringkas?, stage?, repo?, docs?`) **plus** `color, features:Feature[], progress, activeAgents`.
- `Run`: `{ id, agent, role?, agentType:'claude'|'grok'|'codex'|string, model, effort, task, feature?:string|null, project?:string|null, status:'running'|'blocked'|'queued'|'done'|'failed', started?, updated?, note? }`.
- `Decision`: `{ id, teks, status, aksi?, keputusan?, tanggal_putus? }`.

## Conventions (MANDATORY)
1. **TanStack Router file routes** in `src/routes/`. Each route:
   ```tsx
   import { createFileRoute } from '@tanstack/react-router'
   import { boardQueryOptions, useBoard } from '#/lib/board-query'
   export const Route = createFileRoute('/agents')({
     loader: async ({ context }) => { await context.queryClient.ensureQueryData(boardQueryOptions()) },
     component: AgentsView,
   })
   function AgentsView() { const m = useBoard(); /* … */ }
   ```
   Dynamic routes: file `projects.$projectId.tsx` → `createFileRoute('/projects/$projectId')`; read `const { projectId } = Route.useParams()`.
2. **Navigation / links** use `<Link>` from `@tanstack/react-router` (NOT `<a href>` for internal nav, NOT `location.hash`):
   `<Link to="/features/$featureId" params={{ featureId: f.id }} className="…">`. For a clickable card, wrap content in `<Link>` (block) — do not use `onClick={location.hash=…}`.
3. **The AppShell (sidebar/topbar/search/theme) already wraps every route** — routes render ONLY their page body (start with `<>` or a fragment / sections). Do NOT render `<html>`, sidebar, or topbar.
4. TypeScript strict, `noUnusedLocals` ON. No `any`. Match prototype text/labels EXACTLY (English chrome, Indonesian data passes through).
5. **Before you finish**: run `cd <root> && pnpm exec tsc --noEmit 2>&1 | grep "<your-file>"` — fix every error in YOUR file. Return the list of files you created/edited.
6. Do NOT touch files outside your assignment. Do NOT edit spine files (`src/lib/*`, `src/store/*`, `src/components/primitives.tsx`, `src/components/AppShell.tsx`, `src/routes/__root.tsx`, `src/server/*`) unless your task explicitly says so.

## Write path (interactivity) — feature detail tasks
Task checklist toggling persists via:
```ts
const toggle = useToggleTask()
// onClick: toggle.mutate({ featureId: f.id, index })
```
The server writes `data/plan.json` and returns the fresh board → cache updates → UI re-renders.

---

## Batch 2 — system design · wire graph · MCP playbook · collaboration

New spine (IMPORT, never modify):
- `Model` adds: `activity: ActivityEvent[]` (log + collab merged, newest first), `openDecisions: Decision[]`, `conventions?: Conventions`.
- `Feature` adds: `design: FeatureLink[]`, `comments: Comment[]`, `depth: number` (dependency depth).
- `Project` adds: `design: FeatureLink[]`; already has `komponen?: {nama,jenis,stack,status,ket}[]` and `docs?: {overview,baseline,arsitektur,scope}`.
- `Decision`: `status: 'open'|'decided'|'blocked'`, `opsi?: {key,label,rekomendasi?}[]`, `keputusan?`, `tanggal_putus?`, `featureId?`.
- Types `ActivityEvent {ts,actor,actorType?,kind,text,featureId?}`, `Comment {id,featureId,author,authorType:'human'|'agent',text,ts}`.
- Graph: `import { layoutDag, edgePath, NODE_W, NODE_H } from '#/lib/graph'` → `GraphLayout {nodes:{id,feature,x,y,w,h}[], edges:{from,to,blocked}[], width, height, cols}`; `edgePath(fromNode,toNode)` → SVG path string.
- Mutation hooks (each `.mutate(vars)`, cache auto-updates): `useAddComment({featureId,author,authorType?,text})`, `useOpenDecision({featureId,question,options?})`, `useDecideDecision({id,answer,keputusan?})`, `useAddDesignLink({scope:'project'|'feature',id,label?,url})`, `useClearBlocked({featureId})`.

Nav already has **Map** (`/map`) and **Design** (`/design`) — build those routes.

Leaf files to build:
- `src/components/WireGraph.tsx` `{ features: Feature[] }` — render `layoutDag(features)` as an SVG (width/height from layout, wrap in a `overflow:auto` div). Edges via `edgePath` (arrowhead `<marker>`, red when `blocked`). Each node = a block `<Link to="/features/$featureId" params>` positioned with the node x/y/w/h, showing phase-colored left border + feature name + `taskDone/taskTotal`. EmptyState if no features/edges.
- `src/components/Architecture.tsx` `{ project: Project }` — `project.komponen[]` as component cards (nama, `jenis` badge, `stack` chip, `status`), plus `arsitektur`/`baseline` text from `project.docs`.
- `src/components/DesignLinks.tsx` `{ scope:'project'|'feature', id:string, links:FeatureLink[] }` — list links (ext icon) + inline "add link" form (url + optional label) using `useAddDesignLink`.
- `src/components/CommentThread.tsx` `{ feature: Feature }` — `feature.comments` (author + `authorType` badge + text + `fmtDate(ts)`) + add-comment form (`useAddComment`, authorType 'human', author 'you').
- `src/components/ActivityFeed.tsx` `{ activity: ActivityEvent[]; limit?: number }` — timeline (actor, `kind` chip, text, `fmtDate(ts)`).
- `src/components/DecidePanel.tsx` `{ decision: Decision }` — open decision: question + `opsi` as buttons; clicking calls `useDecideDecision` (answer = option.key, keputusan = option.label); recommended option highlighted. Uses `.decision` styling.

Routes:
- `src/routes/map.tsx` (`/map`) — `<WireGraph features={filtered} />` over all features, with project filter chips (reuse `.fbtn`), a small legend, section header + count.
- `src/routes/design.tsx` (`/design`) — per project: `<Architecture project={p}/>` + `<DesignLinks scope="project" id={p.id} links={p.design}/>`; plus a "Design docs" list from `m.docs`; plus features that have `design` links.

Update existing routes (EDIT, keep the rest):
- `projects.$projectId.tsx` — add an "Architecture" section (`<Architecture project={p}/>`), `<DesignLinks scope="project" id={p.id} links={p.design}/>`, and a `<WireGraph features={p.features}/>`.
- `features.$featureId.tsx` — add `<CommentThread feature={f}/>`, `<DesignLinks scope="feature" id={f.id} links={f.design}/>`, and if `m.openDecisions.find(d=>d.featureId===f.id)` render `<DecidePanel decision={that}/>`.
- `decisions.tsx` — show OPEN decisions first with `<DecidePanel/>`; decided ones as before (DecisionCard).
- `index.tsx` (Board) — add a compact "Recent activity" section: `<ActivityFeed activity={m.activity} limit={8}/>`, and if `m.openDecisions.length` a "Decisions waiting on you" strip linking to the features.

New CSS classes may be needed (wire graph nodes/edges, comment thread, decide buttons) — add them to `src/styles.css` scoped + theme-aware (use the existing tokens: `--surface --border --accent --ok --blocked --text-dim` etc.). Reuse existing classes where possible.

---

## Batch 5 — adaptive views: Tasks · Ops(accounts) · Prod · Guide

Cairn is now MULTI-BOARD + ADAPTIVE. Each board (`data/boards.json`) has a `views: string[]` (which nav tabs it shows). The "mfs-rebuild" board enables tasks/ops/prod/guide (not features/map/design); "ibils" enables the standard set. New views read their own per-board data files: `data/boards/<id>/{tasks,accounts,prod,guide}.json`.

New spine (IMPORT, never modify):
- Types: `WorkTask` (first-class task, id like T-XXX — NOT the checklist `Task`), `TaskCheckpoint {id,label,category?,done}`, `Account`, `AccountVault`, `OpsData {vault,accounts,alert?}`, `ProdGate {id,title,meaning?,agent?,doneWhen?}`, `ProdData {mockLabel?,headline?,gates}`, `GuideData {sections:{title,body}[]}`.
- Task adapter: `import { buildTasks, type TaskView } from '#/lib/tasks'` — `TaskView = WorkTask + {done,total,pct}`.
- Query hooks (all board-scoped via the route boardId):
  - `useTasks(): { tasks: TaskView[]; byId }`
  - `useOps(): OpsData` · `useProd(): ProdData` · `useGuide(): GuideData`
  - `useToggleCheckpoint()` → `.mutate({ taskId, checkpointId })` (persists + cache update)
  - `useBoardViews(): string[]` (current board's enabled views)
- CSS ready in styles.css: `.task-grid .task-card .task-id .task-phase .checkpoint(.done) .cp-cat .vault .vault-tile .account-grid .account-card(.usable/.limit) .account-badge .alert-banner .gate .gate-id .gate-body .mock-banner .guide-sec` — USE them; do NOT edit styles.css.

Build (leaf files):
COMPONENTS (src/components/):
- `TaskCard.tsx` `{ task: TaskView }` — block `<Link to="/tasks/$taskId" params={{taskId:task.id}}>` (use BoardLink import): id (mono .task-id), title, .task-phase (task.phase), a ProgressBar (task.pct with `${done}/${total}` right label), .task-foot (project + `${deps} deps`).
- `CheckpointList.tsx` `{ task: TaskView }` — task.checkpoints as `.checkpoint(.done)` rows; clicking toggles via `useToggleCheckpoint().mutate({taskId:task.id, checkpointId:c.id})`; show `.cp-cat` (category). Header = done/total + ProgressBar.
- `AccountsGrid.tsx` `{ ops: OpsData }` — a `.vault` row of `.vault-tile` (accountCount, usableCount, limitCount, capacityNote/sessionsPerAccount as min/max). If `ops.accounts` has usable < alert.lowThreshold OR usableCount low, show an `.alert-banner`. Then `.account-grid` of `.account-card` (add `usable`/`limit` class from status/usable): `.account-label`, `.account-badge`, `.account-slots` (slotsInUse/slotsCapacity), `.account-reason`.
- `ProdGates.tsx` `{ prod: ProdData }` — `.mock-banner` (prod.mockLabel) if present, a headline note, then each gate as `.gate` (.gate-id = g.id, .gate-body: .gate-title, .gate-meaning, .gate-meta with agent + `done when: doneWhen`).
- `GuideView.tsx` `{ guide: GuideData; conventions?: Conventions }` — guide.sections as `.guide-sec` (h3 title + p body). Optionally also render conventions.usage as a "Playbook" section.

ROUTES (src/routes/) — file-based, all board-scoped:
- `b.$boardId.tasks.index.tsx` (`/b/$boardId/tasks`): `const {tasks}=useTasks()`. Filter chips (by projectId + by scope) + global search (uiStore). `.task-grid` of `<TaskCard>`. Section header "Tasks" + count. loader ensureQueryData(tasksQueryOptions(params.boardId)).
- `b.$boardId.tasks.$taskId.tsx` (`/b/$boardId/tasks/$taskId`): `const {byId}=useTasks(); const t=byId[Route.useParams().taskId]`. Detail: Back link; hero (title, .task-id, .task-phase, project, ProgressBar); objective + next (notes); story (userStory/currentGap/targetScope in a card if present); `<CheckpointList task={t}/>`; dependencies as BoardLinks to `/tasks/$taskId` (resolve title via byId); impacts as chips; refs (api/pages as chips, evidence). Not-found empty state.
- `b.$boardId.ops.tsx` (`/b/$boardId/ops`): `const ops=useOps()` (loader opsQueryOptions). `<AccountsGrid ops={ops}/>`. Header "Agent accounts".
- `b.$boardId.prod.tsx` (`/b/$boardId/prod`): `const prod=useProd()` (loader prodQueryOptions). `<ProdGates prod={prod}/>`. Header "Path to production".
- `b.$boardId.guide.tsx` (`/b/$boardId/guide`): `const guide=useGuide()` (loader guideQueryOptions). `<GuideView guide={guide}/>`. Header "Guide".

Reminder: routes render ONLY page body (AppShell wraps). Internal nav = BoardLink (board-relative `to`). Do NOT run generate-routes (integrate does). tsc strict, no any.
