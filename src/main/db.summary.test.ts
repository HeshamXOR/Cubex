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

describe('compaction summary persistence', () => {
  it('migrates databases that only have a boundary, stores the summary with it, and drops the summary when the boundary is cleared', () => {
    // Same approach as db.context.test.ts: the native module is built for Electron, so run
    // the real database in Electron's Node mode against an isolated data directory.
    const fixture = mkdtempSync(join(process.cwd(), '.cubex-summary-db-'))
    fixtures.push(fixture)
    const outfile = join(fixture, 'verify.cjs')
    buildSync({
      stdin: { contents: `
        import assert from 'node:assert/strict'
        import { join } from 'node:path'
        import Database from 'better-sqlite3'
        import { conversationRepo, closeDb, initDb } from ${JSON.stringify(resolve('src/main/db.ts'))}
        import { exportConversation, importConversation } from ${JSON.stringify(resolve('src/main/exporter.ts'))}

        // An install that already has the boundary column but no summary columns.
        const legacy = new Database(join(process.env.CUBEX_DATA_DIR, 'cubex.db'))
        legacy.exec(\`CREATE TABLE conversations (
          id TEXT PRIMARY KEY, title TEXT NOT NULL, createdAt INTEGER NOT NULL,
          updatedAt INTEGER NOT NULL, providerId TEXT, model TEXT,
          execution TEXT NOT NULL DEFAULT 'cloud', presetId TEXT, totalUsageJson TEXT,
          contextStartMessageId TEXT
        ); INSERT INTO conversations (id,title,createdAt,updatedAt,contextStartMessageId) VALUES ('legacy','Existing task',1,1,'old-boundary');\`)
        legacy.close()
        const before = conversationRepo.get('legacy')
        assert.equal(before.title, 'Existing task')
        assert.equal(before.contextStartMessageId, 'old-boundary')
        assert.equal(before.contextSummary, undefined)
        assert.equal(before.contextSummaryAt, undefined)
        const columns = initDb().prepare('PRAGMA table_info(conversations)').all().map(column => column.name)
        assert(columns.includes('contextSummary') && columns.includes('contextSummaryAt'))

        const messages = Array.from({length: 12}, (_, index) => ({
          id: 'm' + index, role: index % 2 ? 'assistant' : 'user', text: 'Message ' + index, createdAt: index + 1
        }))
        const summary = 'Goal: ship the parser.\\n- Edited src/parser/lexer.ts'
        conversationRepo.create({ id: 'task', title: 'Task', createdAt: 1, updatedAt: 1, execution: 'cloud', messages,
          contextStartMessageId: 'm4', contextSummary: summary, contextSummaryAt: 1234 })
        let task = conversationRepo.get('task')
        assert.equal(task.contextSummary, summary)
        assert.equal(task.contextSummaryAt, 1234)
        assert.equal(task.contextStartMessageId, 'm4')

        // Unrelated updates and a later send keep the boundary and its summary.
        conversationRepo.update('task', { title: 'Renamed' })
        assert.equal(conversationRepo.get('task').contextSummary, summary)
        const later = [...conversationRepo.get('task').messages, { id: 'm12', role: 'user', text: 'Later', createdAt: 13 }]
        conversationRepo.update('task', { messages: later })
        task = conversationRepo.get('task')
        assert.equal(task.contextSummary, summary)
        assert.equal(task.contextStartMessageId, 'm4')
        assert.equal(task.messages.length, 13)

        // A new compaction replaces boundary, summary and timestamp together, and survives a restart.
        conversationRepo.update('task', { contextStartMessageId: 'm6', contextSummary: 'Second summary', contextSummaryAt: 5678 })
        closeDb()
        task = conversationRepo.get('task')
        assert.deepEqual([task.contextStartMessageId, task.contextSummary, task.contextSummaryAt], ['m6', 'Second summary', 5678])

        // Moving only the boundary keeps the older summary: it still covers what came before it.
        conversationRepo.update('task', { contextStartMessageId: 'm8' })
        assert.equal(conversationRepo.get('task').contextSummary, 'Second summary')

        // Exports carry the summary; an import has fresh message ids and starts with full context.
        assert.equal(JSON.parse(exportConversation('task', 'json')).contextSummary, 'Second summary')
        const imported = importConversation(exportConversation('task', 'json'))
        assert.equal(conversationRepo.get(imported.id).contextSummary, undefined)
        assert.equal(conversationRepo.get(imported.id).contextStartMessageId, undefined)

        // Restore full context: clearing the boundary clears the summary and its timestamp.
        conversationRepo.update('task', { contextStartMessageId: undefined })
        task = conversationRepo.get('task')
        assert.equal(task.contextStartMessageId, undefined)
        assert.equal(task.contextSummary, undefined)
        assert.equal(task.contextSummaryAt, undefined)
        closeDb()
        assert.equal(conversationRepo.get('task').contextSummary, undefined)

        // /clear sends both together; a summary is never stored without a boundary.
        conversationRepo.update('task', { contextStartMessageId: 'm4', contextSummary: 'Again', contextSummaryAt: 9 })
        conversationRepo.update('task', { messages: [], contextStartMessageId: undefined })
        task = conversationRepo.get('task')
        assert.equal(task.messages.length, 0)
        assert.equal(task.contextSummary, undefined)
        conversationRepo.update('task', { contextSummary: 'Orphan' })
        assert.equal(conversationRepo.get('task').contextSummary, undefined)
        conversationRepo.create({ id: 'orphan', title: 'Orphan', createdAt: 1, updatedAt: 1, execution: 'cloud', messages: [], contextSummary: 'No boundary' })
        assert.equal(conversationRepo.get('orphan').contextSummary, undefined)
        closeDb()
        console.log('summary-persistence-ok')
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
    expect(output).toContain('summary-persistence-ok')
  })
})
