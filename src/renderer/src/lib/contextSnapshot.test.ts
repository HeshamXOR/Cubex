import { describe, expect, it } from 'vitest'
import type { ContextUsageSnapshot } from '../../../shared/ipc'
import { snapshotIsForOtherModel } from './contextSnapshot'

const snapshot = (over: Partial<ContextUsageSnapshot> = {}): ContextUsageSnapshot => ({
  sections: [], estimatedTokens: 1000, outputReserve: 4096, contextWindow: 200_000, provider: 'anthropic', model: 'claude-a', updatedAt: 1, ...over
})

describe('snapshotIsForOtherModel', () => {
  it('is true only when the selected model is a different one with a different window', () => {
    expect(snapshotIsForOtherModel(snapshot(), { providerId: 'anthropic', model: 'claude-a' }, 200_000)).toBe(false)
    expect(snapshotIsForOtherModel(snapshot(), { providerId: 'openai', model: 'gpt-x' }, 128_000)).toBe(true)
    // The same model under a provider that has since been replaced is a different model.
    expect(snapshotIsForOtherModel(snapshot(), { providerId: 'openai', model: 'claude-a' }, 128_000)).toBe(true)
    // A dated id for a window of the same size is not worth distrusting the snapshot over.
    expect(snapshotIsForOtherModel(snapshot({ model: 'claude-a-20250101' }), { providerId: 'anthropic', model: 'claude-a' }, 200_000)).toBe(false)
  })

  it('never distrusts a snapshot that does not say which model it was for, or when nothing is selected', () => {
    expect(snapshotIsForOtherModel(snapshot({ model: undefined }), { model: 'gpt-x' }, 128_000)).toBe(false)
    expect(snapshotIsForOtherModel(snapshot(), {}, undefined)).toBe(false)
    expect(snapshotIsForOtherModel(undefined, { model: 'gpt-x' }, 128_000)).toBe(false)
  })
})
