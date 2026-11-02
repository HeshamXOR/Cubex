import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatEvent, ChatStartRequest, Conversation } from '../../../shared/ipc'
import { DEFAULT_SETTINGS } from '../../../shared/settings'
import { parseGoalMessage, startGoal, type Goal, type GoalVerdict } from '../../../shared/goal'
import { NormalizedAIError, type ProviderConfig } from '@core/types'

const bridge = vi.hoisted(() => ({
  listeners: new Set<(event: ChatEvent) => void>(),
  api: {
    startChat: vi.fn(), cancelChat: vi.fn(), onChatEvent: vi.fn(), listPlans: vi.fn(),
    getConversation: vi.fn(), listConversations: vi.fn(), updateConversation: vi.fn(), createConversation: vi.fn(),
    listModels: vi.fn(), listProviders: vi.fn(), getSettings: vi.fn(), updateSettings: vi.fn(), compactConversation: vi.fn(),
    evaluateGoal: vi.fn(), cancelGoalCheck: vi.fn(), getGoal: vi.fn(), setGoal: vi.fn()
  }
}))
vi.mock('../lib/api', () => ({ api: bridge.api }))
import { useStore } from './store'
import { useQueue } from './queue'
import { useCommandNotice } from './commandNotice'
import { clearActiveGoal, pauseActiveGoal, resumeActiveGoal, toolCallsInLastTurn } from './goal'

const provider: ProviderConfig = { id: 'mock', kind: 'mock', name: 'Mock', accessType: 'api', auth: { type: 'none' }, enabled: true }
const conversation = (id: string): Conversation => ({ id, title: `Task ${id}`, createdAt: 1, updatedAt: 1, execution: 'cloud', workspacePath: `C:\\work\\${id}`, messages: [] })
const emit = (event: ChatEvent): void => { for (const listener of [...bridge.listeners]) listener(event) }

const completed = (streamId: string): void => emit({ streamId, kind: 'stream', event: { type: 'completed', response: {
  id: 'reply', provider: 'mock', model: 'mock-1', text: 'Done.', content: [{ type: 'text', text: 'Done.' }], toolCalls: [], stopReason: 'stop', createdAt: 2
} } })
const failed = (streamId: string): void => emit({ streamId, kind: 'stream', event: { type: 'error', error: new NormalizedAIError({
  provider: 'mock', category: 'UNKNOWN', message: 'Disconnected', classification: 'permanent', retryable: false
}) } })
const toolDone = (streamId: string, id: string): void => emit({ streamId, kind: 'tool', tool: { id, name: 'run_command', phase: 'done', title: 'Run npm test' } })

const requests = (): ChatStartRequest[] => bridge.api.startChat.mock.calls.map(([request]) => request as ChatStartRequest)
const sent = (): string[] => requests().map((request) => request.userText)
const goal = (): Goal | undefined => useStore.getState().goal
/** What is shown above the composer about a command that could not run. */
const notice = (id = 'a'): string | undefined => useCommandNotice.getState().notices[id]
const streamId = (): string => useStore.getState().streamId!
const verdict = (value: GoalVerdict): void => { bridge.api.evaluateGoal.mockResolvedValueOnce(value) }
const notMet: GoalVerdict = { kind: 'continue', reason: 'The agent ended its turn without saying the goal was met.' }

/** `/goal ...` typed in the composer. */
async function typeGoal(rest: string): Promise<void> {
  await useStore.getState().runSlashCommand(`/goal ${rest}`.trimEnd())
}

/** End the running turn the way a turn that did some work ends. */
function finishTurn(options: { tools?: number } = {}): void {
  const id = streamId()
  for (let i = 0; i < (options.tools ?? 1); i++) toolDone(id, `t-${id}-${i}`)
  completed(id)
}

beforeEach(() => {
  vi.clearAllMocks()
  bridge.listeners.clear()
  bridge.api.onChatEvent.mockImplementation((callback: (event: ChatEvent) => void) => {
    bridge.listeners.add(callback)
    return () => bridge.listeners.delete(callback)
  })
  bridge.api.startChat.mockImplementation(async (request: ChatStartRequest) => ({ streamId: request.streamId }))
  bridge.api.cancelChat.mockResolvedValue(undefined)
  bridge.api.cancelGoalCheck.mockResolvedValue(undefined)
  bridge.api.getGoal.mockResolvedValue(null)
  bridge.api.setGoal.mockResolvedValue(undefined)
  bridge.api.evaluateGoal.mockResolvedValue(notMet)
  bridge.api.listPlans.mockResolvedValue([])
  bridge.api.getConversation.mockImplementation(async (id: string) => conversation(id))
  bridge.api.listConversations.mockResolvedValue([])
  bridge.api.updateConversation.mockResolvedValue(undefined)
  bridge.api.listModels.mockResolvedValue([])
  bridge.api.listProviders.mockResolvedValue([provider])
  bridge.api.getSettings.mockResolvedValue(DEFAULT_SETTINGS)
  useQueue.setState({ queues: {} })
  useCommandNotice.setState({ notices: {} })
  useStore.setState(useStore.getInitialState(), true)
  useStore.setState({ activeConversation: conversation('a'), activeTabId: 'a', providers: [provider], activeProviderId: 'mock', activeModel: 'mock-1', settings: DEFAULT_SETTINGS })
  useStore.getState()._initChatEvents()
})

describe('/goal', () => {
  it('sets the goal and starts the first turn, telling the model about the goal and its check', async () => {
    await typeGoal('all tests pass --check npm test')
    expect(goal()).toMatchObject({ text: 'all tests pass', check: 'npm test', status: 'active', turns: 1, maxTurns: 15, turning: true })
    expect(sent()).toEqual(['Goal: all tests pass'])
    expect(requests()[0]?.goal).toEqual({ text: 'all tests pass', check: 'npm test' })
    // The first turn is an ordinary message in the thread.
    expect(useStore.getState().liveMessages.filter((message) => message.role === 'user').map((message) => message.text)).toEqual(['Goal: all tests pass'])
  })

  it('does not send what is in the composer along with the goal', async () => {
    useStore.getState().addAttachment({ type: 'image', source: { kind: 'base64', mediaType: 'image/png', data: 'AAAA' } })
    await typeGoal('it builds')
    expect(requests()[0]?.attachments).toBeUndefined()
    expect(useStore.getState().attachments).toHaveLength(1)
  })

  it('says what is wrong, with an example, when it is used wrongly', async () => {
    await typeGoal('it works --check')
    expect(notice()).toContain('Name the command after --check')
    expect(goal()).toBeUndefined()
    expect(sent()).toEqual([])
  })

  it('does not make the task look as if its last turn failed', async () => {
    await typeGoal('it works --check')
    // A failed turn holds the message queue and pauses a goal: a mistyped command is neither.
    expect(useStore.getState().status).not.toBe('error')
    expect(useStore.getState().statusDetail).toBeUndefined()
  })

  it('says there is no goal when asked for one that is not set', async () => {
    await typeGoal('')
    expect(notice()).toContain('No goal is set')
  })

  it('does not start while a turn is running', async () => {
    await useStore.getState().sendMessage('first')
    await typeGoal('all tests pass')
    expect(goal()).toBeUndefined()
    expect(notice()).toContain('A turn is running')
    expect(sent()).toEqual(['first'])
  })

  it('says to choose a model, and sets nothing, when there is none', async () => {
    useStore.setState({ activeModel: undefined })
    await typeGoal('all tests pass')
    expect(goal()).toBeUndefined()
    expect(notice()).toContain('Choose a model')
    expect(sent()).toEqual([])
  })

  it('pauses the goal, and says why, when the provider refuses the first request', async () => {
    bridge.api.startChat.mockRejectedValueOnce(new Error('The provider refused the request.'))
    await typeGoal('all tests pass')
    await vi.waitFor(() => expect(goal()?.status).toBe('paused'))
    expect(goal()?.note).toContain('The provider refused the request.')
    expect(bridge.api.evaluateGoal).not.toHaveBeenCalled()
  })
})

describe('typed in the composer', () => {
  it('leaves a wrong command in the composer to be corrected, with the reason above it', async () => {
    useStore.getState().setComposerText('/goal it works --check')
    await useStore.getState().submitComposer()
    expect(useStore.getState().composerText).toBe('/goal it works --check')
    expect(notice()).toContain('Name the command after --check')
  })

  it('clears the composer once the goal has started', async () => {
    useStore.getState().setComposerText('/goal all tests pass')
    await useStore.getState().submitComposer()
    expect(useStore.getState().composerText).toBe('')
    expect(sent()).toEqual(['Goal: all tests pass'])
    expect(notice()).toBeUndefined()
  })
})

describe('in a new session, which has no task yet', () => {
  beforeEach(() => {
    useStore.setState({ activeConversation: undefined, activeTabId: undefined })
    bridge.api.createConversation.mockResolvedValue(conversation('n'))
  })

  it('makes the task and starts the goal in it', async () => {
    await typeGoal('all tests pass --check npm test')
    expect(bridge.api.createConversation).toHaveBeenCalledTimes(1)
    expect(useStore.getState().activeConversation?.id).toBe('n')
    expect(requests()[0]).toMatchObject({ conversationId: 'n', userText: 'Goal: all tests pass', goal: { text: 'all tests pass', check: 'npm test' } })
    expect(goal()).toMatchObject({ text: 'all tests pass', status: 'active', turns: 1, turning: true })
    expect(notice('n')).toBeUndefined()
  })

  it('judges the first turn there, like in any other task', async () => {
    await typeGoal('all tests pass')
    verdict({ kind: 'met', reason: 'The check passed: npm test' })
    finishTurn()
    await vi.waitFor(() => expect(goal()?.status).toBe('complete'))
    expect(bridge.api.evaluateGoal).toHaveBeenCalledWith({ conversationId: 'n', goal: { text: 'all tests pass' } })
  })

  it('clears the composer, which was carried into the new task', async () => {
    useStore.getState().setComposerText('/goal all tests pass')
    await useStore.getState().submitComposer()
    expect(useStore.getState().activeConversation?.id).toBe('n')
    expect(useStore.getState().composerText).toBe('')
  })

  it('creates no task, and says why, when there is no model to run it', async () => {
    useStore.setState({ activeModel: undefined })
    await typeGoal('all tests pass')
    expect(bridge.api.createConversation).not.toHaveBeenCalled()
    expect(useStore.getState().activeConversation).toBeUndefined()
    expect(notice('')).toContain('Choose a model')
  })

  it('says why, and leaves the goal unset, when the task cannot be created', async () => {
    bridge.api.createConversation.mockRejectedValueOnce(new Error('The database is locked.'))
    await typeGoal('all tests pass')
    expect(goal()).toBeUndefined()
    expect(notice('')).toBe('The database is locked.')
    expect(sent()).toEqual([])
  })
})

describe('the loop', () => {
  it('judges the turn when it ends, and sends the agent back to work when the goal is not met', async () => {
    await typeGoal('all tests pass')
    finishTurn()
    await vi.waitFor(() => expect(sent()).toHaveLength(2))
    expect(bridge.api.evaluateGoal).toHaveBeenCalledWith({ conversationId: 'a', goal: { text: 'all tests pass' } })
    expect(parseGoalMessage(sent()[1]!)).toEqual({ turn: 2, of: 15, reason: 'The agent ended its turn without saying the goal was met.' })
    expect(requests()[1]?.goal).toEqual({ text: 'all tests pass' })
    expect(goal()).toMatchObject({ status: 'active', turns: 2, turning: true })
    expect(goal()).not.toHaveProperty('checking')
  })

  it('ends the goal when it is met', async () => {
    await typeGoal('all tests pass')
    verdict({ kind: 'met', reason: 'The check passed: npm test' })
    finishTurn()
    await vi.waitFor(() => expect(goal()?.status).toBe('complete'))
    expect(goal()?.note).toBe('The check passed: npm test')
    expect(sent()).toHaveLength(1)
  })

  it('passes what the agent said about the goal to the judge, once', async () => {
    await typeGoal('all tests pass')
    emit({ streamId: streamId(), kind: 'goal', claim: { status: 'complete', note: 'ran npm test: 12 passed' } })
    expect(goal()?.claim).toEqual({ status: 'complete', note: 'ran npm test: 12 passed' })
    verdict({ kind: 'continue', reason: 'Nothing in the record ran the tests.' })
    finishTurn()
    await vi.waitFor(() => expect(sent()).toHaveLength(2))
    expect(bridge.api.evaluateGoal).toHaveBeenCalledWith({ conversationId: 'a', goal: { text: 'all tests pass' }, claim: { status: 'complete', note: 'ran npm test: 12 passed' } })
    expect(goal()).not.toHaveProperty('claim')
  })

  it('shows a blocked goal, and goes on from there when the person says continue', async () => {
    await typeGoal('deploy to staging')
    verdict({ kind: 'blocked', reason: 'Needs the staging API key.' })
    finishTurn()
    await vi.waitFor(() => expect(goal()?.status).toBe('blocked'))
    expect(goal()?.note).toBe('Needs the staging API key.')
    expect(sent()).toHaveLength(1)
    await resumeActiveGoal()
    expect(goal()).toMatchObject({ status: 'active', turns: 2 })
    expect(parseGoalMessage(sent()[1]!)?.reason).toBe('You resumed the goal.')
  })

  it('pauses, and says why, when the turn could not be judged', async () => {
    await typeGoal('all tests pass')
    verdict({ kind: 'error', reason: 'The check command could not start: spawn ENOENT' })
    finishTurn()
    await vi.waitFor(() => expect(goal()?.status).toBe('paused'))
    expect(goal()?.note).toContain('could not start')
    expect(sent()).toHaveLength(1)
  })

  it('treats a judge that rejects as a turn that could not be judged', async () => {
    await typeGoal('all tests pass')
    bridge.api.evaluateGoal.mockRejectedValueOnce(new Error('IPC closed'))
    finishTurn()
    await vi.waitFor(() => expect(goal()?.status).toBe('paused'))
    expect(goal()?.note).toBe('IPC closed')
  })

  it('stops at the turn limit and says how many turns it took', async () => {
    useStore.setState({ goal: startGoal('all tests pass', undefined, 2) })
    await useStore.getState().sendMessage('Goal: all tests pass')
    finishTurn()
    await vi.waitFor(() => expect(sent()).toHaveLength(2))
    finishTurn()
    await vi.waitFor(() => expect(goal()?.status).toBe('limit'))
    expect(goal()?.note).toContain('Stopped after 2 turns')
    expect(sent()).toHaveLength(2)
  })

  it('calls the goal stalled after two turns that did no work and said nothing', async () => {
    await typeGoal('all tests pass')
    finishTurn({ tools: 0 })
    await vi.waitFor(() => expect(sent()).toHaveLength(2))
    finishTurn({ tools: 0 })
    await vi.waitFor(() => expect(goal()?.status).toBe('stalled'))
    expect(sent()).toHaveLength(2)
  })

  it('does not call a goal stalled while the agent is doing work', async () => {
    await typeGoal('all tests pass')
    for (let turn = 1; turn <= 3; turn++) {
      finishTurn({ tools: 2 })
      await vi.waitFor(() => expect(sent()).toHaveLength(turn + 1))
    }
    expect(goal()?.status).toBe('active')
    expect(goal()?.idle).toBe(0)
  })
})

describe('stopping, pausing and clearing', () => {
  it('pauses the goal when the person stops the turn, and judges nothing', async () => {
    await typeGoal('all tests pass')
    useStore.getState().cancel()
    await vi.waitFor(() => expect(goal()?.status).toBe('paused'))
    expect(goal()?.note).toBe('You stopped the turn.')
    expect(bridge.api.evaluateGoal).not.toHaveBeenCalled()
  })

  it('pauses the goal when the turn fails, and says what happened', async () => {
    await typeGoal('all tests pass')
    failed(streamId())
    await vi.waitFor(() => expect(goal()?.status).toBe('paused'))
    expect(goal()?.note).toContain('The turn failed')
    expect(bridge.api.evaluateGoal).not.toHaveBeenCalled()
  })

  it('lets the running turn finish after a pause, then starts nothing', async () => {
    await typeGoal('all tests pass')
    pauseActiveGoal()
    expect(goal()).toMatchObject({ status: 'paused', note: 'No more turns start until you resume.' })
    finishTurn()
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(bridge.api.evaluateGoal).not.toHaveBeenCalled()
    expect(sent()).toHaveLength(1)
  })

  it('resumes with a new turn, which is judged like the others', async () => {
    await typeGoal('all tests pass')
    pauseActiveGoal()
    finishTurn()
    await new Promise((resolve) => setTimeout(resolve, 30))
    await resumeActiveGoal()
    expect(sent()).toHaveLength(2)
    expect(goal()).toMatchObject({ status: 'active', turns: 2, turning: true })
    verdict({ kind: 'met', reason: 'ok' })
    finishTurn()
    await vi.waitFor(() => expect(goal()?.status).toBe('complete'))
  })

  it('resumes while the turn is still running without starting a second one', async () => {
    await typeGoal('all tests pass')
    pauseActiveGoal()
    await resumeActiveGoal()
    expect(sent()).toHaveLength(1)
    expect(goal()).toMatchObject({ status: 'active', turning: true })
  })

  it('does not tell the model about a paused goal', async () => {
    await typeGoal('all tests pass')
    pauseActiveGoal()
    finishTurn()
    await new Promise((resolve) => setTimeout(resolve, 30))
    await useStore.getState().sendMessage('something else')
    expect(requests()[1]?.goal).toBeUndefined()
    expect(goal()?.status).toBe('paused')
  })

  it('clears the goal, and stops the judging that is running', async () => {
    await typeGoal('all tests pass')
    clearActiveGoal()
    expect(goal()).toBeUndefined()
    expect(bridge.api.cancelGoalCheck).toHaveBeenCalledWith('a')
  })

  it('answers /goal pause, resume and clear the same way', async () => {
    await typeGoal('all tests pass')
    await typeGoal('pause')
    expect(goal()?.status).toBe('paused')
    finishTurn()
    await new Promise((resolve) => setTimeout(resolve, 30))
    await typeGoal('resume')
    expect(goal()?.status).toBe('active')
    await typeGoal('clear')
    expect(goal()).toBeUndefined()
  })
})

describe('while it is being judged', () => {
  /** The judge, held until the test lets it answer. */
  function holdJudge(): (value: GoalVerdict) => void {
    let release!: (value: GoalVerdict) => void
    bridge.api.evaluateGoal.mockReturnValueOnce(new Promise<GoalVerdict>((resolve) => { release = resolve }))
    return release
  }

  it('ignores an answer about a goal that was paused meanwhile', async () => {
    await typeGoal('all tests pass')
    const answer = holdJudge()
    finishTurn()
    await vi.waitFor(() => expect(goal()?.checking).toBe(true))
    pauseActiveGoal()
    expect(bridge.api.cancelGoalCheck).toHaveBeenCalledWith('a')
    answer(notMet)
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(goal()?.status).toBe('paused')
    expect(sent()).toHaveLength(1)
  })

  it('ignores an answer about a goal that was cleared meanwhile', async () => {
    await typeGoal('all tests pass')
    const answer = holdJudge()
    finishTurn()
    await vi.waitFor(() => expect(goal()?.checking).toBe(true))
    clearActiveGoal()
    answer({ kind: 'met', reason: 'late' })
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(goal()).toBeUndefined()
  })

  it('cancels the judging, and leaves the answer unused, when the person sends a message', async () => {
    await typeGoal('all tests pass')
    const answer = holdJudge()
    finishTurn()
    await vi.waitFor(() => expect(goal()?.checking).toBe(true))
    await useStore.getState().sendMessage('actually, also fix the lint errors')
    expect(bridge.api.cancelGoalCheck).toHaveBeenCalledWith('a')
    expect(sent()).toHaveLength(2)
    answer(notMet)
    await new Promise((resolve) => setTimeout(resolve, 30))
    // The person's message is a turn of the goal: judged when it ends, not by the old answer.
    expect(sent()).toHaveLength(2)
    expect(goal()).toMatchObject({ status: 'active', turning: true })
    expect(goal()).not.toHaveProperty('checking')
  })
})

describe('with messages the person queued', () => {
  it('sends the queued message first, and judges the goal after that turn', async () => {
    await typeGoal('all tests pass')
    useQueue.getState().add('a', { text: 'also keep the changelog short', attachments: [] })
    finishTurn()
    await vi.waitFor(() => expect(sent()).toEqual(['Goal: all tests pass', 'also keep the changelog short']))
    expect(bridge.api.evaluateGoal).not.toHaveBeenCalled()
    expect(requests()[1]?.goal).toEqual({ text: 'all tests pass' })
    finishTurn()
    await vi.waitFor(() => expect(bridge.api.evaluateGoal).toHaveBeenCalledTimes(1))
    await vi.waitFor(() => expect(sent()).toHaveLength(3))
  })
})

describe('when the person opens another task', () => {
  it('lets the turn finish out of sight, judges nothing meanwhile, and goes on when the task is back', async () => {
    await typeGoal('all tests pass')
    const turn = streamId()
    await useStore.getState().openConversation('b')
    expect(goal()).toBeUndefined()

    toolDone(turn, 'away-1')
    completed(turn)
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(bridge.api.evaluateGoal).not.toHaveBeenCalled()
    expect(sent()).toHaveLength(1)

    await useStore.getState().openConversation('a')
    await vi.waitFor(() => expect(sent()).toHaveLength(2))
    expect(bridge.api.evaluateGoal).toHaveBeenCalledWith({ conversationId: 'a', goal: { text: 'all tests pass' } })
    expect(parseGoalMessage(sent()[1]!)).toMatchObject({ turn: 2, of: 15 })
    expect(goal()).toMatchObject({ status: 'active', turns: 2, turning: true })
  })

  it('does not hand the goal to the other task', async () => {
    await typeGoal('all tests pass')
    await useStore.getState().openConversation('b')
    await useStore.getState().sendMessage('a question for this task')
    expect(requests().at(-1)?.goal).toBeUndefined()
    expect(goal()).toBeUndefined()
  })
})

describe('toolCallsInLastTurn', () => {
  it('counts the tool cards of the latest reply, and zero without one', async () => {
    expect(toolCallsInLastTurn({ liveMessages: [] })).toBe(0)
    await typeGoal('all tests pass')
    finishTurn({ tools: 3 })
    expect(toolCallsInLastTurn(useStore.getState())).toBe(3)
  })
})

/** A verdict the test answers by hand, as a check that takes minutes would. */
function slowVerdict(): (value: GoalVerdict) => void {
  let answer: (value: GoalVerdict) => void = () => undefined
  bridge.api.evaluateGoal.mockImplementationOnce(() => new Promise<GoalVerdict>((resolve) => { answer = resolve }))
  return (value) => answer(value)
}
const runOf = (id: string): Goal | undefined => useStore.getState().conversationRuns[id]?.goal

describe('when the person leaves a task while its turn is being judged', () => {
  it('applies the verdict to the task out of sight, so it is not left checking', async () => {
    await typeGoal('all tests pass --check npm test')
    const answer = slowVerdict()
    finishTurn()
    await vi.waitFor(() => expect(goal()?.checking).toBe(true))

    await useStore.getState().openConversation('b')
    expect(runOf('a')?.checking).toBe(true)
    answer({ kind: 'met', reason: 'npm test exited with code 0.' })
    await vi.waitFor(() => expect(runOf('a')?.status).toBe('complete'))
    expect(runOf('a')).toMatchObject({ note: 'npm test exited with code 0.' })
    expect(runOf('a')?.checking).toBeUndefined()

    await useStore.getState().openConversation('a')
    expect(goal()).toMatchObject({ status: 'complete' })
    expect(goal()?.checking).toBeUndefined()
    expect(sent()).toHaveLength(1)
  })

  it('stops a goal that is not met yet with the reason, and resumes where it was', async () => {
    await typeGoal('all tests pass --check npm test')
    const answer = slowVerdict()
    finishTurn()
    await vi.waitFor(() => expect(goal()?.checking).toBe(true))
    await useStore.getState().openConversation('b')
    answer({ kind: 'continue', reason: 'The check failed with exit code 1.' })
    await vi.waitFor(() => expect(runOf('a')?.status).toBe('paused'))
    expect(runOf('a')).toMatchObject({ turns: 1, note: 'The check failed with exit code 1. Resume the goal to continue.' })

    await useStore.getState().openConversation('a')
    await resumeActiveGoal()
    expect(goal()).toMatchObject({ status: 'active', turns: 2 })
    expect(sent()).toHaveLength(2)
  })

  it('judges the turn again when a task comes back marked as checking with nothing checking it', async () => {
    await typeGoal('all tests pass')
    const turn = streamId()
    await useStore.getState().openConversation('b')
    toolDone(turn, 'away-1')
    completed(turn)
    // What an older window left behind: a verdict that was dropped, so the flag stays.
    const run = useStore.getState().conversationRuns.a!
    useStore.setState({ conversationRuns: { ...useStore.getState().conversationRuns, a: { ...run, goal: { ...run.goal!, checking: true, turning: false } } } })
    verdict({ kind: 'met', reason: 'The agent ran the tests and they pass.' })

    await useStore.getState().openConversation('a')
    await vi.waitFor(() => expect(goal()?.status).toBe('complete'))
    expect(bridge.api.evaluateGoal).toHaveBeenCalledTimes(1)
    expect(bridge.api.cancelGoalCheck).toHaveBeenCalledWith('a')
    expect(goal()?.checking).toBeUndefined()
  })
})

describe('a goal kept with its task', () => {
  it('is saved when it starts and when it changes, without what belongs to one turn', async () => {
    await typeGoal('all tests pass --check npm test')
    await vi.waitFor(() => expect(bridge.api.setGoal).toHaveBeenCalled())
    const first = bridge.api.setGoal.mock.calls.at(-1)!
    expect(first[0]).toBe('a')
    expect(first[1]).toMatchObject({ text: 'all tests pass', check: 'npm test', status: 'active' })
    expect(first[1]).not.toHaveProperty('turning')

    pauseActiveGoal()
    await vi.waitFor(() => expect(bridge.api.setGoal.mock.calls.at(-1)![1]).toMatchObject({ status: 'paused' }))
    clearActiveGoal()
    await vi.waitFor(() => expect(bridge.api.setGoal.mock.calls.at(-1)).toEqual(['a', null]))
  })

  it('comes back paused after a restart, and runs nothing, the check command included', async () => {
    bridge.api.getGoal.mockResolvedValueOnce({ text: 'all tests pass', check: 'npm test', status: 'active', turns: 4, maxTurns: 15, idle: 0, tokens: 900, budget: 5000 })
    await useStore.getState().openConversation('c')
    expect(goal()).toMatchObject({ status: 'paused', turns: 4, check: 'npm test', note: 'Cubex restarted. Resume the goal to continue.' })
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(bridge.api.evaluateGoal).not.toHaveBeenCalled()
    expect(bridge.api.startChat).not.toHaveBeenCalled()

    await resumeActiveGoal()
    expect(goal()).toMatchObject({ status: 'active', turns: 5 })
    expect(sent()).toHaveLength(1)
  })

  it('opens a task without a goal when the saved goal cannot be read', async () => {
    bridge.api.getGoal.mockRejectedValueOnce(new Error('disk'))
    await useStore.getState().openConversation('c')
    expect(goal()).toBeUndefined()
  })
})

describe('the token budget', () => {
  const usage = (id: string, inputTokens: number, outputTokens: number): void => emit({ streamId: id, kind: 'stream', event: { type: 'usage', usage: { inputTokens, outputTokens } } })

  it('counts input and output tokens of every request of the goal, once each', async () => {
    await typeGoal('all tests pass --budget 100k')
    expect(goal()).toMatchObject({ budget: 100_000 })
    const id = streamId()
    emit({ streamId: id, kind: 'iteration', iteration: 1 })
    usage(id, 10_000, 500)
    usage(id, 10_000, 700)
    emit({ streamId: id, kind: 'iteration', iteration: 2 })
    usage(id, 12_000, 300)
    expect(goal()?.tokens).toBe(10_700 + 12_300)
    finishTurn()
    expect(goal()?.tokens).toBe(23_000)
  })

  it('stops the goal, and says so, once the turns passed the budget', async () => {
    await typeGoal('all tests pass --budget 20k')
    const id = streamId()
    emit({ streamId: id, kind: 'iteration', iteration: 1 })
    usage(id, 18_000, 4_400)
    finishTurn()
    await vi.waitFor(() => expect(goal()?.status).toBe('limit'))
    expect(goal()?.note).toBe('Used 22k of the 20k token budget.')
    expect(sent()).toHaveLength(1)
  })

  it('does not count turns of a goal that is paused', async () => {
    await typeGoal('all tests pass --budget 20k')
    const id = streamId()
    pauseActiveGoal()
    usage(id, 5_000, 100)
    expect(goal()?.tokens ?? 0).toBe(0)
  })
})
