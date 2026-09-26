# Rev4a — Database Reference

> **Last updated:** 2026-09-26

Rev4a keeps three SQLite files in WAL mode, by default all in the data directory's `data/`:
`events.db` (sessions and events, below), `metrics.db` (machine metrics, see
[Metrics Database](#metrics-database-metricsdb)) and `credentials.db` (see
[Credentials Database](#credentials-database-credentialsdb)).

## Location

| Environment | Path |
|---|---|
| Default | `~/.config/rev4a/data/events.db` (`$REV4A_DATA_DIR/data/events.db`) |
| Custom | Set `REV4A_DB` env var |

## WAL Mode

```sql
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
```

- The daemon writes; the Next.js API routes open read-only connections
- `events.db`: `PRAGMA wal_checkpoint(PASSIVE)` after each daemon poll cycle, `FULL` every 10
- `metrics.db`: SQLite's automatic checkpoint (every 1000 pages) — no explicit one
- WAL files (`*.db-shm`, `*.db-wal`) — do not delete while the daemon is running

## Tables

### `sessions` — primary session tracking

```sql
CREATE TABLE sessions (
  session_id   TEXT PRIMARY KEY,
  parent_id    TEXT,
  label        TEXT,
  model        TEXT,
  tokens_in    INTEGER DEFAULT 0,
  tokens_out   INTEGER DEFAULT 0,
  cost_usd     REAL    DEFAULT 0,
  status       TEXT    DEFAULT 'idle',
  task_preview TEXT,
  started_at   INTEGER,           -- Unix seconds
  ended_at     INTEGER,           -- Unix seconds, null if active
  updated_at   INTEGER,           -- Unix ms, updated only on real changes
  trello_card_url TEXT
);

CREATE INDEX idx_sessions_updated ON sessions(updated_at);
```

**Status values:** `idle` / `working` / `completed` / `error`

### `events` — lifecycle events

```sql
CREATE TABLE events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  ts         INTEGER NOT NULL,   -- Unix ms
  session_id TEXT    NOT NULL,
  type       TEXT    NOT NULL,   -- spawn | complete | error | tool_call
  data       TEXT                -- JSON payload
);

CREATE INDEX idx_events_session ON events(session_id, ts);
```

### `lineage` — explicit parent→child declarations

```sql
CREATE TABLE lineage (
  child_id    TEXT PRIMARY KEY,
  parent_id   TEXT,
  agent_name  TEXT,
  declared_at INTEGER            -- Unix ms
);
```

Populated by agents calling `lineage.js` at spawn time or via `POST /api/lineage`.

### `cost_override` — manual monthly billing corrections

```sql
CREATE TABLE cost_override (
  month      TEXT PRIMARY KEY,   -- YYYY-MM
  amount     REAL,
  note       TEXT,
  updated_at INTEGER             -- Unix ms
);
```

When a `cost_override` row exists for the current month, the UI displays the override value instead of the computed sum.

The daemon also writes a `system_anomaly` event (session `system`) when the machine
crosses a threshold — see [Metrics Database](#metrics-database-metricsdb). No feature
consumes those events yet; they only pass through the generic event feeds.

### `agent_upgrades` — agent updates and rollbacks

```sql
CREATE TABLE agent_upgrades (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id      TEXT NOT NULL,
  status        TEXT NOT NULL,   -- pending, backing_up, migrating, verifying, done, failed,
                                 -- interrupted, rolling_back, rolled_back, rollback_failed
  from_version  TEXT,
  to_version    TEXT NOT NULL,
  backup_file   TEXT,            -- pre-update cold backup in the rev4a-backups volume
  baseline_json TEXT,            -- transcript events per session and cron job names before
  verify_json   TEXT,            -- the comparison after the update
  error         TEXT,
  started_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  finished_at   INTEGER
);

CREATE INDEX idx_agent_upgrades_agent ON agent_upgrades(agent_id, started_at);
```

One row per update attempt (`lib/agent-update.ts`); a rollback moves the same row on to
`rolling_back`. Created by `lib/db-bootstrap.mjs`. At startup, rows still in an active
status are marked `interrupted`. Rows are never pruned.

### `agent_recreates` — agent recreates

```sql
CREATE TABLE agent_recreates (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id    TEXT NOT NULL,
  status      TEXT NOT NULL,   -- backing_up, recreating, done, failed, interrupted
  image       TEXT,            -- the image the container is rebuilt on
  backup_file TEXT,            -- pre-recreate cold backup in the rev4a-backups volume
  error       TEXT,
  started_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  finished_at INTEGER
);

CREATE INDEX idx_agent_recreates_agent ON agent_recreates(agent_id, started_at);
```

One row per recreate attempt (`lib/agent-recreate.ts`), the same-version counterpart of
an update: a cold backup, the container rebuilt, the gateway waited for. It is written
so a page reload or a Rev4a restart mid-way is visible instead of lost
(`GET /api/agents/[id]/recreate`). At startup, rows still in an active status become
`interrupted` and the agent is started again once its backup helper has finished. Rows
are never pruned.

### `agent_restores` — agent restores

```sql
CREATE TABLE agent_restores (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id    TEXT NOT NULL,
  status      TEXT NOT NULL,   -- restoring, done, failed, interrupted
  file        TEXT,            -- the archive being applied, in the rev4a-backups volume
  error       TEXT,
  started_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  finished_at INTEGER
);

CREATE INDEX idx_agent_restores_agent ON agent_restores(agent_id, started_at);
```

One row per restore attempt (`lib/agent-restore.ts`): the volume is replaced from the
archive. Persisted for the same reason as a recreate (`GET /api/agents/[id]/restore`),
and at startup an active row becomes `interrupted` with the container started again.
Rows are never pruned.

### `agent_edits` — agent renames and port changes

```sql
CREATE TABLE agent_edits (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id     TEXT NOT NULL,
  status       TEXT NOT NULL,   -- rebuilding, done, failed, interrupted
  display_name TEXT,            -- the name being applied, when it was a rename
  port_range   TEXT,            -- the range being applied, when it was a port change
  error        TEXT,
  started_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  finished_at  INTEGER
);

CREATE INDEX idx_agent_edits_agent ON agent_edits(agent_id, started_at);
```

One row per edit attempt (`lib/agent-edit.ts`): the container is rebuilt with the new
name/ports, no backup involved. Persisted for the same reason as the others
(`GET /api/agents/[id]`); at startup an active row becomes `interrupted` with the
container started again. Rows are never pruned.

## Useful Queries

```sql
-- Total cost this month
SELECT SUM(cost_usd) FROM sessions
WHERE started_at >= strftime('%s', date('now', 'start of month'));

-- Active sessions right now
SELECT session_id, label, model, status, cost_usd
FROM sessions WHERE status = 'working';

-- Cost by model (all time)
SELECT model, SUM(cost_usd) AS total, COUNT(*) AS sessions
FROM sessions GROUP BY model ORDER BY total DESC;

-- Last poll time (freshness check)
SELECT datetime(MAX(ts)/1000, 'unixepoch', 'localtime') AS last_event
FROM events;

-- Lineage tree for a session
WITH RECURSIVE tree(child_id, parent_id, agent_name, depth) AS (
  SELECT child_id, parent_id, agent_name, 0 FROM lineage WHERE child_id = 'agent:ops:main'
  UNION ALL
  SELECT l.child_id, l.parent_id, l.agent_name, t.depth + 1
  FROM lineage l JOIN tree t ON l.parent_id = t.child_id
)
SELECT * FROM tree;
```

## Backup

```bash
# Everything Rev4a owns: the whole data directory (.env, data/, shared/)
bash scripts/backup.sh                    # -> ~/rev4a-backups/rev4a-backup-<UTC time>.tar.gz
bash scripts/restore.sh ~/rev4a-backups/rev4a-backup-<UTC time>.tar.gz

# One database only, consistent while Rev4a runs (needs the sqlite3 CLI)
sqlite3 ~/.config/rev4a/data/events.db ".backup events-$(date +%s).db"
```

`backup.sh` archives the Rev4a data directory (`$REV4A_DATA_DIR`, default
`~/.config/rev4a`) whole, so a new file there is included without changing the script.
The archive (mode 0600, directory 0700) holds every secret in plain text; keep a copy
off the machine. `restore.sh` refuses an archive with links in it and a running
`rev4a serve`, archives the current state into `~/rev4a-backups` first, stops
`rev4a.service` when it runs, and replaces the data directory as a whole (a leftover
SQLite `-wal` cannot mix into the restored state), then resets the permissions. Agent volumes are not included —
the dashboard's cold backups cover them.

## Metrics Database (`metrics.db`)

Machine metrics of the host — CPU, RAM, swap, storage — kept apart from `events.db`, so
the event log holds sessions and events only and the history can be dropped on its own.

**Location:** `data/metrics.db`, next to `events.db` (it follows `REV4A_DB`'s directory; both
the daemon and the API resolve the data directory the same way, `REV4A_DATA_DIR` included).
**Created by** the daemon when it starts (`CREATE TABLE IF NOT EXISTS`), which is also its
only writer; `GET /api/metrics` and `GET /api/system-health` read it
(`lib/metrics-db.ts`). Until the daemon has run once the file does not exist, and the
API answers with `latest: null`. If the daemon cannot open it (corrupt, unwritable), it
logs `[METRICS] disabled` and keeps polling sessions without sampling.
**Sampling:** the first sample about 5 s after the daemon starts, then every 30 s, on a timer
of its own — independent of the OpenClaw session poll.
**Retention:** 30 days, pruned at every sample: ~86 400 `system_metrics` rows, and one
`system_disks` row per filesystem per sample (up to ~259 200 for three).

```sql
CREATE TABLE system_metrics (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  ts            INTEGER NOT NULL,   -- Unix seconds
  cpu_percent   REAL,               -- all cores, busy share since the previous sample
  ram_used_mb   INTEGER,            -- total − available (Linux), as `free` shows it
  ram_total_mb  INTEGER,
  swap_used_mb  INTEGER,            -- NULL where there is no swap figure
  swap_total_mb INTEGER,
  load_avg_1m   REAL,
  load_avg_5m   REAL,
  load_avg_15m  REAL
);
CREATE INDEX idx_metrics_ts ON system_metrics(ts);

-- One row per filesystem per sample: `/`, Docker's data root and Rev4a's data directory,
-- each device once; roles lists which of them it is (e.g. 'root,docker,data').
CREATE TABLE system_disks (
  ts       INTEGER NOT NULL,        -- the same ts as the system_metrics row
  mount    TEXT NOT NULL,
  roles    TEXT,
  used_mb  INTEGER,                 -- blocks − free
  avail_mb INTEGER,                 -- what a normal user can still write
  total_mb INTEGER
);
CREATE INDEX idx_disks_ts ON system_disks(ts);
CREATE INDEX idx_disks_mount_ts ON system_disks(mount, ts);
```

**Anomalies** go to `events.db` as `system_anomaly` events: CPU above 85 % or RAM above
90 % on two consecutive samples (at most once per 5 minutes per metric), and a filesystem
at 90 % or more once when it reaches the threshold, with no cooldown (again only after it
has dropped back under, or once after each daemon start: the state is kept in memory).

Installs from before this database may still have a `system_metrics` table in
`events.db`: nothing reads or writes it any more, and it can be dropped.

## Credentials Database (`credentials.db`)

The credential hub uses a **separate SQLite file** (`credentials.db`) alongside
events.db in the same data directory. It stores credentials that can be synced
to agent containers via CLI auth or env files.

**Location:** `data/credentials.db` (same directory as `events.db`)
**Custom path:** Set `REV4A_CREDENTIALS_DB` env var to override.
**WAL mode:** Enabled.

### `credential_profiles` — credential hub metadata

```sql
CREATE TABLE credential_profiles (
  id TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL,
  label TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  secret_masked TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_synced_at INTEGER
);
```

### `credential_secrets` — stored secret payloads

```sql
CREATE TABLE credential_secrets (
  profile_id TEXT PRIMARY KEY,
  payload TEXT NOT NULL
);
```

`payload` holds the secret as raw JSON — **not encrypted**. Anything that can read
this file, or reach `POST /api/credentials/[id]/reveal` with a valid session, has
the secrets in the clear.

### `credential_audit_log` — append-only audit trail

```sql
CREATE TABLE credential_audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  profile_id TEXT,
  result TEXT
);
```

Actions: `create`, `update`, `delete`, `sync`, `desync`, `reveal`.

Nothing reads `credential_audit_log`: it is written by `appendAudit()` and exposed
through no route or view.

---

## Migrations

The daemon applies these migrations safely at startup:

```sql
ALTER TABLE sessions ADD COLUMN trello_card_url TEXT;  -- idempotent
ALTER TABLE sessions ADD COLUMN ended_at INTEGER;       -- idempotent
```

For future schema changes, add a `try/catch` ALTER TABLE block in `daemon.js` following the same pattern.

## Integrity Check

```bash
sqlite3 events.db "PRAGMA quick_check"
# Expected output: ok
```

**Current location on VPS:** `/path/to/rev4a/data/events.db`

The `REV4A_DB` env var is set in the systemd override file at `/etc/systemd/system/rev4a.service.d/env.conf`.
