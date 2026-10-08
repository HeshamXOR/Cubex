import type { DiagnosticsSummary, ToolActivity } from '../../../shared/ipc'
import type { MessageTranscriptBlock } from '../../../shared/messageTranscript'
import { diagnosticsForFile } from './problemCounts'

export const EXPLORE_TOOLS: ReadonlySet<string> = new Set(['read_file', 'list_files', 'search_files', 'glob_files'])
export const EDIT_TOOLS: ReadonlySet<string> = new Set(['write_file', 'edit_file', 'multi_edit', 'apply_patch', 'remove_file', 'delete_file'])
export const WEB_TOOLS: ReadonlySet<string> = new Set(['web_fetch', 'web_search'])

const KIND: Record<string, string> = {
  read_file: 'Read', write_file: 'Write', edit_file: 'Edit', multi_edit: 'Edit', apply_patch: 'Patch',
  remove_file: 'Remove', delete_file: 'Remove', list_files: 'List', search_files: 'Search', glob_files: 'Find',
  run_command: 'Run', web_fetch: 'Fetch', web_search: 'Web', skill: 'Skill', delegate_to_subagent: 'Subagent', consult_agent: 'Ask',
  exit_plan_mode: 'Plan', read_plan: 'Read plan', ask_user_question: 'Question', read_command_output: 'Read output'
}

const SUBAGENT_PREFIX = 'Subagent: '

export function toolKind(name: string): string {
  return KIND[name] ?? name
}

/** The title without its verb and without the subagent prefix: "Edit src/a.ts" becomes "src/a.ts". */
export function toolTarget(tool: Pick<ToolActivity, 'name' | 'title'>): string {
  const title = tool.title ?? ''
  const body = title.startsWith(SUBAGENT_PREFIX) ? title.slice(SUBAGENT_PREFIX.length) : title
  const kind = toolKind(tool.name)
  return body.toLowerCase().startsWith(`${kind.toLowerCase()} `) ? body.slice(kind.length + 1) : body
}

export function fromSubagent(tool: Pick<ToolActivity, 'title'>): boolean {
  return (tool.title ?? '').startsWith(SUBAGENT_PREFIX)
}

export type Phase = ToolActivity['phase']

/** What a group of tool calls is doing now: any running call wins, then any queued, then a failure. */
export function groupPhase(tools: readonly Pick<ToolActivity, 'phase'>[]): Phase {
  if (tools.some((tool) => tool.phase === 'running')) return 'running'
  if (tools.some((tool) => tool.phase === 'queued')) return 'queued'
  if (tools.some((tool) => tool.phase === 'error')) return 'error'
  return 'done'
}

export interface EditedFile {
  path: string
  status: 'added' | 'modified' | 'deleted'
  added: number
  removed: number
  diff?: string
  phase: Phase
  /** What the latest finished edit to this file introduced, as the checker reported it. Absent: nothing new, or unknown. */
  diagnostics?: DiagnosticsSummary
  /** The tool calls that touched this file. */
  ids: string[]
}

/** A file entry a multi-file tool call carries (apply_patch). */
interface ToolFileChange {
  path: string
  status?: EditedFile['status']
  added?: number
  removed?: number
  diff?: string
}

const PHASE_RANK: Record<Phase, number> = { done: 0, error: 1, queued: 2, running: 3 }

/** One entry per file across a run of edit calls, with their line counts added up. */
export function editedFiles(tools: readonly ToolActivity[]): EditedFile[] {
  const byPath = new Map<string, EditedFile>()
  const merge = (next: EditedFile): void => {
    const current = byPath.get(next.path)
    if (!current) {
      byPath.set(next.path, next)
      return
    }
    current.added += next.added
    current.removed += next.removed
    current.diff = current.diff ?? next.diff
    current.ids.push(...next.ids)
    if (PHASE_RANK[next.phase] > PHASE_RANK[current.phase]) current.phase = next.phase
    // An earlier edit's problems stay until a later edit has finished and reports for itself.
    if (next.phase === 'done') current.diagnostics = next.diagnostics
    // A file created and then edited is still new; removing it ends the story.
    if (next.status === 'deleted') current.status = 'deleted'
    else if (current.status === 'deleted') current.status = 'modified'
  }
  for (const tool of tools) {
    const files = (tool as unknown as { files?: ToolFileChange[] }).files
    if (files?.length) {
      for (const file of files) {
        merge({ path: file.path, status: file.status ?? 'modified', added: file.added ?? 0, removed: file.removed ?? 0, diff: file.diff, phase: tool.phase, diagnostics: diagnosticsForFile(tool.diagnostics, file.path, true), ids: [tool.id] })
      }
      continue
    }
    const path = toolTarget(tool) || tool.id
    const removal = tool.name === 'remove_file' || tool.name === 'delete_file'
    const created = tool.name === 'write_file' && !tool.removed && !!tool.added
    merge({
      path,
      status: removal ? 'deleted' : created ? 'added' : 'modified',
      added: tool.added ?? 0,
      removed: tool.removed ?? 0,
      diff: tool.diff,
      phase: tool.phase,
      diagnostics: tool.diagnostics,
      ids: [tool.id]
    })
  }
  return [...byPath.values()]
}

export interface ExploreSummary {
  /** Distinct files that were read. */
  files: string[]
  searches: number
  folders: number
}

export function exploreSummary(tools: readonly ToolActivity[]): ExploreSummary {
  const files: string[] = []
  let searches = 0
  let folders = 0
  for (const tool of tools) {
    if (tool.name === 'read_file') {
      const target = toolTarget(tool)
      if (target && !files.includes(target)) files.push(target)
    } else if (tool.name === 'list_files') folders++
    else searches++
  }
  return { files, searches, folders }
}

export type Segment =
  | { kind: 'text'; key: string; text: string; /** True for the last piece of content, the one a live answer is writing into. */ last: boolean }
  | { kind: 'reasoning'; key: string; text: string; durationMs?: number; last: boolean }
  | { kind: 'explore'; key: string; tools: ToolActivity[] }
  | { kind: 'edit'; key: string; tools: ToolActivity[]; files: EditedFile[] }
  | { kind: 'web'; key: string; tools: ToolActivity[] }
  | { kind: 'command'; key: string; tool: ToolActivity }
  | { kind: 'tool'; key: string; tool: ToolActivity }
  | { kind: 'todos'; key: string }

type ToolGroupKind = 'explore' | 'edit' | 'web'

function groupKindOf(name: string): ToolGroupKind | undefined {
  if (EXPLORE_TOOLS.has(name)) return 'explore'
  if (EDIT_TOOLS.has(name)) return 'edit'
  if (WEB_TOOLS.has(name)) return 'web'
  return undefined
}

/**
 * Fold a message's blocks into what the thread shows: prose and reasoning as they
 * came, and runs of similar tool calls (reads, edits, web lookups) as one row.
 * The model's checklist tool becomes a single marker where the plan card belongs.
 */
export function groupTranscript(blocks: readonly MessageTranscriptBlock[]): Segment[] {
  let lastContent = -1
  blocks.forEach((block, index) => {
    if (block.type !== 'tool' || block.tool.name !== 'todo_write') lastContent = index
  })
  const segments: Segment[] = []
  let todosShown = false
  let run: { kind: ToolGroupKind; tools: ToolActivity[] } | undefined

  const flush = (): void => {
    if (!run) return
    const key = `${run.kind}:${run.tools[0]!.id}`
    if (run.kind === 'explore') segments.push({ kind: 'explore', key, tools: run.tools })
    else if (run.kind === 'web') segments.push({ kind: 'web', key, tools: run.tools })
    else segments.push({ kind: 'edit', key, tools: run.tools, files: editedFiles(run.tools) })
    run = undefined
  }

  blocks.forEach((block, index) => {
    if (block.type === 'text') {
      flush()
      segments.push({ kind: 'text', key: `text:${index}`, text: block.text, last: index === lastContent })
      return
    }
    if (block.type === 'reasoning') {
      flush()
      segments.push({ kind: 'reasoning', key: `reasoning:${index}`, text: block.text, durationMs: block.durationMs, last: index === lastContent })
      return
    }
    const tool = block.tool
    if (tool.name === 'todo_write') {
      if (!todosShown) {
        flush()
        segments.push({ kind: 'todos', key: 'todos' })
        todosShown = true
      }
      return
    }
    const kind = groupKindOf(tool.name)
    if (kind) {
      if (run && run.kind !== kind) flush()
      run ??= { kind, tools: [] }
      run.tools.push(tool)
      return
    }
    flush()
    segments.push(tool.name === 'run_command' ? { kind: 'command', key: `command:${tool.id}`, tool } : { kind: 'tool', key: `tool:${tool.id}`, tool })
  })
  flush()
  return segments
}
