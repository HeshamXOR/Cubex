import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { KNOWN_AGENTS, type AgentAccount, type AgentDetection, type AgentsDetection, type KnownAgent } from '@shared/agentCatalog'
import { LaunchError, locateCommand, resolveLaunch } from '../mcp/resolveLaunch'
import { terminateShellTree } from '../tools/shellProcess'
import { findAppProgram, type AppProgram } from './appPrograms'
import { cleanOutput, tail } from './output'
import { peerEnvironment } from './peerRunner'

/**
 * Looking for the coding agents on this computer. For each one Cubex knows (the catalog), it finds the program, asks it
 * for its version, and, where the program has a command for it, asks who it is signed in as. That is all: nothing is
 * installed, nothing is signed in, and the program's saved login is never read, only reported by the program itself.
 *
 * The programs run with the environment Cubex gives every child (anything that looks like a key or token removed), in the
 * system's temporary folder, without a shell, and are stopped when they take too long. What they print is cleaned and
 * read as data.
 */

export const VERSION_TIMEOUT_MS = 6_000
/** An account check can read the disk and the network the first time, and a Windows start is slow. */
export const ACCOUNT_TIMEOUT_MS = 15_000
const OUTPUT_CAP = 16_000
/** Each program is a whole process, many of them Node: a handful at a time is plenty. */
const AT_ONCE = 4

export interface ProbeResult {
  code: number | null
  stdout: string
  stderr: string
  timedOut: boolean
  /** The program could not be started. */
  error?: string
}

export interface ProbeOptions {
  env: NodeJS.ProcessEnv
  cwd: string
  timeoutMs: number
}

/** Runs a program to the end and returns what it printed. Replaced in tests. */
export type ProbeRunner = (file: string, args: readonly string[], options: ProbeOptions) => Promise<ProbeResult>

export const runProbe: ProbeRunner = (file, args, options) => new Promise<ProbeResult>((settle) => {
  let plan: ReturnType<typeof resolveLaunch>
  try {
    plan = resolveLaunch({ command: file, args, cwd: options.cwd, env: options.env })
  } catch (error) {
    settle({ code: null, stdout: '', stderr: '', timedOut: false, error: error instanceof LaunchError || error instanceof Error ? error.message : String(error) })
    return
  }
  let stdout = ''
  let stderr = ''
  let timedOut = false
  let done = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let grace: ReturnType<typeof setTimeout> | undefined
  let child: ReturnType<typeof spawn>
  try {
    child = spawn(plan.file, plan.args, {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      windowsHide: true,
      windowsVerbatimArguments: plan.windowsVerbatimArguments,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe']
    })
  } catch (error) {
    settle({ code: null, stdout: '', stderr: '', timedOut: false, error: error instanceof Error ? error.message : String(error) })
    return
  }
  const finish = (result: ProbeResult): void => {
    if (done) return
    done = true
    clearTimeout(timer)
    clearTimeout(grace)
    settle(result)
  }
  timer = setTimeout(() => {
    timedOut = true
    void terminateShellTree(child)
    // A program whose pipes stay open after it is stopped must not keep the page waiting.
    grace = setTimeout(() => finish({ code: null, stdout, stderr, timedOut: true }), 2_000)
  }, options.timeoutMs)
  child.stdout?.setEncoding('utf8')
  child.stderr?.setEncoding('utf8')
  child.stdout?.on('data', (chunk: string) => { if (stdout.length < OUTPUT_CAP) stdout += chunk.slice(0, OUTPUT_CAP - stdout.length) })
  child.stderr?.on('data', (chunk: string) => { if (stderr.length < OUTPUT_CAP) stderr += chunk.slice(0, OUTPUT_CAP - stderr.length) })
  child.stdout?.on('error', () => undefined)
  child.stderr?.on('error', () => undefined)
  child.once('error', (error) => finish({ code: null, stdout, stderr, timedOut, error: error.message }))
  child.once('close', (code) => finish({ code, stdout, stderr, timedOut }))
})

// --- Reading what a program printed -------------------------------------------------------

/** The first version number in some output: "2.1.4" from "2.1.4 (Claude Code)", "0.46.0" from "codex-cli 0.46.0". */
export function parseVersion(text: string): string | undefined {
  return /\bv?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/.exec(cleanOutput(text))?.[1]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function firstText(...values: unknown[]): string | undefined {
  for (const value of values) if (typeof value === 'string' && value.trim()) return value.trim()
  return undefined
}

/** The object in some output, which may have a line of text around it. */
function jsonObject(text: string): Record<string, unknown> | undefined {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return undefined
  try {
    const parsed: unknown = JSON.parse(text.slice(start, end + 1))
    return isRecord(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

const CLAUDE_PLANS: Record<string, string> = { free: 'Claude Free', pro: 'Claude Pro', max: 'Claude Max', max5x: 'Claude Max 5x', max20x: 'Claude Max 20x', team: 'Claude Team', enterprise: 'Claude Enterprise' }

function plan(value: string | undefined): string | undefined {
  if (!value) return undefined
  const key = value.toLowerCase().replace(/^claude[\s_-]*/, '').replace(/[\s_-]*(subscription|plan)$/, '').replace(/[\s_-]+/g, '')
  return CLAUDE_PLANS[key]
}

/**
 * `claude auth status` prints one JSON object: {"loggedIn":true,"authMethod":"claude.ai","account":{"email":"..."}}, or
 * {"loggedIn":false}. Anything else is "not known" rather than "signed out": a version without the command prints usage.
 */
export function parseClaudeStatus(output: string): AgentAccount {
  const json = jsonObject(cleanOutput(output))
  if (!json || typeof json.loggedIn !== 'boolean') return { state: 'unknown' }
  if (!json.loggedIn) return { state: 'signed-out' }
  const account = isRecord(json.account) ? json.account : {}
  const email = firstText(account.email, json.email)
  const method = (firstText(json.authMethod, account.authMethod) ?? '').toLowerCase()
  const subscription = plan(firstText(json.subscriptionType, account.subscriptionType, json.plan, account.plan))
  let label: string | undefined
  if (/api|key|console/.test(method)) label = 'an Anthropic API key'
  else if (/claude|oauth|subscription/.test(method) || subscription) label = subscription ?? 'a Claude subscription'
  else if (method) label = method.slice(0, 40)
  return { state: 'signed-in', ...(label ? { label } : {}), ...(email ? { email } : {}) }
}

/** `codex login status` says "Logged in using ChatGPT", "Logged in using an API key", or "Not logged in". */
export function parseCodexStatus(output: string): AgentAccount {
  const text = cleanOutput(output)
  if (/\bnot logged in\b|\blogged out\b/i.test(text)) return { state: 'signed-out' }
  if (!/\blogged in\b/i.test(text)) return { state: 'unknown' }
  if (/chatgpt/i.test(text)) return { state: 'signed-in', label: 'ChatGPT' }
  if (/api key/i.test(text)) return { state: 'signed-in', label: 'an OpenAI API key' }
  return { state: 'signed-in' }
}

// --- Looking ---------------------------------------------------------------------------------

export interface DetectOptions {
  /** Local-only mode: programs are looked for and not started. */
  localOnly: boolean
  env?: NodeJS.ProcessEnv
  run?: ProbeRunner
  /** Replaces the lookup of a program on PATH. For tests. */
  locate?: (command: string, env: NodeJS.ProcessEnv) => string | undefined
  /** Replaces the lookup of a program in the folder of an app that brings it, tried when PATH has none. For tests. */
  app?: (command: string, env: NodeJS.ProcessEnv) => AppProgram | undefined
  catalog?: readonly KnownAgent[]
}

const unknown = (): AgentAccount => ({ state: 'unknown' })

async function inPool<T, R>(items: readonly T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  const worker = async (): Promise<void> => {
    for (let index = next++; index < items.length; index = next++) results[index] = await work(items[index]!)
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}

async function detectOne(entry: KnownAgent, options: Required<Pick<DetectOptions, 'localOnly' | 'run' | 'locate' | 'app'>> & { env: NodeJS.ProcessEnv }): Promise<AgentDetection> {
  let path: string | undefined
  let via: string | undefined
  let folderVersion: string | undefined
  for (const program of entry.programs) {
    path = options.locate(program, options.env)
    if (path) break
  }
  if (!path) {
    // Not on PATH: an app that brings the program keeps it in a folder of its own, and only the names in that folder are read.
    for (const program of entry.programs) {
      const found = options.app(program, options.env)
      if (!found) continue
      path = found.path
      via = found.app
      folderVersion = found.version
      break
    }
  }
  if (!path) return { id: entry.id, found: false, account: unknown(), probed: false }
  const where = via ? { via } : {}
  if (options.localOnly) return { id: entry.id, found: true, path, ...where, ...(folderVersion ? { version: folderVersion } : {}), account: unknown(), probed: false }

  const probe = { env: options.env, cwd: tmpdir() }
  const versionRun = await options.run(path, ['--version'], { ...probe, timeoutMs: VERSION_TIMEOUT_MS })
  const version = parseVersion(`${versionRun.stdout}\n${versionRun.stderr}`) ?? folderVersion
  if (versionRun.error || versionRun.timedOut || (versionRun.code !== 0 && !version)) {
    const why = versionRun.timedOut
      ? 'It did not answer within a few seconds.'
      : versionRun.error
        ? tail(cleanOutput(versionRun.error), 200)
        : `It stopped with exit code ${versionRun.code ?? 'unknown'}${cleanOutput(versionRun.stderr) ? `: ${tail(cleanOutput(versionRun.stderr), 160)}` : '.'}`
    return { id: entry.id, found: true, path, ...where, account: unknown(), probed: false, problem: `Found, but it did not run: ${why}` }
  }

  let account = unknown()
  if (entry.account) {
    const args = entry.account === 'claude' ? ['auth', 'status'] : ['login', 'status']
    const run = await options.run(path, args, { ...probe, timeoutMs: ACCOUNT_TIMEOUT_MS })
    // Programs print the answer to either stream, and a program that is signed out may also exit with an error.
    if (!run.error && !run.timedOut) account = (entry.account === 'claude' ? parseClaudeStatus : parseCodexStatus)(`${run.stdout}\n${run.stderr}`)
  }
  return { id: entry.id, found: true, path, ...where, ...(version ? { version } : {}), account, probed: true }
}

/** Look for every agent in the catalog, and for npx, which the adapters of some of them run through. */
export async function detectAgents(options: DetectOptions): Promise<AgentsDetection> {
  const env = options.env ?? peerEnvironment({})
  const locate = options.locate ?? ((command, base) => locateCommand({ command, env: base }))
  const app = options.app ?? ((command, base) => findAppProgram(command, base))
  const run = options.run ?? runProbe
  const catalog = options.catalog ?? KNOWN_AGENTS

  const agents = await inPool(catalog, AT_ONCE, (entry) => detectOne(entry, { localOnly: options.localOnly, run, locate, app, env }))

  const npx = locate('npx', env)
  let nodeVersion: string | undefined
  if (npx && !options.localOnly) {
    const node = locate('node', env)
    if (node) {
      const result = await run(node, ['--version'], { env, cwd: tmpdir(), timeoutMs: VERSION_TIMEOUT_MS })
      nodeVersion = parseVersion(result.stdout)
    }
  }
  return { agents, node: { found: !!npx, ...(nodeVersion ? { version: nodeVersion } : {}) }, localOnly: options.localOnly, checkedAt: Date.now() }
}
