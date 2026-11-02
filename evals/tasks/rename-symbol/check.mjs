import { expect, files, mustPass, nodeTest, pass, read, run, workspace } from '../../lib/checkKit.mjs'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'

const OLD = /\bcalcTotal\b/
const NEW = /\bcomputeOrderTotal\b/

const texts = files().filter((rel) => /\.(mjs|md|json)$/.test(rel))
const stale = texts.filter((rel) => OLD.test(read(rel)))
expect(stale.length === 0, `calcTotal is still mentioned in: ${stale.join(', ')}`)
const renamed = texts.filter((rel) => NEW.test(read(rel)))
for (const rel of ['src/pricing.mjs', 'src/invoice.mjs', 'src/report.mjs', 'test/pricing.test.mjs', 'README.md']) {
  expect(renamed.includes(rel), `${rel} does not use computeOrderTotal`)
}
expect(read('src/pricing.mjs').includes('calcTotalWithTax'), 'calcTotalWithTax must stay')
expect(read('src/report.mjs').includes('calcTotalWithTax'), 'calcTotalWithTax must stay where it is used')

const probe = run(process.execPath, ['--input-type=module', '-e',
  `import * as p from ${JSON.stringify(pathToFileURL(join(workspace, 'src/pricing.mjs')).href)}
   const keys = Object.keys(p).sort().join(',')
   if (keys !== 'calcTotalWithTax,computeOrderTotal') { console.log('exports are ' + keys); process.exit(1) }
   if (p.computeOrderTotal([{ price: 3, qty: 4 }]) !== 12 || p.calcTotalWithTax([{ price: 10, qty: 1 }], 0.5) !== 15) process.exit(1)`])
mustPass('the exports of pricing.mjs', probe)
mustPass('node --test', nodeTest())
pass('renamed everywhere, calcTotalWithTax kept, tests pass')
