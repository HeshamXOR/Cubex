import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./api', () => ({ api: {} }))
import { useStore } from '../state/store'
import { reviewRequest } from './reviewRequest'

beforeEach(() => {
  useStore.setState(useStore.getInitialState(), true)
})

describe('reviewRequest', () => {
  it('runs the turn with the model, effort and mode the composer shows', () => {
    useStore.setState({ activeProviderId: 'anthropic', activeModel: 'claude-sonnet', effort: 'high', maxTokens: 8192, permissionMode: 'acceptEdits', longContext: true })
    expect(reviewRequest()).toMatchObject({
      policy: { primary: { providerId: 'anthropic', model: 'claude-sonnet', params: { maxOutputTokens: 8192, reasoningEffort: 'high' } }, fallbacks: [] },
      permissionMode: 'acceptEdits',
      longContext: true
    })
  })

  it('leaves the mode to the main process while plan mode is on, because plan mode refuses the edits the comments ask for', () => {
    useStore.setState({ activeProviderId: 'anthropic', activeModel: 'claude-sonnet', permissionMode: 'plan' })
    expect(reviewRequest()).not.toHaveProperty('permissionMode')
  })

  it('asks for no thinking effort, and no reply length, when the composer has neither', () => {
    useStore.setState({ activeProviderId: 'local', activeModel: 'llama', effort: undefined })
    // No length means Automatic, which is an absent parameter, not a number: main caps the reply itself.
    expect(reviewRequest()!.policy!.primary.params).toEqual({})
  })

  it('passes the reply length the composer shows, and leaves it out while it is Automatic', () => {
    useStore.setState({ activeProviderId: 'local', activeModel: 'llama', maxTokens: 64_000 })
    expect(reviewRequest()!.policy!.primary.params).toEqual({ maxOutputTokens: 64_000 })
    useStore.setState({ maxTokens: 0 })
    expect(reviewRequest()!.policy!.primary.params).toEqual({})
  })

  it('names nothing when no model is chosen', () => {
    useStore.setState({ activeProviderId: undefined, activeModel: undefined })
    expect(reviewRequest()).toBeUndefined()
  })
})
