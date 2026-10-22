/**
 * Argv for `docker run` of a new agent, without the gateway token: the token is passed to
 * `runDocker(args, { env })`, which adds `-e OPENCLAW_GATEWAY_TOKEN` and hands the value to docker
 * through its environment, so it never reaches a process table or an error message.
 */
export function buildCreateRunArgs(p: {
  containerName: string;
  network: string;
  mountFlags: string[];
  memoryBytes: number | null;
  labels: string[];
  envVars: string[];
  portArgs: string[];
  image: string;
}): string[] {
  return [
    'run', '-d',
    '--init',
    '--name', p.containerName,
    '--network', p.network,
    '--restart', 'unless-stopped',
    '--add-host', 'host.docker.internal:host-gateway',
    '-v', `agent-${p.containerName}-data:/root`,
    ...p.mountFlags,
    ...(p.memoryBytes === null ? [] : ['--memory', String(p.memoryBytes), '--memory-swap', String(p.memoryBytes)]),
    ...p.labels.flatMap((l) => ['-l', l]),
    ...p.envVars.flatMap((e) => ['-e', e]),
    ...p.portArgs,
    p.image,
  ];
}
