/**
 * Fail-soft search coercion for control-center cursor routes.
 * Mirrors Work's coerceWorkSearchString: numeric/boolean URL search values
 * must never throw an error boundary. Server re-validates pageSize when used.
 */
import { z } from 'zod'

/**
 * Coerce raw URL search values so `?pageSize=50` (number) / `?cursor=12` (number)
 * do not crash zod string schemas. Invalid shapes → undefined (deterministic omit).
 */
export function coerceControlCenterSearchString(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value === 'string') return value
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'bigint') return String(value)
  return undefined
}

const optionalCursorSearchString = z.preprocess(
  (v) => coerceControlCenterSearchString(v),
  z.string().optional(),
)

/** Shared cursor + pageSize search schema for decisions/features/agents/evidence. */
export const controlCenterCursorSearchSchema = z.object({
  cursor: optionalCursorSearchString,
  pageSize: optionalCursorSearchString,
})

export type ControlCenterCursorSearch = z.infer<typeof controlCenterCursorSearchSchema>

/**
 * Deterministic cursor search parse for route validateSearch + unit tests.
 * Never throws on raw URL shapes (`?pageSize=50`, `?cursor=12`, absent, invalid).
 */
export function parseControlCenterCursorSearch(search: unknown): ControlCenterCursorSearch {
  const raw =
    search && typeof search === 'object' && !Array.isArray(search)
      ? (search as Record<string, unknown>)
      : {}
  const result = controlCenterCursorSearchSchema.safeParse(raw)
  if (result.success) return result.data
  // Fail-soft: empty search rather than error-boundary crash
  return {}
}
