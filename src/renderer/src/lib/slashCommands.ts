import type { SkillSummary } from '../../../shared/ipc'
import { matchesShortcut, type KeyEventLike } from './shortcuts'

/**
 * What the "/" menu in the composer offers. The built-in commands are handled here in the window (see
 * runSlashCommand in the store) and never reach a model. A skill picked from the menu is applied to the message by
 * name: the main process puts its instructions in front of the request, so the model does not have to decide to
 * load it.
 */
export interface SlashCommand {
  name: string
  args?: string
  description: string
}

export const SLASH_COMMANDS: SlashCommand[] = [
  { name: 'goal', args: '<objective>', description: 'Set a goal the assistant keeps working toward' },
  { name: 'new', description: 'Start a new conversation' },
  { name: 'system', args: '<prompt>', description: 'Set a system prompt for this chat' },
  { name: 'workspace', description: 'Choose the working folder for this session' },
  { name: 'model', args: '[provider]', description: 'Open the model picker' },
  { name: 'compact', description: 'Summarize older messages to free up context' },
  { name: 'retry', description: 'Regenerate the last response' },
  { name: 'title', args: '<name>', description: 'Rename this conversation' },
  { name: 'export', description: 'Copy this conversation as Markdown' },
  { name: 'clear', description: 'Clear the current conversation' },
  { name: 'cost', description: 'Show usage & cost' },
  { name: 'hardware', description: 'Open the Hardware Analyzer' },
  { name: 'settings', description: 'Open settings' }
]

/** How a skill is spelled when it must not be mistaken for a command: "/skill:title". */
const EXPLICIT = 'skill:'

export function isCommandName(name: string): boolean {
  const lower = name.toLowerCase()
  return SLASH_COMMANDS.some((command) => command.name === lower)
}

/** One row of the menu. `token` is what follows the slash once the row is picked. */
export type SlashEntry =
  | { kind: 'command'; token: string; command: SlashCommand }
  | { kind: 'skill'; token: string; skill: SkillSummary }

export interface SlashMatches {
  commands: SlashEntry[]
  skills: SlashEntry[]
}

/** The word typed after the slash while the menu applies: the draft is "/" and that one word, nothing else yet. */
export function slashQuery(draft: string): string | undefined {
  return /^\/(\S*)$/.exec(draft)?.[1]
}

/** 0 is the name itself, 1 starts with it, 2 has it inside, 3 only the description has it; undefined is no match. */
function rank(query: string, name: string, description: string): number | undefined {
  if (!query) return 0
  const lower = name.toLowerCase()
  if (lower === query) return 0
  if (lower.startsWith(query)) return 1
  if (lower.includes(query)) return 2
  return description.toLowerCase().includes(query) ? 3 : undefined
}

/** The items that match, best first; items of the same rank keep the order they came in. */
function ranked<T>(items: readonly T[], rankOf: (item: T) => number | undefined): T[] {
  const matched: { item: T; index: number; rank: number }[] = []
  items.forEach((item, index) => {
    const found = rankOf(item)
    if (found !== undefined) matched.push({ item, index, rank: found })
  })
  return matched.sort((a, b) => a.rank - b.rank || a.index - b.index).map((entry) => entry.item)
}

/**
 * Both groups for what has been typed after the slash. A skill that shares its name with a built-in command is
 * offered as "skill:name", because the command wins the plain spelling; typing "skill:" asks for skills only.
 */
export function matchSlash(rawQuery: string, skills: readonly SkillSummary[]): SlashMatches {
  const query = rawQuery.toLowerCase()
  const explicit = query.startsWith(EXPLICIT)
  const needle = explicit ? query.slice(EXPLICIT.length) : query
  return {
    commands: explicit ? [] : ranked(SLASH_COMMANDS, (command) => rank(needle, command.name, command.description))
      .map((command) => ({ kind: 'command', token: command.name, command })),
    skills: ranked(skills, (skill) => rank(needle, skill.name, skill.description))
      .map((skill) => ({ kind: 'skill', token: explicit || isCommandName(skill.name) ? `${EXPLICIT}${skill.name}` : skill.name, skill }))
  }
}

/** A message that starts with "/": the name, what follows it, and whether it was spelled "/skill:name". */
export interface SlashInput {
  name: string
  rest: string
  explicit: boolean
}

/** Names run to the next space, so "/new-chat" is not "/new". Null when the message is not a "/name" at all. */
export function parseSlash(input: string): SlashInput | null {
  if (!input.startsWith('/')) return null
  const found = /^\/(skill:)?([A-Za-z0-9][\w.-]*)(?:\s+([\s\S]*))?$/.exec(input.trim())
  return found ? { name: found[2]!, rest: found[3] ?? '', explicit: !!found[1] } : null
}

/** The built-in command a message names. A message spelled "/skill:name" is never one. */
export function parseCommand(input: string): { name: string; rest: string } | null {
  const parsed = parseSlash(input)
  return parsed && !parsed.explicit ? { name: parsed.name.toLowerCase(), rest: parsed.rest } : null
}

export interface SkillInvocation {
  /** The skill as the catalog spells it. */
  skill: string
  /** What was written after the name. */
  request: string
}

/**
 * The skill a message names, if it names one. A command wins its plain spelling. A plain "/name" counts only when
 * the task has a skill of that name, so any other "/word" stays an ordinary message. "/skill:name" always counts:
 * the main process decides whether such a skill exists.
 */
export function skillInvocation(input: string, skills: readonly SkillSummary[] | undefined): SkillInvocation | undefined {
  const parsed = parseSlash(input)
  if (!parsed) return undefined
  const lower = parsed.name.toLowerCase()
  const listed = skills?.find((skill) => skill.name.toLowerCase() === lower)
  if (parsed.explicit) return { skill: listed?.name ?? parsed.name, request: parsed.rest }
  return listed && !isCommandName(lower) ? { skill: listed.name, request: parsed.rest } : undefined
}

export type SlashKeyAction =
  | { type: 'move'; to: number }
  | { type: 'pick'; entry: SlashEntry }
  | { type: 'dismiss' }

/**
 * What a key does while the menu is open, or undefined when the key is not the menu's. Enter and Tab complete the
 * highlighted row; Enter on a name that is already typed in full sends the message instead, so "/clear" and Enter
 * still runs the command.
 */
export function slashKeyAction(event: KeyEventLike, menu: { entries: readonly SlashEntry[]; active: number; draft: string }): SlashKeyAction | undefined {
  const { entries, active, draft } = menu
  if (entries.length === 0) return undefined
  const plain = !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey
  if (plain && event.key === 'ArrowDown') return { type: 'move', to: (active + 1) % entries.length }
  if (plain && event.key === 'ArrowUp') return { type: 'move', to: (active - 1 + entries.length) % entries.length }
  if (plain && event.key === 'Escape') return { type: 'dismiss' }
  const entry = entries[active]
  if (!entry) return undefined
  if (matchesShortcut(event, 'complete')) return { type: 'pick', entry }
  if (plain && event.key === 'Enter' && draft.toLowerCase() !== `/${entry.token.toLowerCase()}`) return { type: 'pick', entry }
  return undefined
}
