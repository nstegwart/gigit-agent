/**
 * Ambient types for qa/e2e/lib/start-auth-preview.mjs (harness only).
 * Satisfies TS7016 for unit harness imports of pure helpers.
 */

export const CSRF_PREVIEW_MUTATOR_SPECS: readonly [
  'collab-comment',
  'feature-toggle',
  'boards',
]

export type AuthPreviewCsrfMeta = {
  configured: boolean
  minted: boolean
  source: string
}

export type AuthPreviewChildEnvResult = {
  env: NodeJS.ProcessEnv
  csrf: AuthPreviewCsrfMeta
  runId: string
  metaPath: string
  secretsPath: string
}

export type AuthPreviewArgs = {
  port: number
  host: string
  cleanupOnExit: boolean
}

export type AuthPreviewCleanupReceipt = {
  performed: boolean
  skipped?: boolean
  reason?: string
  trigger?: string
  runId?: string
  secretsSidecarErased?: boolean
  envScrubbed?: string[]
  dbDropped?: boolean
  dbDropSkipped?: string | null
  storageErased?: boolean
  error?: string
  callCount?: number
}

export type AuthPreviewExitCleanup = {
  cleanupOnExit: boolean
  runOnce: (trigger?: string) => Promise<AuthPreviewCleanupReceipt>
  hasStarted: () => boolean
  getReceipt: () => AuthPreviewCleanupReceipt | null
  getCallCount: () => number
}

export function parseArgs(argv: string[]): AuthPreviewArgs

export function buildAuthPreviewChildEnv(opts?: {
  port?: number | string
  host?: string
  baseEnv?: NodeJS.ProcessEnv
}): AuthPreviewChildEnvResult

export function formatAuthPreviewStartLog(input: {
  port: number | string
  host: string
  isoDb?: string
  runId: string
  metaPath: string
  username?: string
  csrf?: AuthPreviewCsrfMeta
}): string

export function formatAuthPreviewCleanupLog(
  receipt: AuthPreviewCleanupReceipt | null | undefined,
): string

export function createAuthPreviewExitCleanup(opts?: {
  cleanupOnExit?: boolean
  cleanup?: (opts?: {
    keepDb?: boolean
    keepStorage?: boolean
  }) => Promise<{
    runId?: string
    secretsSidecarErased?: boolean
    envScrubbed?: string[]
    dbDropped?: boolean
    dbDropSkipped?: string | null
    storageErased?: boolean
  }>
  eraseSidecar?: () => boolean
  keepDb?: boolean
  keepStorage?: boolean
}): AuthPreviewExitCleanup

export function installAuthPreviewExitHandlers(deps: {
  child: {
    killed?: boolean
    kill: (signal?: string) => void
    on: (event: string, cb: (...args: unknown[]) => void) => void
  }
  exitCleanup: AuthPreviewExitCleanup
  processRef?: {
    on: (event: string, cb: (...args: unknown[]) => void) => void
  }
  log?: (line: string) => void
  exitFn?: (code: number) => void
}): {
  performExitCleanup: (trigger: string) => Promise<AuthPreviewCleanupReceipt>
  isExiting: () => boolean
  stopChild: (signal?: string) => void
}
