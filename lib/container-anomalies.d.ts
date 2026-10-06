/** Types for the CommonJS container anomaly detector shared with daemon.js. */

export const PIDS_THRESHOLD: number;
export const MEMORY_PERCENT: number;
export const COOLDOWN_MS: number;

export interface ContainerAnomaly {
  /** `<metric>:<container>` — the cooldown key. */
  key: string;
  metric: 'container_pids' | 'container_memory';
  container: string;
  values: number[];
  threshold: number;
  message: string;
}

export interface ContainerAnomalySample {
  host?: { memTotalMb?: number | null } | null;
  rows?: { container: string; mem_mb?: number | null; pids?: number | null }[];
}

export function createContainerAnomalyDetector(options?: { cooldownMs?: number }): {
  /** Returns the anomalies due now; starts no cooldown. */
  observe(sample: ContainerAnomalySample, nowMs: number): ContainerAnomaly[];
  /** Call after the event for `key` was written: starts its 60-minute cooldown. */
  markRecorded(key: string, nowMs: number): void;
};
