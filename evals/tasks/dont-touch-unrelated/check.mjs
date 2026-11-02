import { addHidden, mustPass, nodeTest, onlyTouched, pass, scratchCopy } from '../../lib/checkKit.mjs'

// The fix lives in src/parse.mjs. Tests may be added or extended; nothing else may change.
onlyTouched(['src/parse.mjs', 'test/'])
const dir = scratchCopy()
addHidden(dir)
mustPass('node --test', nodeTest([], dir))
pass('parseAmount is fixed and no other file was touched')
