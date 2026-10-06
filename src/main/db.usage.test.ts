import { afterEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtempSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { buildSync } from 'esbuild'

const require = createRequire(import.meta.url)
const fixtures: string[] = []
afterEach(() => {
  for (const fixture of fixtures.splice(0)) rmSync(fixture, { recursive: true, force: true })
})

describe('usage ledger persistence', () => {
  it('migrates old rows to "estimated", stores the new columns, and sums spend per task and per window', () => {
    // Same approach as db.summary.test.ts: the native module is built for Electron, so run
    // the real database in Electron's Node mode against an isolated data directory.
    const fixture = mkdtempSync(join(process.cwd(), '.cubex-usage-db-'))
    fixtures.push(fixture)
    const outfile = join(fixture, 'verify.cjs')
    buildSync({
      stdin: { contents: `
        import assert from 'node:assert/strict'
        import { join } from 'node:path'
        import Database from 'better-sqlite3'
        import { usageRepo, closeDb, initDb } from ${JSON.stringify(resolve('src/main/db.ts'))}

        // An install from before cost sources: the table has none of the new columns.
        const legacy = new Database(join(process.env.CUBEX_DATA_DIR, 'cubex.db'))
        legacy.exec('CREATE TABLE usage_records (id TEXT PRIMARY KEY, ts INTEGER NOT NULL, providerId TEXT NOT NULL, model TEXT NOT NULL, execution TEXT NOT NULL, inputTokens INTEGER NOT NULL, outputTokens INTEGER NOT NULL, totalTokens INTEGER NOT NULL, estimatedCost REAL NOT NULL, currency TEXT NOT NULL)')
        const now = Date.now()
        legacy.prepare('INSERT INTO usage_records VALUES (?,?,?,?,?,?,?,?,?,?)').run('old', now - 3 * 3600_000, 'p', 'm', 'cloud', 10, 10, 20, 1.5, 'USD')
        legacy.close()

        const db = initDb()
        const columns = db.prepare('PRAGMA table_info(usage_records)').all().map((column) => column.name)
        for (const name of ['costSource', 'conversationId', 'cacheReadTokens', 'cacheWriteTokens']) assert(columns.includes(name), name)
        assert.equal(db.prepare('SELECT costSource FROM usage_records WHERE id = ?').get('old').costSource, 'estimated')
        assert.equal(db.prepare('SELECT conversationId FROM usage_records WHERE id = ?').get('old').conversationId, null)

        const base = { providerId: 'p', model: 'm', execution: 'cloud', inputTokens: 1, outputTokens: 1, totalTokens: 2, currency: 'USD' }
        usageRepo.record({ ...base, id: 'a', ts: now - 1000, estimatedCost: 0.25, costSource: 'catalog', conversationId: 'c1', cacheReadTokens: 7, cacheWriteTokens: 3 })
        usageRepo.record({ ...base, id: 'b', ts: now - 500, estimatedCost: 0.5, costSource: 'reported', conversationId: 'c2' })
        usageRepo.record({ ...base, id: 'c', ts: now, estimatedCost: 0.125 })
        const row = db.prepare('SELECT * FROM usage_records WHERE id = ?').get('a')
        assert.deepEqual([row.costSource, row.conversationId, row.cacheReadTokens, row.cacheWriteTokens], ['catalog', 'c1', 7, 3])
        const bare = db.prepare('SELECT * FROM usage_records WHERE id = ?').get('c')
        assert.deepEqual([bare.costSource, bare.conversationId, bare.cacheReadTokens], ['estimated', null, null])

        assert.equal(usageRepo.spendSince(0, 'c1'), 0.25)
        assert.equal(usageRepo.spendSince(0, 'c2'), 0.5)
        assert.equal(usageRepo.spendSince(0, 'missing'), 0)
        assert.equal(usageRepo.spendSince(now - 2000), 0.875)
        assert.equal(usageRepo.spendSince(0), 2.375)
        // The usage view splits the same rows by provider, model, place and kind of price figure.
        const by = Object.fromEntries(usageRepo.breakdownSince(0).map((group) => [group.costSource, group]))
        assert.deepEqual(Object.keys(by).sort(), ['catalog', 'estimated', 'reported'])
        assert.deepEqual([by.estimated.requests, by.estimated.cost, by.estimated.tokens], [2, 1.625, 22])
        assert.deepEqual([by.catalog.providerId, by.catalog.model, by.catalog.execution, by.catalog.requests, by.catalog.cost], ['p', 'm', 'cloud', 1, 0.25])
        assert.deepEqual([by.reported.requests, by.reported.cost], [1, 0.5])
        assert.equal(usageRepo.breakdownSince(now - 2000).length, 3)
        assert.equal(usageRepo.breakdownSince(now + 1).length, 0)
        // The sidebar keeps reading the rolling 24 hour sum, untouched by the new columns.
        assert.equal(usageRepo.summary(now).today, 2.375)
        closeDb()
        console.log('usage-ledger-ok')
      `, resolveDir: process.cwd(), loader: 'ts' },
      bundle: true,
      platform: 'node',
      format: 'cjs',
      external: ['better-sqlite3', 'electron'],
      outfile,
      logLevel: 'silent'
    })
    const output = execFileSync(require('electron') as string, [outfile], {
      cwd: process.cwd(),
      windowsHide: true,
      timeout: 30_000,
      encoding: 'utf8',
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        CUBEX_DATA_DIR: fixture,
        NODE_PATH: resolve('node_modules')
      }
    })
    expect(output).toContain('usage-ledger-ok')
  })
})
