import { expect, test, type Locator } from '@playwright/test'

// Sidebar section -> expected board-scoped route + topbar title (see AppShell.tsx
// SECTION_TITLE + SECTION_TITLE_ID → `${en} · ${id}` when ID present).
// Nav links are board-scoped (/b/ibils/...), so we select each item by its stable
// `.lbl` text rather than a hard-coded href (router may omit trailing slash on home).
// Route identity (urlPattern + nav label + active class) stays strict; only titles
// track the bilingual SECTION_TITLE bases (Agents / Runs, Features / Flows, …).
const SECTIONS: Array<{ label: string; urlPattern: RegExp; title: string }> = [
  {
    label: 'Agents',
    urlPattern: /\/b\/ibils\/agents$/,
    title: 'Agents / Runs · Agen / Run',
  },
  {
    label: 'Projects',
    urlPattern: /\/b\/ibils\/projects$/,
    title: 'Projects · Proyek',
  },
  {
    label: 'Features',
    urlPattern: /\/b\/ibils\/features$/,
    title: 'Features / Flows · Fitur / Alur',
  },
  {
    label: 'Decisions',
    urlPattern: /\/b\/ibils\/decisions$/,
    title: 'Decisions · Keputusan',
  },
  // log + board have EN SECTION_TITLE only (no SECTION_TITLE_ID entry)
  { label: 'Log', urlPattern: /\/b\/ibils\/log$/, title: 'Activity log' },
  { label: 'Board', urlPattern: /\/b\/ibils\/?$/, title: 'Board' },
]

function navItem(page: import('@playwright/test').Page, label: string): Locator {
  return page.locator('.sidebar a.nav-item', {
    has: page.locator('.lbl', { hasText: new RegExp(`^${label}$`) }),
  })
}

test('sidebar nav links navigate between sections', async ({ page }) => {
  await page.goto('/b/ibils/')
  await expect(page.locator('.brand-name')).toHaveText('Cairn')

  for (const s of SECTIONS) {
    await navItem(page, s.label).click()
    await expect(page).toHaveURL(s.urlPattern)
    await expect(page.locator('#page-title')).toHaveText(s.title)
    await expect(navItem(page, s.label)).toHaveClass(/active/)
  }
})

test('drilldown: project card -> project detail -> feature -> checklist, with breadcrumbs', async ({
  page,
}) => {
  // 1) Board home -> click a project card, land on its detail page showing the project name.
  await page.goto('/b/ibils/')
  const projectCards = page.locator('a.proj')
  const cardCount = await projectCards.count()
  expect(cardCount, 'expected at least one project card on the board').toBeGreaterThan(0)

  let featureRow: Locator | null = null
  let projectName = ''

  for (let i = 0; i < cardCount; i++) {
    if (i > 0) await page.goto('/b/ibils/')
    const card = page.locator('a.proj').nth(i)
    projectName = (await card.locator('h3').innerText()).trim()

    await card.click()
    await expect(page).toHaveURL(/\/projects\/.+/)

    // Project name shown on the detail page.
    await expect(page.locator('.detail-title h1')).toHaveText(projectName)
    // Breadcrumb: bilingual base + crumb → "Projects · Proyek / <project name>".
    await expect(page.locator('#page-title')).toContainText('Projects · Proyek /')
    await expect(page.locator('#page-title')).toContainText(projectName)

    const rows = page.locator('.feat-row')
    if ((await rows.count()) > 0) {
      featureRow = rows.first()
      break
    }
  }

  expect(featureRow, 'expected at least one project with a feature to drill into').not.toBeNull()

  // 2) From the project, open a feature -> its page shows the feature name + task checklist.
  await featureRow!.click()
  await expect(page).toHaveURL(/\/features\/.+/)

  const featureNameLocator = page.locator('.detail-title h1')
  await expect(featureNameLocator).toBeVisible()
  const featureName = (await featureNameLocator.innerText()).trim()
  expect(featureName.length).toBeGreaterThan(0)

  // Breadcrumb: bilingual base + crumb → "Features / Flows · Fitur / Alur / <feature name>".
  await expect(page.locator('#page-title')).toContainText(
    'Features / Flows · Fitur / Alur /',
  )
  await expect(page.locator('#page-title')).toContainText(featureName)

  // Task checklist card is present.
  const checklistCard = page
    .locator('.card')
    .filter({ has: page.getByRole('heading', { level: 3, name: 'Tasks' }) })
    .first()
  await expect(checklistCard).toBeVisible()

  const checks = checklistCard.locator('.check')
  const checkCount = await checks.count()

  if (checkCount > 0) {
    // Toggle the first task, verify it flips, then toggle it back to restore data/plan.json.
    const first = checks.first()
    const wasDone = ((await first.getAttribute('class')) ?? '').includes('done')

    await first.click()
    if (wasDone) {
      await expect(first).not.toHaveClass(/done/)
    } else {
      await expect(first).toHaveClass(/done/)
    }

    await first.click()
    if (wasDone) {
      await expect(first).toHaveClass(/done/)
    } else {
      await expect(first).not.toHaveClass(/done/)
    }
  } else {
    await expect(checklistCard.locator('.empty')).toHaveText('No tasks listed.')
  }
})
