/**
 * Flow Ultimate data loaders — server-side only.
 * Reads public/flow-data JSON (static bundle). Future: swap to DB migration 012.
 * NEVER import mysql / db clients from the React graph components.
 */

import { createServerFn } from '@tanstack/react-start'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'

import type { FlowDataBundle } from '#/components/flow-ultimate/types'

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
 * boardId is accepted for future per-board DB routing; currently one shared bundle.
 */
export const getFlowDataBundleFn = createServerFn({ method: 'GET' })
  .validator(boardArgs)
  .handler(async (): Promise<FlowDataBundle> => {
    return readJsonFile<FlowDataBundle>('data-bundle.json')
  })

/**
 * Optional ultimate graph (pages/endpoints). Large; not required for v1 canvas modes.
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
export const getFlowDataMetaFn = createServerFn({ method: 'GET' }).handler(
  async (): Promise<{
    source: 'file'
    bundle: boolean
    graph: boolean
    dir: string
  }> => {
    const dir = flowDataDir()
    let bundle = false
    let graph = false
    try {
      await readFile(path.join(dir, 'data-bundle.json'), 'utf8')
      bundle = true
    } catch {
      /* missing */
    }
    try {
      await readFile(path.join(dir, 'graph.json'), 'utf8')
      graph = true
    } catch {
      /* missing */
    }
    return { source: 'file', bundle, graph, dir: 'public/flow-data' }
  },
)
