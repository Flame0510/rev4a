'use strict';

const { posix } = require('node:path');

const DOCKER_RUNTIME_PATHS = Object.freeze([
  '/usr/bin/docker',
  '/usr/local/bin/docker',
  '/snap/bin/docker',
  '/bin/docker',
  '/var/run/docker.sock',
  '/run/docker.sock',
]);

function decideDockerInstall({ platform, isRoot, distroId, distroIdLike, env, existingPaths, podmanOnPath }) {
  const optOut = env.REV4A_DOCKER_AUTO_INSTALL?.trim().toLowerCase();
  if (['0', 'false', 'no'].includes(optOut)) {
    return { action: 'guide', reason: 'Docker auto-install disabled by REV4A_DOCKER_AUTO_INSTALL.' };
  }

  const found = DOCKER_RUNTIME_PATHS.find((path) => existingPaths.includes(path));
  if (found?.endsWith('/docker')) {
    return {
      action: 'use',
      reason: `Docker CLI found at ${found} outside PATH. Add ${posix.dirname(found)} to the PATH used by rev4a serve.`,
      found,
    };
  }
  if (found) {
    return {
      action: 'use',
      reason: `Docker socket found at ${found}. Make the Docker CLI available on the PATH used by rev4a serve.`,
      found,
    };
  }
  if (podmanOnPath) {
    return { action: 'use', reason: 'Podman found on PATH. Docker auto-install skipped.', found: 'podman' };
  }

  if (platform !== 'linux') {
    return { action: 'guide', reason: 'Docker not found. Rev4a needs Docker to create agent containers.' };
  }
  if (!isRoot) {
    return {
      action: 'guide',
      reason: 'Docker not found. On Debian or Ubuntu and their derivatives, run sudo rev4a serve to auto-install it.',
    };
  }

  if (/^(debian|ubuntu)$/i.test(distroId ?? '') || /(?:^|\s)(debian|ubuntu)(?:\s|$)/i.test(distroIdLike ?? '')) {
    return { action: 'install', reason: 'No existing container runtime found on a Debian or Ubuntu host.' };
  }
  return { action: 'guide', reason: 'Docker not found. Auto-install requires Debian, Ubuntu, or a derivative.' };
}

module.exports = { DOCKER_RUNTIME_PATHS, decideDockerInstall };
