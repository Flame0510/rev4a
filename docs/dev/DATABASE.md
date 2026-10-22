# Rev4a — Database Reference

> **Last updated:** 2026-10-10

Rev4a keeps four SQLite files in WAL mode, by default all in the data directory's `data/`:
`events.db` (sessions and events, below), `metrics.db` (machine and container metrics, see
[Metrics Database](#metrics-database-metricsdb)), `costs.db` (what the agents spent, see
[Costs Database](#costs-database-costsdb)) and `credentials.db` (see
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
- `metrics.db`, `costs.db`: SQLite's automatic checkpoint (every 1000 pages) — no explicit one
- WAL files (`*.db-shm`, `*.db-wal`) — do not delete while the daemon is running

## Tables

### `sessions` — primary session tracking (legacy)

No longer written: the daemon fills `agent_sessions` instead. Kept untouched so a rollback still finds it.

```sql
CREATE TABLE sessions (
  session_id   TEXT PRIMARY KEY,
  parent_id    TEXT,
  label        TEXT,
  model        TEXT,
  tokens_in    INTEGER DEFAULT 0,
  tokens_out   INTEGER DEFAULT 0,
  cost_usd     REAL    DEFAULT 0,  -- always 0 since 2026-09-27: agent costs are in costs.db
  status       TEXT    DEFAULT 'idle',
  task_preview TEXT,
  started_at   INTEGER,           -- Unix ms
  ended_at     INTEGER,           -- Unix ms, null if active
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
  type       TEXT    NOT NULL,   -- see below
  data       TEXT                -- JSON payload
);

CREATE INDEX idx_events_session ON events(session_id, ts);
```

Types written today: `session_started`, `subagent_spawned`, `session_ended`, `session_failed`, `session_aborted` (the daemon's session collector; `data` carries the `container`). Older installs also hold `spawn`, `complete`, `fail`, `spawn_timeout` from the previous host poll, which age out by the 30-day rule below.
`system_anomaly` (the daemon's machine and container metrics, session `system`), `agent_created` and
`agent_deleted` (the create and delete routes, session `system:agents`).

**Retention:** two rules. The session collector deletes the cron-session events it wrote (`session_*`, `subagent_spawned`) older than 7 days; events of the older format are left to the 30-day rule. On
its own timer the daemon deletes every event older than 30 days, whatever its type or session
(`lib/events-retention.js`, `pruneEvents`): first pass about 10 s after start, then every 6
hours, in batches of at most 5 000 rows, so other writers (in WAL mode readers are never blocked) wait only for one batch. A pass deletes at
most 100 000 rows; when it hits that limit, the next pass runs after 60 s instead of 6 h, until
the backlog is gone. A row exactly at the cutoff stays. This timer needs only `events.db`, so it runs on hosts with no OpenClaw and
when `metrics.db` failed to open. On a development machine with a nearly full disk,
`system_anomaly` reached ~4 000 rows in a month.

### `agent_sessions` — the agents' sessions, per container

Written by the daemon only (`lib/agent-sessions.js`, created by the daemon and by `initializeRev4aDb`,
`CREATE TABLE … IF NOT EXISTS`). Primary key `(container, session_key)`, so two agents both have
`agent:main:main`. `container` is the value `costs.db` uses.

```sql
CREATE TABLE agent_sessions (
  container TEXT NOT NULL, session_key TEXT NOT NULL, agent_name TEXT, session_id TEXT,
  kind TEXT,          -- main|subagent|cron|cron_run|explicit|custom|direct|dashboard
  parent_key TEXT,    -- spawnedBy ?? parentSessionKey (a cron run: its job)
  parent_kind TEXT,   -- 'spawn' (real lineage) | 'cron' | 'nav' (navigation only)
  spawn_depth INTEGER, label TEXT,
  status TEXT,        -- running|done|failed|aborted|''
  last_error TEXT, model TEXT, provider TEXT,
  input_tokens INTEGER, output_tokens INTEGER, total_tokens INTEGER,
  cost_usd REAL,      -- OpenClaw's estimate; NULL when unknown, never 0 for unknown
  cron_job_id TEXT,
  started_at INTEGER, updated_at INTEGER, ended_at INTEGER, archived_at INTEGER,  -- Unix ms
  last_seen_at INTEGER, gone_at INTEGER,
  PRIMARY KEY (container, session_key)
);
-- indexes (container, updated_at) and (container, parent_key)
CREATE TABLE agent_sessions_meta (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL);
```

`agent_sessions_meta.version` is bumped by every collector pass that changed something. The
collector writes the events `session_started`, `subagent_spawned` (`data.parent_key`),
`session_ended`, `session_failed` and `session_aborted` into `events` (`session_id` = the
session key, `data.container` = the container). A session that finished and starts a new turn writes `session_started` again; a cron job's own row writes no event (its runs do). A listing is marked complete only when its distinct session keys reach the largest `totalCount` the agent reported; otherwise no row is marked gone. On start, rows of containers that are no longer running get `gone_at`. Retention: rows not returned by any listing for 30 days (`last_seen_at`), cron runs and cron job rows 7 days; a row the agent still lists is never deleted. `/api/stream` rebuilds and sends the sessions frame only when `version` changes or when `costs.db` `agent_cost_sessions` changes (one `COUNT`/`TOTAL(cost)` read per poll; costs are filled at read time), with the same window and cap (2,000) as `GET /api/sessions`. `cost_usd` is NULL when OpenClaw did not price the session (never 0); `GET /api/sessions` fills a NULL from `costs.db` `agent_cost_sessions` by `(container, session_id)` when that row has a cost above 0.

### `lineage` — explicit parent→child declarations (legacy)

```sql
CREATE TABLE lineage (
  child_id    TEXT PRIMARY KEY,
  parent_id   TEXT,
  agent_name  TEXT,
  declared_at INTEGER            -- Unix ms
);
```

Legacy: no longer written since the `agent_sessions` collector, and no longer read by the API (the previous version still reads it, so it stays until a later release drops it).

The daemon also writes a `system_anomaly` event (session `system`) when the machine
crosses a threshold — see [Metrics Database](#metrics-database-metricsdb). The System
page's Recent alerts reads them (`GET /api/metrics/alerts`); otherwise they only pass through
the generic event feeds.

### Removed dead tables

Removed on 2026-10-06: `tool_calls` and `chat_messages` were created by
`lib/db-bootstrap.mjs` but never written by any code (`GET /api/tool-calls` always returned an
empty list); `cost_override` was written only by its own API, which no page used. The two
routes are gone. New installs no longer create them. Older databases
still contain them; nothing reads them.

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
  memory_limit_removed INTEGER, -- 1 when the edit removed the memory limit; NULL on older rows
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

`memory_limit_removed` was added later: `initializeRev4aDb()` adds it to an existing table with a guarded `ALTER TABLE … ADD COLUMN` (safe to run twice), and rows from before read as not removed. A previous Rev4a ignores the column and the file, so the data itself runs on it; but a rebuild by the previous Rev4a does not carry an agent's memory limit, so an agent with a limit loses it when an older version recreates, updates or edits it.

### `agent-defaults.json` — defaults for new agents

An optional file in the root of the Rev4a data directory, next to `.env`. It is written as `{ "memoryLimitMb": 2048 }`, or `{ "memoryLimitMb": null }` for no default. It only prefills the create wizard; nothing reads it to change an existing agent. A missing, unreadable or invalid file reads as `null` and never raises. Written with mode `0600` through a temp file and a rename (`lib/agent-defaults.ts`).

### `settings.json` — application settings

An optional file in the root of the Rev4a data directory, next to `.env`: `{ "timezone": "Europe/Rome" }`. The time zone is read by every dashboard page; with no file (or no valid zone in it) the zone comes from `REV4A_TIMEZONE` when that holds a valid zone, and otherwise it is the server's own zone (saved, then `REV4A_TIMEZONE`, then the server zone). A missing, unreadable or invalid file never raises. Written through a temp file and a rename (`lib/rev4a-settings.ts`). The first read imports the zone from the old `/data/rev4a/settings.json` (where the removed Tools page kept it) when the new file does not exist yet and the old one holds a valid zone; the old file is never changed.

## Useful Queries

```sql
-- costs.db: what the agents spent this month (UTC days), by agent
SELECT s.name, SUM(d.cost) AS spent, SUM(d.missing) AS unpriced
FROM agent_cost_daily d LEFT JOIN agent_cost_sources s USING (container)
WHERE d.date >= strftime('%Y-%m-01', 'now')
GROUP BY d.container ORDER BY spent DESC;

-- costs.db: spend by model, last 30 days
SELECT model, SUM(cost) AS spent, SUM(calls) AS calls
FROM agent_cost_model_daily WHERE date >= date('now', '-29 days')
GROUP BY provider, model ORDER BY spent DESC;

-- events.db: active sessions right now
SELECT container, session_key, label, model, status
FROM agent_sessions WHERE status = 'running' AND gone_at IS NULL;

-- Last poll time (freshness check)
SELECT datetime(MAX(ts)/1000, 'unixepoch', 'localtime') AS last_event
FROM events;

-- Sub-agent tree of one agent (real spawns only)
WITH RECURSIVE tree(session_key, parent_key, depth) AS (
  SELECT session_key, parent_key, 0 FROM agent_sessions
  WHERE container = 'rev4a-agent_1' AND session_key = 'agent:main:main'
  UNION ALL
  SELECT s.session_key, s.parent_key, t.depth + 1
  FROM agent_sessions s JOIN tree t ON s.parent_key = t.session_key
  WHERE s.container = 'rev4a-agent_1' AND s.parent_kind = 'spawn'
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

### Other tables

- `alert_state` — one row per alert key (`lib/alerts.ts`): whether it was sent and resolved, so
  an alert is not sent twice.

`events.db` is Rev4a's own record — what it did to agents (the job tables, created and
deleted) and what it saw (anomalies, alerts). What agents do is read from OpenClaw: agent
spend is in `costs.db`; sessions are in `agent_sessions` (above), and the old
`sessions` and `lineage` tables are left untouched until a later release drops them.

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
of its own — independent of the session collector.
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
Containers add two metrics, `container_pids` (1000 or more processes on 2 consecutive
samples) and `container_memory` (90 % of Docker's memory on 5 consecutive samples), each at
most once per 60 minutes per container; `values` holds the process count or the percentage.
A third container metric, `container_oom`, is written at most once per container per 10 minutes for Docker's `oom` events (a process was killed for lack of memory, with or without a memory limit; kills inside the cooldown are counted into the next alert, whose data also carries `kills`), with `values: [limit in MB or null]`, no threshold and an extra `container` field in the event data holding the container name. Events written before it have no `container` field.

Installs from before this database may still have a `system_metrics` table in
`events.db`: nothing reads or writes it any more, and it can be dropped.

### Container consumption (also in `metrics.db`)

What each running container uses, and the disk Docker holds, so the System page can say
*who* is using the machine. The daemon writes it from the Docker Engine API
(`lib/docker-stats.js`; where the socket is comes from `lib/docker-socket-path.js`, shared
with the dashboard's `lib/docker-socket.ts`); `lib/container-metrics.ts` reads it for
`GET /api/metrics/containers`, the agent panel and the Containers page. The tables are
created with `CREATE TABLE IF NOT EXISTS` when the daemon starts, so an update adds them;
until then the API answers `available: false`.

**Sampling:** containers every 60 s, on a timer of its own — a priming pass 6 s after the
daemon starts (it only records the gauges: a CPU figure needs two readings), the first
complete one 15 s later — and Docker's disk (`/system/df`) every 10 min, the first reading
25 s after start. **Retention:** 30 days, pruned at every sample. A stopped container has no
rows: a gap, not zeros. Size, estimated: 60 s × 10 containers × 30 days ≈ 430 000 rows ≈ 35 MB
(to be measured on the VPS; rollups to 5 min may be added if it grows).

```sql
-- One row per running container per sample. CPU in cores (CPU-seconds per second), rates in
-- bytes per second; each is NULL on the first sample after a start and when its counter went
-- backwards (the container restarted) — never a negative rate or a spike. Memory is the
-- working set: usage − inactive page cache, what `docker stats` shows.
CREATE TABLE container_metrics (
  ts INTEGER NOT NULL,            -- Unix seconds
  container TEXT NOT NULL,
  cpu_cores REAL,
  mem_mb INTEGER,
  pids INTEGER,
  net_rx_bps INTEGER, net_tx_bps INTEGER,
  blk_read_bps INTEGER, blk_write_bps INTEGER
);
CREATE INDEX idx_container_metrics_ts ON container_metrics(ts);
CREATE INDEX idx_container_metrics_c_ts ON container_metrics(container, ts);

-- Who each container is: an agent's name (AGENT_NAME), whether it is an agent, and its named
-- volumes (the link to docker_storage). Forgotten after the retention.
CREATE TABLE container_sources (
  container TEXT PRIMARY KEY,
  agent_id TEXT, name TEXT, is_agent INTEGER NOT NULL DEFAULT 0,
  volumes TEXT,                   -- comma-separated volume names
  last_seen INTEGER NOT NULL
);

-- Docker's own cores and memory: the denominators for a container's share (on Docker Desktop
-- that is its VM — 8 GB of a 16 GB Mac — not the machine). One row.
CREATE TABLE docker_host (id INTEGER PRIMARY KEY CHECK (id = 1), ncpu INTEGER, mem_total_mb INTEGER, updated_at INTEGER);

-- Disk Docker holds, one set of rows per reading: kind 'volume' (name = the volume;
-- reclaimable_mb = its size when no container uses it), 'layer' (name = a container, its
-- writable layer), 'images' and 'build_cache' (totals; reclaimable_mb = what no container /
-- no build uses). A size Docker could not compute is NULL.
CREATE TABLE docker_storage (ts INTEGER NOT NULL, kind TEXT NOT NULL, name TEXT NOT NULL DEFAULT '', size_mb INTEGER, reclaimable_mb INTEGER);
CREATE INDEX idx_docker_storage_ts ON docker_storage(ts);
CREATE INDEX idx_docker_storage_kind_ts ON docker_storage(kind, name, ts);
```

## Costs Database (`costs.db`)

What each agent spent, **as its own OpenClaw priced it** — Rev4a computes no cost here.
Every model in the synced `rev4a` provider block carries its price
([GATEWAY.md](GATEWAY.md#costs-openclaw-prices-every-call)); each agent's OpenClaw prices
every call with it, and the daemon copies the figures here, so a stopped or deleted agent
keeps its history.

**Location:** `data/costs.db`, next to `events.db`, resolved like `metrics.db`.
**Created by** the daemon when it starts. It has two writers: the daemon (its own tables) and the dashboard's provider proxy, which writes `proxy_usage_hourly` and may create that table before the daemon has run. The queries are in `lib/agent-costs.ts` (spend) and `lib/cost-reconciliation.ts` (`vendor_balance`), on a read-only handle from `lib/costs-db.ts` — for
`GET /api/costs/usage`, `GET /api/costs`, `GET /api/costs/agent`, the SSE stream and
system-health. No file yet → the API answers `available: false`. If the daemon
cannot open it, it logs `[COSTS] disabled` and the rest of the daemon keeps running.
**Collection:** 20 s after the daemon starts, then every 5 minutes. First every **running**
container with an `AGENT_ID` label gets one short call, so that the ones whose index needs
rebuilding do it in parallel; then, one at a time, two Gateway calls through
`docker exec … openclaw gateway call` on the agent's port 3000 (token resolved inside the
container, never on the host's argv), both with `agentScope: "all"` over the last 30 UTC
days: `usage.cost` (per day, split into input / output / cache read / cache write, and
the calls it could not price) and `sessions.usage` (per model per day, and the 50 most
recent sessions). OpenClaw answers from an index of its transcripts that it rebuilds
after a price change or a restart; an answer whose `cacheStatus` is not `fresh` is never
stored — asked up to 6 times, 20 s apart (a rebuild took about 60 s on the VPS, from
4 to 290 transcript files alike), then the previous figures stay and the container's row
records the error — OpenClaw's own reason ("Gateway not reachable…") or how long the index
stayed unfresh. An answer missing its lists is refused before anything is deleted. An agent with nothing in the range answers without
`cacheStatus`, which counts as fresh.
**Days** are UTC dates, OpenClaw's default and the clock DeepSeek's rates follow.
**Retention:** the last 30 days are rewritten on every pass (late or repriced calls land in
the right day); older rows are kept as last read.

```sql
-- One row per container per UTC day with any use: OpenClaw's usage.cost daily entry.
CREATE TABLE agent_cost_daily (
  container TEXT NOT NULL, date TEXT NOT NULL,          -- 'YYYY-MM-DD'
  input INTEGER, output INTEGER, cache_read INTEGER, cache_write INTEGER, total_tokens INTEGER,
  cost REAL, input_cost REAL, output_cost REAL, cache_read_cost REAL, cache_write_cost REAL,
  missing INTEGER,                                      -- calls OpenClaw could not price
  PRIMARY KEY (container, date)
);
-- Per model per day: sessions.usage aggregates.modelDaily. Rows with provider `openai` (or the
-- legacy `openai-codex`) are ChatGPT subscription calls: no schema change for them, the readers subtract
-- them from agent_cost_daily (which has no provider) and show them apart, see lib/agent-costs.ts.
CREATE TABLE agent_cost_model_daily (
  container TEXT NOT NULL, date TEXT NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL,
  tokens INTEGER, cost REAL, calls INTEGER,
  PRIMARY KEY (container, date, provider, model)
);
-- One row per session seen; its figures are the session's total over the 30-day window.
CREATE TABLE agent_cost_sessions (
  container TEXT NOT NULL, session_id TEXT NOT NULL,
  session_key TEXT, label TEXT, agent_id TEXT, provider TEXT, model TEXT,
  tokens INTEGER, cost REAL, missing INTEGER,
  first_activity INTEGER, last_activity INTEGER,        -- Unix milliseconds
  PRIMARY KEY (container, session_id)
);
CREATE INDEX idx_cost_sessions_last ON agent_cost_sessions(last_activity);
-- The check against the bill: at most once an hour, after a pass, each vendor's own figure
-- and, read at the same moment, the agents' cumulative priced total for that vendor's
-- models (agent_cost_model_daily rows whose model starts with '<vendor>/'). Kept 400 days.
CREATE TABLE vendor_balance (
  ts INTEGER NOT NULL,        -- Unix ms
  vendor TEXT NOT NULL,       -- 'deepseek' | 'openrouter' (a key must be configured)
  currency TEXT,
  balance REAL,               -- DeepSeek: total balance; OpenRouter: credits − usage
  usage REAL,                 -- OpenRouter: lifetime usage (only grows); NULL for DeepSeek
  agents_cost REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (vendor, ts)
);
-- One row per container ever read: its name (AGENT_NAME) and how the last pass went.
CREATE TABLE agent_cost_sources (
  container TEXT PRIMARY KEY, agent_id TEXT, name TEXT,
  collected_at INTEGER,       -- last stored pass, Unix ms
  attempted_at INTEGER,       -- last attempt, Unix ms
  error TEXT,                 -- why the last attempt stored nothing; NULL after a good one
  missing_by_model TEXT       -- JSON {"rev4a/<model>": calls} over the 30-day window
);
-- What the Rev4a provider proxy metered: one row per UTC hour, caller and model. The proxy
-- (the Next.js process, app/api/provider/upstream.ts) adds to it after every upstream answer,
-- streaming or not, errors included; the daemon creates the table (CREATE IF NOT EXISTS, the
-- proxy does too) and deletes rows older than 400 days. Columns are increments: the writer
-- upserts and adds. See lib/proxy-usage.js.
CREATE TABLE proxy_usage_hourly (
  hour INTEGER NOT NULL,      -- start of the UTC hour, Unix seconds
  agent TEXT NOT NULL,        -- AGENT_ID from the x-rev4a-agent header (bounded: see PROVIDERS.md); 'unknown' otherwise; 'assistant' for PULSE
  provider TEXT NOT NULL,     -- upstream provider ('deepseek', 'openrouter', ...)
  model TEXT NOT NULL,        -- upstream model id, without the provider
  calls INTEGER NOT NULL DEFAULT 0,
  prompt_tokens INTEGER NOT NULL DEFAULT 0,      -- includes cached_tokens
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  cached_tokens INTEGER NOT NULL DEFAULT 0,      -- prompt tokens served from the provider's cache, when it reports them
  errors INTEGER NOT NULL DEFAULT 0,             -- non-2xx answers and calls that failed before any answer
  no_usage INTEGER NOT NULL DEFAULT 0,           -- 2xx answers without a usage report (a stream cut before its last chunk, or by an upstream error after a 200)
  cost REAL NOT NULL DEFAULT 0,                  -- USD, priceAt() of the model at the time of the call; 0 when it has no price
  PRIMARY KEY (hour, agent, provider, model)
);
```

`proxy_usage_hourly` is the proxy's own meter, next to what each agent's OpenClaw recorded
(`agent_cost_daily`): it counts every call the proxy carried, including those an agent never
records (a failed context compaction is not in OpenClaw's usage). The Costs page shows both and counts the larger.
It is additive: a release without it ignores the table, and an install without it (before the first update) has
none until the daemon or the first proxied call creates it.

## Credentials Database (`credentials.db`)

The credential hub uses a **separate SQLite file** (`credentials.db`) alongside
events.db in the same data directory. It stores credentials that can be switched
on, per agent, and delivered through OpenClaw (see `credential_assignments`).

**Location:** `data/credentials.db` (same directory as `events.db`)
**Custom path:** Set `REV4A_CREDENTIALS_DB` env var to override.
**WAL mode:** Enabled.
**File mode:** `credentials.db` and its `-wal` and `-shm` companions are `0600`, readable
by their owner only — like `.env`, `provider-keys.json` and `agents-token.json`. A new file
is created that way instead of inheriting the process umask; an install from an earlier
release with `0644` files is tightened at every server start (`instrumentation.ts` calls
`secureDbFiles` from `lib/credentials/file-mode.ts`), and again by `bootstrap()` in
`lib/credentials/db.ts`, once per process: before SQLite first opens the database, and after
it, because SQLite creates a database path that is a symlink to a missing file itself, under the
umask. If the chmod
fails — a read-only filesystem, Windows, a process that is not the owner — it is logged
once per file and the vault keeps working.

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

`last_synced_at` records the last successful delivery. A failed delivery changes
`status` to `error` without stamping a new sync time; a successful removal also
leaves the last delivery time intact.

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

### `credential_assignments` — which agent gets which credential

```sql
CREATE TABLE IF NOT EXISTS credential_assignments (
  profile_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,          -- container name
  enabled INTEGER NOT NULL DEFAULT 0,
  mode TEXT NOT NULL DEFAULT 'env', -- 'env' implemented, 'protected' reserved
  synced_at INTEGER,               -- last successful delivery (ms), NULL after a failure
  last_error TEXT,                 -- redacted message of the last failure
  pending_removal INTEGER NOT NULL DEFAULT 0, -- the last switch-off failed; retried at re-apply
  PRIMARY KEY (profile_id, agent_id)
);
```

Added with per-agent credential delivery (additive, created with `IF NOT EXISTS`). Holds no secret. The source of truth
for re-applying delivery after a recreate. Older releases ignore the table. `pending_removal`
is added to a table created without it by a guarded `ALTER TABLE` at startup. Rows are deleted
with their credential, and with their agent when the agent is deleted.

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

Actions: `create`, `update`, `delete`, `sync` (switched on), `desync` (switched off), `reveal`.

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
