#!/usr/bin/env node
/** Emit a fail-closed, schema-free RESOLVED_TARGET binding. */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
export const REPO_ROOT_DEFAULT = resolve(__dirname, '../..')
export const SCHEMA_VERSION = 'TM_RESOLVED_TARGET_V1'
export const HOST_CLASSES = Object.freeze([
  'LOCAL',
  'STAGING',
  'PRODUCTION',
  'UNKNOWN_REMOTE',
])
export const PINNED_SPEC_HASHES = Object.freeze({
  artUx: {
    path: 'ART-UX-DIRECTION.md',
    sha256: '4eca14e115223ca4be02ec767dca0a32fb3e104dc4a512ebbc99374f93cddcee',
  },
  v3Combined: {
    path: 'AGENT_TASK_ORCHESTRATOR_COMBINED.md',
    sha256: 'b248c21f7482ec9d4fbe898df3b5ce45321f6d0d87861b4e14f6135adb7f3b4d',
  },
})

/** Portable design-input FABLE receipts (AC-TARGET-04). Advisory only; not product PASS. */
export const PINNED_FABLE_RECEIPTS = Object.freeze({
  review: {
    id: 'fableReview',
    portableUri:
      '.artifact/evidence/TM-P0-ULTIMATE-CONTROL-CENTER-V3/input/01-task-manager-fable5-xhigh-review.json',
    sha256:
      'eadae4e7306aa677e7c460744807934e29df856fac75a01f1321714c556b8d51',
  },
  delta: {
    id: 'fableDelta',
    portableUri:
      '.artifact/evidence/TM-P0-ULTIMATE-CONTROL-CENTER-V3/input/01-task-manager-fable5-xhigh-delta-review.json',
    sha256:
      'eeb9af48651b3c31e1e97933ed55e0ac52aed09731b30d246f2df5c1eefa45db',
  },
})

/** Required fields when root binds portable FABLE receipts into RESOLVED_TARGET. */
export const FABLE_RECEIPT_REQUIRED_FIELDS = Object.freeze([
  'id',
  'portableUri',
  'sha256',
])

const DEFAULT_ALLOWED_PATHS = Object.freeze([
  'qa/evidence/**',
  'tests/unit/**',
  '.artifact/evidence/**',
])
const DEFAULT_FORBIDDEN_PATHS = Object.freeze([
  'deploy/production/**',
  'migrations/**',
  'CONTRACT/**',
  '.git/**',
  'dist/**',
  'node_modules/**',
])

export function sha256Hex(data) {
  return createHash('sha256').update(data).digest('hex')
}

function gitRead(root, args) {
  const out = spawnSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (out.status !== 0) {
    throw new Error(
      (out.stderr || out.stdout || `git ${args.join(' ')} failed`).trim(),
    )
  }
  return out.stdout.trim()
}

function normalizePolicyPath(value) {
  const raw = String(value ?? '')
    .trim()
    .replaceAll('\\', '/')
  if (!raw || isAbsolute(raw) || raw === '..' || raw.startsWith('../'))
    return null
  const pieces = raw.split('/').filter((part) => part && part !== '.')
  if (!pieces.length || pieces.includes('..')) return null
  return pieces.join('/')
}

function policyBase(value) {
  return value.replace(/\/(?:\*\*?|[^/]*\*)$/u, '').replace(/\/$/u, '')
}

export function pathPoliciesOverlap(allowed, forbidden) {
  const a = policyBase(allowed)
  const f = policyBase(forbidden)
  return a === f || a.startsWith(`${f}/`) || f.startsWith(`${a}/`)
}

export function pathMatchesPolicy(path, policy) {
  const candidate = normalizePolicyPath(path)
  const pattern = normalizePolicyPath(policy)
  if (!candidate || !pattern) return false
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&')
  const source = escaped
    .replaceAll('**', '\u0000')
    .replaceAll('*', '[^/]*')
    .replaceAll('\u0000', '.*')
  return new RegExp(`^${source}$`, 'u').test(candidate)
}

export function parseChangedPaths(porcelain) {
  const paths = []
  for (const line of String(porcelain ?? '').split(/\r?\n/u)) {
    if (!line) continue
    const value = line.length >= 4 ? line.slice(3) : line
    for (const path of value.split(' -> ')) {
      const normalized = normalizePolicyPath(path.replace(/^"|"$/g, ''))
      if (normalized) paths.push(normalized)
    }
  }
  return [...new Set(paths)].sort()
}

export function isStrictIsoTimestamp(value) {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)
  ) {
    return false
  }
  const parsed = new Date(value)
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value
}

export function isSha256Hex(value) {
  return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value)
}

/**
 * Bind portable FABLE review+delta receipt URIs/hashes (AC-TARGET-04).
 * When receipts are omitted, documents required fields instead of failing
 * unless requireFableReceipts is true.
 *
 * @param {object} [opts]
 * @param {Array<object>|Record<string,object>|null} [opts.fableReceipts]
 * @param {boolean} [opts.requireFableReceipts]
 * @param {string} [opts.root]
 * @param {(path:string)=>Buffer|string} [opts.readFile]
 * @param {Record<string,{id:string,portableUri:string,sha256:string}>} [opts.pinned]
 */
export function bindFableReceipts(opts = {}) {
  const errors = []
  const pinned = opts.pinned ?? PINNED_FABLE_RECEIPTS
  const expectedPins = Object.values(pinned).map((pin) => ({
    id: pin.id,
    portableUri: pin.portableUri,
    sha256: pin.sha256,
  }))
  const requiredFields = [...FABLE_RECEIPT_REQUIRED_FIELDS]
  const root = opts.root ? resolve(opts.root) : null
  const readFile = opts.readFile ?? readFileSync

  if (opts.fableReceipts == null) {
    if (opts.requireFableReceipts) errors.push('FABLE_RECEIPTS_REQUIRED')
    return {
      provided: false,
      requiredFields,
      expectedPins,
      receipts: [],
      bothBound: false,
      errors,
    }
  }

  const rawList = Array.isArray(opts.fableReceipts)
    ? opts.fableReceipts
    : Object.entries(opts.fableReceipts).map(([key, value]) => ({
        id: value?.id ?? key,
        ...value,
      }))

  if (!rawList.length) {
    errors.push('FABLE_RECEIPTS_EMPTY')
    return {
      provided: true,
      requiredFields,
      expectedPins,
      receipts: [],
      bothBound: false,
      errors,
    }
  }

  const receipts = rawList.map((raw, index) => {
    const id = raw?.id ?? `fableReceipt_${index}`
    const portableUri = raw?.portableUri ?? raw?.uri ?? raw?.path ?? null
    const expectedSha256 = raw?.sha256 ?? raw?.expectedSha256 ?? null
    const missing = requiredFields.filter((field) => {
      if (field === 'id') return !raw?.id && raw?.id !== 0
      if (field === 'portableUri') return !portableUri
      if (field === 'sha256') return !expectedSha256
      return false
    })
    // Allow id derived from object key / index only when portableUri+sha present
    // but still require explicit portableUri + sha256.
    const fieldMissing = []
    if (!portableUri) fieldMissing.push('portableUri')
    if (!expectedSha256) fieldMissing.push('sha256')
    if (fieldMissing.length) errors.push('FABLE_RECEIPT_FIELDS_MISSING')

    let class_ = 'INCOMPLETE'
    let actualSha256 = null
    let filePresent = false

    if (!isSha256Hex(expectedSha256)) {
      if (expectedSha256 != null) errors.push('FABLE_RECEIPT_HASH_INVALID')
      class_ = expectedSha256 == null ? 'INCOMPLETE' : 'HASH_INVALID'
    } else {
      const candidatePath =
        portableUri && root && !String(portableUri).includes('://')
          ? resolve(root, portableUri)
          : raw?.localPath
            ? resolve(raw.localPath)
            : null
      if (candidatePath && existsSync(candidatePath)) {
        filePresent = true
        try {
          actualSha256 = sha256Hex(readFile(candidatePath))
          class_ =
            actualSha256 === expectedSha256 ? 'PIN_MATCH' : 'PIN_MISMATCH'
          if (class_ === 'PIN_MISMATCH') errors.push('FABLE_RECEIPT_HASH_MISMATCH')
        } catch {
          errors.push('FABLE_RECEIPT_UNREADABLE')
          class_ = 'UNREADABLE'
        }
      } else {
        // URI+hash binding without local bytes (root-produced portable pin).
        const pinMatch = expectedPins.some(
          (pin) =>
            pin.sha256 === expectedSha256 &&
            (pin.portableUri === portableUri || pin.id === id),
        )
        class_ = pinMatch ? 'URI_PIN_BOUND' : 'URI_PIN_BOUND_UNVERIFIED_BYTES'
        if (opts.requireLocalBytes) {
          errors.push('FABLE_RECEIPT_FILE_MISSING')
          class_ = 'FILE_MISSING'
        }
      }
    }

    return {
      id,
      portableUri,
      expectedSha256,
      actualSha256,
      filePresent,
      class: class_,
      missingFields: fieldMissing,
    }
  })

  const ids = new Set(receipts.map((r) => r.id))
  const hasReview =
    ids.has('fableReview') ||
    receipts.some((r) => /review/i.test(String(r.id)) || /review/i.test(String(r.portableUri)))
  const hasDelta =
    ids.has('fableDelta') ||
    receipts.some((r) => /delta/i.test(String(r.id)) || /delta/i.test(String(r.portableUri)))
  const bothBound =
    receipts.length >= 2 &&
    hasReview &&
    hasDelta &&
    receipts.every(
      (r) =>
        r.class === 'PIN_MATCH' ||
        r.class === 'URI_PIN_BOUND' ||
        r.class === 'URI_PIN_BOUND_UNVERIFIED_BYTES',
    )
  if (opts.requireFableReceipts && !bothBound) {
    errors.push('FABLE_RECEIPTS_BOTH_REQUIRED')
  }

  return {
    provided: true,
    requiredFields,
    expectedPins,
    receipts,
    bothBound,
    errors: [...new Set(errors)],
  }
}

/**
 * @param {object} [opts]
 * @param {string} [opts.root]
 * @param {string[]} [opts.allowedPaths]
 * @param {string[]} [opts.forbiddenPaths]
 * @param {string[]} [opts.allowedHostClasses]
 * @param {string[]} [opts.forbiddenHostClasses]
 * @param {Record<string,{path:string,sha256:string}>} [opts.specs]
 * @param {(args:string[])=>string} [opts.git]
 * @param {(path:string)=>Buffer|string} [opts.readFile]
 * @param {string} [opts.observedAt]
 * @param {string[]} [opts.changedPaths]
 * @param {Array<object>|Record<string,object>|null} [opts.fableReceipts]
 * @param {boolean} [opts.requireFableReceipts]
 * @param {boolean} [opts.requireLocalBytes]
 */
export function buildResolvedTarget(opts = {}) {
  const requestedRoot = resolve(opts.root ?? REPO_ROOT_DEFAULT)
  const errors = []
  let root = requestedRoot
  if (!existsSync(requestedRoot)) errors.push('ROOT_MISSING')
  else root = realpathSync(requestedRoot)

  const git = opts.git ?? ((args) => gitRead(root, args))
  const gitState = {
    topLevel: null,
    branch: null,
    head: null,
    upstream: null,
    upstreamCommit: null,
    divergence: null,
    porcelain: '',
  }
  try {
    gitState.topLevel = resolve(git(['rev-parse', '--show-toplevel']))
    gitState.branch = git(['rev-parse', '--abbrev-ref', 'HEAD'])
    gitState.head = git(['rev-parse', 'HEAD'])
    gitState.upstream = git([
      'rev-parse',
      '--abbrev-ref',
      '--symbolic-full-name',
      '@{upstream}',
    ])
    gitState.upstreamCommit = git(['rev-parse', '@{upstream}'])
    gitState.divergence = git([
      'rev-list',
      '--left-right',
      '--count',
      'HEAD...@{upstream}',
    ])
    gitState.porcelain = git([
      'status',
      '--porcelain=v1',
      '--untracked-files=all',
    ])
  } catch (error) {
    errors.push('GIT_STATE_UNREADABLE')
    gitState.error = error instanceof Error ? error.message : String(error)
  }

  if (gitState.topLevel && gitState.topLevel !== root)
    errors.push('FOREIGN_REPO_ROOT')
  if (gitState.branch === 'HEAD') errors.push('DETACHED_HEAD')
  if (gitState.branch && gitState.branch !== 'main')
    errors.push('BRANCH_NOT_MAIN')
  if (gitState.upstream && gitState.upstream !== 'origin/main') {
    errors.push('UPSTREAM_NOT_ORIGIN_MAIN')
  }
  if (gitState.head && !/^[a-f0-9]{40}$/u.test(gitState.head))
    errors.push('HEAD_NOT_FULL_SHA')
  if (gitState.head && gitState.upstreamCommit !== gitState.head) {
    errors.push('HEAD_UPSTREAM_MISMATCH')
  }
  if (gitState.divergence && !/^0\s+0$/u.test(gitState.divergence)) {
    errors.push('HEAD_UPSTREAM_DIVERGED')
  }

  const rawAllowed = opts.allowedPaths ?? [...DEFAULT_ALLOWED_PATHS]
  const rawForbidden = opts.forbiddenPaths ?? [...DEFAULT_FORBIDDEN_PATHS]
  const allowedPaths = rawAllowed.map(normalizePolicyPath)
  const forbiddenPaths = rawForbidden.map(normalizePolicyPath)
  if (!rawAllowed.length) errors.push('ALLOWED_PATHS_EMPTY')
  if (!rawForbidden.length) errors.push('FORBIDDEN_PATHS_EMPTY')
  if (allowedPaths.some((value) => value == null))
    errors.push('ALLOWED_PATH_INVALID')
  if (forbiddenPaths.some((value) => value == null))
    errors.push('FORBIDDEN_PATH_INVALID')
  const allowed = [...new Set(allowedPaths.filter(Boolean))]
  const forbidden = [...new Set(forbiddenPaths.filter(Boolean))]
  const collisions = allowed.flatMap((a) =>
    forbidden
      .filter((f) => pathPoliciesOverlap(a, f))
      .map((f) => ({ allowed: a, forbidden: f })),
  )
  if (collisions.length) errors.push('PATH_POLICY_OVERLAP')
  const changed = [
    ...new Set(
      (opts.changedPaths ?? parseChangedPaths(gitState.porcelain)).map((path) =>
        normalizePolicyPath(path),
      ),
    ),
  ].filter(Boolean)
  const outsideAllowed = changed.filter(
    (path) => !allowed.some((policy) => pathMatchesPolicy(path, policy)),
  )
  const changedForbidden = changed.filter((path) =>
    forbidden.some((policy) => pathMatchesPolicy(path, policy)),
  )
  if (outsideAllowed.length) errors.push('CHANGED_PATH_OUTSIDE_ALLOWED')
  if (changedForbidden.length) errors.push('CHANGED_PATH_FORBIDDEN')

  const allowedHostClasses = [
    ...new Set(opts.allowedHostClasses ?? ['LOCAL', 'STAGING']),
  ]
  const forbiddenHostClasses = [
    ...new Set(opts.forbiddenHostClasses ?? ['PRODUCTION', 'UNKNOWN_REMOTE']),
  ]
  if (
    [...allowedHostClasses, ...forbiddenHostClasses].some(
      (value) => !HOST_CLASSES.includes(value),
    )
  ) {
    errors.push('HOST_CLASS_INVALID')
  }
  if (
    allowedHostClasses.some((value) => forbiddenHostClasses.includes(value))
  ) {
    errors.push('HOST_CLASS_OVERLAP')
  }

  const readFile = opts.readFile ?? readFileSync
  const specs = Object.entries(opts.specs ?? PINNED_SPEC_HASHES).map(
    ([id, spec]) => {
      const abs = resolve(root, spec.path)
      const rel = relative(root, abs)
      let actualSha256 = null
      let class_ = 'MISSING'
      if (rel.startsWith('..') || isAbsolute(rel)) {
        class_ = 'FOREIGN_PATH'
        errors.push('SPEC_PATH_FOREIGN')
      } else if (existsSync(abs)) {
        actualSha256 = sha256Hex(readFile(abs))
        class_ = actualSha256 === spec.sha256 ? 'PIN_MATCH' : 'PIN_MISMATCH'
        if (class_ === 'PIN_MISMATCH') errors.push('SPEC_HASH_MISMATCH')
      } else {
        errors.push('SPEC_FILE_MISSING')
      }
      return {
        id,
        path: spec.path,
        expectedSha256: spec.sha256,
        actualSha256,
        class: class_,
      }
    },
  )

  const observedAt = opts.observedAt ?? new Date().toISOString()
  if (!isStrictIsoTimestamp(observedAt)) errors.push('OBSERVED_AT_INVALID')

  const fableBinding = bindFableReceipts({
    fableReceipts: opts.fableReceipts,
    requireFableReceipts: opts.requireFableReceipts,
    requireLocalBytes: opts.requireLocalBytes,
    root,
    readFile,
  })
  errors.push(...fableBinding.errors)

  const binding = {
    repo: {
      root,
      branch: gitState.branch,
      head: gitState.head,
      upstream: gitState.upstream,
      upstreamCommit: gitState.upstreamCommit,
      divergence: gitState.divergence,
      gitTopLevel: gitState.topLevel,
    },
    pathPolicy: {
      allowed,
      forbidden,
      changed,
      outsideAllowed,
      changedForbidden,
    },
    hostPolicy: {
      allowed: allowedHostClasses,
      forbidden: forbiddenHostClasses,
    },
    specs,
    fableReceipts: {
      provided: fableBinding.provided,
      requiredFields: fableBinding.requiredFields,
      expectedPins: fableBinding.expectedPins,
      receipts: fableBinding.receipts,
      bothBound: fableBinding.bothBound,
    },
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    observedAt,
    ...binding,
    bindingSha256: sha256Hex(JSON.stringify(binding)),
    checks: {
      pathPolicyCollisions: collisions,
      headMatchesUpstream: gitState.head === gitState.upstreamCommit,
      divergenceClean: /^0\s+0$/u.test(gitState.divergence ?? ''),
      changedPathFence:
        outsideAllowed.length === 0 && changedForbidden.length === 0,
      fableReceiptsBound: fableBinding.bothBound,
    },
    errors: [...new Set(errors)],
    verdict: errors.length ? 'FAIL' : 'PASS',
    nonMutating: true,
  }
}

function repeated(argv, flag) {
  const out = []
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === flag && argv[i + 1]) out.push(argv[++i])
  }
  return out
}

export function main(argv = process.argv.slice(2)) {
  const valueAfter = (flag) => {
    const index = argv.indexOf(flag)
    return index >= 0 ? argv[index + 1] : undefined
  }
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(
      'Usage: node qa/evidence/validate-resolved-target.mjs [--root PATH] [--allowed PATH] [--forbidden PATH]\n',
    )
    return 0
  }
  const report = buildResolvedTarget({
    root: valueAfter('--root'),
    allowedPaths: repeated(argv, '--allowed').length
      ? repeated(argv, '--allowed')
      : undefined,
    forbiddenPaths: repeated(argv, '--forbidden').length
      ? repeated(argv, '--forbidden')
      : undefined,
    allowedHostClasses: repeated(argv, '--allowed-host-class').length
      ? repeated(argv, '--allowed-host-class')
      : undefined,
    forbiddenHostClasses: repeated(argv, '--forbidden-host-class').length
      ? repeated(argv, '--forbidden-host-class')
      : undefined,
  })
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  return report.verdict === 'PASS' ? 0 : 1
}

const isDirect =
  Boolean(process.argv[1]) &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
if (isDirect) process.exitCode = main()
