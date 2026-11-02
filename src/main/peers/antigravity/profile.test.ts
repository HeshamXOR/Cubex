import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  AUTH_BROWSER_MARKER, AUTH_STDOUT_PREFIX, PROFILE_SETTINGS, ProfileError, antigravityDirectories, antigravityEnvironment, authorizationUrlIn, browserCommand, browserHelperWorks,
  hasSavedSignIn, parseAuthorizationUrl, prepareProfile, sweepRuntimeTemp, tokenPathOf, type AntigravityProfile
} from './profile'

const GOOGLE = 'https://accounts.google.com/o/oauth2/v2/auth'
const valid = (over: Record<string, string | null> = {}): string => {
  const params: Record<string, string | null> = { client_id: 'abc', redirect_uri: 'http://127.0.0.1:43211/', response_type: 'code', state: 'xyz123', scope: 'openid email', ...over }
  const query = Object.entries(params).filter(([, value]) => value !== null).map(([key, value]) => `${key}=${encodeURIComponent(value as string)}`).join('&')
  return `${GOOGLE}?${query}`
}

let dir: string
beforeAll(() => { dir = mkdtempSync(join(tmpdir(), 'cubex-agy-profile-')) })
afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe('the folders of Antigravity', () => {
  it('are short, under one folder, and named for the platform the runtime is for', () => {
    const folders = antigravityDirectories(join(dir, 'agy'), 'win32', 'x64')
    expect(folders.managed).toBe(join(dir, 'agy', 'runtime', 'win32-x64'))
    expect(folders.profile).toBe(join(dir, 'agy', 'profile'))
    expect(folders.temp).toBe(join(dir, 'agy', 'tmp'))
  })
})

describe('the command that stands in for a browser', () => {
  it('quotes each part, with the program, the code, the separator and the place for the address', () => {
    const command = browserCommand('/usr/bin/node', 'linux')!
    expect(command.startsWith("'/usr/bin/node' '-e' '")).toBe(true)
    expect(command.endsWith("'--' '%s'")).toBe(true)
    expect(command).toContain(AUTH_BROWSER_MARKER)
  })

  it('writes a Windows path with forward slashes, which is how Python splits and reads it', () => {
    expect(browserCommand('C:\\Program Files\\Cubex\\Cubex.exe', 'win32')!.startsWith("'C:/Program Files/Cubex/Cubex.exe' '-e'")).toBe(true)
  })

  it('has no colon and no semicolon where Python would split it', () => {
    expect(browserCommand('/usr/bin/node', 'linux')!).not.toContain(':')
    expect(browserCommand('C:\\a\\node.exe', 'win32')!).not.toContain(';')
  })

  it('refuses a program whose path would break the command: one with a separator in it, a line break, or the place for the address', () => {
    expect(browserCommand('/opt/a:b/node', 'linux')).toBeUndefined()
    expect(browserCommand('C:\\a;b\\node.exe', 'win32')).toBeUndefined()
    expect(browserCommand('/opt/a\nb/node', 'linux')).toBeUndefined()
    expect(browserCommand('/opt/%s/node', 'linux')).toBeUndefined()
  })

  it('does what it is trusted to do when it is run: report the address on the error output, and nothing else', () => {
    expect(browserHelperWorks(process.execPath, process.env)).toBe(true)
  })

  it('is not trusted when the program is not one that runs it', () => {
    expect(browserHelperWorks(join(dir, 'no-such-program'), process.env)).toBe(false)
  })
})

describe('the address of the sign-in page', () => {
  it('is accepted when it is Google\'s page for the code flow, with a return address on this computer', () => {
    expect(parseAuthorizationUrl(valid())).toEqual({ authorizationUrl: valid(), redirectUri: 'http://127.0.0.1:43211/', state: 'xyz123' })
  })

  it('is handed on as it was parsed, so a character that a program could read as more than part of an address is encoded', () => {
    const written = `${valid()}&extra="--flag"<b>'x'`
    const parsed = parseAuthorizationUrl(written)
    expect(parsed).toBeDefined()
    expect(parsed!.authorizationUrl).toBe(`${valid()}&extra=%22--flag%22%3Cb%3E%27x%27`)
    expect(parsed!.authorizationUrl).not.toMatch(/["'<>]/)
    // And a page that is written in capitals is the same page, written the way it is opened.
    expect(parseAuthorizationUrl(valid().replace('https://accounts.google.com', 'HTTPS://ACCOUNTS.GOOGLE.COM'))!.authorizationUrl).toBe(valid())
  })

  it.each([
    ['another site', valid().replace('accounts.google.com', 'accounts.google.com.evil.example')],
    ['plain http', valid().replace('https://', 'http://')],
    ['another page of Google\'s', valid().replace('/o/oauth2/v2/auth', '/signin')],
    ['credentials in the address', valid().replace('https://', 'https://user:pw@')],
    ['a fragment', `${valid()}#frag`],
    ['no state', valid({ state: null })],
    ['an empty state', valid({ state: '' })],
    ['a state with a space', valid({ state: 'a b' })],
    ['a state that is too long', valid({ state: 'x'.repeat(513) })],
    ['two states', `${valid()}&state=other`],
    ['no return address', valid({ redirect_uri: null })],
    ['a return address that is not on this computer', valid({ redirect_uri: 'http://evil.example:43211/' })],
    ['a return address that is localhost', valid({ redirect_uri: 'http://localhost:43211/' })],
    ['a return address with a path', valid({ redirect_uri: 'http://127.0.0.1:43211/callback' })],
    ['a return address on a privileged port', valid({ redirect_uri: 'http://127.0.0.1:80/' })],
    ['a return address on https', valid({ redirect_uri: 'https://127.0.0.1:43211/' })],
    ['a response that is not a code', valid({ response_type: 'token' })],
    ['no response type', valid({ response_type: null })],
    ['white space', `${valid()} `],
    ['something that is not an address', 'not an address'],
    ['an address that is far too long', `${valid()}&pad=${'x'.repeat(20_000)}`]
  ])('is refused when it has %s', (_name, address) => {
    expect(parseAuthorizationUrl(address)).toBeUndefined()
  })
})

describe('the lines that report it', () => {
  it('reads the line the runtime prints to its output', () => {
    expect(authorizationUrlIn(`${AUTH_STDOUT_PREFIX}${valid()}`)).toEqual({ found: true, request: parseAuthorizationUrl(valid()) })
    expect(authorizationUrlIn(`${AUTH_STDOUT_PREFIX}${valid()}\r`)).toMatchObject({ found: true })
  })

  it('reads the line the stand-in browser prints, with the address as a JSON string', () => {
    expect(authorizationUrlIn(`${AUTH_BROWSER_MARKER}${JSON.stringify(valid())}`)).toEqual({ found: true, request: parseAuthorizationUrl(valid()) })
  })

  it('knows a report from a line about something else', () => {
    expect(authorizationUrlIn('Starting the server')).toEqual({ found: false })
    expect(authorizationUrlIn('')).toEqual({ found: false })
  })

  it('knows a report whose address cannot be used, and gives no address', () => {
    expect(authorizationUrlIn(`${AUTH_STDOUT_PREFIX}https://evil.example/`)).toEqual({ found: true, request: undefined })
    expect(authorizationUrlIn(`${AUTH_BROWSER_MARKER}not json`)).toEqual({ found: true, request: undefined })
    expect(authorizationUrlIn(`${AUTH_BROWSER_MARKER}42`)).toEqual({ found: true, request: undefined })
  })
})

describe('the environment of the runtime', () => {
  const profile: AntigravityProfile = { platform: 'linux', geminiHome: '/p/profile', acpDirectory: '/p/profile/antigravity-acp', tokenPath: '/p/profile/antigravity-acp/acp_token.json', tempDirectory: '/p/tmp', browserCommand: "'node' '-e' 'x'" }

  it('has no other login: not a key, not a project, not a credentials file, whatever the case of the name', () => {
    const env = antigravityEnvironment(profile, {
      PATH: '/bin', HOME: '/home/a', GEMINI_API_KEY: 'k', google_api_key: 'k', GOOGLE_APPLICATION_CREDENTIALS: '/c.json', GOOGLE_CLOUD_PROJECT: 'p',
      GOOGLE_GENAI_USE_VERTEXAI: '1', GCLOUD_PROJECT: 'p', GEMINI_HOME: '/other', BROWSER: 'firefox', ELECTRON_RUN_AS_NODE: '0', ANTIGRAVITY_HARNESS_PATH: '/x'
    })
    expect(env).toMatchObject({ PATH: '/bin', HOME: '/home/a' })
    for (const name of ['GEMINI_API_KEY', 'google_api_key', 'GOOGLE_APPLICATION_CREDENTIALS', 'GOOGLE_CLOUD_PROJECT', 'GOOGLE_GENAI_USE_VERTEXAI', 'GCLOUD_PROJECT', 'ANTIGRAVITY_HARNESS_PATH']) expect(env[name], name).toBeUndefined()
  })

  it('has its own profile, keeps its sign-in in a file, uses the stand-in browser and runs the helper as Node', () => {
    const env = antigravityEnvironment(profile, { PATH: '/bin' })
    expect(env).toMatchObject({ GEMINI_HOME: '/p/profile', AGY_ACP_FORCE_FILE_STORAGE: '1', BROWSER: profile.browserCommand, PYTHONUNBUFFERED: '1', ELECTRON_RUN_AS_NODE: '1', TMPDIR: '/p/tmp' })
  })

  it('unpacks into the temporary folder of this run, and says so the way each system reads it', () => {
    expect(antigravityEnvironment(profile, {}, '/p/tmp/run-1')).toMatchObject({ TMPDIR: '/p/tmp/run-1' })
    const win = antigravityEnvironment({ ...profile, platform: 'win32' }, {}, 'C:/t/run-1')
    expect(win).toMatchObject({ TEMP: 'C:/t/run-1', TMP: 'C:/t/run-1' })
    expect(win.TMPDIR).toBeUndefined()
  })
})

describe('preparing the profile', () => {
  it('makes the folders, writes the settings that name the sign-in method, and says where the sign-in is saved', () => {
    const profile = prepareProfile({ profileDirectory: join(dir, 'a', 'profile'), tempDirectory: join(dir, 'a', 'tmp'), helperExecutable: process.execPath, baseEnv: process.env })
    expect(existsSync(profile.geminiHome)).toBe(true)
    expect(existsSync(profile.tempDirectory)).toBe(true)
    expect(readFileSync(join(profile.acpDirectory, 'settings.json'), 'utf8')).toBe(PROFILE_SETTINGS)
    expect(JSON.parse(PROFILE_SETTINGS)).toEqual({ auth: { type: 'oauth-personal' } })
    expect(profile.tokenPath).toBe(join(profile.acpDirectory, 'acp_token.json'))
    expect(profile.browserCommand).toContain(AUTH_BROWSER_MARKER)
  })

  it('writes the settings again each time, so what they say is what this version means', () => {
    const input = { profileDirectory: join(dir, 'b', 'profile'), tempDirectory: join(dir, 'b', 'tmp'), helperExecutable: process.execPath, baseEnv: process.env }
    const profile = prepareProfile(input)
    writeFileSync(join(profile.acpDirectory, 'settings.json'), '{"auth":{"type":"gemini-api-key"}}')
    prepareProfile(input)
    expect(readFileSync(join(profile.acpDirectory, 'settings.json'), 'utf8')).toBe(PROFILE_SETTINGS)
  })

  it('does not touch a sign-in that is saved', () => {
    const input = { profileDirectory: join(dir, 'c', 'profile'), tempDirectory: join(dir, 'c', 'tmp'), helperExecutable: process.execPath, baseEnv: process.env }
    const profile = prepareProfile(input)
    writeFileSync(profile.tokenPath, 'saved')
    prepareProfile(input)
    expect(readFileSync(profile.tokenPath, 'utf8')).toBe('saved')
  })

  it('refuses when the helper cannot be used to keep a browser from opening, and makes nothing', () => {
    expect(() => prepareProfile({ profileDirectory: join(dir, 'd', 'profile'), tempDirectory: join(dir, 'd', 'tmp'), helperExecutable: join(dir, 'no-such-program'), baseEnv: process.env })).toThrow(ProfileError)
    expect(existsSync(join(dir, 'd'))).toBe(false)
  })

  it('refuses a helper whose path cannot be put in the command', () => {
    expect(() => prepareProfile({ profileDirectory: join(dir, 'e', 'profile'), tempDirectory: join(dir, 'e', 'tmp'), helperExecutable: '/opt/a:b/node', platform: 'linux', baseEnv: process.env })).toThrow('cannot be used to keep Antigravity from opening a browser')
  })
})

describe('whether the runtime has a sign-in saved', () => {
  it('is whether the file is there, and not what is in it', () => {
    const profileDirectory = join(dir, 'f', 'profile')
    expect(hasSavedSignIn(profileDirectory)).toBe(false)
    mkdirSync(join(profileDirectory, 'antigravity-acp'), { recursive: true })
    expect(hasSavedSignIn(profileDirectory)).toBe(false)
    writeFileSync(tokenPathOf(profileDirectory), '')
    expect(hasSavedSignIn(profileDirectory)).toBe(true)
  })

  it('is not a folder that has the name', () => {
    const profileDirectory = join(dir, 'g', 'profile')
    mkdirSync(tokenPathOf(profileDirectory), { recursive: true })
    expect(hasSavedSignIn(profileDirectory)).toBe(false)
  })
})

describe('sweeping the temporary folders', () => {
  it('removes what a run left, and nothing else', () => {
    const root = join(dir, 'h')
    mkdirSync(join(root, 'run-abc'), { recursive: true })
    writeFileSync(join(root, 'run-abc', 'file'), 'x')
    mkdirSync(join(root, 'keep'))
    sweepRuntimeTemp(root)
    expect(existsSync(join(root, 'run-abc'))).toBe(false)
    expect(existsSync(join(root, 'keep'))).toBe(true)
    expect(() => sweepRuntimeTemp(join(dir, 'does-not-exist'))).not.toThrow()
  })
})
