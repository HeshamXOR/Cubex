import { exists, expect, files, mustPass, nodeTest, pass, workspace } from '../../lib/checkKit.mjs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const { pageCount, caption, pageItems } = await import(pathToFileURL(join(workspace, 'src/paginate.mjs')).href)
const cases = [
  [pageCount(40, 20), 2, 'pageCount(40, 20)'], [pageCount(41, 20), 3, 'pageCount(41, 20)'], [pageCount(1, 20), 1, 'pageCount(1, 20)'],
  [pageCount(20, 20), 1, 'pageCount(20, 20)'], [pageCount(0, 20), 1, 'pageCount(0, 20)'], [pageCount(100, 10), 10, 'pageCount(100, 10)'],
  [caption(1, 20, 45), 'Showing 1-20 of 45', 'caption(1, 20, 45)'], [caption(2, 20, 45), 'Showing 21-40 of 45', 'caption(2, 20, 45)'],
  [caption(3, 20, 45), 'Showing 41-45 of 45', 'caption(3, 20, 45)'], [caption(1, 20, 0), 'No results', 'caption(1, 20, 0)']
]
for (const [got, want, label] of cases) expect(got === want, `${label} is ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`)
expect(pageItems([1, 2, 3, 4, 5], 2, 2).join() === '3,4', 'pageItems must keep working')

mustPass('node --test', nodeTest())
// Each bug needs a test of its own: the project had none for either.
const tests = files().filter((rel) => /(^|\/)test\/.+\.(mjs|js)$/.test(rel))
expect(tests.length > 0 && exists('test/paginate.test.mjs'), 'test/paginate.test.mjs is gone')
const { readFileSync } = await import('node:fs')
const body = tests.map((rel) => readFileSync(join(workspace, rel), 'utf8')).join('\n')
expect(/pageCount/.test(body), 'there is no test for pageCount')
expect(/caption/.test(body), 'there is no test for caption')
pass('both bugs are fixed, the suite passes, and each bug has a test')
