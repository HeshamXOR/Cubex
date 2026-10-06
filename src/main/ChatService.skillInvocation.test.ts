import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_RETRY_POLICY } from '@core/types'
import type { AIProvider, AIRequest, AIStreamEvent } from '@core/types'
import type { ChatEvent, ChatStartRequest } from '@shared/ipc'
import type { ProviderManager } from './ProviderManager'

const mocks = vi.hoisted(() => ({ dataRoot: '', workspace: undefined as string | undefined }))
vi.mock('./paths', () => ({ dataDir: () => mocks.dataRoot }))
vi.mock('./db', () => ({ conversationRepo: { get: () => ({ id: 'task', messages: [], workspacePath: mocks.workspace }) } }))
vi.mock('./config', () => ({ getSettings: () => ({ general: {}, mcpServers: [], hooks: [] }) }))
vi.mock('./cost', () => ({ recordUsage: vi.fn() }))
vi.mock('./logger', () => ({ logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } }))
vi.mock('./skills', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./skills')>()
  return { ...actual, readSkill: vi.fn(actual.readSkill) }
})

import { ChatService } from './ChatService'
import { loadSkills, readSkill } from './skills'

let service: ChatService | undefined
let requests: AIRequest[]
let events: ChatEvent[]

beforeEach(() => {
  mocks.dataRoot = mkdtempSync(join(tmpdir(), 'cubex-chat-invoke-'))
  mocks.workspace = undefined
  requests = []
  events = []
  const provider = { id: 'fixture', async *streamMessage(input: AIRequest): AsyncGenerator<AIStreamEvent> {
    requests.push(structuredClone(input))
    yield { type: 'text_delta', text: 'Done.' }
    yield { type: 'stop', stopReason: 'stop' }
  } } as unknown as AIProvider
  service = new ChatService({ resolve: () => provider, getModelInfo: () => undefined } as unknown as ProviderManager,
    (event) => { events.push(event) })
})
afterEach(() => {
  service?.cancelAll()
  service?.dispose()
  service = undefined
  rmSync(mocks.dataRoot, { recursive: true, force: true })
})

function request(overrides: Partial<ChatStartRequest> = {}): ChatStartRequest {
  return {
    streamId: 'invoke-stream', conversationId: 'task', userText: 'Tighten the settings screen.', fileToolsEnabled: true,
    policy: { primary: { providerId: 'fixture', model: 'fixture' }, fallbacks: [], fallbackEnabled: false,
      retry: { ...DEFAULT_RETRY_POLICY, enabled: false }, timeout: {} },
    ...overrides
  }
}

async function finish(req: ChatStartRequest): Promise<void> {
  await service!.start(req)
  await vi.waitFor(() => expect(events.some((event) => event.kind === 'stream' && event.event.type === 'completed')).toBe(true))
}

const lastUser = () => requests[0]!.messages.at(-1)!

describe('a skill the person named', () => {
  it('goes in front of their words, as its own part of the same message', async () => {
    const frontend = loadSkills().find((skill) => skill.name === 'frontend-engineering')!
    const body = readSkill(frontend)
    await finish(request({ skill: 'frontend-engineering' }))
    expect(requests).toHaveLength(1)
    const message = lastUser()
    expect(message.role).toBe('user')
    expect(message.content).toHaveLength(2)
    const [instructions, words] = message.content
    expect(instructions).toMatchObject({ type: 'text' })
    expect(instructions!.type === 'text' && instructions!.text).toMatch(/^The user invoked the "frontend-engineering" skill\. Follow its instructions for this request\.\n\n<skill name="frontend-engineering">\n/)
    expect(instructions!.type === 'text' && instructions!.text).toContain(body)
    expect(words).toEqual({ type: 'text', text: 'Tighten the settings screen.' })
    expect(requests[0]!.messages).toHaveLength(1)
  })

  it('shows one finished Skill card before the model has said anything, and none for a turn that names no skill', async () => {
    await finish(request({ skill: 'frontend-engineering' }))
    const cards = events.filter((event) => event.kind === 'tool' && event.tool.name === 'skill')
    expect(cards).toHaveLength(1)
    expect(cards[0]).toMatchObject({ tool: { phase: 'done', title: 'Skill frontend-engineering' } })
    const detail = cards[0]!.kind === 'tool' ? cards[0]!.tool.detail : ''
    expect(detail).toContain('# Skill: frontend-engineering')
    expect(detail).toContain('Source: Cubex library')
    const first = (kind: ChatEvent['kind']) => events.findIndex((event) => event.kind === kind)
    expect(events.indexOf(cards[0]!)).toBeLessThan(first('iteration'))
    // The model did not call anything, so nothing was added to the conversation as a tool call.
    expect(JSON.stringify(requests[0]!.messages)).not.toContain('tool_use')

    requests.length = 0
    events.length = 0
    await finish(request({ streamId: 'plain-stream' }))
    expect(events.some((event) => event.kind === 'tool' && event.tool.name === 'skill')).toBe(false)
    expect(lastUser().content).toEqual([{ type: 'text', text: 'Tighten the settings screen.' }])
  })

  it('keeps the skill tool available, so the instructions can read their own reference files', async () => {
    await finish(request({ skill: 'frontend-engineering' }))
    expect(requests[0]!.tools?.some((tool) => tool.name === 'skill')).toBe(true)
  })

  it('says what to do when the person wrote only the name', async () => {
    await finish(request({ skill: 'frontend-engineering', userText: '   ' }))
    expect(lastUser().content[1]).toEqual({ type: 'text', text: 'Use the frontend-engineering skill.' })
  })

  it('is found in the task project first, whatever case the name is written in', async () => {
    mocks.workspace = join(mocks.dataRoot, 'project')
    const dir = join(mocks.workspace, '.cubex', 'skills', 'frontend-engineering')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'SKILL.md'), '---\nname: frontend-engineering\ndescription: Our own take on frontend work.\n---\nOWNED_BODY: keep the navigation.\n')
    await finish(request({ skill: 'Frontend-Engineering' }))
    const text = JSON.stringify(lastUser().content[0])
    expect(text).toContain('OWNED_BODY')
    expect(text).toContain('<skill name=\\"frontend-engineering\\">')
    expect(events.find((event) => event.kind === 'tool' && event.tool.name === 'skill')).toMatchObject({ tool: { detail: expect.stringContaining('Source: This project') } })
  })

  it('stays ahead of the request when the message carries attachments', async () => {
    const image = { type: 'image' as const, source: { kind: 'base64' as const, mediaType: 'image/png', data: 'AAAA' } }
    await finish(request({ skill: 'frontend-engineering', attachments: [image] }))
    expect(lastUser().content.map((part) => part.type)).toEqual(['text', 'text', 'image'])
    expect(lastUser().content[2]).toEqual(image)
  })

  it('offers the skills even when the turn has no tools, because the person asked for one', async () => {
    await finish(request({ skill: 'frontend-engineering', fileToolsEnabled: false }))
    expect(JSON.stringify(lastUser().content[0])).toContain('The user invoked the')
  })
})

describe('a skill that cannot be applied', () => {
  it('refuses a name no skill answers to, before the turn starts', async () => {
    await expect(service!.start(request({ skill: 'no-such-skill' }))).rejects.toThrow(
      'Could not load the "no-such-skill" skill: no skill with that name is available in this task.'
    )
    expect(requests).toHaveLength(0)
    expect(events).toHaveLength(0)
    // Nothing is left running under the stream id, so the person's next try goes through.
    await finish(request())
    expect(requests).toHaveLength(1)
  })

  it('refuses a value that is not a skill name', async () => {
    for (const skill of ['../../secrets/SKILL', 'with space', '', 'x'.repeat(65), null, 7] as unknown as string[]) {
      await expect(service!.start(request({ skill }))).rejects.toThrow(/^Could not load the "[^"]*" skill: skill names use letters/)
    }
    expect(requests).toHaveLength(0)
  })

  it('refuses instructions that cannot be read, and says why', async () => {
    vi.mocked(readSkill).mockImplementationOnce(() => { throw new Error('Skill file changed while it was being read. Try loading it again.') })
    await expect(service!.start(request({ skill: 'frontend-engineering' }))).rejects.toThrow(
      'Could not load the "frontend-engineering" skill: Skill file changed while it was being read. Try loading it again.'
    )
    expect(requests).toHaveLength(0)
    expect(events).toHaveLength(0)
  })
})
