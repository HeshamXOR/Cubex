import { describe, expect, it } from 'vitest'
import type { SkillSummary } from '../../../shared/ipc'
import {
  SLASH_COMMANDS,
  isCommandName,
  matchSlash,
  parseCommand,
  parseSlash,
  skillInvocation,
  slashKeyAction,
  slashQuery,
  type SlashEntry
} from './slashCommands'
import type { KeyEventLike } from './shortcuts'

const skill = (name: string, description = 'Does something useful', source: SkillSummary['source'] = 'bundled'): SkillSummary => ({
  name, description, source, path: `C:\\skills\\${name}\\SKILL.md`
})
const tokens = (entries: readonly SlashEntry[]): string[] => entries.map((entry) => entry.token)
const press = (key: string, modifiers: Partial<Omit<KeyEventLike, 'key'>> = {}): KeyEventLike =>
  ({ key, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...modifiers })

describe('when the menu applies', () => {
  it('reads the word typed after the slash, and only while it is the first word of the draft', () => {
    expect(slashQuery('/')).toBe('')
    expect(slashQuery('/fro')).toBe('fro')
    expect(slashQuery('/skill:co')).toBe('skill:co')
    expect(slashQuery('/goal ')).toBeUndefined()
    expect(slashQuery('/goal ship it')).toBeUndefined()
    expect(slashQuery('/goal\nship it')).toBeUndefined()
    expect(slashQuery('hello /fro')).toBeUndefined()
    expect(slashQuery('')).toBeUndefined()
  })
})

describe('listing commands and skills', () => {
  const library = [skill('code-review'), skill('debugging'), skill('frontend-engineering')]

  it('shows every command and every skill for a bare slash, each group in the order it came', () => {
    const matches = matchSlash('', library)
    expect(tokens(matches.commands)).toEqual(SLASH_COMMANDS.map((command) => command.name))
    expect(tokens(matches.skills)).toEqual(['code-review', 'debugging', 'frontend-engineering'])
    expect(matches.commands.every((entry) => entry.kind === 'command')).toBe(true)
    expect(matches.skills.every((entry) => entry.kind === 'skill')).toBe(true)
  })

  it('works with no skills at all', () => {
    expect(matchSlash('', []).skills).toEqual([])
    expect(tokens(matchSlash('mod', []).commands)).toEqual(['model'])
  })

  it('ranks the name itself, then names that start with it, then names that contain it, then descriptions', () => {
    const skills = [
      skill('review-code', 'Looks at diffs'),
      skill('testing', 'Write tests, then review code'),
      skill('codex', 'Another reader'),
      skill('code-review', 'Checks a change'),
      skill('code', 'Plain'),
      skill('lint', 'Nothing here')
    ]
    expect(tokens(matchSlash('code', skills).skills)).toEqual(['code', 'codex', 'code-review', 'review-code', 'testing'])
  })

  it('keeps the order skills came in among those of the same rank', () => {
    const skills = [skill('b-tool'), skill('a-tool'), skill('c-tool')]
    expect(tokens(matchSlash('tool', skills).skills)).toEqual(['b-tool', 'a-tool', 'c-tool'])
  })

  it('narrows commands the same way, and finds a command by its description', () => {
    expect(tokens(matchSlash('mod', []).commands)).toEqual(['model'])
    expect(tokens(matchSlash('rename', []).commands)).toEqual(['title'])
    expect(matchSlash('zzzz', library).commands).toEqual([])
  })

  it('ignores the case of what was typed', () => {
    expect(tokens(matchSlash('CODE', library).skills)).toEqual(['code-review'])
    expect(tokens(matchSlash('Cl', []).commands)).toEqual(['clear'])
  })

  it('offers a skill that shares a name with a command as skill:name, and keeps the command plain', () => {
    const skills = [skill('title', 'Writes a changelog title'), skill('Export')]
    const { commands, skills: listed } = matchSlash('', skills)
    expect(tokens(commands)).toContain('title')
    expect(tokens(listed)).toEqual(['skill:title', 'skill:Export'])
    const found = matchSlash('title', skills)
    expect(tokens(found.commands)).toEqual(['title'])
    expect(tokens(found.skills)).toEqual(['skill:title'])
  })

  it('shows only skills, spelled skill:name, once "skill:" is typed', () => {
    const matches = matchSlash('skill:', library)
    expect(matches.commands).toEqual([])
    expect(tokens(matches.skills)).toEqual(['skill:code-review', 'skill:debugging', 'skill:frontend-engineering'])
    expect(tokens(matchSlash('skill:de', library).skills)).toEqual(['skill:debugging', 'skill:code-review'])
  })

  it('carries the skill with its row, so the menu can show where it comes from', () => {
    const [entry] = matchSlash('code', [skill('code-review', 'Reviews diffs', 'cubex')]).skills
    expect(entry).toMatchObject({ kind: 'skill', token: 'code-review', skill: { source: 'cubex', description: 'Reviews diffs' } })
  })
})

describe('reading a message that starts with a slash', () => {
  it('splits the name from what follows', () => {
    expect(parseSlash('/goal ship the fix')).toEqual({ name: 'goal', rest: 'ship the fix', explicit: false })
    expect(parseSlash('/new')).toEqual({ name: 'new', rest: '', explicit: false })
    expect(parseSlash('  /new')).toBeNull()
    expect(parseSlash('/new   ')).toEqual({ name: 'new', rest: '', explicit: false })
  })

  it('takes the whole name, with hyphens, dots and underscores', () => {
    expect(parseSlash('/frontend-engineering build it')).toEqual({ name: 'frontend-engineering', rest: 'build it', explicit: false })
    expect(parseSlash('/pdf.v2_tools x')).toEqual({ name: 'pdf.v2_tools', rest: 'x', explicit: false })
    expect(parseSlash('/new-chat')).toEqual({ name: 'new-chat', rest: '', explicit: false })
  })

  it('keeps what follows the name across lines', () => {
    expect(parseSlash('/goal first line\nsecond line\n\nthird')).toEqual({ name: 'goal', rest: 'first line\nsecond line\n\nthird', explicit: false })
    expect(parseSlash('/new\nthen this')).toEqual({ name: 'new', rest: 'then this', explicit: false })
  })

  it('recognizes the skill: spelling', () => {
    expect(parseSlash('/skill:title tidy it')).toEqual({ name: 'title', rest: 'tidy it', explicit: true })
    expect(parseSlash('/skill:Code-Review')).toEqual({ name: 'Code-Review', rest: '', explicit: true })
  })

  it('does not read anything else as a name', () => {
    for (const text of ['/', '/-x', '/skill:', '/usr/bin/env', '/title: x', 'plain text', '']) expect(parseSlash(text)).toBeNull()
  })

  it('names a built-in command in lower case, and never for the skill: spelling', () => {
    expect(parseCommand('/TITLE My plan')).toEqual({ name: 'title', rest: 'My plan' })
    expect(parseCommand('/skill:title tidy it')).toBeNull()
    expect(parseCommand('/new-chat')).toEqual({ name: 'new-chat', rest: '' })
    expect(isCommandName('new-chat')).toBe(false)
    expect(isCommandName('Settings')).toBe(true)
  })
})

describe('telling a skill from a command or a plain message', () => {
  const skills = [skill('code-review'), skill('title'), skill('Frontend-Engineering')]

  it('applies a skill named plainly, with what follows as the request', () => {
    expect(skillInvocation('/code-review check the diff', skills)).toEqual({ skill: 'code-review', request: 'check the diff' })
    expect(skillInvocation('/code-review', skills)).toEqual({ skill: 'code-review', request: '' })
  })

  it('answers with the name the catalog spells, whatever case was typed', () => {
    expect(skillInvocation('/frontend-engineering build it', skills)).toEqual({ skill: 'Frontend-Engineering', request: 'build it' })
  })

  it('leaves the plain spelling of a command to the command', () => {
    expect(skillInvocation('/title Rename me', skills)).toBeUndefined()
    expect(skillInvocation('/skill:title Rename me', skills)).toEqual({ skill: 'title', request: 'Rename me' })
  })

  it('leaves other messages alone', () => {
    expect(skillInvocation('/unknown-thing do it', skills)).toBeUndefined()
    expect(skillInvocation('/code-review', undefined)).toBeUndefined()
    expect(skillInvocation('hello', skills)).toBeUndefined()
    expect(skillInvocation('/usr/bin/env', skills)).toBeUndefined()
  })

  it('passes the skill: spelling on even when the list does not have the name, for the main process to refuse', () => {
    expect(skillInvocation('/skill:nope hi', skills)).toEqual({ skill: 'nope', request: 'hi' })
    expect(skillInvocation('/skill:nope hi', undefined)).toEqual({ skill: 'nope', request: 'hi' })
  })

  it('keeps a request that spans lines', () => {
    expect(skillInvocation('/code-review one\ntwo', skills)).toEqual({ skill: 'code-review', request: 'one\ntwo' })
  })
})

describe('keys in the open menu', () => {
  const entries = matchSlash('', [skill('code-review'), skill('debugging')])
  const all = [...entries.commands, ...entries.skills]
  const menu = (active: number, draft = '/') => ({ entries: all, active, draft })

  it('moves through the rows and wraps at both ends', () => {
    expect(slashKeyAction(press('ArrowDown'), menu(0))).toEqual({ type: 'move', to: 1 })
    expect(slashKeyAction(press('ArrowDown'), menu(all.length - 1))).toEqual({ type: 'move', to: 0 })
    expect(slashKeyAction(press('ArrowUp'), menu(0))).toEqual({ type: 'move', to: all.length - 1 })
    expect(slashKeyAction(press('ArrowUp'), menu(3))).toEqual({ type: 'move', to: 2 })
  })

  it('closes on Escape', () => {
    expect(slashKeyAction(press('Escape'), menu(0))).toEqual({ type: 'dismiss' })
  })

  it('completes the highlighted row on Tab and on Enter', () => {
    const last = all.length - 1
    expect(slashKeyAction(press('Tab'), menu(last))).toEqual({ type: 'pick', entry: all[last] })
    expect(slashKeyAction(press('Enter'), menu(2, '/'))).toEqual({ type: 'pick', entry: all[2] })
  })

  it('lets Enter send a name that is already typed in full, but still completes a part of one', () => {
    const matches = matchSlash('code-review', [skill('code-review')])
    const found = [...matches.commands, ...matches.skills]
    expect(slashKeyAction(press('Enter'), { entries: found, active: 0, draft: '/code-review' })).toBeUndefined()
    expect(slashKeyAction(press('Enter'), { entries: found, active: 0, draft: '/CODE-Review' })).toBeUndefined()
    expect(slashKeyAction(press('Tab'), { entries: found, active: 0, draft: '/code-review' })).toEqual({ type: 'pick', entry: found[0] })
    const partial = matchSlash('code', [skill('code-review')])
    expect(slashKeyAction(press('Enter'), { entries: [...partial.commands, ...partial.skills], active: 0, draft: '/code' })).toMatchObject({ type: 'pick' })
    // The command that was typed in full runs on Enter, the way it always has.
    const clear = matchSlash('clear', [])
    expect(slashKeyAction(press('Enter'), { entries: clear.commands, active: 0, draft: '/clear' })).toBeUndefined()
  })

  it('leaves newline, send-with-modifier and other keys to the composer', () => {
    expect(slashKeyAction(press('Enter', { shiftKey: true }), menu(0))).toBeUndefined()
    expect(slashKeyAction(press('Enter', { ctrlKey: true }), menu(0))).toBeUndefined()
    expect(slashKeyAction(press('Tab', { shiftKey: true }), menu(0))).toBeUndefined()
    expect(slashKeyAction(press('ArrowDown', { shiftKey: true }), menu(0))).toBeUndefined()
    expect(slashKeyAction(press('a'), menu(0))).toBeUndefined()
  })

  it('does nothing when there are no rows, or the highlight points past them', () => {
    expect(slashKeyAction(press('ArrowDown'), { entries: [], active: 0, draft: '/zz' })).toBeUndefined()
    expect(slashKeyAction(press('Enter'), { entries: [], active: 0, draft: '/zz' })).toBeUndefined()
    expect(slashKeyAction(press('Tab'), menu(999))).toBeUndefined()
  })
})
