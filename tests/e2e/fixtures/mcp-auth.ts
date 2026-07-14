/**
 * Scoped MCP auth header fixture for Playwright request contexts.
 * Bearer is process-local (CAIRN_MCP_BEARER) — never hardcode/commit.
 */
import { mcpAuthHeaders as mcpAuthHeadersFromLib } from '../../../qa/e2e/lib/auth-fixture.mjs'

export function mcpAuthHeaders(bearer?: string): { Authorization: string } {
  return mcpAuthHeadersFromLib(bearer) as { Authorization: string }
}

/** Merge MCP auth into an existing headers bag (does not mutate input). */
export function withMcpAuth(
  headers: Record<string, string> = {},
  bearer?: string,
): Record<string, string> {
  return { ...headers, ...mcpAuthHeaders(bearer) }
}
