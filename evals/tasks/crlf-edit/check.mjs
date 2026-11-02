import { expect, fixture, mustPass, nodeTest, pass, path, read, scratchCopy, workspace } from '../../lib/checkKit.mjs'
import { pathToFileURL } from 'node:url'

const after = read('lib/stock.mjs')
expect(!/(^|[^\r])\n/.test(after), 'lib/stock.mjs lost its Windows line endings: some lines now end with a bare LF')
expect(!/\r(?!\n)/.test(after), 'lib/stock.mjs has a stray carriage return')
expect(after.endsWith('\r\n'), 'lib/stock.mjs no longer ends with a CRLF')

// Only the condition and its doc comment may differ.
const was = read('lib/stock.mjs', fixture).split('\r\n')
const now = after.split('\r\n')
const removed = was.filter((line) => !now.includes(line))
const added = now.filter((line) => !was.includes(line))
expect(removed.length <= 3 && added.length <= 3, `too much changed in lib/stock.mjs: removed ${JSON.stringify(removed)}, added ${JSON.stringify(added)}`)
expect(removed.length >= 1, 'lib/stock.mjs was not changed')
expect(now.some((line) => line.includes('restockPlan')) && now.some((line) => line.includes('item.qty < target')), 'restockPlan must keep comparing with <')

const dir = scratchCopy()
const stock = await import(pathToFileURL(path('lib/stock.mjs', dir)).href)
const items = [{ sku: 'b', qty: 5 }, { sku: 'a', qty: 4 }, { sku: 'c', qty: 6 }, { sku: 'd', qty: 0 }]
expect(JSON.stringify(stock.lowStock(items, 5)) === JSON.stringify(['a', 'b', 'd']), `lowStock(items, 5) is ${JSON.stringify(stock.lowStock(items, 5))}, expected a, b, d`)
expect(JSON.stringify(stock.restockPlan(items, 5)) === JSON.stringify([{ sku: 'a', order: 1 }, { sku: 'd', order: 5 }]), 'restockPlan changed behavior')
expect(stock.totalUnits(items) === 15, 'totalUnits changed behavior')
const comment = now.find((line) => /low/i.test(line) && line.trim().startsWith('/**'))
expect(comment !== undefined && !/fewer units on hand than/.test(comment), 'the doc comment of lowStock still describes the old rule')
mustPass('node --test', nodeTest([], dir))
void workspace
pass('lowStock includes the threshold, CRLF endings are intact and nothing else changed')
