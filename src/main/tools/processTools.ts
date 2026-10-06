import type { ExecutableTool, JSONValue, ToolResult } from '@core/types'
import type { BackgroundTask } from '@shared/ipc'
import { ProcessManager } from '../processManager'

export interface ProcessToolsOptions {
  conversationId: string
  processManager: ProcessManager
  /** Tests force a platform; the tool schema must not offer what that platform cannot do. */
  platform?: NodeJS.Platform
}

/**
 * The exit code of a task that was stopped or timed out is whatever the kill produced, so it says nothing
 * about the command and is left out; for any other task it is the process's own result.
 */
function exitCodeOf(task: BackgroundTask): number | undefined {
  return task.status === 'killed' || task.status === 'timed_out' ? undefined : task.exitCode
}

export function createProcessTools(options: ProcessToolsOptions): ExecutableTool[] {
  const { conversationId, processManager } = options
  const windows = (options.platform ?? process.platform) === 'win32'

  const taskOutputTool: ExecutableTool = {
    definition: {
      name: 'task_output',
      description:
        'Read stdout/stderr from a running or completed background task. ' +
        'Optionally wait up to wait_ms for new output or exit.',
      inputSchema: {
        type: 'object',
        properties: {
          task_id: { type: 'string', description: 'The task ID (e.g. p_k3j9a2).' },
          wait_ms: { type: 'number', description: 'Max ms to wait for new output (0 to 30000).' },
          tail_bytes: { type: 'number', description: 'Max bytes from the tail of output to return (default 49152).' }
        },
        required: ['task_id']
      }
    },
    defaultPermission: 'allow',
    async execute(input: JSONValue): Promise<ToolResult> {
      if (!input || typeof input !== 'object' || Array.isArray(input)) {
        return { toolUseId: '', content: 'task_output requires an object with a "task_id".', isError: true }
      }
      const { task_id, wait_ms, tail_bytes } = input as { task_id?: string; wait_ms?: number; tail_bytes?: number }
      if (!task_id || typeof task_id !== 'string') {
        return { toolUseId: '', content: 'task_output requires a valid "task_id".', isError: true }
      }
      try {
        const { text, task } = await processManager.getOutput(task_id, wait_ms, tail_bytes)
        const code = exitCodeOf(task)
        const exitNote = code !== undefined ? `, exit code ${code}` : ''
        const readyNote = task.readyHint ? `\nReady: ${task.readyHint.line}` : ''
        const header = `Task ${task.id} (${task.status}${exitNote}):${readyNote}\n---`
        const content = `${header}\n${text || '(no output)'}`
        return {
          toolUseId: '',
          content,
          isError: task.status === 'failed',
          metadata: { taskId: task.id, commandOutputId: task.outputId }
        }
      } catch (err) {
        return { toolUseId: '', content: `Failed to get output: ${err instanceof Error ? err.message : String(err)}`, isError: true }
      }
    }
  }

  const taskInputTool: ExecutableTool = {
    definition: {
      name: 'task_input',
      description: windows
        ? 'Send a line of standard input text to a running background task. A task on Windows runs on a pipe with no ' +
          'console, so Ctrl+C cannot reach it and there is no interrupt: use task_stop to end it.'
        : 'Send a line of standard input text to a running background task, or interrupt it (SIGINT to its process ' +
          'group, like Ctrl+C) with interrupt: true.',
      inputSchema: {
        type: 'object',
        properties: {
          task_id: { type: 'string', description: 'The task ID to send input to.' },
          text: { type: 'string', description: 'Text line to send to stdin.' },
          ...(windows ? {} : { interrupt: { type: 'boolean', description: 'Send an interrupt signal (Ctrl+C) to the process.' } })
        },
        required: ['task_id']
      }
    },
    defaultPermission: 'ask',
    async execute(input: JSONValue): Promise<ToolResult> {
      if (!input || typeof input !== 'object' || Array.isArray(input)) {
        return { toolUseId: '', content: 'task_input requires an object with "task_id".', isError: true }
      }
      const { task_id, text, interrupt } = input as { task_id?: string; text?: string; interrupt?: boolean }
      if (!task_id || typeof task_id !== 'string') {
        return { toolUseId: '', content: 'task_input requires a valid "task_id".', isError: true }
      }
      if (text === undefined && !interrupt) {
        return {
          toolUseId: '',
          content: windows ? 'task_input requires "text".' : 'task_input requires either "text" or "interrupt: true".',
          isError: true
        }
      }
      const res = await processManager.sendInput(task_id, text, interrupt)
      if (!res.ok) {
        return { toolUseId: '', content: `Failed to send input: ${res.error}`, isError: true }
      }
      // Name what actually happened: an interrupt and a write are separate acts.
      const done: string[] = []
      if (interrupt) done.push('Interrupt sent')
      if (text !== undefined && text.length > 0) done.push('Input sent')
      return {
        toolUseId: '',
        content: `${done.join(' and ')} to task ${task_id}.`,
        isError: false,
        metadata: { taskId: task_id }
      }
    }
  }

  const taskStopTool: ExecutableTool = {
    definition: {
      name: 'task_stop',
      description:
        'Stop a running background task by ending its process and every child process (a forced kill: the task gets ' +
        'no chance to clean up).',
      inputSchema: {
        type: 'object',
        properties: {
          task_id: { type: 'string', description: 'The task ID to stop.' }
        },
        required: ['task_id']
      }
    },
    defaultPermission: 'allow',
    async execute(input: JSONValue): Promise<ToolResult> {
      if (!input || typeof input !== 'object' || Array.isArray(input)) {
        return { toolUseId: '', content: 'task_stop requires an object with "task_id".', isError: true }
      }
      const { task_id } = input as { task_id?: string }
      if (!task_id || typeof task_id !== 'string') {
        return { toolUseId: '', content: 'task_stop requires a valid "task_id".', isError: true }
      }
      const res = await processManager.stop(task_id)
      if (!res.ok) {
        return { toolUseId: '', content: `Failed to stop task: ${res.error}`, isError: true }
      }
      // A stop can succeed with a warning (a descendant that would not die); the model must hear it.
      const warning = res.error ? `\nTermination warning: ${res.error}` : ''
      return {
        toolUseId: '',
        content: `Task ${task_id} has been stopped.${warning}`,
        isError: false,
        metadata: { taskId: task_id }
      }
    }
  }

  const taskListTool: ExecutableTool = {
    definition: {
      name: 'task_list',
      description: 'List background tasks that are running or completed in this conversation.',
      inputSchema: {
        type: 'object',
        properties: {}
      }
    },
    defaultPermission: 'allow',
    async execute(): Promise<ToolResult> {
      const tasks = processManager.list(conversationId)
      if (tasks.length === 0) {
        return { toolUseId: '', content: 'No background tasks found for this session.', isError: false }
      }
      const lines = tasks.map((t) => {
        const code = exitCodeOf(t)
        const exitNote = code !== undefined ? `, exit ${code}` : ''
        const readyNote = t.readyHint ? ` (ready on ${t.readyHint.port ?? t.readyHint.url})` : ''
        return `- ${t.id}: "${t.command}" [${t.status}${exitNote}]${readyNote}`
      })
      return {
        toolUseId: '',
        content: `Background tasks (${tasks.length}):\n${lines.join('\n')}`,
        isError: false
      }
    }
  }

  return [taskOutputTool, taskInputTool, taskStopTool, taskListTool]
}
