import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { chmodSync, copyFileSync, cpSync, lstatSync, symlinkSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import {
  describePortListeners, isRecordedProcess, readPidRecord, readProcessStartTime,
  removePidRecord, stopRev4aPids, waitForPort, writePidRecord,
} from '../lib/port-owner.js';

const port = 4242;
const entry = fileURLToPath(new URL('../bin/rev4a.js', import.meta.url));
// Linux start times are qualified with the boot id (lib/port-owner.js).
const BOOT = 'b1c2d3e4-0000-4000-8000-00000000000a';
const record = (pid, startTime = `${BOOT}:1234`, recordedPort = port) => ({
  pid, port: recordedPort, startTime, root: '/removed/old-install',
});
const fsFiles = { readFileSync: (file) => readFileSync(file, 'utf8'), chmodSync, renameSync, unlinkSync, writeFileSync };

function stat(pid, startTime, state = 'S') {
  return [`${pid} (node ) fixture)`, state, ...Array(18).fill('0'), startTime, '999'].join(' ');
}

function linuxReaders(stats) {
  return {
    platform: 'linux',
    readFileSync(file) {
      if (Object.hasOwn(stats, file)) return stats[file];
      if (file === '/proc/sys/kernel/random/boot_id') return `${BOOT}\n`;
      throw Object.assign(new Error('Unreadable'), { code: 'EACCES' });
    },
  };
}

test('Linux reads stat field 22 and treats unreadable, malformed and zombie entries as absent', () => {
  const readers = linuxReaders({
    '/proc/12/stat': stat(12, '98765'),
    '/proc/13/stat': 'malformed',
    '/proc/14/stat': stat(14, '1234', 'Z'),
    '/proc/sys/kernel/random/boot_id': 'b1c2d3e4-0000-4000-8000-00000000000a\n',
  });
  const boot = 'b1c2d3e4-0000-4000-8000-00000000000a';
  assert.equal(readProcessStartTime(12, readers), `${boot}:98765`);
  assert.equal(isRecordedProcess(record(12, `${boot}:98765`), readers), true);
  // The same PID and tick count from before a reboot (another boot id) never matches.
  assert.equal(isRecordedProcess(record(12, 'aaaaaaaa-0000-4000-8000-000000000000:98765'), readers), false);
  assert.equal(isRecordedProcess(record(12, '98765'), readers), false);
  for (const pid of [12, 13, 14, 15]) assert.equal(isRecordedProcess(record(pid), readers), false);
});

test('a PID record is trusted only as a regular file owned by the running user', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rev4a-test-owner-'));
  try {
    const file = join(dir, 'server.pid');
    writePidRecord(file, record(4242, 'x', 3760), fsFiles);
    const uid = process.getuid();
    assert.equal(readPidRecord(file, fsFiles.readFileSync, { lstatSync: statSync, uid })?.pid, 4242);
    assert.equal(readPidRecord(file, fsFiles.readFileSync, { lstatSync: statSync, uid: uid + 1 }), null);
    const link = join(dir, 'link.pid');
    symlinkSync(file, link);
    assert.equal(readPidRecord(link, fsFiles.readFileSync, { lstatSync, uid }), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('macOS reads the full lstart value via argv and fails closed when ps cannot read it', () => {
  const startTime = 'Tue Nov 24 08:09:10 2026';
  const calls = [];
  const readers = {
    platform: 'darwin',
    execFileSync(file, args) {
      calls.push([file, args]);
      if (args.at(-1) === '13') throw new Error('ps exit 1');
      return args.at(-1) === '14' ? ' ' : ` ${startTime}\n`;
    },
  };
  assert.equal(isRecordedProcess(record(12, startTime), readers), true);
  assert.equal(isRecordedProcess(record(13, startTime), readers), false);
  assert.equal(isRecordedProcess(record(14, startTime), readers), false);
  assert.deepEqual(calls, [12, 13, 14].map((pid) => ['ps', ['-o', 'lstart=', '-p', String(pid)]]));
});

test('port diagnostics use argv on Linux and macOS and tolerate missing tools', () => {
  for (const [platform, tool, args] of [
    ['linux', 'ss', ['-Hltnp', 'sport', '=', ':4242']],
    ['darwin', 'lsof', ['-nP', '-iTCP:4242', '-sTCP:LISTEN']],
  ]) {
    const calls = [];
    const execFileSync = (...argv) => { calls.push(argv); return 'listener PID 12\n'; };
    assert.equal(describePortListeners(port, { platform, execFileSync }), 'listener PID 12');
    assert.equal(describePortListeners('4242; cmd', { platform, execFileSync }), '');
    assert.deepEqual(calls, [[tool, args]]);
    assert.equal(describePortListeners(port, {
      platform,
      execFileSync() { throw Object.assign(new Error('Missing tool'), { code: 'ENOENT' }); },
    }), '');
  }
});

test('PID records are private and atomic, and cleanup preserves a replacement', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'rev4a-test-pid-record-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'server.pid');
  assert.equal(readPidRecord(file, fsFiles.readFileSync), null);
  writeFileSync(file, '{');
  assert.equal(readPidRecord(file, fsFiles.readFileSync), null);
  writeFileSync(file, JSON.stringify(record(1)));
  assert.equal(readPidRecord(file, fsFiles.readFileSync), null);
  const old = record(20);
  writePidRecord(file, old, {
    ...fsFiles,
    renameSync(temporary, destination) {
      assert.equal(readPidRecord(file, fsFiles.readFileSync), null);
      assert.deepEqual(readPidRecord(temporary, fsFiles.readFileSync), old);
      assert.equal(statSync(temporary).mode & 0o777, 0o600);
      renameSync(temporary, destination);
    },
  });
  assert.deepEqual(readPidRecord(file, fsFiles.readFileSync), old);
  const replacement = record(20, '1235');
  writePidRecord(file, replacement, fsFiles);
  removePidRecord(file, old, fsFiles);
  assert.deepEqual(readPidRecord(file, fsFiles.readFileSync), replacement);
  removePidRecord(file, replacement, fsFiles);
  assert.equal(readPidRecord(file, fsFiles.readFileSync), null);
});

test('TERM then KILL honors the grace period and rechecks identity, skipping PID 1 and self', async () => {
  const stats = Object.fromEntries([1, 7, 9, 10, 11, 12].map((pid) => [`/proc/${pid}/stat`, stat(pid, '1234')]));
  const signals = [];
  const probedPids = new Set();
  let elapsed = 0;
  const records = [-1, 0, 1, 7, 8, 9, 10, 11, 11].map((pid) => record(pid)).concat(record(12, '1235'));
  assert.equal(await stopRev4aPids(records, linuxReaders(stats), {
    selfPid: 7,
    now: () => elapsed,
    sleep: async (ms) => {
      elapsed += ms;
      stats['/proc/10/stat'] = stat(10, '5678');
    },
    kill(pid, signal) {
      probedPids.add(pid);
      if (signal) signals.push([pid, signal, elapsed]);
      if (pid === 9 && signal === 0) throw Object.assign(new Error('Exited'), { code: 'ESRCH' });
    },
  }), true);
  assert.deepEqual([...probedPids], [9, 10, 11]);
  assert.deepEqual(signals, [
    [9, 'SIGTERM', 0], [10, 'SIGTERM', 0], [11, 'SIGTERM', 0], [11, 'SIGKILL', 10000],
  ]);
});

test('the port is re-probed every 200 ms for at most five seconds', async () => {
  let elapsed = 0;
  const checked = [];
  const options = { now: () => elapsed, sleep: async (ms) => { elapsed += ms; } };
  assert.equal(await waitForPort(async () => { checked.push(elapsed); return elapsed >= 400; }, options), true);
  assert.deepEqual(checked, [0, 200, 400]);
  assert.equal(await waitForPort(async () => false, options), false);
  assert.equal(elapsed, 5400);
});

function runMockCli(dataRoot, mode, command, cliArgs = [], envPort = String(port)) {
  return spawnSync(process.execPath, ['-e', `
    const assert = require('node:assert/strict');
    const cp = require('node:child_process');
    const fs = require('node:fs');
    const net = require('node:net');
    const { join } = require('node:path');
    const { EventEmitter } = require('node:events');
    process.argv = [process.execPath, ...process.argv.slice(1)];
    const mode = process.env.PORT_TEST_MODE;
    const owned = mode === 'owned';
    const live = new Set([12345, 12346]);
    let elapsed = 0;
    let releasedAt = Infinity;
    let diagnostics = 0;
    Object.defineProperty(process, 'platform', { value: 'linux' });
    Object.defineProperty(performance, 'now', { value: () => elapsed });
    require('node:timers/promises').setTimeout = async (ms) => { elapsed += ms; };
    cp.execFileSync = (file, args) => {
      diagnostics++;
      assert.deepEqual([file, args], ['ss', ['-Hltnp', 'sport', '=', ':4242']]);
      if (mode === 'foreign') return 'node PID 12345';
      if (mode === 'unknown') throw Object.assign(new Error('Missing ss'), { code: 'ENOENT' });
      throw new Error('Unexpected diagnostic');
    };
    cp.execSync = () => { throw new Error('Unexpected shell invocation'); };
    let launches = 0;
    cp.spawnSync = (command, args) => {
      assert.ok(mode === 'free' || owned, 'Unexpected _run spawn');
      console.log('Launching', ...args.slice(1), 'at', elapsed);
      return { status: launches++ === 0 ? 42 : 0 };
    };
    const read = fs.readFileSync;
    fs.readFileSync = (path, ...args) => {
      const pid = Number(/^\\/proc\\/(\\d+)\\/stat$/.exec(path)?.[1]);
      if (path === '/proc/sys/kernel/random/boot_id') return 'b1c2d3e4-0000-4000-8000-00000000000a\\n';
      if (live.has(pid)) return [pid + ' (node)', 'S', ...Array(18).fill('0'), '1234'].join(' ');
      return read(path, ...args);
    };
    process.kill = (pid, signal) => {
      assert.ok(owned && (live.has(pid) || signal === 0), 'Unexpected signal');
      if (!live.has(pid)) throw Object.assign(new Error('Exited'), { code: 'ESRCH' });
      if (!signal) return;
      if (process.argv[2] === 'restart') {
        assert.equal(pid, 12345, 'The flag watcher must survive the fallback');
        assert.equal(read(join(process.env.REV4A_DATA_DIR, 'data', '.restart-flag'), 'utf8'), '');
        live.delete(pid);
      } else if (pid === 12346) {
        assert.equal(signal, 'SIGTERM');
        live.delete(pid);
      } else if (signal === 'SIGKILL') {
        releasedAt = elapsed + 400;
      }
    };
    net.createServer = () => {
      const probe = new EventEmitter();
      probe.listen = (port, ready) => {
        assert.notEqual(mode, 'invalid', 'Invalid port reached the bind probe');
        if (mode === 'free' || elapsed >= releasedAt) ready();
        else probe.emit('error', Object.assign(new Error('Occupied'), { code: 'EADDRINUSE' }));
      };
      probe.close = (done) => done();
      return probe;
    };
    process.on('exit', () => {
      assert.equal(diagnostics, process.argv[2] === 'serve' && ['foreign', 'unknown'].includes(mode) ? 1 : 0);
    });
    require(process.argv[1]);
  `, '--', entry, command, ...cliArgs], {
    encoding: 'utf8', timeout: 5000,
    env: { ...process.env, REV4A_DATA_DIR: dataRoot, PORT: envPort, PORT_TEST_MODE: mode },
  });
}

test('CLI refuses foreign listeners and starts on free ports with no listener tools', (t) => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'rev4a-test-cli-'));
  t.after(() => rmSync(dataRoot, { recursive: true, force: true }));
  const data = join(dataRoot, 'data');
  mkdirSync(data);
  writePidRecord(join(data, 'server.pid'), record(12345, `${BOOT}:9999`), fsFiles);
  writePidRecord(join(data, 'run.pid'), record(12346, `${BOOT}:1234`, port + 1), fsFiles);

  for (const mode of ['foreign', 'unknown']) {
    const busy = runMockCli(dataRoot, mode, 'serve');
    assert.equal(busy.status, 1, busy.stderr);
    assert.match(busy.stderr, /Port 4242 is already in use by another program\./);
    assert.match(busy.stderr, /PORT=<n> rev4a serve or rev4a serve --port <n>/);
    if (mode === 'foreign') assert.match(busy.stderr, /node PID 12345/);
    assert.doesNotMatch(busy.stdout + busy.stderr, /Launching|Unexpected signal/);
  }

  const restart = runMockCli(dataRoot, 'foreign', 'restart');
  assert.equal(restart.status, 0, restart.stderr);
  assert.doesNotMatch(restart.stdout, /Sent SIG/);
  assert.equal(fsFiles.readFileSync(join(data, '.restart-flag')), '');

  const free = runMockCli(dataRoot, 'free', 'serve', ['--port', String(port)], 'abc');
  assert.equal(free.status, 0, free.stderr);
  assert.match(free.stdout, /Launching _run 4242 at 0\n\[REV4A\] Restarting…\nLaunching _run 4242 at 1000/);
});

test('CLI waits for port release after KILL and restarts a recorded server on a custom port', (t) => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'rev4a-test-cli-owned-'));
  t.after(() => rmSync(dataRoot, { recursive: true, force: true }));
  const data = join(dataRoot, 'data');
  mkdirSync(data);
  writePidRecord(join(data, 'server.pid'), record(12345), fsFiles);
  writePidRecord(join(data, 'run.pid'), record(12346), fsFiles);

  const serve = runMockCli(dataRoot, 'owned', 'serve');
  assert.equal(serve.status, 0, serve.stderr);
  assert.match(serve.stdout, /Sent SIGTERM to Rev4a process \(PID 12346\)/);
  assert.match(serve.stdout, /Sent SIGTERM to Rev4a process \(PID 12345\)/);
  assert.match(serve.stdout, /Sent SIGKILL to Rev4a process \(PID 12345\)\nLaunching _run 4242 at 10400/);
  const restart = runMockCli(dataRoot, 'owned', 'restart', [], '3740');
  assert.equal(restart.status, 0, restart.stderr);
  assert.match(restart.stdout, /Restart signal sent\..*\n.*Sent SIGTERM to Rev4a process \(PID 12345\)/);
  assert.doesNotMatch(restart.stdout, /SIGKILL|PID 12346/);
});

test('CLI rejects invalid explicit ports before probing or preflight', (t) => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'rev4a-test-cli-port-'));
  t.after(() => rmSync(dataRoot, { recursive: true, force: true }));
  for (const value of ['abc', '0', '65536', '3740.5', '3740junk', '']) {
    for (const [args, envPort, source] of [[['--port', value], '3740', '--port'], [[], value, 'PORT']]) {
      const result = runMockCli(dataRoot, 'invalid', 'serve', args, envPort);
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stderr, new RegExp(`Invalid dashboard port in ${source}`));
      assert.doesNotMatch(result.stderr, /bind probe/);
    }
  }
  assert.equal(runMockCli(dataRoot, 'invalid', 'serve', ['--port']).status, 1);
  assert.equal(runMockCli(dataRoot, 'invalid', 'serve', ['--port=0']).status, 1);
});

test('_run records itself and its child, consumes the restart flag and exits for relaunch', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'rev4a-test-run-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const root = join(dir, 'package');
  // The whole lib/ directory: bin/rev4a.js may require any CommonJS module from it.
  for (const file of ['bin/rev4a.js', 'package.json']) {
    const target = join(root, file);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(fileURLToPath(new URL(`../${file}`, import.meta.url)), target);
  }
  cpSync(fileURLToPath(new URL('../lib', import.meta.url)), join(root, 'lib'), { recursive: true });
  mkdirSync(join(root, '.next'));
  writeFileSync(join(root, '.next', 'BUILD_ID'), 'test');
  const config = join(dir, 'config');
  const data = join(config, 'data');
  mkdirSync(data, { recursive: true });
  writeFileSync(join(config, '.env'), 'REV4A_PASSWORD=demo\n', { mode: 0o600 });
  writeFileSync(join(data, '.restart-flag'), '');

  const result = spawnSync(process.execPath, ['-e', `
    const assert = require('node:assert/strict');
    const cp = require('node:child_process');
    const fs = require('node:fs');
    const { EventEmitter } = require('node:events');
    const { dirname, join } = require('node:path');
    process.argv = [process.execPath, ...process.argv.slice(1)];
    const root = dirname(dirname(fs.realpathSync(process.argv[1])));
    const data = join(process.env.REV4A_DATA_DIR, 'data');
    Object.defineProperty(process, 'platform', { value: 'linux' });
    require('node:os').platform = () => 'darwin';
    cp.execFileSync = cp.execSync = () => { throw new Error('External command forbidden'); };
    cp.spawnSync = (command, args) => {
      assert.equal(args[0], '-e');
      return { status: 0, stdout: '[]' };
    };
    let pid = 120;
    cp.spawn = (command, args) => {
      const child = new EventEmitter();
      child.pid = ++pid;
      child.spawnfile = args[0];
      child.kill = (signal) => {
        assert.equal(signal, 'SIGTERM');
        queueMicrotask(() => child.emit('exit', null));
      };
      return child;
    };
    const read = fs.readFileSync;
    fs.readFileSync = (file, ...args) => {
      const pid = /^\\/proc\\/(\\d+)\\/stat$/.exec(file)?.[1];
      if (file === '/proc/sys/kernel/random/boot_id') return 'b1c2d3e4-0000-4000-8000-00000000000a\\n';
      if (pid) return [pid + ' (node)', 'S', ...Array(18).fill('0'), '1234'].join(' ');
      return read(file, ...args);
    };
    require('node:net').createServer = () => Object.assign(new EventEmitter(), {
      listen: (port, done) => done(),
      close: (done) => done(),
    });
    global.setInterval = (tick) => {
      queueMicrotask(() => {
        for (const [file, pid] of [['run.pid', process.pid], ['server.pid', 121]]) {
          assert.deepEqual(JSON.parse(read(join(data, file), 'utf8')), { pid, port: 4242, startTime: 'b1c2d3e4-0000-4000-8000-00000000000a:1234', root });
        }
        tick();
      });
      return { unref() {} };
    };
    require(process.argv[1]);
  `, '--', join(root, 'bin', 'rev4a.js'), '_run', String(port)], {
    encoding: 'utf8', timeout: 5000, env: { ...process.env, REV4A_DATA_DIR: config },
  });
  assert.equal(result.status, 42, result.stdout + result.stderr);
  assert.match(result.stdout, /UPDATE — stopping all services/);
  for (const file of ['.restart-flag', 'server.pid', 'run.pid']) {
    assert.throws(() => readFileSync(join(data, file)), { code: 'ENOENT' });
  }
});

const realReaders = {
  platform: process.platform,
  execFileSync: (file, args) => execFileSync(file, args, { encoding: 'utf8', stdio: 'pipe', timeout: 1500 }),
  readFileSync: fsFiles.readFileSync,
};

test('a real loopback listener survives missing and mismatched records and stops with a matching record', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'rev4a-test-listener-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const child = spawn(process.execPath, ['-e', `
    const server = require('node:http').createServer((req, res) => res.end('test'));
    server.once('error', (error) => process.send({ error: error.code }));
    server.listen(0, '127.0.0.1', () => process.send({ port: server.address().port }));
    process.on('message', () => process.send({ alive: server.listening }));
  `], { cwd: dir, stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  const closed = once(child, 'close');
  const timeout = AbortSignal.timeout(5000);
  try {
    const [{ port, error }] = await once(child, 'message', { signal: timeout });
    if (error === 'EPERM' || error === 'EACCES') return t.skip(`Loopback bind denied: ${error}`);
    assert.ifError(error);
    assert.ok(port > 0);
    const startTime = readProcessStartTime(child.pid, realReaders);
    assert.ok(startTime, 'Could not read the test listener start time');

    const file = join(dir, 'server.pid');
    const stop = () => {
      const candidate = readPidRecord(file, fsFiles.readFileSync);
      return stopRev4aPids(candidate?.port === port ? [candidate] : [], realReaders, {
        selfPid: process.pid, now: () => performance.now(), sleep,
        kill(pid, signal) {
          assert.equal(pid, child.pid);
          process.kill(pid, signal);
        },
      });
    };
    const assertListening = async () => {
      const reply = once(child, 'message', { signal: timeout });
      child.send('status');
      assert.deepEqual((await reply)[0], { alive: true });
    };
    assert.equal(await stop(), false);
    await assertListening();
    writePidRecord(file, record(child.pid, `${startTime}-mismatch`, port), fsFiles);
    assert.equal(await stop(), false);
    await assertListening();
    writePidRecord(file, record(child.pid, startTime, port), fsFiles);
    assert.equal(await stop(), true);
    assert.deepEqual(await closed, [null, 'SIGTERM']);

    const probe = createServer();
    probe.listen(port, '127.0.0.1');
    await once(probe, 'listening');
    probe.close();
    await once(probe, 'close');
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await closed;
  }
});
