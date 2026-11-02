import { describe, it, vi } from 'vitest'
import type { RunResult } from './lib/types'

/**
 * The eval suite: every task is given to a real model inside Cubex's real agent loop (ChatService), the way a
 * person would type it, and the workspace is judged afterwards by the task's check. See evals/README.md.
 *
 * ChatService's neighbours are replaced the way the ChatService tests replace them (data folder, task records,
 * settings, cost, logger); the loop, the tools, the shell and the system prompt are the app's own.
 */
vi.mock('../src/main/paths', async () => {
  const { state } = await import('./lib/harnessState')
  return { dataDir: () => state.dataRoot }
})
vi.mock('../src/main/db', async () => {
  const { state } = await import('./lib/harnessState')
  return {
    conversationRepo: {
      get: (id: string) => {
        const workspacePath = state.workspaces.get(id)
        return workspacePath ? { id, workspacePath, messages: [] } : null
      },
      update: () => undefined
    },
    usageRepo: { spendSince: () => 0 }
  }
})
vi.mock('../src/main/config', async () => {
  const { state } = await import('./lib/harnessState')
  return {
    getSettings: () => ({
      general: { workspacePath: [...state.workspaces.values()][0] ?? '' },
      mcpServers: [], hooks: [], privacy: { localOnly: false }, shell: { preferred: 'auto' }
    })
  }
})
vi.mock('../src/main/cost', async () => {
  const { state } = await import('./lib/harnessState')
  return { recordUsage: (row: (typeof state.usage)[number]) => { state.usage.push(row) } }
})
vi.mock('../src/main/logger', () => ({ logger: { info: () => undefined, error: () => undefined, warn: () => undefined } }))

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { state } from './lib/harnessState'
import { configOf, targetFromEnv } from './lib/provider'
import { markdownSummary, writeResults } from './lib/report'
import { runTask } from './lib/runTask'
import { loadTasks } from './lib/tasks'
import { hasProgram } from './lib/workspace'
import { removeFolder } from '../src/main/testing/removeFolder'

const positive = (name: string, fallback: number): number => {
  const value = Number(process.env[name])
  return Number.isInteger(value) && value > 0 ? value : fallback
}

describe('eval suite', () => {
  it('runs the tasks against the model', async () => {
    const target = targetFromEnv()
    const filter = (process.env.CUBEX_EVAL_TASKS ?? '').split(',').map((slug) => slug.trim()).filter(Boolean)
    const repeat = positive('CUBEX_EVAL_REPEAT', 1)
    const concurrency = positive('CUBEX_EVAL_CONCURRENCY', 2)

    // A task that needs a program this machine lacks is left out of the run, and said so.
    const available = new Map<string, boolean>()
    const needs = (program: string): boolean => {
      if (!available.has(program)) available.set(program, hasProgram(program))
      return available.get(program) === true
    }
    const tasks = loadTasks(filter)
    const runnable = tasks.filter((task) => task.requires.every(needs))
    const skipped = tasks.filter((task) => !runnable.includes(task)).map((task) => task.slug)

    state.dataRoot = mkdtempSync(join(tmpdir(), 'cubex-eval-data-'))
    const startedAt = Date.now()
    const jobs = runnable.flatMap((task) => Array.from({ length: repeat }, (_, i) => ({ task, repeat: i + 1 })))
    const results: RunResult[] = []
    let next = 0
    const worker = async (): Promise<void> => {
      for (;;) {
        const job = jobs[next++]
        if (!job) return
        const result = await runTask(job.task, job.repeat, target)
        results.push(result)
        const note = result.passed ? 'pass' : `FAIL (${result.failure ?? result.check?.output.split('\n')[0] ?? 'check failed'})`.slice(0, 160)
        console.log(`[${results.length}/${jobs.length}] ${job.task.slug}${repeat > 1 ? ` #${job.repeat}` : ''}: ${note} - ${result.rounds} rounds, ${result.toolCalls.total} tool calls, ${(result.durationMs / 1000).toFixed(1)} s`)
      }
    }
    try {
      await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, worker))
    } finally {
      await removeFolder(state.dataRoot)
    }

    // Task order, then run number, whatever order the workers finished in.
    const order = new Map(runnable.map((task, i) => [task.slug, i]))
    results.sort((a, b) => (order.get(a.task)! - order.get(b.task)!) || a.repeat - b.repeat)
    const file = writeResults(configOf(target, runnable.map((task) => task.slug), repeat, concurrency), results, skipped, startedAt)
    console.log(`\nModel: ${target.model} (${target.kind})\n\n${markdownSummary(results, skipped)}\n\nResults: ${file}`)
  }, positive('CUBEX_EVAL_SUITE_TIMEOUT_MIN', 120) * 60_000)
})
