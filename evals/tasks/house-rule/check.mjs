import { expect, mustPass, nodeTest, pass, read, unchanged } from '../../lib/checkKit.mjs'

unchanged('test/fees.test.mjs')
mustPass('node --test', nodeTest())
const first = read('docs/CHANGES.txt').split(/\r?\n/).find((line) => line.trim())
expect(/^FIX: \S/.test(first ?? ''), `the newest line of docs/CHANGES.txt is ${JSON.stringify(first)}, not a FIX: line`)
pass('the bug is fixed and the change is recorded as the project memory says')
