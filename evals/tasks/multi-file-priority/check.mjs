import { expect, mustPass, nodeTest, pass, put, read, run, scratchCopy } from '../../lib/checkKit.mjs'
import { join } from 'node:path'

const dir = scratchCopy()
const file = join(dir, 'todos-check.json')
// A file written by the earlier version: no priority anywhere.
put('todos-check.json', JSON.stringify([{ id: 1, text: 'old task', done: false }, { id: 2, text: 'older done', done: true }]), dir)
const cli = (...args) => run(process.execPath, ['src/cli.mjs', ...args], { cwd: dir, env: { TODO_FILE: file } })

const high = cli('add', '--priority', 'high', 'Pay', 'rent')
expect(high.status === 0 && /added 3/.test(high.stdout), `add --priority high failed: ${high.output}`)
expect(cli('add', '--priority', 'low', 'Water plants').status === 0, 'add --priority low failed')
expect(cli('add', 'Plain', 'thing').status === 0, 'add without a priority failed')
expect(cli('add', '--priority', 'normal', 'Explicit normal').status === 0, 'add --priority normal failed')

const before = read('todos-check.json', dir)
const bad = cli('add', '--priority', 'urgent', 'Nope')
expect(bad.status === 2, `an unknown priority should exit 2, exited ${bad.status}`)
expect(bad.stderr.trim().length > 0, 'an unknown priority should explain itself on stderr')
expect(read('todos-check.json', dir) === before, 'an unknown priority must not save anything')

const listed = cli('list').stdout.trim().split(/\r?\n/)
const want = ['[ ] 3 (high) Pay rent', '[ ] 1 (normal) old task', '[x] 2 (normal) older done', '[ ] 5 (normal) Plain thing', '[ ] 6 (normal) Explicit normal', '[ ] 4 (low) Water plants']
// Ids: old tasks 1 and 2, then 3 (high), 4 (low), 5 (plain), 6 (explicit normal).
expect(JSON.stringify(listed) === JSON.stringify(want), `list is wrong.\nexpected:\n${want.join('\n')}\ngot:\n${listed.join('\n')}`)

expect(cli('done', '3').status === 0, 'done still has to work')
expect(cli('list').stdout.split(/\r?\n/)[0] === '[x] 3 (high) Pay rent', 'done does not show after the change')
mustPass('node --test', nodeTest([], dir))
pass('priorities are saved, validated, sorted and shown, and old files still load')
