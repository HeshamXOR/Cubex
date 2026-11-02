import { describe, expect, it, vi } from 'vitest'
import { mcpSecretRef } from '@shared/policy'
import { childEnvironment } from '../childEnv'
import { envDigest, makeScrubber, mergeChildEnvironment, resolveMcpEnv } from './mcpEnv'

const reader = (values: Record<string, string>) => vi.fn((ref: string) => values[ref])

describe('resolveMcpEnv', () => {
  it('puts the plain variables and the resolved secrets together, and lists the secret values apart', () => {
    const read = reader({ [mcpSecretRef('srv', 'SENTRY_ACCESS_TOKEN')]: 'tok-123456', [mcpSecretRef('srv', 'DB_PASSWORD')]: 'pw-abcdef' })
    const resolved = resolveMcpEnv({
      id: 'srv',
      env: { SENTRY_ORG: 'lumen', REGION: 'eu' },
      secretEnv: { SENTRY_ACCESS_TOKEN: mcpSecretRef('srv', 'SENTRY_ACCESS_TOKEN'), DB_PASSWORD: mcpSecretRef('srv', 'DB_PASSWORD') }
    }, read)
    expect(resolved.env).toEqual({ SENTRY_ORG: 'lumen', REGION: 'eu', SENTRY_ACCESS_TOKEN: 'tok-123456', DB_PASSWORD: 'pw-abcdef' })
    expect(resolved.secretValues).toEqual(['tok-123456', 'pw-abcdef'])
    expect(resolved.missing).toEqual([])
  })

  it('reports a secret whose reference no longer resolves, by name, and leaves it out of the environment', () => {
    const read = reader({ [mcpSecretRef('srv', 'A_TOKEN')]: 'kept-value' })
    const resolved = resolveMcpEnv({
      id: 'srv',
      env: { REGION: 'eu' },
      secretEnv: { A_TOKEN: mcpSecretRef('srv', 'A_TOKEN'), B_TOKEN: mcpSecretRef('srv', 'B_TOKEN') }
    }, read)
    expect(resolved.missing).toEqual(['B_TOKEN'])
    expect(resolved.env).toEqual({ REGION: 'eu', A_TOKEN: 'kept-value' })
    expect('B_TOKEN' in resolved.env).toBe(false)
  })

  it('never reads a reference that is not the one this server and this variable produce', () => {
    // A provider key and another server's secret are both in the store.
    const read = reader({ 'provider-openai': 'sk-provider-key', [mcpSecretRef('other', 'API_KEY')]: 'other-servers-key' })
    const resolved = resolveMcpEnv({
      id: 'srv',
      secretEnv: { OPENAI_KEY: 'provider-openai', API_KEY: mcpSecretRef('other', 'API_KEY'), WRONG_NAME: mcpSecretRef('srv', 'SOMETHING_ELSE') }
    }, read)
    expect(read).not.toHaveBeenCalled()
    expect(resolved.env).toEqual({})
    expect(resolved.secretValues).toEqual([])
    expect(resolved.missing).toEqual(['OPENAI_KEY', 'API_KEY', 'WRONG_NAME'])
  })

  it('lets a secret win over a plain variable of the same name, ignoring case', () => {
    const read = reader({ [mcpSecretRef('srv', 'Token')]: 'the-secret' })
    const resolved = resolveMcpEnv({ id: 'srv', env: { TOKEN: 'plain', KEEP: 'yes' }, secretEnv: { Token: mcpSecretRef('srv', 'Token') } }, read)
    expect(resolved.env).toEqual({ KEEP: 'yes', Token: 'the-secret' })
  })
})

describe('mergeChildEnvironment', () => {
  it('adds the server variables to the filtered inherited environment, and an explicit credential gets through the filter', () => {
    const inherited = childEnvironment({ PATH: '/usr/bin', HOME: '/home/a', SENTRY_ACCESS_TOKEN: 'from my shell', ANTHROPIC_API_KEY: 'sk-ant-xyz', CUBEX_DEBUG: '1' })
    expect(inherited.SENTRY_ACCESS_TOKEN).toBeUndefined()
    const merged = mergeChildEnvironment(inherited, { SENTRY_ACCESS_TOKEN: 'saved secret', SENTRY_ORG: 'lumen' }, 'linux')
    expect(merged.SENTRY_ACCESS_TOKEN).toBe('saved secret')
    expect(merged.SENTRY_ORG).toBe('lumen')
    expect(merged.PATH).toBe('/usr/bin')
    // What the filter removed stays removed: only what the server was given on purpose comes back.
    expect(merged.ANTHROPIC_API_KEY).toBeUndefined()
    expect(merged.CUBEX_DEBUG).toBeUndefined()
  })

  it('on Windows, replaces a variable that differs only by case, so the child does not get both', () => {
    const merged = mergeChildEnvironment({ Path: 'C:\\old', HOME: 'h' }, { PATH: 'C:\\new' }, 'win32')
    expect(Object.keys(merged).sort()).toEqual(['HOME', 'PATH'])
    expect(merged.PATH).toBe('C:\\new')
  })
})

describe('makeScrubber', () => {
  const secret = 'tok-9f8e7d6c5b4a'

  it('hides a secret value wherever it appears', () => {
    const scrub = makeScrubber([secret])
    expect(scrub(`Authorization failed for ${secret}\nretrying with ${secret}`)).toBe('Authorization failed for «redacted»\nretrying with «redacted»')
  })

  it('hides the forms a program prints a value in: escaped in JSON and encoded in a URL', () => {
    const odd = 'p@ss"word/with\\chars&more'
    const scrub = makeScrubber([odd])
    expect(scrub(`json: ${JSON.stringify({ password: odd })}`)).not.toContain('with')
    expect(scrub(`url: https://x.test/?password=${encodeURIComponent(odd)}`)).toBe('url: https://x.test/?password=«redacted»')
    expect(scrub(`raw: ${odd}`)).toBe('raw: «redacted»')
  })

  it('hides the longer value whole when one secret contains another', () => {
    const scrub = makeScrubber(['abcd', 'abcdwxyz-long-secret'])
    expect(scrub('value=abcdwxyz-long-secret end')).toBe('value=«redacted» end')
  })

  describe('on text that is still growing', () => {
    it('holds back the start of a value that has only begun to arrive', () => {
      const scrub = makeScrubber([secret])
      expect(scrub.growing('token tok-9f8e7d')).toBe('token ')
      expect(scrub.growing('token tok-')).toBe('token ')
    })
  })
})

describe('envDigest', () => {
  it('is the same for the same variables in any order, and different when a value changes', () => {
    expect(envDigest({ A: '1', B: '2' })).toBe(envDigest({ B: '2', A: '1' }))
    expect(envDigest({ A: '1', B: '2' })).not.toBe(envDigest({ A: '1', B: '3' }))
    expect(envDigest(undefined)).toBe(envDigest({}))
  })

  it('does not contain a value', () => {
    expect(envDigest({ TOKEN: 'tok-9f8e7d6c5b4a' })).not.toContain('tok-9f8e')
  })
})
