import { promises as fs } from 'node:fs'
import { join, resolve, relative, sep, extname } from 'node:path'
import type { ExecutableTool, JSONValue, ToolResult } from '@core/types'

/**
 * Workspace-scoped file tools. Every path is resolved against the workspace root
 * and rejected if it escapes it (path-traversal guard). Read/list/search are
 * `allow` by default; write/edit are `ask` so the user approves each mutation.
 */

const MAX_READ_BYTES = 256 * 1024
const SKIP_DIRS = new Set(['node_modules', '.git', 'out', 'dist', 'release', '.cache', '.next'])
const TEXT_EXT = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.json', '.md', '.txt', '.css', '.scss', '.html', '.yml', '.yaml',
  '.toml', '.py', '.rs', '.go', '.java', '.c', '.cpp', '.h', '.sh', '.env', '.sql', '.xml', '.svg'
])

function safeResolve(root: string, rel: string): string {
  const abs = resolve(root, rel ?? '.')
  const within = abs === root || abs.startsWith(root + sep)
  if (!within) throw new Error(`Path escapes the workspace: ${rel}`)
  return abs
}

function ok(id: string, content: string): ToolResult {
  return { toolUseId: id, content }
}
function fail(id: string, content: string): ToolResult {
  return { toolUseId: id, content, isError: true }
}

function countLines(s: string): number {
  if (!s) return 0
  return s.split('\n').length
}

export function createFileTools(workspaceRoot: string): ExecutableTool[] {
  const root = resolve(workspaceRoot)

  const listFiles: ExecutableTool = {
    definition: {
      name: 'list_files',
      description: 'List files and folders inside the workspace. Provide a relative path (default: root).',
      inputSchema: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Relative folder path; default is the workspace root.' } }
      }
    },
    defaultPermission: 'allow',
    async execute(input: JSONValue): Promise<ToolResult> {
      const { path = '.' } = (input ?? {}) as { path?: string }
      try {
        const dir = safeResolve(root, path)
        const entries = await fs.readdir(dir, { withFileTypes: true })
        const lines = entries
          .filter((e) => !SKIP_DIRS.has(e.name))
          .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
          .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
        return ok('', lines.length ? lines.join('\n') : '(empty)')
      } catch (e) {
        return fail('', `list_files failed: ${(e as Error).message}`)
      }
    }
  }

  const readFile: ExecutableTool = {
    definition: {
      name: 'read_file',
      description: 'Read a UTF-8 text file inside the workspace. Returns up to 256 KiB.',
      inputSchema: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Relative file path.' } },
        required: ['path']
      }
    },
    defaultPermission: 'allow',
    async execute(input: JSONValue): Promise<ToolResult> {
      const { path } = (input ?? {}) as { path?: string }
      if (!path) return fail('', 'read_file requires "path".')
      try {
        const abs = safeResolve(root, path)
        const stat = await fs.stat(abs)
        if (stat.size > MAX_READ_BYTES) return fail('', `File too large (${stat.size} bytes; max ${MAX_READ_BYTES}).`)
        const text = await fs.readFile(abs, 'utf8')
        return ok('', text)
      } catch (e) {
        return fail('', `read_file failed: ${(e as Error).message}`)
      }
    }
  }

  const searchFiles: ExecutableTool = {
    definition: {
      name: 'search_files',
      description: 'Search text files in the workspace for a substring (case-insensitive). Returns matching path:line: text.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Substring to search for.' },
          path: { type: 'string', description: 'Relative folder to search under (default: root).' }
        },
        required: ['query']
      }
    },
    defaultPermission: 'allow',
    async execute(input: JSONValue): Promise<ToolResult> {
      const { query, path = '.' } = (input ?? {}) as { query?: string; path?: string }
      if (!query) return fail('', 'search_files requires "query".')
      const needle = query.toLowerCase()
      const hits: string[] = []
      const start = safeResolve(root, path)
      const walk = async (dir: string): Promise<void> => {
        if (hits.length >= 100) return
        const entries = await fs.readdir(dir, { withFileTypes: true })
        for (const e of entries) {
          if (hits.length >= 100) break
          if (SKIP_DIRS.has(e.name)) continue
          const abs = join(dir, e.name)
          if (e.isDirectory()) await walk(abs)
          else if (TEXT_EXT.has(extname(e.name))) {
            try {
              const stat = await fs.stat(abs)
              if (stat.size > MAX_READ_BYTES) continue
              const text = await fs.readFile(abs, 'utf8')
              text.split('\n').forEach((ln, i) => {
                if (hits.length < 100 && ln.toLowerCase().includes(needle)) {
                  hits.push(`${relative(root, abs)}:${i + 1}: ${ln.trim().slice(0, 200)}`)
                }
              })
            } catch {
              /* skip unreadable */
            }
          }
        }
      }
      try {
        await walk(start)
        return ok('', hits.length ? hits.join('\n') : `No matches for "${query}".`)
      } catch (e) {
        return fail('', `search_files failed: ${(e as Error).message}`)
      }
    }
  }

  const writeFile: ExecutableTool = {
    definition: {
      name: 'write_file',
      description: 'Create or overwrite a text file in the workspace. Requires user approval.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Relative file path.' },
          content: { type: 'string', description: 'Full new file contents.' }
        },
        required: ['path', 'content']
      }
    },
    defaultPermission: 'ask',
    async execute(input: JSONValue): Promise<ToolResult> {
      const { path, content = '' } = (input ?? {}) as { path?: string; content?: string }
      if (!path) return fail('', 'write_file requires "path".')
      try {
        const abs = safeResolve(root, path)
        let prev = ''
        try {
          prev = await fs.readFile(abs, 'utf8')
        } catch {
          /* new file */
        }
        await fs.mkdir(resolve(abs, '..'), { recursive: true })
        await fs.writeFile(abs, content, 'utf8')
        const before = prev ? countLines(prev) : 0
        const after = countLines(content)
        const added = Math.max(0, after - before)
        const removed = prev ? Math.max(0, before - after) : 0
        // Diff stats are surfaced to the UI via the parsed marker below.
        return ok(
          '',
          `Wrote ${relative(root, abs)} (${prev ? 'updated' : 'created'}). ` +
            `«diff added=${prev ? added : after} removed=${removed}»`
        )
      } catch (e) {
        return fail('', `write_file failed: ${(e as Error).message}`)
      }
    }
  }

  return [listFiles, readFile, searchFiles, writeFile]
}

/** Parse the «diff added=N removed=M» marker a file tool may append to its result. */
export function parseDiffMarker(text: string): { added: number; removed: number } | undefined {
  const m = /«diff added=(\d+) removed=(\d+)»/.exec(text)
  if (!m) return undefined
  return { added: Number(m[1]), removed: Number(m[2]) }
}
