import { relative } from 'node:path'
import type { ExecutableTool, JSONValue, ToolExecutionContext, ToolResult } from '@core/types'
import { withFileMutation, replaceInSegments } from './fileObservations'
import { diffMarker, MUTATION_LIMIT_BYTES, summarizeDiff, toolFail, toolOk, type FileMutationHost } from './fileMutationHost'
import { applyEdit } from './textEdit'

const MAX_EDITS = 100

interface ParsedEdit {
  oldString: string
  newString: string
  replaceAll: boolean
}

/** Validate the whole edits array up front so a malformed call never reaches the file. */
function parseEdits(value: unknown): ParsedEdit[] | string {
  if (!Array.isArray(value)) return 'multi_edit requires an "edits" array of { old_string, new_string, replace_all? }.'
  if (value.length === 0) return 'multi_edit needs at least one edit.'
  if (value.length > MAX_EDITS) return `multi_edit accepts at most ${MAX_EDITS} edits per call; split the change into several calls.`
  const edits: ParsedEdit[] = []
  for (let index = 0; index < value.length; index++) {
    const item: unknown = value[index]
    if (item === null || typeof item !== 'object' || Array.isArray(item)) return `edits[${index}] must be an object with old_string and new_string.`
    const { old_string, new_string, replace_all = false } = item as Record<string, unknown>
    if (typeof old_string !== 'string' || !old_string) return `edits[${index}].old_string must be a non-empty string.`
    if (typeof new_string !== 'string') return `edits[${index}].new_string must be a string.`
    if (typeof replace_all !== 'boolean') return `edits[${index}].replace_all must be a boolean.`
    edits.push({ oldString: old_string, newString: new_string, replaceAll: replace_all })
  }
  return edits
}

/**
 * Several edits to one existing file, applied in order to the evolving content and
 * written once. Same ledger rules, checkpoint wiring and permission class as edit_file.
 */
export function createMultiEditTool(host: FileMutationHost): ExecutableTool {
  return {
    definition: {
      name: 'multi_edit',
      description:
        'Apply several edits to ONE existing file in a single atomic call. Edits run in order against the evolving content ' +
        '(a later edit may target text an earlier edit produced) and the file is written once; if any edit fails nothing is ' +
        'written and the error names the failing edit by index. Each edit is { old_string, new_string, replace_all? } with the ' +
        'same matching rules as edit_file: exact text, unique unless replace_all. Read the file first; a current page read permits ' +
        'edits to text shown in that page, and replace_all requires a current full read. Line endings and a UTF-8 BOM are preserved. ' +
        'Prefer this over repeated edit_file calls on one file; use apply_patch to change several files at once.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Relative file path.' },
          edits: {
            type: 'array',
            minItems: 1,
            maxItems: MAX_EDITS,
            description: 'Edits applied in order, each to the result of the previous one.',
            items: {
              type: 'object',
              properties: {
                old_string: { type: 'string', description: 'Exact text to replace (unique unless replace_all).' },
                new_string: { type: 'string', description: 'Replacement text.' },
                replace_all: { type: 'boolean', description: 'Replace every occurrence (default false).' }
              },
              required: ['old_string', 'new_string']
            }
          }
        },
        required: ['path', 'edits']
      }
    },
    defaultPermission: 'ask',
    async execute(input: JSONValue, ctx: ToolExecutionContext): Promise<ToolResult> {
      const { path, edits: rawEdits } = (input ?? {}) as { path?: unknown; edits?: unknown }
      if (typeof path !== 'string' || !path.trim()) return toolFail('multi_edit requires "path".')
      const edits = parseEdits(rawEdits)
      if (typeof edits === 'string') return toolFail(edits)
      // Don't mutate the workspace if the turn was cancelled before we got here.
      if (ctx?.signal?.aborted) return toolFail('multi_edit cancelled.')
      try {
        const abs = host.resolvePath(path)
        const key = host.observationKey(abs)
        const label = relative(host.root, abs)
        const outcome = await withFileMutation(key, ctx?.signal, async () => {
          let original: { bytes: Buffer; text?: string; version: string }
          try { original = await host.readForMutation(abs, ctx?.signal) }
          catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error(`${label} does not exist — use write_file to create it.`)
            throw error
          }
          const seen = host.requireCurrent(key, original.version, edits.some((edit) => edit.replaceAll))
          if (original.text === undefined) {
            throw new Error('The file is binary or not valid UTF-8 (e.g. Latin-1/UTF-16). multi_edit will not re-encode it, because that would corrupt every non-ASCII byte.')
          }
          let current = original.text
          let before = ''
          let after = ''
          let replacements = 0
          // Pages the model actually read, evolved by each edit so later edits may target text it just wrote.
          let segments: readonly string[] = seen.full ? [] : seen.segments
          const applied: Array<{ oldText: string; newText: string }> = []
          for (let index = 0; index < edits.length; index++) {
            const edit = edits[index]!
            const failure = (reason: string): Error => new Error(
              `edits[${index}] (edit ${index + 1} of ${edits.length}) failed and nothing was changed: ${reason}` +
              (index > 0 && /\blines? \d/.test(reason) ? ' Line numbers refer to the content after the earlier edits in this call.' : '')
            )
            const step = applyEdit(current, { oldString: edit.oldString, newString: edit.newString, replaceAll: edit.replaceAll }, label)
            if (!step.ok) throw failure(step.message)
            if (!seen.full && !segments.some((part) => part.includes(step.oldNormalized))) {
              throw failure('old_string was not included in the pages you read. Read the relevant lines before editing them.')
            }
            if (!seen.full) segments = replaceInSegments(segments, step.oldNormalized, step.newNormalized)
            if (index === 0) before = step.before
            after = step.after
            current = step.text
            replacements += step.count
            applied.push({ oldText: step.oldNormalized, newText: step.newNormalized })
          }
          if (Buffer.byteLength(current, 'utf8') > MUTATION_LIMIT_BYTES) throw new Error('Updated file exceeds the 32 MiB mutation limit.')
          await host.verifyBeforeMutation(abs, original.version, ctx?.signal)
          await host.atomicReplace(abs, current)
          host.onMutate?.(abs, original.bytes, true, Buffer.from(current, 'utf8'))
          host.observations.afterEdits(key, await host.recordWritten(abs, key, current, ctx?.signal), seen, applied)
          return { before, after, replacements }
        })
        const summary = summarizeDiff(outcome.before, outcome.after)
        const { length } = edits
        return toolOk(
          `Edited ${label} (${length} edit${length === 1 ? '' : 's'}, ${outcome.replacements} replacement${outcome.replacements === 1 ? '' : 's'}). ${diffMarker(summary)}`
        )
      } catch (error) {
        if (ctx?.signal?.aborted) return toolFail('multi_edit cancelled.')
        return toolFail(`multi_edit failed: ${(error as Error).message}`)
      }
    }
  }
}
