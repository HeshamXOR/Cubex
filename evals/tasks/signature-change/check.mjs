import { mustPass, nodeTest, pass, scratchCopy, unchanged } from '../../lib/checkKit.mjs'

unchanged('test/all.test.mjs')
mustPass('node --test', nodeTest([], scratchCopy()))
pass('every caller follows the new signature')
