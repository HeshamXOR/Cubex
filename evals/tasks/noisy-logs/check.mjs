import { mustPass, nodeTest, pass, scratchCopy, unchanged } from '../../lib/checkKit.mjs'

for (const file of ['test/cart.test.mjs', 'test/tax.test.mjs', 'test/total.test.mjs']) unchanged(file)
mustPass('node --test', nodeTest([], scratchCopy()))
pass('the whole suite passes and the tests are untouched')
