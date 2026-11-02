import { describe, expect, it } from 'vitest'
import { cleanCheckOutput, runCheckCommand } from './checkRunner'

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
