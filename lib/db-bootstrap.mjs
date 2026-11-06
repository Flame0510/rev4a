import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import agentSessions from './agent-sessions.js';

// Added after the table first shipped: guarded, so an existing database gets it once.
const AGENT_EDIT_COLUMNS = [
  ['memory_limit_removed', 'INTEGER'],
];

// Added after 1.21.1: an update that failed or was interrupted can be proved fine later (lib/agent-update-resolution.ts).
// Additive and guarded; `status` is never rewritten, so an older Rev4a reads the rows as before.
const AGENT_UPGRADE_COLUMNS = [
  ['resolved_at', 'INTEGER'],
  ['resolution', 'TEXT'],
  // Keep a retired-cron repair's evidence separate from the original verification.
  ['cron_repair_json', 'TEXT'],
  ['cron_account_json', 'TEXT'],
  ['cron_model_repair_claim', 'INTEGER'],
];

// Restore safety records are additive; old rows deliberately have no trusted phase.
const AGENT_RESTORE_COLUMNS = [
  ['preflight_json', 'TEXT'],
  ['recovery_file', 'TEXT'],
  ['phase', 'TEXT'],
  ['helper_name', 'TEXT'],
  ['source_directory', 'TEXT'],
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

/**
 * LIN-6: drops the host-poll `sessions` and `lineage` tables (nothing reads or writes them since 1.21;
 * Lineage reads `agent_sessions`). This is the only dropper: the daemon no longer creates them.
 * A no-op that takes no write lock when none of them exists (this runs on every openDb()); safe to
 * repeat and on a half-migrated file. No VACUUM: the freed pages are reused by later writes.
 */
function dropLegacyLineageTables(db) {
  const present = db.prepare("SELECT name FROM sqlite_master WHERE (type = 'table' AND name IN ('sessions', 'lineage')) OR (type = 'index' AND name IN ('idx_sessions_updated', 'idx_sessions_started'))").all();
  if (present.length === 0) return;
  const tables = present.filter((r) => r.name === 'sessions' || r.name === 'lineage');
  db.exec('DROP INDEX IF EXISTS idx_sessions_updated; DROP INDEX IF EXISTS idx_sessions_started; DROP TABLE IF EXISTS sessions; DROP TABLE IF EXISTS lineage;');
  if (tables.length > 0) console.log('Dropped the old sessions/lineage tables (Lineage reads agent_sessions since 1.21)');
}

/**
 * Creates or completes the schema. Every statement is idempotent and, on an initialised database,
 * writes nothing: openDb() runs this on every read, so a write here would take the write lock each time.
 * `options.timeout` is the busy timeout in ms (better-sqlite3's default when absent).
 */
export function initializeRev4aDb(dbPath, options = {}) {
  ensureParentDir(dbPath);
  const db = new Database(dbPath, typeof options.timeout === 'number' ? { timeout: options.timeout } : undefined);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      session_id TEXT NOT NULL,
      type TEXT NOT NULL,
      data TEXT
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
    CREATE INDEX IF NOT EXISTS idx_alert_state_updated ON alert_state(updated_at);
  `);

  dropLegacyLineageTables(db);

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
  addMissingColumns(db, 'agent_upgrades', AGENT_UPGRADE_COLUMNS);

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
  addMissingColumns(db, 'agent_restores', AGENT_RESTORE_COLUMNS);

  // Each update gets its own undo journal: rollback restores the same cron job IDs.
  db.exec(`CREATE TABLE IF NOT EXISTS cron_account_adoptions_by_update (
    container TEXT NOT NULL,
    update_id INTEGER NOT NULL,
    job_id TEXT NOT NULL,
    profile_id TEXT NOT NULL,
    original_model TEXT,
    temporary_model TEXT NOT NULL,
    finished_at INTEGER,
    superseded_at INTEGER,
    PRIMARY KEY (container, update_id, job_id)
  )`);
  addMissingColumns(db, 'cron_account_adoptions_by_update', [['superseded_at', 'INTEGER']]);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_cron_account_adoptions_by_update_pending
    ON cron_account_adoptions_by_update(container, update_id) WHERE finished_at IS NULL`);
  // Copy once, retaining the legacy table for rollback. The marker and copy commit together;
  // a partially copied evaluation DB keeps its newer rows and receives only missing records.
  const hasMigrations = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'rev4a_schema_migrations'").get();
  const cronMigrated = hasMigrations && db.prepare('SELECT 1 FROM rev4a_schema_migrations WHERE name = ?').get('cron_account_adoptions_by_update');
  if (!cronMigrated && db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'cron_account_adoptions'").get()) {
    db.transaction(() => {
      db.exec(`INSERT OR IGNORE INTO cron_account_adoptions_by_update
        (container, update_id, job_id, profile_id, original_model, temporary_model, finished_at)
        SELECT container, 0, job_id, profile_id, original_model, temporary_model, finished_at FROM cron_account_adoptions`);
      // A marker also handles files where a previous migration copied only some rows.
      db.exec('CREATE TABLE IF NOT EXISTS rev4a_schema_migrations (name TEXT PRIMARY KEY)');
      db.prepare('INSERT OR IGNORE INTO rev4a_schema_migrations (name) VALUES (?)').run('cron_account_adoptions_by_update');
    }).immediate();
  }


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
  addMissingColumns(db, 'agent_edits', AGENT_EDIT_COLUMNS);


  // Per-container copy of every agent's OpenClaw sessions, filled by the daemon (lib/agent-sessions.js).
  // The old sessions and lineage tables are dropped by dropLegacyLineageTables() (LIN-6).
  // The meta row is inserted only when missing: INSERT OR IGNORE takes the write lock even when it ignores.
  const metaInsert = /INSERT OR IGNORE INTO agent_sessions_meta[^;]*;/;
  db.exec(agentSessions.CREATE_TABLES_SQL.replace(metaInsert, ''));
  if (!db.prepare('SELECT 1 FROM agent_sessions_meta WHERE id = 1').get()) {
    db.exec((agentSessions.CREATE_TABLES_SQL.match(metaInsert) || ["INSERT OR IGNORE INTO agent_sessions_meta (id, version) VALUES (1, 1);"])[0]);
  }

  // Added after the table first shipped (context window of a session, for the spend alarms): guarded.
  agentSessions.ensureAddedColumns(db);

  db.close();
}
