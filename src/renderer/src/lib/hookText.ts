import { HOOK_EVENT_INFO, HOOK_TIMEOUT_MS, matcherTerms, type HookEvent, type HookTestResult } from '../../../shared/policy'

/**
 * Words for hooks on the Settings page: when one runs, and what a test of it means. Cubex only treats
 * exit code 2, or a printed block decision, from a PreToolUse hook (stop the tool), a UserPromptSubmit hook
 * (stop the turn) or a Stop hook (keep the agent working) as a block; every other result lets the work go on. A guard that crashes with exit 1
 * therefore guards nothing, which is the thing a test has to make plain.
 */

export interface TextPart {
  text: string
  code?: boolean
}

/** "Before a tool matching write_file or edit_file runs": when a hook fires, with the matcher terms set as code. */
export function describeHookTrigger(event: HookEvent, matcher: string | undefined): TextPart[] {
  if (event === 'UserPromptSubmit') return [{ text: 'When you send a message' }]
  if (event === 'Stop') return [{ text: 'When a turn ends' }]
  if (event === 'SessionStart') return [{ text: 'On the first turn of a conversation in this run of Cubex' }]
  if (event === 'PreCompact') return [{ text: 'Before older turns are summarized' }]
  if (event === 'PostCompact') return [{ text: 'After older turns are summarized' }]
  if (event === 'SubagentStop') return [{ text: 'After a subagent finishes' }]
  if (event === 'Notification') return [{ text: 'When Cubex waits for a permission or an answer' }]
  const when = event === 'PreToolUse' ? 'Before' : 'After'
  const terms = matcherTerms(matcher)
  if (terms.length === 0) return [{ text: `${when} any tool runs` }]
  const parts: TextPart[] = [{ text: `${when} a tool matching ` }]
  terms.forEach((term, index) => {
    if (index > 0) parts.push({ text: index === terms.length - 1 ? ' or ' : ', ' })
    parts.push({ text: term, code: true })
  })
  parts.push({ text: ' runs' })
  return parts
}

interface HookTestVerdict {
  /** The edge color: ok is a clean run, warn needs a look, error did not run at all. */
  tone: 'ok' | 'warn' | 'error'
  title: string
  body: string
}

const BLOCK_RULE = 'Only exit code 2, or a printed {"decision":"block"}, stops a tool.'
const STOP_RULE = 'Only exit code 2, or a printed {"decision":"block"}, keeps the agent working.'
const PROMPT_RULE = 'Only exit code 2, or a printed {"decision":"block"}, stops the message.'

export function explainHookTest(result: HookTestResult): HookTestVerdict {
  const info = HOOK_EVENT_INFO[result.event]
  const seconds = HOOK_TIMEOUT_MS / 1000
  const atStop = result.event === 'Stop'
  const atPrompt = result.event === 'UserPromptSubmit'
  if (result.outcome === 'failed-to-start') {
    return { tone: 'error', title: 'The hook did not start', body: result.startError ?? 'The shell could not start the command.' }
  }
  if (result.outcome === 'timed-out') {
    return {
      tone: 'warn',
      title: 'The hook timed out',
      body: `It was stopped after ${seconds} seconds. A hook that times out never blocks anything, so ${atStop ? 'the turn would end' : atPrompt ? 'the message would be sent' : info.canBlock ? 'the tool would still run' : 'the session would carry on'}.`
    }
  }
  if (result.decision === 'blocked') {
    if (atPrompt) return { tone: 'warn', title: 'Blocked', body: 'This hook would stop the turn before anything is sent to the model. Its reason is shown as the error.' }
    return atStop
      ? { tone: 'warn', title: 'Asks for more work', body: 'This hook would keep the agent working. Its message goes back to the agent as the next instruction.' }
      : { tone: 'warn', title: 'Blocked', body: 'This hook would stop the tool from running.' }
  }
  if (result.blockIgnored) {
    return { tone: 'warn', title: 'Ran, and asked to block', body: `${result.event} hooks cannot block anything, so Cubex ignores the request.` }
  }
  if (result.exitCode === 0) {
    if (atStop) return { tone: 'ok', title: 'Allowed', body: 'The hook exited with code 0, so the turn would end.' }
    if (atPrompt) return { tone: 'ok', title: 'Allowed', body: 'The hook exited with code 0, so the message would be sent.' }
    return info.canBlock
      ? { tone: 'ok', title: 'Allowed', body: 'The hook exited with code 0, so the tool would run.' }
      : { tone: 'ok', title: 'Ran without errors', body: `${result.event} hooks cannot block anything, so this only shows that the command works.` }
  }
  const code = result.exitCode === null ? 'no exit code' : `exit code ${result.exitCode}`
  if (atStop) return { tone: 'warn', title: 'Allowed, but the hook failed', body: `It ended with ${code}, which is not a block, so the turn would end. ${STOP_RULE}` }
  if (atPrompt) return { tone: 'warn', title: 'Allowed, but the hook failed', body: `It ended with ${code}, which is not a block, so the message would be sent. ${PROMPT_RULE}` }
  return info.canBlock
    ? { tone: 'warn', title: 'Allowed, but the hook failed', body: `It ended with ${code}, which is not a block, so the tool would still run. ${BLOCK_RULE}` }
    : { tone: 'warn', title: 'The hook failed', body: `It ended with ${code}. Cubex ignores the result of ${result.event} hooks.` }
}

/** Where the test ran, as a label next to its path. */
export function folderLabel(result: Pick<HookTestResult, 'cwdKind'>): string {
  return result.cwdKind === 'project' ? 'Project folder' : 'Empty temporary folder'
}
