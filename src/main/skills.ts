import {
  closeSync, constants, fstatSync, lstatSync, openSync, opendirSync,
  readSync, readdirSync, realpathSync
} from 'node:fs'
import { isAbsolute, join, relative, resolve, sep, win32 } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ExecutableTool, JSONValue, ToolExecutionContext, ToolResult } from '@core/types'

export type SkillSource = 'bundled' | 'cubex' | 'agents' | 'claude'

/** Catalog metadata only. Instruction bodies are read afresh when a skill is used. */
export interface Skill {
  name: string
  description: string
  source: SkillSource
  filePath: string
}

export interface LoadSkillsOptions {
  bundledRoot?: string
  includeBundled?: boolean
}

const MAX_SKILLS = 64
const MAX_ENTRIES_PER_SOURCE = 512
// Preserve the supplied library's trigger clauses as well as its capability
// summary. Agent Skills descriptions are bounded at 1024 characters.
const MAX_DESCRIPTION_CHARACTERS = 1024
const MAX_HEADER_BYTES = 8_192
const MAX_SKILL_BYTES = 131_072
const MAX_RESOURCE_BYTES = 65_536
const VALID_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/
const DEFAULT_BUNDLED_ROOT = fileURLToPath(new URL('../../agent-skills-library/skills/', import.meta.url))

interface SkillLocation {
  anchor: string
  folder: string
  name: string
  description: string
}

interface ParsedSkill {
  name: string
  description: string
  body: string
}

// Avoid retaining instructions, exposing trust roots over IPC, or accepting caller-created paths.
const locations = new WeakMap<Skill, SkillLocation>()

function contained(root: string, target: string): boolean {
  const rel = relative(root, target)
  return !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`)
}

function inElectronArchive(path: string): boolean {
  return Boolean(process.versions.electron) && /(?:^|[/\\])[^/\\]+\.asar[/\\]/i.test(path)
}

/** Every component is checked because Windows directory junctions can otherwise escape a root. */
function checkedPath(root: string, target: string, kind: 'file' | 'directory'): string {
  const absoluteRoot = resolve(root)
  const absoluteTarget = resolve(target)
  if (!contained(absoluteRoot, absoluteTarget)) throw new Error('Path must stay inside its skill directory.')
  const rootStat = lstatSync(absoluteRoot)
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new Error('Skill roots must be real directories, not links.')
  let cursor = absoluteRoot
  const parts = relative(absoluteRoot, absoluteTarget).split(sep).filter(Boolean)
  for (let index = 0; index < parts.length; index++) {
    cursor = join(cursor, parts[index]!)
    const entry = lstatSync(cursor)
    if (entry.isSymbolicLink()) throw new Error('Skills cannot read through symbolic links or junctions.')
    if (index < parts.length - 1 && !entry.isDirectory()) throw new Error('A skill path component is not a directory.')
  }
  const final = lstatSync(absoluteTarget)
  if (kind === 'file' ? !final.isFile() : !final.isDirectory()) throw new Error(`Expected a skill ${kind}.`)
  const realRoot = realpathSync(absoluteRoot)
  const realTarget = realpathSync(absoluteTarget)
  if (!contained(realRoot, realTarget)) throw new Error('Resolved path escapes its skill directory.')
  return absoluteTarget
}

function readText(root: string, target: string, limit: number): string {
  const path = checkedPath(root, target, 'file')
  const beforePath = lstatSync(path)
  // Electron assigns new virtual inode values on each ASAR stat. openSync
  // extracts the entry and returns a native descriptor with different values.
  const archiveEntry = inElectronArchive(path)
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const before = fstatSync(fd)
    if (!before.isFile() || before.size > limit) {
      throw new Error(`Skill text exceeds the ${limit.toLocaleString('en-US')}-byte limit or is not a regular file.`)
    }
    const bytes = Buffer.alloc(Math.min(before.size + 1, limit + 1))
    let used = 0
    while (used < bytes.length) {
      const count = readSync(fd, bytes, used, bytes.length - used, used)
      if (count === 0) break
      used += count
    }
    const after = fstatSync(fd)
    checkedPath(root, path, 'file')
    const current = lstatSync(path)
    const identityChanged = !archiveEntry && (
      beforePath.dev !== current.dev || beforePath.ino !== current.ino ||
      before.dev !== current.dev || before.ino !== current.ino
    )
    const contentChanged = beforePath.size !== current.size || beforePath.size !== before.size ||
      beforePath.mtimeMs !== current.mtimeMs || before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs || used !== before.size
    if (identityChanged || contentChanged) {
      throw new Error('Skill file changed while it was being read. Try loading it again.')
    }
    let text: string
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, used))
    } catch {
      throw new Error('Skill resources must contain valid UTF-8 text.')
    }
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) throw new Error('Binary or control-character content is not a skill text resource.')
    return text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')
  } finally {
    closeSync(fd)
  }
}

/** A small YAML scalar reader: no object construction, tags, or aliases. */
function scalar(value: string): string {
  const trimmed = value.trim()
  if (trimmed.startsWith("'")) {
    const match = /^'((?:[^']|'')*)'(?:[ \t]+#.*)?$/.exec(trimmed)
    if (!match) throw new Error('Invalid quoted skill metadata.')
    return match[1]!.replace(/''/g, "'")
  }
  if (trimmed.startsWith('"')) {
    const match = /^("(?:[^"\\]|\\.)*")(?:[ \t]+#.*)?$/.exec(trimmed)
    if (!match) throw new Error('Invalid quoted skill metadata.')
    try {
      return JSON.parse(match[1]!) as string
    } catch {
      throw new Error('Invalid quoted skill metadata.')
    }
  }
  if (/^[\[\]{},&*!|>@`]/.test(trimmed)) throw new Error('Skill metadata must be plain text, quoted text, or a description block.')
  return trimmed.replace(/[ \t]+#.*$/, '').trim()
}

function parseSkill(text: string): ParsedSkill {
  const lines = text.split('\n')
  if (!/^---[ \t]*$/.test(lines[0] ?? '')) throw new Error('SKILL.md must begin with YAML frontmatter.')
  const end = lines.findIndex((line, index) => index > 0 && /^---[ \t]*$/.test(line))
  if (end < 0 || Buffer.byteLength(lines.slice(0, end + 1).join('\n'), 'utf8') > MAX_HEADER_BYTES) {
    throw new Error('Missing or oversized skill frontmatter.')
  }
  const values = new Map<string, string>()
  for (let index = 1; index < end; index++) {
    const line = lines[index]!
    if (!line.trim() || line.trimStart().startsWith('#') || /^[ \t]/.test(line)) continue
    const pair = /^([a-zA-Z][\w-]*)[ \t]*:[ \t]*(.*)$/.exec(line)
    if (!pair) throw new Error('Invalid skill frontmatter entry.')
    const key = pair[1]!
    if (key !== 'name' && key !== 'description') continue
    if (values.has(key)) throw new Error(`Duplicate skill ${key}.`)
    const raw = pair[2]!
    const block = /^([>|])(?:(?:[+-][1-9]?)|(?:[1-9][+-]?))?(?:[ \t]+#.*)?$/.test(raw.trim())
    if (block) {
      if (key !== 'description') throw new Error('Skill names must fit on one line.')
      const content: string[] = []
      while (index + 1 < end && (!lines[index + 1]!.trim() || /^[ \t]/.test(lines[index + 1]!))) {
        content.push(lines[++index]!.trim())
      }
      values.set(key, content.join('\n'))
    } else {
      values.set(key, scalar(raw))
    }
  }
  const name = values.get('name')?.trim() ?? ''
  const description = (values.get('description') ?? '').replace(/\s+/g, ' ').trim()
  const body = lines.slice(end + 1).join('\n').trim()
  if (!VALID_NAME.test(name)) throw new Error('Skill names must be 1–64 letters, digits, dots, underscores, or hyphens, beginning with a letter or digit.')
  if (!description || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(description)) {
    throw new Error('Skills need a nonempty plain-text description.')
  }
  if (!body) throw new Error('Skills need a nonempty Markdown body.')
  return { name, description, body }
}

/** Workspace packs override builtins by name: .cubex, .agents, then .claude.
 * At most 512 directory entries are scanned per source and 64 skills returned;
 * packs beyond a source's scan cap may be omitted from the catalog.
 */
export function loadSkills(workspace?: string, options: LoadSkillsOptions = {}): Skill[] {
  const sources: { source: SkillSource; anchor: string; root: string }[] = []
  if (workspace) {
    const anchor = resolve(workspace)
    for (const source of ['cubex', 'agents', 'claude'] as const) {
      sources.push({ source, anchor, root: join(anchor, `.${source}`, 'skills') })
    }
  }
  if (options.includeBundled !== false) {
    const root = resolve(options.bundledRoot ?? DEFAULT_BUNDLED_ROOT)
    sources.push({ source: 'bundled', anchor: root, root })
  }
  const out: Skill[] = []
  const seen = new Set<string>()
  for (const { source, anchor, root } of sources) {
    let entries: string[]
    try {
      checkedPath(anchor, root, 'directory')
      if (source === 'bundled' && inElectronArchive(root)) {
        // Electron cannot opendir an ASAR. This exception is limited to our
        // packaged, release-owned catalog; workspace enumeration stays bounded.
        entries = readdirSync(root).slice(0, MAX_ENTRIES_PER_SOURCE)
      } else {
        const directory = opendirSync(root, { bufferSize: 32 })
        entries = []
        try {
          while (entries.length < MAX_ENTRIES_PER_SOURCE) {
            const entry = directory.readSync()
            if (!entry) break
            entries.push(entry.name)
          }
        } finally {
          directory.closeSync()
        }
      }
      entries.sort((a, b) => a < b ? -1 : a > b ? 1 : 0)
    } catch {
      continue
    }
    for (const entry of entries) {
      if (out.length === MAX_SKILLS) return out
      const folder = join(root, entry)
      const filePath = join(folder, 'SKILL.md')
      try {
        const parsed = parseSkill(readText(anchor, filePath, MAX_SKILL_BYTES))
        const key = parsed.name.toLowerCase()
        if (seen.has(key)) continue
        seen.add(key)
        const skill: Skill = Object.freeze({
          name: parsed.name,
          description: [...parsed.description].slice(0, MAX_DESCRIPTION_CHARACTERS).join(''),
          source,
          filePath
        })
        locations.set(skill, { anchor, folder, name: parsed.name, description: parsed.description })
        out.push(skill)
      } catch {
        // Broken, oversized, or unsafe packs never become advertised capabilities.
      }
    }
  }
  return out
}

function currentSkill(skill: Skill): { parsed: ParsedSkill; location: SkillLocation } {
  const location = locations.get(skill)
  if (!location) throw new Error('Skill was not discovered by the skill catalog. Reload available skills.')
  const parsed = parseSkill(readText(location.anchor, skill.filePath, MAX_SKILL_BYTES))
  if (parsed.name !== location.name || parsed.description !== location.description) {
    throw new Error('Skill metadata changed after discovery. Refresh the skills catalog before using it.')
  }
  return { parsed, location }
}

/** Read current instructions for a discovered skill; unsafe or stale metadata throws. */
export function readSkill(skill: Skill): string {
  return currentSkill(skill).parsed.body
}

/** Only bounded names and descriptions are included in the model's initial context. */
export function skillsCatalog(skills: Skill[]): string {
  if (skills.length === 0) return ''
  const list = skills.slice(0, MAX_SKILLS)
    .map((skill) => `- ${skill.name} (${skill.source}): ${skill.description}`).join('\n')
  return 'Available skills (instructions load on demand). Match the task to these descriptions; call `skill` with the relevant name before using its workflow. Load only the skills needed for the current task. Use `resource` for a relative text file referenced by that skill; this tool never executes files.\n' + list
}

function cancelled(ctx: ToolExecutionContext): void {
  if (ctx.signal?.aborted) throw new Error('Skill loading was cancelled.')
}

function readResource(skill: Skill, resource: string): string {
  const { location } = currentSkill(skill)
  if (!resource || resource.length > 512 || /[\u0000-\u001f:]/.test(resource) || isAbsolute(resource) || win32.isAbsolute(resource)) {
    throw new Error('Skill resources must be relative text-file paths inside the selected skill directory.')
  }
  const parts = resource.replace(/\\/g, '/').split('/')
  if (parts.some((part) => !part || part === '.' || part === '..')) throw new Error('Skill resource traversal is not allowed.')
  checkedPath(location.anchor, location.folder, 'directory')
  // Keep the original anchor during both pre- and post-read validation: a source
  // directory replaced with a junction must not become the new trusted root.
  return readText(location.anchor, join(location.folder, ...parts), MAX_RESOURCE_BYTES)
}

/** Read-only progressive disclosure, including optional Markdown/examples referenced by a pack. */
export function createSkillTool(skills: Skill[]): ExecutableTool {
  const byName = new Map(skills.slice(0, MAX_SKILLS).map((skill) => [skill.name.toLowerCase(), skill]))
  return {
    definition: {
      name: 'skill',
      description: 'Load instructions for a relevant skill by name before applying its workflow. Optionally read a relative text resource referenced by that skill. This tool only reads files; it does not execute scripts.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'An available skill name.' },
          resource: { type: 'string', description: 'Optional relative text-file path within this skill, such as references/accessibility.md. Omit to load SKILL.md instructions.' }
        },
        required: ['name'],
        additionalProperties: false
      }
    },
    defaultPermission: 'allow',
    async execute(input: JSONValue, ctx: ToolExecutionContext): Promise<ToolResult> {
      try {
        cancelled(ctx)
        if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some((key) => key !== 'name' && key !== 'resource')) {
          throw new Error('Expected an object with a skill name and optional resource path.')
        }
        const { name, resource } = input
        if (typeof name !== 'string' || !VALID_NAME.test(name) || (resource !== undefined && typeof resource !== 'string')) {
          throw new Error('Expected a valid skill name and an optional string resource path.')
        }
        const skill = byName.get(name.toLowerCase())
        if (!skill) throw new Error(`No skill named "${name}". Available: ${[...byName.values()].map((item) => item.name).join(', ') || '(none)'}.`)
        const body = resource === undefined ? readSkill(skill) : readResource(skill, resource)
        cancelled(ctx)
        const hint = 'Referenced files are relative to this skill folder. Read one with the skill tool using this name and a resource path. For a cross-skill reference such as other-skill/references/example.md, use name="other-skill" and resource="references/example.md"; never traverse out of a skill folder. Scripts are returned as text and are never executed.'
        return {
          toolUseId: '',
          content: `# Skill: ${skill.name}${resource === undefined ? '' : ` / ${resource.replace(/\\/g, '/')}`}\nSource: ${skill.source}\n\n${body}\n\n${hint}`
        }
      } catch (error) {
        return { toolUseId: '', content: `Could not load skill: ${error instanceof Error ? error.message : String(error)}`, isError: true }
      }
    }
  }
}
