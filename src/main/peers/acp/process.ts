import type { ChildProcess } from 'node:child_process'
import type { Readable, Writable } from 'node:stream'
import { terminateShellTree, terminateShellTreeSync } from '../../tools/shellProcess'

/**
 * What an agent session needs of the thing it talks to: three streams, a way to hear that it ended, and a way to stop it.
 * Most agents are a program Cubex starts and talks to over its standard input and output. A few are Cubex's own bridge to
 * a program that does not speak the Agent Client Protocol itself; the bridge answers on the same kind of streams, so
 * everything above it (the policy, the modes, the cards) is the same for both.
 */
export interface AcpProcess {
  readonly stdin: Writable | null
  readonly stdout: Readable | null
  readonly stderr: Readable | null
  /** It could not be started, or broke: the error says why. */
  once(event: 'error', listener: (error: NodeJS.ErrnoException) => void): unknown
  /** It ended. `code` is how, when it was a program. */
  once(event: 'close', listener: (code: number | null) => void): unknown
  /** Stop it and what it started. `sync` waits for that to be done, for when the app is quitting. */
  stop(sync: boolean): void
}

/** A program Cubex started, as an agent's process. */
export function fromChild(child: ChildProcess): AcpProcess {
  return {
    stdin: child.stdin,
    stdout: child.stdout,
    stderr: child.stderr,
    once: (event: 'error' | 'close', listener: (...args: never[]) => void) => child.once(event, listener as (...args: unknown[]) => void),
    stop: (sync) => {
      if (sync) terminateShellTreeSync(child)
      else void terminateShellTree(child)
    }
  } as AcpProcess
}

export type ProcessOutcome = { kind: 'error'; error: NodeJS.ErrnoException } | { kind: 'close'; code: number | null }

/**
 * A process that is Cubex's own making, as an agent's process: the three streams, and how to hear that it ended. What the
 * client asks for after the end is answered at once from what is remembered, so a client that starts listening a moment late,
 * as one does when the process failed to start, is not left without an answer or given an error nobody catches.
 */
export function latchedProcess(
  streams: { stdin: Writable; stdout: Readable; stderr: Readable },
  stop: (sync: boolean) => void
): { process: AcpProcess; settle: (outcome: ProcessOutcome) => void } {
  let outcome: ProcessOutcome | undefined
  const errorListeners: Array<(error: NodeJS.ErrnoException) => void> = []
  const closeListeners: Array<(code: number | null) => void> = []
  const facade: AcpProcess = {
    ...streams,
    once: ((event: 'error' | 'close', listener: (arg: never) => void) => {
      if (event === 'error') {
        if (outcome?.kind === 'error') {
          const { error } = outcome
          queueMicrotask(() => (listener as (error: NodeJS.ErrnoException) => void)(error))
        } else {
          errorListeners.push(listener as (error: NodeJS.ErrnoException) => void)
        }
      } else if (outcome?.kind === 'close') {
        const { code } = outcome
        queueMicrotask(() => (listener as (code: number | null) => void)(code))
      } else {
        closeListeners.push(listener as (code: number | null) => void)
      }
    }) as AcpProcess['once'],
    stop
  }
  return {
    process: facade,
    settle(next) {
      if (outcome) return
      outcome = next
      if (next.kind === 'error') for (const listener of errorListeners.splice(0)) listener(next.error)
      else for (const listener of closeListeners.splice(0)) listener(next.code)
    }
  }
}

/**
 * Closes the side of a process that the client reads, and then tells the client the process ended. The answer to a message that
 * failed is written a moment after it fails, so this waits a moment before it closes: the client reads what is still queued, the
 * failure included, and then hears that the process is over.
 */
export function finishOutput(output: Writable, outcome: ProcessOutcome, settle: (outcome: ProcessOutcome) => void): void {
  setImmediate(() => {
    if (outcome.kind === 'error') {
      output.end()
      settle(outcome)
      return
    }
    const done = (): void => settle(outcome)
    output.once('end', done)
    output.end()
    setTimeout(done, 250).unref?.()
  })
}
