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
}

export interface HookOutcome {
  block: boolean
  reason?: string
}

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
      try {
        const j = JSON.parse(out.trim()) as { decision?: string; reason?: unknown }
        if (j && j.decision === 'block' && !timedOut) {
          blocked = true
          reason = typeof j.reason === 'string' ? j.reason : reason
        }
      } catch {
        /* stdout isn't control JSON — that's fine */
      }
      finish({ exitCode: code, blocked, reason })
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
 * on stdin. Only PreToolUse can veto (exit 2 or a block decision); every other
 * event is fire-and-forget. A hook that errors or times out never breaks the
 * agent loop — it's treated as "no objection".
 */
export async function runHooks(hooks: HookConfig[] | undefined, payload: HookPayload, cwd?: string): Promise<HookOutcome> {
  const matching = (hooks ?? []).filter(
    (h) => h.enabled && h.event === payload.event && hookMatches(h.matcher, payload.tool_name ?? payload.event)
  )
  for (const h of matching) {
    try {
      const r = await runOne(h.command, payload, cwd)
      if (payload.event === 'PreToolUse' && r.blocked) return { block: true, reason: r.reason }
    } catch {
      /* never let a hook failure break the turn */
    }
  }
  return { block: false }
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
      return { event: 'Stop', cwd }
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
