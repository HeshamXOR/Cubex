import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs'
import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadSkills, skillsCatalog, createSkillTool, readSkill, type SkillSource } from './skills'
import type { JSONValue, ToolExecutionContext } from '@core/types'

vi.mock('node:fs', async (importOriginal) => ({ ...await importOriginal<typeof import('node:fs')>() }))

const ctx: ToolExecutionContext = { requestPermission: async () => ({ decision: 'allow' }) }
let root: string
let bundled: string
const withoutBundled = { includeBundled: false }
const suppliedLibrary = fileURLToPath(new URL('../../agent-skills-library/', import.meta.url))
const suppliedIndex = JSON.parse(fs.readFileSync(join(suppliedLibrary, 'index.json'), 'utf8')) as {
  skills: { name: string; description: string; path: string; files: string[] }[]
}

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
  it('discovers metadata without retaining the instruction body', () => {
    const filePath = pack('code-review')
    const skills = loadSkills(root, withoutBundled)
    expect(skills).toEqual([{ name: 'code-review', description: 'Review a diff for bugs', source: 'cubex', filePath }])
    expect(skills[0]).not.toHaveProperty('body')
    expect(readSkill(skills[0]!)).toContain('list issues by severity')
  })

  it('loads bundled skills without a workspace', () => {
    pack('frontend', 'bundled')
    expect(loadSkills(undefined, { bundledRoot: bundled })).toMatchObject([{ name: 'frontend', source: 'bundled' }])
    expect(loadSkills(undefined, { bundledRoot: bundled, includeBundled: false })).toEqual([])
  })

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

  it('parses CRLF, quoted metadata, YAML comments and block scalar descriptions', () => {
    const quoted = pack('quoted')
    writeFileSync(quoted, '\uFEFF---\r\nname: "quoted" # name\r\ndescription: \'Review don\'\'t-repeat code\' # text\r\nmetadata:\r\n  owner: cubex\r\n---\r\nInstructions\r\n')
    const folded = pack('folded')
    writeFileSync(folded, '---\nname: folded\ndescription: >-\n  Design accessible\n  interfaces with clear states.\n---\nInstructions')
    const literal = pack('literal')
    writeFileSync(literal, '---\nname: literal\ndescription: |2- # folded for catalog\n  First line.\n\n  Second line.\n---\nInstructions')
    expect(loadSkills(root, withoutBundled).map((skill) => skill.description)).toEqual([
      'Design accessible interfaces with clear states.', 'First line. Second line.', "Review don't-repeat code"
    ])
  })

  it('caps catalog count and Unicode descriptions without truncating loaded instructions', () => {
    for (let index = 0; index < 66; index++) pack(`skill-${String(index).padStart(2, '0')}`, 'cubex', `Instructions ${index}`, '🧩'.repeat(1100))
    const skills = loadSkills(root, withoutBundled)
    expect(skills).toHaveLength(64)
    expect([...skills[0]!.description]).toHaveLength(1024)
    expect(readSkill(skills[0]!)).toBe('Instructions 0')
    expect(skills.at(-1)!.name).toBe('skill-63')
  })

  it('bounds directory enumeration even if a source contains only invalid packs', () => {
    const path = pack('invalid')
    writeFileSync(path, 'Not a skill')
    const readEntry = vi.fn(() => ({ name: 'missing' }))
    const closeDirectory = vi.fn()
    vi.spyOn(fs, 'opendirSync').mockReturnValue({ readSync: readEntry, closeSync: closeDirectory } as unknown as fs.Dir)
    expect(loadSkills(root, withoutBundled)).toEqual([])
    expect(readEntry).toHaveBeenCalledTimes(512)
    expect(closeDirectory).toHaveBeenCalledTimes(1)
  })

  it('supports Electron ASAR virtual inode values while bounding native descriptor reads', () => {
    bundled = join(root, 'app.asar', 'resources', 'skills')
    pack('frontend', 'bundled')
    const originalLstat = fs.lstatSync
    let virtualInode = 1
    vi.spyOn(fs, 'lstatSync').mockImplementation((path) => {
      const stat = originalLstat(path)
      stat.dev = 1
      stat.ino = virtualInode++
      return stat
    })
    const original = Object.getOwnPropertyDescriptor(process.versions, 'electron')
    Object.defineProperty(process.versions, 'electron', { configurable: true, value: 'test' })
    try {
      const skills = loadSkills(undefined, { bundledRoot: bundled })
      expect(skills).toMatchObject([{ name: 'frontend', source: 'bundled' }])
      expect(readSkill(skills[0]!)).toContain('list issues by severity')
    } finally {
      if (original) Object.defineProperty(process.versions, 'electron', original)
      else Reflect.deleteProperty(process.versions, 'electron')
    }
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

  it('rejects non-UTF-8 text and ignores directories without SKILL.md', () => {
    const path = pack('bad')
    writeFileSync(path, Buffer.from([0xff, 0xfe, 0x61]))
    mkdirSync(join(root, '.cubex', 'skills', 'empty'))
    expect(loadSkills(root, withoutBundled)).toEqual([])
    expect(loadSkills(join(root, 'does-not-exist'), withoutBundled)).toEqual([])
  })

  it('rejects directory links during discovery, including linked source roots', () => {
    pack('outside', 'bundled')
    mkdirSync(join(root, '.cubex', 'skills'), { recursive: true })
    symlinkSync(join(bundled, 'outside'), join(root, '.cubex', 'skills', 'linked'), 'junction')
    symlinkSync(bundled, join(root, '.agents'), 'junction')
    expect(loadSkills(root, withoutBundled)).toEqual([])
    expect(loadSkills(undefined, { bundledRoot: join(root, '.agents') })).toEqual([])
  })

  it('catalog advertises only names, sources and bounded descriptions', () => {
    pack('review', 'cubex', 'INSTRUCTIONS_STAY_LAZY')
    const catalog = skillsCatalog(loadSkills(root, withoutBundled))
    expect(catalog).toContain('- review (cubex): Review a diff for bugs')
    expect(catalog).toContain('resource')
    expect(catalog).not.toContain('INSTRUCTIONS_STAY_LAZY')
    expect(catalog).not.toContain(root)
    expect(skillsCatalog([])).toBe('')
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

  it('detects metadata changes even outside the shortened catalog description', () => {
    const path = pack('review', 'cubex', 'Body', 'a'.repeat(1100))
    const skills = loadSkills(root, withoutBundled)
    writeFileSync(path, `---\nname: review\ndescription: ${'a'.repeat(1099)}b\n---\nBody`)
    expect(() => readSkill(skills[0]!)).toThrow('metadata changed')
  })

  it('returns real errors if a discovered skill disappears or becomes oversized', async () => {
    const path = pack('review')
    const tool = createSkillTool(loadSkills(root, withoutBundled))
    writeFileSync(path, 'x'.repeat(140_000))
    expect(String((await tool.execute({ name: 'review' }, ctx)).content)).toContain('byte limit')
    rmSync(path)
    const missing = await tool.execute({ name: 'review' }, ctx)
    expect(missing.isError).toBe(true)
    expect(String(missing.content)).toContain('ENOENT')
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

  it.each<JSONValue>([null, 'review', [], 17, true, {}, { name: 12 }, { name: '' }, { name: '../review' }, { name: 'review', resource: 9 }, { name: 'review', extra: true }])('handles malformed tool input %j', async (input) => {
    pack('review')
    const result = await createSkillTool(loadSkills(root, withoutBundled)).execute(input, ctx)
    expect(result.isError).toBe(true)
    expect(String(result.content)).toContain('Expected')
  })

  it('reports unknown skills and cancelled requests', async () => {
    pack('review')
    const tool = createSkillTool(loadSkills(root, withoutBundled))
    expect(String((await tool.execute({ name: 'missing' }, ctx)).content)).toContain('Available: review')
    const controller = new AbortController()
    controller.abort()
    const result = await tool.execute({ name: 'review' }, { ...ctx, signal: controller.signal })
    expect(result.isError).toBe(true)
    expect(String(result.content)).toContain('cancelled')
  })
})

describe('skill support resources', () => {
  it('reads referenced text on demand with a clear relative path hint', async () => {
    pack('frontend')
    const dir = join(root, '.cubex', 'skills', 'frontend', 'references')
    mkdirSync(dir)
    writeFileSync(join(dir, 'a11y.md'), '# Accessibility\nUse native buttons.')
    const result = await createSkillTool(loadSkills(root, withoutBundled)).execute({ name: 'frontend', resource: 'references/a11y.md' }, ctx)
    expect(result.isError).toBeFalsy()
    expect(String(result.content)).toContain('# Skill: frontend / references/a11y.md')
    expect(String(result.content)).toContain('Use native buttons.')
    expect(String(result.content)).toContain('never executed')
  })

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

  it('returns errors for missing, oversized and binary resources, and never executes script text', async () => {
    pack('review')
    const dir = join(root, '.cubex', 'skills', 'review')
    writeFileSync(join(dir, 'binary.bin'), Buffer.from([0, 1, 2]))
    writeFileSync(join(dir, 'large.md'), 'x'.repeat(65_537))
    writeFileSync(join(dir, 'example.js'), 'throw new Error("This is only source text")')
    const tool = createSkillTool(loadSkills(root, withoutBundled))
    for (const resource of ['missing.md', 'binary.bin', 'large.md']) expect((await tool.execute({ name: 'review', resource }, ctx)).isError).toBe(true)
    const script = await tool.execute({ name: 'review', resource: 'example.js' }, ctx)
    expect(script.isError).toBeFalsy()
    expect(String(script.content)).toContain('This is only source text')
  })
})

describe('supplied bundled library', () => {
  it('uses the supplied catalog with complete trigger descriptions, keeping bodies lazy', () => {
    const skills = loadSkills()
    expect(skills).toHaveLength(18)
    expect(skills.map((skill) => skill.name)).toEqual(suppliedIndex.skills.map((skill) => skill.name))
    const catalog = skillsCatalog(skills)
    for (const entry of suppliedIndex.skills) {
      const skill = skills.find((item) => item.name === entry.name)!
      expect(skill).toEqual({
        name: entry.name, description: entry.description, source: 'bundled',
        filePath: join(suppliedLibrary, entry.path)
      })
      expect(catalog).toContain(entry.description)
      expect(catalog).not.toContain(readSkill(skill))
    }
  })

  it('reads all supplied instructions and supporting resources without rewriting their content', async () => {
    const skills = loadSkills()
    const tool = createSkillTool(skills)
    for (const entry of suppliedIndex.skills) {
      const skill = skills.find((item) => item.name === entry.name)!
      const source = fs.readFileSync(join(suppliedLibrary, entry.path), 'utf8').replace(/\r\n?/g, '\n')
      const originalBody = source.replace(/^---\n[\s\S]*?\n---\n/, '').trim()
      expect(readSkill(skill)).toBe(originalBody)
      for (const resource of entry.files) {
        const result = await tool.execute({ name: entry.name, resource }, ctx)
        expect(result.isError, `${entry.name}/${resource}`).toBeFalsy()
        const original = fs.readFileSync(join(suppliedLibrary, 'skills', entry.name, resource), 'utf8').replace(/\r\n?/g, '\n')
        expect(String(result.content)).toContain(original)
      }
    }
  })

  it('can load cross-skill references through the referenced skill without directory traversal', async () => {
    const skills = loadSkills()
    const tool = createSkillTool(skills)
    const names = new Set(skills.map((skill) => skill.name))
    let crossReferences = 0
    for (const skill of skills) {
      for (const match of readSkill(skill).matchAll(/`([a-z0-9-]+\/((?:references|assets|scripts)\/[A-Za-z0-9_.\-/]+))`/g)) {
        const name = match[1]!.split('/')[0]!
        expect(names.has(name), `Referenced skill ${name}`).toBe(true)
        const result = await tool.execute({ name, resource: match[2]! }, ctx)
        expect(result.isError, match[1]).toBeFalsy()
        crossReferences++
      }
    }
    expect(crossReferences).toBeGreaterThan(0)
  })
})
