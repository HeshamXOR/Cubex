import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { redactString } from '@core/redaction'
import type { HookConfig } from '@shared/settings'
import {
  COMMON_HOOK_TOOLS, HOOK_EVENT_INFO, HOOK_TIMEOUT_MS, hookMatches, matcherTerms,
  type HookTestRequest, type HookTestResult
} from '@shared/policy'
import { childEnvironment } from './childEnv'
import { terminateShellTree } from './tools/shellProcess'

export interface HookPayload {
  event: HookConfig['event']
  tool_name?: string
  tool_input?: unknown
  tool_result?: string
  prompt?: string
  cwd?: string
  /** Stop only: true when the agent is already working because an earlier Stop hook of this turn asked it to. */
  stop_hook_active?: boolean
  /** SessionStart, PreCompact, PostCompact, Notification: the conversation the event belongs to. */
  session_id?: string
  /** PreCompact and PostCompact: what started the summary. */
  trigger?: 'auto' | 'manual' | 'overflow'
  /** PostCompact: the summary that was saved, shortened. Absent when the summary failed. */
  summary?: string
  /** Notification: what Cubex is waiting for. */
  notification_type?: 'permission' | 'question'
  /** Notification: a sentence saying what it is waiting for. */
  message?: string
}

export interface HookOutcome {
  block: boolean
  reason?: string
  /** UserPromptSubmit: text for the model only, added to the person's message (at most 4,000 characters). */
  additionalContext?: string
  /** PreToolUse: the tool runs with this input instead. */
  updatedInput?: Record<string, unknown>
}

/** What a UserPromptSubmit hook may add to the message, in characters. */
export const MAX_ADDITIONAL_CONTEXT = 4_000

/** A hook is a guard, not a data channel: cap what we buffer from it. */
const MAX_HOOK_OUTPUT = 64 * 1024
/** What a test shows of each stream. */
const TEST_OUTPUT_CAP = 8 * 1024
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g

interface RunResult {
  /** Null when the command never started or was killed by a signal. */
  exitCode: number | null
  stdout: string
  stderr: string
  /** The hook printed more than is kept. */
  truncated: boolean
  timedOut: boolean
  startError?: string
  blocked: boolean
  reason?: string
  additionalContext?: string
  updatedInput?: Record<string, unknown>
}

function runOne(command: string, payload: HookPayload, cwd: string | undefined, timeoutMs = HOOK_TIMEOUT_MS): Promise<RunResult> {
  return new Promise<RunResult>((resolve) => {
    const child = spawn(command, {
      shell: true,
      cwd,
      windowsHide: true,
      env: childEnvironment(),
      // Own process group on POSIX so a timeout can kill the whole tree.
      detached: process.platform !== 'win32'
    })
    let out = ''
    let err = ''
    let truncated = false
    let timedOut = false
    let settled = false
    const keep = (current: string, chunk: Buffer): string => {
      const next = current + chunk.toString()
      if (next.length <= MAX_HOOK_OUTPUT) return next
      truncated = true
      return next.slice(0, MAX_HOOK_OUTPUT)
    }
    child.stdout?.on('data', (d: Buffer) => { out = keep(out, d) })
    child.stderr?.on('data', (d: Buffer) => { err = keep(err, d) })
    // `shell: true` means child is the shell; kill its descendants too, or a
    // hung hook script outlives the timeout (always the case on Windows).
    const timer = setTimeout(() => {
      timedOut = true
      void terminateShellTree(child)
    }, timeoutMs)
    const finish = (result: Omit<RunResult, 'stdout' | 'stderr' | 'truncated' | 'timedOut'>): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ ...result, stdout: out, stderr: err, truncated, timedOut })
    }
    child.on('error', (error) => finish({ exitCode: null, startError: error.message, blocked: false }))
    child.on('close', (code) => {
      // Convention (Claude Code-compatible): exit 2 blocks; or JSON on stdout
      // {"decision":"block","reason":"..."}. A hook that was killed for taking too long never blocks.
      let blocked = !timedOut && code === 2
      let reason: string | undefined = err.trim() || undefined
      let additionalContext: string | undefined
      let updatedInput: Record<string, unknown> | undefined
      try {
        const j = JSON.parse(out.trim()) as { decision?: string; reason?: unknown; additionalContext?: unknown; updatedInput?: unknown }
        if (j && !timedOut) {
          if (j.decision === 'block') {
            blocked = true
            reason = typeof j.reason === 'string' ? j.reason : reason
          }
          if (typeof j.additionalContext === 'string' && j.additionalContext.trim()) additionalContext = j.additionalContext.trim()
          if (j.updatedInput && typeof j.updatedInput === 'object' && !Array.isArray(j.updatedInput)) updatedInput = j.updatedInput as Record<string, unknown>
        }
      } catch {
        /* stdout isn't control JSON — that's fine */
      }
      finish({ exitCode: code, blocked, reason, ...(additionalContext ? { additionalContext } : {}), ...(updatedInput ? { updatedInput } : {}) })
    })
    try {
      // The hook can exit before the payload is written; without a listener the
      // resulting `error` event would be an uncaught exception.
      child.stdin.on('error', () => { /* `close` already reports the outcome. */ })
      child.stdin.write(JSON.stringify(payload))
      child.stdin.end()
    } catch {
      /* stdin may already be closed */
    }
  })
}

/**
 * Run the hooks matching an event, in order. A hook receives the payload as JSON
 * on stdin. PreToolUse can veto a tool (or replace its input with `updatedInput`),
 * UserPromptSubmit can stop the turn or add `additionalContext` for the model, and
 * Stop can ask the agent to keep working (exit 2 or a block decision, with the
 * reason as the message); every other event is fire-and-forget. A hook that errors
 * or times out never breaks the agent loop — it's treated as "no objection".
 */
export async function runHooks(hooks: HookConfig[] | undefined, payload: HookPayload, cwd?: string): Promise<HookOutcome> {
  const matching = (hooks ?? []).filter(
    (h) => h.enabled && h.event === payload.event && hookMatches(h.matcher, payload.tool_name ?? payload.event)
  )
  let current = payload
  let updatedInput: Record<string, unknown> | undefined
  const context: string[] = []
  for (const h of matching) {
    try {
      const r = await runOne(h.command, current, cwd)
      if (HOOK_EVENT_INFO[payload.event].canBlock && r.blocked) return { block: true, reason: r.reason }
      if (payload.event === 'PreToolUse' && r.updatedInput) {
        updatedInput = r.updatedInput
        // The next hook of the event sees the input the tool would now run with.
        current = { ...current, tool_input: r.updatedInput }
      }
      if (payload.event === 'UserPromptSubmit' && r.additionalContext) context.push(r.additionalContext)
    } catch {
      /* never let a hook failure break the turn */
    }
  }
  const additionalContext = context.join('\n\n').slice(0, MAX_ADDITIONAL_CONTEXT)
  return {
    block: false,
    ...(updatedInput ? { updatedInput } : {}),
    ...(additionalContext ? { additionalContext } : {})
  }
}

// --- Testing one hook -----------------------------------------------------------

const SAMPLE_INPUTS: Record<string, unknown> = {
  write_file: { path: 'src/example.ts', content: 'export const example = 1\n' },
  edit_file: { path: 'src/example.ts', old_string: 'example = 1', new_string: 'example = 2' },
  run_command: { command: 'npm test' },
  remove_file: { path: 'src/example.ts' },
  web_fetch: { url: 'https://example.com/' }
}

/** A tool name the hook's matcher would accept, so a test exercises the command instead of the matcher. */
export function sampleToolName(matcher: string | undefined): string {
  const terms = matcherTerms(matcher)
  for (const term of terms) {
    const known = COMMON_HOOK_TOOLS.find((tool) => tool.includes(term.toLowerCase()))
    if (known) return known
  }
  return terms[0] ?? 'write_file'
}

/** What a hook for this event receives on stdin in a real run, filled with sample values. */
export function sampleHookPayload(request: HookTestRequest, cwd: string): HookPayload {
  switch (request.event) {
    case 'PreToolUse':
    case 'PostToolUse': {
      const tool = sampleToolName(request.matcher)
      return {
        event: request.event,
        tool_name: tool,
        tool_input: SAMPLE_INPUTS[tool] ?? {},
        ...(request.event === 'PostToolUse' ? { tool_result: 'Sample result from Cubex.' } : {}),
        cwd
      }
    }
    case 'UserPromptSubmit':
      return { event: 'UserPromptSubmit', prompt: 'Add a retry to the upload helper.', cwd }
    case 'Stop':
      return { event: 'Stop', cwd, stop_hook_active: false }
    case 'SessionStart':
      return { event: 'SessionStart', session_id: 'sample-conversation', cwd }
    case 'PreCompact':
      return { event: 'PreCompact', session_id: 'sample-conversation', trigger: 'auto', cwd }
    case 'PostCompact':
      return { event: 'PostCompact', session_id: 'sample-conversation', trigger: 'auto', summary: 'Goal: add a retry to the upload helper.', cwd }
    case 'SubagentStop':
      return {
        event: 'SubagentStop', tool_name: 'subagent', cwd,
        tool_input: { task: 'Find where uploads are retried.' }, tool_result: 'Sample report from a subagent.'
      }
    case 'Notification':
      return { event: 'Notification', session_id: 'sample-conversation', notification_type: 'permission', message: 'Cubex is waiting for you to approve run_command.', cwd }
  }
}

function isDirectory(path: string): boolean {
  try { return statSync(path).isDirectory() } catch { return false }
}

function shown(text: string): { text: string; cut: boolean } {
  const clean = redactString(text.replace(ANSI, '').replace(/\r\n?/g, '\n')).trimEnd()
  return clean.length > TEST_OUTPUT_CAP ? { text: clean.slice(0, TEST_OUTPUT_CAP), cut: true } : { text: clean, cut: false }
}

interface HookTestOptions {
  /** The selected project. The hook runs there when the folder exists, otherwise in an empty temporary folder. */
  workspace?: string
  timeoutMs?: number
}

/**
 * Run one hook once, exactly as a real run would (same shell, environment and time limit), against a
 * sample payload for its event. It runs whether or not the hook is switched on, and the result says
 * where it ran and what it received so nothing happens out of sight.
 */
export async function testHook(request: HookTestRequest, options: HookTestOptions = {}): Promise<HookTestResult> {
  const inProject = options.workspace !== undefined && isDirectory(options.workspace)
  const cwd = inProject && options.workspace ? options.workspace : mkdtempSync(join(tmpdir(), 'cubex-hook-test-'))
  const payload = sampleHookPayload(request, cwd)
  const started = Date.now()
  try {
    const run = await runOne(request.command, payload, cwd, options.timeoutMs)
    const canBlock = HOOK_EVENT_INFO[request.event].canBlock
    const out = shown(run.stdout)
    const err = shown(run.stderr)
    const blocked = canBlock && run.blocked
    const reason = run.blocked && run.reason ? redactString(run.reason).slice(0, 500) : undefined
    return {
      event: request.event,
      command: request.command,
      cwd,
      cwdKind: inProject ? 'project' : 'scratch',
      payload: JSON.stringify(payload, null, 2),
      outcome: run.startError ? 'failed-to-start' : run.timedOut ? 'timed-out' : 'ran',
      exitCode: run.exitCode,
      durationMs: Date.now() - started,
      stdout: out.text,
      stderr: err.text,
      truncated: run.truncated || out.cut || err.cut,
      decision: blocked ? 'blocked' : 'allowed',
      ...(reason ? { reason } : {}),
      ...(run.blocked && !canBlock ? { blockIgnored: true } : {}),
      ...(run.startError ? { startError: redactString(run.startError) } : {})
    }
  } finally {
    if (!inProject) rmSync(cwd, { recursive: true, force: true })
  }
}
