import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { seedGatewayKey } from '../lib/gateway-key-seed.js';

const generated = 'Gateway key generated (provider-keys.json)';
const unreadable = 'Warning: provider-keys.json is not valid JSON; Gateway key not generated';
const changed = 'Warning: provider-keys.json changed during startup; Gateway key not generated';
const foreignOwner = 'Warning: provider-keys.json belongs to another user; Gateway key not generated';
const unresolved = 'Warning: could not resolve the data directory; Gateway key not generated';
const hexKey = /^[a-f0-9]{48}$/;

function fixture(t) {
  const dir = fs.mkdtempSync(join(tmpdir(), 'rev4a-gateway-key-seed-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'provider-keys.json');
  const logs = [];
  const log = (message) => logs.push(message);
  return { dir, file, logs, log };
}

function checkMode(file) {
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
}

test('creates the parent and a private key file, migrating only nonempty legacy upstream values', (t) => {
  const { dir, log, logs } = fixture(t);
  const file = join(dir, 'nested', 'data', 'provider-keys.json');
  const env = {
    PROVIDER_DEEPSEEK_API_KEY: ' fixture-deepseek ',
    PROVIDER_OPENROUTER_API_KEY: 'fixture-openrouter',
    REV4A_API_KEY: 'fixture-legacy-master',
    PROVIDER_OTHER_API_KEY: 'fixture-other',
  };
  assert.equal(seedGatewayKey(file, env, log), 'created-file');
  const { rev4a, ...providers } = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.match(rev4a, hexKey);
  assert.deepEqual(providers, { deepseek: env.PROVIDER_DEEPSEEK_API_KEY, openrouter: env.PROVIDER_OPENROUTER_API_KEY });
  checkMode(file);
  assert.deepEqual(fs.readdirSync(dirname(file)), ['provider-keys.json']);
  assert.deepEqual(logs, [generated]);
  for (const credential of [rev4a, ...Object.values(env)]) assert.equal(logs.join('\n').includes(credential), false);

  fs.utimesSync(file, 1, 1);
  const mtime = fs.statSync(file).mtimeMs;
  const original = fs.readFileSync(file);
  assert.equal(seedGatewayKey(file, {}, log), 'exists');
  assert.equal(fs.statSync(file).mtimeMs, mtime);
  assert.deepEqual(fs.readFileSync(file), original);
  assert.deepEqual(logs, [generated]);
});

test('defaults to process.env and skips empty legacy values', (t) => {
  const { file, log } = fixture(t);
  const deepseek = process.env.PROVIDER_DEEPSEEK_API_KEY;
  const openrouter = process.env.PROVIDER_OPENROUTER_API_KEY;
  t.after(() => {
    if (deepseek === undefined) delete process.env.PROVIDER_DEEPSEEK_API_KEY;
    else process.env.PROVIDER_DEEPSEEK_API_KEY = deepseek;
    if (openrouter === undefined) delete process.env.PROVIDER_OPENROUTER_API_KEY;
    else process.env.PROVIDER_OPENROUTER_API_KEY = openrouter;
  });
  process.env.PROVIDER_DEEPSEEK_API_KEY = 'fixture-process-deepseek';
  process.env.PROVIDER_OPENROUTER_API_KEY = '';
  assert.equal(seedGatewayKey(file, undefined, log), 'created-file');
  const { rev4a, ...providers } = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.match(rev4a, hexKey);
  assert.deepEqual(providers, { deepseek: 'fixture-process-deepseek' });
});

test('adds a key for every missing or invalid entry, preserving the other values and tightening mode', (t) => {
  const { file, log, logs } = fixture(t);
  const existing = JSON.parse('{"deepseek":" fixture\\n","custom":{"nested":[null,true]},"__proto__":"fixture"}');
  for (const previous of [undefined, '', ' \n\t ', null, 0, true, {}, []]) {
    fs.writeFileSync(file, JSON.stringify({ ...existing, rev4a: previous }));
    if (process.platform !== 'win32') fs.chmodSync(file, 0o644);
    assert.equal(seedGatewayKey(file, { PROVIDER_DEEPSEEK_API_KEY: 'ignored', PROVIDER_OPENROUTER_API_KEY: 'ignored' }, log), 'added');
    const { rev4a, ...providers } = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.match(rev4a, hexKey);
    assert.deepEqual(providers, existing);
    checkMode(file);
  }
  assert.deepEqual(logs, Array(8).fill(generated));
});

test('preserves bytes, modification time and permissions for an existing nonblank key', (t) => {
  const { file, log, logs } = fixture(t);
  const original = '{ "rev4a": " fixture-existing ", "deepseek": "fixture-upstream" }\n';
  fs.writeFileSync(file, original);
  const before = fs.statSync(file);
  assert.equal(seedGatewayKey(file, {}, log), 'exists');
  assert.equal(fs.readFileSync(file, 'utf8'), original);
  const after = fs.statSync(file);
  assert.equal(after.mtimeMs, before.mtimeMs);
  assert.equal(after.mode, before.mode);
  assert.deepEqual(logs, []);
});

test('preserves the exact values of large and nested numbers when adding a key', (t) => {
  const { file, log } = fixture(t);
  fs.writeFileSync(file, '{"custom":[9007199254740993,1e999,-0]}');
  assert.equal(seedGatewayKey(file, {}, log), 'added');
  assert.match(fs.readFileSync(file, 'utf8'), /\[\s*9007199254740993,\s*1e999,\s*-0\s*\]/);
});

test('leaves invalid, truncated and non-object files untouched', (t) => {
  const { dir, file, log, logs } = fixture(t);
  const invalid = ['', 'broken JSON fixture', '{"deepseek":"fixture-truncated"', '[]', 'null', '"fixture-string"', '12', 'true'];
  for (const original of invalid) {
    fs.writeFileSync(file, original);
    const before = fs.statSync(file);
    assert.equal(seedGatewayKey(file, { PROVIDER_DEEPSEEK_API_KEY: 'ignored' }, log), 'skipped-unreadable');
    assert.equal(fs.readFileSync(file, 'utf8'), original);
    const after = fs.statSync(file);
    assert.equal(after.mtimeMs, before.mtimeMs);
    assert.equal(after.mode, before.mode);
  }
  assert.deepEqual(logs, invalid.map(() => unreadable));
  assert.deepEqual(fs.readdirSync(dir), ['provider-keys.json']);
});

test('rejects invalid UTF-8 and UTF-8 BOM without modifying the input bytes', (t) => {
  const { file, log, logs } = fixture(t);
  const invalidUtf8 = Buffer.concat([Buffer.from('{"deepseek":"'), Buffer.from([0xff]), Buffer.from('"}')]);
  const withBom = Buffer.from('\ufeff{"deepseek":"fixture-upstream"}');
  for (const [name, original] of [['invalid UTF-8', invalidUtf8], ['UTF-8 BOM', withBom]]) {
    fs.writeFileSync(file, original);
    const result = seedGatewayKey(file, {}, log);
    assert.equal(result, 'skipped-unreadable');
    assert.deepEqual(fs.readFileSync(file), original);
    t.diagnostic(`${name}: ${result}, bytes preserved`);
  }
  assert.deepEqual(logs, [unreadable, unreadable]);
});

test('skips a group-writable file owned by another user on POSIX', { skip: process.platform === 'win32' }, (t) => {
  const { dir, file, log, logs } = fixture(t);
  const original = '{"deepseek":"fixture-upstream"}';
  fs.writeFileSync(file, original);
  fs.chmodSync(file, 0o664);
  const target = fs.realpathSync(file);
  const statSync = fs.statSync;
  t.mock.method(fs, 'statSync', (path, ...args) => {
    const stat = statSync(path, ...args);
    if (path === target) stat.uid = process.getuid() + 1;
    return stat;
  });
  const result = seedGatewayKey(file, {}, log);
  assert.equal(result, 'skipped-error');
  assert.equal(fs.readFileSync(file, 'utf8'), original);
  assert.equal(statSync(file).mode & 0o777, 0o664);
  assert.deepEqual(logs, [foreignOwner]);
  assert.deepEqual(fs.readdirSync(dir), ['provider-keys.json']);
  t.diagnostic(`${result}, file preserved: ${logs[0]}`);
});

for (const writer of ['second startup', 'Gateway save', 'file deletion']) {
  test(`preserves a ${writer} that changes an existing file during startup`, (t) => {
    const { dir, file, log, logs } = fixture(t);
    fs.writeFileSync(file, '{"deepseek":"fixture-old-upstream"}');
    const writeFileSync = fs.writeFileSync;
    let interleaved = false;
    let winner;
    t.mock.method(fs, 'writeFileSync', (...args) => {
      writeFileSync(...args);
      if (interleaved) return;
      interleaved = true;
      if (writer === 'second startup') {
        assert.equal(seedGatewayKey(file, {}, log), 'added');
      } else if (writer === 'Gateway save') {
        writeFileSync(file, '{"rev4a":"fixture-manual-key","deepseek":"fixture-new-upstream"}');
      } else {
        fs.unlinkSync(file);
        return;
      }
      winner = fs.readFileSync(file);
    });
    const result = seedGatewayKey(file, {}, log);
    assert.equal(result, 'skipped-changed');
    if (winner) assert.deepEqual(fs.readFileSync(file), winner);
    assert.deepEqual(fs.readdirSync(dir), winner ? ['provider-keys.json'] : []);
    assert.deepEqual(logs, writer === 'second startup' ? [generated, changed] : [changed]);
    t.diagnostic(`${result}, ${writer} preserved, no temporary file: ${logs.at(-1)}`);
  });
}

for (const writer of ['second startup', 'credential save', 'in-progress creation']) {
  test(`preserves a ${writer} that wins exclusive creation of a missing file`, (t) => {
    const { dir, file, log, logs } = fixture(t);
    const openSync = fs.openSync;
    let winner;
    let interleaved = false;
    t.mock.method(fs, 'openSync', (path, flags, ...args) => {
      if (path === file && flags === 'wx' && !interleaved) {
        interleaved = true;
        if (writer === 'second startup') {
          assert.equal(seedGatewayKey(file, { PROVIDER_DEEPSEEK_API_KEY: 'fixture-winner' }, log), 'created-file');
        } else {
          fs.writeFileSync(file, writer === 'credential save' ? '{"deepseek":"fixture-winner"}' : '{"deepseek":');
        }
        winner = fs.readFileSync(file);
      }
      return openSync(path, flags, ...args);
    });
    const result = seedGatewayKey(file, { PROVIDER_OPENROUTER_API_KEY: 'fixture-contender' }, log);
    const createdKey = writer === 'second startup';
    assert.equal(result, createdKey ? 'exists' : 'skipped-changed');
    assert.deepEqual(fs.readFileSync(file), winner);
    assert.deepEqual(fs.readdirSync(dir), ['provider-keys.json']);
    assert.deepEqual(logs, [createdKey ? generated : changed]);
    t.diagnostic(`${result}, ${writer} preserved: ${logs[0]}`);
  });
}

test('an unwritable directory yields only the filesystem error code', (t) => {
  const { dir, file, log, logs } = fixture(t);
  if (process.platform !== 'win32' && process.getuid?.() !== 0) {
    fs.chmodSync(dir, 0o500);
    try {
      assert.equal(seedGatewayKey(file, {}, log), 'skipped-error');
    } finally {
      fs.chmodSync(dir, 0o700);
    }
  } else {
    // Privileged users and Windows can bypass POSIX directory permissions.
    t.mock.method(fs, 'openSync', () => { throw Object.assign(new Error('fixture secret'), { code: 'EACCES' }); });
    assert.equal(seedGatewayKey(file, {}, log), 'skipped-error');
  }
  assert.deepEqual(logs, ['Warning: could not write the Gateway key (EACCES)']);
  assert.deepEqual(fs.readdirSync(dir), []);
});

for (const method of ['writeFileSync', 'renameSync']) {
  test(`a failed ${method} cleans up the temp file and preserves the original`, (t) => {
    const { dir, file, log, logs } = fixture(t);
    const original = '{"deepseek":"fixture-upstream"}';
    fs.writeFileSync(file, original);
    let attempted = false;
    const writeFileSync = fs.writeFileSync;
    t.mock.method(fs, method, (source) => {
      if (method === 'writeFileSync') writeFileSync(source, '{"partial":');
      else assert.match(source, /provider-keys\.json\.tmp-\d+-[a-f0-9]+$/);
      attempted = true;
      throw Object.assign(new Error('fixture secret and filesystem path'), { code: 'ENOSPC' });
    });
    assert.equal(seedGatewayKey(file, {}, log), 'skipped-error');
    assert.equal(attempted, true);
    assert.deepEqual(logs, ['Warning: could not write the Gateway key (ENOSPC)']);
    assert.equal(fs.readFileSync(file, 'utf8'), original);
    assert.deepEqual(fs.readdirSync(dir), ['provider-keys.json']);
  });
}

test('a failed exclusive create removes the partial file', (t) => {
  const { dir, file, log, logs } = fixture(t);
  const writeFileSync = fs.writeFileSync;
  t.mock.method(fs, 'writeFileSync', (fd) => {
    writeFileSync(fd, '{"partial":');
    throw Object.assign(new Error('fixture secret'), { code: 'ENOSPC' });
  });
  assert.equal(seedGatewayKey(file, {}, log), 'skipped-error');
  assert.deepEqual(logs, ['Warning: could not write the Gateway key (ENOSPC)']);
  assert.deepEqual(fs.readdirSync(dir), []);
});

function launcherFixture(t, overrides = {}) {
  const { dir } = fixture(t);
  const app = join(dir, 'app');
  const config = join(dir, 'config');
  const cli = join(app, 'bin', 'rev4a.js');
  const stub = join(dir, 'stop-at-preflight.cjs');
  fs.mkdirSync(dirname(cli), { recursive: true });
  fs.copyFileSync(new URL('../bin/rev4a.js', import.meta.url), cli);
  for (const name of ['lib', 'node_modules']) {
    fs.symlinkSync(fileURLToPath(new URL(`../${name}`, import.meta.url)), join(app, name), 'junction');
  }
  // Stop after environment setup, before launching any command or service.
  fs.writeFileSync(stub, `
    if (process.env.HOME === undefined) require('node:os').homedir = () => process.cwd();
    const children = require('node:child_process');
    const { spawnSync } = children;
    const probeFailures = {
      'non-zero exit': { status: 1, stdout: '' },
      timeout: { status: null, error: { code: 'ETIMEDOUT' } },
      'invalid JSON': { status: 0, stdout: 'invalid JSON' },
      'missing data root': { status: 0, stdout: '{}' },
    };
    children.spawnSync = (command, args, options) => {
      const failure = probeFailures[process.env.REV4A_TEST_ENV_PROBE];
      if (failure && args[0] === '-e' && args[1].includes('dataRoot')) return failure;
      return spawnSync(command, args, options);
    };
    children.execSync = (command) => {
      if (command !== 'which docker' && command !== 'npx next build') throw new Error('Unexpected command');
      console.log('Reached preflight boundary.');
      process.exit(0);
    };
  `);
  const env = {
    PATH: process.env.PATH,
    HOME: dir,
    USERPROFILE: dir,
    APPDATA: join(dir, 'roaming'),
    REV4A_DATA_DIR: config,
    PROVIDER_DEEPSEEK_API_KEY: 'fixture-service-deepseek',
    ...overrides,
  };
  const run = (...args) => execFileSync(process.execPath, ['--require', stub, cli, ...args], {
    cwd: dir, env, encoding: 'utf8', timeout: 15000,
  });
  return { app, config, dir, run };
}

test('fresh startup seeds the overridden data directory and migrates the server dotenv fallback', (t) => {
  const { app, config, run } = launcherFixture(t);
  fs.writeFileSync(join(app, '.env.production'), 'PROVIDER_OPENROUTER_API_KEY=fixture-production\n');
  const stdout = run('_run', '3740');
  const file = join(config, 'data', 'provider-keys.json');
  const keys = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.match(keys.rev4a, hexKey);
  assert.equal(keys.deepseek, 'fixture-service-deepseek');
  assert.equal(keys.openrouter, 'fixture-production');
  assert.ok(stdout.includes(`[ENV] ${generated}`));
  for (const credential of Object.values(keys)) assert.equal(stdout.includes(credential), false);
  assert.ok(fs.existsSync(join(config, 'data', 'agents-token.json')));
  assert.equal(run('_run', '3740').includes(generated), false);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), keys);
});

test('an existing configuration seeds at startup and resolves relative overrides from the server', (t) => {
  const { app, config, run } = launcherFixture(t);
  fs.mkdirSync(config);
  fs.writeFileSync(join(config, '.env'), 'REV4A_DATA_DIR=redirected\nPROVIDER_DEEPSEEK_API_KEY=fixture-dotenv\n');
  const file = join(app, 'redirected', 'data', 'provider-keys.json');
  assert.equal(run('build').includes(generated), false);
  assert.equal(fs.existsSync(file), false);
  assert.ok(run('_run', '3740').includes(`[ENV] ${generated}`));
  const keys = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.match(keys.rev4a, hexKey);
  assert.equal(keys.deepseek, 'fixture-dotenv');
});

for (const failure of ['non-zero exit', 'timeout', 'invalid JSON', 'missing data root']) {
  test(`launcher skips seeding after env probe failure (${failure}) and continues preflight`, (t) => {
    const { app, config, dir, run } = launcherFixture(t, { REV4A_TEST_ENV_PROBE: failure });
    fs.mkdirSync(config);
    fs.writeFileSync(join(config, '.env'), 'REV4A_DATA_DIR=prod\n');
    const stdout = run('_run', '3751');
    assert.ok(stdout.includes(`[ENV] ${unresolved}`));
    assert.ok(stdout.includes('Reached preflight boundary.'));
    for (const root of [config, join(app, 'prod'), join(dir, '.config', 'rev4a')]) {
      assert.equal(fs.existsSync(join(root, 'data', 'provider-keys.json')), false);
    }
    t.diagnostic(`${failure}: ${unresolved}; reached preflight boundary`);
  });
}

for (const dotenv of ['.env', '.env.production']) {
  test(`launcher skips a data root with variable expansion in ${dotenv}`, (t) => {
    const { app, config, dir, run } = launcherFixture(t, dotenv === '.env' ? {} : { REV4A_DATA_DIR: undefined });
    const base = dotenv === '.env' ? config : app;
    fs.mkdirSync(base, { recursive: true });
    fs.writeFileSync(join(base, dotenv), 'REV4A_DATA_DIR=instances/${PORT}\n');
    const stdout = run('_run', '3751');
    assert.ok(stdout.includes(`[ENV] ${unresolved}`));
    assert.ok(stdout.includes('Reached preflight boundary.'));
    assert.equal(fs.existsSync(join(app, 'instances')), false);
    for (const root of [config, join(dir, '.config', 'rev4a')]) {
      assert.equal(fs.existsSync(join(root, 'data', 'provider-keys.json')), false);
    }
    t.diagnostic(`${dotenv} with \${PORT}: ${unresolved}; reached preflight boundary`);
  });
}

test('legacy upstream migration uses the server port and supervised flag for dotenv expansion', (t) => {
  const { app, config, run } = launcherFixture(t);
  fs.writeFileSync(join(app, '.env.production'), 'PROVIDER_OPENROUTER_API_KEY=fixture-${PORT}-${REV4A_SUPERVISED}\n');
  assert.ok(run('_run', '3751').includes(`[ENV] ${generated}`));
  const keys = JSON.parse(fs.readFileSync(join(config, 'data', 'provider-keys.json'), 'utf8'));
  assert.equal(keys.openrouter, 'fixture-3751-1');
  t.diagnostic('Legacy upstream fixture expanded with PORT=3751 and REV4A_SUPERVISED=1');
});

test('launcher honors the dashboard data path with an explicitly empty HOME on POSIX', { skip: process.platform === 'win32' }, (t) => {
  const { app, dir, run } = launcherFixture(t, { HOME: undefined, REV4A_DATA_DIR: undefined });
  const config = join(dir, '.config', 'rev4a');
  fs.mkdirSync(config, { recursive: true });
  fs.writeFileSync(join(config, '.env'), 'HOME=\n');
  assert.ok(run('_run', '3751').includes(`[ENV] ${generated}`));
  const target = join('.config', 'rev4a', 'data', 'provider-keys.json');
  assert.ok(fs.existsSync(join(app, target)));
  assert.equal(fs.existsSync(join(dir, target)), false);
  t.diagnostic(`HOME=: created-file at ${target} relative to the dashboard`);
});
