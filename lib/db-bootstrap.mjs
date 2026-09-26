import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

const SESSION_COLUMNS = [
  ['parent_id', 'TEXT'],
  ['label', 'TEXT'],
  ['model', 'TEXT'],
  ['tokens_in', 'INTEGER DEFAULT 0'],
  ['tokens_out', 'INTEGER DEFAULT 0'],
  ['cost_usd', 'REAL DEFAULT 0'],
  ['status', "TEXT DEFAULT 'idle'"],
  ['task_preview', 'TEXT'],
  ['started_at', 'INTEGER'],
  ['ended_at', 'INTEGER'],
  ['updated_at', 'INTEGER'],
  ['trello_card_url', 'TEXT'],
];

const LINEAGE_COLUMNS = [
  ['agent_name', 'TEXT'],
  ['label', 'TEXT'],
];

function ensureParentDir(dbPath) {
  const dir = path.dirname(dbPath);
  if (!dir || dir === '.') return;
  fs.mkdirSync(dir, { recursive: true });
}

function addMissingColumns(db, tableName, columns) {
  const existing = new Set(db.prepare(`PRAGMA table_info(${tableName})`).all().map((col) => col.name));
  for (const [name, type] of columns) {
    if (!existing.has(name)) {
      db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${name} ${type}`);
    }
  }
}

export function initializeRev4aDb(dbPath) {
  ensureParentDir(dbPath);
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      session_id TEXT PRIMARY KEY,
      parent_id TEXT,
      label TEXT,
      model TEXT,
      tokens_in INTEGER DEFAULT 0,
      tokens_out INTEGER DEFAULT 0,
      cost_usd REAL DEFAULT 0,
      status TEXT DEFAULT 'idle',
      task_preview TEXT,
      started_at INTEGER,
      ended_at INTEGER,
      updated_at INTEGER,
      trello_card_url TEXT
    );

    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      session_id TEXT NOT NULL,
      type TEXT NOT NULL,
      data TEXT
    );

    CREATE TABLE IF NOT EXISTS tool_calls (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      session_id TEXT NOT NULL,
      tool_name TEXT,
      status TEXT,
      duration_ms INTEGER,
      data TEXT
    );

    CREATE TABLE IF NOT EXISTS lineage (
      child_id TEXT PRIMARY KEY,
      parent_id TEXT NOT NULL,
      declared_at INTEGER NOT NULL,
      agent_name TEXT,
      label TEXT
    );

    CREATE TABLE IF NOT EXISTS cost_override (
      month TEXT PRIMARY KEY,
      amount REAL,
      note TEXT,
      updated_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS alert_state (
      alert_key TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      state TEXT NOT NULL,
      last_sent_at INTEGER,
      last_resolved_at INTEGER,
      updated_at INTEGER NOT NULL,
      payload TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id, ts);
    CREATE INDEX IF NOT EXISTS idx_sessions_updated ON sessions(updated_at);
    CREATE INDEX IF NOT EXISTS idx_sessions_started ON sessions(started_at);
    CREATE INDEX IF NOT EXISTS idx_tool_calls_session ON tool_calls(session_id, ts);
    CREATE INDEX IF NOT EXISTS idx_alert_state_updated ON alert_state(updated_at);
  `);

  addMissingColumns(db, 'sessions', SESSION_COLUMNS);
  addMissingColumns(db, 'lineage', LINEAGE_COLUMNS);

  // Chat messages table
  db.exec(`
    CREATE TABLE IF NOT EXISTS chat_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      user_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      openclaw_session_id TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_chat_user ON chat_messages(user_id, ts);
  `);

  addMissingColumns(db, 'chat_messages', [
    ['model', 'TEXT'],
  ]);

  // Agent updates: one row per attempt to move an agent to a newer OpenClaw version
  // (lib/agent-update.ts). It answers, after any restart, where an update stopped and
  // which archive restores the agent.
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_upgrades (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id TEXT NOT NULL,
      status TEXT NOT NULL,
      from_version TEXT,
      to_version TEXT NOT NULL,
      backup_file TEXT,
      baseline_json TEXT,
      verify_json TEXT,
      error TEXT,
      started_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      finished_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_agent_upgrades_agent ON agent_upgrades(agent_id, started_at);
  `);

  // Recreate jobs (lib/agent-recreate.ts): same shape as an update minus the
  // migration — a cold backup, the container rebuilt on the same version, the
  // gateway started again. Persisted so a reload or a Rev4a restart mid-way is
  // visible instead of lost, and so an interrupted job is marked at startup.
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_recreates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id TEXT NOT NULL,
      status TEXT NOT NULL,
      image TEXT,
      backup_file TEXT,
      error TEXT,
      started_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      finished_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_agent_recreates_agent ON agent_recreates(agent_id, started_at);
  `);


  // Restore jobs (lib/agent-restore.ts): the volume is replaced from an archive, so the
  // job is visible and survives a reload or a Rev4a restart like a recreate does.
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_restores (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id TEXT NOT NULL,
      status TEXT NOT NULL,
      file TEXT,
      error TEXT,
      started_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      finished_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_agent_restores_agent ON agent_restores(agent_id, started_at);
  `);


  // Edit jobs (lib/agent-edit.ts): the container is rebuilt with a new display name
  // and/or port range, no volume backup involved. Persisted like the others so a
  // reload or a Rev4a restart never loses track of it.
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_edits (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id TEXT NOT NULL,
      status TEXT NOT NULL,
      display_name TEXT,
      port_range TEXT,
      error TEXT,
      started_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      finished_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_agent_edits_agent ON agent_edits(agent_id, started_at);
  `);


  db.close();
}
