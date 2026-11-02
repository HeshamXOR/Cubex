import { describe, expect, it } from 'vitest'
import type { RestorePreview } from '../../../shared/ipc'
import { describeChoice } from './restoreCopy'

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

  it('never offers a code restore with nothing to put back, and says why', () => {
    const none = describeChoice('code', preview(0), 3)
    expect(none.disabled).toBe('No file changes to put back.')
    expect(describeChoice('both', preview(0), 3)).toEqual({ effect: 'Removes 3 messages. No file changes to put back.' })
  })

  it('keeps the conversation option usable when the file check failed, and says so on the others', () => {
    expect(describeChoice('conversation', undefined, 5, true)).toEqual({ effect: 'Removes 5 messages. Files stay as they are.' })
    for (const choice of ['both', 'code'] as const) {
      const info = describeChoice(choice, undefined, 5, true)
      expect(info.disabled).toBe('Could not check which files would change.')
      expect(info.effect).toBe(info.disabled)
    }
  })

})
