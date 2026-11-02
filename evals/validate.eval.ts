import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { runCheck } from './lib/check'
import { loadTasks } from './lib/tasks'
import { applySolution, copyFixture, hasProgram } from './lib/workspace'
import { removeFolder } from '../src/main/testing/removeFolder'

/**
 * Proves every task can be judged: its check must FAIL on the untouched fixture (nothing to credit a lazy agent
 * for) and PASS once the reference solution is in place. No model and no network. Run it after adding a task:
 *   npm run eval:validate
 */
const tasks = loadTasks()

describe.each(tasks.map((task) => [task.slug, task] as const))('task %s', (_slug, task) => {
  const runnable = task.requires.every(hasProgram)
  it.skipIf(!runnable)('fails on the fixture and passes with the reference solution', async () => {
    const root = mkdtempSync(join(tmpdir(), `cubex-validate-${task.slug}-`))
    try {
      const untouched = join(root, 'untouched')
      copyFixture(task, untouched)
      const before = await runCheck(task, untouched, '', join(root, 'scratch-a'))
      expect(before.passed, `the check passes without any work:\n${before.output}`).toBe(false)

      const solved = join(root, 'solved')
      copyFixture(task, solved)
      applySolution(task, solved)
      const after = await runCheck(task, solved, task.stub.answer ?? 'Done.', join(root, 'scratch-b'))
      expect(after.passed, `the check fails on the reference solution:\n${after.output}`).toBe(true)
    } finally {
      await removeFolder(root)
    }
  }, 180_000)
})
