export interface PidRecord {
  pid: number;
  port: number;
  startTime: string;
  root: string;
}

type ReadFile = (path: string) => string;

export interface PortOwnerReaders {
  platform: NodeJS.Platform;
  execFileSync(file: string, args: string[]): string;
  readFileSync: ReadFile;
}

interface PidRecordWriter {
  writeFileSync(path: string, data: string, options: { mode: number; flag: string }): void;
  chmodSync(path: string, mode: number): void;
  renameSync(oldPath: string, newPath: string): void;
  unlinkSync(path: string): void;
}

interface PollOptions {
  now(): number;
  sleep(ms: number): Promise<unknown>;
}

type StopSignal = 'SIGTERM' | 'SIGKILL';

export interface StopRev4aOptions extends PollOptions {
  selfPid: number;
  kill(pid: number, signal: StopSignal | 0): void;
  onSignal?(pid: number, signal: StopSignal): void;
  onError?(pid: number, signal: StopSignal, error: NodeJS.ErrnoException): void;
}

export function validPort(port: unknown): port is number;
export function readProcessStartTime(pid: number, readers: PortOwnerReaders): string | null;
export function readPidRecord(
  file: string,
  readFileSync: ReadFile,
  owner?: { lstatSync: (file: string) => { isFile(): boolean; uid: number }; uid: number } | null,
): PidRecord | null;
export function writePidRecord(file: string, record: PidRecord, writer: PidRecordWriter): void;
export function removePidRecord(file: string, record: PidRecord, files: {
  readFileSync: ReadFile;
  unlinkSync(path: string): void;
}): void;
export function isRecordedProcess(record: PidRecord | null, readers: PortOwnerReaders): boolean;
export function describePortListeners(port: number, readers: Pick<PortOwnerReaders, 'platform' | 'execFileSync'>): string;
export function stopRev4aPids(records: PidRecord[], readers: PortOwnerReaders, options: StopRev4aOptions): Promise<boolean>;
export function waitForPort(probe: () => Promise<boolean>, options: PollOptions): Promise<boolean>;
