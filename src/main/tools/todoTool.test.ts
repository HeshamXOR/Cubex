import { describe, it, expect, vi } from 'vitest'
import { createTodoTool } from './todoTool'
import type { TodoItem } from '@shared/ipc'
import type { JSONValue, ToolExecutionContext } from '@core/types'

const ctx: ToolExecutionContext = { requestPermission: async () => ({ decision: 'allow' }) }

describe('todoTool', () => {
  it('normalizes and forwards a valid list, reporting progress', async () => {
    const seen: TodoItem[][] = []
    const tool = createTodoTool((t) => seen.push(t))
    const res = await tool.execute(
      {
        todos: [
          { content: 'A', status: 'completed' },
          { content: 'B', status: 'in_progress', activeForm: 'Doing B' },
          { content: 'C', status: 'pending' }
        ]
      } as unknown as JSONValue,
      ctx
    )
    expect(res.isError).toBeUndefined()
    expect(String(res.content)).toContain('1/3')
    expect(seen).toHaveLength(1)
    expect(seen[0]).toEqual([
      { content: 'A', status: 'completed' },
      { content: 'B', status: 'in_progress', activeForm: 'Doing B' },
      { content: 'C', status: 'pending' }
    ])
  })

  it('coerces unknown status to pending and drops empty items', async () => {
    const seen: TodoItem[][] = []
    const tool = createTodoTool((t) => seen.push(t))
    await tool.execute(
      { todos: [{ content: 'X', status: 'bogus' }, { content: '   ', status: 'pending' }] } as unknown as JSONValue,
      ctx
    )
    expect(seen[0]).toEqual([{ content: 'X', status: 'pending' }])
  })

  it('errors and does not emit when todos is not an array', async () => {
    const onUpdate = vi.fn()
    const tool = createTodoTool(onUpdate)
    const res = await tool.execute({ todos: 'nope' } as unknown as JSONValue, ctx)
    expect(res.isError).toBe(true)
    expect(onUpdate).not.toHaveBeenCalled()
  })

  it('is an allow-by-default (non-mutating) tool', () => {
    expect(createTodoTool(() => {}).defaultPermission).toBe('allow')
  })
})
