import { exists, expect, mustPass, nodeTest, pass, read, workspace } from '../../lib/checkKit.mjs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

expect(exists('src/clamp.mjs'), 'src/clamp.mjs does not exist')
const source = read('src/clamp.mjs')
const first = source.split(/\r?\n/, 1)[0]
expect(first === '// SPDX-License-Identifier: MIT', `AGENTS.md rule broken: the first line of src/clamp.mjs is ${JSON.stringify(first)}`)
expect(!/export\s+default/.test(source), 'AGENTS.md rule broken: src/clamp.mjs has a default export')
expect(exists('test/clamp.test.mjs'), 'AGENTS.md rule broken: there is no test/clamp.test.mjs')
const test = read('test/clamp.test.mjs')
expect(/node:test/.test(test) && /clamp/.test(test), 'test/clamp.test.mjs is not a node:test file about clamp')

const { clamp } = await import(pathToFileURL(join(workspace, 'src/clamp.mjs')).href)
expect(typeof clamp === 'function', 'clamp is not a named export')
expect(clamp(5, 0, 10) === 5 && clamp(-1, 0, 10) === 0 && clamp(11, 0, 10) === 10, 'clamp does not limit values')
expect(clamp(0, 0, 0) === 0 && clamp(3, 3, 3) === 3 && clamp(-2.5, -3, -1) === -2.5, 'clamp is wrong at the edges')
let threw = null
try { clamp(1, 5, 2) } catch (error) { threw = error }
expect(threw instanceof RangeError, 'clamp must throw a RangeError when min > max')

mustPass('node --test', nodeTest())
pass('clamp works and follows the SPDX, test and named-export rules of AGENTS.md')
