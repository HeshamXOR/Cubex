import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createProcessTools } from './processTools'
import { ProcessManager, WINDOWS_INTERRUPT_UNSUPPORTED } from '../processManager'
import type { BackgroundTask } from '@shared/ipc'
import type { ToolExecutionContext } from '@core/types'

const ctx: ToolExecutionContext = { requestPermission: async () => ({ decision: 'allow' }) }

describe('processTools', () => {
  let mockProcessManager: ProcessManager
  let tools: ReturnType<typeof createProcessTools>
  const conversationId = 'conv-test-123'
  const workspace = 'I:/Cubex'

  beforeEach(() => {
    mockProcessManager = {
      getOutput: vi.fn(),
      sendInput: vi.fn(),
      stop: vi.fn(),
      list: vi.fn()
    } as unknown as ProcessManager

    tools = createProcessTools({
      conversationId,
      processManager: mockProcessManager,
      platform: 'linux'
    })
  })

  it('exposes the expected 4 process tools with correct permissions', () => {
    expect(tools.map((t) => t.definition.name)).toEqual([
      'task_output',
      'task_input',
      'task_stop',
      'task_list'
    ])

    const [outputTool, inputTool, stopTool, listTool] = tools
    expect(outputTool?.defaultPermission).toBe('allow')
    expect(inputTool?.defaultPermission).toBe('ask')
    expect(stopTool?.defaultPermission).toBe('allow')
    expect(listTool?.defaultPermission).toBe('allow')
  })

  describe('interrupt on each platform', () => {
    const inputSchema = (platform: NodeJS.Platform): { description: string; properties: Record<string, unknown> } => {
      const tool = createProcessTools({ conversationId, processManager: mockProcessManager, platform })
        .find((t) => t.definition.name === 'task_input')!
      return {
        description: tool.definition.description ?? '',
        properties: (tool.definition.inputSchema as { properties: Record<string, unknown> }).properties
      }
    }

    it('offers an interrupt on POSIX and says what it sends', () => {
      const { description, properties } = inputSchema('linux')
      expect(properties).toHaveProperty('interrupt')
      expect(description).toContain('SIGINT')
    })

    it('does not offer an interrupt on Windows, so the model never asks the user to approve one that cannot work', () => {
      const { description, properties } = inputSchema('win32')
      expect(properties).not.toHaveProperty('interrupt')
      expect(properties).toHaveProperty('text')
      expect(description).toContain('no interrupt')
      expect(description).toContain('task_stop')
    })

    it('asks for text alone on Windows', async () => {
      const windows = createProcessTools({ conversationId, processManager: mockProcessManager, platform: 'win32' })
      const res = await windows.find((t) => t.definition.name === 'task_input')!.execute({ task_id: 'p_1' }, ctx)
      expect(res.isError).toBe(true)
      expect(res.content).toBe('task_input requires "text".')
    })

    it('passes the plain refusal of an interrupt on to the model instead of reporting success', async () => {
      const windows = createProcessTools({ conversationId, processManager: mockProcessManager, platform: 'win32' })
      vi.mocked(mockProcessManager.sendInput).mockResolvedValue({ ok: false, error: WINDOWS_INTERRUPT_UNSUPPORTED })
      const res = await windows.find((t) => t.definition.name === 'task_input')!.execute({ task_id: 'p_1', interrupt: true }, ctx)
      expect(res.isError).toBe(true)
      expect(res.content).toContain('Nothing was sent')
      expect(res.content).toContain('task_stop')
      expect(res.content).not.toContain('Interrupt sent')
    })
  })

  describe('task_output', () => {
    it('validates task_id requirement', async () => {
      const outputTool = tools.find((t) => t.definition.name === 'task_output')!
      const res1 = await outputTool.execute({}, ctx)
      expect(res1.isError).toBe(true)
      expect(res1.content).toContain('task_id')

      const res2 = await outputTool.execute({ task_id: '' }, ctx)
      expect(res2.isError).toBe(true)
    })

    it('returns formatted output and readyHint when available', async () => {
      const outputTool = tools.find((t) => t.definition.name === 'task_output')!
      const fakeTask: BackgroundTask = {
        id: 'p_123',
        conversationId,
        command: 'npm run dev',
        shell: 'cmd',
        cwd: workspace,
        status: 'running',
        startedAt: 1000,
        outputId: 'out_1',
        readyHint: { line: 'VITE v5.0 ready in 300 ms', port: 5173 }
      }

      vi.mocked(mockProcessManager.getOutput).mockResolvedValue({
        text: 'Server running at http://localhost:5173',
        task: fakeTask
      })

      const res = await outputTool.execute({ task_id: 'p_123' }, ctx)
      expect(res.isError).toBe(false)
      expect(res.content).toContain('Task p_123 (running):')
      expect(res.content).toContain('Ready: VITE v5.0 ready in 300 ms')
      expect(res.content).toContain('Server running at http://localhost:5173')
      expect(res.metadata).toEqual({ taskId: 'p_123', commandOutputId: 'out_1' })
    })

    it('surfaces error if getOutput throws', async () => {
      const outputTool = tools.find((t) => t.definition.name === 'task_output')!
      vi.mocked(mockProcessManager.getOutput).mockRejectedValue(new Error('Task p_not_found not found.'))

      const res = await outputTool.execute({ task_id: 'p_not_found' }, ctx)
      expect(res.isError).toBe(true)
      expect(res.content).toContain('Task p_not_found not found')
    })
  })

  describe('task_input', () => {
    it('requires text or interrupt', async () => {
      const inputTool = tools.find((t) => t.definition.name === 'task_input')!
      const res = await inputTool.execute({ task_id: 'p_123' }, ctx)
      expect(res.isError).toBe(true)
      expect(res.content).toContain('either "text" or "interrupt: true"')
    })

    it('sends text input successfully', async () => {
      const inputTool = tools.find((t) => t.definition.name === 'task_input')!
      vi.mocked(mockProcessManager.sendInput).mockResolvedValue({ ok: true })

      const res = await inputTool.execute({ task_id: 'p_123', text: 'y' }, ctx)
      expect(res.isError).toBe(false)
      expect(res.content).toContain('Input sent to task p_123')
      expect(mockProcessManager.sendInput).toHaveBeenCalledWith('p_123', 'y', undefined)
    })

    it('sends interrupt signal', async () => {
      const inputTool = tools.find((t) => t.definition.name === 'task_input')!
      vi.mocked(mockProcessManager.sendInput).mockResolvedValue({ ok: true })

      const res = await inputTool.execute({ task_id: 'p_123', interrupt: true }, ctx)
      expect(res.isError).toBe(false)
      expect(res.content).toContain('Interrupt sent to task p_123')
      expect(mockProcessManager.sendInput).toHaveBeenCalledWith('p_123', undefined, true)
    })

    it('returns error if sendInput fails', async () => {
      const inputTool = tools.find((t) => t.definition.name === 'task_input')!
      vi.mocked(mockProcessManager.sendInput).mockResolvedValue({ ok: false, error: 'Stdin closed' })

      const res = await inputTool.execute({ task_id: 'p_123', text: 'hello' }, ctx)
      expect(res.isError).toBe(true)
      expect(res.content).toContain('Stdin closed')
    })
  })

  describe('task_stop', () => {
    it('validates task_id', async () => {
      const stopTool = tools.find((t) => t.definition.name === 'task_stop')!
      const res = await stopTool.execute({}, ctx)
      expect(res.isError).toBe(true)
    })

    it('stops task successfully', async () => {
      const stopTool = tools.find((t) => t.definition.name === 'task_stop')!
      vi.mocked(mockProcessManager.stop).mockResolvedValue({ ok: true })

      const res = await stopTool.execute({ task_id: 'p_123' }, ctx)
      expect(res.isError).toBe(false)
      expect(res.content).toContain('Task p_123 has been stopped')
    })

    it('returns error if stop fails', async () => {
      const stopTool = tools.find((t) => t.definition.name === 'task_stop')!
      vi.mocked(mockProcessManager.stop).mockResolvedValue({ ok: false, error: 'Access denied' })

      const res = await stopTool.execute({ task_id: 'p_123' }, ctx)
      expect(res.isError).toBe(true)
      expect(res.content).toContain('Access denied')
    })

    it('tells the model about a termination warning instead of reporting a clean stop', async () => {
      const stopTool = tools.find((t) => t.definition.name === 'task_stop')!
      vi.mocked(mockProcessManager.stop).mockResolvedValue({ ok: true, error: 'Process-tree termination exited with code 128.' })

      const res = await stopTool.execute({ task_id: 'p_123' }, ctx)
      expect(res.isError).toBe(false)
      expect(res.content).toContain('Task p_123 has been stopped.')
      expect(res.content).toContain('Termination warning: Process-tree termination exited with code 128.')
    })

    it('says the stop is a forced kill of the whole tree', () => {
      const stopTool = tools.find((t) => t.definition.name === 'task_stop')!
      expect(stopTool.definition.description).toContain('every child process')
      expect(stopTool.definition.description).toContain('forced kill')
    })
  })

  describe('exit codes of stopped tasks', () => {
    const task = (status: BackgroundTask['status'], exitCode?: number): BackgroundTask => ({
      id: 'p_9', conversationId, command: 'npm run dev', shell: 'cmd', cwd: workspace, status, startedAt: 1, outputId: 'o',
      ...(exitCode !== undefined ? { exitCode } : {})
    })

    it.each<[BackgroundTask['status']]>([['killed'], ['timed_out']])('leaves the kill\'s exit code out of a %s task', async (status) => {
      const listTool = tools.find((t) => t.definition.name === 'task_list')!
      vi.mocked(mockProcessManager.list).mockReturnValue([task(status, 1)])
      expect((await listTool.execute({}, ctx)).content).toContain(`[${status}]`)

      const outputTool = tools.find((t) => t.definition.name === 'task_output')!
      vi.mocked(mockProcessManager.getOutput).mockResolvedValue({ text: 'bye', task: task(status, 1) })
      const res = await outputTool.execute({ task_id: 'p_9' }, ctx)
      expect(res.content).toContain(`Task p_9 (${status}):`)
      expect(res.isError).toBe(false)
    })

    it('keeps the exit code of a task that ended by itself', async () => {
      const outputTool = tools.find((t) => t.definition.name === 'task_output')!
      vi.mocked(mockProcessManager.getOutput).mockResolvedValue({ text: 'boom', task: task('failed', 2) })
      const res = await outputTool.execute({ task_id: 'p_9' }, ctx)
      expect(res.content).toContain('Task p_9 (failed, exit code 2):')
      expect(res.isError).toBe(true)
    })
  })

  describe('task_list', () => {
    it('reports when no tasks exist', async () => {
      const listTool = tools.find((t) => t.definition.name === 'task_list')!
      vi.mocked(mockProcessManager.list).mockReturnValue([])

      const res = await listTool.execute({}, ctx)
      expect(res.isError).toBe(false)
      expect(res.content).toContain('No background tasks found')
      expect(mockProcessManager.list).toHaveBeenCalledWith(conversationId)
    })

    it('formats existing background tasks', async () => {
      const listTool = tools.find((t) => t.definition.name === 'task_list')!
      vi.mocked(mockProcessManager.list).mockReturnValue([
        {
          id: 'p_1',
          conversationId,
          command: 'npm run dev',
          shell: 'cmd',
          cwd: workspace,
          status: 'running',
          startedAt: 1000,
          outputId: 'out_1',
          readyHint: { line: 'ready', port: 5173 }
        },
        {
          id: 'p_2',
          conversationId,
          command: 'npm test',
          shell: 'cmd',
          cwd: workspace,
          status: 'exited',
          exitCode: 0,
          startedAt: 1000,
          endedAt: 2000,
          outputId: 'out_2'
        }
      ])

      const res = await listTool.execute({}, ctx)
      expect(res.isError).toBe(false)
      expect(res.content).toContain('Background tasks (2):')
      expect(res.content).toContain('- p_1: "npm run dev" [running] (ready on 5173)')
      expect(res.content).toContain('- p_2: "npm test" [exited, exit 0]')
    })
  })
})
