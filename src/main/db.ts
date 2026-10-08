import Database from 'better-sqlite3'
import { dbPath } from './paths'
import { normalizeMessageTranscriptJson } from '@shared/messageTranscript'
import { cleanPeerIds } from '@shared/peers'
import type {
  Conversation,
  ConversationComposer,
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

/** Checkpoint the WAL and close the handle cleanly on app quit. */
export function closeDb(): void {
  if (!db) return
  try {
    db.pragma('wal_checkpoint(TRUNCATE)')
    db.close()
  } catch {
    /* best-effort on shutdown */
  }
  db = null
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

  // --- Incremental migrations (additive columns on existing installs) ---
  const cols = d.prepare('PRAGMA table_info(conversations)').all() as Array<{ name: string }>
  const hasCol = (name: string): boolean => cols.some((c) => c.name === name)
  if (!hasCol('workspacePath')) {
    // Conversations belong to a project folder so the sidebar can group them.
    d.exec('ALTER TABLE conversations ADD COLUMN workspacePath TEXT')
  }
  if (!hasCol('pinned')) {
    // Pin a conversation to float it into the sidebar's Pinned section.
    d.exec('ALTER TABLE conversations ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0')
  }
  if (!hasCol('archived')) {
    // Archived conversations drop out of the main list into a collapsed section.
    d.exec('ALTER TABLE conversations ADD COLUMN archived INTEGER NOT NULL DEFAULT 0')
  }
  if (!hasCol('contextStartMessageId')) {
    // Compaction only changes model input; it must never delete the transcript.
    d.exec('ALTER TABLE conversations ADD COLUMN contextStartMessageId TEXT')
  }
  if (!hasCol('contextSummary')) {
    // Generated summary of the messages before the boundary; read and cleared together with it.
    d.exec('ALTER TABLE conversations ADD COLUMN contextSummary TEXT')
  }
  if (!hasCol('contextSummaryAt')) {
    d.exec('ALTER TABLE conversations ADD COLUMN contextSummaryAt INTEGER')
  }
  if (!hasCol('composerJson')) {
    // Each conversation keeps its own effort, long-context choice and answer cap next to its model.
    d.exec('ALTER TABLE conversations ADD COLUMN composerJson TEXT')
  }
  const messageCols = d.prepare('PRAGMA table_info(messages)').all() as Array<{ name: string }>
  if (!messageCols.some((column) => column.name === 'uiTranscriptJson')) {
    d.exec('ALTER TABLE messages ADD COLUMN uiTranscriptJson TEXT')
  }
  // Cost provenance and per-task spend. Rows saved before this read as 'estimated' with no task.
  const usageCols = d.prepare('PRAGMA table_info(usage_records)').all() as Array<{ name: string }>
  const hasUsageCol = (name: string): boolean => usageCols.some((column) => column.name === name)
  if (!hasUsageCol('costSource')) d.exec("ALTER TABLE usage_records ADD COLUMN costSource TEXT NOT NULL DEFAULT 'estimated'")
  if (!hasUsageCol('conversationId')) d.exec('ALTER TABLE usage_records ADD COLUMN conversationId TEXT')
  if (!hasUsageCol('cacheReadTokens')) d.exec('ALTER TABLE usage_records ADD COLUMN cacheReadTokens INTEGER')
  if (!hasUsageCol('cacheWriteTokens')) d.exec('ALTER TABLE usage_records ADD COLUMN cacheWriteTokens INTEGER')
  d.exec('CREATE INDEX IF NOT EXISTS idx_usage_conversation ON usage_records(conversationId)')
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
      workspacePath: (c.workspacePath as string) ?? undefined,
      pinned: !!c.pinned,
      archived: !!c.archived,
      contextStartMessageId: (c.contextStartMessageId as string) ?? undefined,
      contextSummary: (c.contextSummary as string) ?? undefined,
      contextSummaryAt: (c.contextSummaryAt as number) ?? undefined,
      ...(parseComposer(c.composerJson) ? { composer: parseComposer(c.composerJson)! } : {}),
      totalUsage: c.totalUsageJson ? JSON.parse(c.totalUsageJson as string) : undefined,
      messages: msgs.map(toMessage)
    }
  },

  create(conv: Conversation): void {
    const d = initDb()
    // One transaction: a failed message insert must not leave an empty conversation behind.
    d.transaction(() => this.insertConversation(d, conv))()
  },

  insertConversation(d: ReturnType<typeof initDb>, conv: Conversation): void {
    d.prepare(
      `INSERT INTO conversations (id,title,createdAt,updatedAt,providerId,model,execution,presetId,composerJson,workspacePath,pinned,archived,totalUsageJson,contextStartMessageId,contextSummary,contextSummaryAt)
       VALUES (@id,@title,@createdAt,@updatedAt,@providerId,@model,@execution,@presetId,@composerJson,@workspacePath,@pinned,@archived,@totalUsageJson,@contextStartMessageId,@contextSummary,@contextSummaryAt)`
    ).run({
      id: conv.id,
      title: conv.title,
      createdAt: conv.createdAt,
      updatedAt: conv.updatedAt,
      providerId: conv.providerId ?? null,
      model: conv.model ?? null,
      execution: conv.execution,
      presetId: conv.presetId ?? null,
      composerJson: composerJson(conv.composer),
      workspacePath: conv.workspacePath ?? null,
      pinned: conv.pinned ? 1 : 0,
      archived: conv.archived ? 1 : 0,
      contextStartMessageId: conv.contextStartMessageId ?? null,
      // A summary describes what precedes the boundary, so it is never stored without one.
      contextSummary: conv.contextStartMessageId ? conv.contextSummary ?? null : null,
      contextSummaryAt: conv.contextStartMessageId && conv.contextSummary ? conv.contextSummaryAt ?? null : null,
      totalUsageJson: conv.totalUsage ? JSON.stringify(conv.totalUsage) : null
    })
    this.replaceMessages(conv.id, conv.messages)
  },

  update(id: string, patch: Partial<Conversation>): void {
    const d = initDb()
    const existing = this.get(id)
    if (!existing) return
    // Choosing a model is not activity: it must not lift an old chat to the top of the sidebar.
    const activity = Object.keys(patch).some((key) => !SELECTION_KEYS.has(key))
    const merged = { ...existing, ...patch, updatedAt: activity ? Date.now() : existing.updatedAt }
    d.prepare(
      `UPDATE conversations SET title=@title, updatedAt=@updatedAt, providerId=@providerId,
        model=@model, execution=@execution, presetId=@presetId, composerJson=@composerJson, workspacePath=@workspacePath,
        pinned=@pinned, archived=@archived, totalUsageJson=@totalUsageJson,
        contextStartMessageId=@contextStartMessageId, contextSummary=@contextSummary,
        contextSummaryAt=@contextSummaryAt WHERE id=@id`
    ).run({
      id,
      title: merged.title,
      updatedAt: merged.updatedAt,
      providerId: merged.providerId ?? null,
      model: merged.model ?? null,
      execution: merged.execution,
      presetId: merged.presetId ?? null,
      composerJson: composerJson(merged.composer),
      workspacePath: merged.workspacePath ?? null,
      pinned: merged.pinned ? 1 : 0,
      archived: merged.archived ? 1 : 0,
      contextStartMessageId: merged.contextStartMessageId ?? null,
      // Clearing the boundary (restore full context, /clear) clears its summary too.
      contextSummary: merged.contextStartMessageId ? merged.contextSummary ?? null : null,
      contextSummaryAt: merged.contextStartMessageId && merged.contextSummary ? merged.contextSummaryAt ?? null : null,
      totalUsageJson: merged.totalUsage ? JSON.stringify(merged.totalUsage) : null
    })
    if (patch.messages) this.replaceMessages(id, patch.messages)
  },

  replaceMessages(conversationId: string, messages: StoredMessage[]): void {
    const d = initDb()
    const tx = d.transaction((msgs: StoredMessage[]) => {
      d.prepare('DELETE FROM messages WHERE conversationId = ?').run(conversationId)
      const stmt = d.prepare(
        `INSERT INTO messages (id,conversationId,role,text,contentJson,toolCallsJson,uiTranscriptJson,usageJson,errorJson,createdAt,seq)
         VALUES (@id,@conversationId,@role,@text,@contentJson,@toolCallsJson,@uiTranscriptJson,@usageJson,@errorJson,@createdAt,@seq)`
      )
      msgs.forEach((m, i) =>
        stmt.run({
          id: m.id,
          conversationId,
          role: m.role,
          text: m.text,
          contentJson: m.contentJson ?? null,
          toolCallsJson: m.toolCallsJson ?? null,
          uiTranscriptJson: normalizeMessageTranscriptJson(m.uiTranscriptJson) ?? null,
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

/** The conversation fields that record what was chosen for it, not what happened in it. */
const SELECTION_KEYS: ReadonlySet<string> = new Set(['providerId', 'model', 'presetId', 'composer', 'execution'])

const EFFORTS: readonly string[] = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']

/** The composer settings as stored: only known fields of the right type, so a bad value never reaches a request. */
function cleanComposer(value: unknown): ConversationComposer | undefined {
  if (!value || typeof value !== 'object') return undefined
  const raw = value as Record<string, unknown>
  const out: ConversationComposer = {}
  if (typeof raw.effort === 'string' && EFFORTS.includes(raw.effort)) out.effort = raw.effort as ConversationComposer['effort']
  if (typeof raw.longContext === 'boolean') out.longContext = raw.longContext
  const peers = cleanPeerIds(raw.peers)
  if (peers) out.peers = peers
  if (typeof raw.maxTokens === 'number' && Number.isInteger(raw.maxTokens) && raw.maxTokens >= 0 && raw.maxTokens <= 2_000_000) out.maxTokens = raw.maxTokens
  return Object.keys(out).length > 0 ? out : undefined
}

function composerJson(value: unknown): string | null {
  const clean = cleanComposer(value)
  return clean ? JSON.stringify(clean) : null
}

function parseComposer(json: unknown): ConversationComposer | undefined {
  if (typeof json !== 'string' || !json) return undefined
  try {
    return cleanComposer(JSON.parse(json))
  } catch {
    return undefined
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
    workspacePath: (c.workspacePath as string) ?? undefined,
    pinned: !!c.pinned,
    archived: !!c.archived,
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
    uiTranscriptJson: normalizeMessageTranscriptJson(m.uiTranscriptJson),
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
/** What the ledger holds for one provider, model, place and kind of price figure over some period. */
export interface UsageGroup {
  providerId: string
  model: string
  execution: string
  costSource: string
  requests: number
  cost: number
  tokens: number
}

export const usageRepo = {
  record(r: UsageRecord): void {
    initDb()
      .prepare(
        `INSERT INTO usage_records (id,ts,providerId,model,execution,inputTokens,outputTokens,totalTokens,estimatedCost,currency,costSource,conversationId,cacheReadTokens,cacheWriteTokens)
         VALUES (@id,@ts,@providerId,@model,@execution,@inputTokens,@outputTokens,@totalTokens,@estimatedCost,@currency,@costSource,@conversationId,@cacheReadTokens,@cacheWriteTokens)`
      )
      .run({
        ...r,
        costSource: r.costSource ?? 'estimated',
        conversationId: r.conversationId ?? null,
        cacheReadTokens: r.cacheReadTokens ?? null,
        cacheWriteTokens: r.cacheWriteTokens ?? null
      })
  },
  /** Money spent since a moment, for everything or for one task. Budget checks read this; `summary` still feeds the sidebar. */
  spendSince(since: number, conversationId?: string): number {
    const d = initDb()
    const row = (conversationId === undefined
      ? d.prepare('SELECT COALESCE(SUM(estimatedCost),0) AS s FROM usage_records WHERE ts >= ?').get(since)
      : d.prepare('SELECT COALESCE(SUM(estimatedCost),0) AS s FROM usage_records WHERE ts >= ? AND conversationId = ?').get(since, conversationId)
    ) as { s: number }
    return row.s
  },
  /**
   * What each provider and model cost since a moment, split by where it ran and by how the price was known,
   * so the usage view can say which figures are estimates. One row per combination.
   */
  breakdownSince(since: number): UsageGroup[] {
    return initDb()
      .prepare(
        `SELECT providerId, model, execution, costSource, COUNT(*) AS requests,
                COALESCE(SUM(estimatedCost),0) AS cost, COALESCE(SUM(totalTokens),0) AS tokens
         FROM usage_records WHERE ts >= ? GROUP BY providerId, model, execution, costSource`
      )
      .all(since) as UsageGroup[]
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
    // The limit comes over IPC; SQLite treats LIMIT -1 as "everything".
    const bounded = Number.isInteger(limit) ? Math.min(Math.max(limit, 1), 5000) : 500
    return initDb()
      .prepare('SELECT json FROM logs ORDER BY id DESC LIMIT ?')
      .all(bounded)
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
