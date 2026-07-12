// E2E for the Batch 5 adaptive-view surface: the /mcp JSON-RPC tools that back
// the Tasks / Ops / Prod / Guide views (list_tasks, get_task, list_accounts,
// get_prod, get_guide) plus the UI routes those tools feed for the
// "mfs-rebuild" board (/b/mfs-rebuild/tasks, /tasks/$taskId, /ops, /prod,
// /guide). Read-only throughout: every call uses a read tool or a plain
// navigation/click (no checkpoint toggling, no filter state persisted across
// tests), so nothing mutates data/boards/mfs-rebuild/*.json — nothing to
// restore.
import { expect, test, type APIRequestContext } from '@playwright/test'

const BOARD_ID = 'mfs-rebuild'

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
  const res = await request.post('/mcp', { headers: { accept: 'application/json, text/event-stream' }, data: body })
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
    }>(request, 'list_tasks', { boardId: BOARD_ID })

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
      { boardId: BOARD_ID },
    )
    const projectId = all.tasks.find((t) => t.projectId)?.projectId
    expect(projectId, 'need at least one task with a projectId').toBeTruthy()

    const scoped = await callTool<{ tasks: Array<{ projectId: string | null }> }>(
      request,
      'list_tasks',
      { boardId: BOARD_ID, projectId },
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
    })
    const id = list.tasks[0]?.id
    expect(id, 'need at least one task id').toBeTruthy()

    const payload = await callTool<{
      task: {
        id: string
        title: string
        checkpoints: Array<{ id: string; label: string; done: boolean }>
        dependencies: string[]
      }
    }>(request, 'get_task', { boardId: BOARD_ID, id })

    expect(payload.task).toBeTruthy()
    expect(payload.task.id).toBe(id)
    expect(payload.task.title).toBeTruthy()
    expect(Array.isArray(payload.task.checkpoints)).toBe(true)
    expect(Array.isArray(payload.task.dependencies)).toBe(true)
  })

  test('tools/call get_task with an unknown id returns an error payload, not a throw', async ({
    request,
  }) => {
    const payload = await callTool<{ error?: string }>(request, 'get_task', {
      boardId: BOARD_ID,
      id: 'T-DOES-NOT-EXIST',
    })
    expect(payload.error).toContain('T-DOES-NOT-EXIST')
  })

  test('tools/call list_accounts {boardId:"mfs-rebuild"} returns vault.accountCount 21', async ({
    request,
  }) => {
    const payload = await callTool<{
      vault: { accountCount: number; usableCount: number; limitCount: number }
      accounts: Array<{ id: string; label: string; usable: boolean; slotsCapacity: number }>
      alert: unknown
    }>(request, 'list_accounts', { boardId: BOARD_ID })

    expect(payload.vault.accountCount).toBe(21)
    expect(payload.vault.usableCount).toBe(7)
    expect(payload.vault.limitCount).toBe(14)
    expect(Array.isArray(payload.accounts)).toBe(true)
    expect(payload.accounts.length).toBe(21)

    const a = payload.accounts[0]
    expect(a.id).toBeTruthy()
    expect(a.label).toBeTruthy()
    expect(typeof a.usable).toBe('boolean')
  })

  test('tools/call get_prod {boardId:"mfs-rebuild"} returns 7 gates G0..G6', async ({
    request,
  }) => {
    const payload = await callTool<{
      mockLabel?: string
      headline?: string
      gates: Array<{ id: string; title: string; meaning?: string; doneWhen?: string }>
    }>(request, 'get_prod', { boardId: BOARD_ID })

    expect(Array.isArray(payload.gates)).toBe(true)
    expect(payload.gates.length).toBe(7)
    expect(payload.gates.map((g) => g.id)).toEqual(['G0', 'G1', 'G2', 'G3', 'G4', 'G5', 'G6'])
    expect(payload.gates[0].title).toBeTruthy()
  })

  test('tools/call get_guide {boardId:"mfs-rebuild"} returns guide sections', async ({
    request,
  }) => {
    const payload = await callTool<{ sections: Array<{ title: string; body: string }> }>(
      request,
      'get_guide',
      { boardId: BOARD_ID },
    )
    expect(Array.isArray(payload.sections)).toBe(true)
    expect(payload.sections.length).toBeGreaterThanOrEqual(1)
    for (const sec of payload.sections) {
      expect(sec.title).toBeTruthy()
      expect(sec.body).toBeTruthy()
    }
  })
})

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

    const cards = section.locator('.ftable tbody tr')
    await expect(cards.first()).toBeVisible()
    const count = await cards.count()
    expect(count).toBeGreaterThanOrEqual(40)

    await expect(section.locator('.count')).toHaveText(String(count))
  })

  test('a task card shows id, phase and a progress bar, and links to its detail page', async ({
    page,
  }) => {
    const card = page.locator('.ftable tbody tr').first()
    await expect(card).toBeVisible()
    await expect(card.locator('.t-id')).not.toBeEmpty()
    await expect(card.locator('.bar')).toBeVisible()

    const taskId = (await card.locator('.t-id').innerText()).trim()
    await card.click()

    await expect(page).toHaveURL(new RegExp(`/b/${BOARD_ID}/tasks/${taskId}$`))
    await expect(page.locator('.task-id')).toHaveText(taskId)
  })

  test('project filter chips narrow the task grid', async ({ page }) => {
    const chips = page.locator('.filters .fbtn')
    await expect(chips.first()).toBeVisible()
    expect(await chips.count()).toBeGreaterThan(1)

    const allCount = await page.locator('.ftable tbody tr').count()

    // chips[0] is "All projects"; chips[1] is the first real project chip.
    const target = chips.nth(1)
    await target.click()
    await expect(target).toHaveClass(/\bon\b/)

    const filtered = page.locator('.ftable tbody tr')
    await expect(filtered.first()).toBeVisible()
    const filteredCount = await filtered.count()
    expect(filteredCount).toBeGreaterThanOrEqual(1)
    expect(filteredCount).toBeLessThanOrEqual(allCount)
  })
})

test.describe('Task detail view (UI) — /b/mfs-rebuild/tasks/$taskId', () => {
  test('shows objective, categorized checkpoints, and dependency chips', async ({
    page,
    request,
  }) => {
    const list = await callTool<{ tasks: Array<{ id: string; deps: number }> }>(
      request,
      'list_tasks',
      { boardId: BOARD_ID },
    )
    const withDeps = list.tasks.find((t) => t.deps > 0) ?? list.tasks[0]
    expect(withDeps, 'need at least one task').toBeTruthy()

    await page.goto(`/b/${BOARD_ID}/tasks/${withDeps.id}`)

    await expect(page.locator('.task-id')).toHaveText(withDeps.id)

    const checkpointRows = page.locator('.checkpoint')
    await expect(checkpointRows.first()).toBeVisible()
    expect(await checkpointRows.count()).toBeGreaterThanOrEqual(1)
    await expect(page.locator('.cp-cat').first()).toBeVisible()

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

test.describe('Ops view (UI) — /b/mfs-rebuild/ops', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(`/b/${BOARD_ID}/ops`)
  })

  test('vault tiles report 21 accounts, 7 usable, 14 at limit', async ({ page }) => {
    const tiles = page.locator('.vault .vault-tile')
    await expect(tiles.first()).toBeVisible()
    expect(await tiles.count()).toBeGreaterThanOrEqual(3)

    await expect(tiles.filter({ hasText: 'Accounts' }).locator('.vault-num')).toHaveText('21')
    await expect(tiles.filter({ hasText: 'Usable' }).locator('.vault-num')).toHaveText('7')
    await expect(tiles.filter({ hasText: 'At limit' }).locator('.vault-num')).toHaveText('14')
  })

  test('renders 21 account cards, each tagged usable or limit', async ({ page }) => {
    const cards = page.locator('.account-grid .account-card')
    await expect(cards.first()).toBeVisible()
    expect(await cards.count()).toBe(21)

    const usable = page.locator('.account-card.usable')
    const limit = page.locator('.account-card.limit')
    expect(await usable.count()).toBeGreaterThanOrEqual(1)
    expect(await limit.count()).toBeGreaterThanOrEqual(1)
    expect((await usable.count()) + (await limit.count())).toBe(21)

    await expect(cards.first().locator('.account-badge')).toBeVisible()
  })

  test('does not show the low-account alert banner (usableCount 7 >= threshold 3)', async ({
    page,
  }) => {
    await expect(page.locator('.alert-banner')).toHaveCount(0)
  })
})

test.describe('Prod view (UI) — /b/mfs-rebuild/prod', () => {
  test('shows the mock banner and all 7 gates G0..G6', async ({ page }) => {
    await page.goto(`/b/${BOARD_ID}/prod`)

    await expect(page.getByRole('heading', { level: 2, name: 'Path to production' })).toBeVisible()
    await expect(page.locator('.mock-banner')).toBeVisible()

    const gates = page.locator('.gate')
    await expect(gates.first()).toBeVisible()
    expect(await gates.count()).toBe(7)

    const ids = await page.locator('.gate .gate-id').allInnerTexts()
    expect(ids).toEqual(['G0', 'G1', 'G2', 'G3', 'G4', 'G5', 'G6'])

    await expect(gates.first().locator('.gate-title')).not.toBeEmpty()
  })
})

test.describe('Guide view (UI) — /b/mfs-rebuild/guide', () => {
  test('renders guide sections with title and body', async ({ page }) => {
    await page.goto(`/b/${BOARD_ID}/guide`)

    await expect(page.getByRole('heading', { level: 2, name: 'Guide' })).toBeVisible()

    const sections = page.locator('.guide-sec')
    await expect(sections.first()).toBeVisible()
    expect(await sections.count()).toBeGreaterThanOrEqual(1)

    await expect(sections.first().locator('h3')).toHaveText('Stage')
    await expect(sections.first().locator('p')).not.toBeEmpty()
  })
})

test.describe('Adaptive nav — mfs-rebuild board shows only its enabled views', () => {
  test('sidebar exposes Tasks/Accounts/Production/Guide but not Features/Map/Design', async ({
    page,
  }) => {
    await page.goto(`/b/${BOARD_ID}/tasks`)

    for (const label of ['Tasks', 'Accounts', 'Production', 'Guide']) {
      await expect(page.locator('.nav-item', { hasText: label })).toBeVisible()
    }
    for (const label of ['Features', 'Map', 'Design']) {
      await expect(page.locator('.nav-item', { hasText: label })).toHaveCount(0)
    }
  })
})
