/**
 * Flow Ultimate data loaders — server-side only.
 * Thin switch: resolveFlowDataBundle (MySQL XOR full file). Never field-merge.
 * NEVER import mysql / db clients from the React graph components.
 */

import { createServerFn } from '@tanstack/react-start'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'

import type { FlowDataBundle } from '#/components/flow-ultimate/types'
import {
  resolveFlowDataBundle,
  type FlowBundleMeta,
} from '#/server/flow-data-materializer'

const boardArgs = z.object({
  boardId: z.string().min(1).optional(),
})

function flowDataDir(): string {
  // Vite/public is served from process.cwd()/public in both dev and preview.
  return path.join(process.cwd(), 'public', 'flow-data')
}

async function readJsonFile<T>(name: string): Promise<T> {
  const abs = path.join(flowDataDir(), name)
  const raw = await readFile(abs, 'utf8')
  return JSON.parse(raw) as T
}

/**
 * Load the interactive workflow data bundle (projects, premium steps, features, tasks, apis).
 * Prefer MySQL (010+ required) when available; else whole-file public/flow-data fallback.
 * boardId scopes lineage rows (default mfs-rebuild).
 */
export const getFlowDataBundleFn = createServerFn({ method: 'GET' })
  .validator(boardArgs)
  .handler(async ({ data }): Promise<FlowDataBundle> => {
    const boardId = data?.boardId
    const { bundle } = await resolveFlowDataBundle({
      boardId,
      preferMysql: true,
    })
    return bundle
  })

/**
 * Optional ultimate graph (pages/endpoints). Large; not required for v1 canvas modes.
 * Still file-only (not part of FlowDataBundle materializer).
 */
export type FlowUltimateGraphFile = {
  generated_at?: string
  label_id?: string
  nodes: Array<Record<string, string | number | boolean | null>>
  edges: Array<Record<string, string | number | boolean | null>>
}

export const getFlowGraphFn = createServerFn({ method: 'GET' })
  .validator(boardArgs)
  .handler(async (): Promise<FlowUltimateGraphFile> => {
    return readJsonFile<FlowUltimateGraphFile>('graph.json')
  })

/** Lightweight metadata for health / readiness without shipping full graph. */
export type FlowDataMetaFnResult = {
  source: FlowBundleMeta['source'] | 'file'
  bundle: boolean
  graph: boolean
  dir: string
  sourceHash?: string
  availability?: FlowBundleMeta['availability']
  code?: FlowBundleMeta['code']
  stale?: boolean
  revision?: number | null
  boardId?: string
}

export const getFlowDataMetaFn = createServerFn({ method: 'GET' })
  .validator(boardArgs)
  .handler(async ({ data }): Promise<FlowDataMetaFnResult> => {
    const dir = flowDataDir()
    let graph = false
    try {
      await readFile(path.join(dir, 'graph.json'), 'utf8')
      graph = true
    } catch {
      /* missing */
    }

    try {
      const load = await resolveFlowDataBundle({
        boardId: data?.boardId,
        preferMysql: true,
      })
      return {
        source: load.meta.source === 'empty' ? 'file' : load.meta.source,
        bundle: true,
        graph,
        dir: 'public/flow-data',
        sourceHash: load.meta.sourceHash,
        availability: load.meta.availability,
        code: load.meta.code,
        stale: load.meta.freshness.stale,
        revision: load.meta.revision,
        boardId: load.meta.boardId,
      }
    } catch {
      let bundle = false
      try {
        await readFile(path.join(dir, 'data-bundle.json'), 'utf8')
        bundle = true
      } catch {
        /* missing */
      }
      return {
        source: 'file',
        bundle,
        graph,
        dir: 'public/flow-data',
      }
    }
  })
