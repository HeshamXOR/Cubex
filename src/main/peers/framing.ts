import { roleIsReadOnly, type DelegateRole } from '@shared/peers'
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

/**
 * What a session that was already told the protocol is sent for its next message: the message, and a reminder of the
 * one thing that has to come out the same every time, the verdict line.
 */
export function consultFollowUp(message: string): string {
  return `The agent's message:\n\n${message}\n\nAnswer as before, and end with the verdict line.`
}

/** The newest part of the talk that fits, so a long history never pushes the message past what can be sent at once. */
export function fitPrompt(history: readonly Exchange[], message: string, readsProject: boolean, limit: number): string | undefined {
  let kept = [...history]
  for (;;) {
    const prompt = consultPrompt(kept, message, readsProject)
    if (prompt.length <= limit) return prompt
    if (kept.length === 0) return undefined
    kept = kept.slice(1)
  }
}

// --- Delegated tasks ------------------------------------------------------------

const ROLE_LINE: Record<DelegateRole, string> = {
  implement: 'Carry out the task: make the changes it asks for in the project, and check that they work.',
  research: 'Research the task: read the project and report what you find.',
  review: 'Review what the task points at: read it and report what is wrong, risky or missing, with the file and the line.',
  test: 'Run the tests or checks the task names, and report what they showed.'
}

/**
 * What an agent is told when it is handed a task. The agent starts with nothing else: it has not seen the conversation, and
 * what is not in the task, the model that wrote it did not think to say. The last paragraph asks for a report that can be
 * read at a glance, because the model that handed the task over has to check it before anyone is told it is done.
 */
export function delegationPrompt(role: DelegateRole, task: string): string {
  const readOnly = roleIsReadOnly(role)
  return [
    'You have been handed a task by another AI agent that is working for a person. The current folder is the person\'s project. You cannot see that agent\'s conversation, and it cannot see your work until you report: everything you need is in the task below.',
    ROLE_LINE[role],
    readOnly
      ? 'Do not edit, create, delete or move any file, and do not run a command that changes anything. You are here to look and report.'
      : 'Work in this folder only, and make only the changes the task needs. Do not commit, push, install anything outside the project or change git settings unless the task says to. Some of what you try may be refused by the person: take a refusal as an answer, and say what you could not do. If something blocks you, say what and stop instead of guessing.',
    'When you are done, finish with a short report: what you did, which files you changed, what you ran and what it showed, and anything you did not finish or are unsure about. Under 400 words.',
    `The task:\n\n${task}`
  ].join('\n\n')
}
