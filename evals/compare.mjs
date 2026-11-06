#!/usr/bin/env node
/**
 * Compares eval result files run on the same tasks: pass rate, tokens, money and time, with a paired test over the tasks,
 * so a difference can be told from noise.
 *
 *   node evals/compare.mjs <before.json> <after.json> [--input 2.5 --output 15 --cached 0.25 --write 3]
 *
 * Runs lost to the provider itself (busy, unavailable) are counted apart: they say nothing about the harness unless the
 * harness is what should have survived them, so the pass rate is shown both over every run and over the runs that got an
 * answer from the model.
 */
import { readFileSync } from 'node:fs'

const args = process.argv.slice(2)
const flag = (name, fallback) => {
  const at = args.indexOf(`--${name}`)
  return at === -1 ? fallback : Number(args[at + 1])
}
const files = args.filter((arg, index) => !arg.startsWith('--') && !args[index - 1]?.startsWith('--'))
if (files.length !== 2) {
  console.error('Usage: node evals/compare.mjs <before.json> <after.json> [--input N --output N --cached N --write N]')
  process.exit(2)
}

const rates = { input: flag('input', 0), output: flag('output', 0), cached: flag('cached', flag('input', 0)), write: flag('write', flag('input', 0)) }

/** What a run cost. `input` includes the cache reads and writes, which are billed at their own rates. */
function costOf(tokens) {
  const read = tokens.cacheRead ?? 0
  const written = tokens.cacheWrite ?? 0
  const plain = Math.max(0, tokens.input - read - written)
  return (plain * rates.input + read * rates.cached + written * rates.write + tokens.output * rates.output) / 1_000_000
}

const lostToProvider = (run) => !run.passed && run.rounds <= 1 && run.toolCalls.total === 0 && (run.tokens.input ?? 0) === 0

function summarize(file) {
  const report = JSON.parse(readFileSync(file, 'utf8'))
  const runs = report.results
  const answered = runs.filter((run) => !lostToProvider(run))
  const sum = (pick, list = runs) => list.reduce((total, run) => total + pick(run), 0)
  const byTask = new Map()
  for (const run of runs) {
    const entry = byTask.get(run.task) ?? { passed: 0, runs: 0, input: 0, cost: 0, ms: 0, answered: 0 }
    entry.passed += run.passed ? 1 : 0
    entry.runs++
    entry.input += run.tokens.input
    entry.cost += costOf(run.tokens)
    entry.ms += run.durationMs
    entry.answered += lostToProvider(run) ? 0 : 1
    byTask.set(run.task, entry)
  }
  return {
    file, model: report.config?.model, runs: runs.length, passed: sum((run) => (run.passed ? 1 : 0)),
    answered: answered.length, answeredPassed: sum((run) => (run.passed ? 1 : 0), answered),
    timedOut: sum((run) => (run.timedOut ? 1 : 0)), lost: runs.length - answered.length,
    input: sum((run) => run.tokens.input), cached: sum((run) => run.tokens.cacheRead ?? 0), written: sum((run) => run.tokens.cacheWrite ?? 0),
    output: sum((run) => run.tokens.output), cost: sum((run) => costOf(run.tokens)), toolCalls: sum((run) => run.toolCalls.total),
    toolErrors: sum((run) => run.toolErrors), retries: sum((run) => run.retries ?? 0), ms: sum((run) => run.durationMs), byTask
  }
}

/** A two-sided sign test over tasks: how likely this many tasks would move one way by chance. */
function signTest(wins, losses) {
  const n = wins + losses
  if (n === 0) return 1
  const k = Math.min(wins, losses)
  let tail = 0
  let term = 0.5 ** n
  for (let i = 0; i <= k; i++) {
    tail += term
    term = term * (n - i) / (i + 1)
  }
  return Math.min(1, 2 * tail)
}

const [a, b] = files.map(summarize)
const pct = (part, whole) => (whole ? `${((part / whole) * 100).toFixed(0)}%` : 'n/a')
const change = (before, after) => (before ? `${(((after - before) / before) * 100 >= 0 ? '+' : '')}${(((after - before) / before) * 100).toFixed(0)}%` : 'n/a')
const k = (value) => (value >= 1e6 ? `${(value / 1e6).toFixed(2)}M` : `${(value / 1e3).toFixed(1)}k`)
const row = (label, before, after, delta = '') => console.log(`| ${label} | ${before} | ${after} | ${delta} |`)

console.log(`\n### ${b.model ?? a.model ?? ''}: ${a.runs} runs before, ${b.runs} after\n`)
console.log('| | Before | After | Change |\n| --- | --- | --- | --- |')
row('Passed, all runs', `${a.passed}/${a.runs} (${pct(a.passed, a.runs)})`, `${b.passed}/${b.runs} (${pct(b.passed, b.runs)})`)
row('Passed, runs the model answered', `${a.answeredPassed}/${a.answered} (${pct(a.answeredPassed, a.answered)})`, `${b.answeredPassed}/${b.answered} (${pct(b.answeredPassed, b.answered)})`)
row('Lost to the provider', a.lost, b.lost)
row('Timed out', a.timedOut, b.timedOut)
row('Input tokens per passed run', k(a.input / Math.max(1, a.passed)), k(b.input / Math.max(1, b.passed)), change(a.input / Math.max(1, a.passed), b.input / Math.max(1, b.passed)))
row('Input tokens, total', k(a.input), k(b.input), change(a.input, b.input))
row('Served from cache', `${k(a.cached)} (${pct(a.cached, a.input)})`, `${k(b.cached)} (${pct(b.cached, b.input)})`)
row('Output tokens, total', k(a.output), k(b.output), change(a.output, b.output))
if (rates.input) {
  row('Cost, total', `$${a.cost.toFixed(3)}`, `$${b.cost.toFixed(3)}`, change(a.cost, b.cost))
  row('Cost per passed run', `$${(a.cost / Math.max(1, a.passed)).toFixed(4)}`, `$${(b.cost / Math.max(1, b.passed)).toFixed(4)}`, change(a.cost / Math.max(1, a.passed), b.cost / Math.max(1, b.passed)))
}
row('Tool calls per run', (a.toolCalls / a.runs).toFixed(1), (b.toolCalls / b.runs).toFixed(1))
row('Tool errors per run', (a.toolErrors / a.runs).toFixed(2), (b.toolErrors / b.runs).toFixed(2))
row('Time per run', `${(a.ms / a.runs / 1000).toFixed(0)}s`, `${(b.ms / b.runs / 1000).toFixed(0)}s`, change(a.ms, b.ms))

let up = 0
let down = 0
let cheaper = 0
let dearer = 0
const moved = []
for (const [task, before] of a.byTask) {
  const after = b.byTask.get(task)
  if (!after) continue
  if (after.passed > before.passed) up++
  if (after.passed < before.passed) down++
  if (after.cost < before.cost) cheaper++
  if (after.cost > before.cost) dearer++
  if (after.input < before.input && !rates.input) cheaper++
  if (after.passed !== before.passed) moved.push(`${task} ${before.passed}/${before.runs} -> ${after.passed}/${after.runs}`)
}
console.log(`\nPass rate by task: ${up} better, ${down} worse (sign test p = ${signTest(up, down).toFixed(3)}).`)
if (rates.input) console.log(`Cost by task: ${cheaper} cheaper, ${dearer} dearer (sign test p = ${signTest(cheaper, dearer).toFixed(4)}).`)
if (moved.length) console.log(`Tasks that moved: ${moved.join('; ')}.`)
