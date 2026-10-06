import { describe, expect, it } from 'vitest'
import { MAX_PARALLEL_TOOLS, PARALLEL_READ_ONLY_TOOLS, createLimiter, mayOverlap, notRunResult, toolFailureResult } from './parallelTools'

const tick = (ms = 0): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

describe('PARALLEL_READ_ONLY_TOOLS', () => {
  it('lists exactly the auto-allowed read-only tools, and caps parallelism at four', () => {
    expect([...PARALLEL_READ_ONLY_TOOLS].sort()).toEqual(
      ['glob_files', 'list_files', 'read_command_output', 'read_file', 'search_files', 'skill', 'web_fetch', 'web_search']
    )
    for (const name of ['write_file', 'edit_file', 'remove_file', 'run_command', 'delegate_to_subagent', 'todo_write', 'ask_user_question', 'exit_plan_mode', 'read_plan']) {
      expect(PARALLEL_READ_ONLY_TOOLS.has(name)).toBe(false)
    }
    expect(MAX_PARALLEL_TOOLS).toBe(4)
  })
})

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

describe('result placeholders', () => {
  it('marks a call that never ran as an error the model can read', () => {
    expect(notRunResult('call_1')).toEqual({
      type: 'tool_result', toolUseId: 'call_1', isError: true, content: [{ type: 'text', text: 'This call was cancelled before it ran.' }]
    })
  })

  it('turns a thrown error, or any other thrown value, into that call\'s own failure', () => {
    expect(toolFailureResult('call_2', new Error('disk gone'))).toEqual({
      type: 'tool_result', toolUseId: 'call_2', isError: true, content: [{ type: 'text', text: 'Tool error: disk gone' }]
    })
    expect(toolFailureResult('call_3', 'plain text')).toMatchObject({ toolUseId: 'call_3', isError: true, content: [{ type: 'text', text: 'Tool error: plain text' }] })
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

  it('starts waiting tasks in arrival order as slots free up', async () => {
    const limit = createLimiter(2)
    const started: number[] = []
    const gates = Array.from({ length: 5 }, () => {
      let open!: () => void
      const promise = new Promise<void>((resolve) => { open = resolve })
      return { promise, open }
    })
    const runs = gates.map((gate, index) => limit(async () => { started.push(index); await gate.promise }))
    await tick()
    expect(started).toEqual([0, 1])
    gates[1]!.open() // a later task finishing frees a slot for the next in line, not for a jumper
    await tick()
    expect(started).toEqual([0, 1, 2])
    gates[0]!.open()
    gates[2]!.open()
    await tick()
    expect(started).toEqual([0, 1, 2, 3, 4])
    gates[3]!.open()
    gates[4]!.open()
    await Promise.all(runs)
  })

  it('keeps the cap while tasks keep arriving as others finish', async () => {
    const limit = createLimiter(2)
    let active = 0
    let peak = 0
    const task = async (ms: number): Promise<void> => { active++; peak = Math.max(peak, active); await tick(ms); active-- }
    const runs: Array<Promise<void>> = []
    for (let index = 0; index < 20; index++) {
      runs.push(limit(() => task(index % 3)))
      if (index % 4 === 0) await tick(1) // arrivals interleave with completions and slot hand-offs
    }
    await Promise.all(runs)
    expect(peak).toBe(2)
    expect(active).toBe(0)
  })

  it('releases the slot when a task throws, and passes the error on', async () => {
    const limit = createLimiter(1)
    const failing = limit(async () => { throw new Error('boom') })
    const next = limit(async () => 'ran')
    await expect(failing).rejects.toThrow('boom')
    await expect(next).resolves.toBe('ran')
  })

  it('treats a limit below one as one', async () => {
    const limit = createLimiter(0)
    let active = 0
    let peak = 0
    await Promise.all([1, 2, 3].map(() => limit(async () => { active++; peak = Math.max(peak, active); await tick(1); active-- })))
    expect(peak).toBe(1)
  })
})
