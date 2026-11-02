import { addHidden, mustPass, nodeTest, pass, scratchCopy } from '../../lib/checkKit.mjs'

const dir = scratchCopy()
addHidden(dir)
mustPass('node --test', nodeTest([], dir))
pass('toRoman and fromRoman satisfy the spec')
