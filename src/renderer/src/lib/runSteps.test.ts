import { describe, expect, it } from 'vitest'
import type { ToolActivity } from '../../../shared/ipc'
import type { LiveMessage } from '../state/store'
import { deriveRunSteps } from './runSteps'

const tool = (patch: Partial<ToolActivity> & Pick<ToolActivity, 'id' | 'name'>): ToolActivity => ({ phase: 'done', ...patch })
const user: LiveMessage = { id: 'u', role: 'user', text: 'go', createdAt: 1 }
const assistant = (toolCalls: ToolActivity[]): LiveMessage => ({
  id: 'a', role: 'assistant', text: '', createdAt: 2, toolCalls, blocks: toolCalls.map((t) => ({ type: 'tool' as const, tool: t }))
})

describe('deriveRunSteps', () => {
  it('folds reads into one step and lists each edited file', () => {
    const steps = deriveRunSteps([user, assistant([
      tool({ id: '1', name: 'read_file', title: 'Read a.ts' }),
      tool({ id: '2', name: 'read_file', title: 'Read b.ts' }),
      tool({ id: '3', name: 'edit_file', title: 'Edit src/a.ts', added: 2, removed: 1 })
    ])])
    expect(steps.map((s) => s.label)).toEqual(['Read 2 files', 'Edited a.ts'])
    expect(steps.every((s) => s.state === 'done')).toBe(true)
  })

  it('marks the call that waits for the person', () => {
    const steps = deriveRunSteps([user, assistant([tool({ id: '1', name: 'run_command', title: 'Run npm test', phase: 'running' })])], { tool: 'run_command' })
    expect(steps).toEqual([{ key: 'command:1', label: 'Run npm test', state: 'waiting' }])
  })

  it('ignores earlier turns', () => {
    const steps = deriveRunSteps([user, assistant([tool({ id: '1', name: 'read_file', title: 'Read a.ts' })]), { ...user, id: 'u2' }])
    expect(steps).toEqual([])
  })
})
