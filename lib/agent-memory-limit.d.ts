/** Types for the CommonJS memory-limit helpers shared with daemon.js. */

export const MIN_LIMIT_MB: number;
export const MAX_LIMIT_MB: number;
/** Sizes the picker offers, in MB (1.5 GB to 16 GB). */
export const MEMORY_PRESETS_MB: number[];
/** GB text ("2.5") to integer MB, range-checked. Throws on empty, non-numeric or out of range. */
export function parseGbInput(text: unknown): number;
/** MB to GB text for the custom field; '' when not a positive number. */
export function mbToGbText(mb: unknown): string;

/** Integer MB in [MIN_LIMIT_MB, MAX_LIMIT_MB], or null for "no limit". Throws on invalid input. */
export function parseLimitMb(input: unknown): number | null;
export function mbToBytes(mb: number): number;
/** Rounds down; null when not a positive number. */
export function bytesToMb(bytes: unknown): number | null;
export function formatLimit(mb: number | null | undefined): string;
/** `docker run` flags from inspect HostConfig.Memory / MemorySwap. */
export function limitArgs(memoryBytes?: number | null, memorySwapBytes?: number | null): string[];
/** Flags for a rebuild: undefined carries the inspect, null removes, a number sets (swap equal). */
export function rebuildLimitArgs(
  hostConfig: { Memory?: number | null; MemorySwap?: number | null } | null | undefined,
  override?: number | null,
): string[];

export interface OomAnomaly {
  key: string;
  container: string;
  time: number | null;
  limitMb: number | null;
  values: (number | null)[];
  message: string;
}
export function oomEventsToAnomalies(events: unknown, limitsMb?: Record<string, number | null | undefined>): OomAnomaly[];
export function parseEventStream(text: unknown): Record<string, unknown>[];

/** NDJSON splitter: push(chunk) returns the objects completed by that chunk, across chunk boundaries. */
export function createLineSplitter(): { push(chunk: string | Uint8Array): Record<string, unknown>[] };
export const OOM_COOLDOWN_MS: number;
export interface OomDue { container: string; kills: number; anomaly: OomAnomaly; message: string }
/** One out-of-memory alert per container per cooldown; kills inside it are counted into the next alert. */
export function createOomTracker(cooldownMs?: number): {
  kill(anomaly: OomAnomaly, nowMs: number): boolean;
  due(nowMs: number): OomDue[];
  markRecorded(container: string, nowMs: number): void;
};
