import Database from 'better-sqlite3'
import { dbPath } from './paths'
import type {
  Conversation,
  ConversationSummary,
  LogEntry,
  Preset,
  StoredMessage,
  UsageRecord,
  UsageSummary
} from '@shared/ipc'
import type { ProviderConfig } from '@core/types'

/**
 * SQLite persistence via better-sqlite3 (synchronous, fast, single-file).
 * Holds providers, conversations, messages, presets, usage records, and logs.
 */
let db: Database.Database | null = null

export function initDb(): Database.Database {
  if (db) return db
  db = new Database(dbPath())
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  migrate(db)
  return db
}

function migrate(d: Database.Database): void {
  d.exec(`
    CREATE TABLE IF NOT EXISTS providers (
      id TEXT PRIMARY KEY,
      json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      createdAt INTEGER NOT NULL,
      updatedAt INTEGER NOT NULL,
      providerId TEXT,
      model TEXT,
      execution TEXT NOT NULL DEFAULT 'cloud',
      presetId TEXT,
      totalUsageJson TEXT
    );
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      conversationId TEXT NOT NULL,
      role TEXT NOT NULL,
      text TEXT NOT NULL,
      contentJson TEXT,
      toolCallsJson TEXT,
      usageJson TEXT,
      errorJson TEXT,
      createdAt INTEGER NOT NULL,
      seq INTEGER NOT NULL,
      FOREIGN KEY (conversationId) REFERENCES conversations(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversationId, seq);
    CREATE TABLE IF NOT EXISTS presets (
      id TEXT PRIMARY KEY,
      json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS usage_records (
      id TEXT PRIMARY KEY,
      ts INTEGER NOT NULL,
      providerId TEXT NOT NULL,
      model TEXT NOT NULL,
      execution TEXT NOT NULL,
      inputTokens INTEGER NOT NULL,
      outputTokens INTEGER NOT NULL,
      totalTokens INTEGER NOT NULL,
      estimatedCost REAL NOT NULL,
      currency TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_usage_ts ON usage_records(ts);
    CREATE TABLE IF NOT EXISTS logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      level TEXT NOT NULL,
      json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS benchmarks (
      id TEXT PRIMARY KEY,
      modelId TEXT NOT NULL,
      ts INTEGER NOT NULL,
      json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_bench_model ON benchmarks(modelId, ts);
  `)
}

// --- Providers ---
export const providerRepo = {
  list(): ProviderConfig[] {
    return initDb()
      .prepare('SELECT json FROM providers')
      .all()
      .map((r) => JSON.parse((r as { json: string }).json) as ProviderConfig)
  },
  save(cfg: ProviderConfig): void {
    initDb()
      .prepare('INSERT INTO providers (id, json) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET json=excluded.json')
      .run(cfg.id, JSON.stringify(cfg))
  },
  delete(id: string): void {
    initDb().prepare('DELETE FROM providers WHERE id = ?').run(id)
  },
  get(id: string): ProviderConfig | undefined {
    const r = initDb().prepare('SELECT json FROM providers WHERE id = ?').get(id) as { json: string } | undefined
    return r ? (JSON.parse(r.json) as ProviderConfig) : undefined
  }
}

// --- Conversations ---
export const conversationRepo = {
  listSummaries(): ConversationSummary[] {
    const rows = initDb()
      .prepare(
        `SELECT c.*, (SELECT COUNT(*) FROM messages m WHERE m.conversationId = c.id) AS messageCount
         FROM conversations c ORDER BY c.updatedAt DESC`
      )
      .all() as Array<Record<string, unknown>>
    return rows.map(toSummary)
  },

  search(query: string): ConversationSummary[] {
    const like = `%${query}%`
    const rows = initDb()
      .prepare(
        `SELECT DISTINCT c.*, (SELECT COUNT(*) FROM messages m2 WHERE m2.conversationId = c.id) AS messageCount
         FROM conversations c
         LEFT JOIN messages m ON m.conversationId = c.id
         WHERE c.title LIKE ? OR m.text LIKE ?
         ORDER BY c.updatedAt DESC`
      )
      .all(like, like) as Array<Record<string, unknown>>
    return rows.map(toSummary)
  },

  get(id: string): Conversation | null {
    const d = initDb()
    const c = d.prepare('SELECT * FROM conversations WHERE id = ?').get(id) as Record<string, unknown> | undefined
    if (!c) return null
    const msgs = d
      .prepare('SELECT * FROM messages WHERE conversationId = ? ORDER BY seq ASC')
      .all(id) as Array<Record<string, unknown>>
    return {
      id: c.id as string,
      title: c.title as string,
      createdAt: c.createdAt as number,
      updatedAt: c.updatedAt as number,
      providerId: (c.providerId as string) ?? undefined,
      model: (c.model as string) ?? undefined,
      execution: (c.execution as Conversation['execution']) ?? 'cloud',
      presetId: (c.presetId as string) ?? undefined,
      totalUsage: c.totalUsageJson ? JSON.parse(c.totalUsageJson as string) : undefined,
      messages: msgs.map(toMessage)
    }
  },

  create(conv: Conversation): void {
    const d = initDb()
    d.prepare(
      `INSERT INTO conversations (id,title,createdAt,updatedAt,providerId,model,execution,presetId,totalUsageJson)
       VALUES (@id,@title,@createdAt,@updatedAt,@providerId,@model,@execution,@presetId,@totalUsageJson)`
    ).run({
      id: conv.id,
      title: conv.title,
      createdAt: conv.createdAt,
      updatedAt: conv.updatedAt,
      providerId: conv.providerId ?? null,
      model: conv.model ?? null,
      execution: conv.execution,
      presetId: conv.presetId ?? null,
      totalUsageJson: conv.totalUsage ? JSON.stringify(conv.totalUsage) : null
    })
    this.replaceMessages(conv.id, conv.messages)
  },

  update(id: string, patch: Partial<Conversation>): void {
    const d = initDb()
    const existing = this.get(id)
    if (!existing) return
    const merged = { ...existing, ...patch, updatedAt: Date.now() }
    d.prepare(
      `UPDATE conversations SET title=@title, updatedAt=@updatedAt, providerId=@providerId,
        model=@model, execution=@execution, presetId=@presetId, totalUsageJson=@totalUsageJson WHERE id=@id`
    ).run({
      id,
      title: merged.title,
      updatedAt: merged.updatedAt,
      providerId: merged.providerId ?? null,
      model: merged.model ?? null,
      execution: merged.execution,
      presetId: merged.presetId ?? null,
      totalUsageJson: merged.totalUsage ? JSON.stringify(merged.totalUsage) : null
    })
    if (patch.messages) this.replaceMessages(id, patch.messages)
  },

  replaceMessages(conversationId: string, messages: StoredMessage[]): void {
    const d = initDb()
    const tx = d.transaction((msgs: StoredMessage[]) => {
      d.prepare('DELETE FROM messages WHERE conversationId = ?').run(conversationId)
      const stmt = d.prepare(
        `INSERT INTO messages (id,conversationId,role,text,contentJson,toolCallsJson,usageJson,errorJson,createdAt,seq)
         VALUES (@id,@conversationId,@role,@text,@contentJson,@toolCallsJson,@usageJson,@errorJson,@createdAt,@seq)`
      )
      msgs.forEach((m, i) =>
        stmt.run({
          id: m.id,
          conversationId,
          role: m.role,
          text: m.text,
          contentJson: m.contentJson ?? null,
          toolCallsJson: m.toolCallsJson ?? null,
          usageJson: m.usage ? JSON.stringify(m.usage) : null,
          errorJson: m.error ? JSON.stringify(m.error) : null,
          createdAt: m.createdAt,
          seq: i
        })
      )
    })
    tx(messages)
  },

  delete(id: string): void {
    initDb().prepare('DELETE FROM conversations WHERE id = ?').run(id)
  }
}

function toSummary(c: Record<string, unknown>): ConversationSummary {
  return {
    id: c.id as string,
    title: c.title as string,
    createdAt: c.createdAt as number,
    updatedAt: c.updatedAt as number,
    providerId: (c.providerId as string) ?? undefined,
    model: (c.model as string) ?? undefined,
    execution: (c.execution as ConversationSummary['execution']) ?? 'cloud',
    messageCount: Number(c.messageCount ?? 0)
  }
}

function toMessage(m: Record<string, unknown>): StoredMessage {
  return {
    id: m.id as string,
    role: m.role as StoredMessage['role'],
    text: m.text as string,
    contentJson: (m.contentJson as string) ?? undefined,
    toolCallsJson: (m.toolCallsJson as string) ?? undefined,
    usage: m.usageJson ? JSON.parse(m.usageJson as string) : undefined,
    error: m.errorJson ? JSON.parse(m.errorJson as string) : undefined,
    createdAt: m.createdAt as number
  }
}

// --- Presets ---
export const presetRepo = {
  list(): Preset[] {
    return initDb()
      .prepare('SELECT json FROM presets')
      .all()
      .map((r) => JSON.parse((r as { json: string }).json) as Preset)
  },
  save(p: Preset): void {
    initDb()
      .prepare('INSERT INTO presets (id, json) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET json=excluded.json')
      .run(p.id, JSON.stringify(p))
  },
  delete(id: string): void {
    initDb().prepare('DELETE FROM presets WHERE id = ?').run(id)
  }
}

// --- Usage / cost ---
export const usageRepo = {
  record(r: UsageRecord): void {
    initDb()
      .prepare(
        `INSERT INTO usage_records (id,ts,providerId,model,execution,inputTokens,outputTokens,totalTokens,estimatedCost,currency)
         VALUES (@id,@ts,@providerId,@model,@execution,@inputTokens,@outputTokens,@totalTokens,@estimatedCost,@currency)`
      )
      .run(r)
  },
  summary(now = Date.now()): UsageSummary {
    const d = initDb()
    const dayAgo = now - 24 * 3600_000
    const weekAgo = now - 7 * 24 * 3600_000
    const monthAgo = now - 30 * 24 * 3600_000
    const sum = (since: number): number =>
      (d.prepare('SELECT COALESCE(SUM(estimatedCost),0) AS s FROM usage_records WHERE ts >= ?').get(since) as {
        s: number
      }).s
    const byProvider: Record<string, number> = {}
    for (const row of d
      .prepare('SELECT providerId, SUM(estimatedCost) AS s FROM usage_records GROUP BY providerId')
      .all() as Array<{ providerId: string; s: number }>) {
      byProvider[row.providerId] = row.s
    }
    const byModel: Record<string, number> = {}
    for (const row of d
      .prepare('SELECT model, SUM(estimatedCost) AS s FROM usage_records GROUP BY model')
      .all() as Array<{ model: string; s: number }>) {
      byModel[row.model] = row.s
    }
    return { today: sum(dayAgo), week: sum(weekAgo), month: sum(monthAgo), currency: 'USD', byProvider, byModel }
  }
}

// --- Logs ---
export const logRepo = {
  append(entry: LogEntry): void {
    initDb().prepare('INSERT INTO logs (ts, level, json) VALUES (?, ?, ?)').run(entry.ts, entry.level, JSON.stringify(entry))
  },
  recent(limit = 500): LogEntry[] {
    return initDb()
      .prepare('SELECT json FROM logs ORDER BY id DESC LIMIT ?')
      .all(limit)
      .map((r) => JSON.parse((r as { json: string }).json) as LogEntry)
  }
}

// --- Benchmarks ---
export const benchmarkRepo = {
  save(id: string, modelId: string, result: unknown): void {
    initDb()
      .prepare('INSERT INTO benchmarks (id, modelId, ts, json) VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET json=excluded.json')
      .run(id, modelId, Date.now(), JSON.stringify(result))
  },
  list(modelId?: string): unknown[] {
    const d = initDb()
    const rows = modelId
      ? (d.prepare('SELECT json FROM benchmarks WHERE modelId = ? ORDER BY ts DESC').all(modelId) as Array<{ json: string }>)
      : (d.prepare('SELECT json FROM benchmarks ORDER BY ts DESC').all() as Array<{ json: string }>)
    return rows.map((r) => JSON.parse(r.json))
  }
}
