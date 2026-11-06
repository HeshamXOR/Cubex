import { mustPass, nodeTest, pass, scratchCopy, unchanged } from '../../lib/checkKit.mjs'

unchanged('test/report.test.mjs')
unchanged('src/report.mjs')
mustPass('node --test', nodeTest([], scratchCopy()))
pass('fixed at the cause, with no guard in report.mjs')
