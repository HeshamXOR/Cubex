import { describe, expect, it } from 'vitest'
import type { ToolActivity } from './ipc'
import {
  hydrateMessageTranscript, MESSAGE_TRANSCRIPT_MAX_BLOCKS, MESSAGE_TRANSCRIPT_MAX_BYTES,
  messageDisplayBlocks, normalizeMessageTranscriptJson, serializeMessageTranscript, type MessageTranscriptBlock
} from './messageTranscript'

const edit: ToolActivity = {
  id: 'edit-one', name: 'edit_file', phase: 'done', title: 'Edit src/parser.ts',
  detail: 'Updated the parser', diff: '-old\n+new', added: 1, removed: 1
}

describe('durable display transcripts', () => {
  it('restores reasoning, measured duration, tool details and diff without changing the canonical answer', () => {
    const input = { text: 'Verified the parser.', reasoning: 'Check the current behavior.', reasoningMs: 1200, toolCalls: [edit] }
    const stored = serializeMessageTranscript(input)
    const result = hydrateMessageTranscript({ uiTranscriptJson: stored }, 'task')
    expect(result.reasoning).toBe(input.reasoning)
    expect(result.reasoningMs).toBe(1200)
    expect(result.toolCalls).toEqual([edit])
    expect(result.blocks?.map((block) => block.type)).toEqual(['reasoning', 'tool', 'text'])
    expect(result.blocks?.at(-1)).toEqual({ type: 'text', text: input.text })
    expect(input.toolCalls[0]?.phase).toBe('done')
  })

  it('keeps explicit block order and only sums fully measured reasoning durations', () => {
    const blocks: MessageTranscriptBlock[] = [
      { type: 'text', text: 'I will inspect the parser.' },
      { type: 'tool', tool: edit },
      { type: 'reasoning', text: 'Check the result.', durationMs: 100 },
      { type: 'text', text: 'Finished.' }
    ]
    const result = hydrateMessageTranscript({ uiTranscriptJson: serializeMessageTranscript({ blocks }) })
    expect(result.blocks).toEqual(blocks)
    expect(result.reasoningMs).toBe(100)
    expect(hydrateMessageTranscript({ uiTranscriptJson: serializeMessageTranscript({ blocks: [...blocks, { type: 'reasoning', text: 'No measured duration' }] }) }).reasoningMs).toBeUndefined()
  })

  it('marks historical running work interrupted without claiming success or mutating its live snapshot', () => {
    const running: ToolActivity = { id: 'command', name: 'run_command', phase: 'running', title: 'Run tests', detail: 'Waiting for output' }
    const stored = serializeMessageTranscript({ toolCalls: [running] })!
    expect(JSON.parse(stored).blocks[0].tool.phase).toBe('running')
    const result = hydrateMessageTranscript({ uiTranscriptJson: stored })
    expect(result.toolCalls?.[0]).toMatchObject({ phase: 'error', interrupted: true })
    expect(result.toolCalls?.[0]?.detail).toContain('completion was not recorded')
    expect(running.phase).toBe('running')
  })

  it('rebinds output ownership to the current task and never trusts an imported owner', () => {
    const stored = serializeMessageTranscript({ toolCalls: [{ ...edit, outputId: 'log-one', outputConversationId: 'original-task' }] })
    expect(hydrateMessageTranscript({ uiTranscriptJson: stored }, 'imported-task').toolCalls?.[0]).toMatchObject({ outputId: 'log-one', outputConversationId: 'imported-task' })
    expect(hydrateMessageTranscript({ uiTranscriptJson: stored }).toolCalls?.[0]?.outputConversationId).toBeUndefined()
    expect(hydrateMessageTranscript({ uiTranscriptJson: stored }, '../not-an-id').toolCalls?.[0]?.outputConversationId).toBeUndefined()
  })

  it('reads legacy activity and uncertain native calls without inventing completion or keeping tool inputs', () => {
    const result = hydrateMessageTranscript({ toolCallsJson: JSON.stringify([
      edit, { id: 'old-call', name: 'read_file', input: { secret: 'MUST_NOT_PERSIST' } }, null, { input: 'no id' }
    ]) })
    expect(result.toolCalls).toHaveLength(2)
    expect(result.toolCalls?.[0]?.phase).toBe('done')
    expect(result.toolCalls?.[1]).toMatchObject({ phase: 'error', interrupted: true })
    expect(JSON.stringify(result)).not.toContain('MUST_NOT_PERSIST')
  })

  it.each([undefined, '', '{', 'null', '[]', '{"version":2,"blocks":[]}', '{"version":1,"blocks":{}}'])('ignores malformed or unsupported envelopes %s', (raw) => {
    expect(hydrateMessageTranscript({ uiTranscriptJson: raw })).toEqual({})
    expect(normalizeMessageTranscriptJson(raw)).toBeUndefined()
  })

  it('falls back to legacy activity when a newer display envelope is malformed', () => {
    expect(hydrateMessageTranscript({ uiTranscriptJson: '{bad', toolCallsJson: JSON.stringify([edit]) }).toolCalls).toEqual([edit])
  })

  it('whitelists fields and rejects invalid counts, owners, phases and blocks', () => {
    const stored = normalizeMessageTranscriptJson(JSON.stringify({ version: 1, rawProviderBody: 'MUST_NOT_PERSIST', blocks: [
      { type: 'tool', tool: { ...edit, input: 'MUST_NOT_PERSIST', content: 'MUST_NOT_PERSIST', added: -1, removed: '20', outputId: '../log', outputConversationId: 'old' } },
      { type: 'tool_result', content: 'MUST_NOT_PERSIST' },
      { type: 'tool', tool: { id: 'bad', name: 'read_file', phase: 'approved' } },
      { type: 'reasoning', text: 'Thought', durationMs: -20 }
    ] }))!
    const result = hydrateMessageTranscript({ uiTranscriptJson: stored })
    expect(stored).not.toContain('MUST_NOT_PERSIST')
    expect(result.blocks).toHaveLength(2)
    expect(result.toolCalls?.[0]?.added).toBeUndefined()
    expect(result.toolCalls?.[0]?.removed).toBeUndefined()
    expect(result.toolCalls?.[0]?.outputId).toBeUndefined()
    expect(result.reasoningMs).toBeUndefined()
  })

  it('bounds individual fields and the overall Unicode payload and exposes truncation', () => {
    const answer = 'Complete canonical answer'
    const stored = serializeMessageTranscript({ text: answer, toolCalls: Array.from({ length: 128 }, (_, index) => ({ ...edit, id: `edit-${index}`, diff: '源'.repeat(100_000) })) })!
    expect(new TextEncoder().encode(stored).byteLength).toBeLessThanOrEqual(MESSAGE_TRANSCRIPT_MAX_BYTES)
    const result = hydrateMessageTranscript({ uiTranscriptJson: stored })
    expect(result.transcriptTruncated).toBe(true)
    expect(result.toolCalls?.[0]?.diff).toContain('truncated in saved history')
    expect(answer).toBe('Complete canonical answer')
  })

  it('limits block counts and refuses oversized serialized metadata before JSON parsing', () => {
    const stored = serializeMessageTranscript({ toolCalls: Array.from({ length: 300 }, (_, index) => ({ ...edit, id: `tool-${index}` })) })!
    expect(hydrateMessageTranscript({ uiTranscriptJson: stored }).blocks).toHaveLength(MESSAGE_TRANSCRIPT_MAX_BLOCKS)
    expect(hydrateMessageTranscript({ uiTranscriptJson: stored }).transcriptTruncated).toBe(true)
    expect(hydrateMessageTranscript({ uiTranscriptJson: ' '.repeat(MESSAGE_TRANSCRIPT_MAX_BYTES + 1) })).toEqual({})
  })

  it('does not duplicate ordinary text-only messages into the display metadata column', () => {
    expect(serializeMessageTranscript({ text: 'Plain answer' })).toBeUndefined()
    expect(serializeMessageTranscript({ blocks: [{ type: 'text', text: 'Plain answer' }] })).toBeUndefined()
  })

  it('uses ordered blocks once and appends canonical text only for legacy tool-only metadata', () => {
    const blocks: MessageTranscriptBlock[] = [{ type: 'text', text: 'Before' }, { type: 'tool', tool: edit }, { type: 'text', text: 'After' }]
    expect(messageDisplayBlocks({ blocks, text: 'Before\n\nAfter', toolCalls: [edit] })).toEqual(blocks)
    expect(messageDisplayBlocks({ blocks: [{ type: 'tool', tool: edit }], text: 'Legacy answer' })).toEqual([
      { type: 'tool', tool: edit }, { type: 'text', text: 'Legacy answer' }
    ])
  })

  it('restores complete long text in its original position using canonical offsets', () => {
    const first = 'Long text: ' + 'source '.repeat(14000)
    const last = 'Verified afterwards.'
    const text = `${first}\n\n${last}`
    const blocks: MessageTranscriptBlock[] = [{ type: 'text', text: first }, { type: 'tool', tool: edit }, { type: 'text', text: last }]
    const uiTranscriptJson = serializeMessageTranscript({ text, blocks })!
    expect(uiTranscriptJson.length).toBeLessThan(text.length)
    const restored = hydrateMessageTranscript({ uiTranscriptJson, text })
    expect(restored.blocks).toEqual(blocks)
    expect(messageDisplayBlocks({ ...restored, text }).filter((block) => block.type === 'text').map((block) => block.text)).toEqual([first, last])
  })

  it('retains text beyond the metadata block limit without repeating the saved prefix', () => {
    const first = 'Inspect the files.'
    const last = 'Everything is verified.'
    const text = `${first}\n\n${last}`
    const blocks: MessageTranscriptBlock[] = [
      { type: 'text', text: first },
      ...Array.from({ length: 150 }, (_, index): MessageTranscriptBlock => ({ type: 'tool', tool: { ...edit, id: `edit-${index}` } })),
      { type: 'text', text: last }
    ]
    const restored = hydrateMessageTranscript({ text, uiTranscriptJson: serializeMessageTranscript({ text, blocks }) })
    expect(restored.transcriptTruncated).toBe(true)
    expect(restored.blocks?.filter((block) => block.type === 'text')).toEqual([{ type: 'text', text: first }, { type: 'text', text: last }])
  })

  it('does not trust imported text offsets that point to different text or overlap', () => {
    const uiTranscriptJson = JSON.stringify({ version: 1, blocks: [
      { type: 'text', text: 'Displayed safely', textStart: 0, textEnd: 7 }, { type: 'tool', tool: edit }
    ] })
    expect(hydrateMessageTranscript({ uiTranscriptJson, text: 'Changed content' }).blocks?.[0]).toEqual({ type: 'text', text: 'Displayed safely' })
  })
})

describe('per-file tool activity', () => {
  const patch: ToolActivity = {
    id: 'patch-one', name: 'apply_patch', phase: 'done', title: 'Apply patch', detail: 'Applied patch: 3 files changed (+3 -2).', added: 3, removed: 2,
    files: [
      { path: 'src/new.ts', status: 'added', added: 2, removed: 0, diff: '+one\n+two' },
      { path: 'src/app.ts', status: 'modified', added: 1, removed: 1, diff: ' keep\n-old\n+new' },
      { path: 'old.txt', status: 'deleted', added: 0, removed: 1 }
    ]
  }

  it('round-trips files with their statuses, counts and diffs, and leaves single-file tools without the field', () => {
    const stored = serializeMessageTranscript({ toolCalls: [patch, edit] })
    const result = hydrateMessageTranscript({ uiTranscriptJson: stored })
    expect(result.toolCalls?.[0]).toEqual(patch)
    expect(result.toolCalls?.[1]).toEqual(edit)
    expect(result.toolCalls?.[1]).not.toHaveProperty('files')
    expect(result.transcriptTruncated).toBeUndefined()
  })

  it('whitelists file fields and drops invalid entries, bad statuses, bad counts and non-arrays', () => {
    const stored = normalizeMessageTranscriptJson(JSON.stringify({ version: 1, blocks: [
      { type: 'tool', tool: { ...patch, files: [
        { path: 'ok.ts', status: 'modified', added: 1, removed: 2, diff: '+a', content: 'MUST_NOT_PERSIST', input: 'MUST_NOT_PERSIST' },
        { path: 'bad-status.ts', status: 'renamed', added: 1, removed: 1 },
        { path: '', status: 'added', added: 1, removed: 1 },
        { path: 'negative.ts', status: 'added', added: -1, removed: 0 },
        { path: 'text-count.ts', status: 'added', added: '1', removed: 0 },
        { status: 'added', added: 1, removed: 0 },
        null, 'nope', []
      ] } },
      { type: 'tool', tool: { ...edit, id: 'not-an-array', files: { path: 'x', status: 'added', added: 1, removed: 0 } } }
    ] }))!
    expect(stored).not.toContain('MUST_NOT_PERSIST')
    const result = hydrateMessageTranscript({ uiTranscriptJson: stored })
    expect(result.toolCalls?.[0]?.files).toEqual([{ path: 'ok.ts', status: 'modified', added: 1, removed: 2, diff: '+a' }])
    expect(result.toolCalls?.[1]).not.toHaveProperty('files')
  })

  it('omits an empty file list rather than persisting it', () => {
    const stored = serializeMessageTranscript({ toolCalls: [{ ...patch, files: [] }] })!
    expect(JSON.parse(stored).blocks[0].tool).not.toHaveProperty('files')
  })

  it('caps the number of files at 50 and exposes the truncation', () => {
    const files = Array.from({ length: 80 }, (_, index) => ({ path: `f${index}.ts`, status: 'added' as const, added: 1, removed: 0 }))
    const result = hydrateMessageTranscript({ uiTranscriptJson: serializeMessageTranscript({ toolCalls: [{ ...patch, files }] }) })
    expect(result.toolCalls?.[0]?.files).toHaveLength(50)
    expect(result.toolCalls?.[0]?.files?.[49]?.path).toBe('f49.ts')
    expect(result.transcriptTruncated).toBe(true)
  })

  it('clips each diff and bounds the total so the tool block is never dropped', () => {
    const files = Array.from({ length: 50 }, (_, index) => ({ path: `big${index}.ts`, status: 'modified' as const, added: 9, removed: 9, diff: '源'.repeat(100_000) }))
    const stored = serializeMessageTranscript({ text: 'Done.', toolCalls: [{ ...patch, files }] })!
    expect(new TextEncoder().encode(stored).byteLength).toBeLessThanOrEqual(MESSAGE_TRANSCRIPT_MAX_BYTES)
    const result = hydrateMessageTranscript({ uiTranscriptJson: stored })
    const kept = result.toolCalls?.[0]?.files
    expect(kept).toHaveLength(50)
    expect(kept?.[0]?.diff).toContain('truncated in saved history')
    // Counts survive even when a late file's diff no longer fits the total budget.
    expect(kept?.[49]).toMatchObject({ path: 'big49.ts', status: 'modified', added: 9, removed: 9 })
    expect(kept?.some((file) => file.diff === undefined)).toBe(true)
    expect(result.transcriptTruncated).toBe(true)
  })

  it('reads files from legacy activity metadata too', () => {
    const result = hydrateMessageTranscript({ toolCallsJson: JSON.stringify([patch]) })
    expect(result.toolCalls?.[0]?.files).toEqual(patch.files)
  })

  it('keeps already persisted file lists stable when normalized again', () => {
    const once = normalizeMessageTranscriptJson(serializeMessageTranscript({ toolCalls: [patch] }))
    expect(normalizeMessageTranscriptJson(once)).toBe(once)
  })
})

describe('post-edit diagnostics in saved history', () => {
  const problem = { path: 'src/a.ts', line: 3, col: 7, code: 'TS2322', message: "Type 'string' is not assignable to type 'number'." }
  const withProblems: ToolActivity = { ...edit, diagnostics: { errors: 2, warnings: 0, items: [problem] } }

  it('restores the chip and its problems after a reload', () => {
    const result = hydrateMessageTranscript({ uiTranscriptJson: serializeMessageTranscript({ toolCalls: [withProblems] }) })
    expect(result.toolCalls?.[0]?.diagnostics).toEqual(withProblems.diagnostics)
  })

  it('never stores a summary that is malformed, empty or oversized', () => {
    const damaged = { ...edit, diagnostics: { errors: 'many', warnings: 0 } } as unknown as ToolActivity
    const empty = { ...edit, diagnostics: { errors: 0, warnings: 0 } }
    const long = { ...edit, diagnostics: { errors: 40, warnings: 0, items: Array.from({ length: 40 }, (_, line) => ({ ...problem, line: line + 1, message: 'x'.repeat(2_000) })) } }
    expect(hydrateMessageTranscript({ uiTranscriptJson: serializeMessageTranscript({ toolCalls: [damaged] }) }).toolCalls?.[0]).not.toHaveProperty('diagnostics')
    expect(hydrateMessageTranscript({ uiTranscriptJson: serializeMessageTranscript({ toolCalls: [empty] }) }).toolCalls?.[0]).not.toHaveProperty('diagnostics')
    const kept = hydrateMessageTranscript({ uiTranscriptJson: serializeMessageTranscript({ toolCalls: [long] }) }).toolCalls?.[0]?.diagnostics
    expect(kept?.items).toHaveLength(15)
    expect(kept?.items?.every((item) => item.message.length <= 300)).toBe(true)
  })
})
