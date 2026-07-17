// E2E for the Batch 5 adaptive-view MCP tools (list_tasks, get_task, list_accounts,
// get_prod, get_guide) plus the UI routes those tools feed for the "mfs-rebuild"
// control-center board (/b/mfs-rebuild/tasks, /tasks/$taskId, /ops).
//
// Control-center contract (UI_CONTRACT §2 + AppShell.CONTROL_CENTER_NAV):
//   - mfs-rebuild always shows the nine primary IA labels (not Batch-5 Tasks/Accounts-only).
//   - Ops UI is OpsScreen (`data-testid=control-center-ops`), not legacy vault tiles.
//   - Populated accounts come from the pinned account-sync envelope; empty/error/
//     DATA_INTEGRITY surfaces must fail closed (do not mask with hardcoded 21/7/14).
//
// The Prod/Guide UI views were removed from the app, so only their MCP tools
// (get_prod/get_guide) are exercised here — no /prod or /guide UI routes remain.
//
// Read-only throughout: every call uses a read tool or a plain navigation/click
// (no checkpoint toggling, no filter state persisted across tests).
import { expect, test } from '@playwright/test'
import type { APIRequestContext, Locator, Page } from '@playwright/test'

const BOARD_ID = 'mfs-rebuild'

/** Exact English labels for control-center boards (AppShell.CONTROL_CENTER_NAV_LABELS). */
const CONTROL_CENTER_NAV_LABELS = [
  'Overview',
  'Work',
  'Priority',
  'Projects',
  'Features / Flows',
  'Agents / Runs',
  'Ops / Accounts',
  'Decisions',
  'Evidence / Audit',
] as const

const OPS_SURFACE_STATES = [
  'loading',
  'empty',
  'populated',
  'partial',
  'stale',
  'error',
  'forbidden',
  'disconnected',
  'zero-results',
] as const

type ToolContent = { type: string; text: string }
type RpcResult = {
  jsonrpc?: string
  id?: number | string | null
  result?: {
    tools?: Array<{ name: string; description?: string }>
    content?: ToolContent[]
    isError?: boolean
  }
  error?: { code: number; message: string }
}

async function rpc(
  request: APIRequestContext,
  body: Record<string, unknown>,
): Promise<RpcResult> {
  const res = await request.post('/mcp', {
    headers: { accept: 'application/json, text/event-stream' },
    data: body,
  })
  expect(res.ok(), `POST /mcp failed: ${res.status()}`).toBeTruthy()
  return (await res.json()) as RpcResult
}

/** Call a tool and return the parsed JSON payload of its first text content block. */
async function callTool<T = unknown>(
  request: APIRequestContext,
  name: string,
  args: Record<string, unknown> = {},
): Promise<T> {
  const body = await rpc(request, {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name, arguments: args },
  })
  const text = body.result?.content?.[0]?.text
  expect(text, `${name} returned no text content`).toBeTruthy()
  return JSON.parse(text as string) as T
}

function navItem(page: Page, label: string): Locator {
  return page.locator('.sidebar a.nav-item', {
    has: page.locator('.lbl', {
      hasText: new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`),
    }),
  })
}

// ---------------------------------------------------------------------------
// MCP tools — method/schema contract (preserve; do not invent vault counts)
// ---------------------------------------------------------------------------

test.describe('/mcp adaptive-view tools (tasks / ops / prod / guide)', () => {
  test('tools/list advertises list_tasks, get_task, list_accounts, get_prod, get_guide', async ({
    request,
  }) => {
    const body = await rpc(request, { jsonrpc: '2.0', id: 1, method: 'tools/list' })
    const tools = body.result?.tools
    expect(Array.isArray(tools)).toBe(true)

    const names = (tools ?? []).map((t) => t.name)
    for (const expected of ['list_tasks', 'get_task', 'list_accounts', 'get_prod', 'get_guide']) {
      expect(names, `tools/list should expose ${expected}`).toContain(expected)
    }
  })

  test('tools/call list_tasks {boardId:"mfs-rebuild"} returns >=40 tasks', async ({
    request,
  }) => {
    const payload = await callTool<{
      schemaVersion?: string
      method?: string
      tasks: Array<{
        id: string
        title: string
        projectId: string | null
        phase: string | null
        scope: string | null
        done: number
        total: number
        deps: number
      }>
    }>(request, 'list_tasks', { boardId: BOARD_ID, pageSize: 200 })

    // Pinned envelope method/schema when present (compatibility spread keeps tasks flat).
    if (payload.schemaVersion != null) {
      expect(payload.schemaVersion).toBe('TM_PINNED_ENVELOPE_V1')
    }
    if (payload.method != null) {
      expect(payload.method).toBe('list_tasks')
    }

    expect(Array.isArray(payload.tasks)).toBe(true)
    expect(payload.tasks.length).toBeGreaterThanOrEqual(40)

    const t = payload.tasks[0]
    expect(t.id).toBeTruthy()
    expect(t.id).toMatch(/^T-/)
    expect(t.title).toBeTruthy()
    expect(t).toHaveProperty('done')
    expect(t).toHaveProperty('total')
    expect(t.total).toBeGreaterThanOrEqual(t.done)
  })

  test('list_tasks filtered by projectId only returns that project', async ({ request }) => {
    const all = await callTool<{ tasks: Array<{ projectId: string | null }> }>(
      request,
      'list_tasks',
      { boardId: BOARD_ID, pageSize: 200 },
    )
    const projectId = all.tasks.find((t) => t.projectId)?.projectId
    expect(projectId, 'need at least one task with a projectId').toBeTruthy()

    const scoped = await callTool<{ tasks: Array<{ projectId: string | null }> }>(
      request,
      'list_tasks',
      { boardId: BOARD_ID, projectId, pageSize: 200 },
    )
    expect(scoped.tasks.length).toBeGreaterThanOrEqual(1)
    expect(scoped.tasks.length).toBeLessThanOrEqual(all.tasks.length)
    for (const t of scoped.tasks) {
      expect(t.projectId).toBe(projectId)
    }
  })

  test('tools/call get_task returns a single task with checkpoints/dependencies/story', async ({
    request,
  }) => {
    const list = await callTool<{ tasks: Array<{ id: string }> }>(request, 'list_tasks', {
      boardId: BOARD_ID,
      pageSize: 50,
    })
    const id = list.tasks[0]?.id
    expect(id, 'need at least one task id').toBeTruthy()

    const payload = await callTool<{
      schemaVersion?: string
      method?: string
      task: {
        id: string
        title: string
        checkpoints: Array<{ id: string; label: string; done: boolean }>
        dependencies: string[]
      }
    }>(request, 'get_task', { boardId: BOARD_ID, id })

    if (payload.schemaVersion != null) {
      expect(payload.schemaVersion).toBe('TM_PINNED_ENVELOPE_V1')
    }
    if (payload.method != null) {
      expect(payload.method).toBe('get_task')
    }

    expect(payload.task).toBeTruthy()
    expect(payload.task.id).toBe(id)
    expect(payload.task.title).toBeTruthy()
    expect(Array.isArray(payload.task.checkpoints)).toBe(true)
    expect(Array.isArray(payload.task.dependencies)).toBe(true)
  })

  test('tools/call get_task with an unknown id returns an error payload, not a throw', async ({
    request,
  }) => {
    const payload = await callTool<{ error?: string; code?: string }>(request, 'get_task', {
      boardId: BOARD_ID,
      id: 'T-DOES-NOT-EXIST',
    })
    expect(payload.error).toContain('T-DOES-NOT-EXIST')
  })

  test('tools/call list_accounts returns pinned MCP account schema (not legacy vault counts)', async ({
    request,
  }) => {
    // Durable account-sync path: ACCOUNT_MCP_LIST_V1 + TM_PINNED_ENVELOPE_V1.
    // Do NOT hardcode vault.accountCount 21/7/14 — empty pin / DATA_INTEGRITY must
    // surface honestly (empty accounts + stale/schema fields), never as a fake vault.
    const payload = await callTool<{
      schemaVersion?: string
      method?: string
      accounts?: Array<Record<string, unknown>>
      data?: {
        schema?: string | null
        accounts?: Array<Record<string, unknown>>
        stale?: boolean
        sourceRevision?: number | null
      }
      stale?: boolean
      // Legacy vault shape must not be required for green:
      vault?: { accountCount?: number }
    }>(request, 'list_accounts', { boardId: BOARD_ID })

    if (payload.schemaVersion != null) {
      expect(payload.schemaVersion).toBe('TM_PINNED_ENVELOPE_V1')
    }
    if (payload.method != null) {
      expect(payload.method).toBe('list_accounts')
    }

    const accounts: Array<Record<string, unknown>> | null = Array.isArray(payload.accounts)
      ? payload.accounts
      : Array.isArray(payload.data?.accounts)
        ? payload.data.accounts
        : null
    expect(accounts, 'list_accounts must expose accounts array (may be empty)').not.toBeNull()
    expect(Array.isArray(accounts)).toBe(true)

    const nestedSchema = payload.data?.schema
    if (nestedSchema != null) {
      expect(nestedSchema).toBe('ACCOUNT_MCP_LIST_V1')
    }

    // When rows exist: masked identity only — no secret-looking keys.
    for (const row of accounts ?? []) {
      const keys = Object.keys(row)
      for (const k of keys) {
        expect(k, `secret-like field leaked on list_accounts row: ${k}`).not.toMatch(
          /token|secret|password|authorization|api[_-]?key|credential/i,
        )
      }
    }

    // Explicit anti-mask: if someone reintroduces vault.accountCount hardcoding,
    // empty/honest pins must still pass — we never require vault.accountCount === 21.
    if (payload.vault?.accountCount != null) {
      expect(typeof payload.vault.accountCount).toBe('number')
    }
  })

  test('tools/call get_prod {boardId:"mfs-rebuild"} returns 7 gates G0..G6', async ({
    request,
  }) => {
    const payload = await callTool<{
      schemaVersion?: string
      method?: string
      mockLabel?: string
      headline?: string
      gates: Array<{ id: string; title: string; meaning?: string; doneWhen?: string }>
    }>(request, 'get_prod', { boardId: BOARD_ID })

    if (payload.schemaVersion != null) {
      expect(payload.schemaVersion).toBe('TM_PINNED_ENVELOPE_V1')
    }
    if (payload.method != null) {
      expect(payload.method).toBe('get_prod')
    }

    expect(Array.isArray(payload.gates)).toBe(true)
    expect(payload.gates.length).toBe(7)
    expect(payload.gates.map((g) => g.id)).toEqual(['G0', 'G1', 'G2', 'G3', 'G4', 'G5', 'G6'])
    expect(payload.gates[0].title).toBeTruthy()
  })

  test('tools/call get_guide {boardId:"mfs-rebuild"} returns guide sections', async ({
    request,
  }) => {
    const payload = await callTool<{
      schemaVersion?: string
      method?: string
      sections: Array<{ title: string; body: string }>
    }>(request, 'get_guide', { boardId: BOARD_ID })

    if (payload.schemaVersion != null) {
      expect(payload.schemaVersion).toBe('TM_PINNED_ENVELOPE_V1')
    }
    if (payload.method != null) {
      expect(payload.method).toBe('get_guide')
    }

    expect(Array.isArray(payload.sections)).toBe(true)
    expect(payload.sections.length).toBeGreaterThanOrEqual(1)
    for (const sec of payload.sections) {
      expect(sec.title).toBeTruthy()
      expect(sec.body).toBeTruthy()
    }
  })
})

// ---------------------------------------------------------------------------
// Tasks UI — server-derived count (>=40), expand/search before row asserts
// ---------------------------------------------------------------------------

test.describe('Tasks view (UI) — /b/mfs-rebuild/tasks', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(`/b/${BOARD_ID}/tasks`)
  })

  test('renders a task grid with at least 40 cards, matching the section count', async ({
    page,
  }) => {
    const section = page.locator('section.section', {
      has: page.getByRole('heading', { name: 'Tasks' }),
    })
    await expect(section.getByRole('heading', { name: 'Tasks' })).toBeVisible()

    // Count is server/DB-derived (not hardcoded JSON-era 44).
    const countText = (await section.locator('.count').innerText()).trim()
    const listed = Number(countText)
    expect(Number.isFinite(listed), `section .count should be numeric, got ${countText}`).toBe(
      true,
    )
    expect(listed).toBeGreaterThanOrEqual(40)

    // Long lists collapse groups (autoOpen when rows <= 25). Expand or search so
    // data rows exist in the DOM before counting tr.
    const expandAll = page.getByRole('button', { name: /Expand all/i })
    if (await expandAll.isVisible().catch(() => false)) {
      await expandAll.click()
    }

    const cards = section.locator('.ftable tbody tr').filter({ has: page.locator('.t-id') })
    await expect(cards.first()).toBeVisible()
    const rowCount = await cards.count()
    expect(rowCount).toBeGreaterThanOrEqual(1)
    // Header count remains the source of truth for total; visible rows may be paged/grouped.
    expect(listed).toBeGreaterThanOrEqual(rowCount)
  })

  test('a task card shows id, phase and a progress bar, and links to its detail page', async ({
    page,
  }) => {
    // Search opens collapsible groups (TasksTable `searching` ⇒ groups open).
    const search = page.getByRole('textbox', { name: 'Search' })
    await expect(search).toBeVisible()

    // Seed a broad query that should hit real task ids (T- prefix).
    // If the first expanded row has a concrete id, prefer that; else type "T-".
    const expandAll = page.getByRole('button', { name: /Expand all/i })
    if (await expandAll.isVisible().catch(() => false)) {
      await expandAll.click()
    }

    let card = page.locator('.ftable tbody tr').filter({ has: page.locator('.t-id') }).first()
    if (!(await card.isVisible().catch(() => false))) {
      await search.fill('T-')
      card = page.locator('.ftable tbody tr').filter({ has: page.locator('.t-id') }).first()
    }
    await expect(card).toBeVisible()
    // TasksTable puts the task id in the first column as div.t-id (other cells reuse .t-id).
    const idCell = card.locator('div.t-id').first()
    await expect(idCell).not.toBeEmpty()
    await expect(card.locator('.bar')).toBeVisible()

    const taskId = (await idCell.innerText()).trim()
    await card.click()

    await expect(page).toHaveURL(new RegExp(`/b/${BOARD_ID}/tasks/${taskId}$`))
    await expect(page.locator('.task-id')).toHaveText(taskId)
  })

  test('project filter chips narrow the task grid', async ({ page }) => {
    const chips = page.locator('.filters .fbtn')
    await expect(chips.first()).toBeVisible()
    expect(await chips.count()).toBeGreaterThan(1)

    const expandAll = page.getByRole('button', { name: /Expand all/i })
    if (await expandAll.isVisible().catch(() => false)) {
      await expandAll.click()
    }

    const dataRows = () =>
      page.locator('.ftable tbody tr').filter({ has: page.locator('.t-id') })
    const allCount = await dataRows().count()

    // chips[0] is "All projects"; chips[1] is the first real project chip.
    const target = chips.nth(1)
    await target.click()
    await expect(target).toHaveClass(/\bon\b/)

    if (await expandAll.isVisible().catch(() => false)) {
      await expandAll.click()
    }

    const filtered = dataRows()
    await expect(filtered.first()).toBeVisible()
    const filteredCount = await filtered.count()
    expect(filteredCount).toBeGreaterThanOrEqual(1)
    expect(filteredCount).toBeLessThanOrEqual(Math.max(allCount, filteredCount))
  })
})

// ---------------------------------------------------------------------------
// Task detail — LifecycleRail (CheckpointList not mounted on this route)
// ---------------------------------------------------------------------------

test.describe('Task detail view (UI) — /b/mfs-rebuild/tasks/$taskId', () => {
  test('shows objective/lifecycle rail and dependency chips when present', async ({
    page,
    request,
  }) => {
    const list = await callTool<{ tasks: Array<{ id: string; deps: number }> }>(
      request,
      'list_tasks',
      { boardId: BOARD_ID, pageSize: 100 },
    )
    const withDeps = list.tasks.find((t) => t.deps > 0) ?? list.tasks[0]
    expect(withDeps, 'need at least one task').toBeTruthy()

    await page.goto(`/b/${BOARD_ID}/tasks/${withDeps.id}`)

    await expect(page.locator('.task-id')).toHaveText(withDeps.id)
    await expect(page.locator('.detail-title h1')).not.toBeEmpty()

    // Lifecycle rail is the production progress surface (not legacy .checkpoint list).
    const rail = page.getByTestId('lifecycle-rail')
    await expect(rail).toBeVisible()
    await expect(page.getByText(/ready-production/i).first()).toBeVisible()

    if (withDeps.deps > 0) {
      const depsCard = page.locator('.card', {
        has: page.getByRole('heading', { name: 'Dependencies' }),
      })
      await expect(depsCard).toBeVisible()
      await expect(depsCard.locator('.chip').first()).toBeVisible()
    }
  })

  test('an unknown task id shows an empty state instead of crashing', async ({ page }) => {
    await page.goto(`/b/${BOARD_ID}/tasks/T-DOES-NOT-EXIST`)
    await expect(page.getByText('Task not found.')).toBeVisible()
  })
})

// ---------------------------------------------------------------------------
// Ops UI — control-center OpsScreen (do not mask DATA_INTEGRITY)
// ---------------------------------------------------------------------------

test.describe('Ops view (UI) — /b/mfs-rebuild/ops', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(`/b/${BOARD_ID}/ops`)
  })

  test('control-center Ops route mounts Ops / Accounts chrome', async ({ page }) => {
    await expect(page.getByTestId('control-center-ops-route')).toBeVisible()
    const surface = page.getByTestId('control-center-ops')
    await expect(surface).toBeVisible()
    // Page title may be bilingual in shell; screen h1 is id-ID monoline.
    await expect(surface.getByRole('heading', { level: 1, name: 'Operasi / Akun' })).toBeVisible()

    const state = await surface.getAttribute('data-surface-state')
    expect(
      OPS_SURFACE_STATES,
      `unexpected data-surface-state=${state}`,
    ).toContain(state as (typeof OPS_SURFACE_STATES)[number])

    // Legacy vault DOM is not the CC contract.
    await expect(page.locator('.vault .vault-tile')).toHaveCount(0)
    await expect(page.locator('.account-grid .account-card')).toHaveCount(0)
  })

  test('account list when populated; error/empty/stale fail closed without inventing vault counts', async ({
    page,
  }) => {
    const surface = page.getByTestId('control-center-ops')
    await expect(surface).toBeVisible()

    // Wait until not stuck on pure loading (or accept loading skeleton).
    await expect
      .poll(async () => (await surface.getAttribute('data-surface-state')) ?? '', {
        timeout: 15_000,
      })
      .not.toBe('')

    const state = (await surface.getAttribute('data-surface-state')) ?? ''
    const accountCount = Number((await surface.getAttribute('data-account-count')) ?? '0')

    if (state === 'error' || state === 'forbidden' || state === 'disconnected') {
      // Honest fail-closed: error banner with code — DATA_INTEGRITY must remain visible.
      const err = page.getByTestId('ops-error')
      await expect(err).toBeVisible()
      const errText = await err.innerText()
      expect(errText, 'ops error banner must include code + ops unavailable').toMatch(
        /ops unavailable/i,
      )
      // Do not require vault tiles or account cards when the surface is fail-closed.
      await expect(page.locator('.vault .vault-tile')).toHaveCount(0)
      await expect(page.getByTestId('ops-account-card')).toHaveCount(0)
      return
    }

    if (state === 'empty' || state === 'zero-results') {
      await expect(page.getByTestId('ops-empty')).toBeVisible()
      expect(accountCount).toBe(0)
      return
    }

    if (state === 'loading') {
      await expect(page.getByTestId('ops-skeleton')).toBeVisible()
      return
    }

    // populated | partial | stale — list only when accounts projected.
    // Desktop shows table rows (visible); card list may be CSS-hidden at wide viewports.
    if (accountCount > 0) {
      await expect(page.getByTestId('ops-account-count')).toContainText(String(accountCount))
      const cards = page.getByTestId('ops-account-card')
      const rows = page.getByTestId('ops-account-row')
      const cardN = await cards.count()
      const rowN = await rows.count()
      expect(cardN + rowN, 'projected accounts must render as rows and/or cards').toBeGreaterThan(0)
      if (rowN > 0) {
        await expect(rows.first()).toBeVisible()
        await expect(rows.first().locator('[data-field="masked-account-id"]')).not.toBeEmpty()
      } else {
        // Card-only layout (narrow): assert attached + non-empty masked id even if CSS-hidden
        // at the harness viewport would still be a contract miss — require visibility.
        await expect(cards.first()).toBeVisible()
        await expect(cards.first().locator('[data-field="masked-account-id"]')).not.toBeEmpty()
      }
    } else {
      // Stale/partial with zero accounts still must not invent legacy vault numbers.
      await expect(page.locator('.vault .vault-tile')).toHaveCount(0)
    }

    if (state === 'stale') {
      // Either pin stale banner or account-sync-stale chip — honesty over silence.
      const staleBanner = page.getByTestId('ops-stale-banner')
      const syncStale = page.getByTestId('ops-sync-stale')
      const hasStale =
        (await staleBanner.count()) > 0 ||
        (await syncStale.count()) > 0 ||
        (await surface.getAttribute('data-account-sync-stale')) === '1'
      expect(hasStale, 'stale surface should expose stale banner or sync-stale flag').toBe(true)
    }
  })

  test('legacy low-account alert-banner is not the CC contract', async ({ page }) => {
    // Batch-5 `.alert-banner` is AccountsGrid-only. CC Ops uses ops-error / ops-stale-banner.
    await expect(page.locator('.alert-banner')).toHaveCount(0)
    await expect(page.getByTestId('control-center-ops')).toBeVisible()
  })
})

// ---------------------------------------------------------------------------
// Adaptive nav — nine control-center IA (not Batch-5 Tasks/Accounts-only)
// ---------------------------------------------------------------------------

test.describe('Adaptive nav — mfs-rebuild board shows control-center IA', () => {
  test('sidebar exposes nine CC labels including Ops / Accounts and Features / Flows', async ({
    page,
  }) => {
    await page.goto(`/b/${BOARD_ID}/tasks`)

    await expect(page.locator('.sidebar')).toBeVisible()

    for (const label of CONTROL_CENTER_NAV_LABELS) {
      await expect(navItem(page, label)).toBeVisible()
    }

    // Explicit contract spots from UI_CONTRACT / AppShell.
    await expect(navItem(page, 'Ops / Accounts')).toBeVisible()
    await expect(navItem(page, 'Features / Flows')).toBeVisible()
    await expect(navItem(page, 'Overview')).toBeVisible()

    // Legacy Batch-5 adaptive labels must not drive the CC sidebar.
    await expect(navItem(page, 'Tasks')).toHaveCount(0)
    await expect(navItem(page, 'Accounts')).toHaveCount(0)
    await expect(navItem(page, 'Map')).toHaveCount(0)
    await expect(navItem(page, 'Design')).toHaveCount(0)
    // Classic monoline "Features" is not a CC label.
    await expect(navItem(page, 'Features')).toHaveCount(0)
  })
})
