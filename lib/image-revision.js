'use strict';
/**
 * Which exact build of an agent image a local `openclaw-agent-base:<version>` is.
 *
 * CommonJS so the `rev4a` CLI (bin/rev4a.js) and the server (lib/agent-versions.ts,
 * lib/agent-images.ts) apply one rule and cannot drift. Pure: no Docker, no file reads.
 *
 * A rebuild of a version keeps its `<version>` tag. A version entry in
 * agent-versions.json may pin `imageRevision`, a short sha: the registry's immutable
 * `<version>-<sha>` tag. A pinned download is also tagged locally
 * `<repository>:<version>-rev.<sha>`; the local `<version>` image is that revision when the
 * same image id carries that tag. The `rev.` marker keeps an all-digit sha from being read
 * as part of a version (`-<digits>` is).
 */

const REVISION_RE = /^[0-9a-f]{7,40}$/;
const REV_MARKER = '-rev.';

/**
 * The revision a version entry pins, or null: none pinned, a malformed value, or
 * REV4A_AGENT_IMAGE_REGISTRY set (another registry is not promised to hold the sha tags).
 */
function pinnedRevision(entry, env = process.env) {
  if ((env.REV4A_AGENT_IMAGE_REGISTRY || '').trim()) return null;
  const rev = entry && entry.imageRevision;
  return typeof rev === 'string' && REVISION_RE.test(rev) ? rev : null;
}

/** The registry tag to pull: `<version>-<sha>` when pinned, else `<version>`. */
const registryTag = (version, pin) => (pin ? `${version}-${pin}` : version);

/** The local reference that records revision `sha` of `version`. */
const revisionRef = (repository, version, sha) => `${repository}:${version}${REV_MARKER}${sha}`;

/** Whether a local tag (without the repository) is `<version>-rev.<sha>`. */
function isRevisionTag(tag) {
  const at = tag.indexOf(REV_MARKER);
  return at > 0 && REVISION_RE.test(tag.slice(at + REV_MARKER.length));
}

/**
 * The sha of a `-rev.<sha>` tag on the image holding `<repository>:<version>`; null when
 * none. An image can carry several: the pinned one wins, whatever the tag order, else the first.
 */
function localImageRevision(repository, version, images, pin) {
  const versionRef = `${repository}:${version}`;
  const image = images.find((img) => img.tags.includes(versionRef));
  if (!image) return null;
  const prefix = `${versionRef}${REV_MARKER}`;
  const shas = image.tags
    .filter((tag) => tag.startsWith(prefix))
    .map((tag) => tag.slice(prefix.length))
    .filter((sha) => REVISION_RE.test(sha));
  return pin && shas.includes(pin) ? pin : shas[0] ?? null;
}

/** The identity tag given to an image that has none: `<version>-rev.<first 12 hex chars of its id>`. */
const identityRevision = (imageId) => imageId.replace(/^sha256:/, '').slice(0, 12);

/** `missing` | `current` | `outdated`: see lib/agent-versions.ts. */
function revisionStatus(repository, version, images, pin) {
  const versionRef = `${repository}:${version}`;
  if (!images.some((img) => img.tags.includes(versionRef))) return 'missing';
  if (!pin) return 'current';
  return localImageRevision(repository, version, images, pin) === pin ? 'current' : 'outdated';
}

module.exports = { pinnedRevision, registryTag, revisionRef, isRevisionTag, localImageRevision, identityRevision, revisionStatus };
