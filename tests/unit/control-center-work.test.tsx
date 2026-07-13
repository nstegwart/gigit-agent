/**
 * C3-F3 Work components — unit / jsdom binding tests.
 * Status support evidence only (LOCAL ONLY); no visual pair / route wiring.
 */
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, within } from '@testing-library/react'
import {
  WorkScreen,
  BucketTabs,
  StaleOverlayFilter,
  WorkRow,
  parseWorkDeepLink,
  encodeWorkDeepLink,
  workDeepLinkPath,
  isPrimaryBucket,
  WORK_PRIMARY_BUCKETS,
  formatAgeSeconds,
  STALE_FAMILY_OVERLAYS,
  type WorkItemRow,
  type WorkPageState,
  type WorkScreenProps,
  type PinnedRevisionTuple,
} from '#/components/control-center/work'

const PIN: PinnedRevisionTuple = {
  canonicalSnapshotId: 'snap-1',
  canonicalHash: 'abcdef0123456789',
  taskHash: 'taskhash99',
  boardRev: 12,
  lifecycleRev: 4,
}

const PAGE: WorkPageState = {
  cursor: null,
  nextCursor: 'opaque-next',
  pageSize: 50,
  totalCount: 3,
  pageIndex: 1,
  hasMore: true,
  hasPrev: false,
}

function row(partial: Partial<WorkItemRow> & Pick<WorkItemRow, 'taskId' | 'title' | 'bucket'>): WorkItemRow {
  return {
    overlays: [],
    ...partial,
  }
}

function baseProps(over: Partial<WorkScreenProps> = {}): WorkScreenProps {
  return {
    state: 'populated',
    boardId: 'mfs-rebuild',
    activeBucket: 'ONGOING',
    bucketCounts: {
      DONE: 2,
      RECONCILIATION_PENDING: 1,
      ONGOING: 3,
      NEXT: 1,
      QUEUED: 4,
      BLOCKED: 0,
    },
    staleOverlayActive: false,
    staleSummary: { total: 2 },
    items: [
      row({
        taskId: 't-ongoing-1',
        title: 'Wire list_work_items',
        bucket: 'ONGOING',
        overlays: [],
        ongoing: {
          targetGate: 'BUILT',
          agentId: 'agent-a',
          role: 'implementer',
          model: 'grok',
          effort: 'high',
          maskedAccount: 'a***@x.ai',
          startedAgeSeconds: 3600,
          heartbeatAgeSeconds: 30,
          materialProgressAgeSeconds: 120,
          liveness: 'PRODUCTIVE',
          evidenceLink: '/evidence/e1',
        },
        lifecycleStage: 'BUILT',
        readinessDisplay: '42%',
      }),
    ],
    page: PAGE,
    pinned: PIN,
    ...over,
  }
}

describe('WORK_PRIMARY_BUCKETS', () => {
  it('has exactly six exclusive primary buckets; STALE is not among them', () => {
    expect([...WORK_PRIMARY_BUCKETS]).toEqual([
      'DONE',
      'RECONCILIATION_PENDING',
      'ONGOING',
      'NEXT',
      'QUEUED',
      'BLOCKED',
    ])
    expect(WORK_PRIMARY_BUCKETS).not.toContain('STALE')
    expect(isPrimaryBucket('STALE')).toBe(false)
    expect(isPrimaryBucket('ONGOING')).toBe(true)
  })

  it('STALE_FAMILY_OVERLAYS covers architecture stale kinds without primary bucket names', () => {
    expect(STALE_FAMILY_OVERLAYS).toContain('STALE_CLAIM')
    expect(STALE_FAMILY_OVERLAYS).toContain('STALE_DATA_SOURCE')
    expect(STALE_FAMILY_OVERLAYS as ReadonlyArray<string>).not.toContain('DONE')
  })
})

describe('deep-link helpers', () => {
  it('parseWorkDeepLink reads boardId, bucket, stale, cursor, pin', () => {
    const f = parseWorkDeepLink('mfs-rebuild', {
      bucket: 'NEXT',
      stale: '1',
      cursor: 'c1',
      boardRev: '12',
      lifecycleRev: '4',
      canonicalSnapshotId: 'snap-1',
      canonicalHash: 'abcdef0123456789',
      taskHash: 'taskhash99',
    })
    expect(f.boardId).toBe('mfs-rebuild')
    expect(f.bucket).toBe('NEXT')
    expect(f.staleOverlay).toBe(true)
    expect(f.cursor).toBe('c1')
    expect(f.pinned).toEqual(PIN)
  })

  it('encode + path round-trips filter state without inventing bucket', () => {
    const encoded = encodeWorkDeepLink({
      boardId: 'mfs-rebuild',
      bucket: 'BLOCKED',
      staleOverlay: true,
      overlayKind: 'STALE_CLAIM',
      cursor: 'abc',
      pinned: PIN,
    })
    expect(encoded.bucket).toBe('BLOCKED')
    expect(encoded.stale).toBe('1')
    expect(encoded.overlay).toBe('STALE_CLAIM')
    expect(encoded.cursor).toBe('abc')
    expect(workDeepLinkPath({
      boardId: 'mfs-rebuild',
      bucket: 'QUEUED',
      staleOverlay: false,
      cursor: null,
      pinned: null,
    })).toBe('/b/mfs-rebuild/work?bucket=QUEUED')
  })

  it('invalid bucket falls back to default ONGOING', () => {
    const f = parseWorkDeepLink('b1', { bucket: 'NOT_A_BUCKET' })
    expect(f.bucket).toBe('ONGOING')
  })
})

describe('formatAgeSeconds', () => {
  it('formats relative ages for display only', () => {
    expect(formatAgeSeconds(45)).toBe('45s')
    expect(formatAgeSeconds(120)).toBe('2m')
    expect(formatAgeSeconds(3660)).toBe('1h 1m')
    expect(formatAgeSeconds(null)).toBe('')
  })
})

describe('BucketTabs', () => {
  it('renders six tabs and notifies exclusive selection', () => {
    const onChange = vi.fn()
    render(
      <BucketTabs
        activeBucket="DONE"
        counts={{
          DONE: 1,
          RECONCILIATION_PENDING: 0,
          ONGOING: 0,
          NEXT: 0,
          QUEUED: 0,
          BLOCKED: 0,
        }}
        onChange={onChange}
      />,
    )
    const tabs = screen.getAllByRole('tab')
    expect(tabs).toHaveLength(6)
    expect(screen.getByTestId('work-tab-DONE').getAttribute('aria-selected')).toBe('true')
    fireEvent.click(screen.getByTestId('work-tab-NEXT'))
    expect(onChange).toHaveBeenCalledWith('NEXT')
  })

  it('supports keyboard arrow navigation across exclusive tabs', () => {
    const onChange = vi.fn()
    render(<BucketTabs activeBucket="DONE" onChange={onChange} />)
    const done = screen.getByTestId('work-tab-DONE')
    fireEvent.keyDown(done, { key: 'ArrowRight' })
    expect(onChange).toHaveBeenCalledWith('RECONCILIATION_PENDING')
    fireEvent.keyDown(done, { key: 'End' })
    expect(onChange).toHaveBeenCalledWith('BLOCKED')
  })

  it('sanitizes idPrefix so aria-controls IDREFs are valid tokens', () => {
    render(<BucketTabs activeBucket="ONGOING" idPrefix=":r1:" />)
    const tab = screen.getByTestId('work-tab-ONGOING')
    const controls = tab.getAttribute('aria-controls')
    expect(controls).toBeTruthy()
    expect(controls).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(controls).not.toMatch(/:/)
  })
})

describe('WorkScreen tab/panel relationship', () => {
  it('always mounts tabpanel matching active tab aria-controls', () => {
    render(<WorkScreen {...baseProps({ state: 'empty', items: [] })} />)
    const panel = screen.getByTestId('work-tabpanel')
    expect(panel.getAttribute('role')).toBe('tabpanel')
    const selected = screen.getByTestId('work-tab-ONGOING')
    expect(selected.getAttribute('aria-controls')).toBe(panel.id)
    expect(panel.getAttribute('aria-labelledby')).toBe(selected.id)
  })
})

describe('StaleOverlayFilter', () => {
  it('is a switch chip, not a primary tab', () => {
    const onChange = vi.fn()
    render(<StaleOverlayFilter active={false} summary={{ total: 5 }} onChange={onChange} />)
    const chip = screen.getByTestId('work-stale-overlay')
    expect(chip.getAttribute('role')).toBe('switch')
    expect(chip.getAttribute('aria-checked')).toBe('false')
    expect(chip.tagName).not.toBe('TAB')
    fireEvent.click(chip)
    expect(onChange).toHaveBeenCalledWith(true)
  })
})

describe('WorkRow display rules', () => {
  it('renders server bucket and never invents a different primary', () => {
    render(
      <table>
        <tbody>
          <WorkRow
            item={row({
              taskId: 't1',
              title: 'Done with lingering claim',
              bucket: 'DONE',
              overlays: ['STALE_CLAIM', 'RECONCILIATION_DRILLDOWN'],
              reconciliation: {
                runId: 'run-9',
                claimId: 'claim-2',
                claimState: 'STALE',
                lockId: 'lock-1',
                action: 'RECLAIM',
                dryRun: true,
                ageSeconds: 900,
                ownerAgentId: 'agent-z',
              },
            })}
          />
        </tbody>
      </table>,
    )
    const badge = screen.getByTestId('work-row-bucket')
    expect(badge.getAttribute('data-bucket')).toBe('DONE')
    expect(screen.getByTestId('work-row-overlays').querySelectorAll('[data-overlay]')).toHaveLength(2)
    const recon = screen.getByTestId('work-row-reconciliation')
    expect(recon.textContent).toContain('run-9')
    expect(recon.textContent).toContain('RECLAIM')
    expect(recon.textContent).toContain('dry-run')
    expect(recon.textContent).toContain('agent-z')
  })

  it('RECONCILIATION_PENDING exposes run/claim/lock/action/age/owner', () => {
    render(
      <table>
        <tbody>
          <WorkRow
            item={row({
              taskId: 't-rp',
              title: 'Orphan claim',
              bucket: 'RECONCILIATION_PENDING',
              overlays: ['RECONCILIATION_DRILLDOWN'],
              reconciliation: {
                runId: 'r1',
                claimId: 'c1',
                lockId: 'l1',
                lockOwner: 'owner-x',
                action: 'RELEASE',
                dryRun: false,
                age: '12m',
                ownerAgentId: 'a1',
                ownerRole: 'verifier',
                ownerMaskedAccount: 'm***',
              },
            })}
          />
        </tbody>
      </table>,
    )
    const recon = screen.getByTestId('work-row-reconciliation')
    expect(recon.textContent).toMatch(/r1/)
    expect(recon.textContent).toMatch(/c1/)
    expect(recon.textContent).toMatch(/l1/)
    expect(recon.textContent).toMatch(/RELEASE/)
    expect(recon.textContent).toMatch(/\(live\)/)
    expect(recon.textContent).toMatch(/12m/)
    expect(recon.textContent).toMatch(/a1/)
  })

  it('ONGOING zero-click shows gate/agent/liveness without detail navigation', () => {
    render(
      <table>
        <tbody>
          <WorkRow
            item={row({
              taskId: 't-on',
              title: 'Running',
              bucket: 'ONGOING',
              ongoing: {
                targetGate: 'FUNCTIONAL',
                agentId: 'ag-1',
                role: 'builder',
                model: 'claude',
                effort: 'medium',
                maskedAccount: 'x***',
                liveness: 'STALLED',
                heartbeatAgeSeconds: 600,
                evidenceLink: '/e/2',
              },
            })}
          />
        </tbody>
      </table>,
    )
    const block = screen.getByTestId('work-row-ongoing')
    expect(block.textContent).toContain('FUNCTIONAL')
    expect(block.textContent).toContain('ag-1')
    expect(block.textContent).toContain('Stalled')
    expect(screen.getByTestId('work-row-evidence').getAttribute('href')).toBe('/e/2')
  })

  it('displays server blockReason + reason text only', () => {
    render(
      <table>
        <tbody>
          <WorkRow
            item={row({
              taskId: 't-b',
              title: 'Blocked row',
              bucket: 'BLOCKED',
              blockReason: 'HARD_BLOCKER',
              reason: 'waiting on provider',
            })}
          />
        </tbody>
      </table>,
    )
    expect(screen.getByTestId('work-row-reason').textContent).toBe(
      'HARD_BLOCKER · waiting on provider',
    )
  })
})

describe('WorkScreen states (UI_CONTRACT §5)', () => {
  const states: Array<WorkScreenProps['state']> = [
    'populated',
    'loading',
    'empty',
    'zero-results',
    'partial',
    'stale',
    'disconnected',
    'error',
    'forbidden',
    'needs-human',
  ]

  it.each(states)('renders state=%s surface marker', (state) => {
    const props = baseProps({
      state,
      items: state === 'populated' || state === 'partial' || state === 'stale' || state === 'needs-human'
        ? baseProps().items
        : [],
      error:
        state === 'error' || state === 'forbidden'
          ? { code: 'FORBIDDEN', message: 'no access', field: 'filters.cursor', retryable: true }
          : null,
      partialMessage: state === 'partial' ? 'section X failed' : null,
      envelopeStale: state === 'stale',
      envelopeStaleReason: state === 'stale' ? 'STALE_REVISION' : null,
      needsHumanMessage: state === 'needs-human' ? 'Decide on D-1' : null,
    })
    render(<WorkScreen {...props} />)
    expect(screen.getByTestId('work-screen').getAttribute('data-state')).toBe(state)

    if (state === 'loading') expect(screen.getByTestId('work-state-loading')).toBeTruthy()
    if (state === 'empty') expect(screen.getByTestId('work-state-empty')).toBeTruthy()
    if (state === 'zero-results') expect(screen.getByTestId('work-state-zero-results')).toBeTruthy()
    if (state === 'partial') expect(screen.getByTestId('work-state-partial')).toBeTruthy()
    if (state === 'stale') expect(screen.getByTestId('work-state-stale')).toBeTruthy()
    if (state === 'disconnected') expect(screen.getByTestId('work-state-disconnected')).toBeTruthy()
    if (state === 'error') {
      expect(screen.getByTestId('work-state-error')).toBeTruthy()
      expect(screen.getByTestId('work-field-error').textContent).toContain('filters.cursor')
    }
    if (state === 'forbidden') expect(screen.getByTestId('work-state-forbidden')).toBeTruthy()
    if (state === 'needs-human') expect(screen.getByTestId('work-state-needs-human')).toBeTruthy()
  })

  it('populated shows pinned revision, pagination cursor state, dual reflow trees', () => {
    render(<WorkScreen {...baseProps()} />)
    const pin = screen.getByTestId('work-pinned-revision')
    expect(pin.textContent).toMatch(/b12\/L4/)
    const pag = screen.getByTestId('work-pagination')
    expect(pag.getAttribute('data-page-size')).toBe('50')
    expect(pag.getAttribute('data-next-cursor')).toBe('opaque-next')
    expect(screen.getByTestId('work-list').getAttribute('data-reflow-breakpoint')).toBe('768')
    expect(screen.getByTestId('work-table')).toBeTruthy()
    expect(screen.getByTestId('work-card-list')).toBeTruthy()
    // same task appears as table row + card (dual presentation)
    expect(screen.getAllByTestId('work-row-t-ongoing-1')).toHaveLength(2)
  })

  it('wires bucket / stale / page callbacks without client reclassification', () => {
    const onBucketChange = vi.fn()
    const onStaleOverlayChange = vi.fn()
    const onNextPage = vi.fn()
    const onRowActivate = vi.fn()
    render(
      <WorkScreen
        {...baseProps()}
        onBucketChange={onBucketChange}
        onStaleOverlayChange={onStaleOverlayChange}
        onNextPage={onNextPage}
        onRowActivate={onRowActivate}
      />,
    )
    fireEvent.click(screen.getByTestId('work-tab-QUEUED'))
    expect(onBucketChange).toHaveBeenCalledWith('QUEUED')
    fireEvent.click(screen.getByTestId('work-stale-overlay'))
    expect(onStaleOverlayChange).toHaveBeenCalledWith(true)
    fireEvent.click(screen.getByTestId('work-page-next'))
    expect(onNextPage).toHaveBeenCalled()
    // activate first of dual rows
    fireEvent.click(screen.getAllByTestId('work-row-t-ongoing-1')[0]!)
    expect(onRowActivate).toHaveBeenCalled()
    expect(onRowActivate.mock.calls[0]![0].bucket).toBe('ONGOING')
  })

  it('loading does not render list or fake counts from items', () => {
    render(<WorkScreen {...baseProps({ state: 'loading', items: baseProps().items })} />)
    expect(screen.queryByTestId('work-list')).toBeNull()
    expect(screen.getByTestId('work-state-loading')).toBeTruthy()
    // tabs still show server counts when provided
    const done = screen.getByTestId('work-tab-DONE')
    expect(within(done).getByLabelText('2 items')).toBeTruthy()
  })
})

describe('no client readiness / bucket compute surface', () => {
  it('Work package exports do not include assignBucket or rowReadiness', async () => {
    const mod = await import('#/components/control-center/work')
    const keys = Object.keys(mod)
    expect(keys).not.toContain('assignBucket')
    expect(keys).not.toContain('rowReadiness')
    expect(keys).not.toContain('computeRollupV3')
    expect(keys).toContain('WorkScreen')
    expect(keys).toContain('parseWorkDeepLink')
  })
})
