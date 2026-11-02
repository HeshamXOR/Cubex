import { describe, expect, it } from 'vitest'
import {
  PEER_ASKED_CHARS,
  PEER_LIMITS,
  enabledPeers,
  normalizePeerSettings,
  peerCommandLine,
  sanitizePeerActivity,
  validatePeer,
  type AcpPeer,
  type CliPeer,
  type ModelPeer
} from './peers'

const claude: CliPeer = { kind: 'cli', id: 'claude-code', name: 'Claude Code', enabled: true, preset: 'claude-code', command: 'claude' }
const custom: CliPeer = { kind: 'cli', id: 'codex', name: 'Codex', enabled: true, preset: 'custom', command: 'codex', args: ['exec', '-'], input: 'stdin' }
const model: ModelPeer = { kind: 'model', id: 'gpt', name: 'GPT', enabled: true, providerId: 'openai', model: 'gpt-5' }
const gemini: AcpPeer = { kind: 'acp', id: 'gemini', name: 'Gemini', enabled: true, preset: 'gemini', command: 'gemini', args: ['--acp'] }

describe('how each kind of agent is started', () => {

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
    [{ ...claude, kind: 'service' }, 'kind of agent'],
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

})

describe('normalizePeerSettings', () => {

  it('drops what fails the checks and any repeated id, and keeps order', () => {
    const settings = normalizePeerSettings({ list: [claude, { id: 'x' }, null, 4, { ...custom, id: claude.id }, custom, model], maxRounds: 4 })
    expect(settings.list.map((peer) => peer.id)).toEqual(['claude-code', 'codex', 'gpt'])
    expect(settings.maxRounds).toBe(4)
  })

})

describe('choosing agents for a chat', () => {
  const settings = normalizePeerSettings({ list: [claude, { ...custom, enabled: false }, model] })

  it('offers the ones that exist and are on, in the order asked', () => {
    expect(enabledPeers(settings, ['gpt', 'codex', 'missing', 'claude-code', 'gpt']).map((peer) => peer.id)).toEqual(['gpt', 'claude-code'])
    expect(enabledPeers(settings, undefined)).toEqual([])
    expect(enabledPeers(undefined, ['gpt'])).toEqual([])
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

})

describe('agents that speak ACP', () => {
  it('are accepted with only the fields they have', () => {
    expect(validatePeer({ ...gemini, input: 'argument', extra: 1 })).toEqual({ ok: true, value: gemini })
    const full = validatePeer({ ...gemini, readProject: true, passEnv: ['GEMINI_API_KEY'], authMethod: ' oauth-personal ' })
    expect(full).toEqual({ ok: true, value: { ...gemini, readProject: true, passEnv: ['GEMINI_API_KEY'], authMethod: 'oauth-personal' } })
  })

  it.each([
    [{ ...gemini, preset: 'claude-code' }, 'kind of agent'],
    [{ ...gemini, preset: undefined }, 'kind of agent'],
    [{ ...gemini, command: '  ' }, 'program'],
    [{ ...gemini, command: 'a\nb' }, 'control'],
    [{ ...gemini, args: '--acp' }, 'Arguments'],
    [{ ...gemini, args: ['a\0b'] }, 'null'],
    [{ ...gemini, readProject: 'yes' }, 'project'],
    [{ ...gemini, authMethod: 5 }, 'sign-in method'],
    [{ ...gemini, authMethod: 'x'.repeat(PEER_LIMITS.authMethod + 1) }, 'sign-in method'],
    [{ ...gemini, authMethod: 'two\nlines' }, 'sign-in method'],
    [{ ...gemini, passEnv: ['1BAD'] }, 'valid variable name']
  ])('refuse %j', (value, fragment) => {
    const checked = validatePeer(value)
    expect(checked.ok).toBe(false)
    if (!checked.ok) expect(checked.error.toLowerCase()).toContain(fragment.toLowerCase())
  })

})
