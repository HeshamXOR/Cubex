import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { CheckResult, TaskSpec } from './types'
import { fixtureDir } from './workspace'

const CHECK_TIMEOUT_MS = 120_000
const OUTPUT_LIMIT = 6_000

/**
 * Run a task's check against a workspace. The check sees the workspace path as its first argument and, in the
 * environment, the untouched fixture (CUBEX_EVAL_FIXTURE), its own task folder (CUBEX_EVAL_TASK_DIR, where hidden
 * tests live) and the agent's last words (CUBEX_EVAL_ANSWER, also written to the file named by CUBEX_EVAL_ANSWER_FILE,
 * the second argument). Exit 0 is a pass.
 */
export async function runCheck(task: TaskSpec, workspace: string, answer: string, scratch: string): Promise<CheckResult> {
  // Outside the workspace, so that writing it is not a change the agent made.
  mkdirSync(scratch, { recursive: true })
  const answerFile = join(scratch, 'answer.txt')
  writeFileSync(answerFile, answer)
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CUBEX_EVAL_WORKSPACE: workspace,
    CUBEX_EVAL_FIXTURE: fixtureDir(task),
    CUBEX_EVAL_TASK_DIR: task.dir,
    CUBEX_EVAL_ANSWER_FILE: answerFile,
    CUBEX_EVAL_ANSWER: answer.slice(0, 20_000),
    NO_COLOR: '1'
  }
  delete env.CUBEX_EVAL_API_KEY
  const command = task.check.kind === 'script' ? process.execPath : task.check.command
  const args = task.check.kind === 'script' ? [join(task.dir, task.check.file), workspace, answerFile] : []
  return new Promise<CheckResult>((resolve) => {
    let output = ''
    let timedOut = false
    const child = spawn(command, args, { cwd: workspace, env, shell: task.check.kind === 'command', windowsHide: true })
    const timer = setTimeout(() => { timedOut = true; child.kill() }, CHECK_TIMEOUT_MS)
    const collect = (chunk: Buffer): void => { if (output.length < OUTPUT_LIMIT * 4) output += chunk.toString('utf8') }
    child.stdout.on('data', collect)
    child.stderr.on('data', collect)
    child.on('error', (error) => {
      clearTimeout(timer)
      resolve({ passed: false, exitCode: null, output: `The check could not start: ${error.message}` })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      const text = output.trim()
      resolve({
        passed: code === 0 && !timedOut,
        exitCode: code,
        output: text.length > OUTPUT_LIMIT ? `${text.slice(0, OUTPUT_LIMIT / 2)}\n... [shortened] ...\n${text.slice(-OUTPUT_LIMIT / 2)}` : text,
        ...(timedOut ? { timedOut: true } : {})
      })
    })
  })
}
