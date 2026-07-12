// E2E for the Batch 5 adaptive views on the "mfs-rebuild" board: Tasks, Ops
// (agent-account vault), Prod (path-to-production gates), Guide.
//
// Board data: data/boards/mfs-rebuild/{tasks,accounts,prod,guide}.json.
// Real seed: 21 vault accounts / 7 usable / 14 at limit; 7 production gates
// G0..G6; 3 guide sections; 44 WorkTasks (T-AFF-*).
//
// Only the "checkpoint toggle" test mutates data (tasks.json) — it toggles a
// known-unchecked checkpoint on, verifies persistence across reload, then
// toggles it back off so the file is restored. Every other test is read-only.
import { expect, test } from '@playwright/test'

const BOARD = '/b/mfs-rebuild'

test.describe('Ops (agent accounts) view', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(`${BOARD}/ops`)
  })

  test('header renders and vault summary tiles show real counts', async ({ page }) => {
    await expect(page.getByRole('heading', { level: 2, name: 'Agent accounts' })).toBeVisible()

    const tiles = page.locator('.vault .vault-tile')
    await expect(tiles.first()).toBeVisible()
    expect(await tiles.count()).toBeGreaterThanOrEqual(3)

    // Seed: 21 accounts / 7 usable / 14 at limit.
    const accountsTile = tiles.filter({ has: page.locator('.vault-lbl', { hasText: 'Accounts' }) })
    await expect(accountsTile.locator('.vault-num')).toHaveText('21')
    const usableTile = tiles.filter({ has: page.locator('.vault-lbl', { hasText: 'Usable' }) })
    await expect(usableTile.locator('.vault-num')).toHaveText('7')
    const limitTile = tiles.filter({ has: page.locator('.vault-lbl', { hasText: 'At limit' }) })
    await expect(limitTile.locator('.vault-num')).toHaveText('14')
  })

  test('account cards render with usable/limit badges', async ({ page }) => {
    const cards = page.locator('.account-grid .account-card')
    await expect(cards.first()).toBeVisible()
    expect(await cards.count()).toBe(21)

    // Usable cards carry the .usable class + badge text "usable".
    const usableCards = page.locator('.account-card.usable')
    expect(await usableCards.count()).toBe(7)
    await expect(usableCards.first().locator('.account-badge.usable')).toHaveText('usable')

    // Limit cards carry the .limit class + badge text "limit" + a reason line.
    const limitCards = page.locator('.account-card.limit')
    expect(await limitCards.count()).toBe(14)
    await expect(limitCards.first().locator('.account-badge.limit')).toHaveText('limit')
    await expect(limitCards.first().locator('.account-reason')).not.toBeEmpty()

    // Every card exposes a label and a slots-in-use line.
    await expect(cards.first().locator('.account-label')).not.toBeEmpty()
    await expect(cards.first().locator('.account-slots')).toContainText('/20 slots in use')
  })

  test('low-usable alert banner is shown (usable 7 vs seeded threshold)', async ({ page }) => {
    // alert.enabled=true, lowThreshold=3 in seed data. usableCount(7) is NOT
    // below the threshold, so the banner should be absent; this proves the
    // component reads real vault numbers rather than always rendering it.
    await expect(page.locator('.alert-banner')).toHaveCount(0)
  })
})

test.describe('Prod (path to production) view', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(`${BOARD}/prod`)
  })

  test('header, mock banner and headline render', async ({ page }) => {
    await expect(page.getByRole('heading', { level: 2, name: 'Path to production' })).toBeVisible()
    await expect(page.locator('.mock-banner')).toContainText('MOCK')
    await expect(page.locator('.mock-banner')).toContainText('preview desain')
  })

  test('all seeded gates G0..G6 render with title and body', async ({ page }) => {
    const gates = page.locator('.gate')
    expect(await gates.count()).toBe(7)

    for (const id of ['G0', 'G1', 'G2', 'G3', 'G4', 'G5', 'G6']) {
      const gate = page.locator('.gate', { has: page.locator('.gate-id', { hasText: id }) })
      await expect(gate).toBeVisible()
      await expect(gate.locator('.gate-title')).not.toBeEmpty()
    }
  })

  test('a gate exposes meaning and a "done when" meta line', async ({ page }) => {
    const g1 = page.locator('.gate', { has: page.locator('.gate-id', { hasText: 'G1' }) })
    await expect(g1.locator('.gate-meaning')).toContainText('Feature Contract')
    await expect(g1.locator('.gate-meta')).toContainText('done when:')
  })
})

test.describe('Guide view', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(`${BOARD}/guide`)
  })

  test('header renders and all seeded guide sections show title + body', async ({ page }) => {
    await expect(page.getByRole('heading', { level: 2, name: 'Guide' })).toBeVisible()

    const sections = page.locator('.guide-sec')
    expect(await sections.count()).toBe(3)

    const titles = await sections.locator('h3').allInnerTexts()
    expect(titles).toEqual(expect.arrayContaining(['Stage', 'Golden template', 'Rule']))

    for (let i = 0; i < (await sections.count()); i++) {
      await expect(sections.nth(i).locator('h3')).not.toBeEmpty()
      await expect(sections.nth(i).locator('p')).not.toBeEmpty()
    }

    // Content sanity: the "Stage" section calls out the LOCAL ONLY status cap.
    const stage = sections.filter({ has: page.locator('h3', { hasText: 'Stage' }) })
    await expect(stage.locator('p')).toContainText('LOCAL ONLY')
  })
})

test.describe('Tasks (list) view', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(`${BOARD}/tasks`)
  })

  test('header count and task grid render all seeded tasks', async ({ page }) => {
    const section = page.locator('section.section', {
      has: page.getByRole('heading', { name: 'Tasks' }),
    })
    await expect(section.getByRole('heading', { name: 'Tasks' })).toBeVisible()
    await expect(section.locator('.count')).toHaveText('44')

    const cards = section.locator('.ftable tbody tr')
    expect(await cards.count()).toBe(44)
  })

  test('a task card shows id, phase, progress bar and checkpoint count', async ({ page }) => {
    const card = page
      .locator('.ftable tbody tr', { hasText: 'T-AFF-INTEGRATION-E2E' })
      .first()
    await expect(card).toBeVisible()
    await expect(card.locator('.t-name')).not.toBeEmpty()
    await expect(card.locator('.task-phase')).not.toBeEmpty()
    await expect(card.locator('.bar')).toBeVisible()
    await expect(card.locator('.t-id')).toHaveText('T-AFF-INTEGRATION-E2E')
    await expect(card).toContainText(/\d+\/\d+/) // checkpoint count cell (done/total)
  })

  test('project filter chips narrow the grid, "All projects" resets it', async ({ page }) => {
    const section = page.locator('section.section', {
      has: page.getByRole('heading', { name: 'Tasks' }),
    })
    const allBtn = section.getByRole('button', { name: 'All projects' })
    await expect(allBtn).toBeVisible()
    await expect(allBtn).toHaveClass(/on/)

    const totalCount = await section.locator('.ftable tbody tr').count()

    // Click the "affiliate" project chip (seeded project id for the sampled task).
    const affBtn = section.getByRole('button', { name: 'affiliate', exact: true })
    await affBtn.click()
    await expect(affBtn).toHaveClass(/on/)
    const filteredCount = await section.locator('.ftable tbody tr').count()
    expect(filteredCount).toBeGreaterThan(0)
    expect(filteredCount).toBeLessThanOrEqual(totalCount)

    await allBtn.click()
    await expect(allBtn).toHaveClass(/on/)
    expect(await section.locator('.ftable tbody tr').count()).toBe(totalCount)
  })

  test('global search filters the task grid by title/id', async ({ page }) => {
    const search = page.getByRole('textbox', { name: 'Search' })
    await expect(search).toBeVisible()
    await search.fill('N03-LOGIN-GATES')
    const cards = page.locator('.ftable tbody tr')
    await expect(cards).toHaveCount(1)
    await expect(cards.first()).toContainText('T-AFF-N03-LOGIN-GATES')
    await search.fill('')
  })
})

test.describe('Task detail view', () => {
  const TASK_URL = `${BOARD}/tasks/T-AFF-INTEGRATION-E2E`

  test.beforeEach(async ({ page }) => {
    await page.goto(TASK_URL)
  })

  test('hero shows title, id, phase, project chip and progress bar', async ({ page }) => {
    await expect(page.locator('.back')).toBeVisible()
    await expect(page.locator('.detail-title h1')).not.toBeEmpty()
    await expect(page.locator('.task-id')).toHaveText('T-AFF-INTEGRATION-E2E')
    await expect(page.locator('.task-phase').first()).not.toBeEmpty()
    await expect(page.locator('.detail-head .bar')).toBeVisible()
  })

  test('objective, story and checkpoints cards render', async ({ page }) => {
    const objectiveCard = page.locator('.card', {
      has: page.getByRole('heading', { name: 'Objective' }),
    })
    await expect(objectiveCard).toBeVisible()
    await expect(objectiveCard.locator('.meta-row', { hasText: 'Next' })).toBeVisible()

    const storyCard = page.locator('.card', { has: page.getByRole('heading', { name: 'Story' }) })
    await expect(storyCard).toBeVisible()
    await expect(storyCard.locator('.meta-row', { hasText: 'User story' })).toBeVisible()

    const cpCard = page.locator('.card', {
      has: page.getByRole('heading', { name: 'Checkpoints' }),
    })
    await expect(cpCard).toBeVisible()
    // Seed: 10 checkpoints for this task.
    expect(await cpCard.locator('.checkpoint').count()).toBe(10)
  })

  test('dependencies render as clickable links to other tasks', async ({ page }) => {
    const depsCard = page.locator('.card', {
      has: page.getByRole('heading', { name: 'Dependencies' }),
    })
    await expect(depsCard).toBeVisible()
    const links = depsCard.locator('a.chip')
    expect(await links.count()).toBeGreaterThan(0)

    const first = links.first()
    const href = await first.getAttribute('href')
    expect(href).toContain(`${BOARD}/tasks/`)
    await first.click()
    await expect(page).toHaveURL(new RegExp(`${BOARD}/tasks/T-AFF-`))
    await expect(page.locator('.detail-title h1')).not.toBeEmpty()
  })

  test('references card lists API + pages chips', async ({ page }) => {
    const refsCard = page.locator('.card', {
      has: page.getByRole('heading', { name: 'References' }),
    })
    await expect(refsCard).toBeVisible()
    await expect(refsCard.locator('.meta-row', { hasText: 'API' })).toBeVisible()
    await expect(refsCard.locator('.meta-row', { hasText: 'Pages' })).toBeVisible()
    expect(await refsCard.locator('.chip.chip-mono').count()).toBeGreaterThan(0)
  })

  test('unknown task id shows a not-found empty state', async ({ page }) => {
    await page.goto(`${BOARD}/tasks/T-DOES-NOT-EXIST`)
    await expect(page.locator('.back')).toBeVisible()
    await expect(page.getByText('Task not found.')).toBeVisible()
  })
})

test.describe('Checkpoint toggle (mutating — restores itself)', () => {
  // T-AFF-N03-LOGIN-GATES is seeded with a mix of done/undone checkpoints, so
  // there is always at least one unchecked row available to toggle.
  const TASK_URL = `${BOARD}/tasks/T-AFF-N03-LOGIN-GATES`

  test('toggling a checkpoint flips its done state, persists, then restores', async ({
    page,
  }) => {
    await page.goto(TASK_URL)

    const cpCard = page.locator('.card', {
      has: page.getByRole('heading', { name: 'Checkpoints' }),
    })
    await expect(cpCard).toBeVisible()

    const firstUnchecked = cpCard.locator('.checkpoint:not(.done)').first()
    await expect(firstUnchecked).toBeVisible()
    const label = (await firstUnchecked.locator('.cp-label').innerText()).trim()
    expect(label.length).toBeGreaterThan(0)

    const row = cpCard.locator('.checkpoint', { hasText: label })
    await expect(row).toHaveCount(1)
    await expect(row).not.toHaveClass(/done/)
    await expect(row.locator('.box svg')).toHaveCount(0)

    // --- toggle ON --------------------------------------------------------
    await row.click()
    await expect(row).toHaveClass(/done/)
    await expect(row.locator('.box svg')).toBeVisible()

    // Persists across a full reload (server wrote tasks.json).
    await page.reload()
    const reloadedRow = page
      .locator('.card', { has: page.getByRole('heading', { name: 'Checkpoints' }) })
      .locator('.checkpoint', { hasText: label })
    await expect(reloadedRow).toHaveClass(/done/)

    // --- toggle OFF (restore original state) -------------------------------
    await reloadedRow.click()
    await expect(reloadedRow).not.toHaveClass(/done/)
    await page.reload()
    const finalRow = page
      .locator('.card', { has: page.getByRole('heading', { name: 'Checkpoints' }) })
      .locator('.checkpoint', { hasText: label })
    await expect(finalRow).not.toHaveClass(/done/)
  })
})
