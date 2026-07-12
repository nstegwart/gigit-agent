// Real MCP board tools (async, MySQL-backed via board-store). Every board tool is
// boardId-scoped (default = the first board). Registered on the McpServer in mcp.ts.
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

import { buildModel } from '#/lib/model'
import type { Feature } from '#/lib/types'
import { advanceTask, computeRollup, initLifecycleStage, readAudit, readLifecycle, writeLifecycle } from '#/server/lifecycle-store'
import { taskLifecycle } from '#/server/tasks-store'
import { decideDecision, deleteBoard, deleteProject, setQueue, updateBoard, upsertProject } from '#/server/board-store'
import {
  addComment,
  addComponent,
  addTaskSection,
  boardHash,
  createBoard,
  defaultBoardId,
  deleteFeature,
  deleteTask,
  removeTaskSection,
  setTaskSections,
  updateTaskSection,
  listBoards,
  openDecision,
  readBoard,
  readConventions,
  readGuide,
  readOps,
  readProd,
  readTask,
  readTasks,
  replaceAccounts,
  replaceBoardSnapshot,
  setBlocked,
  setFeaturePhase,
  setGuide,
  setProd,
  setProjectDesign,
  setRunStatus,
  toggleTask,
  upsertFeature,
  upsertTask,
  upsertRun,
} from '#/server/board-store'

function jsonText(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] }
}
const bid = async (boardId?: string) => boardId || (await defaultBoardId())
const modelOf = async (boardId?: string) => buildModel(await readBoard(await bid(boardId)))
const BOARD_ARG = { boardId: z.string().optional().describe('Board id (default = the first board)') }

function featureSummary(f: Feature) {
  return {
    id: f.id, nama: f.nama, fase: f.fase, phaseLabel: f.phaseLabel, blocked: f.blocked ?? null,
    isBlocked: f.isBlocked, projectId: f.projectId, taskDone: f.taskDone, taskTotal: f.taskTotal, pct: f.pct,
  }
}

export function registerBoardTools(server: McpServer): void {
  // ---- boards ----
  server.registerTool(
    'list_boards',
    { title: 'List boards', description: 'List all boards (each board is its own scope).', inputSchema: {} },
    async () => jsonText({ boards: await listBoards() }),
  )
  server.registerTool(
    'create_board',
    { title: 'Create board', description: 'Create a new empty board.', inputSchema: { id: z.string(), name: z.string(), description: z.string().optional() } },
    async ({ id, name, description }) => {
      try {
        return jsonText({ ok: true, boards: await createBoard(id, name, description) })
      } catch (e) {
        return jsonText({ ok: false, error: e instanceof Error ? e.message : String(e) })
      }
    },
  )

  // ---- reads ----
  server.registerTool(
    'list_projects',
    { title: 'List projects', description: "List a board's projects with status, stage, progress.", inputSchema: { ...BOARD_ARG } },
    async ({ boardId }) => {
      const m = await modelOf(boardId)
      return jsonText({ projects: m.projects.map((p) => ({ id: p.id, nama: p.nama, status: p.status, stage: p.stage ?? null, progress: p.progress, featureCount: p.features.length, activeAgents: p.activeAgents })) })
    },
  )
  server.registerTool(
    'list_features',
    { title: 'List features', description: 'List features, optionally filtered by projectId and/or fase.', inputSchema: { ...BOARD_ARG, projectId: z.string().optional(), status: z.string().optional() } },
    async ({ boardId, projectId, status }) => {
      let features = (await modelOf(boardId)).features
      if (projectId) features = features.filter((f) => f.projectId === projectId)
      if (status) features = features.filter((f) => String(f.fase) === status)
      return jsonText({ features: features.map(featureSummary) })
    },
  )
  server.registerTool(
    'get_feature',
    { title: 'Get feature', description: 'A single feature incl checklist, runs, comments, design.', inputSchema: { ...BOARD_ARG, id: z.string() } },
    async ({ boardId, id }) => {
      const f = (await modelOf(boardId)).featById[id]
      if (!f) return jsonText({ error: `feature not found: ${id}` })
      return jsonText({ feature: { ...featureSummary(f), kelompok: f.kelompok ?? null, track: f.track ?? null, tier: f.tier ?? null, impact: f.impact ?? [], catatan: f.catatan ?? null, deps: f.deps ?? [], links: f.links ?? [], branch: f.branch ?? null, bucket: f.bucket ?? null, parked: f.parked, updated: f.updated ?? null, checklist: f.checklist ?? [], runs: f.runs, comments: f.comments, design: f.design } })
    },
  )
  server.registerTool(
    'list_runs',
    { title: 'List agent runs', description: 'List agent runs, optionally filtered by status.', inputSchema: { ...BOARD_ARG, status: z.string().optional() } },
    async ({ boardId, status }) => {
      const runs = (await modelOf(boardId)).runs
      return jsonText({ runs: status ? runs.filter((r) => r.status === status) : runs })
    },
  )
  server.registerTool(
    'list_queue',
    { title: 'List queue', description: 'The work queue: now / next features + catatan.', inputSchema: { ...BOARD_ARG } },
    async ({ boardId }) => {
      const m = await modelOf(boardId)
      return jsonText({ now: m.queue.now.map((f) => ({ id: f.id, nama: f.nama })), next: m.queue.next.map((f) => ({ id: f.id, nama: f.nama })), catatan: m.queue.catatan ?? null })
    },
  )

  // ---- writes ----
  server.registerTool(
    'toggle_task',
    { title: 'Toggle checklist task', description: 'Toggle (or set) a feature checklist task done flag.', inputSchema: { ...BOARD_ARG, featureId: z.string(), index: z.number().int(), done: z.boolean().optional() } },
    async ({ boardId, featureId, index, done }) => {
      const f = buildModel(await toggleTask(await bid(boardId), featureId, index, done)).featById[featureId]
      if (!f) return jsonText({ error: `feature not found: ${featureId}` })
      return jsonText({ feature: { ...featureSummary(f), checklist: f.checklist ?? [] } })
    },
  )
  server.registerTool(
    'set_feature_phase',
    { title: 'Set feature phase', description: "Set a feature's fase (phase).", inputSchema: { ...BOARD_ARG, featureId: z.string(), fase: z.string() } },
    async ({ boardId, featureId, fase }) => {
      const f = buildModel(await setFeaturePhase(await bid(boardId), featureId, fase)).featById[featureId]
      if (!f) return jsonText({ error: `feature not found: ${featureId}` })
      return jsonText({ feature: featureSummary(f) })
    },
  )
  server.registerTool(
    'upsert_run',
    { title: 'Register or update an agent run', description: 'The write path an agent uses to report itself.', inputSchema: { ...BOARD_ARG, id: z.string(), agent: z.string().optional(), agentType: z.string().optional(), model: z.string().optional(), effort: z.string().optional(), task: z.string().optional(), feature: z.string().optional(), taskId: z.string().optional(), project: z.string().optional(), status: z.enum(['running', 'blocked', 'queued', 'done', 'failed']).optional() } },
    async ({ boardId, ...rest }) => {
      const patch: Parameters<typeof upsertRun>[1] = { id: rest.id }
      for (const k of ['agent', 'agentType', 'model', 'effort', 'task', 'feature', 'taskId', 'project', 'status'] as const) {
        if (rest[k] !== undefined) (patch as Record<string, unknown>)[k] = rest[k]
      }
      const raw = await upsertRun(await bid(boardId), patch)
      return jsonText({ run: raw.runs?.find((r) => r.id === rest.id) ?? null })
    },
  )
  server.registerTool(
    'set_run_status',
    { title: 'Set run status', description: "Update an agent run's status.", inputSchema: { ...BOARD_ARG, id: z.string(), status: z.enum(['running', 'blocked', 'queued', 'done', 'failed']) } },
    async ({ boardId, id, status }) => {
      const raw = await setRunStatus(await bid(boardId), id, status)
      return jsonText({ run: raw.runs?.find((r) => r.id === id) ?? null })
    },
  )

  // ---- agent knowledge ----
  server.registerTool(
    'get_conventions',
    { title: 'Get conventions', description: 'The Cairn playbook. Read after connecting.', inputSchema: {} },
    async () => jsonText(await readConventions()),
  )
  server.registerTool(
    'get_workspace',
    { title: 'Get feature workspace', description: 'Canonical branch + git worktree path + repo for a feature.', inputSchema: { ...BOARD_ARG, featureId: z.string() } },
    async ({ boardId, featureId }) => {
      const f = (await modelOf(boardId)).featById[featureId]
      if (!f) return jsonText({ error: `feature not found: ${featureId}` })
      const conv = await readConventions()
      const repo = (f.projectId && conv.repos?.[f.projectId]) || '<repo>'
      const slug = f.branch ? f.branch.replace(/^(feature|fix|chore)\//, '') : featureId
      return jsonText({ featureId, project: f.projectId, repo, branch: f.branch ?? `feature/${slug}`, worktree: `worktrees/${repo}--${slug}`, steps: conv.usage ?? [] })
    },
  )
  server.registerTool(
    'get_design',
    { title: 'Get system design', description: 'Architecture / design links for a project or feature.', inputSchema: { ...BOARD_ARG, projectId: z.string().optional(), featureId: z.string().optional() } },
    async ({ boardId, projectId, featureId }) => {
      const m = await modelOf(boardId)
      if (featureId) {
        const f = m.featById[featureId]
        if (!f) return jsonText({ error: `feature not found: ${featureId}` })
        return jsonText({ feature: featureId, design: f.design, links: f.links ?? [] })
      }
      const p = projectId ? m.projById[projectId] : null
      if (!p) return jsonText({ error: 'pass projectId or featureId' })
      const docs = p.docs as Record<string, unknown> | undefined
      return jsonText({ project: p.id, komponen: p.komponen ?? [], arsitektur: docs?.arsitektur ?? null, baseline: docs?.baseline ?? null, pages: docs?.pages ?? null, design: p.design, design_foundation: p.design_foundation ?? null, design_components: p.design_components ?? null, design_pages: p.design_pages ?? null })
    },
  )
  server.registerTool(
    'set_project_design',
    {
      title: 'Upload system design',
      description:
        "Upload/replace a project's system design: component catalog (komponen), architecture note (arsitektur), baseline bullets, design-system links (foundation/components/pages URLs), and the all-pages catalog (pages). Only the fields you pass are changed.",
      inputSchema: {
        ...BOARD_ARG,
        projectId: z.string(),
        arsitektur: z.string().optional().describe('Architecture / system-design prose'),
        baseline: z.array(z.string()).optional().describe('Baseline / foundation bullets'),
        komponen: z
          .array(z.object({ nama: z.string(), jenis: z.string().optional(), stack: z.string().optional(), status: z.string().optional(), ket: z.string().optional() }).passthrough())
          .optional()
          .describe('Full component catalog (replaces existing)'),
        foundationUrl: z.string().optional().describe('Design-system foundation page URL'),
        componentsUrl: z.string().optional().describe('Design-system components page URL'),
        pagesUrl: z.string().optional().describe('Design-system pages/screens page URL'),
        pages: z
          .array(z.object({ nama: z.string(), route: z.string().optional(), status: z.string().optional(), ket: z.string().optional() }).passthrough())
          .optional()
          .describe('All-pages catalog (replaces existing)'),
      },
    },
    async ({ boardId, projectId, ...patch }) => {
      try {
        const raw = await setProjectDesign(await bid(boardId), projectId, patch)
        const p = raw.projects.find((x) => x.id === projectId)
        const docs = p?.docs as Record<string, unknown> | undefined
        return jsonText({ ok: true, project: projectId, komponen: p?.komponen ?? [], arsitektur: docs?.arsitektur ?? null, baseline: docs?.baseline ?? null, pages: docs?.pages ?? null, design_foundation: p?.design_foundation ?? null, design_components: p?.design_components ?? null, design_pages: p?.design_pages ?? null })
      } catch (e) {
        return jsonText({ error: (e as Error).message })
      }
    },
  )
  server.registerTool(
    'add_component',
    {
      title: 'Add a component',
      description: "Append one entry to a project's component catalog (komponen).",
      inputSchema: {
        ...BOARD_ARG,
        projectId: z.string(),
        nama: z.string(),
        jenis: z.string().optional(),
        stack: z.string().optional(),
        status: z.string().optional(),
        ket: z.string().optional(),
      },
    },
    async ({ boardId, projectId, ...komponen }) => {
      try {
        const raw = await addComponent(await bid(boardId), projectId, komponen)
        const p = raw.projects.find((x) => x.id === projectId)
        return jsonText({ ok: true, project: projectId, komponen: p?.komponen ?? [] })
      } catch (e) {
        return jsonText({ error: (e as Error).message })
      }
    },
  )

  // ---- write suite: upsert/delete task & feature, set prod/guide/accounts, bulk snapshot ----
  const TASK_OBJ = z.object({ id: z.string(), title: z.string() }).passthrough()
  const FEATURE_OBJ = z.object({ id: z.string(), nama: z.string(), fase: z.string() }).passthrough()
  const GATE_OBJ = z.object({ id: z.string(), title: z.string() }).passthrough()
  const GUIDE_SEC = z.object({ title: z.string(), body: z.string() })
  const ACCOUNT_OBJ = z.object({ id: z.string(), label: z.string(), status: z.string(), usable: z.boolean() }).passthrough()
  const OPS_OBJ = z.object({ vault: z.record(z.string(), z.any()).optional(), accounts: z.array(ACCOUNT_OBJ), alert: z.record(z.string(), z.any()).optional() }).passthrough()
  const asErr = (e: unknown) => jsonText({ error: (e as Error).message })

  server.registerTool(
    'upsert_task',
    { title: 'Upsert a task', description: 'Create or update one first-class task (T-… id) with its full mapping. Merges into an existing task of the same id. Lifecycle state is preserved (use advance_task to move stage). Pass expectedRev (from get_task) for optimistic-lock safety against concurrent writers.', inputSchema: { ...BOARD_ARG, task: TASK_OBJ, expectedRev: z.number().int().optional() } },
    async ({ boardId, task, expectedRev }) => {
      try { return jsonText(await upsertTask(await bid(boardId), task as never, expectedRev)) } catch (e) { return asErr(e) }
    },
  )
  server.registerTool(
    'delete_task',
    { title: 'Delete a task', description: 'Remove a first-class task by id.', inputSchema: { ...BOARD_ARG, id: z.string() } },
    async ({ boardId, id }) => {
      try { return jsonText(await deleteTask(await bid(boardId), id)) } catch (e) { return asErr(e) }
    },
  )

  // ---- agent-defined task sections (add ANY content block/"menu" inside a task) ----
  const SECTION_OBJ = z.object({
    id: z.string().optional(),
    type: z.string().describe('text | callout | fields | list | checklist | table | chips | anchors | variants | links | badges (or any custom type — falls back to raw JSON)'),
    title: z.string().optional(),
    collapsed: z.boolean().optional(),
    tone: z.string().optional(),
    body: z.string().optional(),
    fields: z.array(z.object({ k: z.string(), v: z.string() })).optional(),
    items: z.array(z.string()).optional(),
    checklist: z.array(z.object({ id: z.string().optional(), label: z.string(), done: z.boolean().optional() })).optional(),
    columns: z.array(z.string()).optional(),
    rows: z.array(z.array(z.string())).optional(),
    chips: z.array(z.string()).optional(),
    anchors: z.array(z.object({ repo: z.string().optional(), file: z.string().optional(), line: z.union([z.string(), z.number()]).optional(), symbol: z.string().optional(), fact: z.string().optional() })).optional(),
    variants: z.array(z.object({ id: z.string().optional(), when: z.string().optional(), expect: z.string().optional() })).optional(),
    links: z.array(z.object({ label: z.string().optional(), url: z.string() })).optional(),
  }).passthrough()
  server.registerTool(
    'add_task_section',
    { title: 'Add a task section', description: 'Append one agent-defined content block ("menu") inside a task — any type/content. id auto-generated if omitted. Renders on the task detail immediately.', inputSchema: { ...BOARD_ARG, taskId: z.string(), section: SECTION_OBJ } },
    async ({ boardId, taskId, section }) => {
      try { return jsonText({ ok: true, sections: await addTaskSection(await bid(boardId), taskId, section as never) }) } catch (e) { return asErr(e) }
    },
  )
  server.registerTool(
    'set_task_sections',
    { title: 'Set task sections', description: 'Replace ALL of a task\'s content blocks with this ordered list. Fully defines the task body.', inputSchema: { ...BOARD_ARG, taskId: z.string(), sections: z.array(SECTION_OBJ) } },
    async ({ boardId, taskId, sections }) => {
      try { return jsonText({ ok: true, sections: await setTaskSections(await bid(boardId), taskId, sections as never) }) } catch (e) { return asErr(e) }
    },
  )
  server.registerTool(
    'update_task_section',
    { title: 'Update a task section', description: 'Patch one section by id (title/content/collapsed/tone/…).', inputSchema: { ...BOARD_ARG, taskId: z.string(), sectionId: z.string(), patch: SECTION_OBJ.partial() } },
    async ({ boardId, taskId, sectionId, patch }) => {
      try { return jsonText({ ok: true, sections: await updateTaskSection(await bid(boardId), taskId, sectionId, patch as never) }) } catch (e) { return asErr(e) }
    },
  )
  server.registerTool(
    'remove_task_section',
    { title: 'Remove a task section', description: 'Delete one section by id.', inputSchema: { ...BOARD_ARG, taskId: z.string(), sectionId: z.string() } },
    async ({ boardId, taskId, sectionId }) => {
      try { return jsonText({ ok: true, sections: await removeTaskSection(await bid(boardId), taskId, sectionId) }) } catch (e) { return asErr(e) }
    },
  )

  server.registerTool(
    'upsert_feature',
    { title: 'Upsert a feature', description: 'Create or update one feature/feature-contract (checklist card). Merges into an existing feature of the same id.', inputSchema: { ...BOARD_ARG, feature: FEATURE_OBJ } },
    async ({ boardId, feature }) => {
      try { return jsonText(await upsertFeature(await bid(boardId), feature as never)) } catch (e) { return asErr(e) }
    },
  )
  server.registerTool(
    'delete_feature',
    { title: 'Delete a feature', description: 'Remove a feature by id.', inputSchema: { ...BOARD_ARG, id: z.string() } },
    async ({ boardId, id }) => {
      try { return jsonText(await deleteFeature(await bid(boardId), id)) } catch (e) { return asErr(e) }
    },
  )
  server.registerTool(
    'set_prod',
    { title: 'Set production gates', description: 'Replace the board’s path-to-production gates (G0→G6) plus optional label/headline.', inputSchema: { ...BOARD_ARG, gates: z.array(GATE_OBJ), mockLabel: z.string().optional(), headline: z.string().optional() } },
    async ({ boardId, gates, mockLabel, headline }) => {
      try { return jsonText(await setProd(await bid(boardId), { gates: gates as never, mockLabel, headline })) } catch (e) { return asErr(e) }
    },
  )
  server.registerTool(
    'set_guide',
    { title: 'Set board guide', description: 'Replace the board-specific guide sections.', inputSchema: { ...BOARD_ARG, sections: z.array(GUIDE_SEC) } },
    async ({ boardId, sections }) => {
      try { return jsonText(await setGuide(await bid(boardId), { sections })) } catch (e) { return asErr(e) }
    },
  )
  server.registerTool(
    'replace_accounts',
    { title: 'Replace agent-account vault', description: 'Replace the ops agent-account vault (accounts + vault summary + alert).', inputSchema: { ...BOARD_ARG, ops: OPS_OBJ } },
    async ({ boardId, ops }) => {
      try { return jsonText(await replaceAccounts(await bid(boardId), ops as never)) } catch (e) { return asErr(e) }
    },
  )
  server.registerTool(
    'get_board_hash',
    { title: 'Get board hash', description: 'Content hash of the 7 board collections — read it first, then pass as expectedHash to replace_board_snapshot for safe concurrent writes.', inputSchema: { ...BOARD_ARG } },
    async ({ boardId }) => {
      try { const id = await bid(boardId); return jsonText({ boardId: id, hash: await boardHash(id) }) } catch (e) { return asErr(e) }
    },
  )
  server.registerTool(
    'replace_board_snapshot',
    {
      title: 'Replace board snapshot (bulk)',
      description:
        'Atomically replace whole collections in one transaction. Pass only the collections you want to sync — each provided array upserts new records and drops stale ones. Set dryRun:true to preview the before/after counts without writing. Pass expectedHash (from get_board_hash) to refuse the write if the board changed since you read it. Returns an audit receipt with before/after counts and the new hash.',
      inputSchema: {
        ...BOARD_ARG,
        projects: z.array(z.object({ id: z.string(), nama: z.string(), status: z.string() }).passthrough()).optional(),
        features: z.array(FEATURE_OBJ).optional(),
        tasks: z.array(TASK_OBJ).optional(),
        productionGates: z.array(GATE_OBJ).optional(),
        prodMockLabel: z.string().optional(),
        prodHeadline: z.string().optional(),
        guide: z.array(GUIDE_SEC).optional(),
        accounts: OPS_OBJ.optional(),
        runs: z.array(z.object({ id: z.string() }).passthrough()).optional(),
        dryRun: z.boolean().optional().describe('Preview counts, do not write'),
        expectedHash: z.string().optional().describe('From get_board_hash — write refused on mismatch'),
      },
    },
    async ({ boardId, dryRun, expectedHash, ...snap }) => {
      try {
        return jsonText(await replaceBoardSnapshot(await bid(boardId), snap as never, { dryRun, expectedHash }))
      } catch (e) {
        return asErr(e)
      }
    },
  )

  // ---- lifecycle engine (per-board configurable rail + evidence-gated transitions) ----
  const STAGE_OBJ = z.object({
    key: z.string(), label: z.string(), color: z.string().optional(), group: z.string().optional(),
    gated: z.boolean().optional(), requiresEvidence: z.array(z.string()).optional(), verifierRole: z.string().optional(),
    readiness: z.number().optional().describe('0–100 ready-to-production % this stage represents (drives rollups)'),
    milestone: z.boolean().optional().describe('mark the "ready-production" gate rollups count toward'),
  })
  server.registerTool(
    'get_lifecycle',
    { title: 'Get lifecycle rail', description: "This board's lifecycle stages + gate rules. Each board defines its own rail; read this before advance_task.", inputSchema: { ...BOARD_ARG } },
    async ({ boardId }) => { try { return jsonText(await readLifecycle(await bid(boardId))) } catch (e) { return asErr(e) } },
  )
  server.registerTool(
    'set_lifecycle',
    { title: 'Set lifecycle rail', description: "Fully (re)configure this board's lifecycle: ordered stages + gate rules. gated:true = reachable only via advance_task with a program-emitted receipt; verifierRole = must be passed by a run other than the implementer. allowSkip (default false) permits forward jumps; allowRegression (default true) permits moving back for repair. Each board owns its own rail.", inputSchema: { ...BOARD_ARG, stages: z.array(STAGE_OBJ).min(1), allowSkip: z.boolean().optional(), allowRegression: z.boolean().optional() } },
    async ({ boardId, stages, allowSkip, allowRegression }) => { try { return jsonText(await writeLifecycle(await bid(boardId), stages as never, { allowSkip, allowRegression })) } catch (e) { return asErr(e) } },
  )
  server.registerTool(
    'get_task_lifecycle',
    { title: 'Get task lifecycle', description: 'Current stage, rev (for optimistic lock), implementer run, and stage history for one task.', inputSchema: { ...BOARD_ARG, id: z.string() } },
    async ({ boardId, id }) => {
      try { const lc = await taskLifecycle(await bid(boardId), id); return jsonText(lc ?? { error: `task not found: ${id}` }) } catch (e) { return asErr(e) }
    },
  )
  server.registerTool(
    'advance_task',
    {
      title: 'Advance task lifecycle',
      description:
        "Move a task to a stage on this board's rail. Gated stages REQUIRE a program-emitted receipt (evidence/commitSha/deployReceipt) — no manual ticking of FUNCTIONAL/PROD_READY/LIVE. A stage with a verifierRole is refused if byRunId equals the implementer (independent verification). Pass expectedRev (from get_task_lifecycle) to prevent a concurrent lost update. Every transition is written to the audit log.",
      inputSchema: {
        ...BOARD_ARG,
        id: z.string(),
        toStage: z.string(),
        byRunId: z.string().describe('run/agent id performing the transition (required)'),
        role: z.string().optional(),
        evidence: z.record(z.string(), z.any()).optional(),
        verdict: z.string().optional(),
        commitSha: z.string().optional(),
        deployReceipt: z.string().optional(),
        blocker: z.string().optional(),
        expectedRev: z.number().int().optional(),
      },
    },
    async ({ boardId, id, ...inp }) => {
      try { return jsonText(await advanceTask(await bid(boardId), id, inp as never)) } catch (e) { return asErr(e) }
    },
  )
  server.registerTool(
    'get_rollup',
    { title: 'Get lifecycle rollup', description: 'Active task count per lifecycle stage, HOLD count (outside the active denominator), and per-project / per-feature rollup (each follows its most-behind active task).', inputSchema: { ...BOARD_ARG } },
    async ({ boardId }) => { try { return jsonText(await computeRollup(await bid(boardId))) } catch (e) { return asErr(e) } },
  )
  server.registerTool(
    'list_audit',
    { title: 'List audit log', description: 'Recent audit entries (gate changes + mutations), newest first. Filter by taskId.', inputSchema: { ...BOARD_ARG, taskId: z.string().optional(), limit: z.number().int().optional() } },
    async ({ boardId, taskId, limit }) => { try { return jsonText({ audit: await readAudit(await bid(boardId), { taskId, limit }) }) } catch (e) { return asErr(e) } },
  )
  server.registerTool(
    'init_lifecycle',
    { title: 'Bulk-init task stages', description: "Set the lifecycle stage for a board's tasks in one atomic UPDATE (default = onlyUninitialized). stage defaults to the rail's first stage.", inputSchema: { ...BOARD_ARG, stage: z.string().optional(), onlyUninitialized: z.boolean().optional() } },
    async ({ boardId, stage, onlyUninitialized }) => { try { return jsonText(await initLifecycleStage(await bid(boardId), stage, onlyUninitialized ?? true)) } catch (e) { return asErr(e) } },
  )

  // ---- board / project / queue CRUD (full board management from MCP) ----
  server.registerTool(
    'update_board',
    { title: 'Update a board', description: "Rename a board, change its description, or set which views/tabs it shows.", inputSchema: { boardId: z.string(), name: z.string().optional(), description: z.string().optional(), views: z.array(z.string()).optional() } },
    async ({ boardId, ...patch }) => { try { return jsonText({ ok: true, boards: await updateBoard(boardId, patch) }) } catch (e) { return asErr(e) } },
  )
  server.registerTool(
    'delete_board',
    { title: 'Delete a board', description: 'Delete a board and ALL its data (docs, tasks, audit). Irreversible.', inputSchema: { boardId: z.string() } },
    async ({ boardId }) => { try { return jsonText({ ok: true, boards: await deleteBoard(boardId) }) } catch (e) { return asErr(e) } },
  )
  server.registerTool(
    'upsert_project',
    { title: 'Upsert a project', description: 'Create or update one project (merges by id). Any extra fields pass through.', inputSchema: { ...BOARD_ARG, project: z.object({ id: z.string(), nama: z.string(), status: z.string().optional() }).passthrough() } },
    async ({ boardId, project }) => {
      try {
        const raw = await upsertProject(await bid(boardId), project as never)
        const p = raw.projects.find((x) => x.id === (project as { id: string }).id)
        return jsonText({ ok: true, project: p ?? null, projects: raw.projects.map((x) => x.id) }) // full project incl. passthrough fields
      } catch (e) { return asErr(e) }
    },
  )
  server.registerTool(
    'delete_project',
    { title: 'Delete a project', description: 'Remove a project by id (its tasks stay; re-point or delete them separately).', inputSchema: { ...BOARD_ARG, id: z.string() } },
    async ({ boardId, id }) => { try { const raw = await deleteProject(await bid(boardId), id); return jsonText({ ok: true, projects: raw.projects.map((p) => p.id) }) } catch (e) { return asErr(e) } },
  )
  server.registerTool(
    'set_queue',
    { title: 'Set the work queue', description: 'Set the board queue (now / next feature ids + note).', inputSchema: { ...BOARD_ARG, now: z.array(z.string()).optional(), next: z.array(z.string()).optional(), catatan: z.string().optional() } },
    async ({ boardId, ...q }) => { try { const raw = await setQueue(await bid(boardId), q); return jsonText({ ok: true, queue: raw.queue ?? null }) } catch (e) { return asErr(e) } },
  )
  server.registerTool(
    'decide_decision',
    { title: 'Decide an open decision', description: 'Answer/close an open decision (unblocks the feature it gated).', inputSchema: { ...BOARD_ARG, id: z.string(), answer: z.string(), keputusan: z.string().optional(), decidedBy: z.string().optional() } },
    async ({ boardId, id, answer, keputusan, decidedBy }) => {
      try { const raw = await decideDecision(await bid(boardId), id, answer, keputusan, decidedBy ?? 'human'); return jsonText({ ok: true, decision: raw.decisions?.find((d) => d.id === id) ?? null }) } catch (e) { return asErr(e) }
    },
  )

  // ---- collaboration ----
  server.registerTool(
    'add_comment',
    { title: 'Add a comment', description: 'Leave a comment on a feature.', inputSchema: { ...BOARD_ARG, featureId: z.string(), author: z.string(), text: z.string().min(1), authorType: z.enum(['human', 'agent']).optional() } },
    async ({ boardId, featureId, author, text, authorType }) => {
      await addComment(await bid(boardId), featureId, author, authorType ?? 'agent', text)
      return jsonText({ ok: true, featureId })
    },
  )
  server.registerTool(
    'open_decision',
    { title: 'Open a decision', description: 'Raise a decision that needs a human (blocks the feature).', inputSchema: { ...BOARD_ARG, featureId: z.string(), question: z.string().min(1), options: z.array(z.object({ key: z.string(), label: z.string(), rekomendasi: z.boolean().optional() })).optional(), openedBy: z.string().optional() } },
    async ({ boardId, featureId, question, options, openedBy }) => {
      const raw = await openDecision(await bid(boardId), featureId, question, options, openedBy ?? 'agent')
      const d = raw.decisions?.find((x) => x.featureId === featureId && x.status === 'open')
      return jsonText({ ok: true, decision: d ?? null })
    },
  )
  server.registerTool(
    'set_blocked',
    { title: 'Set feature blocked', description: 'Mark a feature blocked with a reason.', inputSchema: { ...BOARD_ARG, featureId: z.string(), reason: z.string().min(1) } },
    async ({ boardId, featureId, reason }) => {
      await setBlocked(await bid(boardId), featureId, reason)
      return jsonText({ ok: true, featureId, reason })
    },
  )
  server.registerTool(
    'list_activity',
    { title: 'List activity', description: 'The board activity feed, newest first.', inputSchema: { ...BOARD_ARG, limit: z.number().int().optional() } },
    async ({ boardId, limit }) => jsonText({ activity: (await modelOf(boardId)).activity.slice(0, limit ?? 30) }),
  )

  // ---- adaptive views ----
  server.registerTool(
    'list_tasks',
    { title: 'List tasks', description: "List a board's first-class tasks (T-… ids).", inputSchema: { ...BOARD_ARG, projectId: z.string().optional(), scope: z.string().optional() } },
    async ({ boardId, projectId, scope }) => {
      let tasks = (await readTasks(await bid(boardId))).tasks
      if (projectId) tasks = tasks.filter((t) => t.projectId === projectId)
      if (scope) tasks = tasks.filter((t) => t.scope === scope)
      return jsonText({ tasks: tasks.map((t) => ({ id: t.id, title: t.title, projectId: t.projectId ?? null, phase: t.phase ?? null, scope: t.scope ?? null, done: t.checkpoints.filter((c) => c.done).length, total: t.checkpoints.length, deps: t.dependencies.length })) })
    },
  )
  server.registerTool(
    'get_task',
    { title: 'Get task', description: 'A single task incl checkpoints, deps, story, refs.', inputSchema: { ...BOARD_ARG, id: z.string() } },
    async ({ boardId, id }) => {
      const t = await readTask(await bid(boardId), id)
      return jsonText(t ? { task: t } : { error: `task not found: ${id}` })
    },
  )
  server.registerTool(
    'list_accounts',
    { title: 'List agent accounts', description: 'The agent-account vault + accounts. Check before spawning workers.', inputSchema: { ...BOARD_ARG } },
    async ({ boardId }) => {
      const o = await readOps(await bid(boardId))
      return jsonText({ vault: o.vault, accounts: o.accounts, alert: o.alert ?? null })
    },
  )
  server.registerTool(
    'get_prod',
    { title: 'Get production path', description: 'The path-to-production gates (G0→G6).', inputSchema: { ...BOARD_ARG } },
    async ({ boardId }) => jsonText(await readProd(await bid(boardId))),
  )
  server.registerTool(
    'get_guide',
    { title: 'Get board guide', description: 'The board-specific guide + rules sections.', inputSchema: { ...BOARD_ARG } },
    async ({ boardId }) => jsonText(await readGuide(await bid(boardId))),
  )

  // ---- resource: the playbook ----
  server.registerResource(
    'playbook',
    'cairn://playbook',
    { title: 'Cairn playbook', description: 'How to use Cairn + workspace conventions (branch/worktree/usage).', mimeType: 'text/markdown' },
    async (uri) => {
      const c = await readConventions()
      const md = [
        `# ${c.brand ?? 'Cairn'} — agent playbook`, '',
        '## Branch naming', ...Object.entries(c.branch ?? {}).map(([k, v]) => `- ${k}: \`${v}\``), '',
        '## Worktree', `- \`${c.worktree?.path ?? ''}\` — ${c.worktree?.note ?? ''}`, '',
        '## How to use Cairn', ...(c.usage ?? []).map((s, i) => `${i + 1}. ${s}`), '',
        `## Deploy\n${c.deploy ?? ''}`, `\n## Status grades\n${(c.status_grades ?? []).join(' · ')}`,
      ].join('\n')
      return { contents: [{ uri: uri.href, mimeType: 'text/markdown', text: md }] }
    },
  )
}
