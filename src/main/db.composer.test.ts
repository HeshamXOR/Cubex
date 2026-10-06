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

describe('what each conversation remembers about its model', () => {
  it('migrates older databases, keeps each chat its own choices across a restart, and does not count a model change as activity', () => {
    // Same approach as db.summary.test.ts: the native module is built for Electron, so the real database runs in
    // Electron's Node mode against an isolated data directory.
    const fixture = mkdtempSync(join(process.cwd(), '.cubex-composer-db-'))
    fixtures.push(fixture)
    const outfile = join(fixture, 'verify.cjs')
    buildSync({
      stdin: { contents: `
        import assert from 'node:assert/strict'
        import { join } from 'node:path'
        import Database from 'better-sqlite3'
        import { conversationRepo, closeDb, initDb } from ${JSON.stringify(resolve('src/main/db.ts'))}

        // An install from before the settings were kept per conversation.
        const legacy = new Database(join(process.env.CUBEX_DATA_DIR, 'cubex.db'))
        legacy.exec(\`CREATE TABLE conversations (
          id TEXT PRIMARY KEY, title TEXT NOT NULL, createdAt INTEGER NOT NULL,
          updatedAt INTEGER NOT NULL, providerId TEXT, model TEXT,
          execution TEXT NOT NULL DEFAULT 'cloud', presetId TEXT, totalUsageJson TEXT
        ); INSERT INTO conversations (id,title,createdAt,updatedAt,providerId,model) VALUES ('legacy','Existing task',1,1,'nv','old-model');\`)
        legacy.close()
        const before = conversationRepo.get('legacy')
        assert.equal(before.model, 'old-model')
        assert.equal(before.composer, undefined)
        assert(initDb().prepare('PRAGMA table_info(conversations)').all().some(column => column.name === 'composerJson'))

        // Two chats on two models, each with its own effort and limits.
        conversationRepo.create({ id: 'a', title: 'A', createdAt: 10, updatedAt: 10, execution: 'cloud', messages: [], providerId: 'nv', model: 'moonshotai/kimi-k3', composer: { effort: 'max', longContext: false, maxTokens: 8192 } })
        conversationRepo.create({ id: 'b', title: 'B', createdAt: 20, updatedAt: 20, execution: 'cloud', messages: [], providerId: 'nv', model: 'z-ai/glm-5.3', composer: { effort: 'low' } })
        closeDb()
        assert.deepEqual(conversationRepo.get('a').composer, { effort: 'max', longContext: false, maxTokens: 8192 })
        assert.deepEqual(conversationRepo.get('b').composer, { effort: 'low' })

        // Changing one chat's model leaves the other alone, and clears an effort the new model does not take.
        conversationRepo.update('a', { providerId: 'nv', model: 'z-ai/glm-5.3', composer: { longContext: false, maxTokens: 4096 } })
        assert.equal(conversationRepo.get('a').model, 'z-ai/glm-5.3')
        assert.deepEqual(conversationRepo.get('a').composer, { longContext: false, maxTokens: 4096 })
        assert.equal(conversationRepo.get('b').model, 'z-ai/glm-5.3')
        assert.equal(conversationRepo.get('b').composer.effort, 'low')

        // Choosing a model is not activity: the chat keeps its place in the list. A rename is.
        assert.equal(conversationRepo.get('a').updatedAt, 10)
        conversationRepo.update('a', { title: 'Renamed' })
        assert(conversationRepo.get('a').updatedAt > 10)
        const stamp = conversationRepo.get('a').updatedAt
        conversationRepo.update('a', { composer: { effort: 'high' } })
        assert.equal(conversationRepo.get('a').updatedAt, stamp)
        assert.equal(conversationRepo.get('a').title, 'Renamed')

        // Anything that is not a known setting of the right type is dropped, never stored.
        conversationRepo.update('a', { composer: { effort: 'ludicrous', longContext: 'yes', maxTokens: -5, extra: 1 } })
        assert.equal(conversationRepo.get('a').composer, undefined)
        conversationRepo.update('a', { composer: { effort: 'xhigh', maxTokens: 2.5 } })
        assert.deepEqual(conversationRepo.get('a').composer, { effort: 'xhigh' })
        closeDb()
        console.log('composer-persistence-ok')
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
    expect(output).toContain('composer-persistence-ok')
  })
})
