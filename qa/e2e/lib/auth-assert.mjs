/**
 * Deterministic authenticated-shell assertions for protected captures.
 * Fail-closed: login form, setup form, wrong board, missing OWNER chrome → throw.
 *
 * Auth/setup detection is STRUCTURAL (`.auth-card`, `h1.auth-title`, auth form
 * controls) — never scans arbitrary body prose for "bootstrap" (Evidence/Log
 * fixtures legitimately contain that word).
 */

/**
 * Pure structural probe (mirrors page DOM signals; no browser).
 * Used by self-tests / contract harness.
 *
 * @param {{
 *   hasAuthCard?: boolean,
 *   hasAuthPage?: boolean,
 *   hasAuthForm?: boolean,
 *   hasUsernameInput?: boolean,
 *   authTitle?: string | null,
 *   bodyText?: string | null,
 *   hasSidebar?: boolean,
 *   brand?: string | null,
 * }} dom
 */
export function probeAuthDomSignals(dom = {}) {
  const authTitle = (dom.authTitle || '').trim()
  const loginForm = !!(
    dom.hasAuthCard ||
    dom.hasAuthPage ||
    dom.hasAuthForm ||
    dom.hasUsernameInput
  )
  // Setup UI = real auth card title only. Body prose ("bootstrap") is ignored.
  const setupCopy = !!(
    (dom.hasAuthCard || dom.hasAuthPage) &&
    /create (the )?first admin/i.test(authTitle)
  )
  return {
    loginForm,
    setupCopy,
    brand: dom.brand ?? null,
    sidebar: !!dom.hasSidebar,
    // bodyText accepted for diagnostics only — never used for pass/fail
    bodyTextLen: (dom.bodyText || '').length,
  }
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {{ boardId: string, allowLogin?: boolean }} opts
 */
export async function assertAuthenticatedOwnerShell(page, opts) {
  const boardId = opts.boardId
  if (!boardId) throw new Error('assertAuthenticatedOwnerShell: boardId required')

  const url = page.url()
  const pathname = new URL(url).pathname

  if (!opts.allowLogin) {
    if (pathname.startsWith('/login') || pathname.startsWith('/setup')) {
      throw new Error(
        `AUTH_ASSERT FAIL: protected capture landed on auth surface url=${url}`,
      )
    }
  }

  const probe = await page.evaluate(() => {
    const authCard = document.querySelector('.auth-card')
    const authPage = document.querySelector('.auth-page')
    const authForm = document.querySelector('form.auth-form')
    const usernameInput = document.querySelector('input[autocomplete="username"]')
    // Title only from structural auth surface — never document.body prose
    const authTitleEl =
      (authCard && authCard.querySelector('h1.auth-title')) ||
      document.querySelector('.auth-page h1.auth-title') ||
      null
    const authTitle = authTitleEl?.textContent?.trim() || ''

    const loginForm = !!(authCard || authPage || authForm || usernameInput)
    // Real setup: "Create the first admin" on h1.auth-title inside auth surface.
    // Do NOT match bare "bootstrap" / "create the first" in Evidence/Log body.
    const setupCopy = !!(
      (authCard || authPage) &&
      /create (the )?first admin/i.test(authTitle)
    )

    const brand = document.querySelector('.brand-name')?.textContent?.trim() || null
    const sidebar = !!document.querySelector('.sidebar')
    const navLabels = [...document.querySelectorAll('.sidebar a.nav-item .lbl')].map((n) =>
      (n.textContent || '').trim(),
    )
    const bodySnippet = (document.body?.innerText || '').slice(0, 200)
    return { loginForm, setupCopy, brand, sidebar, navLabels, bodySnippet, authTitle }
  })

  if (!opts.allowLogin && (probe.loginForm || probe.setupCopy)) {
    throw new Error(
      `AUTH_ASSERT FAIL: login/setup form present on protected surface url=${url} loginForm=${probe.loginForm} setupCopy=${probe.setupCopy}`,
    )
  }

  if (!opts.allowLogin) {
    if (!probe.sidebar) {
      throw new Error(`AUTH_ASSERT FAIL: OWNER sidebar missing url=${url}`)
    }
    if (!probe.brand) {
      throw new Error(`AUTH_ASSERT FAIL: brand-name missing (not OWNER shell) url=${url}`)
    }
    // Board id must appear in URL path for board routes
    if (pathname.startsWith('/b/') && !pathname.includes(`/b/${boardId}`)) {
      throw new Error(
        `AUTH_ASSERT FAIL: boardId mismatch expected=${boardId} url=${url}`,
      )
    }
  }

  return {
    url,
    pathname,
    boardId,
    brand: probe.brand,
    sidebar: probe.sidebar,
    navLabels: probe.navLabels,
    ok: true,
  }
}

/**
 * Pure classifier used by self-tests (no browser).
 * Structural setup is `hasSetupUi` (auth card title). Body "bootstrap" prose is
 * intentionally not an input that can fail classification.
 *
 * @param {{
 *   url: string,
 *   hasLoginForm: boolean,
 *   hasSidebar: boolean,
 *   hasBrand: boolean,
 *   boardId: string,
 *   hasSetupUi?: boolean,
 * }} s
 */
export function classifyAuthSurface(s) {
  try {
    const pathname = new URL(s.url, 'http://127.0.0.1').pathname
    if (pathname.startsWith('/login') || pathname.startsWith('/setup')) {
      return { ok: false, reason: 'auth_route' }
    }
    if (s.hasLoginForm) return { ok: false, reason: 'login_form' }
    if (s.hasSetupUi) return { ok: false, reason: 'setup_ui' }
    if (!s.hasSidebar) return { ok: false, reason: 'no_sidebar' }
    if (!s.hasBrand) return { ok: false, reason: 'no_brand' }
    if (pathname.startsWith('/b/') && s.boardId && !pathname.includes(`/b/${s.boardId}`)) {
      return { ok: false, reason: 'board_mismatch' }
    }
    return { ok: true, reason: 'authenticated_owner_shell' }
  } catch (e) {
    return { ok: false, reason: `url_parse:${String(e?.message || e)}` }
  }
}
