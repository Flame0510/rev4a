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
 *
 * `imageRevision` (optional) is the short commit sha of the published image rebuild this
 * release expects for that version: the registry holds it as the immutable tag
 * `<version>-<sha>`. Without it the version is addressed by `<version>` alone.
 */
import table from './agent-versions.json';
import {
  identityRevision,
  isRevisionTag,
  localImageRevision as localRevision,
  pinnedRevision,
  registryTag,
  revisionRef,
  revisionStatus,
  type RevisionImage,
  type RevisionStatus,
} from './image-revision';

export interface SupportedVersion {
  version: string;
  modelInput: string[];
  imageRevision?: string;
}

export const SUPPORTED_VERSIONS: readonly SupportedVersion[] = table.supported as SupportedVersion[];

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

// ── Image revisions ──────────────────────────────────────────────────────────
//
// A rebuild of the same OpenClaw version keeps its `<version>` tag, so the version alone
// cannot tell two builds apart. Rev4a records which revision a local image is with a
// second local tag, `openclaw-agent-base:<version>-rev.<sha>`, set when it downloads a
// pinned revision. The rule itself lives in image-revision.js (CommonJS, shared with
// bin/rev4a.js); these are typed wrappers bound to this table. The `rev.` marker matters:
// VERSION_RE accepts `-<digits>`, and a short sha can be all digits.

export type ImageRevisionStatus = RevisionStatus;
export type { RevisionImage };

/** The local tag that records revision `revision` of `version`. */
export const localRevisionRef = (version: string, revision: string): string =>
  revisionRef(LOCAL_IMAGE_REPOSITORY, version, revision);

export { isRevisionTag };

/** The image revision this release expects for a version, or null (no pin, or a registry override). */
export function pinnedImageRevision(version: string): string | null {
  return pinnedRevision(SUPPORTED_VERSIONS.find((v) => v.version === version));
}

/** The registry tag to pull for a version: `<version>-<sha>` when pinned, else `<version>`. */
export const registryImageTag = (version: string): string => registryTag(version, pinnedImageRevision(version));

/** The revision of the local image of `version` (the pinned one when it carries several); null when there is none or it has no revision tag. */
export const localImageRevision = (
  version: string,
  images: RevisionImage[],
  pin: string | null = pinnedImageRevision(version),
): string | null => localRevision(LOCAL_IMAGE_REPOSITORY, version, images, pin);

/** The revision tag value for an image with none: the first 12 hex chars of its id. */
export { identityRevision };

/** `missing`, `current` or `outdated` (pin set, local revision unknown or different). */
export const imageRevisionStatus = (
  version: string,
  images: RevisionImage[],
  pin: string | null = pinnedImageRevision(version),
): ImageRevisionStatus => revisionStatus(LOCAL_IMAGE_REPOSITORY, version, images, pin);
