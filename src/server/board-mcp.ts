// Real MCP board tools. Registers read + write tools on the McpServer so an AI
// client (Claude/Cursor) can drive Cairn. Every board tool is boardId-scoped
// (default = the first board). Reads/writes go through board-store (disk SSOT).
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

import { buildModel } from '#/lib/model'
import type { Feature } from '#/lib/types'
import {
  addComment,
  createBoard,
  defaultBoardId,
  listBoards,
  openDecision,
  readBoard,
  readConventions,
  readGuide,
  readOps,
  readProd,
  readTasks,
  setBlocked,
  setFeaturePhase,
  setRunStatus,
  toggleTask,
  upsertRun,
} from '#/server/board-store'

function jsonText(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] }
}
/** Resolve the board id (fall back to the default board). */
const bid = (boardId?: string) => boardId || defaultBoardId()
const modelOf = (boardId?: string) => buildModel(readBoard(bid(boardId)))
const BOARD_ARG = { boardId: z.string().optional().describe('Board id (default = the first board)') }

function featureSummary(f: Feature) {
  return {
    id: f.id, nama: f.nama, fase: f.fase, phaseLabel: f.phaseLabel,
    blocked: f.blocked ?? null, isBlocked: f.isBlocked, projectId: f.projectId,
    taskDone: f.taskDone, taskTotal: f.taskTotal, pct: f.pct,
  }
}

export function registerBoardTools(server: McpServer): void {
  // ---- boards ----
  server.registerTool(
    'list_boards',
    { title: 'List boards', description: 'List all boards (each board is its own scope).', inputSchema: {} },
    () => jsonText({ boards: listBoards() }),
  )

  server.registerTool(
    'create_board',
    {
      title: 'Create board',
      description: 'Create a new empty board (its own projects/features/agents).',
      inputSchema: {
        id: z.string().describe('kebab-case board id'),
        name: z.string().describe('Display name'),
        description: z.string().optional(),
      },
    },
    ({ id, name, description }) => {
      try {
        return jsonText({ ok: true, boards: createBoard(id, name, description) })
      } catch (e) {
        return jsonText({ ok: false, error: e instanceof Error ? e.message : String(e) })
      }
    },
  )

  // ---- reads ----
  server.registerTool(
    'list_projects',
    { title: 'List projects', description: 'List a board\'s projects with status, stage, progress.', inputSchema: { ...BOARD_ARG } },
    ({ boardId }) =>
      jsonText({
        projects: modelOf(boardId).projects.map((p) => ({
          id: p.id, nama: p.nama, status: p.status, stage: p.stage ?? null,
          progress: p.progress, featureCount: p.features.length, activeAgents: p.activeAgents,
        })),
      }),
  )

  server.registerTool(
    'list_features',
    {
      title: 'List features',
      description: 'List features, optionally filtered by projectId and/or fase (status).',
      inputSchema: {
        ...BOARD_ARG,
        projectId: z.string().optional().describe('Filter to a single project id'),
        status: z.string().optional().describe('Filter by fase (e.g. build, qa, done)'),
      },
    },
    ({ boardId, projectId, status }) => {
      let features = modelOf(boardId).features
      if (projectId) features = features.filter((f) => f.projectId === projectId)
      if (status) features = features.filter((f) => String(f.fase) === status)
      return jsonText({ features: features.map(featureSummary) })
    },
  )

  server.registerTool(
    'get_feature',
    {
      title: 'Get feature',
      description: 'Get a single feature by id, including its checklist, runs, comments, design.',
      inputSchema: { ...BOARD_ARG, id: z.string().describe('The feature id') },
    },
    ({ boardId, id }) => {
      const f = modelOf(boardId).featById[id]
      if (!f) return jsonText({ error: `feature not found: ${id}` })
      return jsonText({
        feature: {
          ...featureSummary(f), kelompok: f.kelompok ?? null, track: f.track ?? null,
          tier: f.tier ?? null, impact: f.impact ?? [], catatan: f.catatan ?? null,
          deps: f.deps ?? [], links: f.links ?? [], branch: f.branch ?? null,
          bucket: f.bucket ?? null, parked: f.parked, updated: f.updated ?? null,
          checklist: f.checklist ?? [], runs: f.runs, comments: f.comments, design: f.design,
        },
      })
    },
  )

  server.registerTool(
    'list_runs',
    {
      title: 'List agent runs',
      description: 'List agent runs, optionally filtered by status.',
      inputSchema: { ...BOARD_ARG, status: z.string().optional().describe('running|blocked|queued|done|failed') },
    },
    ({ boardId, status }) => {
      const runs = modelOf(boardId).runs
      return jsonText({ runs: status ? runs.filter((r) => r.status === status) : runs })
    },
  )

  server.registerTool(
    'list_queue',
    {
      title: 'List queue',
      description: 'The work queue: now (active) and next (upcoming) features, plus catatan.',
      inputSchema: { ...BOARD_ARG },
    },
    ({ boardId }) => {
      const m = modelOf(boardId)
      return jsonText({
        now: m.queue.now.map((f) => ({ id: f.id, nama: f.nama })),
        next: m.queue.next.map((f) => ({ id: f.id, nama: f.nama })),
        catatan: m.queue.catatan ?? null,
      })
    },
  )

  // ---- writes ----
  server.registerTool(
    'toggle_task',
    {
      title: 'Toggle checklist task',
      description: 'Toggle (or set) a feature checklist task done flag.',
      inputSchema: {
        ...BOARD_ARG,
        featureId: z.string(),
        index: z.number().int().describe('The checklist task index (0-based)'),
        done: z.boolean().optional().describe('Explicit done value; omit to toggle'),
      },
    },
    ({ boardId, featureId, index, done }) => {
      const f = buildModel(toggleTask(bid(boardId), featureId, index, done)).featById[featureId]
      if (!f) return jsonText({ error: `feature not found: ${featureId}` })
      return jsonText({ feature: { ...featureSummary(f), checklist: f.checklist ?? [] } })
    },
  )

  server.registerTool(
    'set_feature_phase',
    {
      title: 'Set feature phase',
      description: "Set a feature's fase (phase).",
      inputSchema: { ...BOARD_ARG, featureId: z.string(), fase: z.string() },
    },
    ({ boardId, featureId, fase }) => {
      const f = buildModel(setFeaturePhase(bid(boardId), featureId, fase)).featById[featureId]
      if (!f) return jsonText({ error: `feature not found: ${featureId}` })
      return jsonText({ feature: featureSummary(f) })
    },
  )

  server.registerTool(
    'upsert_run',
    {
      title: 'Register or update an agent run',
      description: 'The write path an agent uses to report itself on the board.',
      inputSchema: {
        ...BOARD_ARG,
        id: z.string().describe('The run id (stable key)'),
        agent: z.string().optional(),
        agentType: z.string().optional().describe('claude | grok | codex | other'),
        model: z.string().optional(),
        effort: z.string().optional(),
        task: z.string().optional(),
        feature: z.string().optional(),
        project: z.string().optional(),
        status: z.enum(['running', 'blocked', 'queued', 'done', 'failed']).optional(),
      },
    },
    ({ boardId, id, agent, agentType, model, effort, task, feature, project, status }) => {
      const patch: Parameters<typeof upsertRun>[1] = { id }
      if (agent !== undefined) patch.agent = agent
      if (agentType !== undefined) patch.agentType = agentType
      if (model !== undefined) patch.model = model
      if (effort !== undefined) patch.effort = effort
      if (task !== undefined) patch.task = task
      if (feature !== undefined) patch.feature = feature
      if (project !== undefined) patch.project = project
      if (status !== undefined) patch.status = status
      const raw = upsertRun(bid(boardId), patch)
      return jsonText({ run: raw.runs?.find((r) => r.id === id) ?? null })
    },
  )

  server.registerTool(
    'set_run_status',
    {
      title: 'Set run status',
      description: "Update an agent run's status (e.g. running -> done).",
      inputSchema: { ...BOARD_ARG, id: z.string(), status: z.enum(['running', 'blocked', 'queued', 'done', 'failed']) },
    },
    ({ boardId, id, status }) => {
      const raw = setRunStatus(bid(boardId), id, status)
      return jsonText({ run: raw.runs?.find((r) => r.id === id) ?? null })
    },
  )

  // ---- agent knowledge ----
  server.registerTool(
    'get_conventions',
    {
      title: 'Get conventions',
      description: 'The Cairn playbook: branch/worktree naming, how to use Cairn, deploy, status grades. Read after connecting.',
      inputSchema: {},
    },
    () => jsonText(readConventions()),
  )

  server.registerTool(
    'get_workspace',
    {
      title: 'Get feature workspace',
      description: 'For a feature: canonical branch, git worktree path, and repo per Cairn conventions.',
      inputSchema: { ...BOARD_ARG, featureId: z.string() },
    },
    ({ boardId, featureId }) => {
      const f = modelOf(boardId).featById[featureId]
      if (!f) return jsonText({ error: `feature not found: ${featureId}` })
      const conv = readConventions()
      const repo = (f.projectId && conv.repos?.[f.projectId]) || '<repo>'
      const slug = f.branch ? f.branch.replace(/^(feature|fix|chore)\//, '') : featureId
      return jsonText({
        featureId, project: f.projectId, repo,
        branch: f.branch ?? `feature/${slug}`,
        worktree: `worktrees/${repo}--${slug}`,
        steps: conv.usage ?? [],
      })
    },
  )

  server.registerTool(
    'get_design',
    {
      title: 'Get system design',
      description: 'Design/architecture for a project (components + stack, arsitektur/baseline) or a feature (design links).',
      inputSchema: { ...BOARD_ARG, projectId: z.string().optional(), featureId: z.string().optional() },
    },
    ({ boardId, projectId, featureId }) => {
      const m = modelOf(boardId)
      if (featureId) {
        const f = m.featById[featureId]
        if (!f) return jsonText({ error: `feature not found: ${featureId}` })
        return jsonText({ feature: featureId, design: f.design, links: f.links ?? [] })
      }
      const p = projectId ? m.projById[projectId] : null
      if (!p) return jsonText({ error: 'pass projectId or featureId' })
      const docs = p.docs as Record<string, unknown> | undefined
      return jsonText({
        project: p.id, komponen: p.komponen ?? [],
        arsitektur: docs?.arsitektur ?? null, baseline: docs?.baseline ?? null, design: p.design,
      })
    },
  )

  // ---- collaboration ----
  server.registerTool(
    'add_comment',
    {
      title: 'Add a comment',
      description: 'Leave a comment on a feature for a human or another agent.',
      inputSchema: { ...BOARD_ARG, featureId: z.string(), author: z.string(), text: z.string().min(1), authorType: z.enum(['human', 'agent']).optional() },
    },
    ({ boardId, featureId, author, text, authorType }) => {
      addComment(bid(boardId), featureId, author, authorType ?? 'agent', text)
      return jsonText({ ok: true, featureId })
    },
  )

  server.registerTool(
    'open_decision',
    {
      title: 'Open a decision',
      description: 'Raise a decision that needs a human — blocks the feature until decided. Use when you cannot proceed without an owner call.',
      inputSchema: {
        ...BOARD_ARG,
        featureId: z.string(),
        question: z.string().min(1),
        options: z.array(z.object({ key: z.string(), label: z.string(), rekomendasi: z.boolean().optional() })).optional(),
        openedBy: z.string().optional(),
      },
    },
    ({ boardId, featureId, question, options, openedBy }) => {
      const raw = openDecision(bid(boardId), featureId, question, options, openedBy ?? 'agent')
      const d = raw.decisions?.find((x) => x.featureId === featureId && x.status === 'open')
      return jsonText({ ok: true, decision: d ?? null })
    },
  )

  server.registerTool(
    'set_blocked',
    {
      title: 'Set feature blocked',
      description: 'Mark a feature blocked with a reason (surfaces to the human as "waiting on you").',
      inputSchema: { ...BOARD_ARG, featureId: z.string(), reason: z.string().min(1) },
    },
    ({ boardId, featureId, reason }) => {
      setBlocked(bid(boardId), featureId, reason)
      return jsonText({ ok: true, featureId, reason })
    },
  )

  server.registerTool(
    'list_activity',
    {
      title: 'List activity',
      description: 'The board activity feed (log + collaboration events), newest first.',
      inputSchema: { ...BOARD_ARG, limit: z.number().int().optional().describe('Max events (default 30)') },
    },
    ({ boardId, limit }) => jsonText({ activity: modelOf(boardId).activity.slice(0, limit ?? 30) }),
  )

  // ---- adaptive views: tasks / ops / prod / guide ----
  server.registerTool(
    'list_tasks',
    {
      title: 'List tasks',
      description: 'List a board\'s tasks (first-class, IDs), optionally filtered by projectId/scope.',
      inputSchema: { ...BOARD_ARG, projectId: z.string().optional(), scope: z.string().optional() },
    },
    ({ boardId, projectId, scope }) => {
      let tasks = readTasks(bid(boardId)).tasks
      if (projectId) tasks = tasks.filter((t) => t.projectId === projectId)
      if (scope) tasks = tasks.filter((t) => t.scope === scope)
      return jsonText({
        tasks: tasks.map((t) => ({
          id: t.id, title: t.title, projectId: t.projectId ?? null, phase: t.phase ?? null,
          scope: t.scope ?? null, done: t.checkpoints.filter((c) => c.done).length,
          total: t.checkpoints.length, deps: t.dependencies.length,
        })),
      })
    },
  )
  server.registerTool(
    'get_task',
    {
      title: 'Get task',
      description: 'A single task by id: objective, checkpoints, dependencies, story, refs.',
      inputSchema: { ...BOARD_ARG, id: z.string() },
    },
    ({ boardId, id }) => {
      const t = readTasks(bid(boardId)).tasks.find((x) => x.id === id)
      return jsonText(t ? { task: t } : { error: `task not found: ${id}` })
    },
  )
  server.registerTool(
    'list_accounts',
    {
      title: 'List agent accounts',
      description: 'The agent-account vault (capacity, usable/limit) + accounts. Check before spawning workers.',
      inputSchema: { ...BOARD_ARG },
    },
    ({ boardId }) => {
      const o = readOps(bid(boardId))
      return jsonText({ vault: o.vault, accounts: o.accounts, alert: o.alert ?? null })
    },
  )
  server.registerTool(
    'get_prod',
    {
      title: 'Get production path',
      description: 'The path-to-production gates (G0→G6) for the board.',
      inputSchema: { ...BOARD_ARG },
    },
    ({ boardId }) => jsonText(readProd(bid(boardId))),
  )
  server.registerTool(
    'get_guide',
    {
      title: 'Get board guide',
      description: 'The board-specific guide + rules sections.',
      inputSchema: { ...BOARD_ARG },
    },
    ({ boardId }) => jsonText(readGuide(bid(boardId))),
  )

  // ---- resource: the playbook ----
  server.registerResource(
    'playbook',
    'cairn://playbook',
    {
      title: 'Cairn playbook',
      description: 'How to use Cairn + workspace conventions (branch/worktree/usage).',
      mimeType: 'text/markdown',
    },
    async (uri) => {
      const c = readConventions()
      const md = [
        `# ${c.brand ?? 'Cairn'} — agent playbook`, '',
        '## Branch naming',
        ...Object.entries(c.branch ?? {}).map(([k, v]) => `- ${k}: \`${v}\``), '',
        '## Worktree', `- \`${c.worktree?.path ?? ''}\` — ${c.worktree?.note ?? ''}`, '',
        '## How to use Cairn', ...(c.usage ?? []).map((s, i) => `${i + 1}. ${s}`), '',
        `## Deploy\n${c.deploy ?? ''}`,
        `\n## Status grades\n${(c.status_grades ?? []).join(' · ')}`,
      ].join('\n')
      return { contents: [{ uri: uri.href, mimeType: 'text/markdown', text: md }] }
    },
  )
}
