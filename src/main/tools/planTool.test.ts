import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { JSONValue } from '@core/types'
import { PlanStore } from '../plans'
import { createReadPlanTool } from './planTool'

let dir: string
let store: PlanStore
const context = { requestPermission: async () => ({ decision: 'allow' as const }) }
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cubex-read-plan-'))
  store = new PlanStore(join(dir, 'plans'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('read_plan', () => {
  it('reads the latest saved revision with its exact Markdown and feedback after restart', async () => {
    const first = store.create('task', { plan: '# First plan' })
    store.settle(first.id, { decision: 'reject' })
    const markdown = '# Updated plan\n\n1. Preserve the parser API.\n'
    const feedback = '  Include nested comments.\nKeep `parse(text)` public.  '
    const latest = store.create('task', { plan: markdown })
    store.settle(latest.id, { decision: 'reject', feedback })
    const tool = createReadPlanTool(new PlanStore(join(dir, 'plans')), 'task')
    const result = await tool.execute({}, context)
    expect(result.isError).toBeFalsy()
    expect(JSON.parse(result.content as string)).toMatchObject({ id: latest.id, plan: markdown, status: 'rejected', feedback })
    const older = await tool.execute({ id: first.id }, context)
    expect(JSON.parse(older.content as string)).toMatchObject({ id: first.id, plan: '# First plan' })
  })

  it('rejects another task’s exact plan id and never returns its contents', async () => {
    const foreign = store.create('other-task', { plan: '# PRIVATE_OTHER_TASK_PLAN' })
    store.settle(foreign.id, { decision: 'default' })
    const own = store.create('task', { plan: '# This task only' })
    store.settle(own.id, { decision: 'default' })
    const tool = createReadPlanTool(store, 'task')
    const result = await tool.execute({ id: foreign.id }, context)
    expect(result.isError).toBe(true)
    expect(result.content).not.toContain('PRIVATE_OTHER_TASK_PLAN')
    expect(result.content).toContain('this task')
  })

  it('accepts no filesystem paths or invalid identifiers', async () => {
    const tool = createReadPlanTool(store, 'task')
    const invalidInputs: JSONValue[] = [{ path: '../../secret.md' }, { id: 42 }, { id: '' }, { id: 'x'.repeat(129) }, null]
    for (const input of invalidInputs) {
      expect((await tool.execute(input, context)).isError).toBe(true)
    }
    expect((await tool.execute({}, context)).content).toContain('No matching saved plan')
  })
})
