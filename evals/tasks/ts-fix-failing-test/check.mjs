import { addHidden, mustPass, nodeTest, pass, scratchCopy, unchanged } from '../../lib/checkKit.mjs'

unchanged('test/cart.test.ts')
const dir = scratchCopy()
addHidden(dir)
mustPass('node --test', nodeTest([], dir))
pass('the cart tests and the hidden ones pass, and the existing tests are untouched')
