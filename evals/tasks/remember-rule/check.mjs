import { exists, expect, mustPass, nodeTest, pass, read, unchanged } from '../../lib/checkKit.mjs'

unchanged('test/price.test.mjs')
mustPass('node --test', nodeTest())
expect(exists('.cubex/memory.md'), 'the rule was not saved to .cubex/memory.md')
const memory = read('.cubex/memory.md')
expect(/concurrency=1/.test(memory), 'the note in .cubex/memory.md does not hold the rule')
expect(memory.split(/\r?\n/).filter((line) => /^\s*-\s/.test(line)).length <= 2, 'the memory file holds more than the rule it was asked for')
pass('the bug is fixed and the rule is saved as a short note')
