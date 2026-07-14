/**
 * Ambient types for qa/e2e/lib/server-lifecycle.mjs (harness only).
 * Satisfies TS7016 for unit harness imports of pure helpers.
 */

export function pickFreePort(preferred?: number): Promise<number>

export function waitForHttpOk(
  url: string,
  opts?: { timeoutMs?: number; intervalMs?: number },
): Promise<{ ok: true; status: number; url: string; elapsedMs: number }>

/**
 * Child-only public allowlist for disposable owned preview.
 * Does not mutate process.env. Product empty allowlist remains deny-all.
 */
export function buildOwnedPreviewPublicAllowlistEnv(
  boardId: string,
): { CAIRN_PUBLIC_BOARD_IDS: string }

/**
 * Pure membership check matching product allowlist parse rules.
 */
export function publicAllowlistEnvAllows(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> | null | undefined,
  boardId: string,
): boolean

export type OwnedPreviewServer = {
  pid: number | undefined
  port: number
  host: string
  baseUrl: string
  logPath: string
  startedAt: string
  stopped: boolean
  exitCode: number | null
  health: { ok: true; status: number; url: string; elapsedMs: number }
  stop: () => Promise<{
    already?: boolean
    stopped?: boolean
    pid?: number
    exitCode?: number | null
  }>
  child: unknown
  /** Sensitive env key names injected into child only (values never returned). */
  injectedEnvKeys: string[]
}

export function startOwnedPreviewServer(opts?: {
  cwd?: string
  port?: number
  preferredPort?: number
  host?: string
  logDir?: string
  healthPath?: string
  healthTimeoutMs?: number
  command?: string
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>
}): Promise<OwnedPreviewServer>

export function portIsFree(port: number, host?: string): Promise<boolean>
