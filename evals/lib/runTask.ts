import { copyFileSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_RETRY_POLICY } from '@core/types'
import type { AIProvider } from '@core/types'
import type { ChatEvent, ChatStartRequest } from '@shared/ipc'
import { ChatService } from '../../src/main/ChatService'
import type { ProviderManager } from '../../src/main/ProviderManager'
import { removeFolder } from '../../src/main/testing/removeFolder'
import { runCheck } from './check'
import { state } from './harnessState'
import { withFaults } from './faults'
import { probed, type EvalTarget, type RequestProbe } from './provider'
import type { RunResult, TaskSpec } from './types'
import { changedFiles, copyFixture, snapshot } from './workspace'

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** How long a turn that was asked to stop gets to wind down before the run is given up on. */
const STOP_GRACE_MS = 15_000

const ANSWER_FOR_QUESTION = 'Use your best judgment and carry on; nobody is available to answer.'

/** Plausible rules that say nothing about these tasks, to measure what notes cost when they do not help. */
const NOISE_NOTES = [
  'Prefer small commits that do one thing.', 'Keep functions under about 40 lines.', 'Use descriptive names over comments.',
  'Do not add a dependency without saying why.', 'Keep error messages specific about what failed.', 'Avoid global state.',
  'Dates are stored in UTC.', 'Log at info level only for what an operator acts on.', 'New public functions get a short doc comment.',
  'Feature flags live in one place and are removed after launch.'
]

/**
 * The project memory a run starts with: the task's own memory.md, unless CUBEX_EVAL_MEMORY=off takes it away to measure what
 * the note does. CUBEX_EVAL_MEMORY=noise gives every task notes that have nothing to do with it, to measure what they cost.
 */
function seedMemory(task: TaskSpec, workspace: string): void {
  const setting = process.env.CUBEX_EVAL_MEMORY
  const target = join(workspace, '.cubex', 'memory.md')
  if (setting === 'noise') {
    mkdirSync(join(workspace, '.cubex'), { recursive: true })
    writeFileSync(target, `# Project memory\n\n${NOISE_NOTES.map((note) => `- ${note}`).join('\n')}\n`)
    return
  }
  const own = join(task.dir, 'memory.md')
  if (setting === 'off' || !existsSync(own)) return
  mkdirSync(join(workspace, '.cubex'), { recursive: true })
  copyFileSync(own, target)
}

/**
 * One run of one task: a fresh workspace from the fixture, a real ChatService over the provider under test, the
 * prompt sent as a turn, and the check run on what is left. Never throws: whatever goes wrong is a failed result.
 */
export async function runTask(task: TaskSpec, repeat: number, target: EvalTarget): Promise<RunResult> {
  const started = Date.now()
  const root = mkdtempSync(join(tmpdir(), `cubex-eval-${task.slug}-`))
  const workspace = join(root, 'workspace')
  const conversationId = `eval-${task.slug}-${repeat}-${Date.now().toString(36)}`
  const result: RunResult = {
    task: task.slug, repeat, passed: false, timedOut: false, rounds: 0, toolCalls: { total: 0, byName: {} }, toolErrors: 0,
    interventions: 0, retries: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, durationMs: 0, finalText: '', filesChanged: []
  }
  let service: ChatService | undefined
  try {
    mkdirSync(workspace)
    copyFixture(task, workspace)
    seedMemory(task, workspace)
    const before = snapshot(workspace)
    state.workspaces.set(conversationId, workspace)

    const probe: RequestProbe = {}
    const provider: AIProvider = withFaults(probed(target.providerFor(task, workspace), probe, workspace))
    const events: ChatEvent[] = []
    const tools = new Map<string, { name: string; failed: boolean }>()
    let roundText = ''
    let lastCompletedText = ''
    const failures: string[] = []

    // Without this a run has no window to fill. CUBEX_EVAL_WINDOW sets one, to measure what happens as a small one fills up.
    const windowTokens = Number(process.env.CUBEX_EVAL_WINDOW) || 0
    const modelInfo = windowTokens ? { id: target.model, contextWindow: windowTokens, capabilities: ['temperature'], location: 'cloud' } : undefined
    service = new ChatService({ resolve: () => provider, getModelInfo: () => modelInfo } as unknown as ProviderManager, (event) => {
      events.push(event)
      switch (event.kind) {
        case 'iteration':
          result.rounds = Math.max(result.rounds, event.iteration)
          roundText = ''
          break
        case 'stream':
          if (event.event.type === 'text_delta') roundText += event.event.text
          else if (event.event.type === 'completed') lastCompletedText = event.event.response.text
          else if (event.event.type === 'error') failures.push(event.event.error.message)
          break
        case 'tool': {
          const known = tools.get(event.tool.id)
          tools.set(event.tool.id, { name: event.tool.name, failed: known?.failed === true || event.tool.phase === 'error' })
          break
        }
        case 'gateway':
          if (event.event.type === 'attempt_error' && event.event.willRetry) result.retries++
          break
        // Nobody is at the window: whatever the agent waits for is answered so that a run never hangs.
        case 'permission': result.interventions++; service?.resolvePermission(event.ask.id, 'allow'); break
        case 'question': result.interventions++; service?.resolveQuestion(event.ask.id, [ANSWER_FOR_QUESTION]); break
        case 'plan': result.interventions++; service?.resolvePlan(event.ask.id, 'bypass'); break
        default: break
      }
    })

    const policy = {
      primary: { providerId: 'eval', model: target.model, ...(target.effort ? { params: { reasoningEffort: target.effort as never } } : {}) },
      fallbacks: [], fallbackEnabled: false, retry: { ...DEFAULT_RETRY_POLICY }, timeout: {}
    }
    const streamId = `s-${conversationId}`
    const request: ChatStartRequest = {
      streamId, conversationId, messageId: `u-${conversationId}`, userText: task.prompt, policy,
      fileToolsEnabled: true, subagentEnabled: task.subagents, permissionMode: task.mode
    }
    await service.start(request)

    // The turn is over when the service has nothing running; the deadline stops it, and that run is failed.
    const deadline = started + task.timeoutMs
    while (service.runningTurns > 0) {
      if (Date.now() > deadline) {
        result.timedOut = true
        service.cancel(streamId)
        const grace = Date.now() + STOP_GRACE_MS
        while (service.runningTurns > 0 && Date.now() < grace) await sleep(100)
        break
      }
      await sleep(100)
    }
    // The record of the turn is written as it is retired.
    await sleep(50)

    const finalText = (roundText || lastCompletedText).trim()
    result.finalText = finalText
    for (const tool of tools.values()) {
      result.toolCalls.total++
      result.toolCalls.byName[tool.name] = (result.toolCalls.byName[tool.name] ?? 0) + 1
      if (tool.failed) result.toolErrors++
    }
    for (const row of state.usage) {
      if (row.conversationId !== conversationId) continue
      result.tokens.input += row.usage.inputTokens ?? 0
      result.tokens.output += row.usage.outputTokens ?? 0
      result.tokens.cacheRead += row.usage.cachedInputTokens ?? 0
      result.tokens.cacheWrite += row.usage.cacheWriteInputTokens ?? 0
    }
    if (probe.promptHash) result.promptHash = probe.promptHash
    if (probe.toolsOffered) result.toolsOffered = probe.toolsOffered
    result.filesChanged = changedFiles(before, snapshot(workspace))

    if (result.timedOut) result.failure = `Timed out after ${Math.round(task.timeoutMs / 1000)} s.`
    else if (failures.length) result.failure = `The provider reported an error: ${failures[failures.length - 1]}`
    else {
      result.check = await runCheck(task, workspace, finalText, join(root, 'scratch'))
      result.passed = result.check.passed
    }
    if (process.env.CUBEX_EVAL_KEEP === '1') result.workspace = workspace
  } catch (error) {
    result.failure = `The run threw: ${error instanceof Error ? error.message : String(error)}`
  } finally {
    result.durationMs = Date.now() - started
    try { service?.cancelAll(); service?.dispose() } catch { /* the result is already decided */ }
    state.workspaces.delete(conversationId)
    state.usage = state.usage.filter((row) => row.conversationId !== conversationId)
    if (process.env.CUBEX_EVAL_KEEP !== '1') await removeFolder(root)
  }
  return result
}
