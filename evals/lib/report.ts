import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { RunConfig, RunResult } from './types'
import { EVALS_ROOT } from './tasks'

export interface TaskSummary {
  task: string
  runs: number
  passes: number
  rounds: number
  toolCalls: number
  toolErrors: number
  inputTokens: number
  outputTokens: number
  seconds: number
}

const mean = (values: number[]): number => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0)

/** One row per task, averaged over its runs, in task order. */
export function summarize(results: RunResult[]): TaskSummary[] {
  const slugs = [...new Set(results.map((r) => r.task))]
  return slugs.map((task) => {
    const runs = results.filter((r) => r.task === task)
    return {
      task, runs: runs.length, passes: runs.filter((r) => r.passed).length,
      rounds: mean(runs.map((r) => r.rounds)),
      toolCalls: mean(runs.map((r) => r.toolCalls.total)),
      toolErrors: mean(runs.map((r) => r.toolErrors)),
      inputTokens: mean(runs.map((r) => r.tokens.input)),
      outputTokens: mean(runs.map((r) => r.tokens.output)),
      seconds: mean(runs.map((r) => r.durationMs / 1000))
    }
  })
}

const num = (value: number, digits = 1): string => (Number.isInteger(value) ? String(value) : value.toFixed(digits))
const tokens = (value: number): string => (value >= 10_000 ? `${(value / 1000).toFixed(1)}k` : String(Math.round(value)))

/** The table printed at the end of a run, and the line that sums it up. Averages are per run. */
export function markdownSummary(results: RunResult[], skipped: string[] = []): string {
  const rows = summarize(results)
  const lines = [
    '| Task | Pass | Rounds | Tool calls | Tool errors | Input tok | Output tok | Time (s) |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |'
  ]
  for (const row of rows) {
    lines.push(`| ${row.task} | ${row.passes}/${row.runs} ${row.passes === row.runs ? 'PASS' : row.passes === 0 ? 'FAIL' : 'flaky'} | ${num(row.rounds)} | ${num(row.toolCalls)} | ${num(row.toolErrors)} | ${tokens(row.inputTokens)} | ${tokens(row.outputTokens)} | ${num(row.seconds)} |`)
  }
  const total = (pick: (r: RunResult) => number): number => results.reduce((sum, r) => sum + pick(r), 0)
  const passed = results.filter((r) => r.passed).length
  lines.push(
    `| **Total** | **${passed}/${results.length}** | ${num(mean(results.map((r) => r.rounds)))} | ${num(mean(results.map((r) => r.toolCalls.total)))} | ${num(mean(results.map((r) => r.toolErrors)))} | ${tokens(total((r) => r.tokens.input))} | ${tokens(total((r) => r.tokens.output))} | ${num(total((r) => r.durationMs) / 1000)} |`
  )
  const pct = results.length ? Math.round((passed / results.length) * 100) : 0
  const out = [lines.join('\n'), '', `Pass rate ${pct}% (${passed} of ${results.length} runs). Rounds, tool calls and errors are averages per run; tokens and time in the total row are sums.`]
  const failed = results.filter((r) => !r.passed)
  if (failed.length) {
    out.push('', 'Failures:')
    for (const run of failed) {
      const why = run.failure ?? run.check?.output.split('\n').find((line) => line.trim()) ?? 'the check failed'
      out.push(`- ${run.task}${run.repeat > 1 ? ` (run ${run.repeat})` : ''}: ${why.slice(0, 200)}`)
    }
  }
  if (skipped.length) out.push('', `Skipped (a required program is missing): ${skipped.join(', ')}.`)
  return out.join('\n')
}

function gitInfo(): { commit?: string; dirty?: boolean } {
  const run = (args: string[]): string | undefined => {
    const result = spawnSync('git', args, { cwd: EVALS_ROOT, encoding: 'utf8', timeout: 10_000 })
    return result.status === 0 ? result.stdout.trim() : undefined
  }
  const commit = run(['rev-parse', '--short', 'HEAD'])
  const status = run(['status', '--porcelain'])
  return { ...(commit ? { commit } : {}), ...(status !== undefined ? { dirty: status.length > 0 } : {}) }
}

/** Write evals/results/<timestamp>-<model>.json and return its path. */
export function writeResults(config: RunConfig, results: RunResult[], skipped: string[], startedAt: number): string {
  const dir = join(EVALS_ROOT, 'results')
  mkdirSync(dir, { recursive: true })
  const stamp = new Date(startedAt).toISOString().replace(/[:.]/g, '-')
  const model = config.model.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 60)
  const file = join(dir, `${stamp}-${model}.json`)
  const passed = results.filter((r) => r.passed).length
  const body = {
    startedAt: new Date(startedAt).toISOString(),
    durationMs: Date.now() - startedAt,
    config,
    git: gitInfo(),
    node: process.version,
    totals: {
      runs: results.length, passed, passRate: results.length ? passed / results.length : 0,
      inputTokens: results.reduce((sum, r) => sum + r.tokens.input, 0),
      outputTokens: results.reduce((sum, r) => sum + r.tokens.output, 0)
    },
    skipped,
    tasks: summarize(results),
    results
  }
  writeFileSync(file, JSON.stringify(body, null, 2))
  return file
}
