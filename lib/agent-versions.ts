/**
 * The OpenClaw versions this Rev4a release supports, newest first.
 *
 * The table lives in `agent-versions.json` so the `rev4a` CLI (plain CommonJS) reads
 * the same list the server does. A new OpenClaw release is supported by adding its
 * entry here together with the Dockerfile's `ARG OPENCLAW_VERSION`; nothing detects
 * versions at runtime.
 *
 * `modelInput` is the model `input` list written into `models.json` for that version:
 * OpenClaw validates it against the modalities it knows, so a value an older release
 * does not know invalidates the whole catalogue.
 */
import table from './agent-versions.json';

export interface SupportedVersion {
  version: string;
  modelInput: string[];
}

export const SUPPORTED_VERSIONS: readonly SupportedVersion[] = table.supported;

/** Local image repository; agents run `openclaw-agent-base:<version>`. */
export const LOCAL_IMAGE_REPOSITORY: string = table.localRepository;

/**
 * Where images are pulled from. `REV4A_AGENT_IMAGE_REGISTRY` points Rev4a at another
 * registry with the same tags, such as a local `registry:2` for tests.
 */
export function registryRepository(): string {
  return process.env.REV4A_AGENT_IMAGE_REGISTRY?.trim() || table.registryRepository;
}

export const localImageRef = (version: string): string => `${LOCAL_IMAGE_REPOSITORY}:${version}`;

export const newestSupportedVersion = (): string => SUPPORTED_VERSIONS[0].version;

export const isSupportedVersion = (version: unknown): version is string =>
  typeof version === 'string' && SUPPORTED_VERSIONS.some((v) => v.version === version);

/** Model `input` values every supported version accepts — the safe list when the version is unknown. */
export function conservativeModelInput(): string[] {
  return SUPPORTED_VERSIONS.reduce<string[]>(
    (acc, v, i) => (i === 0 ? [...v.modelInput] : acc.filter((x) => v.modelInput.includes(x))),
    [],
  );
}

/**
 * Model `input` values for a version. An unknown version gets the conservative
 * intersection rather than the newest list: sending an older release a value it does
 * not know discards its whole generated catalogue, so the fallback must be the set all
 * supported versions accept.
 */
export function modelInputFor(version?: string | null): string[] {
  const entry = version ? SUPPORTED_VERSIONS.find((v) => v.version === version) : undefined;
  return entry ? entry.modelInput : conservativeModelInput();
}

const VERSION_RE = /(\d{4})\.(\d{1,2})\.(\d{1,2})(?:-(\d+))?/;

/** The version in `2026.9.3` or `OpenClaw 2026.9.3 (1391f7c)`; null when there is none. */
export function parseOpenClawVersion(text: string | null | undefined): string | null {
  const m = VERSION_RE.exec(text ?? '');
  if (!m) return null;
  return `${Number(m[1])}.${Number(m[2])}.${Number(m[3])}${m[4] !== undefined ? `-${Number(m[4])}` : ''}`;
}

/** Negative when `a` is older than `b`, zero when equal, positive when newer. Unparseable sorts oldest. */
export function compareVersions(a: string, b: string): number {
  const parts = (v: string) => {
    const m = VERSION_RE.exec(v);
    return m ? [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4] ?? 0)] : [-1, -1, -1, -1];
  };
  const pa = parts(a);
  const pb = parts(b);
  for (let i = 0; i < pa.length; i++) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i];
  }
  return 0;
}
