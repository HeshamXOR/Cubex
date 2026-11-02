import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { AUTH_BROWSER_MARKER, PROFILE_SETTINGS, antigravityEnvironment, browserCommand, parseAuthorizationUrl, prepareProfile, sweepRuntimeTemp, type AntigravityProfile } from './profile'

const GOOGLE = 'https://accounts.google.com/o/oauth2/v2/auth'
const valid = (over: Record<string, string | null> = {}): string => {
  const params: Record<string, string | null> = { client_id: 'abc', redirect_uri: 'http://127.0.0.1:43211/', response_type: 'code', state: 'xyz123', scope: 'openid email', ...over }
  const query = Object.entries(params).filter(([, value]) => value !== null).map(([key, value]) => `${key}=${encodeURIComponent(value as string)}`).join('&')
  return `${GOOGLE}?${query}`
}

let dir: string
beforeAll(() => { dir = mkdtempSync(join(tmpdir(), 'cubex-agy-profile-')) })
afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe('the command that stands in for a browser', () => {
  it('quotes each part, with the program, the code, the separator and the place for the address', () => {
    const command = browserCommand('/usr/bin/node', 'linux')!
    expect(command.startsWith("'/usr/bin/node' '-e' '")).toBe(true)
    expect(command.endsWith("'--' '%s'")).toBe(true)
    expect(command).toContain(AUTH_BROWSER_MARKER)
  })

  it('refuses a program whose path would break the command: one with a separator in it, a line break, or the place for the address', () => {
    expect(browserCommand('/opt/a:b/node', 'linux')).toBeUndefined()
    expect(browserCommand('C:\\a;b\\node.exe', 'win32')).toBeUndefined()
    expect(browserCommand('/opt/a\nb/node', 'linux')).toBeUndefined()
    expect(browserCommand('/opt/%s/node', 'linux')).toBeUndefined()
  })
})

describe('the address of the sign-in page', () => {
  it('is accepted when it is Google\'s page for the code flow, with a return address on this computer', () => {
    expect(parseAuthorizationUrl(valid())).toEqual({ authorizationUrl: valid(), redirectUri: 'http://127.0.0.1:43211/', state: 'xyz123' })
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

  it('does not touch a sign-in that is saved', () => {
    const input = { profileDirectory: join(dir, 'c', 'profile'), tempDirectory: join(dir, 'c', 'tmp'), helperExecutable: process.execPath, baseEnv: process.env }
    const profile = prepareProfile(input)
    writeFileSync(profile.tokenPath, 'saved')
    prepareProfile(input)
    expect(readFileSync(profile.tokenPath, 'utf8')).toBe('saved')
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
