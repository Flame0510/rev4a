#!/usr/bin/env node
/** BUG-14 boundaries: mocked files, auth, processes and hooks; no services are started. */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const envFile = require('../lib/env-file.js');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENV_FILE = '/mock/.env';
let passed = 0;

async function test(name, fn) {
  await fn();
  passed++;
  console.log(`ok   ${name}`);
}

function load(file, dependencies, globals = {}) {
  const code = ts.transpileModule(fs.readFileSync(path.join(root, file), 'utf8'), {
    fileName: file, compilerOptions: { module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022, esModuleInterop: true, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(code, { module, exports: module.exports, require: (name) => {
    if (name === '@/lib/env-edit') return load('lib/env-edit.ts', dependencies, globals);
    assert.ok(name in dependencies, `Unexpected dependency: ${name}`);
    return dependencies[name];
  }, ...globals }, { filename: file });
  return module.exports;
}

function harness(initial, inherited = {}, readError = null, lock) {
  let content = initial;
  let mode = 0o644;
  const effects = [];
  const denied = { status: 401 };
  let authenticated = true;
  const route = load('app/api/config/env/route.ts', {
    'next/server': { NextResponse: { json: (body, options) => ({ status: options?.status ?? 200, body }) } },
    fs: {
      readFileSync: (file) => {
        assert.equal(file, ENV_FILE);
        if (readError) throw Object.assign(new Error(readError), { code: readError });
        return content;
      },
      writeFileSync: (file, next, options) => {
        assert.equal(file, ENV_FILE);
        assert.equal(options.mode, 0o600);
        content = next; effects.push('write');
      },
      chmodSync: (file, nextMode) => { assert.equal(file, ENV_FILE); assert.equal(nextMode, 0o600); mode = nextMode; },
      statSync: () => ({ mode }),
    },
    child_process: { execSync: () => effects.push('reload') },
    '@/lib/rev4a-paths': { ENV_FILE },
    '@/lib/rev4a-auth': { requireAuthJWT: async () => authenticated ? null : denied },
    '@/lib/env-file': envFile,
    '@/lib/file-lock': { withFileDirectoryLock: lock },
    '@/lib/listen-addresses': require('../lib/listen-addresses.js'),
  }, { process: { env: inherited, platform: lock ? 'linux' : 'darwin' }, console: { warn: () => {} } });
  return { get content() { return content; }, get mode() { return mode; }, effects,
    put: (env) => route.PUT({ json: async () => ({ env }) }),
    get: () => route.GET({}),
    deny: () => { authenticated = false; },
  };
}

const fixture = '# operator header\nGATEWAY_TOKEN=x\n\nPORT=1\n# provider\nPROVIDER_VENDOR.OPTION=y\nREV4A_TOKEN=t\n# footer\n';

await test('BUG-15: inherited-only clears return 400 with recovery instructions before any batch write', async () => {
  const error = 'This value comes from the service environment, not .env; change it there.';
  for (const content of ['', fixture]) {
    for (const key of ['REV4A_PASSWORD', 'PROVIDER_INHERITED']) {
      for (const value of ['service-value', '0', ' ']) {
        const inherited = { [key]: value };
        const h = harness(content, inherited);
        assert.equal((await h.get()).body.env[key], value);
        const response = await h.put({ REV4A_NEW: 'edit', [key]: '' });
        assert.equal(response.status, 400);
        assert.equal(response.body.error, error);
        assert.equal(h.content, content);
        assert.equal(inherited[key], value);
        assert.deepEqual(h.effects, []);
        assert.equal((await h.put({ [key]: value })).status, 200);
        assert.deepEqual(h.effects, []);
        assert.equal((await h.put({ [key]: 'file-override' })).status, 200);
        assert.equal((await h.put({ [key]: '' })).status, 200, 'a stored override can still be removed');
      }
    }
  }
  const empty = harness(fixture, { REV4A_EMPTY: '' });
  assert.equal((await empty.put({ REV4A_EMPTY: '', REV4A_ABSENT: '' })).status, 200);
  assert.deepEqual(empty.effects, []);
});

await test('BUG-15: GET uses shared inline-comment, quote and last-assignment semantics', async () => {
  for (const newline of ['\n', '\r\n', '\r']) {
    const content = ['REV4A_TOKEN=old', 'export REV4A_TOKEN = abc # note',
      'PROVIDER_QUOTED="abc # literal" # note', 'REV4A_EMPTY=old', 'REV4A_EMPTY= # empty',
      'REV4A_COLON: value # note', ''].join(newline);
    const h = harness(content);
    const { env } = (await h.get()).body;
    assert.equal(env.REV4A_TOKEN, 'abc');
    assert.equal(env.PROVIDER_QUOTED, 'abc # literal');
    assert.equal(env.REV4A_EMPTY, '');
    assert.equal(env.REV4A_COLON, 'value');
    assert.equal((await h.put(env)).status, 200);
    assert.equal(h.content, content);
    assert.deepEqual(h.effects, []);
  }
});

await test('PUT changes only the submitted assignment, preserving every other byte', async () => {
  for (const content of [fixture, fixture.replaceAll('\n', '\r\n'), fixture.trimEnd()]) {
    const h = harness(content);
    assert.equal((await h.put({ REV4A_TOKEN: 'u' })).status, 200);
    assert.equal(h.content, content.replace('REV4A_TOKEN=t', 'REV4A_TOKEN=u'));
    assert.equal(h.mode, 0o600);
  }
});

await test('PUT appends absent settings and removes only the requested line', async () => {
  const h = harness(fixture);
  assert.equal((await h.put({ REV4A_NEW: 'v' })).status, 200);
  assert.equal(h.content, `${fixture}REV4A_NEW=v\n`);
  assert.equal((await h.put({ REV4A_TOKEN: '' })).status, 200);
  assert.equal(h.content, `${fixture.replace('REV4A_TOKEN=t\n', '')}REV4A_NEW=v\n`);
  for (const content of ['', '# last comment', '# last comment\r\n']) {
    const fresh = harness(content);
    await fresh.put({ REV4A_NEW: 'v' });
    const newline = content.includes('\r\n') ? '\r\n' : '\n';
    assert.equal(fresh.content, content + (content && !content.endsWith('\n') ? newline : '') + `REV4A_NEW=v${newline}`);
  }
});

await test('PUT replaces the last duplicate, removes earlier duplicates, and GET reads the new value', async () => {
  for (const newline of ['\n', '\r\n', '\r']) {
    for (const ending of [newline, '']) {
      const content = ['# before', ' export REV4A_PASSWORD = "first"', 'REV4A_OTHER=\'q\'',
        '# between', 'REV4A_PASSWORD=last'].join(newline) + ending;
      const h = harness(content);
      assert.equal((await h.get()).body.env.REV4A_PASSWORD, 'last');
      assert.equal((await h.put({ REV4A_PASSWORD: 'replacement' })).status, 200); // secret-ok: synthetic fixture
      assert.equal(h.content, ['# before', 'REV4A_OTHER=\'q\'', '# between', 'REV4A_PASSWORD=replacement'].join(newline) + ending);
      assert.equal((await h.get()).body.env.REV4A_PASSWORD, 'replacement');
      const clear = harness(content);
      await clear.put({ REV4A_PASSWORD: '' });
      assert.equal(clear.content, ['# before', 'REV4A_OTHER=\'q\'', '# between', ''].join(newline));
      assert.equal((await clear.get()).body.env.REV4A_PASSWORD, undefined);
    }
  }
});

await test('backslashes before same-kind quotes refuse edits and runtime repair without swallowing other keys', async () => {
  for (const quote of ["'", '"', '`']) {
    for (const newline of ['\n', '\r\n', '\r']) {
      for (const value of [`${quote}password\\${quote}`, `${quote}password\\\\${quote}`, `${quote}pass\\${quote}word${quote}`]) {
        for (const key of ['REV4A_PASSWORD', 'REV4A_SERVER_PID']) {
          const content = [`${key}=${value}`, 'REV4A_JWT_SECRET=keep-secret', 'REV4A_DB=/keep/events.db', ''].join(newline);
          assert.equal(envFile.isPlainEnvFile(content), false);
          const h = harness(content);
          assert.equal((await h.put({ REV4A_PASSWORD: 'replacement' })).status, 409); // secret-ok: synthetic fixture
          assert.equal(h.content, content);
          assert.deepEqual(h.effects, []);
          assert.deepEqual(envFile.removeRuntimeEnvLines(content), { content, removed: [], skipped: true });
        }
      }
    }
  }
  // Ordinary backslashes and a slash before a different quote stay safe for line edits.
  const content = "REV4A_SERVER_PID='path\\folder'\r\nREV4A_PASSWORD='pass\\\"word'\nREV4A_DB=/keep/events.db";
  assert.equal(envFile.isPlainEnvFile(content), true);
  assert.equal(envFile.removeRuntimeEnvLines(content).content, content.split('\r\n')[1]);
  const h = harness(content);
  await h.put({ REV4A_PASSWORD: 'replacement' }); // secret-ok: synthetic fixture
  assert.equal(h.content, content.replace("REV4A_PASSWORD='pass\\\"word'", 'REV4A_PASSWORD=replacement'));
});

await test('runtime-only keys are hidden and silently ignored, even from an old tab', async () => {
  const runtime = Object.fromEntries(envFile.RUNTIME_ONLY_ENV_KEYS.map((key) => [key, 'SENTINEL_PRIVATE_VALUE']));
  const content = fixture + Object.keys(runtime).map((key) => `${key}=old\n`).join('');
  const h = harness(content, runtime);
  const response = await h.get();
  for (const key of Object.keys(runtime)) assert.equal(response.body.env[key], undefined);
  assert.equal((await h.put(runtime)).status, 200);
  assert.equal(h.content, content);
  // Ignoring happens before value validation as well.
  assert.equal((await h.put({ REV4A_SERVER_PID: null, REV4A_TERMINAL_SECRET: 'a\nb' })).status, 200);
  assert.equal(h.content, content);
  assert.deepEqual(h.effects, []);
});

await test('old-client GET -> PUT is a byte-for-byte no-op, including inherited settings and quotes', async () => {
  const content = fixture.replace('REV4A_TOKEN=t', 'REV4A_TOKEN="t"') + "REV4A_QUOTED='a=b'\n";
  const inherited = { REV4A_DATA_DIR: '/mock/data', REV4A_LEGACY_BACKUP_VOLUME: 'legacy',
    REV4A_SERVER_PID: '111', REV4A_STARTED_AT: '222', REV4A_RUNNING_VERSION: '1.0',
    REV4A_TERMINAL_SECRET: 'ephemeral', REV4A_SETUP_CODE: 'setup', PROVIDER_EXTRA: 'inherited' }; // secret-ok
  const h = harness(content, inherited);
  const { env } = (await h.get()).body;
  assert.equal(env.REV4A_DATA_DIR, '/mock/data');
  assert.equal(env.PROVIDER_EXTRA, 'inherited');
  assert.equal((await h.put(env)).status, 200);
  assert.equal(h.content, content);
  assert.deepEqual(h.effects, []);
  assert.equal((await h.put({ REV4A_DATA_DIR: '/new/path' })).status, 200);
  assert.equal(h.content, content + 'REV4A_DATA_DIR=/new/path\n');
});

await test('old-client round trip preserves all unchanged empty assignments without a write', async () => {
  for (const newline of ['\n', '\r\n']) {
    const content = ['# empties', 'REV4A_EMPTY=', 'REV4A_DOUBLE=""', "REV4A_SINGLE=''",
      'REV4A_SPACES=   ', 'REV4A_COMMENT= # empty', 'REV4A_TOKEN=t', ''].join(newline);
    const h = harness(content, { REV4A_EMPTY: 'inherited-must-not-win' });
    const { env } = (await h.get()).body;
    for (const key of ['REV4A_EMPTY', 'REV4A_DOUBLE', 'REV4A_SINGLE', 'REV4A_SPACES', 'REV4A_COMMENT']) {
      assert.equal(env[key], '');
    }
    const response = await h.put(env);
    assert.equal(response.status, 200);
    assert.equal(response.body.updated.length, 0);
    assert.equal(h.content, content);
    assert.deepEqual(h.effects, []);
    await h.put({ REV4A_TOKEN: '' });
    assert.equal(h.content, content.replace(`REV4A_TOKEN=t${newline}`, ''));
    assert.deepEqual(h.effects, ['write', 'reload']);
  }
});

await test('classifier agrees with installed @next/env on quoted blocks, escapes and inline comments', () => {
  // Isolate @next/env's process.env mutations; no services or real env files are loaded.
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(require.resolve('@next/env'), 'utf8'), {
    module, exports: module.exports, require, __dirname: '/mock', process: { env: {} }, console,
  });
  const content = '# header\nexport PROVIDER_VENDOR.OPTION = "a#b" # comment\n'
    + 'REV4A_NOTE="first   \nREV4A_SERVER_PID=x\nlast" # comment\n'
    + "OPERATOR_NOTE='first\nNODE_OPTIONS=literal\nlast'\n"
    + 'REV4A_ESCAPED="first\\"\nREV4A_TOKEN=literal\nlast"\n'
    + 'REV4A_BACKTICK=`first\nLD_PRELOAD=literal\nlast`\n'
    + 'REV4A_ESCAPES="line\\nnext\\r"\nREV4A_PLAIN=value # comment\nREV4A_EMPTY=\n';
  const [, parsed] = module.exports.processEnv([{ path: '.env', contents: content, env: {} }], '/mock');
  const lines = envFile.classifyEnvLines(content);
  const classified = Object.fromEntries(lines.filter((line) => line.key).map((line) => [line.key, line.value]));
  assert.deepEqual(classified, JSON.parse(JSON.stringify(parsed)));
  assert.equal(lines.map((line) => line.text).join(''), content);
  for (const line of lines.filter((line) => line.continuation)) assert.equal(line.key, undefined);
  assert.equal(classified.REV4A_TOKEN, undefined);
});

await test('a .env with a multi-line or unusual value: GET still parses it, an unchanged round trip writes nothing, an edit is refused (409) and nothing is written', async () => {
  for (const quote of ['"', "'", '`']) {
    for (const newline of ['\n', '\r\n']) {
      const content = ['# keep', `OPERATOR_NOTE=${quote}first`, 'REV4A_TOKEN=decoy', `last${quote}`, 'REV4A_TOKEN=t', 'GATEWAY_TOKEN=g', ''].join(newline);
      const h = harness(content);
      const { env } = (await h.get()).body;
      assert.equal((await h.put(env)).status, 200);
      assert.equal(h.content, content);
      assert.deepEqual(h.effects, []);
      const edit = harness(content);
      assert.equal((await edit.put({ REV4A_TOKEN: 'u' })).status, 409);
      assert.equal(edit.content, content);
      assert.deepEqual(edit.effects, []);
    }
  }
  for (const content of ['REV4A_SERVER_PID="oops\nGATEWAY_TOKEN=keep\nPORT=1\n', 'REV4A_TOKEN=old\nNOTE=\n"x\ny"\nPORT=1\n']) {
    const h = harness(content);
    assert.equal((await h.put({ REV4A_TOKEN: 'fixed' })).status, 409);
    assert.equal(h.content, content, 'unrelated settings are never deleted');
  }
});

await test('a key absent from the file whose value equals the running one (GET-injected, even multi-line) is not an edit', async () => {
  const h = harness('REV4A_TOKEN=t\n', { PROVIDER_CERT: 'line1\nline2' });
  assert.equal((await h.put({ REV4A_TOKEN: 't', PROVIDER_CERT: 'line1\nline2' })).status, 200);
  assert.equal(h.content, 'REV4A_TOKEN=t\n');
  assert.equal((await h.put({ PROVIDER_CERT: 'other\nvalue' })).status, 400, 'a real multi-line edit is still refused');
});

await test('allow-list, assignment validation and ENOENT-only writes remain enforced', async () => {
  for (const env of [{ PORT: '2' }, { OTHER: 'x' }, { 'REV4A_BAD KEY': 'x' },
    { REV4A_TOKEN: 'a\nb' }, { REV4A_TOKEN: 'a\rb' }, { REV4A_TOKEN: 'a\0b' }, { REV4A_TOKEN: 1 }]) {
    const h = harness(fixture);
    assert.equal((await h.put(env)).status, 400);
    assert.equal(h.content, fixture);
    assert.deepEqual(h.effects, []);
  }
  for (const error of ['EACCES', 'EIO', 'EISDIR', 'ENOENT']) {
    const h = harness(fixture, {}, error);
    assert.equal((await h.put({ REV4A_NEW: 'v' })).status, error === 'ENOENT' ? 200 : 500);
    if (error === 'ENOENT') assert.equal(h.content, 'REV4A_NEW=v\n');
    else { assert.equal(h.content, fixture); assert.deepEqual(h.effects, []); }
  }
  const h = harness(fixture);
  h.deny();
  assert.equal((await h.get()).status, 401);
  assert.equal((await h.put({ REV4A_TOKEN: 'u' })).status, 401);
  assert.deepEqual(h.effects, []);
});

await test('startup removes only exact runtime assignments, logs names, and is idempotent', () => {
  const source = fs.readFileSync(path.join(root, 'bin/rev4a.js'), 'utf8');
  const ast = ts.createSourceFile('rev4a.js', source, ts.ScriptTarget.Latest, true);
  const ensure = ast.statements.find((node) => ts.isFunctionDeclaration(node) && node.name.text === 'ensureEnv');
  assert.ok(ensure);
  const keep = '# REV4A_SERVER_PID=comment\r\nGATEWAY_TOKEN=x\r\n\r\nPORT=1\r\nREV4A_SERVER_PID_EXTRA=keep\r\nOPERATOR=REV4A_STARTED_AT=2\r\n'
    + 'OPERATOR_NOTE="one line"\r\n';
  let content = keep + envFile.RUNTIME_ONLY_ENV_KEYS.map((key) => `${key}=SENTINEL_PRIVATE_VALUE\r\n`).join('')
    + ' export REV4A_SERVER_PID = duplicate\r\nREV4A_STARTED_AT=last';
  const writes = [];
  const logs = [];
  const temporaryFiles = new Map();
  const descriptors = new Map();
  let nextFd = 10;
  let mode = 0o600;
  const context = vm.createContext({
    ENV_SOURCE: ENV_FILE, ENV_LINK: '/mock/link', existsSync: () => true,
    readFileSync: () => content,
    openSync: (file, flags, mode) => {
      assert.equal(flags, 'wx');
      assert.equal(mode, 0o600);
      if (file === ENV_FILE || temporaryFiles.has(file)) throw Object.assign(new Error('Exists'), { code: 'EEXIST' });
      temporaryFiles.set(file, { content: '', mode });
      const fd = nextFd++;
      descriptors.set(fd, file);
      return fd;
    },
    closeSync: (fd) => { assert.ok(descriptors.delete(fd)); },
    writeFileSync: (fd, next, encoding) => {
      assert.equal(encoding, 'utf-8');
      assert.ok(descriptors.has(fd));
      temporaryFiles.get(descriptors.get(fd)).content = next;
      writes.push(next);
    },
    realpathSync: (file) => { assert.equal(file, ENV_FILE); return file; },
    renameSync: (from, to) => {
      assert.equal(descriptors.size, 0);
      assert.equal(to, ENV_FILE);
      assert.ok(temporaryFiles.has(from));
      ({ content, mode } = temporaryFiles.get(from));
      temporaryFiles.delete(from);
    },
    rmSync: (file, options) => { assert.equal(options.force, true); temporaryFiles.delete(file); },
    statSync: () => ({ mode }),
    chmodSync: (file, nextMode) => {
      if (file === ENV_FILE) mode = nextMode;
      else { assert.ok(temporaryFiles.has(file)); temporaryFiles.get(file).mode = nextMode; }
    },
    log: (_tag, message) => logs.push(message), seedAgentToken: () => {}, loaderKeysNextWouldLoad: () => [], refuseIfLoaderKeysLeft: () => {},
    parseEnvValues: envFile.parseEnvValues, applyEnvEdits: envFile.applyEnvEdits, process: { env: {}, pid: 42 },
    disableLoaderEnvLines: envFile.disableLoaderEnvLines, removeRuntimeEnvLines: envFile.removeRuntimeEnvLines,
  });
  const run = () => vm.runInContext(`${ensure.getText(ast)}\nensureEnv();`, context);
  run();
  assert.equal(content, keep);
  assert.equal(mode, 0o600);
  assert.equal(temporaryFiles.size, 0);
  assert.equal(descriptors.size, 0);
  assert.equal(writes.length, 1);
  for (const key of envFile.RUNTIME_ONLY_ENV_KEYS) assert.ok(logs.some((line) => line.includes(key)));
  assert.ok(!logs.join('\n').includes('SENTINEL_PRIVATE_VALUE'));
  run();
  assert.equal(content, keep);
  assert.equal(writes.length, 1);
  assert.equal(logs.filter((line) => line.startsWith('Removed runtime-only')).length, 1);
  content += 'NODE_OPTIONS=--import=fixture\nREV4A_SERVER_PID=1\n';
  run();
  assert.ok(content.startsWith(keep));
  assert.match(content, /# Disabled by Rev4a:/);
  assert.equal(content.match(/^REV4A_SERVER_PID=/gm), null);
  assert.equal(mode, 0o600);
  assert.equal(temporaryFiles.size, 0);
});

await test('runtime repair leaves a .env with a multi-line or unterminated value untouched and says so', () => {
  for (const content of [
    'OPERATOR_NOTE="first\nREV4A_SERVER_PID=literal\nlast"\nREV4A_STARTED_AT=1\nPORT=1\n',
    'REV4A_SERVER_PID="oops\nGATEWAY_TOKEN=keep\nPORT=1\n',
    'OPERATOR_NOTE=\n"first\nREV4A_SERVER_PID=x\nlast"\nPORT=1\n',
  ]) {
    assert.deepEqual(envFile.removeRuntimeEnvLines(content), { content, removed: [], skipped: true });
  }
});

function clientHarness() {
  const hooks = [];
  let index = 0;
  const effects = [];
  const calls = [];
  let outcome = 'ok';
  const initial = { REV4A_TOKEN: 't', REV4A_API_KEY: 'k', REV4A_DATA_DIR: '/mock',
    REV4A_SERVER_PID: 'runtime' };
  const Button = () => {};
  const PasswordInput = () => {};
  const Modal = () => {};
  const react = {
    useState: (initial) => {
      const slot = index++;
      if (!(slot in hooks)) hooks[slot] = initial;
      return [hooks[slot], (next) => { hooks[slot] = typeof next === 'function' ? next(hooks[slot]) : next; }];
    },
    useRef: (value) => { const slot = index++; return hooks[slot] ??= { current: value }; },
    useCallback: (fn) => fn,
    useMemo: (fn) => fn(),
    useEffect: (fn) => { const slot = index++; if (!(slot in hooks)) { hooks[slot] = true; effects.push(fn); } },
  };
  const client = load('app/config/PageClient.tsx', {
    react, 'react/jsx-runtime': require('react/jsx-runtime'),
    '@/lib/timezone': { updateCachedRev4aTimezone: () => {} }, '@/lib/apiFetch': { apiFetch: () => {} },
    '@/lib/env-file': envFile,
    '@/lib/file-lock': require('../lib/file-lock.js'),
    '../components/ui': { Button, Modal, Input: () => {}, Page: () => {}, PageHeader: () => {},
      Surface: () => {}, Pill: () => {} }, '../components/PasswordInput': PasswordInput,
  }, { AbortController, setTimeout: () => {}, fetch: async (url, options) => {
    calls.push({ url, options });
    return { ok: typeof outcome === 'string' ? outcome === 'ok' : false,
      status: typeof outcome === 'object' ? outcome.status : 200,
      json: async () => options?.method === 'PUT' ? (typeof outcome === 'object' ? outcome.body : { status: outcome }) : { env: { ...initial } } };
  } });
  function render() {
    index = 0;
    const nodes = [];
    function visit(node) {
      if (Array.isArray(node)) return node.forEach(visit);
      if (!node || typeof node !== 'object') return;
      nodes.push(node);
      visit(node.props?.children);
    }
    visit(client.default());
    effects.splice(0).forEach((fn) => fn());
    return nodes;
  }
  return { render, calls, hooks, setOutcome: (next) => { outcome = next; },
    change: (value) => render().find((n) => n.type === PasswordInput && n.props.placeholder === 'Internal auth token').props.onChange(value),
    confirm: (action) => {
      // Exercise both branches of the existing confirmation flow.
      hooks[5] = action;
      const modal = render().find((n) => n.type === Modal);
      return modal.props.children.props.children[1].props.children[1].props.onClick;
    },
  };
}

async function flush() { for (let i = 0; i < 8; i++) await Promise.resolve(); }

await test('both client save actions diff loaded values, preserve clears, and refresh baseline after success', async () => {
  for (const action of ['save', 'restart']) {
    const h = clientHarness();
    h.render();
    await flush();
    h.change('changed');
    const click = h.confirm(action);
    click(); click();
    await flush();
    const puts = () => h.calls.filter((call) => call.options?.method === 'PUT');
    assert.equal(puts().length, 1, 'repeated clicks must not overlap saves');
    assert.deepEqual(JSON.parse(puts()[0].options.body), { env: { REV4A_TOKEN: 'changed' } });
    assert.equal(h.calls.filter((call) => call.url.endsWith('/restart')).length, action === 'restart' ? 1 : 0);
    h.confirm('save')();
    await flush();
    assert.deepEqual(JSON.parse(puts()[1].options.body), { env: {} });
    h.change('');
    h.confirm('save')();
    await flush();
    assert.deepEqual(JSON.parse(puts()[2].options.body), { env: { REV4A_TOKEN: '' } });
  }
});

await test('client omits reverted edits and retries failed saves against the last successful baseline', async () => {
  const h = clientHarness();
  h.render();
  await flush();
  h.change('changed');
  h.change('t');
  h.confirm('save')();
  await flush();
  h.change('retry');
  h.setOutcome('error');
  h.confirm('save')();
  await flush();
  h.setOutcome('ok');
  h.confirm('save')();
  await flush();
  const bodies = h.calls.filter((call) => call.options?.method === 'PUT').map((call) => JSON.parse(call.options.body));
  assert.deepEqual(bodies, [{ env: {} }, { env: { REV4A_TOKEN: 'retry' } }, { env: { REV4A_TOKEN: 'retry' } }]);
});

await test('Config renders persistent 400/409 recovery messages beside Save, keeps edits, and does not restart on failure', async () => {
  for (const status of [400, 409]) {
    const h = clientHarness();
    h.render();
    await flush();
    h.change('retry');
    const error = status === 409 ? '.env has an unusual value: edit it by hand' : 'Invalid value for REV4A_TOKEN';
    h.setOutcome({ status, body: { error } });
    h.confirm('restart')();
    await flush();
    const nodes = h.render();
    assert.ok(nodes.some((node) => node.props.role === 'alert' && node.props.children === error));
    assert.equal(h.hooks[5], null, 'dialog closes to expose the persistent recovery message');
    assert.equal(h.hooks[0].REV4A_TOKEN, 'retry', 'failed saves keep the edited value');
    assert.equal(h.calls.filter((call) => call.url.endsWith('/restart')).length, 0);
    assert.ok(h.render().some((node) => node.props.role === 'alert' && node.props.children === error));
    h.setOutcome('ok');
    h.confirm('save')();
    await flush();
    assert.ok(!h.render().some((node) => node.props.role === 'alert'));
  }
});

await test('BUG-15: Config displays inherited-only clear errors and preserves the edit without restarting', async () => {
  const h = clientHarness();
  h.render();
  await flush();
  h.change('');
  const error = 'This value comes from the service environment, not .env; change it there.';
  h.setOutcome({ status: 400, body: { error } });
  h.confirm('restart')();
  await flush();
  assert.ok(h.render().some((node) => node.props.role === 'alert' && node.props.children === error));
  assert.equal(h.hooks[0].REV4A_TOKEN, '');
  assert.equal(h.hooks[5], null);
  assert.equal(h.calls.filter((call) => call.url.endsWith('/restart')).length, 0);
  h.confirm('save')();
  await flush();
  const puts = h.calls.filter((call) => call.options?.method === 'PUT');
  assert.equal(puts.length, 2);
  for (const call of puts) assert.deepEqual(JSON.parse(call.options.body), { env: { REV4A_TOKEN: '' } });
});

await test('FIX-133: a value that cannot be written faithfully is refused (400) and nothing is written; a quoted-looking one is single-quoted', async () => {
  const content = 'REV4A_TOKEN=t\nGATEWAY_TOKEN=g\n';
  for (const value of ["'password\\'", "'mixed' #x"]) {
    const h = harness(content);
    const r = await h.put({ REV4A_TOKEN: value });
    assert.equal(r.status, 400, value);
    assert.equal(h.content, content);
  }
  const ok = harness(content);
  assert.equal((await ok.put({ REV4A_TOKEN: 'plain-value_with.symbols and spaces' })).status, 200);
  const quoted = harness(content);
  assert.equal((await quoted.put({ REV4A_TOKEN: '"quoted' })).status, 200);
  assert.ok(quoted.content.split('\n').includes("REV4A_TOKEN='\"quoted'"));
});

await test('FIX-133: U+2028 / U+2029 inside a value keep the file plain and editable', async () => {
  const note = 'REV4A_NOTE=a b c';
  const content = note + '\nGATEWAY_TOKEN=g\n';
  const h = harness(content);
  assert.equal((await h.put({ REV4A_TOKEN: 'new' })).status, 200);
  assert.ok(h.content.split('\n').includes(note));
  assert.ok(h.content.split('\n').includes('GATEWAY_TOKEN=g'));
});

await test('SEC-9B: REV4A_LISTEN and REV4A_AGENT_PORTS_LISTEN accept only empty, all, local or one IP; garbage is a 400 naming the key', async () => {
  for (const key of ['REV4A_LISTEN', 'REV4A_AGENT_PORTS_LISTEN']) {
    for (const value of ['', 'all', 'ALL', 'local', '10.0.0.5', '::1', '2001:db8::5', '[::1]']) {
      const h = harness(fixture);
      assert.equal((await h.put({ [key]: value })).status, 200, `${key}=${value}`);
    }
    for (const value of ['lokal', 'everything', '0.0.0.0', '::', 'localhost', '10.0.0.5:3740', '999.1.1.1', 'local,all']) {
      const h = harness(fixture);
      const r = await h.put({ [key]: value });
      assert.equal(r.status, 400, `${key}=${value}`);
      assert.match(r.body.error, new RegExp(key));
      assert.equal(h.content, fixture, 'nothing written');
    }
  }
  // Other keys are not touched by the rule.
  assert.equal((await harness(fixture).put({ REV4A_OTHER: 'lokal' })).status, 200);
});

await test('SEC-9B: REV4A_LISTEN_STATE and REV4A_DOTENV_KEYS are runtime-only: never shown, never accepted', async () => {
  assert.ok(envFile.RUNTIME_ONLY_ENV_KEYS.includes('REV4A_LISTEN_STATE') && envFile.RUNTIME_ONLY_ENV_KEYS.includes('REV4A_DOTENV_KEYS'));
  const h = harness(fixture, { REV4A_LISTEN_STATE: '{"mode":"local"}', REV4A_DOTENV_KEYS: 'PORT', REV4A_LISTEN: 'local' });
  const env = (await h.get()).body.env;
  assert.ok(!('REV4A_LISTEN_STATE' in env) && !('REV4A_DOTENV_KEYS' in env));
  assert.equal(env.REV4A_LISTEN, 'local');
  const r = await h.put({ REV4A_LISTEN_STATE: 'x', REV4A_DOTENV_KEYS: 'y' });
  assert.equal(r.status, 200);
  assert.ok(!h.content.includes('REV4A_LISTEN_STATE') && !h.content.includes('REV4A_DOTENV_KEYS'));
});

await test('SEC-9B: a key the launcher copied from .env and the user then cleared is gone: GET hides the stale copy, clearing again is not refused', async () => {
  const h = harness(fixture, { REV4A_AGENT_PORTS_LISTEN: 'local', REV4A_DOTENV_KEYS: 'PORT,REV4A_AGENT_PORTS_LISTEN' });
  assert.ok(!('REV4A_AGENT_PORTS_LISTEN' in (await h.get()).body.env));
  assert.equal((await h.put({ REV4A_AGENT_PORTS_LISTEN: '' })).status, 200);
  // A real service value (not in REV4A_DOTENV_KEYS) is still shown and still protected.
  const svc = harness(fixture, { REV4A_AGENT_PORTS_LISTEN: 'local', REV4A_DOTENV_KEYS: 'PORT' });
  assert.equal((await svc.get()).body.env.REV4A_AGENT_PORTS_LISTEN, 'local');
  assert.equal((await svc.put({ REV4A_AGENT_PORTS_LISTEN: '' })).status, 400);
});

await test('Config hides Domain setup keys from file and service settings and rejects edits', async () => {
  const keys = ['REV4A_DOMAIN', 'REV4A_CADDY_FILE', 'REV4A_CADDY_MAIN'];
  const initial = fixture + keys.map(key => `\n${key}=fixture`).join('') + '\n';
  for (const h of [harness(initial), harness(fixture, Object.fromEntries(keys.map(key => [key, 'fixture'])))]) {
    const before = h.content;
    const { body } = await h.get();
    for (const key of keys) {
      assert.ok(!Object.hasOwn(body.env, key));
      const response = await h.put({ [key]: 'other' });
      assert.equal(response.status, 400);
      assert.ok(response.body.error.includes(key));
    }
    assert.equal(h.content, before);
  }
});

await test('missing flock warns once and saves, while other acquisition errors fail', async () => {
  const warnings = [];
  let errorCode = 'ENOENT';
  let exitCode;
  let closed = 0;
  let writes = 0;
  const { withFileDirectoryLock } = load('lib/file-lock.js', {
    'node:fs/promises': {
      open: async (directory, mode) => {
        assert.equal(directory, '/mock');
        assert.equal(mode, 'r');
        return { fd: 3, close: async () => { closed++; } };
      },
    },
    'node:path': path,
    'node:child_process': { spawn: (command, args, opts) => {
      assert.equal(command, 'flock');
      assert.deepEqual([...args], ['--exclusive', '--timeout', '20', '0']);
      assert.equal(opts.stdio[0], 3);
      const child = new EventEmitter();
      queueMicrotask(() => errorCode
        ? child.emit('error', Object.assign(new Error('Fixture spawn error'), { code: errorCode }))
        : child.emit('exit', exitCode));
      return child;
    } },
  }, { console: { warn: message => warnings.push(message) } });
  const save = async () => ++writes;
  const unlocked = { allowMissingFlock: true };
  await assert.rejects(withFileDirectoryLock(ENV_FILE, save), /flock is required/);
  const h = harness(fixture, {}, null, withFileDirectoryLock);
  assert.equal((await h.put({ REV4A_LISTEN: 'local' })).status, 200);
  assert.match(h.content, /^REV4A_LISTEN=local$/m);
  assert.deepEqual(await Promise.all([withFileDirectoryLock(ENV_FILE, save, unlocked), withFileDirectoryLock(ENV_FILE, save, unlocked)]), [1, 2]);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /flock is unavailable/);
  errorCode = 'EACCES';
  await assert.rejects(withFileDirectoryLock(ENV_FILE, save, unlocked), { code: 'EACCES' });
  errorCode = undefined;
  exitCode = 1;
  await assert.rejects(withFileDirectoryLock(ENV_FILE, save), /Could not acquire the lock/);
  exitCode = 0;
  assert.equal(await withFileDirectoryLock(ENV_FILE, save), 3);
  assert.equal(closed, 7);
  assert.equal(warnings.length, 1);
});

console.log(`\n${passed} config environment save checks passed`);
