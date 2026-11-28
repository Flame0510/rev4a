import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { format } from 'node:util';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const env = {
  PROVIDER_DEEPSEEK_API_KEY: 'fixture-deepseek',
  PROVIDER_OPENROUTER_API_KEY: 'fixture-openrouter',
};
const legacyKeys = { deepseek: env.PROVIDER_DEEPSEEK_API_KEY, openrouter: env.PROVIDER_OPENROUTER_API_KEY };
const fakeKey = 'sk-test-SECRET123';
const warning = (reason) =>
  `[provider-keys] provider-keys.json could not be read (${reason}); keys ignored until it is fixed. Its content was not changed.`;
const unreadableError = 'provider-keys.json could not be read. Fix or remove the file, then try again.';
const changedError = 'provider-keys.json changed while saving. Try again.';

function transpile(file) {
  const source = fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
  const { outputText } = ts.transpileModule(source, {
    fileName: file,
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  });
  return new vm.Script(outputText, { filename: file });
}

const keysScript = transpile('app/api/gateway/provider/keys.ts');
const routeScript = transpile('app/api/gateway/provider/route.ts');

function load(script, dependencies, globals = {}) {
  const exports = {};
  script.runInNewContext({
    ...globals,
    exports,
    require: (name) => {
      assert.ok(Object.hasOwn(dependencies, name), `Unexpected dependency: ${name}`);
      return dependencies[name];
    },
  });
  return exports;
}

function fixture(t, { environment = env, filesystem = fs } = {}) {
  const dir = fs.mkdtempSync(path.join(tmpdir(), 'rev4a-provider-keys-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'data', 'provider-keys.json');
  const output = [];
  const capture = Object.fromEntries(['warn', 'error', 'log', 'info', 'debug'].map((level) => [
    level,
    (...args) => output.push([level, format(...args)]),
  ]));
  const keys = load(keysScript, { fs: filesystem, path, '@/lib/rev4a-paths': { PROVIDER_KEYS_FILE: file } }, {
    process: { env: environment },
    TextDecoder,
    console: capture,
  });
  return {
    file, keys, output,
    write(bytes) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, bytes);
      return fs.readFileSync(file);
    },
  };
}

test('missing file with legacy env keys is created with mode 0600', (t) => {
  const { file, keys, output } = fixture(t);
  assert.equal(fs.existsSync(file), false);
  const loaded = keys.loadProviderKeys();
  assert.equal(loaded.state, 'missing');
  assert.deepEqual({ ...loaded.keys }, legacyKeys);
  assert.equal(fs.readFileSync(file, 'utf8'), JSON.stringify(legacyKeys, null, 2));
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(output, []);
  assert.equal(keys.loadProviderKeys().state, 'ok');
});

test('missing file without legacy env keys stays missing', (t) => {
  const { file, keys, output } = fixture(t, { environment: {} });
  assert.equal(fs.existsSync(file), false);
  assert.deepEqual({ ...keys.readProviderKeys() }, {});
  assert.equal(keys.loadProviderKeys().state, 'missing');
  assert.equal(fs.existsSync(file), false);
  assert.deepEqual(output, []);
});

test('empty legacy env values are ignored and either nonempty value can migrate alone', (t) => {
  for (const [environment, expected] of [
    [{ PROVIDER_DEEPSEEK_API_KEY: '', PROVIDER_OPENROUTER_API_KEY: '' }, {}],
    [{ PROVIDER_DEEPSEEK_API_KEY: env.PROVIDER_DEEPSEEK_API_KEY }, { deepseek: legacyKeys.deepseek }],
    [{ PROVIDER_OPENROUTER_API_KEY: env.PROVIDER_OPENROUTER_API_KEY }, { openrouter: legacyKeys.openrouter }],
  ]) {
    const { file, keys, output } = fixture(t, { environment });
    assert.equal(fs.existsSync(file), false);
    assert.deepEqual({ ...keys.readProviderKeys() }, expected);
    if (Object.keys(expected).length) {
      assert.equal(fs.readFileSync(file, 'utf8'), JSON.stringify(expected, null, 2));
      if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
      assert.equal(keys.loadProviderKeys().state, 'ok');
    } else {
      assert.equal(fs.existsSync(file), false);
    }
    assert.deepEqual(output, []);
  }
});

test('a valid object is read without replacing its bytes or using env keys', (t) => {
  const { file, keys, output, write } = fixture(t);
  const original = write('{ "rev4a": "fixture-gateway", "deepseek": "fixture-existing" }\n');
  assert.deepEqual({ ...keys.readProviderKeys() }, { rev4a: 'fixture-gateway', deepseek: 'fixture-existing' });
  assert.equal(keys.loadProviderKeys().state, 'ok');
  assert.deepEqual(fs.readFileSync(file), original);
  assert.deepEqual(output, []);
});

test('malformed JSON is preserved and warnings are deduplicated until it is fixed', (t) => {
  const { file, keys, output, write } = fixture(t);
  const truncated = write('{"rev4a": "x",');
  fs.chmodSync(file, 0o644);
  fs.utimesSync(file, 1, 1);
  assert.deepEqual({ ...keys.readProviderKeys() }, {});
  assert.deepEqual(fs.readFileSync(file), truncated);
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const expected = ['warn', warning('not valid JSON')];
  assert.deepEqual(output, [expected]);

  const broken = write(fakeKey);
  fs.utimesSync(file, 1, 1);
  assert.deepEqual({ ...keys.readProviderKeys() }, {});
  assert.deepEqual(output, [expected, expected]);
  assert.equal(keys.loadProviderKeys().state, 'unreadable');
  assert.deepEqual(fs.readFileSync(file), broken);
  assert.deepEqual(output, [expected, expected]);

  const repaired = write('{"rev4a": "fixture-gateway"}');
  assert.deepEqual({ ...keys.readProviderKeys() }, { rev4a: 'fixture-gateway' });
  assert.deepEqual(fs.readFileSync(file), repaired);
  assert.deepEqual(output, [expected, expected]);

  write(broken);
  fs.utimesSync(file, 1, 1);
  assert.deepEqual({ ...keys.readProviderKeys() }, {});
  assert.deepEqual(fs.readFileSync(file), broken);
  assert.deepEqual(output, [expected, expected, expected]);
  assert.equal(JSON.stringify(output).includes(fakeKey), false);
  t.diagnostic('malformed 0644 file: bytes preserved, mode tightened, no credential in logs');
});

test('a warning is renewed when the modification time, size or reason changes', (t) => {
  const { file, keys, output, write } = fixture(t);
  const broken = write('x');
  fs.utimesSync(file, 1, 1);
  const counts = [];
  const read = (expected, bytes) => {
    assert.deepEqual({ ...keys.readProviderKeys() }, expected);
    assert.deepEqual(fs.readFileSync(file), bytes);
    counts.push(output.length);
  };
  read({}, broken);
  read({}, broken);

  fs.utimesSync(file, 2, 2);
  read({}, broken);

  const larger = write('x!');
  fs.utimesSync(file, 2, 2);
  read({}, larger);

  const array = write('[]');
  fs.utimesSync(file, 2, 2);
  read({}, array);
  read({ rev4a: 'fixture-gateway' }, write('{"rev4a":"fixture-gateway"}'));
  write(array);
  fs.utimesSync(file, 2, 2);
  read({}, array);
  assert.deepEqual(counts, [1, 1, 2, 3, 4, 4, 5]);
  t.diagnostic(`warning counts: ${counts.join(',')}`);
});

for (const raw of ['[]', 'null', '-1', '0', '1', '13', '1e9999', '"fixture"', 'true', 'false']) {
  test(`non-object JSON is unreadable and preserved: ${raw}`, (t) => {
    const { file, keys, output, write } = fixture(t);
    const original = write(raw);
    const loaded = keys.loadProviderKeys();
    assert.equal(loaded.state, 'unreadable');
    assert.deepEqual({ ...loaded.keys }, {});
    assert.deepEqual(fs.readFileSync(file), original);
    assert.deepEqual(output, [['warn', warning('not a JSON object')]]);
  });
}

for (const [label, raw] of [['blank input', ''], ['UTF-8 BOM', '\ufeff{"rev4a":"fixture-gateway"}']]) {
  test(`${label} is invalid JSON and its bytes are preserved`, (t) => {
    const { file, keys, output, write } = fixture(t);
    const original = write(raw);
    assert.equal(keys.loadProviderKeys().state, 'unreadable');
    assert.deepEqual({ ...keys.readProviderKeys() }, {});
    assert.deepEqual(fs.readFileSync(file), original);
    assert.deepEqual(output, [['warn', warning('not valid JSON')]]);
  });
}

test('a directory at the key path is unreadable and left untouched', (t) => {
  const { file, keys, output } = fixture(t);
  fs.mkdirSync(file, { recursive: true });
  const marker = path.join(file, 'marker');
  fs.writeFileSync(marker, 'fixture-bytes');
  const original = fs.readFileSync(marker);
  const mode = fs.statSync(file).mode;
  const loaded = keys.loadProviderKeys();
  assert.equal(loaded.state, 'unreadable');
  assert.deepEqual({ ...loaded.keys }, {});
  assert.deepEqual(fs.readdirSync(file), ['marker']);
  assert.deepEqual(fs.readFileSync(marker), original);
  assert.equal(fs.statSync(file).mode, mode);
  assert.deepEqual(output, [['warn', warning('EISDIR')]]);
});

test('read failures warn with only the errno, even when metadata is inaccessible', (t) => {
  for (const code of ['EACCES', 'ENOTDIR', 'ELOOP', 'EIO']) {
    const deny = () => { throw Object.assign(new Error(fakeKey), { code }); };
    const { file, keys, output, write } = fixture(t, {
      filesystem: { ...fs, readFileSync: deny, statSync: deny },
    });
    const original = write('{"rev4a": "fixture-gateway"}');
    assert.equal(keys.loadProviderKeys().state, 'unreadable');
    assert.deepEqual({ ...keys.readProviderKeys() }, {});
    assert.deepEqual(fs.readFileSync(file), original);
    assert.deepEqual(output, [['warn', warning(code)]]);
    t.diagnostic(`${code}: state=unreadable, bytes preserved, warnings=${output.length}`);
  }
});

function gateway(keys, { denied = false } = {}) {
  let syncs = 0;
  const { POST } = load(routeScript, {
    './keys': keys,
    'next/server': { NextResponse: { json: (body, options) => Response.json(body, options) } },
    child_process: { execSync: () => assert.fail('Unexpected process execution') },
    '../sync': { syncAllAgents: async () => { syncs++; return { ok: true }; } },
    '@/lib/docker-utils': { detectProviderGatewayUrl: () => 'http://fixture' },
    '@/lib/model-pricing': {},
    '@/lib/model-details': {},
    '@/lib/provider-labels': { PROVIDER_LABELS: {} },
    '@/lib/model-catalogue': {},
    '@/lib/openrouter-pricing': {},
    '@/lib/rev4a-auth': { requireAuthJWT: async () => denied ? new Response(null, { status: 401 }) : null },
  });
  return {
    postKey: (apiKey, provider = 'deepseek') => POST({ json: async () => ({ provider, ...(apiKey === undefined ? {} : { apiKey }) }) }),
    get syncs() { return syncs; },
  };
}

async function assertConflict(response, message) {
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { status: 'error', error: message });
}

test('Gateway POST refuses saving or removing a key with 409 and skips sync', async (t) => {
  const { file, keys, write } = fixture(t);
  const api = gateway(keys);

  assert.equal(fs.existsSync(file), false);
  assert.equal((await api.postKey('fixture-first')).status, 200);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { ...legacyKeys, deepseek: 'fixture-first' });
  assert.equal(api.syncs, 1);

  const broken = write('{"rev4a": "fixture-gateway",');
  for (const apiKey of ['fixture-replacement', null, undefined, '', '  ']) {
    await assertConflict(await api.postKey(apiKey), unreadableError);
    assert.deepEqual(fs.readFileSync(file), broken);
    assert.equal(api.syncs, 1);
  }

  write('{"rev4a": "fixture-gateway", "deepseek": "fixture-first"}');
  assert.equal((await api.postKey('fixture-replacement')).status, 200);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), {
    rev4a: 'fixture-gateway', deepseek: 'fixture-replacement',
  });
  assert.equal((await api.postKey(null)).status, 200);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { rev4a: 'fixture-gateway' });
  assert.equal(api.syncs, 3);
  t.diagnostic('malformed file save and all removal forms: HTTP 409, bytes preserved, syncs=0');
});

test('an unauthenticated Gateway POST does not read provider keys', async (t) => {
  const { keys } = fixture(t, { filesystem: { ...fs, readFileSync: () => assert.fail('Unexpected read') } });
  const api = gateway(keys, { denied: true });
  assert.equal((await api.postKey('fixture-first')).status, 401);
  assert.equal(api.syncs, 0);
});

test('invalid UTF-8 inside a JSON string is unreadable and Gateway POST preserves the bytes', async (t) => {
  const { file, keys, output, write } = fixture(t);
  const original = write(Buffer.concat([Buffer.from(`{"rev4a":"${fakeKey}`), Buffer.from([0xff]), Buffer.from('"}')]));
  assert.equal(keys.loadProviderKeys().state, 'unreadable');
  assert.deepEqual({ ...keys.readProviderKeys() }, {});
  const api = gateway(keys);
  await assertConflict(await api.postKey('fixture-replacement'), unreadableError);
  assert.deepEqual(fs.readFileSync(file), original);
  assert.deepEqual(output, [['warn', warning('not valid UTF-8')]]);
  assert.equal(api.syncs, 0);
  t.diagnostic('invalid UTF-8: state=unreadable, HTTP 409, bytes preserved, syncs=0');
  t.diagnostic(output[0][1]);
});

test('a dangling symlink is unreadable and neither write path creates the target', { skip: process.platform === 'win32' }, async (t) => {
  const { file, keys, output } = fixture(t);
  fs.mkdirSync(path.dirname(file));
  const target = path.join(path.dirname(file), 'missing.json');
  fs.symlinkSync(target, file);
  assert.equal(keys.loadProviderKeys().state, 'unreadable');
  assert.deepEqual({ ...keys.readProviderKeys() }, {});
  const api = gateway(keys);
  await assertConflict(await api.postKey('fixture-replacement'), unreadableError);
  assert.equal(fs.readlinkSync(file), target);
  assert.equal(fs.existsSync(target), false);
  assert.deepEqual(output, [['warn', warning('dangling link')]]);
  assert.equal(api.syncs, 0);
  t.diagnostic('dangling link: state=unreadable, HTTP 409, target absent, syncs=0');
});

test('legacy migration reloads a truncated file created by a concurrent writer', (t) => {
  const truncated = Buffer.from('{"rev4a": "x",');
  let attempts = 0;
  let reads = 0;
  const { file, keys, output } = fixture(t, {
    filesystem: {
      ...fs,
      readFileSync(path) { reads++; return fs.readFileSync(path); },
      writeFileSync(path, bytes, options) {
        attempts++;
        fs.writeFileSync(path, truncated);
        fs.writeFileSync(path, bytes, options);
      },
    },
  });
  assert.equal(fs.existsSync(file), false);
  const result = keys.loadProviderKeys();
  assert.equal(result.state, 'unreadable');
  assert.deepEqual({ ...result.keys }, {});
  assert.deepEqual(fs.readFileSync(file), truncated);
  assert.deepEqual(output, [['warn', warning('not valid JSON')]]);
  assert.equal(attempts, 1);
  assert.equal(reads, 2);
  t.diagnostic('migration race: state=unreadable, winner bytes preserved, one create attempt, one reload');
});

test('Gateway POST returns 409 when existing file bytes change before the final read', async (t) => {
  const truncated = Buffer.from('{"rev4a": "x",');
  let reads = 0;
  const { file, keys, write } = fixture(t, {
    filesystem: {
      ...fs,
      readFileSync(path) {
        if (++reads === 2) fs.writeFileSync(path, truncated);
        return fs.readFileSync(path);
      },
      writeFileSync: () => assert.fail('Unexpected write'),
    },
  });
  write('{"rev4a": "fixture-gateway"}');
  const api = gateway(keys);
  await assertConflict(await api.postKey('fixture-replacement'), changedError);
  assert.deepEqual(fs.readFileSync(file), truncated);
  assert.equal(api.syncs, 0);
  assert.equal(reads, 2);
  t.diagnostic(`POST compare race: HTTP 409, bytes preserved, syncs=${api.syncs}, error=${changedError}`);
});

test('Gateway POST returns 409 when a concurrent writer creates the missing file first', async (t) => {
  const truncated = Buffer.from('{"rev4a": "x",');
  let attempts = 0;
  const { file, keys } = fixture(t, {
    filesystem: {
      ...fs,
      writeFileSync(path, bytes, options) {
        attempts++;
        fs.writeFileSync(path, truncated);
        fs.writeFileSync(path, bytes, options);
      },
    },
  });
  assert.equal(fs.existsSync(file), false);
  const api = gateway(keys);
  await assertConflict(await api.postKey('fixture-replacement'), changedError);
  assert.deepEqual(fs.readFileSync(file), truncated);
  assert.equal(api.syncs, 0);
  assert.equal(attempts, 1);
  t.diagnostic('POST create race: HTTP 409, winner bytes preserved, syncs=0');
});

test('a 16 MiB valid legacy file is read in place and its permissions are tightened', (t) => {
  const { file, keys, output, write } = fixture(t);
  const key = 'x'.repeat(16 * 1024 * 1024 - '{"rev4a":""}'.length);
  const original = write(JSON.stringify({ rev4a: key }));
  fs.chmodSync(file, 0o644);
  const started = performance.now();
  const loaded = keys.loadProviderKeys();
  const elapsed = performance.now() - started;
  assert.equal(loaded.state, 'ok');
  assert.ok(loaded.keys.rev4a === key);
  assert.deepEqual(fs.readFileSync(file), original);
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(output, []);
  t.diagnostic(`16 MiB file: state=ok, bytes preserved, mode=${(fs.statSync(file).mode & 0o777).toString(8)}, ms=${Math.round(elapsed)}`);
});

test('wizard stays on Providers after an API conflict or network failure and advances on retry', async (t) => {
  const { keys, write } = fixture(t);
  const api = gateway(keys);
  write('{"rev4a": "x",');
  const values = [];
  let index = 0;
  let refreshes = 0;
  let requests = 0;
  let offline = false;
  const wizard = load(transpile('app/wizard/useWizard.ts'), {
    react: {
      useState(initial) {
        const slot = index++;
        if (!(slot in values)) values[slot] = initial;
        return [values[slot], (next) => { values[slot] = next; }];
      },
      useCallback: (callback) => callback,
      useEffect: () => {},
    },
    '../lib/models-context': { useModels: () => ({ refresh: () => { refreshes++; } }) },
    './storage': {},
  }, {
    async fetch(url, options) {
      assert.equal(url, '/api/gateway/provider');
      assert.equal(options.method, 'POST');
      requests++;
      if (offline) throw new TypeError('Network unavailable');
      const { provider, apiKey } = JSON.parse(options.body);
      return api.postKey(apiKey, provider);
    },
  });
  const render = () => { index = 0; return wizard.useWizard(); };
  render().goToStep(2);
  render().setProviderKeys({ deepseek: 'fixture-first', openai: 'fixture-second' });

  await render().goNext();
  assert.equal(requests, 1);
  assert.equal(refreshes, 0);
  assert.equal(render().step, 'providers');
  assert.equal(render().saving, false);
  assert.equal(render().providerError, unreadableError);
  t.diagnostic(`wizard HTTP 409: step=${render().step}, requests=${requests}, refreshes=${refreshes}, error=${render().providerError}`);

  offline = true;
  await render().goNext();
  assert.equal(requests, 2);
  assert.equal(refreshes, 0);
  assert.equal(render().step, 'providers');
  assert.equal(render().saving, false);
  assert.equal(render().providerError, 'Could not save the API keys. Try again.');
  t.diagnostic(`wizard network failure: step=${render().step}, refreshes=${refreshes}, error=${render().providerError}`);

  offline = false;
  write('{"rev4a":"fixture-gateway"}');
  await render().goNext();
  assert.equal(requests, 4);
  assert.equal(refreshes, 1);
  assert.equal(render().step, 'agents');
  assert.equal(render().saving, false);
  assert.equal(render().providerError, '');
  t.diagnostic(`wizard successful retry: step=${render().step}, refreshes=${refreshes}`);
});
