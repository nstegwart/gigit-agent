/**
 * Adjacent TypeScript declarations for `conformance-lib.mjs`.
 * Runtime remains pure ESM JS; this file is types-only (no emit required).
 * MFS_PUBLIC_CONSUMER_SYNC_CONTRACT_V1
 */

export const CONTRACT_ID: 'MFS_PUBLIC_CONSUMER_SYNC_CONTRACT_V1'
export const OPENAPI_VERSION: 'MFS_PUBLIC_CONSUMER_SYNC_V1'
export const SCHEMA_VERSION: 'MFS_PUBLIC_SNAPSHOT_V1'
export const SERIALIZER_VERSION: 'PUBLIC_SNAPSHOT_V1'
export const RATE_LIMIT_POLICY: 'PUBLIC_SNAPSHOT_RATE_LIMIT_V1'
export const PUBLISH_SCHEMA: 'MFS_PUBLIC_CONSUMER_PUBLISH_V1'
export const CANONICAL_MASK_RE: RegExp
export const HEX64_RE: RegExp
export const FORBIDDEN_KEY_RE: RegExp
export const MOCK_MARKERS: readonly string[]

export type ValidationResult = {
  ok: boolean
  errors: string[]
}

export type PublicSnapshotChecks = {
  schema_and_pin: boolean
  freshness_shape: boolean
  counts_consistency: boolean
  redaction: boolean
  etag_internal: boolean
}

export type PublicSnapshotValidationResult = ValidationResult & {
  checks: PublicSnapshotChecks
}

export type AtomicPublishValidationResult = ValidationResult & {
  mockHits: string[]
}

export function normalizeEtag(value: unknown): string
export function etagMatches(a: unknown, b: unknown): boolean
export function isForbiddenKey(key: string): boolean
export function findForbiddenKeys(value: unknown, path?: string): string[]
export function findSecretLikeStrings(value: unknown, path?: string): string[]
export function validatePin(pin: unknown): ValidationResult
export function validatePublicSnapshotPayload(
  payload: unknown,
  opts?: { boardId?: string },
): PublicSnapshotValidationResult
export function validateRateLimitedBody(body: unknown): ValidationResult
export function validateStaleOrMissingBody(body: unknown): ValidationResult
export function findMockMarkers(value: unknown): string[]
export function validateAtomicPublishReceipt(
  receipt: unknown,
): AtomicPublishValidationResult
export function shouldReturn304(
  currentEtag: string,
  ifNoneMatch: string | null | undefined,
): boolean
