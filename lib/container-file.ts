/**
 * Reading one file out of an agent container, running or not.
 *
 * `docker exec` cannot reach a stopped or paused container; `docker cp` can, and
 * streams the file as a tar archive. Used by the config sync, which also writes
 * back through `docker cp`, and by the model summary behind the agent cards.
 */

/** The single regular file in a `docker cp … -` tar stream: its bytes and mode. */
export function singleFileFromTar(tar: Buffer): { body: Buffer; mode: number } {
  if (tar.length < 512) throw new Error('docker cp returned an empty archive');
  const header = tar.subarray(0, 512);
  const field = (start: number, len: number) => {
    const text = header.subarray(start, start + len).toString('ascii');
    const nul = text.indexOf('\0');
    return (nul === -1 ? text : text.slice(0, nul)).trim();
  };
  const type = field(156, 1);
  // '0' (or NUL on old writers) is a regular file. Anything else — a pax header,
  // a directory — is not the shape expected, and guessing past it could mean
  // writing a config that was never read.
  if (type !== '0' && type !== '') throw new Error(`docker cp returned a non-file entry (type ${type})`);
  const size = parseInt(field(124, 12), 8);
  if (!Number.isFinite(size) || tar.length < 512 + size) throw new Error('docker cp returned a truncated archive');
  const mode = parseInt(field(100, 8), 8);
  return { body: tar.subarray(512, 512 + size), mode: Number.isFinite(mode) ? mode & 0o777 : 0o600 };
}
