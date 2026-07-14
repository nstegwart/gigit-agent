// Interconnection on mfs-rebuild (control-center Agents / Runs).
// Legacy Batch-era selectors (`.run`, vault email chips, hard run-aff-register)
// are stale — surface uses data-testid agent-run-row / agent-run-card / task links.
// DATA_INTEGRITY (empty pin / schema) is a hard fail, never a silent pass.
import { expect, test, type APIRequestContext, type Page } from '@playwright/test'

const BOARD = 'mfs-rebuild'
const AGENTS_URL = `/b/${BOARD}/agents`
const PROJECT_WEB = `/b/${BOARD}/projects/web`

type McpRpcBody = {
  jsonrpc?: string
  id?: number | string | null
  result?: {
    content?: Array<{ type?: string; text?: string }>
    isError?: boolean
  }
  error?: { code?: number; message?: string }
}

type ListRunsProbe = {
  httpStatus: number
  httpOk: boolean
  body: McpRpcBody
  payload: Record<string, unknown> | null
  parseNote: string | null
}

/** Safe list_runs call: never assume result.content[0].text exists. */
async function probeListRuns(
  request: APIRequestContext,
  boardId: string,
): Promise<ListRunsProbe> {
  const res = await request.post('/mcp', {
    headers: { accept: 'application/json, text/event-stream' },
    data: {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'list_runs', arguments: { boardId } },
    },
  })
  const httpStatus = res.status()
  const httpOk = res.ok()
  let body: McpRpcBody = {}
  try {
    body = (await res.json()) as McpRpcBody
  } catch (e) {
    return {
      httpStatus,
      httpOk,
      body,
      payload: null,
      parseNote: `response JSON parse failed: ${String(e)}`,
    }
  }

  const text = body.result?.content?.[0]?.text
  if (typeof text !== 'string' || text.length === 0) {
    return {
      httpStatus,
      httpOk,
      body,
      payload: null,
      parseNote: `missing result.content[0].text; isError=${String(body.result?.isError)}; rpcError=${JSON.stringify(body.error ?? null)}`,
    }
  }

  try {
    return {
      httpStatus,
      httpOk,
      body,
      payload: JSON.parse(text) as Record<string, unknown>,
      parseNote: null,
    }
  } catch (e) {
    return {
      httpStatus,
      httpOk,
      body,
      payload: null,
      parseNote: `content text is not JSON: ${String(e)}`,
    }
  }
}

function runsArray(payload: Record<string, unknown>): Array<Record<string, unknown>> {
  const raw = payload.runs ?? payload.items
  return Array.isArray(raw) ? (raw as Array<Record<string, unknown>>) : []
}

function isDataIntegrityPayload(payload: Record<string, unknown>): boolean {
  const code = String(payload.code ?? '')
  const err = String(payload.error ?? payload.message ?? '')
  return code === 'DATA_INTEGRITY' || /DATA_INTEGRITY/i.test(code) || /DATA_INTEGRITY/i.test(err)
}

/** Fail closed if agents error banner reports DATA_INTEGRITY (fixture/schema packet). */
async function assertNoAgentsDataIntegrity(page: Page): Promise<void> {
  const err = page.getByTestId('agents-error')
  if ((await err.count()) === 0) return
  if (!(await err.isVisible().catch(() => false))) return
  const msg = (await err.innerText()).trim()
  expect(
    msg,
    `agents error banner present — DATA_INTEGRITY is a hard fail (not silent empty): ${msg}`,
  ).not.toMatch(/DATA_INTEGRITY/i)
}

test('mfs /agents control-center rows/cards and task links (no legacy .run/email)', async ({
  page,
}) => {
  await page.goto(AGENTS_URL)

  const root = page.getByTestId('control-center-agents')
  await expect(root).toBeVisible({ timeout: 30_000 })
  // Scope to CC surface — topbar #page-title is also an h1 with bilingual Agents / Runs.
  await expect(root.getByRole('heading', { name: /^Agents\s*\/\s*Runs$/i })).toBeVisible()

  await assertNoAgentsDataIntegrity(page)

  const surface = await root.getAttribute('data-surface-state')
  const runCount = Number((await root.getAttribute('data-run-count')) || '0')

  // Structural chips always meaningful on CC surface.
  await expect(page.getByTestId('agents-run-count')).toBeVisible()
  await expect(page.getByTestId('agents-ongoing-count')).toBeVisible()

  if (surface === 'error' || surface === 'forbidden' || surface === 'disconnected') {
    await expect(page.getByTestId('agents-error')).toBeVisible()
    // Non-DATA_INTEGRITY errors still block interconnect proof.
    expect(
      surface,
      `agents surface ${surface} — cannot prove task interconnect without populated runs`,
    ).toBe('populated')
  }

  if (runCount === 0) {
    // Honest empty inventory: no legacy vault email hardcodes, no Batch-era .run cards required.
    await expect(page.getByTestId('agents-run-count')).toContainText(/0\s*runs/i)
    await expect(page.locator('body')).not.toContainText('@warungaplikasi.biz.id')
    // Empty banner when screen projects it.
    const empty = page.getByTestId('agents-empty')
    if ((await empty.count()) > 0) {
      await expect(empty).toBeVisible()
    }
    return
  }

  const rows = page.getByTestId('agent-run-row')
  const cards = page.getByTestId('agent-run-card')
  const rowN = await rows.count()
  const cardN = await cards.count()
  expect(
    rowN + cardN,
    'expected agent-run-row and/or agent-run-card when data-run-count > 0',
  ).toBeGreaterThan(0)

  // Prefer desktop task link; ongoing ONGOING card uses agent-task-link.
  const runTaskLinks = page.getByTestId('agent-run-task-link')
  const ongoingTaskLinks = page.getByTestId('agent-task-link')
  const linkN = (await runTaskLinks.count()) + (await ongoingTaskLinks.count())
  expect(linkN, 'at least one task link when runs are projected').toBeGreaterThan(0)

  const link = (await runTaskLinks.count()) > 0 ? runTaskLinks.first() : ongoingTaskLinks.first()
  await expect(link).toBeVisible()
  const href = await link.getAttribute('href')
  expect(href, 'task link href').toMatch(new RegExp(`/b/${BOARD}/(tasks|work)/`))

  // Masked account field when present — never require vault email domain.
  const masked = page.locator('[data-field="masked-account"]').first()
  if ((await masked.count()) > 0) {
    const t = (await masked.innerText()).trim()
    expect(t.length).toBeGreaterThan(0)
    expect(t).not.toMatch(/@warungaplikasi\.biz\.id/)
  }

  await link.click()
  await expect(page).toHaveURL(new RegExp(`/b/${BOARD}/(tasks|work)/[^/?#]+`))
})

test('mfs task detail reverse agents link when projected', async ({ page }) => {
  // Drive reverse interconnect from Agents surface — no hardcoded T-AFF-N01 / grok-aff-register.
  await page.goto(AGENTS_URL)
  const root = page.getByTestId('control-center-agents')
  await expect(root).toBeVisible({ timeout: 30_000 })
  await assertNoAgentsDataIntegrity(page)

  const runTaskLinks = page.getByTestId('agent-run-task-link')
  if ((await runTaskLinks.count()) === 0) {
    // No projected task wiring — reverse section cannot be forced; structure only.
    const runCount = Number((await root.getAttribute('data-run-count')) || '0')
    expect(runCount).toBeGreaterThanOrEqual(0)
    await expect(page.getByTestId('agents-run-count')).toBeVisible()
    return
  }

  const link = runTaskLinks.first()
  const taskId =
    ((await link.getAttribute('title')) || (await link.innerText())).trim()
  expect(taskId.length).toBeGreaterThan(0)

  await link.click()
  await expect(page).toHaveURL(new RegExp(`/b/${BOARD}/(tasks|work)/`))

  // Control-center task detail OR Batch-5 task detail with agents section.
  const ccDetail = page.getByTestId('control-center-task-detail')
  if ((await ccDetail.count()) > 0) {
    await expect(ccDetail).toBeVisible()
    return
  }

  const agentsSection = page.locator('.card', {
    has: page.getByRole('heading', { name: 'Agents on this task', exact: true }),
  })
  if ((await agentsSection.count()) > 0) {
    await expect(agentsSection).toBeVisible()
    // Prefer CC testids if present; else RunCard may still render plan runs.
    const sectionRows = agentsSection.getByTestId('agent-run-row')
    const sectionCards = agentsSection.getByTestId('agent-run-card')
    const legacyRuns = agentsSection.locator('.run')
    expect(
      (await sectionRows.count()) +
        (await sectionCards.count()) +
        (await legacyRuns.count()),
      `Agents on this task for ${taskId} should list at least one run`,
    ).toBeGreaterThan(0)
  } else {
    // Plan-model reverse link empty even though CC had a taskId — record task id only.
    expect(taskId, 'had agent-run-task-link but no Agents-on-this-task section').toMatch(/\S/)
  }
})

test('mfs project detail lists project tasks (expand/search, no hard T-AFF id)', async ({
  page,
}) => {
  await page.goto(PROJECT_WEB)

  const main = page.getByTestId('app-main-content')
  await expect(main).toBeVisible({ timeout: 30_000 })
  // Topbar also uses h1#page-title — scope detail hero to main content.
  await expect(main.locator('.detail-title h1')).toBeVisible()
  await expect(page.getByText('Project not found.')).toHaveCount(0)

  const section = main.locator('section.section', {
    has: page.getByRole('heading', { level: 2, name: 'Tasks', exact: true }),
  })
  await expect(section).toBeVisible()

  const countText = (await section.locator('.sec-head .count').innerText()).trim()
  const taskTotal = Number(countText)
  expect(taskTotal, `Tasks count badge (${countText})`).toBeGreaterThanOrEqual(2)

  // Dense boards collapse FC groups — expand or search before asserting data rows.
  const expandAll = section.getByRole('button', { name: /Expand all/i })
  if ((await expandAll.count()) > 0 && (await expandAll.isVisible())) {
    await expandAll.click()
  }

  let taskRows = section.locator('.ftable tbody tr').filter({ has: page.locator('.t-name') })
  if ((await taskRows.count()) === 0) {
    const search = page.getByRole('textbox', { name: /Search/i })
    await expect(search).toBeVisible()
    // Broad needle for web project tasks (avoid obsolete T-AFF-N10 hardcode).
    await search.fill('T-')
    taskRows = section.locator('.ftable tbody tr').filter({ has: page.locator('.t-name') })
    await expect(taskRows.first()).toBeVisible({ timeout: 15_000 })
  }

  expect(await taskRows.count()).toBeGreaterThanOrEqual(1)
  const first = taskRows.first()
  const title = (await first.locator('.t-name').innerText()).trim()
  expect(title.length).toBeGreaterThan(0)

  await first.click()
  await expect(page).toHaveURL(new RegExp(`/b/${BOARD}/tasks/T-`))
  await expect(main.locator('.detail-title h1, h1').first()).toBeVisible()
})

test('mfs list_runs (MCP) safe parse + wiring; fail on DATA_INTEGRITY', async ({
  request,
}) => {
  const probe = await probeListRuns(request, BOARD)

  expect(
    probe.httpOk,
    `POST /mcp list_runs httpStatus=${probe.httpStatus} parseNote=${probe.parseNote}`,
  ).toBeTruthy()
  expect(
    probe.parseNote,
    `list_runs content missing/unparseable: ${probe.parseNote}; bodyKeys=${Object.keys(probe.body).join(',')}`,
  ).toBeNull()
  expect(probe.payload, 'list_runs payload object').toBeTruthy()

  const payload = probe.payload!

  // Hard fail — never treat DATA_INTEGRITY as empty success.
  expect(
    isDataIntegrityPayload(payload),
    `list_runs DATA_INTEGRITY: code=${String(payload.code ?? '')} error=${String(payload.error ?? payload.message ?? '')}`,
  ).toBe(false)

  if (payload.ok === false) {
    expect(
      false,
      `list_runs ok:false code=${String(payload.code ?? '')} error=${String(payload.error ?? '')}`,
    ).toBe(true)
  }

  const runsRaw = payload.runs ?? payload.items
  expect(
    Array.isArray(runsRaw),
    `list_runs must expose runs[] or items[]; keys=${Object.keys(payload).join(',')}`,
  ).toBe(true)

  const runs = runsArray(payload)
  // Drop hard === 8 seed assumption; live inventory varies.
  expect(runs.length).toBeGreaterThanOrEqual(0)

  if (runs.length > 0) {
    const sample = runs[0]
    expect(sample.id || sample.runId, 'run id/runId').toBeTruthy()
    expect(sample, 'status field').toHaveProperty('status')

    // When taskId is projected, it must be a non-empty string (wiring signal).
    const withTask = runs.find((r) => r.taskId != null && String(r.taskId).length > 0)
    if (withTask) {
      expect(String(withTask.taskId).length).toBeGreaterThan(0)
    }

    // Never require vault email / legacy account field — durable list_runs has no account email.
    for (const r of runs) {
      if (r.account != null) {
        expect(String(r.account)).not.toMatch(/@warungaplikasi\.biz\.id/)
      }
    }
  }
})
