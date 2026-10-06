import { HOOK_EVENT_INFO, HOOK_TIMEOUT_MS, matcherTerms, type HookEvent, type HookTestResult } from '../../../shared/policy'

/**
 * Words for hooks on the Settings page: when one runs, and what a test of it means. Cubex only treats
 * exit code 2, or a printed block decision, from a PreToolUse hook as "stop"; every other result lets
 * the work go on. A guard that crashes with exit 1 therefore guards nothing, which is the thing a test
 * has to make plain.
 */

export interface TextPart {
  text: string
  code?: boolean
}

/** "Before a tool matching write_file or edit_file runs": when a hook fires, with the matcher terms set as code. */
export function describeHookTrigger(event: HookEvent, matcher: string | undefined): TextPart[] {
  if (event === 'UserPromptSubmit') return [{ text: 'When you send a message' }]
  if (event === 'Stop') return [{ text: 'When a turn ends' }]
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

export function explainHookTest(result: HookTestResult): HookTestVerdict {
  const info = HOOK_EVENT_INFO[result.event]
  const seconds = HOOK_TIMEOUT_MS / 1000
  if (result.outcome === 'failed-to-start') {
    return { tone: 'error', title: 'The hook did not start', body: result.startError ?? 'The shell could not start the command.' }
  }
  if (result.outcome === 'timed-out') {
    return {
      tone: 'warn',
      title: 'The hook timed out',
      body: `It was stopped after ${seconds} seconds. A hook that times out never blocks anything, so ${info.canBlock ? 'the tool would still run' : 'the session would carry on'}.`
    }
  }
  if (result.decision === 'blocked') {
    return { tone: 'warn', title: 'Blocked', body: 'This hook would stop the tool from running.' }
  }
  if (result.blockIgnored) {
    return { tone: 'warn', title: 'Ran, and asked to block', body: `${result.event} hooks cannot block anything, so Cubex ignores the request.` }
  }
  if (result.exitCode === 0) {
    return info.canBlock
      ? { tone: 'ok', title: 'Allowed', body: 'The hook exited with code 0, so the tool would run.' }
      : { tone: 'ok', title: 'Ran without errors', body: `${result.event} hooks cannot block anything, so this only shows that the command works.` }
  }
  const code = result.exitCode === null ? 'no exit code' : `exit code ${result.exitCode}`
  return info.canBlock
    ? { tone: 'warn', title: 'Allowed, but the hook failed', body: `It ended with ${code}, which is not a block, so the tool would still run. ${BLOCK_RULE}` }
    : { tone: 'warn', title: 'The hook failed', body: `It ended with ${code}. Cubex ignores the result of ${result.event} hooks.` }
}

/** Where the test ran, as a label next to its path. */
export function folderLabel(result: Pick<HookTestResult, 'cwdKind'>): string {
  return result.cwdKind === 'project' ? 'Project folder' : 'Empty temporary folder'
}
