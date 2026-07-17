#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '../..')
const output = resolve(root, 'AGENT_TASK_ORCHESTRATOR_COMBINED.md')
const sources = [
  {
    label: 'PARENT',
    file: 'AGENT_TASK_ORCHESTRATOR.md',
    pinnedPath: '/home/user/Downloads/01-TASK-MANAGER-AGENT.txt',
    pinnedSha:
      'b7e6c69484952d9fd3ada6d13c4b7b32a829187b6e9117c9c32f5bde7419f29d',
  },
  {
    label: 'ADDENDUM',
    file: 'ART-UX-DIRECTION.md',
    pinnedPath:
      '/home/user/Downloads/01A-TASK-MANAGER-UX-ART-DIRECTION-COMBINED.txt',
    pinnedSha:
      '4eca14e115223ca4be02ec767dca0a32fb3e104dc4a512ebbc99374f93cddcee',
  },
]

const sha256 = (value) => createHash('sha256').update(value).digest('hex')
if (process.argv.includes('--sync-pinned')) {
  for (const source of sources) {
    const pinnedBytes = readFileSync(source.pinnedPath)
    const actual = sha256(pinnedBytes)
    if (actual !== source.pinnedSha) {
      throw new Error(
        `PINNED_INPUT_MISMATCH ${source.pinnedPath} expected=${source.pinnedSha} actual=${actual}`,
      )
    }
    writeFileSync(resolve(root, source.file), pinnedBytes)
  }
}
const loaded = sources.map((source) => {
  const bytes = readFileSync(resolve(root, source.file))
  const actual = sha256(bytes)
  if (actual !== source.pinnedSha) {
    throw new Error(
      `PIN_MISMATCH ${source.file} expected=${source.pinnedSha} actual=${actual}`,
    )
  }
  return {
    ...source,
    bytes,
    lineCount: bytes.toString('utf8').split('\n').length - 1,
  }
})

const provenanceSha =
  '4330d6e6d34e209acc1e54a4f42127cdf39363bd6428267a3031ad1744c78091'
const header = `# AGENT_TASK_ORCHESTRATOR_COMBINED.md
# CUMULATIVE CANONICAL EXECUTION CONTRACT
# Generated mechanically by qa/cp0/generate-combined-spec.mjs; do not hand-edit.

## COMBINED_META

- document_id: AGENT_TASK_ORCHESTRATOR_COMBINED
- task_id: TM-P0-ULTIMATE-CONTROL-CENTER-V3
- generation_mode: deterministic_verbatim_embed_v2
- authority_model: cumulative parent plus addendum
- parent_sha256: ${loaded[0].pinnedSha}
- addendum_sha256: ${loaded[1].pinnedSha}
- retired_offline_provenance_sha256: ${provenanceSha}

## CURRENT PUBLICATION AUTHORITY

App-only Task Manager production publication is pre-authorized only after exact current-SHA
staging PASS, an independent verifier PASS bound to that SHA, root acceptance, backup and
rollback proof, authenticated UI/MCP plus sanitized public parity, zero effective sync backlog,
and lifecycle/audit/rollup/hash/freshness readback. Publication uses --no-migrate. Production
schema migration remains separately owner-gated; a schema-incompatible candidate returns
SCHEMA_AUTH_REQUIRED and is not published. MFS production remains outside this contract.

## INTEGRITY RULES

- Each pinned source appears exactly once between its BEGIN/END markers.
- Text inside each verbatim block is byte-identical to the named pinned source.
- Metadata resolves later owner authority only; it does not rewrite either source body.
- Run this generator with --check before accepting a candidate.

`

const blocks = loaded
  .map(
    (source) =>
      `## VERBATIM_${source.label}: ${source.file}\n\n` +
      `<<<BEGIN_VERBATIM_SOURCE:${source.file}>>>\n` +
      source.bytes.toString('utf8') +
      `<<<END_VERBATIM_SOURCE:${source.file}>>>\n\n`,
  )
  .join('')
const rendered = header + blocks

if (process.argv.includes('--check')) {
  const actual = readFileSync(output)
  if (!actual.equals(Buffer.from(rendered))) {
    throw new Error(
      `COMBINED_SPEC_DRIFT expected=${sha256(rendered)} actual=${sha256(actual)}`,
    )
  }
  process.stdout.write(
    JSON.stringify({
      ok: true,
      output: 'AGENT_TASK_ORCHESTRATOR_COMBINED.md',
      sha256: sha256(actual),
    }) + '\n',
  )
} else {
  writeFileSync(output, rendered)
  process.stdout.write(
    JSON.stringify({
      ok: true,
      output: 'AGENT_TASK_ORCHESTRATOR_COMBINED.md',
      sha256: sha256(rendered),
    }) + '\n',
  )
}
