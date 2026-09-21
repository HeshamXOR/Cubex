import { nanoid } from 'nanoid'
import type { Conversation } from '@shared/ipc'
import { conversationRepo } from './db'

/** Export a conversation to JSON, Markdown, or plain text. */
export function exportConversation(id: string, format: 'json' | 'markdown' | 'txt'): string {
  const conv = conversationRepo.get(id)
  if (!conv) throw new Error('Conversation not found')

  if (format === 'json') return JSON.stringify(conv, null, 2)

  const lines: string[] = []
  const date = new Date(conv.createdAt).toISOString()
  if (format === 'markdown') {
    lines.push(`# ${conv.title}`, '')
    lines.push(`- **Created:** ${date}`)
    lines.push(`- **Model:** ${conv.model ?? 'n/a'} (${conv.execution})`, '')
    for (const m of conv.messages) {
      lines.push(`## ${cap(m.role)}`, '', m.text, '')
    }
  } else {
    lines.push(conv.title, date, '')
    for (const m of conv.messages) {
      lines.push(`[${m.role.toUpperCase()}]`, m.text, '')
    }
  }
  return lines.join('\n')
}

/** Import a conversation from an exported JSON document (assigns a fresh id). */
export function importConversation(data: string): Conversation {
  const parsed = JSON.parse(data) as Partial<Conversation>
  const now = Date.now()
  const conv: Conversation = {
    id: nanoid(),
    title: parsed.title ?? 'Imported conversation',
    createdAt: parsed.createdAt ?? now,
    updatedAt: now,
    execution: parsed.execution ?? 'cloud',
    messages: (parsed.messages ?? []).map((m) => ({ ...m, id: m.id ?? nanoid() })),
    ...(parsed.providerId ? { providerId: parsed.providerId } : {}),
    ...(parsed.model ? { model: parsed.model } : {})
  }
  conversationRepo.create(conv)
  return conv
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}
