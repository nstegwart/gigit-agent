/**
 * Playwright globalSetup: align process env with auth fixture.
 * Primary prepare lives in start-auth-preview.mjs (webServer) because webServer may
 * start before globalSetup. Here we load the sidecar and reuse existing iso meta.
 */
import {
  ensureAuthSecretsInEnv,
  loadSecretsSidecar,
  prepareIsolatedAuthFixture,
  readRuntimeMeta,
  resolveAuthRunId,
  resolveAuthRuntimeMetaPath,
} from '../../../qa/e2e/lib/auth-fixture.mjs'

export default async function globalSetup(): Promise<void> {
  loadSecretsSidecar()
  ensureAuthSecretsInEnv()
  const runId = resolveAuthRunId()
  const metaPath = resolveAuthRuntimeMetaPath()

  // Reuse iso prepared by start-auth-preview for THIS runId only; never a peer meta path.
  const prep = await prepareIsolatedAuthFixture({ slug: 'authfix' })
  if (!prep?.ok) {
    throw new Error(
      `FAIL-CLOSED globalSetup: prepareIsolatedAuthFixture failed: ${JSON.stringify(prep)}`,
    )
  }

  const meta = readRuntimeMeta()
  // eslint-disable-next-line no-console
  console.log(
    [
      'AUTH_FIXTURE_READY',
      `mode=${meta?.mode ?? prep.mode}`,
      `reused=${prep.reused === true}`,
      `runId=${runId}`,
      `meta=${metaPath}`,
      `isoDb=${meta?.isoDb ?? prep.isoDb ?? 'n/a'}`,
      `username=${meta?.username ?? prep.username ?? 'n/a'}`,
      `mcpRole=${meta?.mcpPrincipalMeta?.role ?? 'n/a'}`,
      `dbName=${process.env.CAIRN_DB_NAME ?? 'unset'}`,
    ].join(' '),
  )
}
