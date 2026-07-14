// E2E for mfs-rebuild Tasks + Ops / Accounts (control-center secondary surfaces).
//
// Prod/Guide *UI* routes were removed from the app. Real G5 / prod / guide
// semantics live in MCP tools get_prod / get_guide (see mcp-views.spec.ts) —
// this file does not re-assert those tools or invent /prod|/guide pages.
//
// Ops path for control-center boards (mfs-rebuild): OpsScreen via pinned
// envelope (data-testid control-center-ops / ops-account-*). Legacy vault
// (.vault-tile, .account-card usable/limit, Agent accounts h2) is non-CC only.
//
// Tasks: server-derived count (MySQL taskSummaries — often >> JSON seed 44).
// With >25 rows, TasksTable collapses groups until search or Expand all.
// Assert specific rows only after search/expand. Do not hardcode 44.
//
// CheckpointList card + interactive checkpoint toggle are not mounted on the
// task detail route; LifecycleRail (read-only nested checkpoints) is the surface.
// No mutating tests in this file.
import { expect, test, type Locator, type Page } from '@playwright/test'

const BOARD = '/b/mfs-rebuild'
const MIN_TASKS = 40
const SAMPLE_TASK_ID = 'T-AFF-INTEGRATION-E2E'
const SEARCH_TASK_TOKEN = 'N03-LOGIN-GATES'
const SEARCH_TASK_ID = 'T-AFF-N03-LOGIN-GATES'

/** Global topbar search (AppShell aria-label: "Search features and agents"). */
function globalSearch(page: Page) {
  return page.getByRole('textbox', { name: /Search features/i })
}

/** Data rows only — group headers (tr.tgroup) lack div.t-id; other cells reuse span.t-id. */
function taskDataRows(scope: Page | Locator) {
  // CSS :has keeps the match scoped to each tr (avoid chaining a section-wide locator into filter has).
  return scope.locator('.ftable tbody tr:has(div.t-id)')
}

/**
 * Long lists collapse groups (TasksTable autoOpen only when rows <= 25).
 * Never click "Expand all" on large boards — mounting hundreds of rows freezes
 * Chromium under parallel workers. Open one group header, or a narrow search.
 */
async function ensureSomeTaskRowsVisible(page: Page) {
  await page.locator('.ftable').first().waitFor({ state: 'visible' })
  const rows = taskDataRows(page)
  if (await rows.first().isVisible().catch(() => false)) return

  const firstGroup = page.locator('tr.tgroup').first()
  if ((await firstGroup.count()) > 0) {
    await firstGroup.click()
    if (await rows.first().isVisible().catch(() => false)) return
  }

  // Narrow token: opens matching groups without dumping the full 600+ set.
  const search = globalSearch(page)
  await search.fill(SEARCH_TASK_TOKEN)
  await expect(rows.first()).toBeVisible({ timeout: 15_000 })
}

/** Sum of group-header badges (visible even when groups are collapsed). */
async function sumGroupTaskBadges(scope: Page | Locator) {
  const badges = scope.locator('tr.tgroup .tgroup-count')
  const n = await badges.count()
  let sum = 0
  for (let i = 0; i < n; i++) {
    sum += Number((await badges.nth(i).innerText()).trim()) || 0
  }
  return sum
}

test.describe('Ops / Accounts (control-center)', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(`${BOARD}/ops`)
  })

  test('route mounts OpsScreen with Ops / Accounts chrome and CC testids', async ({ page }) => {
    await expect(page.getByTestId('control-center-ops-route')).toBeVisible()
    const ops = page.getByTestId('control-center-ops')
    await expect(ops).toBeVisible()
    // Shell page-title is bilingual ("Ops / Accounts · Operasi / Akun"); screen h1 is exact.
    await expect(ops.getByRole('heading', { level: 1, name: 'Ops / Accounts', exact: true })).toBeVisible()
    await expect(ops).toHaveAttribute('data-board-id', 'mfs-rebuild')
    await expect(ops).toHaveAttribute('data-surface-state', /.+/)
    await expect(page.getByTestId('ops-live')).toBeAttached()

    // Must not regress to legacy vault DOM on this board.
    await expect(page.locator('.vault .vault-tile')).toHaveCount(0)
    await expect(page.locator('.account-grid .account-card')).toHaveCount(0)
    await expect(page.getByRole('heading', { level: 2, name: 'Agent accounts' })).toHaveCount(0)
  })

  test('summary chips and account list are server-derived (no hardcoded vault 21/7/14)', async ({
    page,
  }) => {
    const ops = page.getByTestId('control-center-ops')
    await expect(ops).toBeVisible()
    const surface = await ops.getAttribute('data-surface-state')

    // Honest fail-closed surfaces: error / empty / populated (or loading→settled).
    if (surface === 'error' || surface === 'forbidden' || surface === 'disconnected') {
      await expect(page.getByTestId('ops-error')).toBeVisible()
      // Do not invent account rows when the envelope is unavailable.
      await expect(page.getByTestId('ops-account-row')).toHaveCount(0)
      return
    }

    if (surface === 'empty' || surface === 'zero-results') {
      await expect(page.getByTestId('ops-empty')).toBeVisible()
      await expect(page.getByTestId('ops-account-row')).toHaveCount(0)
      return
    }

    // Populated / partial / stale: count chip reflects data-account-count (server).
    const accountCountAttr = await ops.getAttribute('data-account-count')
    expect(accountCountAttr, 'data-account-count present on control-center-ops').toBeTruthy()
    const serverCount = Number(accountCountAttr)
    expect(Number.isFinite(serverCount)).toBe(true)
    expect(serverCount).toBeGreaterThanOrEqual(0)

    if (serverCount === 0) {
      await expect(page.getByTestId('ops-empty')).toBeVisible()
      return
    }

    await expect(page.getByTestId('ops-account-count')).toBeVisible()
    await expect(page.getByTestId('ops-account-count')).toContainText(String(serverCount))

    // Sync chip is either stale or fresh — never legacy alert-banner.
    const syncStale = page.getByTestId('ops-sync-stale')
    const syncFresh = page.getByTestId('ops-sync-fresh')
    expect((await syncStale.count()) + (await syncFresh.count())).toBeGreaterThanOrEqual(1)

    // Optional capacity / quarantine chips when the envelope provides them.
    // Do not hardcode usable=7 or at-limit=14 (JSON vault era).
    const usable = page.getByTestId('ops-usable-capacity')
    if ((await usable.count()) > 0) {
      await expect(usable).toContainText(/usable capacity\s+\d+/i)
    }
    const quarantine = page.getByTestId('ops-quarantine-count')
    if ((await quarantine.count()) > 0) {
      await expect(quarantine).toContainText(/quarantine\s+\d+/i)
    }

    await expect(page.getByTestId('ops-accounts-table')).toBeVisible()
    const rows = page.getByTestId('ops-account-row')
    await expect(rows.first()).toBeVisible()
    expect(await rows.count()).toBe(serverCount)

    // Row contract: masked id + capacity field; flags via data-* not .usable/.limit CSS.
    const first = rows.first()
    await expect(first.locator('[data-field="masked-account-id"]')).not.toBeEmpty()
    await expect(first.locator('[data-field="capacity"]')).toContainText(/\d+\/\d+/)
    await expect(first).toHaveAttribute('data-limit', /0|1/)
    await expect(first).toHaveAttribute('data-quarantine', /0|1/)
    await expect(first).toHaveAttribute('data-tombstone', /0|1/)

    // Narrow-viewport card list mirrors rows (same server set).
    const cards = page.getByTestId('ops-account-card')
    expect(await cards.count()).toBe(serverCount)
  })

  test('pin strip exposes snapshot id when pin is present (honest absence ok)', async ({ page }) => {
    const ops = page.getByTestId('control-center-ops')
    await expect(ops).toBeVisible()
    const pin = page.getByTestId('ops-pin')
    if ((await pin.count()) === 0) {
      // Envelope without pin (e.g. hard error) — still must not show vault tiles.
      await expect(page.locator('.vault .vault-tile')).toHaveCount(0)
      return
    }
    await expect(pin).toBeVisible()
    await expect(pin).toHaveAttribute('data-canonical-snapshot-id', /.+/)
    await expect(pin).toHaveAttribute('data-board-rev', /.+/)
    await expect(pin).toHaveAttribute('data-freshness-age', /.+/)
  })
})

test.describe('Tasks (list) view', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(`${BOARD}/tasks`)
  })

  test('header count is server-derived and >= 40; do not assume 44', async ({ page }) => {
    const section = page.locator('section.section', {
      has: page.getByRole('heading', { name: 'Tasks', exact: true }),
    })
    await expect(section.getByRole('heading', { name: 'Tasks', exact: true })).toBeVisible()

    const countText = (await section.locator('.count').innerText()).trim()
    const serverCount = Number(countText)
    expect(Number.isFinite(serverCount), `count text is numeric: ${countText}`).toBe(true)
    expect(serverCount).toBeGreaterThanOrEqual(MIN_TASKS)
    // Explicit anti-staleness: do not lock to JSON-era 44.
    // (If the live count ever equals 44, that is fine — we only forbid requiring it.)

    // With large lists groups collapse — open one group or narrow search (never Expand all).
    await ensureSomeTaskRowsVisible(page)
    const rows = taskDataRows(section)
    await expect(rows.first()).toBeVisible({ timeout: 15_000 })
    expect(await rows.count()).toBeGreaterThan(0)
    expect(await rows.count()).toBeLessThanOrEqual(serverCount)
    await globalSearch(page).fill('')
  })

  test('search reveals a specific task row (no rely on default-expanded groups)', async ({
    page,
  }) => {
    // Wait for server-derived list shell before filtering (avoids empty-filter race).
    const section = page.locator('section.section', {
      has: page.getByRole('heading', { name: 'Tasks', exact: true }),
    })
    await expect(section.locator('.count')).toBeVisible()
    const countNum = Number((await section.locator('.count').innerText()).trim())
    expect(countNum).toBeGreaterThanOrEqual(MIN_TASKS)

    const search = globalSearch(page)
    await expect(search).toBeVisible()
    await search.click()
    await search.fill('')
    // Prefer short unique token; searching auto-opens collapsed groups (TasksTable).
    await search.fill(SEARCH_TASK_TOKEN)

    const card = page
      .locator('.ftable tbody tr')
      .filter({ has: page.locator('div.t-id', { hasText: SEARCH_TASK_ID }) })
      .first()
    await expect(card).toBeVisible({ timeout: 15_000 })
    await expect(card.locator('.t-name')).not.toBeEmpty()
    await expect(card.locator('div.t-id').first()).toHaveText(SEARCH_TASK_ID)
    // Current TasksTable columns: stage chip / next-gate / readiness bar — not checkpoint n/n.
    const bar = card.locator('.bar')
    if ((await bar.count()) > 0) {
      await expect(bar.first()).toBeVisible()
    }
    await expect(card).toContainText(/\d+%/)
    await search.fill('')
  })

  test('project filter chips narrow the grid, "All projects" resets it', async ({ page }) => {
    const section = page.locator('section.section', {
      has: page.getByRole('heading', { name: 'Tasks', exact: true }),
    })
    // Clear search so badges reflect the full (unfiltered) set.
    await globalSearch(page).fill('')
    const allBtn = section.getByRole('button', { name: 'All projects' })
    await expect(allBtn).toBeVisible()
    await expect(allBtn).toHaveClass(/on/)

    // Group headers stay mounted when collapsed — use badge sums, not Expand-all rows.
    const groupHeaders = section.locator('tr.tgroup')
    await expect(groupHeaders.first()).toBeVisible({ timeout: 15_000 })
    const totalTasks = await sumGroupTaskBadges(section)
    expect(totalTasks).toBeGreaterThan(0)
    expect(totalTasks).toBeGreaterThanOrEqual(MIN_TASKS)

    // Prefer affiliate when present; otherwise any non-All project chip.
    const affBtn = section.getByRole('button', { name: 'affiliate', exact: true })
    const projectChip =
      (await affBtn.count()) > 0
        ? affBtn
        : section.locator('.filters button.fbtn').filter({ hasNotText: /All /i }).first()

    await expect(projectChip).toBeVisible()
    await projectChip.click()
    await expect(projectChip).toHaveClass(/on/)
    await expect(groupHeaders.first()).toBeVisible({ timeout: 15_000 })
    const filteredTasks = await sumGroupTaskBadges(section)
    expect(filteredTasks).toBeGreaterThan(0)
    expect(filteredTasks).toBeLessThanOrEqual(totalTasks)

    await allBtn.click()
    await expect(allBtn).toHaveClass(/on/)
    await expect(groupHeaders.first()).toBeVisible({ timeout: 15_000 })
    expect(await sumGroupTaskBadges(section)).toBe(totalTasks)
  })

  test('global search filters the task grid by title/id', async ({ page }) => {
    const section = page.locator('section.section', {
      has: page.getByRole('heading', { name: 'Tasks', exact: true }),
    })
    await expect(section.locator('.count')).toBeVisible()

    const search = globalSearch(page)
    await expect(search).toBeVisible()
    await search.fill('')
    await search.fill(SEARCH_TASK_TOKEN)

    const match = page
      .locator('.ftable tbody tr')
      .filter({ has: page.locator('div.t-id', { hasText: SEARCH_TASK_ID }) })
      .first()
    await expect(match).toBeVisible({ timeout: 15_000 })
    // Searching opens groups and narrows to matching ids — not a full unfiltered dump.
    const dataRows = taskDataRows(page)
    expect(await dataRows.count()).toBeGreaterThanOrEqual(1)
    expect(await dataRows.count()).toBeLessThan(MIN_TASKS)
    await search.fill('')
  })
})

test.describe('Task detail view', () => {
  const TASK_URL = `${BOARD}/tasks/${SAMPLE_TASK_ID}`

  test.beforeEach(async ({ page }) => {
    await page.goto(TASK_URL)
  })

  test('hero shows title, id, phase/progress chrome', async ({ page }) => {
    await expect(page.locator('.back')).toBeVisible()
    await expect(page.locator('.detail-title h1')).not.toBeEmpty()
    await expect(page.locator('.task-id')).toHaveText(SAMPLE_TASK_ID)
    // Phase may come from lifecycle stage or legacy phase field.
    const phase = page.locator('.task-phase').first()
    if ((await phase.count()) > 0) {
      await expect(phase).not.toBeEmpty()
    }
    await expect(page.locator('.detail-head .bar')).toBeVisible()
  })

  test('LifecycleRail is the checkpoint surface (not CheckpointList card)', async ({ page }) => {
    await expect(page.getByTestId('lifecycle-rail')).toBeVisible()
    // Stale CheckpointList card heading must not be required.
    // Nested mapping checkpoints (if any) expand under the rail nest head.
    const nestHead = page.locator('.rail-nest-head')
    if ((await nestHead.count()) > 0) {
      await nestHead.first().click()
      const items = page.locator('.rail-ck .ts-check-item')
      if ((await items.count()) > 0) {
        await expect(items.first()).toBeVisible()
        await expect(items.first().locator('.ts-check-label')).not.toBeEmpty()
      }
    }

    // Details card is always mounted on detail.
    const details = page.locator('.card', {
      has: page.getByRole('heading', { name: 'Details', exact: true }),
    })
    await expect(details).toBeVisible()

    // Objective / Story / References are conditional on payload — assert only when present.
    const objective = page.locator('.card', {
      has: page.getByRole('heading', { name: 'Objective', exact: true }),
    })
    if ((await objective.count()) > 0) {
      await expect(objective).toBeVisible()
    }
    const story = page.locator('.card', {
      has: page.getByRole('heading', { name: 'Story', exact: true }),
    })
    if ((await story.count()) > 0) {
      await expect(story.locator('.meta-row', { hasText: 'User story' })).toBeVisible()
    }
    const refs = page.locator('.card', {
      has: page.getByRole('heading', { name: 'References', exact: true }),
    })
    if ((await refs.count()) > 0) {
      expect(await refs.locator('.chip.chip-mono').count()).toBeGreaterThan(0)
    }
  })

  test('dependencies render as clickable links when present', async ({ page }) => {
    const depsCard = page.locator('.card', {
      has: page.getByRole('heading', { name: 'Dependencies', exact: true }),
    })
    if ((await depsCard.count()) === 0) {
      // Seed may lack dependencies for this id — not a product failure.
      test.info().annotations.push({
        type: 'note',
        description: `${SAMPLE_TASK_ID} has no Dependencies card in this fixture`,
      })
      return
    }
    await expect(depsCard).toBeVisible()
    const links = depsCard.locator('a.chip')
    expect(await links.count()).toBeGreaterThan(0)

    const first = links.first()
    const href = await first.getAttribute('href')
    expect(href).toContain(`${BOARD}/tasks/`)
    await first.click()
    await expect(page).toHaveURL(new RegExp(`${BOARD}/tasks/T-`))
    await expect(page.locator('.detail-title h1')).not.toBeEmpty()
  })

  test('unknown task id shows a not-found empty state', async ({ page }) => {
    await page.goto(`${BOARD}/tasks/T-DOES-NOT-EXIST`)
    await expect(page.locator('.back')).toBeVisible()
    await expect(page.getByText('Task not found.')).toBeVisible()
  })
})

test.describe('G5 / prod / guide semantics (deferred to MCP)', () => {
  test('this suite documents UI absence of /prod and /guide (no false UI contract)', async ({
    page,
  }) => {
    // Contract: Prod/Guide UI routes removed; MCP get_prod/get_guide remain in mcp-views.
    // Lightweight smoke: navigating invented paths must not mount a dedicated prod/guide shell.
    await page.goto(`${BOARD}/prod`)
    await expect(page.getByRole('heading', { name: /Production|Prod \/ Guide|G5/i })).toHaveCount(0)
    await page.goto(`${BOARD}/guide`)
    await expect(page.getByRole('heading', { name: /^Guide$/i })).toHaveCount(0)
  })
})
