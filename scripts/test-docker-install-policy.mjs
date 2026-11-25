import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { decideDockerInstall } from '../lib/docker-install-policy.js';

const decide = (overrides = {}) => decideDockerInstall({
  platform: 'linux',
  isRoot: true,
  distroId: 'debian',
  env: {},
  existingPaths: [],
  podmanOnPath: false,
  ...overrides,
});

test('opt-out wins over an eligible empty host, existing runtimes, and platform guidance', () => {
  for (const value of ['0', 'false', 'FALSE', 'FaLsE', 'no', 'NO', ' No ']) {
    const env = { REV4A_DOCKER_AUTO_INSTALL: value };
    for (const facts of [
      {},
      { existingPaths: ['/snap/bin/docker', '/var/run/docker.sock'], podmanOnPath: true },
      { platform: 'darwin', isRoot: false },
    ]) {
      const result = decide({ ...facts, env });
      assert.equal(result.action, 'guide', value);
      assert.match(result.reason, /disabled by REV4A_DOCKER_AUTO_INSTALL/);
      assert.equal(result.found, undefined);
    }
  }
});

test('every known Docker binary prevents installation and identifies the directory to add to PATH', () => {
  for (const path of ['/usr/bin/docker', '/usr/local/bin/docker', '/snap/bin/docker', '/bin/docker']) {
    const result = decide({ existingPaths: [path] });
    assert.equal(result.action, 'use');
    assert.equal(result.found, path);
    assert.ok(result.reason.includes(path));
    assert.ok(result.reason.includes(`Add ${path.slice(0, -'/docker'.length)} to the PATH`));
  }
});

test('a Docker socket alone prevents installation on an otherwise eligible host', () => {
  for (const path of ['/var/run/docker.sock', '/run/docker.sock']) {
    const result = decide({ existingPaths: [path] });
    assert.equal(result.action, 'use');
    assert.equal(result.found, path);
    assert.ok(result.reason.includes(`Docker socket found at ${path}`));
  }
});

test('Podman on PATH prevents installation', () => {
  const result = decide({ podmanOnPath: true });
  assert.equal(result.action, 'use');
  assert.equal(result.found, 'podman');
  assert.match(result.reason, /Podman found on PATH/);
});

test('runtime detection takes precedence over platform, privilege, and distro guidance', () => {
  assert.equal(decide({ platform: 'darwin', isRoot: false, existingPaths: ['/snap/bin/docker'] }).action, 'use');
  assert.equal(decide({ isRoot: false, distroId: 'fedora', podmanOnPath: true }).action, 'use');
  assert.equal(decide({ distroId: 'fedora', existingPaths: ['/run/docker.sock'] }).action, 'use');
});

test('macOS gets guidance even with root and a Debian ID fixture', () => {
  const result = decide({ platform: 'darwin' });
  assert.equal(result.action, 'guide');
  assert.match(result.reason, /Rev4a needs Docker/);
});

test('non-root Linux gets guidance on an otherwise eligible host', () => {
  const result = decide({ isRoot: false });
  assert.equal(result.action, 'guide');
  assert.match(result.reason, /sudo rev4a serve/);
});

test('root on Debian, Ubuntu, or a derivative can install when no runtime is found', () => {
  assert.equal(decide().action, 'install');
  assert.equal(decide({ distroId: 'ubuntu' }).action, 'install');
  assert.equal(decide({ distroId: 'mint', distroIdLike: 'linux ubuntu' }).action, 'install');
  assert.equal(decide({ distroId: undefined, distroIdLike: 'debian' }).action, 'install');
  assert.equal(decide({ env: { REV4A_DOCKER_AUTO_INSTALL: '1' } }).action, 'install');
});

test('Fedora, missing distro metadata, and partial distro-name matches get guidance', () => {
  for (const distro of [
    { distroId: 'fedora', distroIdLike: 'rhel centos' },
    { distroId: undefined },
    { distroId: 'ubuntu-like', distroIdLike: 'notdebian' },
  ]) {
    const result = decide(distro);
    assert.equal(result.action, 'guide');
    assert.match(result.reason, /requires Debian, Ubuntu, or a derivative/);
  }
});

const cliUrl = new URL('../bin/rev4a.js', import.meta.url);
const cliSource = fs.readFileSync(cliUrl, 'utf8').split('// ── CLI entry point')[0];
const cliRequire = createRequire(cliUrl);

function installHarness(t) {
  const runDir = fs.mkdtempSync(join(tmpdir(), 'rev4a-docker-lock-'));
  t.after(() => fs.rmSync(runDir, { recursive: true, force: true }));
  const systemPath = (path) => path.replace(/^\/run\//, `${runDir}/`);
  const lockPath = systemPath('/run/rev4a-docker-install.lock');
  const commands = [];
  const logs = [];
  const paths = new Set();
  const host = { docker: false, now: 0, onLock() {}, onApt() {} };
  let guardOwner;
  const ensure = runInNewContext(`${cliSource}\nensureDocker;`, {
    __dirname: fileURLToPath(new URL('.', cliUrl)),
    process: { env: {}, getuid: () => 0 },
    console: { log: (line) => logs.push(line) },
    require(name) {
      if (name === 'os') return { ...cliRequire(name), platform: () => 'linux' };
      if (name === 'node:perf_hooks') return { performance: { now: () => host.now } };
      if (name === 'fs') return {
        ...fs,
        existsSync: (path) => paths.has(path),
        readFileSync: (path) => {
          assert.equal(path, '/etc/os-release');
          return 'ID=ubuntu\nID_LIKE=debian\n';
        },
        mkdirSync: (path, options) => fs.mkdirSync(systemPath(path), options),
        openSync: (path, flags, mode) => fs.openSync(systemPath(path), flags, mode),
        lstatSync: (path) => fs.lstatSync(systemPath(path)),
        unlinkSync: (path) => fs.unlinkSync(systemPath(path)),
        closeSync: (fd) => {
          fs.closeSync(fd);
          if (guardOwner === fd) guardOwner = undefined;
        },
      };
      if (name === 'child_process') return {
        spawnSync(command, args, options) {
          assert.equal(command, 'flock');
          assert.deepEqual([...args], ['--exclusive', '--nonblock', '0']);
          if (guardOwner !== undefined) return { status: 1 };
          guardOwner = options.stdio[0];
          host.onLock();
          return { status: 0 };
        },
        execFileSync(command, args, options) {
          assert.equal(command, 'apt-get');
          assert.equal(fs.existsSync(lockPath), true);
          commands.push([args[0], options.timeout]);
          host.onApt(args[0]);
        },
        execSync(command, options) {
          if (command === 'which docker' && host.docker) return;
          if (command === 'which docker' || command === 'which podman') throw new Error('missing');
          if (command === 'docker info --format "{{.ServerVersion}}"') {
            assert.equal(fs.existsSync(lockPath), false);
            commands.push(['wait']);
            return Buffer.from('27.0.0');
          }
          assert.equal(command, 'curl -fsSL https://get.docker.com | sh');
          assert.equal(fs.existsSync(lockPath), true);
          commands.push(['script', options.timeout]);
        },
      };
      return cliRequire(name);
    },
  });
  return { ensure, commands, logs, lockPath, paths, host };
}

test('the lock excludes an overlapping launch and install phases share a monotonic deadline', (t) => {
  const { ensure, commands, logs, lockPath, host } = installHarness(t);
  host.onApt = (step) => {
    if (step === 'update') {
      assert.equal(ensure(), false);
      host.now = 35_000;
    } else {
      host.now = 125_000;
    }
  };
  assert.equal(ensure(), true);
  assert.deepEqual(commands, [['update', 120_000], ['install', 85_000], ['script', 175_000], ['wait']]);
  assert.equal(logs.filter((line) => line.includes('installing it with the official script')).length, 1);
  assert.ok(logs.some((line) => line.includes('Another Rev4a launch')));
  assert.equal(fs.existsSync(lockPath), false);
});

test('Docker appearing before apt or before the install script stops installation', (t) => {
  const beforeApt = installHarness(t);
  beforeApt.host.onLock = () => { beforeApt.host.docker = true; };
  assert.equal(beforeApt.ensure(), true);
  assert.deepEqual(beforeApt.commands, [['wait']]);

  const beforeScript = installHarness(t);
  beforeScript.host.onApt = (step) => {
    if (step === 'install') beforeScript.paths.add('/run/docker.sock');
  };
  assert.equal(beforeScript.ensure(), false);
  assert.deepEqual(beforeScript.commands.map(([step]) => step), ['update', 'install']);
  assert.ok(beforeScript.logs.some((line) => line.includes('Docker socket found at /run/docker.sock')));
  assert.equal(fs.existsSync(beforeScript.lockPath), false);
});

test('a recent leftover lock blocks install, and a stale one is replaced and cleaned up on failure', (t) => {
  const { ensure, commands, logs, lockPath, host } = installHarness(t);
  fs.writeFileSync(lockPath, '');
  assert.equal(ensure(), false);
  assert.deepEqual(commands, []);
  assert.equal(fs.existsSync(lockPath), true);

  const staleTime = new Date(Date.now() - 16 * 60_000);
  fs.utimesSync(lockPath, staleTime, staleTime);
  host.onApt = () => { throw new Error('apt fixture failure'); };
  assert.equal(ensure(), false);
  assert.deepEqual(commands, [['update', 120_000]]);
  assert.ok(logs.some((line) => line.includes('Ignoring stale Docker auto-install lock')));
  assert.equal(fs.existsSync(lockPath), false);
});
