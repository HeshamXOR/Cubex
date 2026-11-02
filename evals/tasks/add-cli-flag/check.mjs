import { expect, pass, put, run, scratchCopy } from '../../lib/checkKit.mjs'

const dir = scratchCopy()
put('sample.txt', ['Error: disk full', 'ok', 'error: retrying', 'warning', 'ERROR again', 'done', ''].join('\n'), dir)
const cli = (...args) => run(process.execPath, ['bin/grep-lite.mjs', ...args], { cwd: dir })

const plain = cli('error', 'sample.txt')
expect(plain.stdout.trim() === 'error: retrying', `plain search changed: ${JSON.stringify(plain.stdout)}`)
expect(plain.status === 0, 'plain search should exit 0')

const ignoring = cli('-i', 'error', 'sample.txt')
expect(ignoring.stdout.trim().split(/\r?\n/).length === 3, `-i search changed: ${JSON.stringify(ignoring.stdout)}`)

for (const flag of ['-c', '--count']) {
  const counted = cli(flag, 'error', 'sample.txt')
  expect(counted.stdout.trim() === '1', `${flag} printed ${JSON.stringify(counted.stdout)}, expected 1`)
  expect(counted.status === 0, `${flag} should exit 0 when something matched`)
  const both = cli(flag, '-i', 'error', 'sample.txt')
  expect(both.stdout.trim() === '3', `${flag} -i printed ${JSON.stringify(both.stdout)}, expected 3`)
  const flipped = cli('-i', flag, 'error', 'sample.txt')
  expect(flipped.stdout.trim() === '3', `-i ${flag} printed ${JSON.stringify(flipped.stdout)}, expected 3`)
  const none = cli(flag, 'nothing-like-this', 'sample.txt')
  expect(none.stdout.trim() === '0', `${flag} with no match printed ${JSON.stringify(none.stdout)}, expected 0`)
  expect(none.status === 1, `${flag} with no match should exit 1, exited ${none.status}`)
}

const usage = cli()
expect(usage.status === 2, 'no arguments should still exit 2')
expect(/--count|-c\b/.test(usage.stderr), `the usage text does not mention the flag: ${JSON.stringify(usage.stderr)}`)
const unknown = cli('--nope', 'x', 'sample.txt')
expect(unknown.status === 2, 'an unknown option should still exit 2')
pass('-c and --count work alone and with -i, exit codes are kept, usage mentions the flag')
