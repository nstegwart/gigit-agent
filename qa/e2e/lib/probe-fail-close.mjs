/**
 * Pure fail-close evaluators for deterministic harness probes (C3-R3H).
 * No browser/MySQL/server. Importable by harness + contract self-tests.
 *
 * Rule: broad substring on legitimate schema/constants is NOT a leak signal.
 * Only exact synthetic canaries + forbidden raw keys fail public redaction.
 */

/** Unique synthetic canaries — plant in private fixture only; must never appear in public snapshot. */
export const REDACTION_CANARIES = Object.freeze({
  decisionBody: 'CANARY_PRIV_DECISION_BODY_r3h_x7k9m2',
  commentText: 'CANARY_PRIV_COMMENT_r3h_p4q8w1',
  accountPassword: 'CANARY_PRIV_ACCT_PASSWORD_r3h_z3n6v0',
  accountToken: 'CANARY_PRIV_ACCT_TOKEN_r3h_tok_live_fake_notreal',
  accountRawIdentity: 'CANARY_PRIV_RAW_ACCOUNT_ID_r3h_acc-full-unmasked-999',
  /** JSON keys that must not appear at any depth in public snapshot payloads. */
  forbiddenKeys: Object.freeze([
    'password',
    'rawPassword',
    'token',
    'accessToken',
    'refreshToken',
    'bearerToken',
    'apiKey',
    'secret',
    'clientSecret',
  ]),
})

/**
 * Collect canary string values (not keys) that must be absent from public body text.
 * @param {typeof REDACTION_CANARIES | Record<string, unknown>} [canaries]
 */
export function listCanaryValues(canaries = REDACTION_CANARIES) {
  return [
    canaries.decisionBody,
    canaries.commentText,
    canaries.accountPassword,
    canaries.accountToken,
    canaries.accountRawIdentity,
  ].filter((v) => typeof v === 'string' && v.length > 0)
}

/**
 * Walk object tree for forbidden key names (case-sensitive property names).
 * @param {unknown} node
 * @param {string[]} forbiddenKeys
 * @param {string} [path]
 * @returns {string[]} paths of hits
 */
export function findForbiddenKeys(node, forbiddenKeys = REDACTION_CANARIES.forbiddenKeys, path = '$') {
  const hits = []
  if (node == null) return hits
  if (Array.isArray(node)) {
    node.forEach((item, i) => hits.push(...findForbiddenKeys(item, forbiddenKeys, `${path}[${i}]`)))
    return hits
  }
  if (typeof node !== 'object') return hits
  for (const [k, v] of Object.entries(node)) {
    if (forbiddenKeys.includes(k)) hits.push(`${path}.${k}`)
    hits.push(...findForbiddenKeys(v, forbiddenKeys, `${path}.${k}`))
  }
  return hits
}

/**
 * @param {{ status?: number, bodyText?: string, body?: unknown, error?: string, canaries?: typeof REDACTION_CANARIES }} input
 */
export function evaluatePublicRedaction(input) {
  const canaries = input.canaries ?? REDACTION_CANARIES
  const canaryValues = listCanaryValues(canaries)
  const failures = []
  if (input.error) {
    failures.push(`public_fetch_error: ${input.error}`)
    return { name: 'publicRedaction', ok: false, failures, canaryHits: [], forbiddenKeyHits: [] }
  }
  const status = input.status
  if (status !== 200) {
    failures.push(`public_status_not_200: ${status}`)
  }
  const bodyText =
    typeof input.bodyText === 'string'
      ? input.bodyText
      : input.body != null
        ? JSON.stringify(input.body)
        : ''
  const canaryHits = canaryValues.filter((c) => bodyText.includes(c))
  if (canaryHits.length) {
    // Never echo full canary into proof stores that might be shared — report index only
    failures.push(
      `public_canary_leak: ${canaryHits.length} canary value(s) present (indices: ${canaryHits
        .map((c) => canaryValues.indexOf(c))
        .join(',')})`,
    )
  }
  let body = input.body
  if (body == null && bodyText) {
    try {
      body = JSON.parse(bodyText)
    } catch {
      body = null
    }
  }
  const forbiddenKeyHits = body != null ? findForbiddenKeys(body, canaries.forbiddenKeys) : []
  if (forbiddenKeyHits.length) {
    failures.push(`public_forbidden_keys: ${forbiddenKeyHits.slice(0, 8).join('; ')}`)
  }
  // Sanitized proof only — no credential material
  return {
    name: 'publicRedaction',
    ok: failures.length === 0,
    failures,
    canaryHits: canaryHits.map((_, i) => `canary[${canaryValues.indexOf(canaryHits[i])}]`),
    forbiddenKeyHits,
    status: status ?? null,
    bodyByteLength: bodyText.length,
  }
}

/**
 * Sticky Decision probe (viewport-container scroll, not window.scrollY alone).
 * DOM-present-but-offscreen MUST fail — require geometry + computed visibility.
 * C3-C9: full containment (eps≤1px) inside BOTH browser viewport and #view visible
 * rect; intersectionRatio ≥ 0.999; no window.scroll nudge when #view scrolls;
 * app summary must stay visible; nearest VISIBLE mission content (not hard-coded
 * priority) must not be covered by >8px.
 * @param {object} input
 */
export function evaluateStickyDecision(input) {
  const failures = []
  const EPS = 1
  const MIN_INTERSECTION = 0.999
  if (!input) {
    return { name: 'stickyDecision', ok: false, failures: ['sticky_missing_input'] }
  }
  if (input.usedWindowScrollYAlone === true) {
    failures.push('sticky_invalid: window.scrollY alone is not a valid sticky proof')
  }
  if (!input.scrollContainerSelector) {
    failures.push('sticky_no_scroll_container')
  }
  if (!input.preScrollShotPath || !input.postScrollShotPath) {
    failures.push('sticky_missing_pre_or_post_screenshot')
  }
  if (!input.decisionCardPresent) {
    failures.push('sticky_decision_card_absent')
  }
  // Optional screenshot dimension contract (390×844 mobile sticky pair)
  if (input.screenshotDims) {
    const { pre, post, expectedWidth, expectedHeight } = input.screenshotDims
    const ew = expectedWidth ?? 390
    const eh = expectedHeight ?? 844
    if (!pre || pre.width !== ew || pre.height !== eh) {
      failures.push(
        `sticky_pre_shot_dims:${pre ? `${pre.width}x${pre.height}` : 'missing'} expected ${ew}x${eh}`,
      )
    }
    if (!post || post.width !== ew || post.height !== eh) {
      failures.push(
        `sticky_post_shot_dims:${post ? `${post.width}x${post.height}` : 'missing'} expected ${ew}x${eh}`,
      )
    }
  }
  // After scroll: full card collapses to one-line pill with count/severity/expand
  if (input.postScroll) {
    const p = input.postScroll
    if (!p.pillPresent) failures.push('sticky_pill_absent_after_scroll')
    if (!p.pillCountPresent) failures.push('sticky_pill_count_absent')
    if (!p.pillSeverityPresent) failures.push('sticky_pill_severity_absent')
    if (!p.pillExpandPresent) failures.push('sticky_pill_expand_absent')
    if (p.cardVisuallyFullHeight === true && p.pillPresent === true) {
      // Soft: card may remain in a11y tree as spacer; fail only if obstruction proven
    }
    if (p.coversNextContent === true) {
      const who = p.nextTestId || p.nearestContentTestId || 'unknown'
      failures.push(`sticky_covers_next_content:${who}`)
    }
    // C3-C10: multi-sample scroll must not obscure content at any sample.
    if (p.multiSampleCoversContent === true) {
      const who = p.nextTestId || p.nearestContentTestId || 'unknown'
      if (!failures.some((f) => f.startsWith('sticky_covers_next_content:'))) {
        failures.push(`sticky_covers_next_content:multi_sample:${who}`)
      }
    }
    if (Array.isArray(input.scrollSamples) && input.scrollSamples.length >= 2) {
      const badSample = input.scrollSamples.find((s) => s && s.coversNextContent === true)
      if (badSample) {
        const who = badSample.nextTestId || 'unknown'
        if (!failures.some((f) => f.startsWith('sticky_covers_next_content:'))) {
          failures.push(
            `sticky_covers_next_content:sample@${badSample.scrollTop ?? '?'}:${who}`,
          )
        }
      }
    } else if (input.requireScrollSamples === true) {
      failures.push('sticky_missing_multi_scroll_samples')
    }
    if (p.overlapsAppBar === true) {
      failures.push('sticky_pill_overlaps_app_bar')
    }
    if (p.appBarVisible === false) {
      failures.push('sticky_app_bar_not_visible')
    }
    if (typeof p.scrollTop === 'number' && p.scrollTop <= 0 && input.requiredScrollTopMin > 0) {
      failures.push(`sticky_scroll_container_not_moved: scrollTop=${p.scrollTop}`)
    }

    // When #view (or .content) is the scroll container, window must not be nudged.
    const sel = String(input.scrollContainerSelector || '')
    const isViewScroll =
      sel === '#view' || sel === '.content' || sel.includes('view') || sel.includes('content')
    if (isViewScroll && typeof p.windowScrollY === 'number' && p.windowScrollY > 1) {
      failures.push(
        `sticky_window_scroll_nudge: windowScrollY=${p.windowScrollY} (must be ≤1 when scrolling ${sel})`,
      )
    }

    // Geometry / visibility — DOM-only presence is insufficient (C3-C7 false positive).
    const b = p.pillBounds
    const c = p.computed
    const vp = p.viewport
    if (p.pillPresent) {
      if (!b) {
        failures.push('sticky_pill_bounds_missing')
      } else {
        const w = Number(b.width) || 0
        const h = Number(b.height) || 0
        if (w < 1 || h < 1 || p.zeroArea === true) {
          failures.push(`sticky_pill_zero_area: ${w}x${h}`)
        }
        const vh = vp && typeof vp.height === 'number' ? vp.height : null
        const vw = vp && typeof vp.width === 'number' ? vp.width : null
        // Full containment in browser viewport (epsilon ≤1px) — partial clip fails.
        if (vh != null && vw != null) {
          if (b.top < -EPS) {
            failures.push(`sticky_pill_clip_top_viewport: top=${b.top}`)
          }
          if (b.left < -EPS) {
            failures.push(`sticky_pill_clip_left_viewport: left=${b.left}`)
          }
          if (b.bottom > vh + EPS) {
            failures.push(
              `sticky_pill_clip_bottom_viewport: bottom=${b.bottom} vh=${vh}`,
            )
          }
          if (b.right > vw + EPS) {
            failures.push(
              `sticky_pill_clip_right_viewport: right=${b.right} vw=${vw}`,
            )
          }
          // Legacy offscreen class (fully outside)
          if (b.bottom <= 0 || b.top >= vh) {
            failures.push(
              `sticky_pill_offscreen_y: top=${b.top} bottom=${b.bottom} vh=${vh}`,
            )
          }
          if (b.right <= 0 || b.left >= vw) {
            failures.push(
              `sticky_pill_offscreen_x: left=${b.left} right=${b.right} vw=${vw}`,
            )
          }
        }
        // Full containment inside the actual #view visible rect when provided.
        const vr = vp && vp.viewRect
        if (vr && typeof vr.top === 'number') {
          if (b.top < vr.top - EPS) {
            failures.push(
              `sticky_pill_clip_top_view: top=${b.top} viewTop=${vr.top}`,
            )
          }
          if (b.left < vr.left - EPS) {
            failures.push(
              `sticky_pill_clip_left_view: left=${b.left} viewLeft=${vr.left}`,
            )
          }
          if (b.bottom > vr.bottom + EPS) {
            failures.push(
              `sticky_pill_clip_bottom_view: bottom=${b.bottom} viewBottom=${vr.bottom}`,
            )
          }
          if (b.right > vr.right + EPS) {
            failures.push(
              `sticky_pill_clip_right_view: right=${b.right} viewRight=${vr.right}`,
            )
          }
          // view itself must not be scrolled out of the browser viewport (window nudge)
          if (typeof vr.top === 'number' && vr.top < -EPS) {
            failures.push(
              `sticky_view_rect_offscreen: viewTop=${vr.top} (window scroll displaced #view)`,
            )
          }
        }
      }
      if (c) {
        if (c.display === 'none') failures.push('sticky_pill_display_none')
        if (c.visibility === 'hidden') failures.push('sticky_pill_visibility_hidden')
        const op = Number(c.opacity)
        if (Number.isFinite(op) && op <= 0.05) {
          failures.push(`sticky_pill_opacity_hidden: ${c.opacity}`)
        }
      } else if (p.pillPresent) {
        failures.push('sticky_pill_computed_missing')
      }
      if (p.visuallyVisible === false) {
        failures.push('sticky_pill_not_visually_in_viewport')
      }
      // Full intersection required (C3-C9): partial 0.945 previously accepted wrongly.
      if (typeof p.intersectionRatio === 'number') {
        if (p.intersectionRatio <= 0) {
          failures.push(`sticky_pill_zero_intersection: ${p.intersectionRatio}`)
        } else if (p.intersectionRatio < MIN_INTERSECTION) {
          failures.push(
            `sticky_pill_partial_intersection: ${p.intersectionRatio} required>=${MIN_INTERSECTION}`,
          )
        }
      } else if (p.pillPresent) {
        failures.push('sticky_pill_intersection_missing')
      }
      // Pill must sit below the app summary when both are visible (not just non-overlap).
      if (
        p.appBarVisible === true &&
        b &&
        typeof p.appBarBottom === 'number' &&
        b.top + EPS < p.appBarBottom
      ) {
        failures.push(
          `sticky_pill_above_app_bar: pillTop=${b.top} appBarBottom=${p.appBarBottom}`,
        )
      }
    }
  } else {
    failures.push('sticky_missing_post_scroll_metrics')
  }
  return {
    name: 'stickyDecision',
    ok: failures.length === 0,
    failures,
    scrollContainerSelector: input.scrollContainerSelector ?? null,
  }
}

/**
 * Raw STALE deep-link probe.
 * @param {object} input
 */
export function evaluateRawStale(input) {
  const failures = []
  if (!input) return { name: 'rawStale', ok: false, failures: ['raw_stale_missing_input'] }
  if (input.navigationUsedRouterSerialize === true) {
    failures.push('raw_stale_used_router_serialization')
  }
  if (!input.literalPath || !String(input.literalPath).includes('stale=1')) {
    failures.push('raw_stale_path_not_literal_stale=1')
  }
  if (!input.authShellOk) failures.push('raw_stale_auth_shell_fail')
  if (!input.workScreenPresent) failures.push('raw_stale_work_screen_absent')
  if (!input.staleActive) failures.push('raw_stale_overlay_not_active')
  if (input.errorBoundaryPresent) failures.push('raw_stale_error_boundary')
  if (input.consoleErrorDuringNav) failures.push('raw_stale_console_error_during_nav')
  return { name: 'rawStale', ok: failures.length === 0, failures, path: input.literalPath ?? null }
}

/**
 * Touch target probe — fail if any visible in-scope control < 44×44.
 * @param {{ total?: number, failing?: number, sampleFail?: Array<{ selector?: string, testid?: string, w?: number, h?: number, text?: string }> }} input
 */
export function evaluateTouch(input) {
  const failures = []
  if (!input) return { name: 'touch', ok: false, failures: ['touch_missing_input'] }
  const failing = Number(input.failing ?? 0)
  if (failing > 0) {
    const samples = (input.sampleFail ?? [])
      .slice(0, 12)
      .map((n) => {
        const id = n.testid ? `[data-testid=${n.testid}]` : n.selector || n.text || '?'
        return `${id}@${n.w}x${n.h}`
      })
      .join(', ')
    failures.push(`touch_below_44: ${failing} control(s) — ${samples}`)
  }
  if ((input.total ?? 0) === 0) {
    failures.push('touch_no_controls_measured')
  }
  return {
    name: 'touch',
    ok: failures.length === 0,
    failures,
    total: input.total ?? 0,
    failing,
  }
}

/**
 * ONGOING zero-click: exact fields visible for seeded run, not only query-string.
 * @param {object} input
 */
export function evaluateOngoingZeroClick(input) {
  const failures = []
  if (!input) return { name: 'ongoingZeroClick', ok: false, failures: ['ongoing_missing_input'] }
  // Query string alone is insufficient
  if (input.hasOngoingQuery === true && input.onlyQueryString === true) {
    failures.push('ongoing_only_query_string_insufficient')
  }
  if (!input.sectionPresent) failures.push('ongoing_section_absent')
  const requiredFields = input.requiredFields ?? [
    'taskId',
    'title',
    'targetGate',
    'agentId',
    'role',
    'model',
    'effort',
    'maskedAccount',
    'startedAge',
    'heartbeatAge',
    'materialProgressAge',
    'evidence',
  ]
  const missing = (input.missingFields ?? []).length
    ? input.missingFields
    : requiredFields.filter((f) => !(input.visibleFields || {})[f])
  if (missing.length) {
    failures.push(`ongoing_missing_fields: ${missing.join(',')}`)
  }
  if (input.seededTaskId && input.foundTaskId && input.seededTaskId !== input.foundTaskId) {
    failures.push(`ongoing_task_mismatch: expected ${input.seededTaskId} got ${input.foundTaskId}`)
  }
  if (input.seededTaskId && !input.foundTaskId) {
    failures.push(`ongoing_seeded_task_not_found: ${input.seededTaskId}`)
  }
  return {
    name: 'ongoingZeroClick',
    ok: failures.length === 0,
    failures,
    foundTaskId: input.foundTaskId ?? null,
  }
}

export function evaluateSessionDenial(denials) {
  const failures = []
  if (!Array.isArray(denials) || denials.length === 0) {
    return { name: 'sessionDenial', ok: false, failures: ['session_denial_empty'] }
  }
  for (const d of denials) {
    if (!d.denied) failures.push(`session_not_denied: ${d.path} → ${d.url}`)
  }
  return { name: 'sessionDenial', ok: failures.length === 0, failures }
}

export function evaluateFocus(focus) {
  const failures = []
  if (!focus?.focusOk) failures.push(`focus_not_visible: ${focus?.focusErr || 'unknown'}`)
  return { name: 'focus', ok: failures.length === 0, failures }
}

export function evaluateReducedMotion(rm) {
  const failures = []
  if (!rm?.matches) failures.push('reduced_motion_not_matched')
  return { name: 'reducedMotion', ok: failures.length === 0, failures }
}

/**
 * Narrow network-failure allowlist (C3-C6 / R4-P4).
 *
 * Evidence (r5a-network-failures.json): 3× net::ERR_ABORTED on same-origin
 * `/_serverFn/<hash>?payload=…` during Work ONGOING navigation. These are
 * TanStack Start server-function requests cancelled by SPA navigation / query
 * invalidation (EXPECTED_ABORT), not application/API failures.
 *
 * HARD BANS — never allowlist:
 * - generic ERR_ABORTED without exact `/_serverFn/<hex>` path
 * - HTTP 4xx/5xx (status-bearing failures)
 * - /api/*, /mcp*, /health*, /public-snapshot*, document/navigation
 * - unknown hosts / cross-origin when page origin is known
 * - non-abort Chrome net errors (CONNECTION_REFUSED, FAILED, TIMED_OUT, …)
 */

/** Chrome abort text emitted by Playwright requestfailed for cancelled fetches. */
export const EXPECTED_ABORT_FAILURE_TEXT = 'net::ERR_ABORTED'

/**
 * TanStack Start server-function path: `/_serverFn/` + ≥16 hex hash.
 * Deliberately narrow — does not match /api, /mcp, static assets, or documents.
 */
export const SERVER_FN_PATH_RE = /^\/_serverFn\/[0-9a-f]{16,}(?:\?|$)/i

/** Path prefixes that must NEVER be treated as expected aborts. */
export const FORBIDDEN_NETWORK_PATH_PREFIXES = Object.freeze([
  '/api/',
  '/api',
  '/mcp',
  '/health',
  '/healthz',
  '/api/healthz',
  '/api/public-snapshot',
  '/public-snapshot',
])

/**
 * Classify a single Playwright requestfailed entry.
 * @param {{ url?: string, failure?: string|null, page?: string, status?: number|null }} entry
 * @returns {{ class: 'EXPECTED_ABORT'|'APP', allowlisted: boolean, reason: string }}
 */
export function classifyNetworkFailure(entry = {}) {
  const failure = String(entry?.failure ?? '')
  const urlRaw = String(entry?.url ?? '')
  const pageRaw = String(entry?.page ?? '')
  const status =
    entry?.status == null || entry?.status === ''
      ? null
      : Number(entry.status)

  if (status != null && Number.isFinite(status) && status >= 400) {
    return {
      class: 'APP',
      allowlisted: false,
      reason: `http_status_${status}`,
    }
  }

  let parsed
  try {
    parsed = urlRaw ? new URL(urlRaw) : null
  } catch {
    return { class: 'APP', allowlisted: false, reason: 'unparseable_url' }
  }
  if (!parsed) {
    return { class: 'APP', allowlisted: false, reason: 'missing_url' }
  }

  const pathOnly = parsed.pathname || '/'

  // Forbidden application / ops surfaces — never allowlist even if aborted.
  if (
    pathOnly === '/api' ||
    pathOnly.startsWith('/api/') ||
    pathOnly === '/mcp' ||
    pathOnly.startsWith('/mcp/') ||
    pathOnly.startsWith('/mcp?') ||
    pathOnly === '/health' ||
    pathOnly === '/healthz' ||
    pathOnly.startsWith('/health/') ||
    pathOnly.startsWith('/healthz/') ||
    pathOnly.includes('public-snapshot')
  ) {
    return { class: 'APP', allowlisted: false, reason: `forbidden_path:${pathOnly}` }
  }

  // Document / top-level navigation failures are always APP.
  const resourceType = entry?.resourceType ?? entry?.resource_type ?? null
  if (resourceType === 'document' || resourceType === 'navigation') {
    return { class: 'APP', allowlisted: false, reason: `resource_type_${resourceType}` }
  }

  // Cross-origin when page is known → APP (unknown host relative to app).
  if (pageRaw) {
    try {
      const pageUrl = new URL(pageRaw)
      if (parsed.origin !== pageUrl.origin) {
        return {
          class: 'APP',
          allowlisted: false,
          reason: `cross_origin:${parsed.origin}`,
        }
      }
    } catch {
      // ignore bad page URL; continue path-based checks
    }
  }

  // Only exact Chrome abort + exact serverFn path is EXPECTED_ABORT.
  const isAbort =
    failure === EXPECTED_ABORT_FAILURE_TEXT || failure === 'ERR_ABORTED'
  if (!isAbort) {
    return {
      class: 'APP',
      allowlisted: false,
      reason: failure ? `failure_text:${failure}` : 'missing_failure_text',
    }
  }

  // Path must be /_serverFn/<hex≥16> (query optional).
  if (!/^\/_serverFn\/[0-9a-f]{16,}$/i.test(pathOnly)) {
    return {
      class: 'APP',
      allowlisted: false,
      reason: `abort_non_serverFn:${pathOnly}`,
    }
  }

  return {
    class: 'EXPECTED_ABORT',
    allowlisted: true,
    reason: 'tanstack_serverFn_spa_abort',
  }
}

/**
 * Partition network failures into app-visible vs allowlisted expected aborts.
 * @param {Array<{ url?: string, failure?: string|null, page?: string }>} networkFailures
 */
export function partitionNetworkFailures(networkFailures = []) {
  const appFailures = []
  const allowlisted = []
  const classifications = []
  for (const entry of networkFailures) {
    const c = classifyNetworkFailure(entry)
    classifications.push({ ...c, url: entry?.url ?? null, failure: entry?.failure ?? null })
    if (c.allowlisted) allowlisted.push(entry)
    else appFailures.push(entry)
  }
  return { appFailures, allowlisted, classifications }
}

export function evaluateConsoleNetwork({ consoleErrors = [], networkFailures = [] } = {}) {
  const failures = []
  // Console noise: favicon + React DevTools only (unchanged).
  const appConsole = consoleErrors.filter((e) => {
    const t = String(e?.text || e || '')
    if (/favicon|Download the React DevTools/i.test(t)) return false
    return true
  })
  if (appConsole.length) failures.push(`console_errors: ${appConsole.length}`)

  const partitioned = partitionNetworkFailures(networkFailures)
  if (partitioned.appFailures.length) {
    failures.push(`network_failures: ${partitioned.appFailures.length}`)
  }
  return {
    name: 'consoleNetwork',
    ok: failures.length === 0,
    failures,
    consoleCount: appConsole.length,
    networkCount: partitioned.appFailures.length,
    networkAllowlistedCount: partitioned.allowlisted.length,
    networkClassifications: partitioned.classifications,
  }
}

export function evaluateOverflow(overflowSummary = []) {
  const failures = []
  const bad = overflowSummary.filter((o) => o.overflow)
  if (bad.length) {
    failures.push(`overflow: ${bad.length} capture(s) — first=${bad[0]?.id}`)
  }
  return { name: 'overflow', ok: failures.length === 0, failures, failCount: bad.length }
}

/**
 * C3-C12: mobile shell + internal element containment at 360/390.
 * Document scrollWidth alone is insufficient (Spark: #view 424px while overflow probe green).
 * Requires shell widths ≤ viewport+eps and representative rects left/right contained.
 *
 * @param {{ rows?: Array<object>, summary?: Array<object> } | Array<object>} input
 */
export function evaluateMobileShellContainment(input) {
  const EPS = 1
  const failures = []
  const rows = Array.isArray(input)
    ? input
    : Array.isArray(input?.rows)
      ? input.rows
      : Array.isArray(input?.summary)
        ? input.summary
        : input
          ? [input]
          : []
  if (!rows.length) {
    return {
      name: 'mobileShellContainment',
      ok: false,
      failures: ['mobile_shell_missing_rows'],
      rowCount: 0,
      failCount: 1,
    }
  }

  const mobileRows = rows.filter((r) => {
    const w = Number(r?.viewportWidth ?? r?.viewport?.width ?? r?.vpWidth ?? 0)
    return w > 0 && w <= 420
  })
  if (!mobileRows.length) {
    return {
      name: 'mobileShellContainment',
      ok: false,
      failures: ['mobile_shell_no_360_390_rows'],
      rowCount: rows.length,
      failCount: 1,
    }
  }

  for (const row of mobileRows) {
    const id = row.id || row.captureId || row.route || 'unknown'
    const vw = Number(row.viewportWidth ?? row.viewport?.width ?? 0)
    if (!(vw > 0)) {
      failures.push(`${id}: missing_viewport_width`)
      continue
    }
    const shells = row.shells || row.shell || {}
    const names = ['html', 'body', 'app', 'main', 'view']
    for (const name of names) {
      const s = shells[name]
      if (!s) {
        failures.push(`${id}: shell_${name}_missing`)
        continue
      }
      const clientW = Number(s.clientWidth ?? s.width ?? NaN)
      const rectW = Number(s.width ?? s.clientWidth ?? NaN)
      const right = s.right != null ? Number(s.right) : null
      const left = s.left != null ? Number(s.left) : null
      if (Number.isFinite(clientW) && clientW > vw + EPS) {
        failures.push(
          `${id}: shell_${name}_clientWidth_${clientW}>viewport_${vw}`,
        )
      }
      if (Number.isFinite(rectW) && rectW > vw + EPS) {
        failures.push(`${id}: shell_${name}_width_${rectW}>viewport_${vw}`)
      }
      if (left != null && Number.isFinite(left) && left < -EPS) {
        failures.push(`${id}: shell_${name}_clip_left: left=${left}`)
      }
      if (right != null && Number.isFinite(right) && right > vw + EPS) {
        failures.push(
          `${id}: shell_${name}_clip_right: right=${right} vw=${vw}`,
        )
      }
    }

    const pageScrollW = Number(
      row.documentScrollWidth ?? shells.html?.scrollWidth ?? shells.body?.scrollWidth ?? NaN,
    )
    const pageClientW = Number(
      row.documentClientWidth ?? shells.html?.clientWidth ?? shells.body?.clientWidth ?? vw,
    )
    if (Number.isFinite(pageScrollW) && pageScrollW > pageClientW + EPS) {
      failures.push(
        `${id}: document_horizontal_scroll: scrollWidth=${pageScrollW} clientWidth=${pageClientW}`,
      )
    }

    const elements = Array.isArray(row.elements) ? row.elements : []
    for (const el of elements) {
      if (!el || el.present === false) continue
      const name = el.name || el.selector || 'element'
      // Intentional horizontal scrollports (nav rail) are allowed if flagged.
      if (el.namedScrollport === true) continue
      const left = Number(el.left)
      const right = Number(el.right)
      if (Number.isFinite(left) && left < -EPS) {
        failures.push(`${id}: element_${name}_clip_left: left=${left}`)
      }
      if (Number.isFinite(right) && right > vw + EPS) {
        failures.push(
          `${id}: element_${name}_clip_right: right=${right} vw=${vw}`,
        )
      }
      // Touch targets still ≥44 when present and measured
      if (el.requireTouch === true) {
        const w = Number(el.width)
        const h = Number(el.height)
        if (Number.isFinite(w) && w + EPS < 44) {
          failures.push(`${id}: element_${name}_touch_w_${w}<44`)
        }
        if (Number.isFinite(h) && h + EPS < 44) {
          failures.push(`${id}: element_${name}_touch_h_${h}<44`)
        }
      }
    }
  }

  return {
    name: 'mobileShellContainment',
    ok: failures.length === 0,
    failures,
    rowCount: mobileRows.length,
    failCount: failures.length,
  }
}

export function evaluateAxe(axeSummary = [], { skipFail = false } = {}) {
  const failures = []
  const bad = axeSummary.filter((a) => !a.ok)
  if (!skipFail && bad.length) {
    failures.push(`axe_critical_serious: ${bad.length} — first=${bad[0]?.id}`)
  }
  return {
    name: 'axe',
    ok: failures.length === 0,
    failures,
    failCount: bad.length,
    skipped: skipFail,
  }
}

/**
 * Aggregate probe + matrix signals into verdicts and fail count.
 * @param {object} bag
 */
export function aggregateProbeVerdicts(bag = {}) {
  const verdicts = []
  if (bag.publicRedaction != null) {
    verdicts.push(
      bag.publicRedaction.name
        ? bag.publicRedaction
        : evaluatePublicRedaction(bag.publicRedaction),
    )
  }
  if (bag.stickyDecision != null) {
    verdicts.push(
      bag.stickyDecision.name ? bag.stickyDecision : evaluateStickyDecision(bag.stickyDecision),
    )
  }
  if (bag.rawStale != null) {
    verdicts.push(bag.rawStale.name ? bag.rawStale : evaluateRawStale(bag.rawStale))
  }
  if (bag.touch != null) {
    verdicts.push(bag.touch.name ? bag.touch : evaluateTouch(bag.touch))
  }
  if (bag.ongoingZeroClick != null) {
    verdicts.push(
      bag.ongoingZeroClick.name
        ? bag.ongoingZeroClick
        : evaluateOngoingZeroClick(bag.ongoingZeroClick),
    )
  }
  if (bag.sessionDenial != null) {
    verdicts.push(
      Array.isArray(bag.sessionDenial)
        ? evaluateSessionDenial(bag.sessionDenial)
        : bag.sessionDenial.name
          ? bag.sessionDenial
          : evaluateSessionDenial(bag.sessionDenial.denials ?? bag.sessionDenial),
    )
  }
  if (bag.focus != null) {
    verdicts.push(bag.focus.name ? bag.focus : evaluateFocus(bag.focus))
  }
  if (bag.reducedMotion != null) {
    verdicts.push(
      bag.reducedMotion.name ? bag.reducedMotion : evaluateReducedMotion(bag.reducedMotion),
    )
  }
  if (bag.consoleErrors != null || bag.networkFailures != null) {
    verdicts.push(
      evaluateConsoleNetwork({
        consoleErrors: bag.consoleErrors ?? [],
        networkFailures: bag.networkFailures ?? [],
      }),
    )
  }
  if (bag.overflowSummary != null) {
    verdicts.push(evaluateOverflow(bag.overflowSummary))
  }
  if (bag.mobileShellSummary != null || bag.mobileShellContainment != null) {
    const shellInput = bag.mobileShellContainment ?? bag.mobileShellSummary
    verdicts.push(
      shellInput?.name
        ? shellInput
        : evaluateMobileShellContainment(shellInput),
    )
  }
  if (bag.axeSummary != null) {
    verdicts.push(evaluateAxe(bag.axeSummary, { skipFail: bag.skipAxeFail === true }))
  }

  const failCount = verdicts.filter((v) => !v.ok).length
  const failureMessages = verdicts.flatMap((v) =>
    (v.failures || []).map((f) => `${v.name}: ${f}`),
  )
  return {
    verdicts,
    failCount,
    failureMessages,
    ok: failCount === 0,
    summaryLines: verdicts.map((v) => `${v.ok ? 'PASS' : 'FAIL'} probe ${v.name}`),
  }
}

/**
 * Throw if aggregate not ok — used by harness after probes.
 * @param {ReturnType<typeof aggregateProbeVerdicts>} agg
 */
export function assertProbesFailClosed(agg) {
  if (agg.ok) return
  const first = agg.failureMessages[0] || 'unknown'
  throw new Error(
    `HARNESS FAIL: ${agg.failCount} probe verdict(s) failed. First: ${first}`,
  )
}
