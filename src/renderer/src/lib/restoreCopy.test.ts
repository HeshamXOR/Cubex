import { describe, expect, it } from 'vitest'
import type { RestorePreview, RestoreResult } from '../../../shared/ipc'
import { CHOICES, CHOICE_AXES, CHOICE_LABEL, actionPhrase, choiceOf, describeChoice, describeNotice, restoredSummary, restoredTitle, undoneSummary } from './restoreCopy'

const preview = (files: number, blocked = 0, checkpoint = true): RestorePreview => ({
  checkpoint,
  files: Array.from({ length: files }, (_, index) => ({ path: `src/file${index}.ts`, action: 'revert' as const })),
  blocked: Array.from({ length: blocked }, (_, index) => ({ path: `src/edited${index}.ts`, reason: 'Changed outside Cubex since its last edit' }))
})

describe('the Restore menu lines', () => {
  it('says what each option does, with the counts', () => {
    expect(describeChoice('both', preview(3), 4).effect).toBe('Removes 4 messages, puts back 3 files.')
    expect(describeChoice('conversation', preview(3), 4).effect).toBe('Removes 4 messages. Files stay as they are.')
    expect(describeChoice('code', preview(3), 4).effect).toBe('Puts back 3 files. Messages stay.')
  })

  it('uses the singular for one', () => {
    expect(describeChoice('both', preview(1), 1).effect).toBe('Removes 1 message, puts back 1 file.')
    expect(describeChoice('code', preview(1), 2).effect).toBe('Puts back 1 file. Messages stay.')
  })

  it('mentions files the person edited that a restore would leave alone', () => {
    expect(describeChoice('both', preview(2, 1), 2).effect).toBe('Removes 2 messages, puts back 2 files, leaves 1 file you edited.')
    expect(describeChoice('code', preview(0, 2), 2).effect).toBe('Puts back 0 files, leaves 2 files you edited. Messages stay.')
  })

  it('never offers a code restore with nothing to put back, and says why', () => {
    const none = describeChoice('code', preview(0), 3)
    expect(none.disabled).toBe('No file changes to put back.')
    expect(describeChoice('both', preview(0), 3)).toEqual({ effect: 'Removes 3 messages. No file changes to put back.' })
  })

  it('explains that checkpoints end with the app instead of showing a dead option', () => {
    for (const choice of ['both', 'code'] as const) {
      const info = describeChoice(choice, preview(0, 0, false), 3)
      expect(info.disabled).toContain('only while Cubex is running')
      expect(info.effect).toBe(info.disabled)
    }
    expect(describeChoice('conversation', preview(0, 0, false), 3).disabled).toBeUndefined()
  })

  it('does not wait for the file check to offer the conversation option', () => {
    expect(describeChoice('conversation', undefined, 5)).toEqual({ effect: 'Removes 5 messages. Files stay as they are.' })
    expect(describeChoice('both', undefined, 5).effect).toContain('Checking files')
    expect(describeChoice('code', undefined, 5).effect).toContain('Checking')
  })

  it('keeps the conversation option usable when the file check failed, and says so on the others', () => {
    expect(describeChoice('conversation', undefined, 5, true)).toEqual({ effect: 'Removes 5 messages. Files stay as they are.' })
    for (const choice of ['both', 'code'] as const) {
      const info = describeChoice(choice, undefined, 5, true)
      expect(info.disabled).toBe('Could not check which files would change.')
      expect(info.effect).toBe(info.disabled)
    }
  })

  it('names all three choices and maps them to the contract axes', () => {
    expect(CHOICES.map((choice) => CHOICE_LABEL[choice])).toEqual(['Restore code and conversation', 'Restore conversation only', 'Restore code only'])
    for (const choice of CHOICES) expect(choiceOf(CHOICE_AXES[choice])).toBe(choice)
  })
})

describe('what is said afterwards', () => {
  const done = (restored: number, messages?: number): RestoreResult => ({
    restored: Array.from({ length: restored }, (_, index) => `src/f${index}.ts`), skipped: [], failed: [],
    ...(messages === undefined ? {} : { conversation: { removedMessages: messages, removedPlanIds: [], contextCleared: false } })
  })

  it('titles each restore by what it did', () => {
    expect(restoredTitle(CHOICE_AXES.both)).toBe('Restored code and conversation')
    expect(restoredTitle(CHOICE_AXES.code)).toBe('Restored code')
    expect(restoredTitle(CHOICE_AXES.conversation)).toBe('Restored conversation')
  })

  it('counts what changed and says what did not', () => {
    expect(restoredSummary(done(3, 4), CHOICE_AXES.both)).toBe('3 files put back and 4 messages removed.')
    expect(restoredSummary(done(0, 4), CHOICE_AXES.conversation)).toBe('4 messages removed. Files were not changed.')
    expect(restoredSummary(done(2), CHOICE_AXES.code)).toBe('2 files put back. The conversation was not changed.')
    expect(restoredSummary(done(0), CHOICE_AXES.code)).toBe('No files needed putting back. The conversation was not changed.')
    expect(restoredSummary(done(1, 1), CHOICE_AXES.both)).toBe('1 file put back and 1 message removed.')
  })

  it('reports an undo in the same terms', () => {
    expect(undoneSummary(3, 4)).toBe('3 files and 4 messages are back.')
    expect(undoneSummary(1, 0)).toBe('1 file is back.')
    expect(undoneSummary(0, 1)).toBe('1 message is back.')
    expect(undoneSummary(0, 0)).toBe('Nothing needed to change back.')
  })

  it('describes what a file will do', () => {
    expect(actionPhrase('revert')).toBe('put back as it was')
    expect(actionPhrase('delete')).toContain('Cubex created it')
    expect(actionPhrase('recreate')).toContain('Cubex removed it')
  })

  it('uses no spaced dash and no dot-joined list anywhere', () => {
    const lines = [
      ...CHOICES.flatMap((choice) => [describeChoice(choice, preview(2, 1), 3).effect, describeChoice(choice, undefined, 3).effect, describeChoice(choice, preview(0, 0, false), 3).effect]),
      restoredSummary(done(3, 4), CHOICE_AXES.both), undoneSummary(3, 4), actionPhrase('delete'), actionPhrase('recreate')
    ]
    for (const line of lines) expect(line).not.toMatch(/ — | · /)
  })
})

describe('the notice above the composer', () => {
  const result = (extra: Partial<RestoreResult> = {}): RestoreResult => ({ restored: ['src/a.ts', 'src/b.ts'], skipped: [], failed: [], ...extra })
  const both = { code: true, conversation: true }

  it('reports a clean restore in neutral words, and says when the message is back in the composer', () => {
    const text = describeNotice({ kind: 'restored', axes: both, result: result({ conversation: { removedMessages: 4, removedPlanIds: [], contextCleared: false } }), composerHasMessage: true })
    expect(text).toEqual({ tone: 'ok', title: 'Restored code and conversation', summary: '2 files put back and 4 messages removed. Your message is back in the composer.', lists: [] })
  })

  it('lists the files it left alone, with why, and turns amber', () => {
    const text = describeNotice({
      kind: 'restored', axes: CHOICE_AXES.code, composerHasMessage: false,
      result: result({ skipped: [{ path: 'src/c.ts', reason: 'Changed outside Cubex since its last edit' }] })
    })
    expect(text.tone).toBe('warn')
    expect(text.title).toBe('Restored code')
    expect(text.lists).toEqual([{ label: 'Left as they are because they changed outside Cubex', items: [{ path: 'src/c.ts', why: 'Changed outside Cubex since its last edit' }] }])
  })

  it('turns red when a file could not be written, and says the conversation was kept', () => {
    const text = describeNotice({
      kind: 'restored', axes: both, composerHasMessage: false,
      result: result({ restored: ['src/a.ts'], failed: [{ path: 'src/b.ts', reason: 'Another program is using it' }] })
    })
    expect(text).toMatchObject({ tone: 'error', title: 'Some files could not be put back', summary: '1 file put back. The conversation was kept so you can try again.' })
    expect(text.lists[0]).toEqual({ label: 'Could not be written', items: [{ path: 'src/b.ts', why: 'Another program is using it' }] })
    expect(describeNotice({ kind: 'restored', axes: CHOICE_AXES.code, composerHasMessage: false, result: result({ restored: [], failed: [{ path: 'x', reason: 'y' }] }) }).summary).toBe('No files were put back.')
  })

  it('reports an undo, and a failure with the sentence first and the files after it', () => {
    expect(describeNotice({ kind: 'undone', axes: both, undone: { files: 2, messages: 4 }, composerHasMessage: false }))
      .toEqual({ tone: 'ok', title: 'Restore undone', summary: '2 files and 4 messages are back.', lists: [] })
    const failed = describeNotice({ kind: 'undo-failed', axes: both, error: 'Undo stopped: these files changed after the restore. Your current files were preserved.\nsrc/a.ts\nsrc/b.ts', composerHasMessage: false })
    expect(failed).toMatchObject({ tone: 'error', title: 'Could not undo the restore', summary: 'Undo stopped: these files changed after the restore. Your current files were preserved.' })
    expect(failed.lists).toEqual([{ label: 'Files', items: [{ path: 'src/a.ts' }, { path: 'src/b.ts' }] }])
    expect(describeNotice({ kind: 'failed', axes: both, composerHasMessage: false })).toMatchObject({ title: 'Could not restore', summary: 'Nothing was changed.', lists: [] })
  })

  it('uses no spaced dash and no dot-joined list', () => {
    const texts = [
      describeNotice({ kind: 'restored', axes: both, composerHasMessage: true, result: result({ skipped: [{ path: 'a', reason: 'b' }] }) }),
      describeNotice({ kind: 'restored', axes: both, composerHasMessage: false, result: result({ failed: [{ path: 'a', reason: 'b' }] }) }),
      describeNotice({ kind: 'undone', axes: both, undone: { files: 1, messages: 1 }, composerHasMessage: false }),
      describeNotice({ kind: 'failed', axes: both, composerHasMessage: false }), describeNotice({ kind: 'undo-failed', axes: both, composerHasMessage: false })
    ]
    for (const text of texts) for (const line of [text.title, text.summary, ...text.lists.map((list) => list.label)]) expect(line).not.toMatch(/ — | · /)
  })
})
