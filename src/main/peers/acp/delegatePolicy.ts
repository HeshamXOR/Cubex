import { relative, isAbsolute, resolve, sep } from 'node:path'
import { condenseDiff, lineDiff, serializeDiff } from '@core/tools/lineDiff'
import type { PermissionDelegate, PermissionMode } from '@shared/ipc'
import { canonicalPath, isInside, permissionOptions, replyOnce, type AcpPolicy } from './permissions'

/**
 * What Cubex answers when an agent working on a delegated task asks permission to use one of its tools. The agent has no
 * file access and no terminal from Cubex: it edits and runs with its own tools, and when one of them needs permission it
 * asks. This is where the chat's permission mode is applied to it, the same way it is applied to Cubex's own tools:
 *
 *  - Reading, searching and thinking are allowed inside the project and refused outside it.
 *  - An edit, a delete or a move must name where, and where must be inside the project: in no mode may an agent change
 *    something outside it. Inside, default mode asks the person; accept-edits allows an edit (not a delete or a move)
 *    unless the place is a protected one; bypass allows it. Plan mode refuses.
 *  - A command is allowed when it is a read-only probe, or in bypass mode; otherwise the person is asked. Plan refuses.
 *  - A request to change the mode is always refused, and a kind of request Cubex does not know is asked about (never allowed
 *    by itself, except in bypass mode).
 *  - A task that only reads (research, review) is refused everything that is not reading, and is asked before it fetches.
 *
 * The answer is always "this once", never "always". Something the agent does without asking is outside what Cubex can
 * hold it to, which is why the folder is compared afterwards and every change is listed.
 */

export interface DelegateQuestion extends PermissionDelegate {
  /** What the agent wants, in a sentence: "Codex wants to edit src/app.ts". */
  title: string
  /** The change as a diff (lines tagged +, -, space), or the command, or what the agent said it wants. */
  detail?: string
  /** What the person should know before answering. */
  risks: string[]
}

export interface DelegatePolicyOptions {
  /** The project folder: where the agent was started, and the only place it may change. */
  root: string
  /** The agent's name, for the questions. */
  agent: string
  /** The chat's permission mode now. It can change while a task runs (a plan is approved). */
  mode: () => PermissionMode
  /** A task that only reads: research and review. */
  readOnly: boolean
  /** Ask the person. Resolves to whether they allowed it. A rejection counts as no. */
  ask: (question: DelegateQuestion) => Promise<boolean>
  /** Called with the paths of an edit, delete or move, just before it is allowed: keep what is there now. */
  beforeChange: (paths: string[]) => void
  /** Whether a path, relative to the project, is one that can change how git or other tools run. */
  isProtected: (relativePath: string) => boolean
  /** Whether a command only looks and changes nothing. */
  isReadOnlyCommand: (command: string) => boolean
}

type Judgement =
  | { verdict: 'allow'; reason: string; capture?: string[] }
  | { verdict: 'ask'; reason: string; question: DelegateQuestion; capture?: string[] }
  | { verdict: 'reject'; reason: string }

const READING = new Set(['read', 'search', 'think'])
const MUTATING = new Set(['edit', 'delete', 'move'])

const COMMAND_RISK = 'Cubex cannot limit what a command touches.'
const PROTECTED_RISK = 'Protected path: changes here can alter how git, Cubex or other tools execute.'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Places a request names: undefined when it names none, 'invalid' when one of them is not a path. */
function placesOf(value: unknown): string[] | 'invalid' | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined
  const paths: string[] = []
  for (const entry of value) {
    const path = isRecord(entry) ? entry.path : undefined
    if (typeof path !== 'string' || !path.trim() || path.includes('\u0000')) return 'invalid'
    paths.push(path)
  }
  return paths
}

/** The command a tool call is about, when its input names one as text or as a list of words. */
function commandOf(toolCall: Record<string, unknown>): string | undefined {
  const input = isRecord(toolCall.rawInput) ? toolCall.rawInput : undefined
  const raw = input?.command ?? input?.cmd
  if (typeof raw === 'string' && raw.trim()) return raw
  if (Array.isArray(raw) && raw.length > 0 && raw.every((part) => typeof part === 'string')) return (raw as string[]).join(' ')
  return undefined
}

/** A path as the person reads it: relative to the project when it is inside it, with forward slashes. */
export function shownPath(path: string, root: string): string {
  const absolute = isAbsolute(path) ? path : resolve(root, path)
  const between = relative(root, absolute)
  const inside = between !== '' && between !== '..' && !between.startsWith(`..${sep}`) && !isAbsolute(between)
  return (inside ? between : absolute).split(sep).join('/')
}

const DETAIL_LINES = 60
const DETAIL_LINE_CHARS = 300

/** The first change of a tool call as diff lines for the question, when the agent sent the old and the new text. */
function diffDetail(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined
  for (const entry of content) {
    if (!isRecord(entry) || entry.type !== 'diff' || typeof entry.newText !== 'string') continue
    const before = typeof entry.oldText === 'string' ? entry.oldText : ''
    const lines = serializeDiff(condenseDiff(lineDiff(before, entry.newText), 2)).split('\n')
    const shown = lines.slice(0, DETAIL_LINES).map((line) => (line.length > DETAIL_LINE_CHARS ? `${line.slice(0, DETAIL_LINE_CHARS)}…` : line))
    if (lines.length > DETAIL_LINES) shown.push(`@${lines.length - DETAIL_LINES} more lines`)
    return shown.join('\n')
  }
  return undefined
}

function actionOf(kind: string): PermissionDelegate['action'] {
  switch (kind) {
    case 'edit': return 'edit'
    case 'delete': return 'delete'
    case 'move': return 'move'
    case 'execute': return 'run'
    case 'fetch': return 'fetch'
    default: return 'other'
  }
}

const VERB: Record<PermissionDelegate['action'], string> = { edit: 'edit', delete: 'delete', move: 'move', run: 'run a command', fetch: 'fetch a page', other: 'use a tool' }

/** "Codex wants to edit src/app.ts": the sentence a question starts with. */
function sentence(agent: string, action: PermissionDelegate['action'], target: string | undefined, title: string): string {
  if (action === 'other') return `${agent} wants to ${VERB.other}${title ? `: ${title}` : ''}`
  if (action === 'run' || action === 'fetch') return `${agent} wants to ${VERB[action]}`
  return `${agent} wants to ${VERB[action]}${target ? ` ${target}` : ''}`
}

/** What an agent asked for and the policy's answer, without asking anyone. Reads the disk only to follow links. */
export function judgeDelegated(params: unknown, options: DelegatePolicyOptions): Judgement {
  const request = isRecord(params) ? params : {}
  const toolCall = isRecord(request.toolCall) ? request.toolCall : {}
  const kind = typeof toolCall.kind === 'string' ? toolCall.kind : 'other'
  const title = typeof toolCall.title === 'string' ? toolCall.title.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 200) : ''
  const mode = options.mode()
  const { root, agent } = options
  const places = placesOf(toolCall.locations)

  const action = actionOf(kind)
  const ask = (extra: { target?: string; command?: string; detail?: string; risks?: string[] }, reason: string, capture?: string[]): Judgement => ({
    verdict: 'ask',
    reason,
    ...(capture ? { capture } : {}),
    question: {
      agent,
      action,
      title: sentence(agent, action, extra.target, title),
      ...(extra.target ? { target: extra.target } : {}),
      ...(extra.command ? { command: extra.command } : {}),
      ...(extra.detail ? { detail: extra.detail } : {}),
      risks: extra.risks ?? []
    }
  })

  if (READING.has(kind)) {
    if (places === 'invalid') return { verdict: 'reject', reason: 'a place that is not a path' }
    for (const path of places ?? []) if (!isInside(path, root)) return { verdict: 'reject', reason: 'a place outside the project' }
    // A read that names no file cannot be held to the project, so the person is asked. A search that names no folder
    // starts in the agent's own folder, which is the project, and thinking reads nothing: both go ahead.
    if (places === undefined && kind === 'read' && mode !== 'bypass') {
      return ask({ detail: title, risks: ['The agent did not say what it reads. Cubex cannot check that it stays inside the project.'] }, `${kind} without a place needs an answer`)
    }
    return { verdict: 'allow', reason: `${kind} inside the project` }
  }

  if (kind === 'switch_mode') return { verdict: 'reject', reason: 'changing the mode is not allowed in a task' }
  if (mode === 'plan') return { verdict: 'reject', reason: 'plan mode allows nothing but reading' }

  if (MUTATING.has(kind)) {
    if (options.readOnly) return { verdict: 'reject', reason: 'a task that only reads may not change anything' }
    if (places === 'invalid') return { verdict: 'reject', reason: 'a place that is not a path' }
    const paths = (places ?? []).map((path) => (isAbsolute(path) ? path : resolve(root, path)))
    for (const path of paths) if (!isInside(path, root)) return { verdict: 'reject', reason: 'a place outside the project' }
    const shown = paths.map((path) => shownPath(path, root))
    const guarded = shown.some((path) => options.isProtected(path))
    // Only a request that says where can be held to the folder, so only such a request is ever allowed without asking.
    const auto = paths.length > 0 && (mode === 'bypass' || (mode === 'acceptEdits' && kind === 'edit' && !guarded))
    if (auto) return { verdict: 'allow', reason: `${kind} inside the project`, capture: paths }
    const target = shown.length === 0 ? undefined : shown.length === 1 ? shown[0] : `${shown[0]} and ${shown.length - 1} more`
    return ask({
      ...(target ? { target } : {}),
      ...(kind === 'edit' ? { detail: diffDetail(toolCall.content) ?? title } : { detail: title }),
      risks: [...(guarded ? [PROTECTED_RISK] : []), ...(paths.length === 0 ? ['The agent did not say where. Cubex cannot check that it stays inside the project.'] : [])]
    }, `${kind} needs an answer`, paths)
  }

  if (kind === 'execute') {
    if (options.readOnly) return { verdict: 'reject', reason: 'a task that only reads may not run commands' }
    const command = commandOf(toolCall)
    if (command !== undefined && options.isReadOnlyCommand(command)) return { verdict: 'allow', reason: 'a read-only command' }
    if (mode === 'bypass') return { verdict: 'allow', reason: 'bypass mode allows commands' }
    return ask({ ...(command ? { command } : {}), detail: command ?? title, risks: [COMMAND_RISK] }, 'a command needs an answer')
  }

  if (kind === 'fetch') {
    if (mode === 'bypass' && !options.readOnly) return { verdict: 'allow', reason: 'bypass mode allows fetching' }
    return ask({ detail: title, risks: ['Sends a request from this PC. Data in the address leaves it.'] }, 'a fetch needs an answer')
  }

  // Anything else: a kind of tool Cubex does not know. A task that only reads gets none of them.
  if (options.readOnly) return { verdict: 'reject', reason: 'a task that only reads may not use other tools' }
  if (mode === 'bypass') return { verdict: 'allow', reason: 'bypass mode allows other tools' }
  return ask({ detail: title, risks: [`Cubex does not recognise this kind of request: ${kind.replace(/[^A-Za-z0-9_-]/g, '?').slice(0, 40)}.`] }, 'an unknown kind needs an answer')
}

/** The policy of a delegated task. */
export function createDelegatePolicy(options: DelegatePolicyOptions): AcpPolicy {
  // The folder is compared by what it really is, so a link cannot make something outside it look inside.
  const root = canonicalPath(options.root) ?? options.root
  const bound: DelegatePolicyOptions = { ...options, root }
  return {
    purpose: options.readOnly ? 'consult' : 'work',
    async decide(params) {
      const offered = permissionOptions(isRecord(params) ? params.options : undefined)
      const judgement = judgeDelegated(params, bound)
      let allow = judgement.verdict === 'allow'
      if (judgement.verdict === 'ask') {
        try { allow = await options.ask(judgement.question) } catch { allow = false }
      }
      if (allow && !offered.some((option) => option.kind === 'allow_once')) allow = false
      if (allow && judgement.verdict !== 'reject' && judgement.capture?.length) options.beforeChange(judgement.capture)
      return replyOnce(offered, allow).reply
    }
  }
}
