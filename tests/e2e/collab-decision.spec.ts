// E2E for the human<->agent decision loop: an agent raises a decision through the
// /mcp `open_decision` tool (which blocks the feature "waiting on you"), then a
// human resolves it in the Cairn UI via the DecidePanel — clearing the block.
// MUTATES data/plan.json (opens a decision + blocks/unblocks the feature); the
// Verify phase resets data, so no manual restore here.
import { expect, test, type APIRequestContext } from '@playwright/test'

const FEATURE_ID = 'f4-m2-produk'
const QUESTION = 'Ship v0?'

/** Raise a decision on a feature via the real MCP tool an agent would call. */
async function openDecision(request: APIRequestContext): Promise<void> {
  const res = await request.post('/mcp', { headers: { accept: 'application/json, text/event-stream' },
    data: {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'open_decision',
        arguments: {
          featureId: FEATURE_ID,
          question: QUESTION,
          options: [
            { key: 'a', label: 'Yes' },
            { key: 'b', label: 'No' },
          ],
        },
      },
    },
  })
  expect(res.ok(), `open_decision failed: ${res.status()}`).toBeTruthy()
  const body = (await res.json()) as {
    result?: { content?: Array<{ text: string }>; isError?: boolean }
  }
  expect(body.result?.isError, 'open_decision returned an MCP error').toBeFalsy()
  const text = body.result?.content?.[0]?.text
  expect(text, 'open_decision returned no content').toBeTruthy()
  const payload = JSON.parse(text as string) as {
    ok: boolean
    decision: { id: string; featureId?: string } | null
  }
  expect(payload.ok).toBe(true)
  expect(payload.decision?.featureId).toBe(FEATURE_ID)
}

test.describe('collaboration — decide via UI', () => {
  test('agent opens a decision via MCP, human resolves it and unblocks the feature', async ({
    page,
    request,
  }) => {
    // Agent side: raise the decision — this blocks the feature.
    await openDecision(request)

    // Human side: open the feature and confirm the DecidePanel is waiting.
    await page.goto(`/b/ibils/features/${FEATURE_ID}`)

    const panel = page.locator('.decide')
    await expect(panel).toBeVisible()
    await expect(panel.locator('.d-q')).toHaveText(QUESTION)

    // The feature is blocked while the decision is open.
    const banner = page.locator('.banner.blocked')
    await expect(banner).toBeVisible()

    // Resolve it by choosing "Yes".
    const yes = panel.locator('.decide-opt', { hasText: 'Yes' })
    await expect(yes).toBeVisible()
    await yes.click()

    // Deciding clears the block — banner disappears and the panel closes.
    await expect(banner).toHaveCount(0)
    await expect(page.locator('.decide')).toHaveCount(0)
  })
})
