import { describe, expect, it } from 'vitest'
import {
  ANTIGRAVITY_ARGUMENTS, CONSULT_TOOL, PEER_ASKED_CHARS, PEER_LIMITS, claudeCodeArguments, cleanPeerIds, clampRounds, describePeer, enabledPeers,
  newCliPeer, newModelPeer, normalizePeerSettings, peerCommandLine, peerSlug, sanitizePeerActivity, uniquePeerId, validatePeer,
  type CliPeer, type ModelPeer, type PeerConfig
} from './peers'

const claude: CliPeer = { kind: 'cli', id: 'claude-code', name: 'Claude Code', enabled: true, preset: 'claude-code', command: 'claude' }
const custom: CliPeer = { kind: 'cli', id: 'codex', name: 'Codex', enabled: true, preset: 'custom', command: 'codex', args: ['exec', '-'], input: 'stdin' }
const model: ModelPeer = { kind: 'model', id: 'gpt', name: 'GPT', enabled: true, providerId: 'openai', model: 'gpt-5' }

describe('how each kind of agent is started', () => {
  it('never gives Claude Code more than reading, and no permission bypass', () => {
    const none = claudeCodeArguments(false)
    const read = claudeCodeArguments(true)
    expect(none[none.indexOf('--tools') + 1]).toBe('')
    expect(read[read.indexOf('--tools') + 1]).toBe('Read,Grep,Glob')
    for (const args of [none, read]) {
      expect(args.join(' ')).not.toMatch(/dangerously|--bare|bypass|acceptEdits|Bash|Edit|Write/)
      expect(args).toContain('--strict-mcp-config')
      expect(args).toContain('--no-session-persistence')
      expect(args[args.indexOf('--setting-sources') + 1]).toBe('user')
      expect(args[args.indexOf('--output-format') + 1]).toBe('json')
    }
  })

  it('gives each program its own input and output', () => {
    expect(peerCommandLine(claude)).toMatchObject({ input: 'stdin', format: 'claude-json', readsProject: false })
    expect(peerCommandLine({ ...claude, readProject: true })).toMatchObject({ readsProject: true })
    const agy = peerCommandLine({ kind: 'cli', id: 'antigravity', name: 'Antigravity', enabled: true, preset: 'antigravity', command: 'agy' })
    expect(agy).toMatchObject({ input: 'argument', format: 'agy-json', args: [...ANTIGRAVITY_ARGUMENTS] })
    // The message is the value of -p, so -p is the last thing before it.
    expect(agy.args[agy.args.length - 1]).toBe('-p')
    expect(peerCommandLine(custom)).toMatchObject({ input: 'stdin', format: 'text', args: ['exec', '-'], readsProject: false })
  })

  it('does not let a custom program read the project, whatever its settings say', () => {
    expect(peerCommandLine({ ...custom, readProject: true }).readsProject).toBe(false)
  })
})

describe('validatePeer', () => {
  it('accepts each kind and keeps only the fields that kind has', () => {
    expect(validatePeer({ ...claude, args: ['x'], input: 'argument', extra: 1 })).toEqual({ ok: true, value: claude })
    expect(validatePeer({ ...claude, readProject: true })).toEqual({ ok: true, value: { ...claude, readProject: true } })
    expect(validatePeer(custom)).toEqual({ ok: true, value: custom })
    expect(validatePeer({ ...model, command: 'x' })).toEqual({ ok: true, value: model })
  })

  it('trims names and commands', () => {
    const checked = validatePeer({ ...claude, name: '  Claude  ', command: ' claude ' })
    expect(checked).toMatchObject({ ok: true, value: { name: 'Claude', command: 'claude' } })
  })

  it.each([
    [{}, 'agent'],
    [{ ...claude, id: '../x' }, 'id'],
    [{ ...claude, id: 'a'.repeat(PEER_LIMITS.id + 1) }, 'id'],
    [{ ...claude, name: '   ' }, 'name'],
    [{ ...claude, name: 'x'.repeat(PEER_LIMITS.name + 1) }, 'name'],
    [{ ...claude, name: 'two\nlines' }, 'name'],
    [{ ...claude, enabled: 'yes' }, 'on or off'],
    [{ ...claude, command: '' }, 'program'],
    [{ ...claude, command: 'a\nb' }, 'control'],
    [{ ...claude, preset: 'other' }, 'kind'],
    [{ ...claude, kind: 'service' }, 'neither'],
    [{ ...claude, readProject: 'yes' }, 'project'],
    [{ ...custom, args: ['ok', 1] }, 'Arguments'],
    [{ ...custom, args: Array.from({ length: PEER_LIMITS.args + 1 }, () => 'a') }, 'arguments or fewer'],
    [{ ...custom, args: ['a\0b'] }, 'null'],
    [{ ...custom, input: 'pipe' }, 'message'],
    [{ ...claude, passEnv: ['1BAD'] }, 'valid variable name'],
    [{ ...claude, passEnv: ['A', 'a'] }, 'twice'],
    [{ ...claude, passEnv: Array.from({ length: PEER_LIMITS.passEnv + 1 }, (_, i) => `V${i}`) }, 'variables or fewer'],
    [{ ...model, providerId: '' }, 'provider'],
    [{ ...model, model: ' ' }, 'model']
  ])('refuses %j', (value, fragment) => {
    const checked = validatePeer(value)
    expect(checked.ok).toBe(false)
    if (!checked.ok) expect(checked.error.toLowerCase()).toContain(fragment.toLowerCase())
  })

  it('keeps the names of variables to pass and drops an empty list', () => {
    expect(validatePeer({ ...claude, passEnv: ['ANTHROPIC_API_KEY'] })).toMatchObject({ ok: true, value: { passEnv: ['ANTHROPIC_API_KEY'] } })
    const empty = validatePeer({ ...claude, passEnv: [] })
    expect(empty.ok && 'passEnv' in empty.value).toBe(false)
  })
})

describe('normalizePeerSettings', () => {
  it('starts empty with the default rounds', () => {
    expect(normalizePeerSettings(undefined)).toEqual({ list: [], maxRounds: 3 })
    expect(normalizePeerSettings('nonsense')).toEqual({ list: [], maxRounds: 3 })
  })

  it('drops what fails the checks and any repeated id, and keeps order', () => {
    const settings = normalizePeerSettings({ list: [claude, { id: 'x' }, null, 4, { ...custom, id: claude.id }, custom, model], maxRounds: 4 })
    expect(settings.list.map((peer) => peer.id)).toEqual(['claude-code', 'codex', 'gpt'])
    expect(settings.maxRounds).toBe(4)
  })

  it('keeps no more than the limit', () => {
    const many = Array.from({ length: PEER_LIMITS.peers + 5 }, (_, i) => ({ ...model, id: `m${i}` }))
    expect(normalizePeerSettings({ list: many }).list).toHaveLength(PEER_LIMITS.peers)
  })

  it('keeps the rounds a reply can spend', () => {
    expect(clampRounds(0)).toBe(1)
    expect(clampRounds(99)).toBe(6)
    expect(clampRounds(2.6)).toBe(3)
    expect(clampRounds('3')).toBe(3)
    expect(clampRounds(NaN)).toBe(3)
  })
})

describe('choosing agents for a chat', () => {
  const settings = normalizePeerSettings({ list: [claude, { ...custom, enabled: false }, model] })

  it('offers the ones that exist and are on, in the order asked', () => {
    expect(enabledPeers(settings, ['gpt', 'codex', 'missing', 'claude-code', 'gpt']).map((peer) => peer.id)).toEqual(['gpt', 'claude-code'])
    expect(enabledPeers(settings, undefined)).toEqual([])
    expect(enabledPeers(undefined, ['gpt'])).toEqual([])
  })

  it('cleans a list of ids from a request', () => {
    expect(cleanPeerIds(['a', 'a', 'b/c', 5, 'd'])).toEqual(['a', 'd'])
    expect(cleanPeerIds('a')).toBeUndefined()
    expect(cleanPeerIds(Array.from({ length: 30 }, (_, i) => `p${i}`))).toHaveLength(PEER_LIMITS.peers)
  })
})

describe('naming', () => {
  it('makes a key from a name', () => {
    expect(peerSlug('Claude Code')).toBe('claude-code')
    expect(peerSlug('  GPT-5 (review)  ')).toBe('gpt-5-review')
    expect(peerSlug('日本語')).toBe('agent')
    expect(peerSlug('x'.repeat(100)).length).toBeLessThanOrEqual(PEER_LIMITS.id - 4)
  })

  it('numbers a key that is taken', () => {
    expect(uniquePeerId('claude-code', [])).toBe('claude-code')
    expect(uniquePeerId('claude-code', ['claude-code'])).toBe('claude-code-2')
    expect(uniquePeerId('claude-code', ['claude-code', 'claude-code-2'])).toBe('claude-code-3')
  })

  it('makes a program from a preset, and a second one gets a number', () => {
    const first = newCliPeer('claude-code', [])
    expect(first).toMatchObject({ id: 'claude-code', name: 'Claude Code', command: 'claude', enabled: true, preset: 'claude-code' })
    const second = newCliPeer('claude-code', [first])
    expect(second).toMatchObject({ id: 'claude-code-2', name: 'Claude Code 2' })
    expect(validatePeer(second).ok).toBe(true)
    const blank = newCliPeer('custom', [])
    expect(blank).toMatchObject({ id: 'custom', name: '', command: '', input: 'stdin' })
  })

  it('makes a model peer from a provider and model', () => {
    const peer = newModelPeer('openai', 'gpt-5', 'GPT-5', [model])
    expect(peer).toMatchObject({ kind: 'model', id: 'gpt-5', name: 'GPT-5', providerId: 'openai', model: 'gpt-5' })
    expect(validatePeer(peer).ok).toBe(true)
    expect(newModelPeer('openai', 'gpt-5', '', [peer]).id).toBe('gpt-5-2')
  })

  it('describes an agent in a line', () => {
    expect(describePeer(claude)).toBe('claude')
    expect(describePeer({ ...claude, readProject: true })).toBe('claude, can read this project')
    expect(describePeer(model, 'OpenAI')).toBe('gpt-5 on OpenAI')
    expect(describePeer(model)).toBe('gpt-5')
  })
})

describe('the card in the thread', () => {
  it('keeps only fields that check out', () => {
    expect(sanitizePeerActivity({ name: 'Claude', round: 2, of: 3, seconds: 41.6, verdict: 'agree', extra: 1 })).toEqual({ name: 'Claude', round: 2, of: 3, seconds: 42, verdict: 'agree' })
    expect(sanitizePeerActivity({ name: 'Claude', round: 1, of: 3, verdict: 'maybe', seconds: -1 })).toEqual({ name: 'Claude', round: 1, of: 3 })
  })

  it('keeps what was asked, bounded, with its line breaks and without control characters', () => {
    const card = sanitizePeerActivity({ name: 'Claude', round: 1, of: 3, asked: '  Line one\nLine two\u0007\u0000 ' + 'x'.repeat(5_000) })
    expect(card?.asked?.startsWith('Line one\nLine two')).toBe(true)
    expect(card?.asked).not.toMatch(/[\u0000-\u0008]/)
    expect(card?.asked?.length).toBeLessThanOrEqual(PEER_ASKED_CHARS)
    expect(sanitizePeerActivity({ name: 'Claude', round: 1, of: 3, asked: '   ' })).toEqual({ name: 'Claude', round: 1, of: 3 })
    expect(sanitizePeerActivity({ name: 'Claude', round: 1, of: 3, asked: 7 })).toEqual({ name: 'Claude', round: 1, of: 3 })
  })

  it('refuses what is not a card', () => {
    for (const value of [null, 'x', [], {}, { name: '', round: 1, of: 3 }, { name: 'A', round: 0, of: 3 }, { name: 'A', round: 1.5, of: 3 }, { name: 'A', round: 1, of: 'x' }]) {
      expect(sanitizePeerActivity(value)).toBeUndefined()
    }
  })

  it('names the tool', () => {
    expect(CONSULT_TOOL).toBe('consult_agent')
  })
})

describe('typing', () => {
  it('lets a list of peers be a list of either kind', () => {
    const list: PeerConfig[] = [claude, model]
    expect(list.map((peer) => peer.kind)).toEqual(['cli', 'model'])
  })
})
