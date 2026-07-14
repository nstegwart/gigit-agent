/**
 * Playwright globalTeardown: drop THIS run's iso DB only, erase storageState, scrub secret env.
 * Never reads a shared fixed meta path — peer workers keep their DBs.
 */
import {
  cleanupIsolatedAuthFixture,
  resolveAuthRunId,
  resolveAuthRuntimeMetaPath,
} from '../../../qa/e2e/lib/auth-fixture.mjs'

export default async function globalTeardown(): Promise<void> {
  const runId = resolveAuthRunId()
  const metaPath = resolveAuthRuntimeMetaPath()
  const result = await cleanupIsolatedAuthFixture()
  // eslint-disable-next-line no-console
  console.log(
    [
      'AUTH_FIXTURE_CLEANUP',
      `runId=${runId}`,
      `meta=${metaPath}`,
      `dbDropped=${result.dbDropped}`,
      `dbDropSkipped=${result.dbDropSkipped ?? 'none'}`,
      `storageErased=${result.storageErased}`,
      `envScrubbed=${(result.envScrubbed ?? []).join(',') || 'none'}`,
      `isoDb=${result.isoDb ?? 'n/a'}`,
    ].join(' '),
  )
}
