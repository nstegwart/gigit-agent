// Demo board — the only board committed to the repo (data/boards/demo). These tests
// pass on a fresh clone (no private data). They exercise every adaptive view.
import { expect, test } from '@playwright/test'

test('boards home lists the demo board and it opens', async ({ page }) => {
  await page.goto('/')
  const card = page.locator('.board-card', { hasText: 'Acme Notes (demo)' })
  await expect(card).toBeVisible()
  await card.click()
  await expect(page).toHaveURL(/\/b\/demo/)
  await expect(page.locator('.brand-name')).toHaveText('Cairn')
})

test('demo board shows every adaptive view + real content', async ({ page }) => {
  await page.goto('/b/demo/')
  // full showcase nav
  for (const label of ['Board', 'Agents', 'Features', 'Tasks', 'Accounts', 'Production', 'Guide']) {
    await expect(page.locator('.nav-item .lbl', { hasText: new RegExp(`^${label}$`) })).toBeVisible()
  }
  // features table
  await page.goto('/b/demo/features')
  expect(await page.locator('.ftable tbody tr').count()).toBeGreaterThanOrEqual(6)
  // tasks table
  await page.goto('/b/demo/tasks')
  expect(await page.locator('.ftable tbody tr').count()).toBeGreaterThanOrEqual(3)
  // ops accounts (vault tiles)
  await page.goto('/b/demo/ops')
  await expect(page.locator('.account-card').first()).toBeVisible()
  // prod gates
  await page.goto('/b/demo/prod')
  await expect(page.getByText('G0', { exact: true })).toBeVisible()
})

test('MCP serves the demo board', async ({ request }) => {
  const rpc = (body: unknown) =>
    request.post('/mcp', { headers: { accept: 'application/json, text/event-stream' }, data: body })
  const boards = JSON.parse(
    (await (await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_boards', arguments: {} } })).json())
      .result.content[0].text,
  )
  expect(boards.boards.map((b: { id: string }) => b.id)).toContain('demo')
  const feats = JSON.parse(
    (await (await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'list_features', arguments: { boardId: 'demo' } } })).json())
      .result.content[0].text,
  )
  expect(feats.features.length).toBe(6)
})
