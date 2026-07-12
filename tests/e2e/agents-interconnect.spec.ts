// Interconnection: on the MFS board, agents link to their task + show project + account,
// and the task detail shows the agents working on it (both directions).
import { expect, test } from '@playwright/test'

test('mfs /agents cards show project + account and link to the task', async ({ page }) => {
  await page.goto('/b/mfs-rebuild/agents')

  const card = page.locator('.run', { hasText: 'grok-aff-register' }).first()
  await expect(card).toBeVisible()
  // project chip + real vault account chip (Ops interconnect)
  await expect(card).toContainText('Affiliate program')
  await expect(card).toContainText('@warungaplikasi.biz.id')

  // footer links to the task (by resolved title) → task detail
  const taskLink = card.locator('.run-foot a')
  await expect(taskLink).toBeVisible()
  await taskLink.click()
  await expect(page).toHaveURL(/\/b\/mfs-rebuild\/tasks\/T-AFF-N01-REGISTER-PAGE$/)
})

test('mfs task detail shows the agents on it (reverse link)', async ({ page }) => {
  await page.goto('/b/mfs-rebuild/tasks/T-AFF-N01-REGISTER-PAGE')
  const section = page.locator('.card', {
    has: page.getByRole('heading', { name: 'Agents on this task', exact: true }),
  })
  await expect(section).toBeVisible()
  await expect(section.locator('.run', { hasText: 'grok-aff-register' })).toBeVisible()
})

test('mfs project detail lists that project’s tasks', async ({ page }) => {
  await page.goto('/b/mfs-rebuild/projects/web')
  const section = page.locator('section.section', {
    has: page.getByRole('heading', { level: 2, name: 'Tasks', exact: true }),
  })
  await expect(section).toBeVisible()
  const rows = section.locator('.ftable tbody tr')
  expect(await rows.count()).toBeGreaterThanOrEqual(2)
  await expect(section).toContainText('T-AFF-N10-PUBLIC-A')
  // clicking a task row opens its detail
  await section.locator('.ftable tbody tr', { hasText: 'T-AFF-N10-PUBLIC-A' }).click()
  await expect(page).toHaveURL(/\/b\/mfs-rebuild\/tasks\/T-AFF-N10-PUBLIC-A$/)
})

test('mfs list_runs (MCP) carries taskId + account wiring', async ({ request }) => {
  const res = await request.post('/mcp', {
    headers: { accept: 'application/json, text/event-stream' },
    data: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_runs', arguments: { boardId: 'mfs-rebuild' } } },
  })
  const body = await res.json()
  const runs = JSON.parse(body.result.content[0].text).runs as Array<Record<string, unknown>>
  expect(runs.length).toBe(8)
  const wired = runs.find((r) => r.id === 'run-aff-register')!
  expect(wired.taskId).toBe('T-AFF-N01-REGISTER-PAGE')
  expect(wired.project).toBe('affiliate')
  expect(String(wired.account)).toContain('@')
})
