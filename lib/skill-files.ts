/**
 * Writing a skill file inside an agent container.
 *
 * The command is a fixed script; the path is a positional argument and the content goes
 * through stdin, so nothing the caller sends is ever part of a shell string (on the host or in
 * the container). The container name is checked separately, before it reaches docker.
 */

/** Rule for a container name taken from a request body. */
export const CONTAINER_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;

/** The argv for `docker exec -i <container> …` that writes stdin to `path` (creating its directory). */
export function containerSkillWriteArgv(path: string): string[] {
  return ['sh', '-c', 'mkdir -p -- "$(dirname -- "$1")" && cat > "$1"', 'sh', path];
}
