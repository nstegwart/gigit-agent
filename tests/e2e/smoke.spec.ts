import { expect, test } from '@playwright/test'

test('board shell renders with live agent data', async ({ page }) => {
  await page.goto('/b/ibils/')
  await expect(page.locator('.brand-name')).toHaveText('Cairn')
  // nav "Agents" count = running agents (seeded data has 6)
  await expect(page.getByTestId('board-smoke')).toBeVisible()
  await expect(page.locator('.kpi-num').first()).toHaveText('6')
})

test('mcp endpoint lists tools', async ({ request }) => {
  const res = await request.post('/mcp', { headers: { accept: 'application/json, text/event-stream' },
    data: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
  })
  expect(res.ok()).toBeTruthy()
  const body = await res.json()
  expect(Array.isArray(body.result?.tools)).toBe(true)
})
