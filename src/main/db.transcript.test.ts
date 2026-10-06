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

describe('display transcript persistence', () => {
  it('migrates legacy messages and preserves bounded activity/diffs across a real database restart', () => {
    const fixture = mkdtempSync(join(process.cwd(), '.cubex-transcript-db-'))
    fixtures.push(fixture)
    const outfile = join(fixture, 'verify.cjs')
    buildSync({
      stdin: { contents: `
        import assert from 'node:assert/strict'
        import { join } from 'node:path'
        import Database from 'better-sqlite3'
        import { conversationRepo, closeDb, initDb } from ${JSON.stringify(resolve('src/main/db.ts'))}
        import { hydrateMessageTranscript, serializeMessageTranscript, MESSAGE_TRANSCRIPT_MAX_BYTES } from ${JSON.stringify(resolve('src/shared/messageTranscript.ts'))}

        const legacy = new Database(join(process.env.CUBEX_DATA_DIR, 'cubex.db'))
        legacy.exec(\`CREATE TABLE conversations (
          id TEXT PRIMARY KEY, title TEXT NOT NULL, createdAt INTEGER NOT NULL,
          updatedAt INTEGER NOT NULL, providerId TEXT, model TEXT,
          execution TEXT NOT NULL DEFAULT 'cloud', presetId TEXT, totalUsageJson TEXT
        ); CREATE TABLE messages (
          id TEXT PRIMARY KEY, conversationId TEXT NOT NULL, role TEXT NOT NULL, text TEXT NOT NULL,
          contentJson TEXT, toolCallsJson TEXT, usageJson TEXT, errorJson TEXT, createdAt INTEGER NOT NULL, seq INTEGER NOT NULL
        ); INSERT INTO conversations (id,title,createdAt,updatedAt) VALUES ('legacy','Existing task',1,1);\`)
        legacy.prepare('INSERT INTO messages (id,conversationId,role,text,toolCallsJson,createdAt,seq) VALUES (?,?,?,?,?,?,?)')
          .run('old-message','legacy','assistant','Old answer',JSON.stringify([{id:'old-read',name:'read_file',phase:'done',title:'Read README'}]),1,0)
        legacy.close()
        const oldMessage = conversationRepo.get('legacy').messages[0]
        assert.equal(oldMessage.text, 'Old answer')
        assert.equal(oldMessage.uiTranscriptJson, undefined)
        assert.equal(hydrateMessageTranscript(oldMessage,'legacy').toolCalls[0].phase, 'done')
        assert(initDb().prepare('PRAGMA table_info(messages)').all().some(column => column.name === 'uiTranscriptJson'))

        const uiTranscriptJson = serializeMessageTranscript({
          text: 'Final answer', reasoning: 'Inspect current behavior', reasoningMs: 450,
          toolCalls: [
            {id:'edit',name:'edit_file',phase:'done',title:'Edit parser.ts',diff:'-before\\n+after',added:1,removed:1},
            {id:'test',name:'run_command',phase:'running',title:'Run tests',outputId:'owned-log',outputConversationId:'task'}
          ]
        })
        conversationRepo.create({id:'task',title:'Task',createdAt:1,updatedAt:1,execution:'cloud',messages:[
          {id:'user',role:'user',text:'Fix parser',createdAt:1},
          {id:'assistant',role:'assistant',text:'Final answer',createdAt:2,uiTranscriptJson}
        ]})
        closeDb()
        const stored = conversationRepo.get('task').messages[1]
        assert.equal(stored.text, 'Final answer')
        const display = hydrateMessageTranscript(stored, 'task')
        assert.equal(display.reasoning, 'Inspect current behavior')
        assert.equal(display.reasoningMs, 450)
        assert.equal(display.toolCalls[0].diff, '-before\\n+after')
        assert.equal(display.toolCalls[0].added, 1)
        assert.equal(display.toolCalls[1].phase, 'error')
        assert.equal(display.toolCalls[1].interrupted, true)
        assert.equal(display.toolCalls[1].outputConversationId, 'task')
        assert.equal(hydrateMessageTranscript(stored,'imported-task').toolCalls[1].outputConversationId,'imported-task')
        assert.equal(JSON.parse(stored.uiTranscriptJson).blocks.find(block => block.type === 'tool' && block.tool.id === 'test').tool.phase, 'running')

        const malformed = '{not-json'
        const oversized = 'x'.repeat(MESSAGE_TRANSCRIPT_MAX_BYTES + 1)
        const noisy = JSON.stringify({version:1,blocks:[{type:'tool',tool:{id:'safe',name:'read_file',phase:'done',title:'Read',input:'MUST_NOT_STORE',raw:'MUST_NOT_STORE'}}]})
        conversationRepo.update('task',{messages:[
          {id:'bad',role:'assistant',text:'Still readable',createdAt:3,uiTranscriptJson:malformed},
          {id:'large',role:'assistant',text:'Still complete',createdAt:4,uiTranscriptJson:oversized},
          {id:'clean',role:'assistant',text:'Kept display fields',createdAt:5,uiTranscriptJson:noisy}
        ]})
        const rows = conversationRepo.get('task').messages
        assert.equal(rows[0].uiTranscriptJson, undefined)
        assert.equal(rows[1].uiTranscriptJson, undefined)
        assert.equal(rows[0].text, 'Still readable')
        assert(!rows[2].uiTranscriptJson.includes('MUST_NOT_STORE'))
        assert.equal(hydrateMessageTranscript(rows[2]).toolCalls[0].title,'Read')
        closeDb()
        console.log('transcript-persistence-ok')
      `, resolveDir: process.cwd(), loader: 'ts' },
      bundle: true,
      platform: 'node',
      format: 'cjs',
      external: ['better-sqlite3', 'electron'],
      outfile,
      logLevel: 'silent'
    })
    const output = execFileSync(require('electron') as string, [outfile], {
      cwd: process.cwd(), windowsHide: true, timeout: 20_000, encoding: 'utf8',
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', CUBEX_DATA_DIR: fixture, NODE_PATH: resolve('node_modules') }
    })
    expect(output).toContain('transcript-persistence-ok')
  })
})
