import { expect, mustPass, nodeTest, pass, path, put, read, scratchCopy, unchanged } from '../../lib/checkKit.mjs'
import { existsSync } from 'node:fs'

unchanged('src/slug.mjs')
expect(existsSync(path('test/slug.test.mjs')), 'test/slug.test.mjs does not exist')
mustPass('the new tests against the real slugify', nodeTest(['test/slug.test.mjs']))

// Mutation check: break slugify in seven ways, one at a time. A good suite fails on most of them.
const source = read('src/slug.mjs')
const mutants = [
  ['accents are kept', ".replace(/[\\u0300-\\u036f]/g, '')", ''],
  ['case is kept', '.toLowerCase()', ''],
  ['digits are dropped', '[^a-z0-9]+', '[^a-z]+'],
  ['runs of characters are not collapsed', '[^a-z0-9]+', '[^a-z0-9]'],
  ['trailing dash is kept', '.replace(/^-+|-+$/g, \'\')', ".replace(/^-+/, '')"],
  ['leading dash is kept', '.replace(/^-+|-+$/g, \'\')', ".replace(/-+$/, '')"],
  ['a cut can end in a dash', ".slice(0, maxLength).replace(/-+$/, '')", '.slice(0, maxLength)'],
  ['the default length is 60', 'maxLength = 80', 'maxLength = 60'],
  ['the cut is one too long', '.slice(0, maxLength)', '.slice(0, maxLength + 1)']
]
let killed = 0
const survivors = []
for (const [label, from, to] of mutants) {
  expect(source.includes(from), `internal: the mutant "${label}" does not apply`)
  const dir = scratchCopy()
  put('src/slug.mjs', source.replace(from, to), dir)
  const result = nodeTest(['test/slug.test.mjs'], dir)
  if (result.status !== 0) killed++
  else survivors.push(label)
}
const needed = 7
expect(killed >= needed, `the tests caught ${killed} of ${mutants.length} deliberate bugs; ${needed} are needed. Not caught: ${survivors.join('; ')}`)
pass(`the tests pass and caught ${killed} of ${mutants.length} deliberate bugs`)
