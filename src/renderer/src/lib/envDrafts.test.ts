import { describe, expect, it } from 'vitest'
import { MCP_ENV_LIMITS } from '../../../shared/policy'
import { blankDraft, checkDrafts, planEnvChange, sameVariables, shouldBeSecret, testVariables, toggleSecret, type EnvDraft } from './envDrafts'

const plain = (name: string, value: string): EnvDraft => ({ ...blankDraft(false), name, value })
const secret = (name: string, value: string): EnvDraft => ({ ...blankDraft(true), name, value })
/** A secret that is stored and kept: nothing typed. */
const saved = (name: string): EnvDraft => ({ ...blankDraft(true), name, saved: true })

describe('checkDrafts', () => {
  it('accepts a plain variable, a secret with a value, a saved secret that is kept, and an empty plain value', () => {
    expect(checkDrafts([plain('REGION', 'eu'), secret('API_TOKEN', 'abc'), saved('DB_PASSWORD'), plain('EMPTY', '')], true).ok).toBe(true)
  })

  it('asks for a name only once the form is complete, so a row being typed is not scolded', () => {
    const row = { ...blankDraft(), value: 'x' }
    expect(checkDrafts([row], false).rows.size).toBe(0)
    expect(checkDrafts([row], true).rows.get(row.key)).toEqual({ name: 'Enter a name.' })
  })

  it.each(['my var', '1ABC', 'A-B', 'ÅNGSTRÖM', 'a.b', 'A=B', '__proto__'])('refuses the name %j and says why', (name) => {
    const row = plain(name, 'x')
    const problem = checkDrafts([row], false).rows.get(row.key)?.name
    expect(problem).toBeTruthy()
    expect(problem).not.toMatch(/^Enter a name/)
  })

  it('blocks a name used twice, on both rows, ignoring case', () => {
    const [first, second, other] = [plain('Token', '1'), secret('TOKEN', 'abc'), plain('OTHER', '2')]
    const check = checkDrafts([first, second, other], false)
    const message = 'Another variable already uses this name. Case does not count.'
    expect(check.rows.get(first.key)?.name).toBe(message)
    expect(check.rows.get(second.key)?.name).toBe(message)
    expect(check.rows.has(other.key)).toBe(false)
    expect(check.ok).toBe(false)
  })

  it('needs a value for a secret, unless a saved one is being kept', () => {
    const [typed, empty, kept, replacing, lost] = [
      secret('A_TOKEN', 'abc'),
      secret('B_TOKEN', ''),
      saved('C_TOKEN'),
      { ...saved('D_TOKEN'), replacing: true },
      { ...blankDraft(true), name: 'E_TOKEN', lost: true }
    ]
    const check = checkDrafts([typed, empty, kept, replacing, lost], true)
    expect([typed, empty, kept, replacing, lost].map((row) => check.rows.get(row.key)?.value)).toEqual([undefined, 'Enter the secret.', undefined, 'Enter the secret.', 'Enter the secret.'])
    // Not before the form is complete.
    expect(checkDrafts([empty], false).ok).toBe(true)
  })

  it('refuses a value that is too long, even before the form is complete', () => {
    const row = plain('BIG', 'x'.repeat(MCP_ENV_LIMITS.value + 1))
    expect(checkDrafts([row], false).rows.get(row.key)?.value).toBe('Use 8,192 characters or fewer.')
  })

  it('refuses a set whose names and values together are too long for a process', () => {
    const rows = Array.from({ length: 4 }, (_, index) => plain(`V${index}`, 'x'.repeat(7_000)))
    expect(checkDrafts(rows, false)).toMatchObject({ ok: false, overall: 'Variables must total 24,576 characters or fewer.' })
  })
})

describe('shouldBeSecret', () => {
  it('flags a plain variable named like a credential', () => {
    expect(shouldBeSecret(plain('GITHUB_TOKEN', 'x'))).toBe(true)
    expect(shouldBeSecret(plain('API_KEY', 'x'))).toBe(true)
    expect(shouldBeSecret(plain('DB_PASSWORD', 'x'))).toBe(true)
  })

  it('leaves other names, and anything already secret, alone', () => {
    expect(shouldBeSecret(plain('REGION', 'x'))).toBe(false)
    expect(shouldBeSecret(plain('KEYBOARD_LAYOUT', 'x'))).toBe(false)
    expect(shouldBeSecret(secret('GITHUB_TOKEN', 'x'))).toBe(false)
  })
})

describe('toggleSecret', () => {
  it('turns a plain variable into a secret and keeps what was typed', () => {
    expect(toggleSecret(plain('API_TOKEN', 'abc'))).toMatchObject({ name: 'API_TOKEN', secret: true, value: 'abc' })
  })

})

describe('planEnvChange', () => {
  const id = 'srv'

  it('splits plain variables from secrets, and points each secret at the reference its server and name produce', () => {
    const change = planEnvChange([plain('REGION', 'eu'), secret('API_TOKEN', 'abc-123')], [], id)
    expect(change.env).toEqual({ REGION: 'eu' })
    expect(change.secretEnv).toEqual({ API_TOKEN: 'mcp-env:srv:API_TOKEN' })
    expect(change.toSave).toEqual([{ name: 'API_TOKEN', value: 'abc-123' }])
    expect(change.toForget).toEqual([])
  })

  it('never puts a secret value where settings are written', () => {
    const change = planEnvChange([secret('API_TOKEN', 'abc-123-private')], [], id)
    expect(JSON.stringify({ env: change.env, secretEnv: change.secretEnv })).not.toContain('abc-123-private')
  })

  it('keeps a saved secret without saving anything, and saves a replacement', () => {
    const change = planEnvChange([saved('KEPT_TOKEN'), { ...saved('NEW_TOKEN'), replacing: true, value: 'fresh-value' }], ['KEPT_TOKEN', 'NEW_TOKEN'], id)
    expect(Object.keys(change.secretEnv ?? {})).toEqual(['KEPT_TOKEN', 'NEW_TOKEN'])
    expect(change.toSave).toEqual([{ name: 'NEW_TOKEN', value: 'fresh-value' }])
    expect(change.toForget).toEqual([])
  })

  it('saves a secret whose stored value was gone when it is entered again', () => {
    const change = planEnvChange([{ ...blankDraft(true), name: 'API_TOKEN', lost: true, value: 'entered-again' }], ['API_TOKEN'], id)
    expect(change.toSave).toEqual([{ name: 'API_TOKEN', value: 'entered-again' }])
    expect(change.toForget).toEqual([])
  })

  it('forgets a stored secret that was removed, turned into a plain variable, or renamed', () => {
    const change = planEnvChange([plain('A_TOKEN', 'now plain'), secret('NEW_NAME', 'abc-123')], ['A_TOKEN', 'B_TOKEN', 'OLD_NAME'], id)
    expect(change.toForget).toEqual(['A_TOKEN', 'B_TOKEN', 'OLD_NAME'])
    expect(change.env).toEqual({ A_TOKEN: 'now plain' })
  })

  it('does not confuse a stored name with something on the object prototype', () => {
    expect(planEnvChange([plain('toString', 'x')], ['constructor'], id).toForget).toEqual(['constructor'])
  })
})

describe('testVariables', () => {
  it('sends plain variables, secrets typed in, and the names of saved ones to be read by the server id', () => {
    expect(testVariables([plain('REGION', 'eu'), secret('NEW_TOKEN', 'typed-value'), saved('SAVED_TOKEN')])).toEqual({
      env: { REGION: 'eu' },
      secrets: { NEW_TOKEN: 'typed-value' },
      savedSecrets: ['SAVED_TOKEN']
    })
  })

  it('does not ask for a saved secret that is being replaced and has no new value yet, nor for a lost one', () => {
    expect(testVariables([{ ...saved('A_TOKEN'), replacing: true }, { ...blankDraft(true), name: 'B_TOKEN', lost: true }])).toEqual({})
  })

  it('uses the replacement rather than the saved value once one is typed', () => {
    expect(testVariables([{ ...saved('A_TOKEN'), replacing: true, value: 'new-value' }])).toEqual({ secrets: { A_TOKEN: 'new-value' } })
  })

})

describe('sameVariables', () => {

  it('sees a changed value, a changed name and an added or removed variable', () => {
    expect(sameVariables({ A: '1' }, { A: '2' })).toBe(false)
    expect(sameVariables({ A: '1' }, { B: '1' })).toBe(false)
    expect(sameVariables({ A: '1' }, { A: '1', B: '2' })).toBe(false)
    expect(sameVariables({ A: '1', B: '2' }, { A: '1' })).toBe(false)
  })

  it('does not take an inherited property for a variable', () => {
    expect(sameVariables({ toString: 'x' }, { other: 'x' })).toBe(false)
    expect(sameVariables({ A: '1' }, Object.create({ A: '1' }) as Record<string, string>)).toBe(false)
  })
})
