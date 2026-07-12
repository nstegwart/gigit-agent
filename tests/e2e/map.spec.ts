import { expect, test } from '@playwright/test'

// Covers the /map route (`WireGraph` port of the prototype dependency graph):
// an SVG DAG of `.wire-node` links connected by `.wire-edge` paths, with
// project filter chips (`.filters .fbtn`, same pattern as /features) that
// narrow the graph. Read-only — never mutates `data/plan.json`.

test.describe('Dependency map (/map)', () => {
  test('renders the wire graph with edges and nodes', async ({ page }) => {
    await page.goto('/b/ibils/map')

    await expect(page.locator('.sec-head h2')).toHaveText('Dependency map')

    const svg = page.locator('.wire-edges')
    await expect(svg).toBeVisible()

    const edges = svg.locator('path.wire-edge')
    await expect(edges.first()).toBeAttached()
    const edgeCount = await edges.count()
    expect(edgeCount).toBeGreaterThanOrEqual(5)

    const nodes = page.locator('a.wire-node')
    await expect(nodes.first()).toBeVisible()
    const nodeCount = await nodes.count()
    expect(nodeCount).toBeGreaterThan(0)

    // Header count badge mirrors the unfiltered node count.
    await expect(page.locator('.sec-head .count')).toHaveText(String(nodeCount))

    // Each node exposes a name and a done/total task ratio.
    const firstNode = nodes.first()
    await expect(firstNode.locator('.wn-name')).toBeVisible()
    await expect(firstNode.locator('.wn-meta')).toBeVisible()
  })

  test('a project filter chip changes the node count', async ({ page }) => {
    await page.goto('/b/ibils/map')

    const nodes = page.locator('a.wire-node')
    await expect(nodes.first()).toBeVisible()
    const totalCount = await nodes.count()

    // Chip order mirrors `m.projects`: index 0 is the "All projects" reset
    // chip, so the first real per-project chip is index 1.
    const projectChips = page.locator('.filters button.fbtn')
    const allProjectsChip = projectChips.first()
    await expect(allProjectsChip).toHaveText('All projects')

    const projectChip = projectChips.nth(1)
    const projectName = (await projectChip.textContent())?.trim()
    expect(projectName?.length ?? 0).toBeGreaterThan(0)

    await projectChip.click()
    await expect(projectChip).toHaveClass(/\bon\b/)

    // Node count reflects the filtered feature set and differs from the
    // unfiltered total (a project subset is never the whole board).
    await expect(async () => {
      const filteredCount = await nodes.count()
      expect(filteredCount).not.toBe(totalCount)
    }).toPass()

    const filteredCount = await nodes.count()
    await expect(page.locator('.sec-head .count')).toHaveText(String(filteredCount))

    // Resetting to "All projects" restores the full node count.
    await allProjectsChip.click()
    await expect(nodes).toHaveCount(totalCount)
  })

  test('clicking a wire node navigates to its feature detail page', async ({ page }) => {
    await page.goto('/b/ibils/map')

    const nodes = page.locator('a.wire-node')
    await expect(nodes.first()).toBeVisible()

    const firstNode = nodes.first()
    const nodeName = (await firstNode.locator('.wn-name').textContent())?.trim()
    expect(nodeName?.length ?? 0).toBeGreaterThan(0)

    await firstNode.click()

    await expect(page).toHaveURL(/\/features\/.+/)
    await expect(page.locator('.detail-title h1')).toHaveText(nodeName!)
  })
})
