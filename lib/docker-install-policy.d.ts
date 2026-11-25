export const DOCKER_RUNTIME_PATHS: readonly string[];

export interface DockerInstallFacts {
  platform: string;
  isRoot: boolean;
  distroId?: string;
  distroIdLike?: string;
  env: Readonly<Record<string, string | undefined>>;
  existingPaths: readonly string[];
  podmanOnPath: boolean;
}

export type DockerInstallDecision =
  | { action: 'use'; reason: string; found: string }
  | { action: 'install' | 'guide'; reason: string; found?: never };

export function decideDockerInstall(facts: DockerInstallFacts): DockerInstallDecision;
