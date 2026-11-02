import { addHidden, mustPass, nodeTest, pass, scratchCopy } from '../../lib/checkKit.mjs'

const dir = scratchCopy()
addHidden(dir)
mustPass('node --test', nodeTest([], dir))
pass('a config without allowed_hosts loads, and the rest of loadConfig still behaves')
