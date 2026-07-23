/**
 * Authenticated GET /api/rebuild-parity — JSON read-only for public UI later.
 * Auth follows api.healthz: bearer principal (non-PUBLIC) OR session cookie.
 * Unauthenticated → 401. Never crashes when 009/010 tables are missing
 * (returns available:false / REBUILD_DATA_TABLES_NOT_MIGRATED).
 *
 * Query:
 *   ?view=parity|feature360|blindspot  (default parity)
 *   &boardId=mfs-rebuild
 *   &feature_id=FEAT-MEDITATION  (feature360)
 *   &term=meditation             (blindspot)
 */
import { createFileRoute } from '@tanstack/react-router'

import { envVar } from '#/server/db'
import {
  extractBearerFromHeaders,
  principalFromSession,
  resolveBearerPrincipal,
} from '#/server/rbac'
import { sessionUser } from '#/server/auth-store'
import { SESSION_COOKIE } from '#/server/auth'
import {
  handleGetFeature360,
  handleGetRebuildParity,
  handleTraceBlindspot,
} from '#/server/rebuild-parity-mcp'

function parseCookie(header: string | null, name: string): string | undefined {
  if (!header) return undefined
  for (const part of header.split(';')) {
    const [k, ...rest] = part.trim().split('=')
    if (k === name) return decodeURIComponent(rest.join('='))
  }
  return undefined
}

function authDenied(
  message: 'authentication required' | 'invalid bearer' | 'insufficient authority' = 'authentication required',
): { ok: false; status: number; code: string; message: string } {
  return {
    ok: false,
    status: 401,
    code: 'AUTHORIZATION_REQUIRED',
    message,
  }
}

/** Same authority gate as healthz: bearer non-PUBLIC or session non-PUBLIC. */
export async function rebuildParityAuthGuard(request: Request): Promise<
  | { ok: true; actor: { actorId: string; role: string } }
  | { ok: false; status: number; code: string; message: string }
> {
  try {
    const raw = extractBearerFromHeaders(request.headers)
    if (raw) {
      const { principal } = await resolveBearerPrincipal(raw, {
        envWriteToken: envVar('CAIRN_WRITE_TOKEN') ?? null,
        envBearerJson: envVar('CAIRN_BEARER_PRINCIPALS_JSON') ?? null,
      })
      if (principal && principal.role !== 'PUBLIC') {
        return { ok: true, actor: { actorId: principal.actorId, role: principal.role } }
      }
      return authDenied('invalid bearer')
    }

    const token = parseCookie(request.headers.get('cookie'), SESSION_COOKIE)
    if (token) {
      try {
        const user = await sessionUser(token)
        const principal = principalFromSession(user)
        if (principal && principal.role !== 'PUBLIC') {
          return { ok: true, actor: { actorId: principal.actorId, role: principal.role } }
        }
        if (principal && principal.role === 'PUBLIC') {
          return authDenied('insufficient authority')
        }
      } catch {
        return authDenied('invalid bearer')
      }
    }

    return authDenied('authentication required')
  } catch {
    return authDenied('authentication required')
  }
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  })
}

export async function rebuildParityGetHandler(request: Request): Promise<Response> {
  const auth = await rebuildParityAuthGuard(request)
  if (!auth.ok) {
    return jsonResponse(
      { ok: false, error: auth.message, code: auth.code },
      auth.status,
    )
  }

  try {
    const url = new URL(request.url)
    const view = (url.searchParams.get('view') ?? 'parity').trim().toLowerCase()
    const boardId = (url.searchParams.get('boardId') ?? '').trim() || undefined
    const featureId =
      (url.searchParams.get('feature_id') ?? url.searchParams.get('featureId') ?? '').trim() ||
      undefined
    const term = (url.searchParams.get('term') ?? '').trim() || undefined
    const historyLimitRaw = url.searchParams.get('historyLimit')
    const historyLimit = historyLimitRaw ? Number(historyLimitRaw) : undefined

    let payload: unknown
    if (view === 'feature360' || view === 'feature_360' || view === 'feature-360') {
      payload = await handleGetFeature360({
        boardId,
        feature_id: featureId,
      })
    } else if (view === 'blindspot' || view === 'trace' || view === 'trace_blindspot') {
      payload = await handleTraceBlindspot({ boardId, term })
    } else {
      payload = await handleGetRebuildParity({
        boardId,
        historyLimit:
          historyLimit != null && Number.isFinite(historyLimit) ? historyLimit : undefined,
      })
    }

    // DATA_REBUILD contract: expose lineage/parity/features/boardId at the TOP
    // level (acceptance + public UI consumers). Keep nested `data` for older
    // clients that unwrap the envelope.
    const payloadObj =
      payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : null
    const topBoardId =
      (payloadObj && typeof payloadObj.boardId === 'string' && payloadObj.boardId) ||
      boardId ||
      null
    const isParityView =
      view === 'parity' || view === '' || (!view.includes('feature') && !view.includes('blind') && !view.includes('trace'))
    const isFeatureView =
      view === 'feature360' || view === 'feature_360' || view === 'feature-360'

    return jsonResponse(
      {
        ok: true,
        view,
        actor: { actorId: auth.actor.actorId, role: auth.actor.role },
        // Contract keys (any one satisfies DATA-LINEAGE-REBUILD-PARITY-API)
        boardId: topBoardId,
        ...(isParityView
          ? {
              parity: payload,
              // lineage alias: parity rollup is the lineage summary surface
              lineage: payload,
            }
          : {}),
        ...(isFeatureView ? { features: payload } : {}),
        // Promote payload fields so BlindspotTracer / feature360 clients that
        // read body.available / body.boardId (not body.data.*) keep working.
        ...(payloadObj ?? {}),
        data: payload,
      },
      200,
    )
  } catch {
    // Never echo raw errors / secrets
    return jsonResponse(
      {
        ok: false,
        error: 'rebuild parity read failed',
        code: 'REBUILD_PARITY_UNAVAILABLE',
      },
      503,
    )
  }
}

export const Route = createFileRoute('/api/rebuild-parity')({
  server: {
    handlers: {
      GET: ({ request }) => rebuildParityGetHandler(request),
    },
  },
})
