import { describe, expect, it } from 'vitest'
import {
  HISTORY_ENTRY_MAX_CHARS,
  HISTORY_PER_PROJECT,
  HISTORY_PROJECTS,
  NOT_RECALLING,
  clearPrompts,
  leaveRecall,
  loadPrompts,
  mayRecallNewer,
  mayRecallOlder,
  projectKey,
  recallNewer,
  recallOlder,
  recordPrompt,
  settleRecall,
  type PromptStorage,
  type Recall
} from './promptHistory'

function memoryStorage(initial: Record<string, string> = {}): PromptStorage & { values: Map<string, string> } {
  const values = new Map(Object.entries(initial))
  return {
    values,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value) },
    removeItem: (key) => { values.delete(key) }
  }
}

describe('remembering prompts per project', () => {
  it('keeps prompts oldest first, separately for each project', () => {
    const storage = memoryStorage()
    recordPrompt(storage, 'one', 'first')
    recordPrompt(storage, 'one', 'second')
    recordPrompt(storage, 'two', 'elsewhere')
    expect(loadPrompts(storage, 'one')).toEqual(['first', 'second'])
    expect(loadPrompts(storage, 'two')).toEqual(['elsewhere'])
    expect(loadPrompts(storage, 'never used')).toEqual([])
  })

  it('trims what it stores and ignores blanks and an immediate repeat', () => {
    const storage = memoryStorage()
    recordPrompt(storage, 'p', '  run the tests  ')
    recordPrompt(storage, 'p', 'run the tests')
    recordPrompt(storage, 'p', '   ')
    recordPrompt(storage, 'p', 'something else')
    recordPrompt(storage, 'p', 'run the tests')
    expect(loadPrompts(storage, 'p')).toEqual(['run the tests', 'something else', 'run the tests'])
  })

  it('does not keep a pasted document as a prompt', () => {
    const storage = memoryStorage()
    recordPrompt(storage, 'p', 'x'.repeat(HISTORY_ENTRY_MAX_CHARS + 1))
    recordPrompt(storage, 'p', 'x'.repeat(HISTORY_ENTRY_MAX_CHARS))
    expect(loadPrompts(storage, 'p')).toHaveLength(1)
  })

  it('forgets the oldest prompts of a project past the limit', () => {
    const storage = memoryStorage()
    for (let index = 0; index < HISTORY_PER_PROJECT + 15; index++) recordPrompt(storage, 'p', `prompt ${index}`)
    const prompts = loadPrompts(storage, 'p')
    expect(prompts).toHaveLength(HISTORY_PER_PROJECT)
    expect(prompts[0]).toBe('prompt 15')
    expect(prompts.at(-1)).toBe(`prompt ${HISTORY_PER_PROJECT + 14}`)
  })

  it('forgets the least recently used projects past the limit', () => {
    const storage = memoryStorage()
    for (let index = 0; index < HISTORY_PROJECTS + 3; index++) recordPrompt(storage, `project ${index}`, `prompt ${index}`, 1000 + index)
    expect(loadPrompts(storage, 'project 0')).toEqual([])
    expect(loadPrompts(storage, 'project 2')).toEqual([])
    expect(loadPrompts(storage, 'project 3')).toEqual(['prompt 3'])
    expect(loadPrompts(storage, `project ${HISTORY_PROJECTS + 2}`)).toEqual([`prompt ${HISTORY_PROJECTS + 2}`])
  })

  it('stays inside a total size by dropping old prompts of old projects', () => {
    const storage = memoryStorage()
    const long = 'y'.repeat(HISTORY_ENTRY_MAX_CHARS - 10)
    for (let project = 0; project < 12; project++) {
      for (let index = 0; index < 30; index++) recordPrompt(storage, `project ${project}`, `${index} ${long}`, 1000 + project)
    }
    const stored = [...storage.values.values()].join('').length
    expect(stored).toBeLessThan(1_300_000)
    // The project used last keeps its prompts.
    expect(loadPrompts(storage, 'project 11').length).toBeGreaterThan(0)
  })

  it('clears one project and says how many prompts that was', () => {
    const storage = memoryStorage()
    recordPrompt(storage, 'one', 'a')
    recordPrompt(storage, 'one', 'b')
    recordPrompt(storage, 'two', 'c')
    expect(clearPrompts(storage, 'one')).toBe(2)
    expect(loadPrompts(storage, 'one')).toEqual([])
    expect(loadPrompts(storage, 'two')).toEqual(['c'])
    expect(clearPrompts(storage, 'one')).toBe(0)
    clearPrompts(storage, 'two')
    expect(storage.values.size).toBe(0)
  })

  it('survives damaged storage instead of throwing', () => {
    for (const damaged of ['not json', '[]', '{"p":{"prompts":"nope"}}', '{"p":null}', 'null']) {
      const storage = memoryStorage({ 'cubex.promptHistory.v1': damaged })
      expect(loadPrompts(storage, 'p')).toEqual([])
      recordPrompt(storage, 'p', 'fresh start')
      expect(loadPrompts(storage, 'p')).toEqual(['fresh start'])
    }
  })

  it('does not throw when storage refuses to write', () => {
    const refusing: PromptStorage = { getItem: () => null, setItem: () => { throw new Error('quota') }, removeItem: () => undefined }
    expect(() => recordPrompt(refusing, 'p', 'text')).not.toThrow()
  })

  it('files a project under one key however its path is spelled', () => {
    expect(projectKey('C:\\Users\\Me\\Code\\App\\')).toBe(projectKey('c:/users/me/code/app'))
    expect(projectKey('/home/me/App')).toBe('/home/me/App')
    expect(projectKey('/home/me/App/')).toBe('/home/me/App')
    expect(projectKey(undefined)).toBe('')
    expect(projectKey('  ')).toBe('')
  })
})

describe('walking back through prompts', () => {
  const prompts = ['oldest', 'middle', 'newest']

  it('goes back one prompt at a time and remembers the draft', () => {
    let step = recallOlder(prompts, NOT_RECALLING, 'half typed')!
    expect(step.text).toBe('newest')
    expect(step.recall).toEqual({ index: 0, draft: 'half typed', shown: 'newest' })
    step = recallOlder(prompts, step.recall, step.text)!
    expect(step.text).toBe('middle')
    expect(step.recall.draft).toBe('half typed')
    step = recallOlder(prompts, step.recall, step.text)!
    expect(step.text).toBe('oldest')
    expect(recallOlder(prompts, step.recall, step.text)).toBeUndefined()
  })

  it('does nothing without any prompts', () => {
    expect(recallOlder([], NOT_RECALLING, '')).toBeUndefined()
    expect(recallNewer([], NOT_RECALLING, '')).toBeUndefined()
  })

  it('comes forward again and ends on the draft', () => {
    let recall: Recall = recallOlder(prompts, NOT_RECALLING, 'draft')!.recall
    let text = 'newest'
    ;({ recall, text } = recallOlder(prompts, recall, text)!)
    expect(text).toBe('middle')
    ;({ recall, text } = recallNewer(prompts, recall, text)!)
    expect(text).toBe('newest')
    const back = recallNewer(prompts, recall, text)!
    expect(back.text).toBe('draft')
    expect(back.recall.index).toBeNull()
    expect(recallNewer(prompts, back.recall, back.text)).toBeUndefined()
  })

  it('returns to the draft with Esc from anywhere in the walk, and ignores Esc otherwise', () => {
    const deep = recallOlder(prompts, recallOlder(prompts, NOT_RECALLING, 'my draft')!.recall, 'newest')!
    const out = leaveRecall(deep.recall)!
    expect(out.text).toBe('my draft')
    expect(out.recall.index).toBeNull()
    expect(leaveRecall(NOT_RECALLING)).toBeUndefined()
  })

  it('brings back an empty draft too, so the composer is empty again', () => {
    const step = recallOlder(prompts, NOT_RECALLING, '')!
    expect(leaveRecall(step.recall)!.text).toBe('')
  })

  it('skips a prompt identical to what is already on screen', () => {
    const repeated = ['alpha', 'beta', 'alpha']
    // The draft equals the newest prompt: Up goes straight to the one before it.
    expect(recallOlder(repeated, NOT_RECALLING, 'alpha')!.text).toBe('beta')
  })

  it('keeps walking while the text is the prompt it put there, and stops the moment the person types', () => {
    const shown = recallOlder(prompts, NOT_RECALLING, 'draft')!
    expect(settleRecall(shown.recall, 'newest')).toBe(shown.recall)
    expect(settleRecall(shown.recall, 'newest, but')).toBe(NOT_RECALLING)
    expect(settleRecall(NOT_RECALLING, 'anything')).toBe(NOT_RECALLING)
  })
})

describe('when the arrow keys belong to history', () => {
  it('claims Up in an empty composer and at the very start of a draft, not in the middle of one', () => {
    expect(mayRecallOlder('', 0, 0, false)).toBe(true)
    expect(mayRecallOlder('a draft', 0, 0, false)).toBe(true)
    expect(mayRecallOlder('a draft', 3, 3, false)).toBe(false)
    expect(mayRecallOlder('a draft', 0, 4, false)).toBe(false)
  })

  it('while walking, claims Up on the first line only so a long prompt can still be read', () => {
    expect(mayRecallOlder('line one\nline two', 4, 4, true)).toBe(true)
    expect(mayRecallOlder('line one\nline two', 12, 12, true)).toBe(false)
  })

  it('claims Down only while walking, and only on the last line', () => {
    expect(mayRecallNewer('text', 4, 4, false)).toBe(false)
    expect(mayRecallNewer('line one\nline two', 12, 12, true)).toBe(true)
    expect(mayRecallNewer('line one\nline two', 2, 2, true)).toBe(false)
    expect(mayRecallNewer('text', 1, 3, true)).toBe(false)
  })
})
