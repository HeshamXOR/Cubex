import { describe, expect, it } from 'vitest'
import {
  HOOK_EVENTS, HOOK_EVENT_INFO, MCP_ENV_LIMITS, duplicateEnvNames, envNameProblem, hookMatches, looksLikeSecretName,
  matcherProblem, matcherTerms, mcpSecretRef, validateHookTestRequest,
  validateMcpSecretForget, validateMcpSecretSave, validateMcpTestRequest
} from './policy'

describe('validateMcpTestRequest', () => {
  const ok = { name: 'Files', command: 'npx', args: ['-y', 'server'] }

  it('accepts a server as saved and trims the text fields', () => {
    expect(validateMcpTestRequest({ ...ok, name: '  Files ', command: ' npx ' })).toEqual({ ok: true, value: ok })
    expect(validateMcpTestRequest({ ...ok, id: 'ab12-CD_34' })).toEqual({ ok: true, value: { ...ok, id: 'ab12-CD_34' } })
    expect(validateMcpTestRequest({ name: 'x', command: 'node' })).toEqual({ ok: true, value: { name: 'x', command: 'node', args: [] } })
  })

  it('drops everything it does not know, so no working folder or other setting can ride along', () => {
    const result = validateMcpTestRequest({ ...ok, env: { REGION: 'eu' }, cwd: 'C:\\', enabled: true, secretEnv: { TOKEN: 'ref' } })
    expect(result).toEqual({ ok: true, value: { ...ok, env: { REGION: 'eu' } } })
  })

  it.each([
    [undefined, 'Expected an MCP server configuration.'],
    [null, 'Expected an MCP server configuration.'],
    ['npx', 'Expected an MCP server configuration.'],
    [[], 'Expected an MCP server configuration.'],
    [{ command: 'npx' }, 'Enter a name for the server.'],
    [{ name: '   ', command: 'npx' }, 'Enter a name for the server.'],
    [{ name: 'x' }, 'Enter the command that starts the server.'],
    [{ name: 'x', command: '  ' }, 'Enter the command that starts the server.'],
    [{ name: 'x', command: 5 }, 'Enter the command that starts the server.'],
    [{ name: 'x', command: 'a\nb' }, 'The command contains a control character or line break.'],
    [{ name: 'x', command: 'a\u0000b' }, 'The command contains a control character or line break.'],
    [{ name: 'x'.repeat(81), command: 'npx' }, 'The name must be 80 characters or fewer.'],
    [{ name: 'x', command: 'c'.repeat(1_025) }, 'The command must be 1024 characters or fewer.'],
    [{ name: 'x', command: 'npx', id: 'has space' }, 'The server id is not valid.'],
    [{ name: 'x', command: 'npx', id: 7 }, 'The server id is not valid.'],
    [{ name: 'x', command: 'npx', id: 'i'.repeat(129) }, 'The server id is not valid.'],
    [{ name: 'x', command: 'npx', args: 'not a list' }, 'Arguments must be a list of strings.'],
    [{ name: 'x', command: 'npx', args: ['ok', 3] }, 'Arguments must be a list of strings.']
  ])('rejects %j', (value, error) => {
    expect(validateMcpTestRequest(value)).toEqual({ ok: false, error })
  })
})

describe('arguments in a connection test request', () => {
  const server = { name: 'x', command: 'npx' }
  const withArguments = (args: unknown): ReturnType<typeof validateMcpTestRequest> => validateMcpTestRequest({ ...server, args })

  it('treats no arguments as an empty list', () => {
    expect(validateMcpTestRequest(server)).toEqual({ ok: true, value: { ...server, args: [] } })
    expect(withArguments([])).toEqual({ ok: true, value: { ...server, args: [] } })
  })

  it('bounds the count, each argument and the total', () => {
    expect(withArguments(Array.from({ length: 64 }, () => 'a')).ok).toBe(true)
    expect(withArguments(Array.from({ length: 65 }, () => 'a'))).toEqual({ ok: false, error: 'Use 64 arguments or fewer.' })
    expect(withArguments(['a'.repeat(8_193)])).toEqual({ ok: false, error: 'Argument 1 must be 8,192 characters or fewer.' })
    expect(withArguments(Array.from({ length: 5 }, () => 'a'.repeat(7_000)))).toEqual({ ok: false, error: 'Arguments must total 32,768 characters or fewer.' })
  })

  it('refuses a null character, which cannot be passed to a process', () => {
    expect(withArguments(['ok', 'bad\0'])).toEqual({ ok: false, error: 'Argument 2 contains a null character, which cannot be passed to a process.' })
  })
})

describe('hook matchers', () => {
  it('splits alternatives on | and drops blanks', () => {
    expect(matcherTerms('write_file|edit_file')).toEqual(['write_file', 'edit_file'])
    expect(matcherTerms(' a | | b ')).toEqual(['a', 'b'])
    expect(matcherTerms('|')).toEqual([])
    expect(matcherTerms(undefined)).toEqual([])
  })

  it('matches a tool whose name contains any term, ignoring case', () => {
    expect(hookMatches('write', 'write_file')).toBe(true)
    expect(hookMatches('WRITE', 'write_file')).toBe(true)
    expect(hookMatches('edit|write', 'write_file')).toBe(true)
    expect(hookMatches('edit', 'write_file')).toBe(false)
    expect(hookMatches('mcp__github', 'mcp__github__create_issue')).toBe(true)
  })

  it('matches everything when there is no usable term', () => {
    for (const matcher of [undefined, '', '   ', '|', ' | ']) expect(hookMatches(matcher, 'anything')).toBe(true)
  })

  it('explains what is wrong with a matcher typed as a pattern', () => {
    expect(matcherProblem('write_file')).toBeUndefined()
    expect(matcherProblem('write_file|edit_file')).toBeUndefined()
    expect(matcherProblem('mcp__github')).toBeUndefined()
    expect(matcherProblem('')).toBeUndefined()
    expect(matcherProblem('write_*')).toBe('"*" is not part of a tool name. The matcher is plain text, not a pattern; separate several tools with |.')
    expect(matcherProblem('^edit$')).toContain('"^"')
    expect(matcherProblem('(a|b)')).toContain('"("')
    expect(matcherProblem('a.b')).toContain('"."')
    expect(matcherProblem('x'.repeat(201))).toBe('The matcher must be 200 characters or fewer.')
    expect(matcherProblem('a\u0001')).toBe('The matcher contains a control character.')
  })
})

describe('validateHookTestRequest', () => {
  it('accepts each event and trims the text', () => {
    for (const event of HOOK_EVENTS) {
      expect(validateHookTestRequest({ event, command: ' npm run format ' })).toEqual({ ok: true, value: { event, command: 'npm run format' } })
    }
    expect(validateHookTestRequest({ event: 'PreToolUse', matcher: ' write_file ', command: 'x' })).toEqual({ ok: true, value: { event: 'PreToolUse', matcher: 'write_file', command: 'x' } })
    expect(validateHookTestRequest({ event: 'PreToolUse', matcher: '  ', command: 'x' })).toEqual({ ok: true, value: { event: 'PreToolUse', command: 'x' } })
  })

  it.each([
    [undefined, 'Expected a hook.'],
    ['x', 'Expected a hook.'],
    [{ command: 'x' }, 'Choose one of the four hook events.'],
    [{ event: 'OnSave', command: 'x' }, 'Choose one of the four hook events.'],
    [{ event: 'Stop' }, 'Enter the command to run.'],
    [{ event: 'Stop', command: '   ' }, 'Enter the command to run.'],
    [{ event: 'Stop', command: 4 }, 'Enter the command to run.'],
    [{ event: 'Stop', command: 'a'.repeat(4_001) }, 'The command must be 4,000 characters or fewer.'],
    [{ event: 'Stop', command: 'a\0b' }, 'The command contains a null character.'],
    [{ event: 'PreToolUse', command: 'x', matcher: 5 }, 'The matcher must be text.'],
    [{ event: 'PreToolUse', command: 'x', matcher: 'a*' }, '"*" is not part of a tool name. The matcher is plain text, not a pattern; separate several tools with |.']
  ])('rejects %j', (value, error) => {
    expect(validateHookTestRequest(value)).toEqual({ ok: false, error })
  })
})

describe('hook events', () => {
  it('lets only PreToolUse block, and only tool events match a tool', () => {
    expect(HOOK_EVENTS.filter((event) => HOOK_EVENT_INFO[event].canBlock)).toEqual(['PreToolUse'])
    expect(HOOK_EVENTS.filter((event) => HOOK_EVENT_INFO[event].matchesTools)).toEqual(['PreToolUse', 'PostToolUse'])
  })
})

describe('environment variable names', () => {
  it.each(['A', 'a', '_', '_PRIVATE', 'API_URL', 'Path', 'x1', 'SENTRY_ACCESS_TOKEN', 'A'.repeat(MCP_ENV_LIMITS.name)])('accepts %s', (name) => {
    expect(envNameProblem(name)).toBeUndefined()
  })

  it.each([
    ['', 'Enter a name.'],
    ['1ABC', 'Use letters, digits and underscores, and do not start with a digit.'],
    ['MY-VAR', 'Use letters, digits and underscores, and do not start with a digit.'],
    ['MY VAR', 'Use letters, digits and underscores, and do not start with a digit.'],
    ['A=B', 'Use letters, digits and underscores, and do not start with a digit.'],
    ['NAME\n', 'Use letters, digits and underscores, and do not start with a digit.'],
    ['CAFÉ', 'Use letters, digits and underscores, and do not start with a digit.'],
    ['__proto__', 'This name is reserved.'],
    ['A'.repeat(MCP_ENV_LIMITS.name + 1), 'Use 128 characters or fewer.']
  ])('explains why %j is refused', (name, message) => {
    expect(envNameProblem(name)).toBe(message)
  })

  it('finds names used twice, ignoring case, and reports the one written first', () => {
    expect(duplicateEnvNames(['PATH', 'Path', 'HOME', 'path'])).toEqual(new Set(['PATH']))
    expect(duplicateEnvNames(['A', 'B'])).toEqual(new Set())
  })

  it.each(['API_KEY', 'github_token', 'DB_PASSWORD', 'SERVICE_PASSPHRASE', 'CLIENT_SECRET', 'GITHUB_PAT', 'TOKEN', 'DATABASE_URL', 'OPENAI_APIKEY', 'AWS_CREDENTIALS'])('says %s looks like a credential', (name) => {
    expect(looksLikeSecretName(name)).toBe(true)
  })

  it.each(['PATH', 'REGION', 'NODE_ENV', 'LOG_LEVEL', 'SENTRY_ORG', 'MONKEY', 'TOKENIZER', 'COMPASS', 'KEYBOARD_LAYOUT'])('does not say %s looks like a credential', (name) => {
    expect(looksLikeSecretName(name)).toBe(false)
  })

  it('names the credential reference from the server and the variable, in one place', () => {
    expect(mcpSecretRef('3f2c1a9e-1b2c', 'SENTRY_ACCESS_TOKEN')).toBe('mcp-env:3f2c1a9e-1b2c:SENTRY_ACCESS_TOKEN')
  })
})

describe('variables in a connection test request', () => {
  const server = { name: 'Sentry', command: 'npx' }
  /** The variable checks run inside the request check, so each case puts its variables around a valid server. */
  const variablesOf = (variables: object, id: string | undefined): ReturnType<typeof validateMcpTestRequest> =>
    validateMcpTestRequest({ ...server, ...(id !== undefined ? { id } : {}), ...variables })

  it('accepts plain variables, typed secrets and saved secret names, and leaves out empty groups', () => {
    expect(variablesOf({ env: { REGION: 'eu', EMPTY: '' }, secrets: { TOKEN: 's3cret' }, savedSecrets: ['PASSWORD'] }, 'srv-1')).toEqual({
      ok: true, value: { ...server, args: [], id: 'srv-1', env: { REGION: 'eu', EMPTY: '' }, secrets: { TOKEN: 's3cret' }, savedSecrets: ['PASSWORD'] }
    })
    expect(variablesOf({ env: {}, secrets: {}, savedSecrets: [] }, undefined)).toEqual({ ok: true, value: { ...server, args: [] } })
  })

  it.each([
    [{ env: 'REGION=eu' }, 'Variables must be pairs of a name and a value.'],
    [{ env: [['A', 'b']] }, 'Variables must be pairs of a name and a value.'],
    [{ secrets: 'x' }, 'Secrets must be pairs of a name and a value.'],
    [{ env: { '1A': 'x' } }, '"1A" is not a valid variable name. Use letters, digits and underscores, and do not start with a digit.'],
    [{ env: { 'A B': 'x' } }, '"A B" is not a valid variable name. Use letters, digits and underscores, and do not start with a digit.'],
    [{ env: { A: 5 } }, 'The value of A must be text.'],
    [{ env: { A: 'x\0y' } }, 'The value of A contains a null character, which cannot be passed to a process.'],
    [{ env: { A: 'x'.repeat(MCP_ENV_LIMITS.value + 1) } }, 'The value of A must be 8,192 characters or fewer.'],
    [{ secrets: { TOKEN: '' } }, 'Enter a value for the secret TOKEN.'],
    [{ savedSecrets: 'TOKEN' }, 'Saved secrets must be a list of names.'],
    [{ savedSecrets: [3] }, 'Saved secrets must be a list of names.'],
    [{ savedSecrets: ['9TOKEN'] }, '"9TOKEN" is not a valid variable name. Use letters, digits and underscores, and do not start with a digit.'],
    [{ env: { PATH: 'a' }, secrets: { Path: 'b' } }, 'The variable PATH is set more than once.'],
    [{ secrets: { TOKEN: 'abc' }, savedSecrets: ['token'] }, 'The variable TOKEN is set more than once.'],
    [{ env: { A: 'x' }, savedSecrets: ['A'] }, 'The variable A is set more than once.']
  ])('rejects %j', (value, error) => {
    expect(variablesOf(value, 'srv-1')).toEqual({ ok: false, error })
  })

  it('needs the server id for saved secrets, because their values are found by it', () => {
    expect(variablesOf({ savedSecrets: ['TOKEN'] }, undefined)).toEqual({ ok: false, error: 'Saved secrets belong to a saved server.' })
    expect(variablesOf({ savedSecrets: [] }, undefined).ok).toBe(true)
  })

  it('bounds how many variables there are and how long they are together', () => {
    const many = Object.fromEntries(Array.from({ length: MCP_ENV_LIMITS.variables + 1 }, (_, index) => [`V${index}`, 'x']))
    expect(variablesOf({ env: many }, 'srv-1')).toEqual({ ok: false, error: 'Use 32 variables or fewer.' })
    const split = { env: { A: 'x'.repeat(8_192), B: 'x'.repeat(8_192) }, secrets: { C: 'x'.repeat(8_192) } }
    expect(variablesOf(split, 'srv-1')).toEqual({ ok: false, error: 'Variables must total 24,576 characters or fewer.' })
    expect(variablesOf({ savedSecrets: Array.from({ length: 40 }, (_, index) => `S${index}`) }, 'srv-1')).toEqual({ ok: false, error: 'Use 32 variables or fewer.' })
  })

  it('never puts a value in a message', () => {
    const secret = 'sup3r-s3cret-value'
    const results = [
      variablesOf({ env: { '1A': secret } }, 'srv-1'),
      variablesOf({ secrets: { 'bad name': secret } }, 'srv-1'),
      variablesOf({ secrets: { A: `${secret}\0` } }, 'srv-1'),
      variablesOf({ env: { A: secret.repeat(1_000) } }, 'srv-1'),
      variablesOf({ env: { A: secret }, secrets: { a: secret } }, 'srv-1')
    ]
    for (const result of results) {
      expect(result.ok).toBe(false)
      expect(JSON.stringify(result)).not.toContain(secret)
    }
  })

  it('quotes a bad name safely, whatever it holds', () => {
    const result = variablesOf({ env: { [`bad\n${'x'.repeat(100)}`]: 'v' } }, 'srv-1')
    expect(result).toMatchObject({ ok: false })
    expect(result.ok ? '' : result.error).not.toMatch(/\n/)
    expect(result.ok ? '' : result.error.length).toBeLessThan(160)
  })
})

describe('validateMcpSecretSave', () => {
  it('accepts a server id, a variable name and a value', () => {
    expect(validateMcpSecretSave({ serverId: 'srv-1', name: 'TOKEN', value: 'abc' })).toEqual({ ok: true, value: { serverId: 'srv-1', name: 'TOKEN', value: 'abc' } })
  })

  it.each([
    [undefined, 'Expected a secret to save.'],
    ['x', 'Expected a secret to save.'],
    [{ serverId: '../x', name: 'TOKEN', value: 'abc' }, 'The server id is not valid.'],
    [{ serverId: 'a:b', name: 'TOKEN', value: 'abc' }, 'The server id is not valid.'],
    [{ serverId: 7, name: 'TOKEN', value: 'abc' }, 'The server id is not valid.'],
    [{ serverId: 'srv-1', name: 5, value: 'abc' }, 'Enter a name for the variable.'],
    [{ serverId: 'srv-1', name: '1X', value: 'abc' }, '"1X" is not a valid variable name. Use letters, digits and underscores, and do not start with a digit.'],
    [{ serverId: 'srv-1', name: 'TOKEN', value: '' }, 'Enter a value for the secret TOKEN.'],
    [{ serverId: 'srv-1', name: 'TOKEN', value: 5 }, 'Enter a value for the secret TOKEN.'],
    [{ serverId: 'srv-1', name: 'TOKEN', value: 'a\0b' }, 'The value of TOKEN contains a null character, which cannot be passed to a process.'],
    [{ serverId: 'srv-1', name: 'TOKEN', value: 'x'.repeat(8_193) }, 'The value of TOKEN must be 8,192 characters or fewer.']
  ])('rejects %j', (value, error) => {
    expect(validateMcpSecretSave(value)).toEqual({ ok: false, error })
  })
})

describe('validateMcpSecretForget', () => {
  it('accepts a server id and names, once each', () => {
    expect(validateMcpSecretForget({ serverId: 'srv-1', names: ['A', 'B', 'A'] })).toEqual({ ok: true, value: { serverId: 'srv-1', names: ['A', 'B'] } })
    expect(validateMcpSecretForget({ serverId: 'srv-1', names: [] })).toEqual({ ok: true, value: { serverId: 'srv-1', names: [] } })
  })

  it.each([
    [null, 'Expected the secrets to remove.'],
    [{ serverId: 'x y', names: [] }, 'The server id is not valid.'],
    [{ serverId: 'srv-1', names: 'A' }, 'Expected a list of variable names.'],
    [{ serverId: 'srv-1', names: [1] }, 'Expected a list of variable names.'],
    [{ serverId: 'srv-1', names: ['ok', 'not ok'] }, '"not ok" is not a valid variable name. Use letters, digits and underscores, and do not start with a digit.'],
    [{ serverId: 'srv-1', names: Array.from({ length: 33 }, (_, index) => `N${index}`) }, 'Use 32 variables or fewer.']
  ])('rejects %j', (value, error) => {
    expect(validateMcpSecretForget(value)).toEqual({ ok: false, error })
  })
})
