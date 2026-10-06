import type { ExecutableTool, JSONValue, ToolExecutionContext, ToolResult } from '@core/types'

export interface AskQuestion {
  question: string
  options: Array<{ label: string; description?: string }>
  multiSelect?: boolean
  allowOther?: boolean
}

/**
 * `ask_user_question` — a structured human-in-the-loop tool. The model poses one
 * multiple-choice question and blocks until the user answers (or dismisses it).
 * Not a mutation, so it runs without a permission prompt; the harness surfaces a
 * choice card and feeds the selection back as the tool result.
 */
export function createAskUserTool(
  ask: (q: AskQuestion, signal?: AbortSignal) => Promise<string[]>
): ExecutableTool {
  return {
    definition: {
      name: 'ask_user_question',
      description:
        'Ask the user ONE multiple-choice question when you hit a decision you cannot make yourself — a ' +
        'preference, an ambiguous requirement, or a fork in the approach. Give 2–4 concrete options (each a ' +
        'short label, optional description). Only use it when the answer materially changes what you do next; ' +
        'otherwise pick a sensible default and keep going.',
      inputSchema: {
        type: 'object',
        properties: {
          question: { type: 'string', description: 'The question to ask.' },
          options: {
            type: 'array',
            description: '2–4 options.',
            items: {
              type: 'object',
              properties: {
                label: { type: 'string' },
                description: { type: 'string' }
              },
              required: ['label']
            }
          },
          multiSelect: { type: 'boolean', description: 'Allow selecting more than one (default false).' },
          allowOther: { type: 'boolean', description: 'Offer a free-text "Other" answer (default true).' }
        },
        required: ['question', 'options']
      }
    },
    defaultPermission: 'allow',
    async execute(input: JSONValue, ctx: ToolExecutionContext): Promise<ToolResult> {
      const o = (input ?? {}) as {
        question?: string
        options?: unknown
        multiSelect?: boolean
        allowOther?: boolean
      }
      const question = typeof o.question === 'string' ? o.question.trim() : ''
      if (!question) return { toolUseId: '', content: 'ask_user_question requires a "question".', isError: true }
      const options = Array.isArray(o.options)
        ? o.options
            .map((x) => {
              if (typeof x === 'string') return { label: x }
              const obj = (x ?? {}) as { label?: unknown; description?: unknown }
              const label = typeof obj.label === 'string' ? obj.label : ''
              return { label, ...(typeof obj.description === 'string' ? { description: obj.description } : {}) }
            })
            .filter((x) => x.label)
        : []
      if (options.length < 2) return { toolUseId: '', content: 'ask_user_question needs at least 2 options.', isError: true }
      const answers = await ask(
        { question, options, multiSelect: !!o.multiSelect, allowOther: o.allowOther !== false },
        ctx?.signal
      )
      if (!answers.length)
        return { toolUseId: '', content: 'The user dismissed the question without answering — proceed with your best judgment.' }
      return { toolUseId: '', content: `The user answered: ${answers.join('; ')}` }
    }
  }
}
