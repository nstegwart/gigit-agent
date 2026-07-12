import { expect, test } from '@playwright/test'

// Collaboration — CommentThread on a feature detail page.
// Type a comment into the add-comment form and submit; the comment text must
// appear in the thread AND survive a full page reload (the server persisted it
// to data/plan.json). The Verify phase resets data afterwards, so this spec
// does not restore state itself.
//
// A unique per-run marker keeps the assertion index-independent and robust to
// however many comments already exist on the feature — we only ever assert on
// OUR comment, located by its exact text.
const FEATURE_URL = '/b/ibils/features/f3-wa-export'

test('adding a comment renders it in the thread and persists across reload', async ({
  page,
}) => {
  await page.goto(FEATURE_URL)

  // Scope every locator to the Comments card so the form/thread can't collide
  // with other cards (Tasks, Design links, etc.).
  const commentsCard = page.locator('.card', {
    has: page.getByRole('heading', { name: 'Comments' }),
  })
  await expect(commentsCard).toBeVisible()

  const marker = `e2e comment ${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

  const form = commentsCard.locator('.comment-form')
  const input = form.locator('input.field')
  const submit = form.getByRole('button', { name: 'Comment' })

  await expect(input).toBeVisible()
  await input.fill(marker)
  await expect(submit).toBeEnabled()
  await submit.click()

  // The new comment renders in the thread, located by its exact unique text.
  const posted = commentsCard.locator('.comment', { hasText: marker })
  await expect(posted).toHaveCount(1)
  await expect(posted.locator('.c-text')).toHaveText(marker)

  // The input clears after a successful submit.
  await expect(input).toHaveValue('')

  // Persists across a full reload → the server wrote data/plan.json.
  await page.reload()
  const afterReload = page
    .locator('.card', { has: page.getByRole('heading', { name: 'Comments' }) })
    .locator('.comment', { hasText: marker })
  await expect(afterReload).toHaveCount(1)
  await expect(afterReload.locator('.c-text')).toHaveText(marker)
})
