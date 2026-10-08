import type { Exchange } from './transcript'

/**
 * What another agent is told about the talk it has been pulled into. The same words are the system prompt of a model
 * and the top of the text a program receives, so every kind of agent is asked for the same thing: an honest view with
 * reasons, in a form that ends in a verdict the thread can show.
 */
export function consultProtocol(readsProject: boolean): string {
  return [
    readsProject
      ? 'You are being consulted by another AI agent that is working for a person on a task. The current folder holds the person\'s project, and you may read its files to check facts. You cannot see the agent\'s conversation unless the message includes it, and it cannot see yours.'
      : 'You are being consulted by another AI agent that is working for a person on a task. You cannot see the agent\'s conversation or the person\'s files unless the message includes them, and it cannot see yours.',
    'Give your own assessment, with reasons. If you disagree, say where and what you would do instead. Be concrete and brief: under 400 words unless the question needs more.',
    'This is a text conversation. Do not edit files, run commands or change anything.',
    'End with one last line that says exactly one of: "Verdict: agree", "Verdict: partly agree" or "Verdict: disagree".'
  ].join('\n')
}

function transcript(history: readonly Exchange[]): string {
  return history.map((entry) => `Agent: ${entry.message}\n\nYou: ${entry.reply}`).join('\n\n')
}

/** The whole text a program is given: the protocol, what was said before, and the new message. */
export function consultPrompt(history: readonly Exchange[], message: string, readsProject: boolean): string {
  return [
    consultProtocol(readsProject),
    ...(history.length > 0 ? [`Earlier in this conversation, oldest first:\n\n${transcript(history)}`] : []),
    `The agent's message:\n\n${message}`
  ].join('\n\n')
}
