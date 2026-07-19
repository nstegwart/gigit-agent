/**
 * Strict ambient types for qa/e2e/flows/security-probes.mjs
 * Satisfies TS7016 for tests/unit/security-probes-harness.test.ts.
 */

export const HARNESS_ID: 'security-probes-v1'
export const NEGATIVE_PACK_ID: 'TM-SECURITY-PROBES-NEGATIVE-R1'
export const DUMMY_BEARER_LITERAL: 'not-a-valid-token'
export const DUMMY_CAIRN_TOKEN_LITERAL: 'not-a-valid-token'
export const DUMMY_SESSION_COOKIE: string
export const FORBIDDEN_BODY_KEYS: RegExp
export const LEAK_PATTERNS: readonly RegExp[]

export type ProbePlanRow = {
  id: string
  class: 'baseline-unauth' | 'public' | 'optional-auth' | 'negative-readonly' | string
  method: string
  path: string
  expectStatus: number | string
  requiresRealToken: boolean
  headerClass?: string
  skipIfNoBearer?: boolean
  optionalMatrix?: boolean
}

export const PROBE_PLAN: readonly ProbePlanRow[]

export type ProbeResult = {
  id: string
  pass: boolean
  detail: Record<string, unknown> | null
}

export type EvalBase = {
  pass: boolean
  failClosed: boolean
  reason: string | null
  status: number | null
  code?: string | null
  leak?: boolean
  elevated?: boolean
  classification?: string
  cookieNeverElevates?: boolean
}

export type PlanResult = {
  mode: 'plan'
  harness: string
  pack: string
  boardId: string
  probeCount: number
  negativeCount: number
  requiresRealTokenCount: number
  rows: Array<{
    id: string
    class: string
    method: string
    path: string
    expectStatus: number | string
    requiresRealToken: boolean
    headerClass: string | null
    optionalMatrix: boolean
    skipIfNoBearer: boolean
  }>
  note: string
  NOT_SHIPPABLE: string
}

export type SelfTestResult = {
  ok: boolean
  mode: string
  harness: string
  pack: string
  checks: Record<string, boolean>
  passCount: number
  failCount: number
  note: string
}

export function resolveBearer(env?: NodeJS.ProcessEnv | Record<string, string | undefined>): string | null
export function probeResult(id: string, pass: boolean, detail?: unknown): ProbeResult
export function sanitizeProbeDetail(detail: unknown): Record<string, unknown> | null
export function textHasLeakSignals(text: string | null | undefined): boolean
export function collectKeys(value: unknown, out?: Set<string>, depth?: number): Set<string>
export function extractStableCode(body: unknown): string | null
export function hasMcpSuccessData(body: unknown): boolean

export function evaluateWrongTokenHealthz(input?: {
  status?: number | null
  code?: string | null
  error?: string | null
  text?: string | null
}): EvalBase

export function evaluateWrongTokenMcp(input?: {
  status?: number | null
  code?: string | null
  error?: string | null
  text?: string | null
  body?: unknown
}): EvalBase

export function evaluateCookieOnlyMcp(input?: {
  status?: number | null
  code?: string | null
  error?: string | null
  text?: string | null
  body?: unknown
}): EvalBase

export function evaluateMalformedMcp(input?: {
  status?: number | null
  code?: string | null
  error?: string | null
  text?: string | null
  body?: unknown
}): EvalBase

export function evaluateMethodPathNegative(input?: {
  status?: number | null
  code?: string | null
  error?: string | null
  text?: string | null
  body?: unknown
  expect?: 'session-401' | 'method-gated'
}): EvalBase

export function isSecretSafeReport(report: unknown): boolean
export function planSecurityProbes(opts?: {
  boardId?: string
  includeOptionalMatrix?: boolean
}): PlanResult

export function fetchJson(
  url: string,
  init?: RequestInit,
  fetchImpl?: typeof fetch,
): Promise<{
  res: Response
  status: number
  text: string
  body: unknown
  headers: Headers
}>

export function runProbes(
  base: string,
  boardId: string,
  opts?: { fetchImpl?: typeof fetch; env?: NodeJS.ProcessEnv },
): Promise<ProbeResult[]>

export function selfTest(): SelfTestResult
export function main(
  argv?: string[],
  env?: NodeJS.ProcessEnv,
): Promise<unknown>
