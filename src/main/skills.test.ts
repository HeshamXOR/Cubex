import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadSkills, createSkillTool, readSkill, type SkillSource } from './skills'
import type { ToolExecutionContext } from '@core/types'

vi.mock('node:fs', async (importOriginal) => ({ ...await importOriginal<typeof import('node:fs')>() }))

const ctx: ToolExecutionContext = { requestPermission: async () => ({ decision: 'allow' }) }
let root: string
let bundled: string
const withoutBundled = { includeBundled: false }

function pack(name: string, source: SkillSource = 'cubex', body = 'Read the diff, then list issues by severity.', description = 'Review a diff for bugs'): string {
  const dir = source === 'bundled' ? join(bundled, name) : join(root, `.${source}`, 'skills', name)
  mkdirSync(dir, { recursive: true })
  const path = join(dir, 'SKILL.md')
  writeFileSync(path, `---\nname: ${name}\ndescription: ${description}\n---\n${body}`)
  return path
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cubex-skills-'))
  bundled = join(root, 'builtins')
  mkdirSync(bundled)
})

afterEach(() => {
  vi.restoreAllMocks()
  rmSync(root, { recursive: true, force: true })
})

describe('skill discovery', () => {

  it('uses deterministic cubex, agents, claude, bundled precedence and name deduplication', () => {
    pack('shared', 'bundled')
    pack('shared', 'claude')
    pack('shared', 'agents')
    pack('shared', 'cubex')
    pack('claude-only', 'claude')
    pack('agents-only', 'agents')
    pack('z-last')
    pack('a-first')
    const alternate = pack('alternate')
    writeFileSync(alternate, '---\nname: SHARED\ndescription: Duplicate with different casing\n---\nDuplicate')
    const skills = loadSkills(root, { bundledRoot: bundled })
    expect(skills.map((skill) => `${skill.name}:${skill.source}`)).toEqual(['a-first:cubex', 'SHARED:cubex', 'z-last:cubex', 'agents-only:agents', 'claude-only:claude'])
  })

  it.each([
    ['missing frontmatter', 'Plain instructions'],
    ['unclosed frontmatter', '---\nname: bad\ndescription: Missing closing fence'],
    ['missing name', '---\ndescription: Description\n---\nBody'],
    ['empty description', '---\nname: bad\ndescription: ""\n---\nBody'],
    ['invalid name', '---\nname: ../escape\ndescription: Description\n---\nBody'],
    ['empty body', '---\nname: bad\ndescription: Description\n---\n \n'],
    ['broken quote', '---\nname: bad\ndescription: "not closed\n---\nBody'],
    ['duplicate name', '---\nname: bad\nname: duplicate\ndescription: Description\n---\nBody'],
    ['object metadata', '---\nname: bad\ndescription: {unsafe: value}\n---\nBody'],
    ['binary', '---\nname: bad\ndescription: Description\n---\nBody\u0000'],
    ['escaped control characters', '---\nname: bad\ndescription: "Description\\u0000"\n---\nBody'],
    ['oversized body', `---\nname: bad\ndescription: Description\n---\n${'x'.repeat(131_072)}`],
    ['oversized header', `---\nname: bad\ndescription: ${'x'.repeat(8_192)}\n---\nBody`]
  ])('rejects %s', (_label, text) => {
    const path = pack('bad')
    writeFileSync(path, text)
    expect(loadSkills(root, withoutBundled)).toEqual([])
  })

  it('rejects directory links during discovery, including linked source roots', () => {
    pack('outside', 'bundled')
    mkdirSync(join(root, '.cubex', 'skills'), { recursive: true })
    symlinkSync(join(bundled, 'outside'), join(root, '.cubex', 'skills', 'linked'), 'junction')
    symlinkSync(bundled, join(root, '.agents'), 'junction')
    expect(loadSkills(root, withoutBundled)).toEqual([])
    expect(loadSkills(undefined, { bundledRoot: join(root, '.agents') })).toEqual([])
  })
})

describe('on-demand skill loading', () => {
  it('reads the current body after discovery', async () => {
    const path = pack('review', 'cubex', 'Initial body')
    const skills = loadSkills(root, withoutBundled)
    writeFileSync(path, '---\nname: review\ndescription: Review a diff for bugs\n---\nUpdated body')
    expect(readSkill(skills[0]!)).toBe('Updated body')
    const result = await createSkillTool(skills).execute({ name: 'REVIEW' }, ctx)
    expect(result.isError).toBeFalsy()
    expect(String(result.content)).toContain('Updated body')
    expect(String(result.content)).toContain('relative to this skill folder')
  })

  it('rejects changed metadata rather than loading instructions under a stale catalog entry', async () => {
    const path = pack('review')
    const skills = loadSkills(root, withoutBundled)
    writeFileSync(path, '---\nname: review\ndescription: A changed description\n---\nChanged body')
    expect(() => readSkill(skills[0]!)).toThrow('metadata changed')
    const result = await createSkillTool(skills).execute({ name: 'review' }, ctx)
    expect(result.isError).toBe(true)
    expect(String(result.content)).toContain('Refresh the skills catalog')
  })

  it('rejects caller-created metadata and links introduced after discovery', async () => {
    pack('review')
    pack('outside', 'bundled')
    const skills = loadSkills(root, withoutBundled)
    expect(() => readSkill({ ...skills[0]! })).toThrow('not discovered')
    const skillDir = join(root, '.cubex', 'skills', 'review')
    rmSync(skillDir, { recursive: true })
    symlinkSync(join(bundled, 'outside'), skillDir, 'junction')
    const result = await createSkillTool(skills).execute({ name: 'review' }, ctx)
    expect(result.isError).toBe(true)
    expect(String(result.content)).toContain('links or junctions')
  })
})

describe('skill support resources', () => {

  it.each(['../outside.md', 'references/../../outside.md', '..\\outside.md', '/outside.md', 'C:\\outside.md', '\\\\server\\outside.md', 'file.md:stream', '', 'a//b', './SKILL.md', 'a\u0000b'])('rejects unsafe resource %j', async (resource) => {
    pack('review')
    const result = await createSkillTool(loadSkills(root, withoutBundled)).execute({ name: 'review', resource }, ctx)
    expect(result.isError).toBe(true)
  })

  it('rejects resource junction escapes and revalidates metadata before reading support files', async () => {
    const path = pack('review')
    const dir = join(root, '.cubex', 'skills', 'review')
    const outside = join(root, 'outside')
    mkdirSync(outside)
    writeFileSync(join(outside, 'secret.md'), 'NOT_A_SKILL_RESOURCE')
    symlinkSync(outside, join(dir, 'references'), 'junction')
    const tool = createSkillTool(loadSkills(root, withoutBundled))
    const escape = await tool.execute({ name: 'review', resource: 'references/secret.md' }, ctx)
    expect(escape.isError).toBe(true)
    expect(String(escape.content)).not.toContain('NOT_A_SKILL_RESOURCE')
    writeFileSync(join(dir, 'safe.md'), 'Safe resource')
    writeFileSync(path, '---\nname: different\ndescription: Review a diff for bugs\n---\nBody')
    expect(String((await tool.execute({ name: 'review', resource: 'safe.md' }, ctx)).content)).toContain('metadata changed')
  })
})
