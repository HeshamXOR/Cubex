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

describe('the context snapshot kept with a conversation', () => {
  it('migrates older databases, survives a restart, does not count as activity, and goes when the context is cut', () => {
    // Same approach as db.composer.test.ts: the real database runs in Electron's Node mode against an isolated data directory.
    const fixture = mkdtempSync(join(process.cwd(), '.cubex-last-context-db-'))
    fixtures.push(fixture)
    const outfile = join(fixture, 'verify.cjs')
    buildSync({
      stdin: { contents: `
        import assert from 'node:assert/strict'
        import { join } from 'node:path'
        import Database from 'better-sqlite3'
        import { conversationRepo, closeDb, initDb } from ${JSON.stringify(resolve('src/main/db.ts'))}

        // An install from before the snapshot was kept.
        const legacy = new Database(join(process.env.CUBEX_DATA_DIR, 'cubex.db'))
        legacy.exec(\`CREATE TABLE conversations (
          id TEXT PRIMARY KEY, title TEXT NOT NULL, createdAt INTEGER NOT NULL,
          updatedAt INTEGER NOT NULL, providerId TEXT, model TEXT,
          execution TEXT NOT NULL DEFAULT 'cloud', presetId TEXT, totalUsageJson TEXT
        ); INSERT INTO conversations (id,title,createdAt,updatedAt) VALUES ('legacy','Existing task',1,1);\`)
        legacy.close()
        assert.equal(conversationRepo.get('legacy').lastContext, undefined)
        assert(initDb().prepare('PRAGMA table_info(conversations)').all().some(column => column.name === 'contextJson'))

        const snapshot = (tokens) => ({ sections: [{ id: 'conversation', label: 'Conversation', estimatedTokens: tokens }], estimatedTokens: tokens, contextTokens: tokens,
          contextWindow: 200000, outputReserve: 4096, provider: 'p', model: 'm', updatedAt: 5 })
        const messages = [{ id: 'm1', role: 'user', text: 'a', createdAt: 1 }, { id: 'm2', role: 'assistant', text: 'b', createdAt: 2 }]
        conversationRepo.create({ id: 'task', title: 'Task', createdAt: 10, updatedAt: 10, execution: 'cloud', messages })
        assert.equal(conversationRepo.get('task').lastContext, undefined)

        // Saved at the end of a turn: it round-trips through a restart and leaves the chat where it was in the list.
        conversationRepo.update('task', { lastContext: snapshot(1200) })
        closeDb()
        assert.deepEqual(conversationRepo.get('task').lastContext, snapshot(1200))
        assert.equal(conversationRepo.get('task').updatedAt, 10)
        assert.equal(conversationRepo.get('task').messages.length, 2)

        // Other updates keep it; a newer snapshot replaces it.
        conversationRepo.update('task', { messages: [...messages, { id: 'm3', role: 'user', text: 'c', createdAt: 3 }] })
        assert.deepEqual(conversationRepo.get('task').lastContext, snapshot(1200))
        assert(conversationRepo.get('task').updatedAt > 10)
        conversationRepo.update('task', { lastContext: snapshot(3400) })
        assert.equal(conversationRepo.get('task').lastContext.estimatedTokens, 3400)

        // A compaction moves the boundary and, unless it brings a snapshot of its own, clears the old one.
        conversationRepo.update('task', { contextStartMessageId: 'm3', contextSummary: 'Summary of the earlier work', contextSummaryAt: 7 })
        assert.equal(conversationRepo.get('task').lastContext, undefined)
        conversationRepo.update('task', { lastContext: snapshot(900) })
        conversationRepo.update('task', { contextStartMessageId: 'm3', contextSummary: 'Again', lastContext: snapshot(800) })
        assert.equal(conversationRepo.get('task').lastContext.estimatedTokens, 800)

        // Restore full context and /clear cut the boundary: nothing stays that counted the old context.
        conversationRepo.update('task', { contextStartMessageId: undefined })
        assert.equal(conversationRepo.get('task').lastContext, undefined)
        conversationRepo.update('task', { lastContext: snapshot(700) })
        conversationRepo.update('task', { messages: [], contextStartMessageId: undefined })
        assert.equal(conversationRepo.get('task').lastContext, undefined)

        // Saving it explicitly empty clears it, and a damaged row reads as no snapshot instead of failing to open.
        conversationRepo.update('task', { lastContext: snapshot(600) })
        conversationRepo.update('task', { lastContext: undefined })
        assert.equal(conversationRepo.get('task').lastContext, undefined)
        initDb().prepare("UPDATE conversations SET contextJson = ? WHERE id = 'task'").run('{"sections":"nope"')
        assert.equal(conversationRepo.get('task').lastContext, undefined)
        initDb().prepare("UPDATE conversations SET contextJson = ? WHERE id = 'task'").run('{"sections":"x","estimatedTokens":1}')
        assert.equal(conversationRepo.get('task').lastContext, undefined)
        closeDb()
        console.log('last-context-ok')
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
    expect(output).toContain('last-context-ok')
  })
})
