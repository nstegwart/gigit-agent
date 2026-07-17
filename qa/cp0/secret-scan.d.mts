export interface SecretFinding {
  path: string
  line: number
  rule: string
}

export function scanText(path: string, text: string): SecretFinding[]
export function scanRepository(cwd?: string): {
  ok: boolean
  scanned: number
  findings: SecretFinding[]
}
export function runSelfTest(): { ok: boolean; badRules: string[] }
