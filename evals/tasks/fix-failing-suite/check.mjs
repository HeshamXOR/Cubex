import { addHidden, expect, answer, mustPass, nodeTest, pass, scratchCopy, unchanged } from '../../lib/checkKit.mjs'

unchanged('test/text.test.mjs')
unchanged('test/list.test.mjs')
const dir = scratchCopy()
addHidden(dir)
mustPass('node --test', nodeTest([], dir))
expect(answer.trim().length > 0, 'the agent was asked to say what was wrong and said nothing')
pass('all tests pass, the existing tests are untouched, and the agent reported')
