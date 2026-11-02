import { describe, expect, it } from 'vitest'
import { PARALLEL_READ_ONLY_TOOLS, createLimiter, mayOverlap } from './parallelTools'

const tick = (ms = 0): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

describe('mayOverlap', () => {
  it('lets every listed read-only tool overlap when it runs without asking', () => {
    for (const name of PARALLEL_READ_ONLY_TOOLS) expect(mayOverlap(name, 'allow', false)).toBe(true)
  })

  it('keeps a web fetch that would ask for approval in line', () => {
    expect(mayOverlap('web_fetch', 'allow', true)).toBe(false)
    expect(mayOverlap('web_fetch', 'allow', false)).toBe(true)
  })

  it('never overlaps a tool that asks, is denied, or is unknown', () => {
    for (const name of PARALLEL_READ_ONLY_TOOLS) {
      expect(mayOverlap(name, 'ask', false)).toBe(false)
      expect(mayOverlap(name, 'deny', false)).toBe(false)
      expect(mayOverlap(name, undefined, false)).toBe(false)
    }
  })

  it('never overlaps mutations, shell commands, delegation or the special tools, even when they run without asking', () => {
    for (const name of ['write_file', 'edit_file', 'remove_file', 'run_command', 'delegate_to_subagent', 'todo_write', 'ask_user_question', 'exit_plan_mode', 'read_plan', 'mcp__demo__ping', 'made_up']) {
      expect(mayOverlap(name, 'allow', false)).toBe(false)
    }
  })
})

describe('createLimiter', () => {
  it('never runs more than the limit at once, and reaches it', async () => {
    const limit = createLimiter(3)
    let active = 0
    let peak = 0
    const results = await Promise.all(Array.from({ length: 10 }, (_, index) => limit(async () => {
      active++
      peak = Math.max(peak, active)
      await tick(5)
      active--
      return index
    })))
    expect(peak).toBe(3)
    expect(results).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
  })

  it('releases the slot when a task throws, and passes the error on', async () => {
    const limit = createLimiter(1)
    const failing = limit(async () => { throw new Error('boom') })
    const next = limit(async () => 'ran')
    await expect(failing).rejects.toThrow('boom')
    await expect(next).resolves.toBe('ran')
  })
})
