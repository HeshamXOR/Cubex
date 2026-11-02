import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AIProvider, AIRequest, AIStreamEvent, ToolCall } from '@core/types'
import type { TaskSpec } from './types'
import { listFiles, solutionDir } from './workspace'

/**
 * A provider that needs no network: it replays a task's reference solution through the real agent loop, so the
 * whole pipeline (tools, permissions, events, check, report) can be exercised, and every task shown to be solvable.
 *
 *   round 1  read_file for each file the solution replaces
 *   round 2  write_file for each file in the task's solution/ folder
 *   round 3  run_command with stub.command from task.json, when it has one
 *   last     the answer from stub.answer, or "Done."
 */
export function createStubProvider(task: TaskSpec, workspace: string): AIProvider {
  const dir = solutionDir(task)
  const solution = existsSync(dir) ? listFiles(dir) : []
  const replaced = solution.filter((rel) => existsSync(join(workspace, ...rel.split('/'))))
  const rounds: ToolCall[][] = []
  if (replaced.length) rounds.push(replaced.map((rel, i) => ({ id: `r${i}`, name: 'read_file', input: { path: rel } }) as ToolCall))
  if (solution.length) {
    rounds.push(solution.map((rel, i) => ({
      id: `w${i}`, name: 'write_file', input: { path: rel, content: readFileSync(join(dir, ...rel.split('/')), 'utf8') }
    }) as ToolCall))
  }
  if (task.stub.command) rounds.push([{ id: 'c0', name: 'run_command', input: { command: task.stub.command } } as ToolCall])

  // CUBEX_EVAL_STUB_DELAY_MS slows every round, to exercise the timeout path.
  const delayMs = Number(process.env.CUBEX_EVAL_STUB_DELAY_MS) || 0
  let used = 0
  return {
    id: 'eval-stub', name: 'Stub', kind: 'mock',
    async *streamMessage(request: AIRequest): AsyncGenerator<AIStreamEvent> {
      if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs))
      const step = rounds[used++]
      const inputTokens = Math.ceil(JSON.stringify(request.messages).length / 4)
      if (step) for (const toolCall of step) yield { type: 'tool_call', toolCall }
      else yield { type: 'text_delta', text: task.stub.answer ?? 'Done.' }
      yield { type: 'usage', usage: { inputTokens, outputTokens: step ? 40 : 10, totalTokens: inputTokens + (step ? 40 : 10) } }
    },
    async getModels() { return [] },
    async sendMessage() { throw new Error('The stub provider only streams.') },
    supports() { return true },
    async validateConfiguration() { return { ok: true } }
  } as unknown as AIProvider
}
