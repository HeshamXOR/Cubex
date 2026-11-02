import { describe, expect, it } from 'vitest'
import { CHECK_OUTPUT_CAP, cleanCheckOutput, runCheckCommand } from './checkRunner'

const node = (script: string): string => `node -e "${script}"`

describe('runCheckCommand', () => {
  it('reports exit code 0 and what the command printed', async () => {
    const run = await runCheckCommand(node("console.log('all good')"), { cwd: process.cwd(), shell: 'auto' })
    expect(run).toMatchObject({ exitCode: 0, timedOut: false, cancelled: false })
    expect(run.output).toBe('all good')
    expect(run.startError).toBeUndefined()
  }, 20_000)

  it('reports a failing exit code, with output from both streams', async () => {
    const run = await runCheckCommand(node("console.log('out'); console.error('FAIL one test'); process.exit(3)"), { cwd: process.cwd() })
    expect(run.exitCode).toBe(3)
    expect(run.output).toContain('out')
    expect(run.output).toContain('FAIL one test')
  }, 20_000)

  it('runs in the folder it was given', async () => {
    const run = await runCheckCommand(node('console.log(process.cwd())'), { cwd: process.cwd() })
    expect(run.output.toLowerCase()).toBe(process.cwd().toLowerCase())
  }, 20_000)

  it('keeps the end of long output, which is where a test run prints its failures', async () => {
    const run = await runCheckCommand(node(`process.stdout.write('a'.repeat(${CHECK_OUTPUT_CAP * 2})); process.stdout.write('THE END')`), { cwd: process.cwd() })
    expect(run.output.length).toBeLessThanOrEqual(CHECK_OUTPUT_CAP)
    expect(run.output.endsWith('THE END')).toBe(true)
  }, 20_000)

  it('stops a command that runs past its time and says so', async () => {
    const run = await runCheckCommand(node('setInterval(() => {}, 1000)'), { cwd: process.cwd(), timeoutMs: 600 })
    expect(run).toMatchObject({ timedOut: true, cancelled: false, exitCode: null })
  }, 20_000)

  it('stops a command when the goal is paused', async () => {
    const controller = new AbortController()
    const pending = runCheckCommand(node('setInterval(() => {}, 1000)'), { cwd: process.cwd(), signal: controller.signal })
    setTimeout(() => controller.abort(), 300)
    expect(await pending).toMatchObject({ cancelled: true, timedOut: false, exitCode: null })
  }, 20_000)

  it('does not start when it was already cancelled', async () => {
    const controller = new AbortController()
    controller.abort()
    expect(await runCheckCommand(node("console.log('never')"), { cwd: process.cwd(), signal: controller.signal })).toMatchObject({ cancelled: true, output: '' })
  })

  it('reports a command that could not start, in words', async () => {
    const run = await runCheckCommand('anything', {
      cwd: process.cwd(),
      spawn: () => { throw new Error('This command is too long to pass to cmd on Windows.') }
    })
    expect(run).toMatchObject({ exitCode: null, startError: 'This command is too long to pass to cmd on Windows.' })
  })

  it('reports a folder that does not exist as a failure to start', async () => {
    const run = await runCheckCommand(node("console.log('x')"), { cwd: 'Z:\\definitely\\not\\here\\anywhere' })
    // The shell either fails to start (ENOENT) or exits non-zero; it must never look like a pass.
    expect(run.exitCode === 0).toBe(false)
  }, 20_000)
})

describe('cleanCheckOutput', () => {
  it('removes color codes and carriage returns, and secrets', () => {
    const text = cleanCheckOutput('\u001b[31mFAIL\u001b[0m a.test.ts\r\nkey sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGH\r\n')
    expect(text).not.toContain('\u001b')
    expect(text).not.toContain('\r')
    expect(text).toContain('FAIL a.test.ts')
    expect(text).not.toContain('abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGH')
  })
})
