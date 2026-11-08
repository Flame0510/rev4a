#!/usr/bin/env node
/** BUG-14 boundaries: mocked files, auth, processes and hooks; no services are started. */
import assert from 'node:assert/strict';
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
    assert.ok(name in dependencies, `Unexpected dependency: ${name}`);
    return dependencies[name];
  }, ...globals }, { filename: file });
  return module.exports;
}

function harness(initial, inherited = {}, readError = null) {
  let content = initial;
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
      writeFileSync: (file, next) => { assert.equal(file, ENV_FILE); content = next; effects.push('write'); },
    },
    child_process: { execSync: () => effects.push('reload') },
    '@/lib/rev4a-paths': { ENV_FILE },
    '@/lib/rev4a-auth': { requireAuthJWT: async () => authenticated ? null : denied },
    '@/lib/env-file': envFile,
  }, { process: { env: inherited }, console: { warn: () => {} } });
  return { get content() { return content; }, effects,
    put: (env) => route.PUT({ json: async () => ({ env }) }),
    get: () => route.GET({}),
    deny: () => { authenticated = false; },
  };
}

const fixture = '# operator header\nGATEWAY_TOKEN=x\n\nPORT=1\n# provider\nPROVIDER_VENDOR.OPTION=y\nREV4A_TOKEN=t\n# footer\n';

await test('PUT changes only the submitted assignment, preserving every other byte', async () => {
  for (const content of [fixture, fixture.replaceAll('\n', '\r\n'), fixture.trimEnd()]) {
    const h = harness(content);
    assert.equal((await h.put({ REV4A_TOKEN: 'u' })).status, 200);
    assert.equal(h.content, content.replace('REV4A_TOKEN=t', 'REV4A_TOKEN=u'));
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

await test('PUT edits the first duplicate only and leaves unrelated quoted settings intact', async () => {
  const h = harness('# before\n REV4A_TOKEN = "t"\nREV4A_TOKEN=last\nREV4A_OTHER=\'q\'\n');
  await h.put({ REV4A_TOKEN: 'u' });
  assert.equal(h.content, '# before\nREV4A_TOKEN=u\nREV4A_TOKEN=last\nREV4A_OTHER=\'q\'\n');
  await h.put({ REV4A_TOKEN: '' });
  assert.equal(h.content, '# before\nREV4A_TOKEN=last\nREV4A_OTHER=\'q\'\n');
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
  const context = vm.createContext({
    ENV_SOURCE: ENV_FILE, ENV_LINK: '/mock/link', existsSync: () => true,
    readFileSync: () => content,
    writeFileSync: (_file, next) => { content = next; writes.push(next); },
    log: (_tag, message) => logs.push(message), seedAgentToken: () => {},
    disableLoaderEnvLines: envFile.disableLoaderEnvLines, removeRuntimeEnvLines: envFile.removeRuntimeEnvLines,
  });
  const run = () => vm.runInContext(`${ensure.getText(ast)}\nensureEnv();`, context);
  run();
  assert.equal(content, keep);
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
    '../components/ui': { Button, Modal, Input: () => {}, Page: () => {}, PageHeader: () => {},
      Surface: () => {}, Pill: () => {} }, '../components/PasswordInput': PasswordInput,
  }, { AbortController, setTimeout: () => {}, fetch: async (url, options) => {
    calls.push({ url, options });
    return { json: async () => options?.method === 'PUT' ? { status: outcome } : { env: { ...initial } } };
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

console.log(`\n${passed} config environment save checks passed`);
