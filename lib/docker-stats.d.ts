/** Types for the CommonJS Docker stats parser shared with daemon.js. */

export const CONTAINER_NAME_RE: RegExp;
export const DF_TIMEOUT_MS: number;
export const MB: number;

export function cleanName(value: unknown, fallback?: string | null): string | null;
export function primaryName(names: unknown): string;
export function workingSetBytes(memory: unknown): number | null;
export function sumNetwork(networks: unknown): { rx: number | null; tx: number | null };
export function sumBlockIo(blkio: unknown): { rd: number | null; wr: number | null };

export interface ContainerCounters {
  t: number;
  cpuNs: number;
  memBytes: number | null;
  pids: number | null;
  rx: number | null;
  tx: number | null;
  rd: number | null;
  wr: number | null;
}

export function readCounters(stats: unknown, atMs: number): ContainerCounters | null;

export interface ContainerRates {
  cpuCores: number | null;
  rxBps: number | null;
  txBps: number | null;
  rdBps: number | null;
  wrBps: number | null;
}

export function ratesBetween(
  prev: ContainerCounters | null | undefined,
  cur: ContainerCounters | null | undefined,
  maxWindowS?: number,
): ContainerRates;

export interface HostCapacity {
  ncpu: number;
  memTotalMb: number;
}

export interface ContainerRow {
  container: string;
  cpu_cores: number | null;
  mem_mb: number | null;
  pids: number | null;
  net_rx_bps: number | null;
  net_tx_bps: number | null;
  blk_read_bps: number | null;
  blk_write_bps: number | null;
}

export interface ContainerSource {
  container: string;
  agent_id: string | null;
  name: string;
  is_agent: 0 | 1;
  volumes: string;
}

export interface ContainerSample {
  ts: number;
  host: HostCapacity | null;
  rows: ContainerRow[];
  sources: ContainerSource[];
}

export function createContainerSampler(options: {
  request: (method: string, path: string, timeoutMs?: number) => Promise<unknown>;
  now?: () => number;
  maxWindowS?: number;
}): { sample: () => Promise<ContainerSample> };

export interface VolumeUsage {
  name: string;
  sizeBytes: number | null;
  unused: boolean;
}

export function parseStorage(df: unknown): {
  volumes: VolumeUsage[];
  layers: { container: string; sizeBytes: number | null }[];
  images: { sizeBytes: number | null; reclaimableBytes: number | null };
  buildCache: { sizeBytes: number | null; reclaimableBytes: number | null };
} | null;
