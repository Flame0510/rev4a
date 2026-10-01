/**
 * What each container consumes, read from metrics.db (daemon.js writes it — see
 * docs/dev/DATABASE.md, Container consumption). The queries behind the System page's
 * *Agents* section, the agent panel and the Containers page; the routes stay thin.
 *
 * CPU is stored in cores and shown as a share of Docker's cores (`docker_host.ncpu`): on the
 * VPS that is the machine, on Docker Desktop its VM. Memory is the working set in MB,
 * with its share of Docker's memory next to it.
 */
import type Database from 'better-sqlite3';

/** How often daemon.js samples containers, and reads Docker's disk (seconds). */
export const CONTAINER_INTERVAL_S = 60;
export const STORAGE_INTERVAL_S = 600;
/** History points per chart. */
const POINTS = 120;
/** A container whose newest sample is older than this many intervals is not running. */
const RUNNING_WITHIN_INTERVALS = 3;

const TABLES = ['container_metrics', 'container_sources', 'docker_host', 'docker_storage'];

/** False until the daemon has created the tables (first start after an update). */
export function containerTablesReady(db: Database.Database): boolean {
  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name IN (${TABLES.map(() => '?').join(', ')})`)
    .get(...TABLES) as { n: number };
  return row.n === TABLES.length;
}

/** Seconds per chart point: at least two samples, so a drifting timer leaves no empty bucket. */
export function bucketSeconds(spanS: number, intervalS: number): number {
  return Math.max(2 * intervalS, Math.round(spanS / POINTS));
}

export interface DockerHost { ncpu: number; mem_total_mb: number }

export function readDockerHost(db: Database.Database): DockerHost | null {
  const row = db.prepare('SELECT ncpu, mem_total_mb FROM docker_host WHERE id = 1').get() as
    { ncpu: number | null; mem_total_mb: number | null } | undefined;
  return row && row.ncpu && row.mem_total_mb ? { ncpu: row.ncpu, mem_total_mb: row.mem_total_mb } : null;
}

/** `value` as a percent of `whole`, to `digits` decimals — CPU needs two: an idle agent is a few hundredths of a percent of the machine. */
const pct = (value: number | null, whole: number | null | undefined, digits = 1): number | null =>
  value === null || !whole ? null : Math.round((value / whole) * 100 * 10 ** digits) / 10 ** digits;
const round2 = (n: number | null): number | null => (n === null ? null : Math.round(n * 100) / 100);

/** The named volumes a container uses, as daemon.js recorded them. */
function volumesOf(list: string | null): string[] {
  return list ? list.split(',').filter(Boolean) : [];
}

export interface ContainerNow {
  cpu_cores: number | null;
  cpu_percent: number | null;
  mem_mb: number | null;
  mem_percent: number | null;
  pids: number | null;
  net_rx_bps: number | null;
  net_tx_bps: number | null;
  blk_read_bps: number | null;
  blk_write_bps: number | null;
}

export interface ContainerRow {
  container: string;
  name: string;
  agent_id: string | null;
  is_agent: boolean;
  running: boolean;
  last_seen: number;
  now: ContainerNow | null;
  /** Average and peak over the range, CPU as a share of Docker's cores. */
  range: { cpu_avg_percent: number | null; cpu_max_percent: number | null; mem_avg_mb: number | null; mem_max_mb: number | null };
  /** Named volumes plus the writable layer, from the last reading of Docker's disk. */
  storage: { volume_mb: number | null; layer_mb: number | null; total_mb: number | null; ts: number | null };
}

export interface DockerStorage {
  ts: number;
  images_mb: number | null;
  images_reclaimable_mb: number | null;
  build_cache_mb: number | null;
  build_cache_reclaimable_mb: number | null;
  volumes_mb: number;
  /** What no container uses, all of it — `unused_volumes` lists only the largest five. */
  unused_volumes_mb: number;
  layers_mb: number;
  /** Volumes no container uses (cold backups, leftovers), largest first. */
  unused_volumes: { name: string; size_mb: number }[];
}

export interface ContainerOverview {
  host: DockerHost | null;
  /** Unix seconds of the newest sample, and how old it is. */
  sampled_at: number | null;
  age_s: number | null;
  containers: ContainerRow[];
  /** The machine minus the containers: what is not one of them (the host, Rev4a, other software). */
  rest: { cpu_percent: number | null; mem_mb: number | null } | null;
  docker_storage: DockerStorage | null;
}

interface NowRow {
  ts: number; cpu_cores: number | null; mem_mb: number | null; pids: number | null;
  net_rx_bps: number | null; net_tx_bps: number | null; blk_read_bps: number | null; blk_write_bps: number | null;
}

/** The newest reading of each volume, layer and total, or null before the first. */
export function readDockerStorage(db: Database.Database): DockerStorage | null {
  const ts = (db.prepare('SELECT MAX(ts) AS ts FROM docker_storage').get() as { ts: number | null }).ts;
  if (ts === null) return null;
  const rows = db.prepare('SELECT kind, name, size_mb, reclaimable_mb FROM docker_storage WHERE ts = ?').all(ts) as
    { kind: string; name: string; size_mb: number | null; reclaimable_mb: number | null }[];
  const one = (kind: string) => rows.find((r) => r.kind === kind);
  const sum = (kind: string) => rows.filter((r) => r.kind === kind).reduce((acc, r) => acc + (r.size_mb ?? 0), 0);
  const unused = rows
    .filter((r) => r.kind === 'volume' && (r.reclaimable_mb ?? 0) > 0)
    .map((r) => ({ name: r.name, size_mb: r.reclaimable_mb as number }))
    .sort((a, b) => b.size_mb - a.size_mb);
  return {
    ts,
    images_mb: one('images')?.size_mb ?? null,
    images_reclaimable_mb: one('images')?.reclaimable_mb ?? null,
    build_cache_mb: one('build_cache')?.size_mb ?? null,
    build_cache_reclaimable_mb: one('build_cache')?.reclaimable_mb ?? null,
    volumes_mb: sum('volume'),
    unused_volumes_mb: unused.reduce((a, v) => a + v.size_mb, 0),
    layers_mb: sum('layer'),
    unused_volumes: unused.slice(0, 5),
  };
}

interface AggregateRow { container: string; cpu_avg: number | null; cpu_max: number | null; mem_avg: number | null; mem_max: number | null }

/**
 * From 24 hours up, the average and peak scan every sample of the range: the page's heaviest
 * query — synchronous, so it holds the server's event loop (about 100 ms for ten containers
 * over 24 h, measured) on every 30 s poll — and its answer hardly moves in two minutes. So
 * those ranges are kept that long; shorter ones are cheap and read fresh.
 */
const LONG_RANGE_S = 24 * 3_600;
const AGGREGATE_TTL_MS = 120_000;
const aggregateCache = new Map<string, { at: number; rows: Map<string, AggregateRow> }>();

function rangeAggregates(db: Database.Database, spanS: number, since: number): Map<string, AggregateRow> {
  const cacheable = spanS >= LONG_RANGE_S;
  const key = `${db.name}:${spanS}`;
  if (cacheable) {
    const hit = aggregateCache.get(key);
    if (hit && Date.now() - hit.at < AGGREGATE_TTL_MS) return hit.rows;
  }
  const rows = new Map(
    (db
      .prepare(
        `SELECT container, AVG(cpu_cores) AS cpu_avg, MAX(cpu_cores) AS cpu_max, AVG(mem_mb) AS mem_avg, MAX(mem_mb) AS mem_max
         FROM container_metrics WHERE ts > ? GROUP BY container`,
      )
      .all(since) as AggregateRow[])
      .map((r) => [r.container, r]),
  );
  if (cacheable) aggregateCache.set(key, { at: Date.now(), rows });
  return rows;
}

/**
 * Every container seen in the range: who it is, what it uses now, its average and peak over
 * the range, and its disk — running ones first, by CPU.
 */
export function readContainerOverview(
  db: Database.Database,
  spanS: number,
  nowS = Math.floor(Date.now() / 1000),
  /** Cores of the machine the API runs on, to put the containers' CPU on the machine's scale in `rest`. */
  hostCores?: number,
): ContainerOverview {
  const host = readDockerHost(db);
  const sampledAt = (db.prepare('SELECT MAX(ts) AS ts FROM container_metrics').get() as { ts: number | null }).ts;
  const since = nowS - spanS;

  const sources = db
    .prepare('SELECT container, agent_id, name, is_agent, volumes, last_seen FROM container_sources WHERE last_seen > ?')
    .all(since) as { container: string; agent_id: string | null; name: string | null; is_agent: number; volumes: string | null; last_seen: number }[];

  const aggregates = rangeAggregates(db, spanS, since);
  // Running is judged against the newest sample, not the wall clock: a daemon that stopped must
  // not make every container look stopped (the page says "Not collecting" instead) — but never
  // against a sample from the future, which a clock set back would leave behind.
  const reference = sampledAt === null ? null : Math.min(sampledAt, nowS);

  const storage = readDockerStorage(db);
  const storageRows = storage
    ? (db.prepare('SELECT kind, name, size_mb FROM docker_storage WHERE ts = ?').all(storage.ts) as { kind: string; name: string; size_mb: number | null }[])
    : [];
  const sizeOf = (kind: string, name: string) => storageRows.find((r) => r.kind === kind && r.name === name)?.size_mb ?? null;

  const newest = db.prepare(
    `SELECT ts, cpu_cores, mem_mb, pids, net_rx_bps, net_tx_bps, blk_read_bps, blk_write_bps
     FROM container_metrics WHERE container = ? ORDER BY ts DESC LIMIT 3`,
  );

  const containers: ContainerRow[] = sources.map((s) => {
    const recent = newest.all(s.container) as NowRow[];
    const latest = recent[0];
    const running = Boolean(latest && reference !== null && latest.ts >= reference - RUNNING_WITHIN_INTERVALS * CONTAINER_INTERVAL_S);
    // A rate is null on the first sample after a start; the previous reading stands in for it.
    const rate = (key: keyof NowRow) => recent.find((r) => r[key] !== null)?.[key] ?? null;
    const cores = running ? (rate('cpu_cores') as number | null) : null;
    const now: ContainerNow | null = running
      ? {
          cpu_cores: cores,
          cpu_percent: pct(cores, host?.ncpu, 2),
          mem_mb: latest.mem_mb,
          mem_percent: pct(latest.mem_mb, host?.mem_total_mb),
          pids: latest.pids,
          net_rx_bps: rate('net_rx_bps') as number | null,
          net_tx_bps: rate('net_tx_bps') as number | null,
          blk_read_bps: rate('blk_read_bps') as number | null,
          blk_write_bps: rate('blk_write_bps') as number | null,
        }
      : null;
    const agg = aggregates.get(s.container);
    const volumeSizes = volumesOf(s.volumes).map((v) => sizeOf('volume', v));
    const volume = volumeSizes.length && volumeSizes.some((v) => v !== null) ? volumeSizes.reduce<number>((a, v) => a + (v ?? 0), 0) : null;
    const layer = sizeOf('layer', s.container);
    return {
      container: s.container,
      name: s.name || s.container,
      agent_id: s.agent_id,
      is_agent: s.is_agent === 1,
      running,
      last_seen: s.last_seen,
      now,
      range: {
        cpu_avg_percent: pct(agg?.cpu_avg ?? null, host?.ncpu, 2),
        cpu_max_percent: pct(agg?.cpu_max ?? null, host?.ncpu, 2),
        mem_avg_mb: agg?.mem_avg == null ? null : Math.round(agg.mem_avg),
        mem_max_mb: agg?.mem_max ?? null,
      },
      storage: {
        volume_mb: volume,
        layer_mb: layer,
        total_mb: volume === null && layer === null ? null : (volume ?? 0) + (layer ?? 0),
        ts: storage?.ts ?? null,
      },
    };
  });

  containers.sort((a, b) =>
    Number(b.running) - Number(a.running)
    || (b.now?.cpu_percent ?? -1) - (a.now?.cpu_percent ?? -1)
    || a.name.localeCompare(b.name));

  // Machine minus the containers, from the machine's newest sample.
  const machine = db
    .prepare('SELECT cpu_percent, ram_used_mb FROM system_metrics ORDER BY ts DESC LIMIT 1')
    .get() as { cpu_percent: number | null; ram_used_mb: number | null } | undefined;
  const running = containers.filter((c) => c.running && c.now);
  // The machine's CPU is a share of the host's cores; a container's is of Docker's — the same on a
  // server, not on Docker Desktop, whose VM may have fewer. Compare in cores over the host's.
  const containersShare = hostCores && hostCores > 0
    ? (running.reduce((a, c) => a + (c.now?.cpu_cores ?? 0), 0) / hostCores) * 100
    : running.reduce((a, c) => a + (c.now?.cpu_percent ?? 0), 0);
  const rest = machine && host
    ? {
        cpu_percent: machine.cpu_percent === null ? null : round2(Math.max(0, machine.cpu_percent - containersShare)),
        mem_mb: machine.ram_used_mb === null ? null : Math.max(0, machine.ram_used_mb - running.reduce((a, c) => a + (c.now?.mem_mb ?? 0), 0)),
      }
    : null;

  return {
    host,
    sampled_at: sampledAt,
    age_s: sampledAt === null ? null : Math.max(0, nowS - sampledAt),
    containers,
    rest,
    docker_storage: storage,
  };
}

export interface ContainerHistory {
  host: DockerHost | null;
  container: string;
  name: string | null;
  bucket_s: number;
  /** CPU as a share of Docker's cores (average and peak), memory in MB (average and peak). */
  history: { ts: number; cpu_avg: number | null; cpu_max: number | null; mem_avg: number | null; mem_max: number | null }[];
  storage_bucket_s: number;
  /** Named volumes plus the writable layer, MB. */
  storage_history: { ts: number; total_mb: number | null }[];
}

/** One container's history, bucketed like the machine's (`GET /api/metrics`). */
export function readContainerHistory(db: Database.Database, container: string, spanS: number, nowS = Math.floor(Date.now() / 1000)): ContainerHistory {
  const host = readDockerHost(db);
  const since = nowS - spanS;
  const bucket = bucketSeconds(spanS, CONTAINER_INTERVAL_S);
  const storageBucket = bucketSeconds(spanS, STORAGE_INTERVAL_S);

  const source = db.prepare('SELECT name, volumes FROM container_sources WHERE container = ?').get(container) as
    { name: string | null; volumes: string | null } | undefined;

  const rows = db
    .prepare(
      `SELECT (ts / CAST(@bucket AS INTEGER)) * CAST(@bucket AS INTEGER) AS ts,
         AVG(cpu_cores) AS cpu_avg, MAX(cpu_cores) AS cpu_max, AVG(mem_mb) AS mem_avg, MAX(mem_mb) AS mem_max
       FROM container_metrics WHERE container = @container AND ts > @since
       GROUP BY ts / CAST(@bucket AS INTEGER) ORDER BY ts`,
    )
    .all({ bucket, container, since }) as { ts: number; cpu_avg: number | null; cpu_max: number | null; mem_avg: number | null; mem_max: number | null }[];

  const volumes = volumesOf(source?.volumes ?? null);
  const placeholders = volumes.map(() => '?').join(', ');
  // Volumes and the writable layer, summed per reading, then averaged per bucket.
  const storageRows = db
    .prepare(
      `SELECT (ts / CAST(? AS INTEGER)) * CAST(? AS INTEGER) AS ts, AVG(total) AS total_mb FROM (
         SELECT ts, SUM(size_mb) AS total FROM docker_storage
         WHERE ts > ? AND ((kind = 'layer' AND name = ?)${volumes.length ? ` OR (kind = 'volume' AND name IN (${placeholders}))` : ''})
         GROUP BY ts
       ) GROUP BY ts / CAST(? AS INTEGER) ORDER BY ts`,
    )
    .all(storageBucket, storageBucket, since, container, ...volumes, storageBucket) as { ts: number; total_mb: number | null }[];

  return {
    host,
    container,
    name: source?.name ?? null,
    bucket_s: bucket,
    history: rows.map((r) => ({
      ts: r.ts,
      cpu_avg: pct(r.cpu_avg, host?.ncpu, 2),
      cpu_max: pct(r.cpu_max, host?.ncpu, 2),
      mem_avg: r.mem_avg === null ? null : Math.round(r.mem_avg),
      mem_max: r.mem_max,
    })),
    storage_bucket_s: storageBucket,
    storage_history: storageRows.map((r) => ({ ts: r.ts, total_mb: r.total_mb === null ? null : Math.round(r.total_mb) })),
  };
}
