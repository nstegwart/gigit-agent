export const CP0_STAGING_GATE: 'CP0_EXACT_SHA_STAGING_GATE_V1'
export const CP0_SCHEMA_VERSION: '008'
export const REQUIRED_MIGRATIONS: readonly string[]

export interface StagingPlan {
  gate: string
  mode: 'PLAN_ONLY'
  target: 'staging'
  expectedSha: string
  observedHead: string | null
  headMatches: boolean
  dirty: boolean
  stagingVerified: false
  liveP0: false
  checksRequired: string[]
}

export interface StagingEvidenceVerdict {
  gate: string
  ok: boolean
  target?: string
  expectedSha?: string
  failures: string[]
  stagingVerified: boolean
  liveP0: false
}

export function buildPlan(input: {
  expectedSha: string
  target?: string
  cwd?: string
}): StagingPlan

export function validateEvidence(
  evidence: unknown,
  expectedSha: string,
  target?: string,
): StagingEvidenceVerdict
