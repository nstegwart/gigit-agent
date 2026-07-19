/**
 * Canon v3 source-level fidelity tokens (micro residual R1).
 *
 * Deterministic source assertions — fail before / pass after exact token repair.
 * Avoids brittle full-file snapshots; pins only the residual contracts:
 *   - status fdot --dot-size: 10px (not --sp-3 / 12px)
 *   - small chip --dot-size-sm: 7px (canon tokens.css)
 *   - bottom sheet height/max-height: 65vh (not 65%)
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = join(dirname(fileURLToPath(import.meta.url)), '../..')
const css = readFileSync(
  join(root, 'src/components/flow-ultimate/flow-ultimate.css'),
  'utf8',
)
const tsx = readFileSync(
  join(root, 'src/components/flow-ultimate/FlowUltimateScreen.tsx'),
  'utf8',
)

describe('canon-flow-fidelity-tokens — exact CSS residuals', () => {
  it('status dot token is literal 10px (not spacing ladder --sp-3)', () => {
    expect(css).toMatch(/--dot-size:\s*10px\s*;/)
    expect(css).not.toMatch(/--dot-size:\s*var\(--sp-3\)/)
    // .fdot still consumes the token (geometry wiring intact)
    expect(css).toMatch(/\.fdot\s*\{[^}]*width:\s*var\(--dot-size\)/s)
    expect(css).toMatch(/\.fdot\s*\{[^}]*height:\s*var\(--dot-size\)/s)
  })

  it('small chip dot token is literal 7px (canon --dot-size-sm)', () => {
    expect(css).toMatch(/--dot-size-sm:\s*7px\s*;/)
    expect(css).not.toMatch(/--dot-size-sm:\s*var\(--sp-2\)/)
  })

  it('bottom sheet uses exact canon 65vh height and max-height', () => {
    expect(css).toMatch(
      /\.flow-sheet\s*\{[^}]*height:\s*65vh\s*;[^}]*max-height:\s*65vh\s*;/s,
    )
    // Residual percentage sheet geometry must not remain on .flow-sheet
    expect(css).not.toMatch(
      /\.flow-sheet\s*\{[^}]*height:\s*65%\s*;/s,
    )
    expect(css).not.toMatch(
      /\.flow-sheet\s*\{[^}]*max-height:\s*65%\s*;/s,
    )
  })
})

describe('canon-flow-fidelity-tokens — graph summary copy source', () => {
  it('graphSummary announces simpul, not English node/nodes', () => {
    expect(tsx).toMatch(/\$\{count\}\s*simpul\./)
    expect(tsx).not.toMatch(/\$\{count\}\s*node\$\{/)
    expect(tsx).not.toMatch(/node\$\{count === 1 \? ['"]['"] : ['"]s['"]\}/)
  })
})
