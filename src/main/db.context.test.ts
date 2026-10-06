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

describe('context boundary persistence', () => {
  it('migrates existing databases and keeps the full searchable/exportable transcript across compaction and restart', () => {
    // better-sqlite3 is built for Electron. Exercise the actual native database
    // using Electron's Node mode, with an isolated temporary data directory and
    // no application window or access to the user's database.
    // Keep the fixture under the test workspace: Windows sandbox identities may
    // not resolve the user's 8.3-shortened TEMP path when Electron starts.
    const fixture = mkdtempSync(join(process.cwd(), '.cubex-context-db-'))
    fixtures.push(fixture)
    const outfile = join(fixture, 'verify.cjs')
    buildSync({
      stdin: { contents: `
        import assert from 'node:assert/strict'
        import { join } from 'node:path'
        import Database from 'better-sqlite3'
        import { conversationRepo, closeDb, initDb } from ${JSON.stringify(resolve('src/main/db.ts'))}
        import { exportConversation } from ${JSON.stringify(resolve('src/main/exporter.ts'))}

        const legacy = new Database(join(process.env.CUBEX_DATA_DIR, 'cubex.db'))
        legacy.exec(\`CREATE TABLE conversations (
          id TEXT PRIMARY KEY, title TEXT NOT NULL, createdAt INTEGER NOT NULL,
          updatedAt INTEGER NOT NULL, providerId TEXT, model TEXT,
          execution TEXT NOT NULL DEFAULT 'cloud', presetId TEXT, totalUsageJson TEXT
        ); INSERT INTO conversations (id,title,createdAt,updatedAt) VALUES ('legacy','Existing task',1,1);\`)
        legacy.close()
        assert.equal(conversationRepo.get('legacy').title, 'Existing task')
        assert.equal(conversationRepo.get('legacy').contextStartMessageId, undefined)
        assert(initDb().prepare('PRAGMA table_info(conversations)').all().some(column => column.name === 'contextStartMessageId'))

        const messages = Array.from({length: 12}, (_, index) => ({
          id: 'm' + index, role: index % 2 ? 'assistant' : 'user',
          text: index === 0 ? 'ORIGINAL_UNIQUE_TOKEN' : 'Message ' + index, createdAt: index + 1
        }))
        conversationRepo.create({ id: 'task', title: 'Task', createdAt: 1, updatedAt: 1, execution: 'cloud', messages, contextStartMessageId: 'm4' })
        assert.equal(conversationRepo.get('task').contextStartMessageId, 'm4')
        conversationRepo.update('task', {contextStartMessageId: 'm6'})
        assert.equal(conversationRepo.get('task').contextStartMessageId, 'm6')
        assert.equal(conversationRepo.get('task').messages.length, 12)
        assert.deepEqual(conversationRepo.get('task').messages.map(message => message.id), messages.map(message => message.id))
        assert(conversationRepo.search('ORIGINAL_UNIQUE_TOKEN').some(item => item.id === 'task'))
        assert.equal(JSON.parse(exportConversation('task', 'json')).messages.length, 12)
        assert(exportConversation('task', 'markdown').includes('ORIGINAL_UNIQUE_TOKEN'))
        closeDb()
        assert.equal(conversationRepo.get('task').contextStartMessageId, 'm6')
        assert.equal(conversationRepo.get('task').messages.length, 12)

        // A later send persists the entire transcript and leaves its boundary.
        const later = [...conversationRepo.get('task').messages, {id:'m12',role:'user',text:'Later message',createdAt:13}]
        conversationRepo.update('task', {messages: later, title:'Renamed task'})
        assert.equal(conversationRepo.get('task').contextStartMessageId, 'm6')
        assert.equal(conversationRepo.get('task').messages.length, 13)
        conversationRepo.update('task', {contextStartMessageId: undefined})
        assert.equal(conversationRepo.get('task').contextStartMessageId, undefined)
        assert.equal(conversationRepo.get('task').messages.length, 13)
        closeDb()
        assert.equal(conversationRepo.get('task').contextStartMessageId, undefined)
        assert.equal(conversationRepo.get('task').messages.length, 13)
        closeDb()
        console.log('context-persistence-ok')
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
      timeout: 20_000,
      encoding: 'utf8',
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        CUBEX_DATA_DIR: fixture,
        NODE_PATH: resolve('node_modules')
      }
    })
    expect(output).toContain('context-persistence-ok')
  })
})
