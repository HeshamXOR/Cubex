import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { CliPeer } from '@shared/peers'
import { createScratch, peerEnvironment, removeScratch, runCliPeer, locatePeer, STDIN_PROMPT_LIMIT, ARGUMENT_PROMPT_LIMIT } from './peerRunner'
import { PEER_STDOUT_CAP } from './output'

// Fake agents: small node scripts started the way a real program is, through the same launch and process code.
let dir: string
const scripts: Record<string, string> = {
  'echo-stdin.cjs': `let d = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', (c) => { d += c }); process.stdin.on('end', () => { process.stdout.write('GOT:' + d) })`,
  'echo-arg.cjs': `process.stdout.write('ARG:' + process.argv[process.argv.length - 1])`,
  'fail.cjs': `process.stderr.write('boom: Invalid API key. Please run /login\\n'); process.exit(3)`,
  'silent.cjs': `process.exit(0)`,
  'sleep.cjs': `setTimeout(() => {}, 60000)`,
  'env.cjs': `process.stdout.write(JSON.stringify({ key: process.env.FAKE_API_KEY ?? null, plain: process.env.PLAIN_VAR ?? null, term: process.env.TERM ?? null, cwd: process.cwd() }))`,
  'big.cjs': `process.stdout.write('x'.repeat(${PEER_STDOUT_CAP + 50_000}))`,
  'claude.cjs': `process.stdout.write(JSON.stringify({ type: 'result', is_error: false, result: 'Fine.\\nVerdict: agree' }))`,
  'claude-error.cjs': `process.stdout.write(JSON.stringify({ type: 'result', is_error: true, result: 'Credit balance is too low' })); process.exit(1)`,
  'spawns-child.cjs': `const { spawn } = require('node:child_process'); const c = spawn(process.execPath, ['-e', 'setTimeout(()=>{},60000)'], { stdio: 'inherit' }); process.stdout.write('started'); setTimeout(() => {}, 60000)`
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'cubex-peer-test-'))
  for (const [name, source] of Object.entries(scripts)) writeFileSync(join(dir, name), source)
})
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const script = (name: string): string => join(dir, name)
const peer = (name: string, over: Partial<CliPeer> = {}): CliPeer => ({
  kind: 'cli', id: 'fake', name: 'Fake', enabled: true, preset: 'custom', command: process.execPath, args: [script(name)], input: 'stdin', ...over
})

describe('running a program as an agent', () => {
  it('sends the message on standard input, whole, with its line breaks and quotes', async () => {
    const prompt = 'Line one\n"quoted" and \'single\' and 100% and $HOME and `tick`\n\nLast line é 😀'
    const run = await runCliPeer(peer('echo-stdin.cjs'), { prompt, cwd: dir })
    expect(run).toMatchObject({ ok: true, reply: `GOT:${prompt}` })
    expect(run.durationMs).toBeGreaterThanOrEqual(0)
  })

  it('sends the message as the last argument', async () => {
    const prompt = 'Question with "quotes" and\nline breaks'
    const run = await runCliPeer(peer('echo-arg.cjs', { input: 'argument' }), { prompt, cwd: dir })
    expect(run).toMatchObject({ ok: true, reply: `ARG:${prompt}` })
  })

  it('starts the program in the folder it was given', async () => {
    const run = await runCliPeer(peer('env.cjs'), { prompt: 'x', cwd: dir })
    expect(JSON.parse(run.reply).cwd.toLowerCase()).toBe(dir.toLowerCase())
  })

  it('reads a reply in the shape Claude Code prints', async () => {
    const run = await runCliPeer(peer('claude.cjs', { preset: 'claude-code', name: 'Claude Code', args: undefined }), {
      prompt: 'x', cwd: dir, launch: () => ({ file: process.execPath, args: [script('claude.cjs')], windowsVerbatimArguments: false, mode: 'direct' })
    })
    expect(run).toMatchObject({ ok: true, reply: 'Fine.\nVerdict: agree' })
  })

  it('says why a program failed, with a hint, and shows what it wrote to its error output', async () => {
    const run = await runCliPeer(peer('fail.cjs'), { prompt: 'x', cwd: dir })
    expect(run.ok).toBe(false)
    expect(run.error).toContain('exit code 3')
    expect(run.output).toContain('Invalid API key')
    expect(run.hint).toContain('Sign in')
  })

  it('uses the failure a program names in its own output', async () => {
    const run = await runCliPeer(peer('claude-error.cjs', { preset: 'claude-code', args: undefined }), {
      prompt: 'x', cwd: dir, launch: () => ({ file: process.execPath, args: [script('claude-error.cjs')], windowsVerbatimArguments: false, mode: 'direct' })
    })
    expect(run.ok).toBe(false)
    expect(run.error).toBe('Credit balance is too low')
    expect(run.hint).toContain('out of credit')
  })

  it('reports a program that finishes without a reply', async () => {
    const run = await runCliPeer(peer('silent.cjs'), { prompt: 'x', cwd: dir })
    expect(run).toMatchObject({ ok: false, error: 'Fake finished without a reply.' })
    expect(run.hint).toBeTruthy()
  })

  it('tells Antigravity users about the empty-output bug', async () => {
    const run = await runCliPeer(peer('silent.cjs', { preset: 'antigravity', name: 'Antigravity' }), {
      prompt: 'x', cwd: dir, launch: () => ({ file: process.execPath, args: [script('silent.cjs')], windowsVerbatimArguments: false, mode: 'direct' })
    })
    expect(run.ok).toBe(false)
    expect(run.hint).toContain('agy update')
  })

  it('stops a program that takes too long, and says so', async () => {
    const started = Date.now()
    const run = await runCliPeer(peer('sleep.cjs'), { prompt: 'x', cwd: dir, timeoutMs: 500 })
    expect(run.ok).toBe(false)
    expect(run.error).toContain('did not answer within')
    expect(Date.now() - started).toBeLessThan(9_000)
  }, 15_000)

  it('stops when the turn is cancelled', async () => {
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 400)
    const started = Date.now()
    const run = await runCliPeer(peer('sleep.cjs'), { prompt: 'x', cwd: dir, signal: controller.signal })
    expect(run).toMatchObject({ ok: false, error: 'Cancelled.' })
    expect(Date.now() - started).toBeLessThan(9_000)
  }, 15_000)

  it('does not start when the turn is already cancelled', async () => {
    const controller = new AbortController()
    controller.abort()
    expect(await runCliPeer(peer('echo-stdin.cjs'), { prompt: 'x', cwd: dir, signal: controller.signal })).toMatchObject({ ok: false, error: 'Cancelled.' })
  })

  it('stops what the program started as well', async () => {
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 700)
    const run = await runCliPeer(peer('spawns-child.cjs'), { prompt: 'x', cwd: dir, signal: controller.signal })
    expect(run).toMatchObject({ ok: false, error: 'Cancelled.' })
  }, 15_000)

  it('keeps no more output than the cap', async () => {
    const run = await runCliPeer(peer('big.cjs'), { prompt: 'x', cwd: dir })
    expect(run.ok).toBe(true)
    expect(run.reply.length).toBeLessThanOrEqual(PEER_STDOUT_CAP)
  })

  it('refuses a message too long for how it is sent', async () => {
    const byInput = await runCliPeer(peer('echo-stdin.cjs'), { prompt: 'x'.repeat(STDIN_PROMPT_LIMIT + 1), cwd: dir })
    expect(byInput).toMatchObject({ ok: false })
    expect(byInput.error).toContain('more than Fake can be sent')
    const byArgument = await runCliPeer(peer('echo-arg.cjs', { input: 'argument' }), { prompt: 'x'.repeat(ARGUMENT_PROMPT_LIMIT + 1), cwd: dir })
    expect(byArgument.ok).toBe(false)
  })

  it('says when the program is not installed', async () => {
    const run = await runCliPeer(peer('echo-stdin.cjs', { command: 'cubex-no-such-program-xyz' }), { prompt: 'x', cwd: dir })
    expect(run.ok).toBe(false)
    expect(run.error).toContain('cubex-no-such-program-xyz')
  })
})

describe('what a program inherits', () => {
  const base = { ...process.env, FAKE_API_KEY: 'sk-secret-value', PLAIN_VAR: 'plain' }

  it('keeps credentials out, and everything ordinary in', async () => {
    const run = await runCliPeer(peer('env.cjs'), { prompt: 'x', cwd: dir, env: base })
    expect(JSON.parse(run.reply)).toMatchObject({ key: null, plain: 'plain', term: 'dumb' })
  })

  it('passes a variable the person listed', async () => {
    const run = await runCliPeer(peer('env.cjs', { passEnv: ['FAKE_API_KEY'] }), { prompt: 'x', cwd: dir, env: base })
    expect(JSON.parse(run.reply).key).toBe('sk-secret-value')
  })

  it.skipIf(process.platform !== 'win32')('matches the name of a variable without regard to case on Windows', () => {
    const env = peerEnvironment(peer('env.cjs', { passEnv: ['fake_api_key'] }), base)
    expect(env.FAKE_API_KEY).toBe('sk-secret-value')
    expect(Object.keys(env).filter((key) => key.toLowerCase() === 'fake_api_key')).toEqual(['FAKE_API_KEY'])
  })

  it('does not pass a variable that is not set', () => {
    const env = peerEnvironment(peer('env.cjs', { passEnv: ['NOT_SET_ANYWHERE_XYZ'] }), base)
    expect('NOT_SET_ANYWHERE_XYZ' in env).toBe(false)
  })

  it('adds the usual tool folders after the ones PATH has', () => {
    const env = peerEnvironment(peer('env.cjs'), { PATH: ['/first', '/second'].join(delimiter) })
    const entries = (env.PATH ?? '').split(delimiter)
    expect(entries.slice(0, 2)).toEqual(['/first', '/second'])
    expect(entries.length).toBeGreaterThan(2)
  })

  it('writes the folders to the PATH variable under the name it already has', () => {
    const env = peerEnvironment(peer('env.cjs'), { Path: '/only' })
    expect(Object.keys(env).filter((key) => key.toLowerCase() === 'path')).toEqual(['Path'])
    expect(env.Path?.startsWith('/only')).toBe(true)
  })
})

describe('finding a program', () => {
  it('finds a file by its full path', () => {
    expect(locatePeer(peer('echo-stdin.cjs'))?.toLowerCase()).toBe(process.execPath.toLowerCase())
  })

  it('does not find what is not there', () => {
    expect(locatePeer(peer('echo-stdin.cjs', { command: 'cubex-no-such-program-xyz' }))).toBeUndefined()
  })
})

describe('the empty folder', () => {
  it('is created and removed', () => {
    const folder = createScratch()
    expect(existsSync(folder)).toBe(true)
    expect(folder.toLowerCase()).toContain('cubex-consult')
    removeScratch(folder)
    expect(existsSync(folder)).toBe(false)
  })

  it('is the only kind of folder that is removed', () => {
    const elsewhere = mkdtempSync(join(tmpdir(), 'cubex-not-scratch-'))
    removeScratch(elsewhere)
    expect(existsSync(elsewhere)).toBe(true)
    rmSync(elsewhere, { recursive: true, force: true })
  })
})
