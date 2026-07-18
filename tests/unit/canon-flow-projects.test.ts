/**
 * Exhaustive unit tests for the pure canon flow project identity map.
 * Covers: table integrity, round-trip serialize↔normalize, MCP aliases,
 * cross mode, unknown rejection, and alias collision detection.
 */
import { describe, expect, it } from 'vitest'

import {
  CANON_APP_FLOW_IDS,
  CANON_COLOR_TOKEN_NAMES,
  CANON_CROSS_MODE,
  CANON_FLOW_MODE_IDS,
  CANON_FLOW_PROJECTS,
  CANON_PLATFORM_KEYS,
  CANON_UI_PROJECT_IDS,
  CanonProjectMapError,
  assertNoAliasCollisions,
  getCanonFlowProject,
  isCanonAppFlowId,
  isCanonColorTokenName,
  isCanonFlowModeId,
  isCanonPlatformKey,
  isCanonUiProjectId,
  listMcpAliases,
  listRegisteredAliasKeys,
  normalizeAliasKey,
  normalizeCanonProjectId,
  requireCanonFlowMode,
  requireCanonProjectId,
  serializeCanonFlowMode,
  serializeCanonProject,
  toAppFlowId,
  toColorCssVar,
  toColorToken,
  toLabelId,
  toPlatformKey,
  toUiId,
  uiIdFromAppFlowId,
  uiIdFromPlatformKey,
  type CanonSerializeForm,
  type CanonUiProjectId,
} from '#/lib/canon-flow-projects'

const SERIALIZE_FORMS: readonly CanonSerializeForm[] = [
  'ui',
  'appFlow',
  'platform',
  'colorToken',
  'labelId',
] as const

/** Expected fixed mapping (oracle for this module). */
const EXPECTED: ReadonlyArray<{
  uiId: CanonUiProjectId
  appFlowId: string
  platformKey: string
  labelId: string
  colorToken: string
}> = [
  {
    uiId: 'rn',
    appFlowId: 'rn',
    platformKey: 'rn',
    labelId: 'React Native',
    colorToken: '--proj-rn',
  },
  {
    uiId: 'web-member',
    appFlowId: 'web',
    platformKey: 'web',
    labelId: 'Web Member',
    colorToken: '--proj-web',
  },
  {
    uiId: 'panel-sales',
    appFlowId: 'sales',
    platformKey: 'admin',
    labelId: 'Panel Sales',
    colorToken: '--proj-sales',
  },
  {
    uiId: 'affiliate',
    appFlowId: 'affiliate',
    platformKey: 'affiliate',
    labelId: 'Afiliasi',
    colorToken: '--proj-affiliate',
  },
  {
    uiId: 'backend',
    appFlowId: 'backend',
    platformKey: 'backend',
    labelId: 'Backend',
    colorToken: '--proj-backend',
  },
]

describe('canon-flow-projects: table integrity', () => {
  it('exposes exactly five projects in stable UI order', () => {
    expect(CANON_UI_PROJECT_IDS).toEqual([
      'rn',
      'web-member',
      'panel-sales',
      'affiliate',
      'backend',
    ])
    expect(CANON_FLOW_PROJECTS.map((p) => p.uiId)).toEqual([
      ...CANON_UI_PROJECT_IDS,
    ])
    expect(CANON_FLOW_PROJECTS).toHaveLength(5)
  })

  it('app-flow ids match data/app-flow file project_ids', () => {
    expect(CANON_APP_FLOW_IDS).toEqual([
      'rn',
      'web',
      'sales',
      'affiliate',
      'backend',
    ])
  })

  it('platform keys are rn/web/admin/affiliate/backend', () => {
    expect(CANON_PLATFORM_KEYS).toEqual([
      'rn',
      'web',
      'admin',
      'affiliate',
      'backend',
    ])
  })

  it('flow modes = cross + five projects', () => {
    expect(CANON_FLOW_MODE_IDS).toEqual([
      'cross',
      'rn',
      'web-member',
      'panel-sales',
      'affiliate',
      'backend',
    ])
  })

  it('color token names match flow-ultimate CSS custom properties', () => {
    expect(CANON_COLOR_TOKEN_NAMES).toEqual([
      '--proj-rn',
      '--proj-web',
      '--proj-sales',
      '--proj-affiliate',
      '--proj-backend',
    ])
  })

  it('each project row matches the fixed identity oracle', () => {
    for (const exp of EXPECTED) {
      const p = getCanonFlowProject(exp.uiId)
      expect(p.uiId).toBe(exp.uiId)
      expect(p.appFlowId).toBe(exp.appFlowId)
      expect(p.platformKey).toBe(exp.platformKey)
      expect(p.labelId).toBe(exp.labelId)
      expect(p.colorToken).toBe(exp.colorToken)
    }
  })

  it('cross mode has id-ID label Lintas Proyek', () => {
    expect(CANON_CROSS_MODE.modeId).toBe('cross')
    expect(CANON_CROSS_MODE.labelId).toBe('Lintas Proyek')
  })

  it('ui / app-flow / platform sets are each unique and length 5', () => {
    expect(new Set(CANON_UI_PROJECT_IDS).size).toBe(5)
    expect(new Set(CANON_APP_FLOW_IDS).size).toBe(5)
    expect(new Set(CANON_PLATFORM_KEYS).size).toBe(5)
    expect(new Set(CANON_COLOR_TOKEN_NAMES).size).toBe(5)
  })
})

describe('canon-flow-projects: type guards', () => {
  it('isCanonUiProjectId accepts only UI ids', () => {
    for (const id of CANON_UI_PROJECT_IDS) {
      expect(isCanonUiProjectId(id)).toBe(true)
    }
    expect(isCanonUiProjectId('web')).toBe(false)
    expect(isCanonUiProjectId('sales')).toBe(false)
    expect(isCanonUiProjectId('admin')).toBe(false)
    expect(isCanonUiProjectId('cross')).toBe(false)
    expect(isCanonUiProjectId('')).toBe(false)
    expect(isCanonUiProjectId(null)).toBe(false)
  })

  it('isCanonAppFlowId / isCanonPlatformKey distinguish id spaces', () => {
    expect(isCanonAppFlowId('web')).toBe(true)
    expect(isCanonAppFlowId('web-member')).toBe(false)
    expect(isCanonPlatformKey('admin')).toBe(true)
    expect(isCanonPlatformKey('panel-sales')).toBe(false)
    expect(isCanonPlatformKey('sales')).toBe(false)
  })

  it('isCanonFlowModeId includes cross', () => {
    expect(isCanonFlowModeId('cross')).toBe(true)
    expect(isCanonFlowModeId('rn')).toBe(true)
    expect(isCanonFlowModeId('web')).toBe(false)
  })

  it('isCanonColorTokenName is exact', () => {
    expect(isCanonColorTokenName('--proj-rn')).toBe(true)
    expect(isCanonColorTokenName('var(--proj-rn)')).toBe(false)
    expect(isCanonColorTokenName('proj-rn')).toBe(false)
  })
})

describe('canon-flow-projects: serialize helpers', () => {
  it('to* helpers match the oracle for every project', () => {
    for (const exp of EXPECTED) {
      expect(toUiId(exp.uiId)).toBe(exp.uiId)
      expect(toAppFlowId(exp.uiId)).toBe(exp.appFlowId)
      expect(toPlatformKey(exp.uiId)).toBe(exp.platformKey)
      expect(toColorToken(exp.uiId)).toBe(exp.colorToken)
      expect(toLabelId(exp.uiId)).toBe(exp.labelId)
      expect(toColorCssVar(exp.uiId)).toBe(`var(${exp.colorToken})`)
    }
    expect(toLabelId('cross')).toBe('Lintas Proyek')
  })

  it('serializeCanonProject covers every form', () => {
    for (const exp of EXPECTED) {
      expect(serializeCanonProject(exp.uiId, 'ui')).toBe(exp.uiId)
      expect(serializeCanonProject(exp.uiId, 'appFlow')).toBe(exp.appFlowId)
      expect(serializeCanonProject(exp.uiId, 'platform')).toBe(exp.platformKey)
      expect(serializeCanonProject(exp.uiId, 'colorToken')).toBe(exp.colorToken)
      expect(serializeCanonProject(exp.uiId, 'labelId')).toBe(exp.labelId)
    }
  })

  it('serializeCanonFlowMode supports cross only for ui + labelId', () => {
    expect(serializeCanonFlowMode('cross', 'ui')).toBe('cross')
    expect(serializeCanonFlowMode('cross', 'labelId')).toBe('Lintas Proyek')
    for (const form of ['appFlow', 'platform', 'colorToken'] as const) {
      expect(() => serializeCanonFlowMode('cross', form)).toThrow(
        CanonProjectMapError,
      )
      try {
        serializeCanonFlowMode('cross', form)
      } catch (e) {
        expect(e).toBeInstanceOf(CanonProjectMapError)
        expect((e as CanonProjectMapError).code).toBe('NOT_A_PROJECT')
      }
    }
  })

  it('typed reverse maps appFlow/platform → ui', () => {
    for (const exp of EXPECTED) {
      expect(uiIdFromAppFlowId(exp.appFlowId as never)).toBe(exp.uiId)
      expect(uiIdFromPlatformKey(exp.platformKey as never)).toBe(exp.uiId)
    }
  })
})

describe('canon-flow-projects: exhaustive round-trip', () => {
  it('normalize(serialize(id, form)) === id for every project × form', () => {
    for (const id of CANON_UI_PROJECT_IDS) {
      for (const form of SERIALIZE_FORMS) {
        const serialized = serializeCanonProject(id, form)
        const r = normalizeCanonProjectId(serialized)
        expect(r, `${id}/${form} → ${serialized}`).toEqual({
          ok: true,
          id,
        })
      }
    }
  })

  it('requireCanonProjectId round-trips every serialize form', () => {
    for (const id of CANON_UI_PROJECT_IDS) {
      for (const form of SERIALIZE_FORMS) {
        const serialized = serializeCanonProject(id, form)
        expect(requireCanonProjectId(serialized)).toBe(id)
      }
    }
  })

  it('normalizeCanonFlowMode round-trips modes including cross', () => {
    for (const mode of CANON_FLOW_MODE_IDS) {
      if (mode === 'cross') {
        expect(requireCanonFlowMode('cross')).toBe('cross')
        expect(requireCanonFlowMode('Lintas Proyek')).toBe('cross')
        continue
      }
      for (const form of SERIALIZE_FORMS) {
        const serialized = serializeCanonFlowMode(mode, form)
        expect(requireCanonFlowMode(serialized)).toBe(mode)
      }
    }
  })

  it('case / separator variants of identity forms still round-trip', () => {
    const cases: Array<[string, CanonUiProjectId]> = [
      ['WEB-MEMBER', 'web-member'],
      ['Web_Member', 'web-member'],
      ['panel/sales', 'panel-sales'],
      ['PANEL.SALES', 'panel-sales'],
      ['  rn  ', 'rn'],
      ['--PROJ-RN', 'rn'],
      ['Admin', 'panel-sales'],
      ['SALES', 'panel-sales'],
      ['WEB', 'web-member'],
    ]
    for (const [raw, id] of cases) {
      expect(requireCanonProjectId(raw), raw).toBe(id)
    }
  })
})

describe('canon-flow-projects: MCP aliases', () => {
  const MCP_CASES: Array<[string, CanonUiProjectId]> = [
    // rn
    ['rn', 'rn'],
    ['mobile', 'rn'],
    ['react native', 'rn'],
    ['React Native', 'rn'],
    ['react-native', 'rn'],
    // web-member
    ['web', 'web-member'],
    ['web-member', 'web-member'],
    ['web member', 'web-member'],
    ['mfs-web', 'web-member'],
    ['mfs web', 'web-member'],
    // panel-sales
    ['sales', 'panel-sales'],
    ['panel-sales', 'panel-sales'],
    ['panel sales', 'panel-sales'],
    ['admin', 'panel-sales'],
    // affiliate
    ['affiliate', 'affiliate'],
    ['aff', 'affiliate'],
    ['afiliasi', 'affiliate'],
    ['Afiliasi', 'affiliate'],
    // backend
    ['backend', 'backend'],
    ['be', 'backend'],
    ['api', 'backend'],
  ]

  it('resolves every accepted MCP alias to the correct project', () => {
    for (const [alias, id] of MCP_CASES) {
      const r = normalizeCanonProjectId(alias)
      expect(r, alias).toEqual({ ok: true, id })
    }
  })

  it('listMcpAliases returns non-empty exclusive lists per project', () => {
    for (const id of CANON_UI_PROJECT_IDS) {
      const aliases = listMcpAliases(id)
      expect(aliases.length).toBeGreaterThan(0)
      for (const a of aliases) {
        expect(requireCanonProjectId(a)).toBe(id)
      }
    }
    for (const a of listMcpAliases('cross')) {
      expect(requireCanonFlowMode(a)).toBe('cross')
    }
  })

  it('cross / lintas aliases resolve as mode, not project', () => {
    const crossAliases = [
      'cross',
      'lintas',
      'lintas-sistem',
      'cross-system',
      'lintas proyek',
      'cross project',
      'cross-project',
      'Lintas Proyek',
    ]
    for (const a of crossAliases) {
      expect(requireCanonFlowMode(a), a).toBe('cross')
      const proj = normalizeCanonProjectId(a)
      expect(proj.ok, a).toBe(false)
      if (!proj.ok) expect(proj.code).toBe('NOT_A_PROJECT')
    }
  })
})

describe('canon-flow-projects: unknown rejection (strict)', () => {
  const UNKNOWNS = [
    '',
    '   ',
    'jobs',
    'premium',
    'other',
    'foo',
    'mfs-rebuild',
    'proj-sales-web',
    'react',
    'native',
    'member',
    'panel',
    'var(--proj-rn)',
    // note: "proj-rn" collapses to the same key as color token "--proj-rn" and is accepted
  ]

  it('normalizeCanonProjectId rejects unknowns / empty / non-string', () => {
    for (const u of UNKNOWNS) {
      const r = normalizeCanonProjectId(u)
      expect(r.ok, `should reject ${JSON.stringify(u)}`).toBe(false)
      if (!r.ok) {
        expect(['UNKNOWN', 'EMPTY']).toContain(r.code)
      }
    }
    expect(normalizeCanonProjectId(null).ok).toBe(false)
    expect(normalizeCanonProjectId(undefined).ok).toBe(false)
    expect(normalizeCanonProjectId(42).ok).toBe(false)
    expect(normalizeCanonProjectId({ id: 'rn' }).ok).toBe(false)
  })

  it('requireCanonProjectId throws CanonProjectMapError on unknowns', () => {
    expect(() => requireCanonProjectId('jobs')).toThrow(CanonProjectMapError)
    expect(() => requireCanonProjectId('')).toThrow(CanonProjectMapError)
    expect(() => requireCanonProjectId(null)).toThrow(CanonProjectMapError)
    try {
      requireCanonProjectId('not-a-project')
    } catch (e) {
      expect(e).toBeInstanceOf(CanonProjectMapError)
      expect((e as CanonProjectMapError).code).toBe('UNKNOWN')
    }
  })

  it('does not silently coerce partial tokens via substring match', () => {
    // "be" is backend, but "backend-extra" must not match
    expect(normalizeCanonProjectId('backend-extra').ok).toBe(false)
    expect(normalizeCanonProjectId('affiliate-portal').ok).toBe(false)
    expect(normalizeCanonProjectId('my mobile app').ok).toBe(false)
    expect(normalizeCanonProjectId('api-gateway').ok).toBe(false)
  })

  it('serialize rejects forged non-member ids at runtime', () => {
    expect(() =>
      serializeCanonProject('not-real' as CanonUiProjectId, 'ui'),
    ).toThrow(CanonProjectMapError)
    expect(() => toAppFlowId('nope' as CanonUiProjectId)).toThrow(
      CanonProjectMapError,
    )
  })
})

describe('canon-flow-projects: alias collision integrity', () => {
  it('assertNoAliasCollisions succeeds on the built table', () => {
    expect(() => assertNoAliasCollisions()).not.toThrow()
  })

  it('every registered alias key maps to exactly one target', () => {
    const keys = listRegisteredAliasKeys()
    expect(keys.length).toBeGreaterThan(20)
    // uniqueness is inherent in Map; also ensure no empty keys
    for (const k of keys) {
      expect(k.length).toBeGreaterThan(0)
      expect(k).toBe(normalizeAliasKey(k))
    }
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('no two projects share an MCP alias after normalizeAliasKey', () => {
    const seen = new Map<string, CanonUiProjectId>()
    for (const p of CANON_FLOW_PROJECTS) {
      const sources = [
        p.uiId,
        p.appFlowId,
        p.platformKey,
        p.colorToken,
        p.labelId,
        ...p.mcpAliases,
      ]
      for (const raw of sources) {
        const key = normalizeAliasKey(raw)
        const prev = seen.get(key)
        if (prev != null && prev !== p.uiId) {
          throw new Error(
            `collision: "${key}" owned by ${prev} and ${p.uiId}`,
          )
        }
        seen.set(key, p.uiId)
      }
    }
    // cross aliases must not collide with projects
    for (const raw of [
      CANON_CROSS_MODE.modeId,
      CANON_CROSS_MODE.labelId,
      ...CANON_CROSS_MODE.mcpAliases,
    ]) {
      const key = normalizeAliasKey(raw)
      expect(seen.has(key), `cross alias collides with project: ${key}`).toBe(
        false,
      )
    }
  })

  it('distinct raw aliases that collapse to the same key stay same-owner', () => {
    // web-member vs web member, panel-sales vs panel sales, etc.
    expect(normalizeAliasKey('web-member')).toBe(normalizeAliasKey('web member'))
    expect(normalizeAliasKey('panel-sales')).toBe(
      normalizeAliasKey('panel sales'),
    )
    expect(requireCanonProjectId('web-member')).toBe(
      requireCanonProjectId('web member'),
    )
    expect(requireCanonProjectId('panel-sales')).toBe(
      requireCanonProjectId('panel sales'),
    )
  })
})

describe('canon-flow-projects: normalizeAliasKey', () => {
  it('strips diacritics and collapses separators', () => {
    expect(normalizeAliasKey('Afiliasi')).toBe('afiliasi')
    // combining accent on e
    expect(normalizeAliasKey('café')).toBe('cafe')
    expect(normalizeAliasKey('foo_bar/baz.qux')).toBe('foo bar baz qux')
    expect(normalizeAliasKey('--proj-rn')).toBe('proj rn')
  })
})
