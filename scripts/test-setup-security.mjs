#!/usr/bin/env node
/** SEC-14 boundaries. In-memory files/processes only; never starts the server or launcher. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const validator = require('../lib/env-file.js');
const CODE = 'ABCD-EFGH-JKLM-NPQR';
const ERROR = 'Setup code required: it is printed in the terminal (or the journal) where rev4a serve runs';
const ENV_FILE = '/mock/.env';
let passed = 0;
const envFile = (await import('../lib/env-file.js')).default;

async function test(name, fn) {
  await fn();
  passed++;
  console.log(`ok   ${name}`);
}

function load(file, dependencies, globals = {}) {
  const source = fs.readFileSync(path.join(root, file), 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true, jsx: ts.JsxEmit.ReactJSX,
  }, fileName: file }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(code, { module, exports: module.exports, require: (name) => {
    if (!(name in dependencies)) throw new Error(`Unexpected import ${name} in ${file}`);
    return dependencies[name];
  }, TextEncoder, Response, ReadableStream, AbortController, ...globals }, { filename: file });
  return module.exports;
}

function harness(env = { REV4A_SETUP_CODE: CODE }, content = '', readError = null) {
  const files = new Map([[ENV_FILE, content]]);
  const effects = [];
  const logs = [];
  const mockFs = {
    existsSync: (file) => files.has(file),
    readFileSync: (file) => {
      if (file === ENV_FILE && readError) throw Object.assign(new Error(readError), { code: readError });
      if (!files.has(file)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return files.get(file);
    },
    writeFileSync: (file, value) => { effects.push(['write', file]); files.set(file, value); },
    mkdirSync: () => {}, chmodSync: () => {},
    unlinkSync: (file) => { effects.push(['unlink', file]); files.delete(file); },
  };
  const process = { env: { ...env }, platform: 'linux', pid: 1, kill: () => effects.push(['kill']) };
  const globals = { process, console: { log: (...args) => logs.push(args.join(' ')), error: () => {} },
    setTimeout: () => effects.push(['timer']) };
  const NextResponse = { json: (body, options = {}) => ({
    status: options.status ?? 200, json: async () => body, cookies: { set: () => effects.push(['cookie']) },
  }) };
  const dependencies = {
    'next/server': { NextResponse }, fs: mockFs, 'node:fs': mockFs,
    path, 'node:path': path, crypto, 'node:os': { homedir: () => '/mock' },
    '@/lib/rev4a-paths': { ENV_FILE, REV4A_DATA: '/mock' },
    '@/lib/env-file': validator, './env-file.js': validator,
    jose: { jwtVerify: async (token) => { if (token !== 'valid-cookie') throw new Error('Invalid JWT'); } },
    child_process: { execSync: () => effects.push(['exec']) },
    '@/lib/buildAgentImage': {
      getIsDownloading: () => { effects.push(['download-check']); return false; },
      downloadAgentImage: async () => effects.push(['download']),
    },
    '@/lib/docker-socket': { dockerAvailable: () => { effects.push(['docker']); return false; } },
    '@/lib/agent-images': { listLocalAgentImages: async () => [], newestLocalSupportedVersion: () => null },
  };
  const auth = load('lib/rev4a-auth.js', dependencies, globals);
  dependencies['@/lib/rev4a-auth'] = auth;
  return { files, effects, logs, process, auth,
    load: (file) => load(file, dependencies, globals),
    req: (body, code = CODE, extra = {}) => ({
      headers: new Headers({ ...(code === null ? {} : { 'x-rev4a-setup-code': code }), ...extra }),
      json: async () => body,
    }),
  };
}

await test('shared .env boundary: abc and spaces accepted; CR, LF, NUL and non-strings rejected', () => {
  for (const value of ['abc', '   ', '']) validator.assertEnvValue('REV4A_TEST', value);
  for (const value of ['a\nb', 'a\rb', 'a\0b', '\n', 1, false, null, undefined, {}, []]) {
    assert.throws(() => validator.assertEnvValue('REV4A_TEST', value), /REV4A_TEST/);
  }
  assert.throws(() => validator.assertEnvKey('REV4A_X\nNODE_OPTIONS'), /Invalid environment key/);
  validator.assertEnvValue('PROVIDER_VENDOR.OPTION', 'abc');
});

await test('password HTTP boundaries: 7 rejected, 8 accepted; spaces retain previous acceptance', async () => {
  for (const [password, status] of [['1234567', 400], ['12345678', 200], ['        ', 200]]) {
    const h = harness();
    const response = await h.load('app/api/setup/password/route.ts').POST(h.req({ password }));
    assert.equal(response.status, status);
  }
  for (const password of ['a\nb', 'a\rb', 'a\0b', '\n', 'xxxxxxxx\nNODE_OPTIONS=payload', 8, false, null, {}, []]) {
    const h = harness();
    const response = await h.load('app/api/setup/password/route.ts').POST(h.req({ password }));
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /REV4A_PASSWORD/);
    assert.equal(h.effects.length, 0);
  }
});

await test('config PUT rejects every invalid value with its key before writing any part of a batch', async () => {
  for (const value of ['a\nb', 'a\rb', 'a\0b', '\n', 'xxxxxxxx\nNODE_OPTIONS=payload', 8, false, null, {}, []]) {
    const h = harness({ REV4A_TOKEN: 'test-bearer' }); // secret-ok
    const response = await h.load('app/api/config/env/route.ts').PUT(h.req({
      env: { REV4A_GOOD: 'abc', PROVIDER_TEST: value },
    }, null, { authorization: 'Bearer test-bearer' }));
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /PROVIDER_TEST/);
    assert.equal(h.effects.length, 0);
  }
  for (const value of ['abc', '   ', '']) {
    const h = harness({ REV4A_TOKEN: 'test-bearer' }, 'REV4A_TEST=old\n'); // secret-ok
    const response = await h.load('app/api/config/env/route.ts').PUT(h.req({ env: { REV4A_TEST: value } },
      null, { authorization: 'Bearer test-bearer' }));
    assert.equal(response.status, 200);
    assert.equal(h.files.get(ENV_FILE), value === '' ? '\n' : `REV4A_TEST=${value}\n`);
  }
  const h = harness({ REV4A_TOKEN: 'test-bearer' }); // secret-ok
  const response = await h.load('app/api/config/env/route.ts').PUT(h.req({
    env: { ['REV4A_X\nNODE_OPTIONS']: 'payload' },
  }, null, { authorization: 'Bearer test-bearer' }));
  assert.equal(response.status, 400);
  assert.equal(h.effects.length, 0);
});

await test('writeEnvVar uses the shared boundary before touching files or process.env', () => {
  const h = harness({ REV4A_DATA_DIR: '/mock' });
  const paths = h.load('lib/rev4a-paths.ts');
  for (const value of ['a\nb', 'a\rb', 'a\0b', '\n', 8]) {
    assert.throws(() => paths.writeEnvVar('REV4A_TEST', value), /REV4A_TEST/);
    assert.equal(h.effects.length, 0);
    assert.equal(h.process.env.REV4A_TEST, undefined);
  }
  paths.writeEnvVar('REV4A_TEST', 'abc');
  assert.match(h.files.get(ENV_FILE), /^REV4A_TEST=abc$/m);
});

await test('Config never returns the setup code from disk or runtime and refuses PUT with 400', async () => {
  const h = harness({ REV4A_TOKEN: 'test-bearer', REV4A_SETUP_CODE: CODE }, // secret-ok
    'REV4A_SETUP_CODE=old-file-code\nREV4A_TEST=abc\n');
  const route = h.load('app/api/config/env/route.ts');
  const req = (body) => h.req(body, null, { authorization: 'Bearer test-bearer' });
  const response = await route.GET(req({}));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).env.REV4A_SETUP_CODE, undefined);
  h.files.set(ENV_FILE, 'REV4A_TEST=abc\n');
  assert.equal((await (await route.GET(req({}))).json()).env.REV4A_SETUP_CODE, undefined);
  const saved = h.files.get(ENV_FILE);
  const rejected = await route.PUT(req({ env: { REV4A_SETUP_CODE: CODE, REV4A_TEST: 'changed' } }));
  assert.equal(rejected.status, 400);
  assert.match((await rejected.json()).error, /Keys not allowed: REV4A_SETUP_CODE/);
  assert.equal(h.files.get(ENV_FILE), saved);
  assert.equal(h.effects.length, 0);
});

await test('Config saves preserve legacy dotted keys without applying request key syntax to stored entries', async () => {
  const h = harness({ REV4A_TOKEN: 'test-bearer' }, 'PROVIDER_VENDOR.OPTION=x\nREV4A_TEST=old\n'); // secret-ok
  const response = await h.load('app/api/config/env/route.ts').PUT(h.req({ env: { REV4A_TEST: 'abc' } },
    null, { authorization: 'Bearer test-bearer' }));
  assert.equal(response.status, 200);
  assert.equal(h.files.get(ENV_FILE), 'PROVIDER_VENDOR.OPTION=x\nREV4A_TEST=abc\n');
});

await test('Config GET -> PUT round trip keeps a legacy dotted key (the client sends every stored key back)', async () => {
  const h = harness({ REV4A_TOKEN: 'test-bearer' }, 'PROVIDER_VENDOR.OPTION=x\nREV4A_TEST=old\n'); // secret-ok
  const route = h.load('app/api/config/env/route.ts');
  const auth = { authorization: 'Bearer test-bearer' };
  const { env } = await (await route.GET(h.req({}, null, auth))).json();
  assert.equal(env['PROVIDER_VENDOR.OPTION'], 'x');
  const response = await route.PUT(h.req({ env: { ...env, REV4A_TEST: 'abc' } }, null, auth));
  assert.equal(response.status, 200);
  assert.match(h.files.get(ENV_FILE), /^PROVIDER_VENDOR\.OPTION=x$/m);
  assert.match(h.files.get(ENV_FILE), /^REV4A_TEST=abc$/m);
});

await test('line-breaking keys are refused; legacy key syntax is accepted', () => {
  for (const k of ['REV4A_TEST', 'PROVIDER_VENDOR.OPTION', 'a-b']) envFile.assertEnvKey(k);
  for (const k of ['', 'A=B', 'A B', '#X', 'A\nB', 'A\u0001', 7]) assert.throws(() => envFile.assertEnvKey(k));
});

await test('.env repair comments out loader keys (Next.js reads .env for the build and the server), idempotent', () => {
  const r = envFile.disableLoaderEnvLines('REV4A_PASSWORD=x\nNODE_OPTIONS=--import=evil\n# NODE_OPTIONS=old\nexport LD_PRELOAD=/x.so\nDYLD_INSERT_LIBRARIES=/y\nPORT=3740\n');
  assert.deepEqual(r.disabled, ['NODE_OPTIONS', 'LD_PRELOAD', 'DYLD_INSERT_LIBRARIES']);
  assert.match(r.content, /^REV4A_PASSWORD=x$/m);
  assert.match(r.content, /^PORT=3740$/m);
  assert.doesNotMatch(r.content, /^(export\s+)?(NODE_OPTIONS|LD_PRELOAD|DYLD_INSERT_LIBRARIES)=/m);
  assert.deepEqual(envFile.disableLoaderEnvLines(r.content).disabled, []);
});

await test('all assignment writers fail closed on EACCES/EIO/EISDIR; only ENOENT starts an empty file', async () => {
  for (const error of ['EACCES', 'EIO', 'EISDIR', 'ENOENT']) {
    for (const writer of ['config', 'password', 'writeEnvVar']) {
      const h = harness({ REV4A_SETUP_CODE: CODE, REV4A_DATA_DIR: '/mock', REV4A_TOKEN: 'test-bearer' }, // secret-ok
        'PROVIDER_KEEP=existing\n', error);
      if (writer === 'writeEnvVar') {
        const paths = h.load('lib/rev4a-paths.ts');
        if (error === 'ENOENT') paths.writeEnvVar('REV4A_TEST', 'abc');
        else assert.throws(() => paths.writeEnvVar('REV4A_TEST', 'abc'), { code: error });
      } else {
        const route = writer === 'config' ? 'config/env' : 'setup/password';
        const method = writer === 'config' ? 'PUT' : 'POST';
        const body = writer === 'config' ? { env: { REV4A_TEST: 'abc' } } : { password: '12345678' }; // secret-ok
        const response = await h.load(`app/api/${route}/route.ts`)[method](h.req(body,
          CODE, { authorization: 'Bearer test-bearer' }));
        assert.equal(response.status, error === 'ENOENT' ? 200 : 500, `${writer}: ${error}`);
      }
      if (error !== 'ENOENT') {
        assert.equal(h.files.get(ENV_FILE), 'PROVIDER_KEEP=existing\n');
        assert.equal(h.effects.length, 0, `${writer}: ${error}`);
        assert.equal(h.process.env.REV4A_TEST, undefined);
        assert.equal(h.process.env.REV4A_PASSWORD, undefined);
      } else assert.equal(h.effects.filter(([effect]) => effect === 'write').length, 1);
    }
  }
});

await test('setup code accepts lowercase, no dashes and surrounding/spaced input; rejects one wrong character and empty', async () => {
  const h = harness();
  for (const code of [CODE.toLowerCase(), CODE.replaceAll('-', ''), '  abcd efgh jklm npqr  ']) {
    assert.equal(await h.auth.requireAuthIfConfigured(h.req({}, code)), null);
  }
  for (const code of ['BBCD-EFGH-JKLM-NPQR', '', null]) {
    const response = await h.auth.requireAuthIfConfigured(h.req({}, code));
    assert.equal(response.status, 403);
    assert.equal((await response.json()).error, ERROR);
  }
});

await test('every pre-setup handler refuses a missing/wrong code before body reads or side effects', async () => {
  for (const [route, method] of [
    ['setup/password', 'POST'], ['setup/agent-image', 'GET'], ['setup/agent-image', 'POST'],
    ['setup/restart', 'POST'], ['wizard/complete', 'POST'], ['wizard/reset', 'POST'], ['wizard/status', 'GET'],
  ]) {
    for (const code of [null, '', 'BBCD-EFGH-JKLM-NPQR']) {
      const h = harness();
      const req = h.req({}, code);
      req.json = () => { throw new Error('Unauthorized body read'); };
      const response = await h.load(`app/api/${route}/route.ts`)[method](req);
      assert.equal(response.status, 403, `${method} ${route}`);
      assert.equal((await response.json()).error, ERROR);
      assert.equal(h.effects.length, 0);
    }
  }
});

await test('correct code reaches each pre-setup handler, including streamed image download', async () => {
  for (const [route, method, status] of [
    ['setup/password', 'POST', 200], ['setup/agent-image', 'GET', 200], ['setup/agent-image', 'POST', 200],
    ['setup/restart', 'POST', 400], ['wizard/complete', 'POST', 200], ['wizard/reset', 'POST', 200],
    ['wizard/status', 'GET', 200],
  ]) {
    const h = harness();
    const response = await h.load(`app/api/${route}/route.ts`)[method](h.req({ password: '12345678' }, CODE.toLowerCase())); // secret-ok
    assert.equal(response.status, status, `${method} ${route}`);
    if (response instanceof Response) await response.text();
  }
});

await test('a paused setup request cannot overwrite the owner; conflict is 409 and secrets stay unchanged', async () => {
  const h = harness();
  const route = h.load('app/api/setup/password/route.ts');
  let release;
  let bodyStarted;
  const started = new Promise((resolve) => { bodyStarted = resolve; });
  const body = new Promise((resolve) => { release = resolve; });
  const stale = h.req({});
  stale.json = () => { bodyStarted(); return body; };
  const pending = route.POST(stale);
  await started;
  assert.equal((await route.POST(h.req({ password: 'owner-pass' }))).status, 200); // secret-ok
  const saved = h.files.get(ENV_FILE);
  const writes = h.effects.length;
  release({ password: 'stale-pass' }); // secret-ok
  assert.equal((await pending).status, 409);
  assert.equal(h.files.get(ENV_FILE), saved);
  assert.equal(h.effects.length, writes);
  assert.equal(h.process.env.REV4A_PASSWORD, 'owner-pass');
});

await test('final check detects a password written to disk without an in-memory update, and rereads fresh secrets', async () => {
  const h = harness();
  const route = h.load('app/api/setup/password/route.ts');
  const req = h.req({});
  req.json = async () => {
    h.files.set(ENV_FILE, 'REV4A_PASSWORD=external-owner\n');
    return { password: 'stale-pass' }; // secret-ok
  };
  assert.equal((await route.POST(req)).status, 409);
  assert.equal(h.effects.length, 0);
  h.files.set(ENV_FILE, '');
  req.json = async () => {
    h.files.set(ENV_FILE, '# changed while body was read\nREV4A_TOKEN=fresh-token\n');
    return { password: 'owner-pass' }; // secret-ok
  };
  assert.equal((await route.POST(req)).status, 200);
  assert.match(h.files.get(ENV_FILE), /# changed while body was read\nREV4A_TOKEN=fresh-token\n/);
});

await test('configured installs ignore setup codes: normal bearer/cookie auth applies; password setup stays 409', async () => {
  const h = harness({ REV4A_PASSWORD: 'owner-pass', REV4A_TOKEN: 'test-bearer', REV4A_JWT_SECRET: 'test-secret' }); // secret-ok
  for (const code of [null, CODE, 'wrong']) {
    assert.equal((await h.auth.requireAuthIfConfigured(h.req({}, code))).status, 401);
    assert.equal(await h.auth.requireAuthIfConfigured(h.req({}, code, { authorization: 'Bearer test-bearer' })), null);
    const req = h.req({}, code);
    req.cookies = { get: () => ({ value: 'valid-cookie' }) };
    assert.equal(await h.auth.requireAuthIfConfigured(req), null);
    assert.equal((await h.load('app/api/setup/password/route.ts').POST(req)).status, 409);
  }
  assert.equal(h.logs.length, 0);
  assert.equal(h.process.env.REV4A_SETUP_CODE, undefined);
});

await test('development fallback generates one 80-bit code, logs once and shares it across route bundles', async () => {
  const h = harness({});
  assert.equal((await h.auth.requireAuthIfConfigured(h.req({}, null))).status, 403);
  const code = h.process.env.REV4A_SETUP_CODE;
  assert.match(code, /^[A-HJ-NP-Z2-9]{4}(?:-[A-HJ-NP-Z2-9]{4}){3}$/);
  assert.equal(h.logs.length, 1);
  assert.match(h.logs[0], /open the dashboard and enter this code/);
  const anotherBundle = h.load('lib/rev4a-auth.js');
  assert.equal(await anotherBundle.requireAuthIfConfigured(h.req({}, code.toLowerCase())), null);
  assert.equal(h.logs.length, 1);
});

// Parse out the actual function declarations. Never evaluate the CLI entrypoint or preflight.
const cliSource = fs.readFileSync(path.join(root, 'bin/rev4a.js'), 'utf8');
const cliAst = ts.createSourceFile('rev4a.js', cliSource, ts.ScriptTarget.Latest, true);
function cliFunction(name) {
  const node = cliAst.statements.find((statement) => ts.isFunctionDeclaration(statement) && statement.name.text === name);
  assert.ok(node, name);
  return node.getText(cliAst);
}

function launcher(content, inherited = {}) {
  const logs = [];
  const children = [];
  const context = vm.createContext({
    ENV_SOURCE: ENV_FILE, ROOT: '/mock', ENV_LINK: '/mock/link', CONFIG_DIR: '/mock', DATA_DIR: '/mock/data', join: path.join,
    existsSync: () => true, readFileSync: () => content, log: (tag, message) => logs.push({ tag, message }),
    skippedEnvKeys: new Set(), process: { env: inherited, execPath: '/mock/node', on: () => {} }, crypto,
    isLoaderEnvKey: validator.isLoaderEnvKey,
    preflight: () => {}, checkVersion: () => {}, setTimeout: () => {}, setInterval: () => ({ unref: () => {} }),
    spawn: (_exec, args, options) => {
      children.push({ args, env: options.env });
      return { pid: children.length, on: () => {} };
    },
    require: (name) => { assert.equal(name, 'crypto'); return crypto; },
  });
  vm.runInContext(`${cliFunction('loadEnv')}\n${cliFunction('serve')}\nserve(3740);`, context);
  return { logs, children, context };
}

await test('launcher filters loader controls already present in old .env, warns once per key, preserves arbitrary other keys', () => {
  const keys = ['NODE_OPTIONS', 'NODE_REPL_EXTERNAL_MODULE', 'LD_PRELOAD', 'LD_LIBRARY_PATH',
    'DYLD_INSERT_LIBRARIES', 'DYLD_LIBRARY_PATH', 'DYLD_CUSTOM'];
  const h = launcher(['REV4A_PASSWORD=owner-pass', 'CUSTOM_OPERATOR_KEY=abc', 'PATH=/operator/bin',
    ...keys.flatMap((key) => [`${key}=SENTINEL_PRIVATE_VALUE`, `${key}=SENTINEL_PRIVATE_VALUE`])].join('\n'));
  vm.runInContext('loadEnv()', h.context);
  for (const child of h.children) {
    for (const key of keys) assert.equal(child.env[key], undefined, key);
    assert.equal(child.env.CUSTOM_OPERATOR_KEY, 'abc');
    assert.equal(child.env.PATH, '/operator/bin');
  }
  for (const key of keys) assert.equal(h.logs.filter(({ message }) => message.endsWith(`key ${key}`)).length, 1);
  assert.ok(!JSON.stringify(h.logs).includes('SENTINEL_PRIVATE_VALUE'));
  assert.equal(h.logs.filter(({ tag }) => tag === 'SETUP').length, 0);
});

await test('launcher generates a fresh code only before configuration and passes it only to server.js', () => {
  const a = launcher('REV4A_PASSWORD=\nREV4A_SETUP_CODE=untrusted-file-value\n');
  const b = launcher('');
  const code = a.children[0].env.REV4A_SETUP_CODE;
  assert.equal(vm.runInContext('loadEnv()', a.context).REV4A_SETUP_CODE, undefined);
  assert.match(code, /^[A-HJ-NP-Z2-9]{4}(?:-[A-HJ-NP-Z2-9]{4}){3}$/);
  assert.notEqual(code, b.children[0].env.REV4A_SETUP_CODE);
  assert.equal(a.children[0].args[0], 'server.js');
  for (const child of a.children.slice(1)) assert.equal(child.env.REV4A_SETUP_CODE, undefined);
  assert.equal(a.logs.filter(({ tag }) => tag === 'SETUP').length, 1);
  assert.ok(a.logs.some(({ message }) => message.includes(code) && message.includes('open the dashboard and enter this code')));
  for (const [file, inherited] of [['REV4A_PASSWORD=existing\n', {}], ['', { REV4A_PASSWORD: 'existing' }]]) { // secret-ok
    const configured = launcher(file, inherited);
    assert.equal(configured.logs.filter(({ tag }) => tag === 'SETUP').length, 0);
    for (const child of configured.children) assert.equal(child.env.REV4A_SETUP_CODE, undefined);
  }
});

await test('launcher preserves operator-inherited loader controls even when .env contains the same keys', () => {
  const inherited = Object.fromEntries(['NODE_OPTIONS', 'NODE_REPL_EXTERNAL_MODULE', 'LD_PRELOAD',
    'LD_LIBRARY_PATH', 'DYLD_INSERT_LIBRARIES', 'DYLD_LIBRARY_PATH', 'DYLD_CUSTOM'].map((key) => [key, 'operator-value']));
  inherited.NODE_OPTIONS = '--max-old-space-size=4096';
  const h = launcher(['REV4A_PASSWORD=existing', ...Object.keys(inherited).map((key) => `${key}=file-value`)].join('\n'), inherited);
  for (const child of h.children) {
    for (const [key, value] of Object.entries(inherited)) assert.equal(child.env[key], value);
  }
});

await test('server snapshots before requiring Next and strips only newly loaded controls after prepare, before serving', async () => {
  const source = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  const ast = ts.createSourceFile('server.js', source, ts.ScriptTarget.Latest, true);
  const main = ast.statements.find((node) => ts.isFunctionDeclaration(node) && node.name.text === 'main');
  const keys = ['NODE_OPTIONS', 'NODE_REPL_EXTERNAL_MODULE', 'LD_PRELOAD', 'LD_LIBRARY_PATH',
    'DYLD_INSERT_LIBRARIES', 'DYLD_LIBRARY_PATH', 'DYLD_CUSTOM'];
  for (const inherited of [{}, { NODE_OPTIONS: '--max-old-space-size=4096' },
    Object.fromEntries(keys.map((key) => [key, 'operator-value']))]) {
    const env = { ...inherited, CUSTOM_OPERATOR_KEY: 'abc' };
    const logs = [];
    const assertEnv = () => {
      for (const key of keys) assert.equal(env[key], inherited[key]);
      assert.equal(env.CUSTOM_OPERATOR_KEY, 'abc');
    };
    let prepared = false;
    let listening = false;
    const context = vm.createContext({
      require: (name) => { assert.equal(name, './lib/env-file.js'); return validator; },
      process: { env, on: () => {} }, console: { warn: (message) => logs.push(message) },
      parseTrustedProxies: () => ({ invalid: [], wide: [] }), __dirname: '/mock', PORT: 3740,
      next: () => {
        // Model env loading both during Next construction and during prepare().
        if (!('NODE_OPTIONS' in env)) env.NODE_OPTIONS = 'SENTINEL_PRIVATE_VALUE';
        return {
          prepare: async () => {
            for (const key of keys) if (!(key in env)) env[key] = 'SENTINEL_PRIVATE_VALUE';
            prepared = true;
          },
          getRequestHandler: () => { assert.equal(prepared, true); assertEnv(); return () => {}; },
        };
      },
      http: { createServer: () => {
        assertEnv();
        return { on: () => {}, listen: () => { listening = true; }, close: () => {} };
      } },
    });
    const snapshot = source.slice(source.indexOf("'use strict';"), source.indexOf("const http = require('http');"));
    vm.runInContext(snapshot, context);
    await vm.runInContext(`${main.getText(ast)}\nmain();`, context);
    assert.equal(listening, true);
    for (const key of keys) {
      assert.equal(logs.filter((message) => message.endsWith(`key ${key}`)).length, key in inherited ? 0 : 1);
    }
    assert.ok(!JSON.stringify(logs).includes('SENTINEL_PRIVATE_VALUE'));
    validator.stripUninheritedLoaderEnv(env, new Set(Object.keys(inherited)), (message) => logs.push(message));
    assert.equal(logs.length, keys.length - Object.keys(inherited).length);
  }
});

await test('the default .env generator validates assignments too, before any write', () => {
  for (const value of ['abc', 'abc\nNODE_OPTIONS=payload']) {
    const writes = [];
    const context = vm.createContext({
      existsSync: () => false, ENV_SOURCE: ENV_FILE, ENV_LINK: '/mock/link', CONFIG_DIR: '/mock',
      readFileSync: () => { throw Object.assign(new Error('Missing'), { code: 'ENOENT' }); },
      log: () => {}, mkdirSync: () => {}, randomString: () => value,
      assertEnvValue: validator.assertEnvValue, seedAgentToken: () => {},
      writeFileSync: (_file, content) => writes.push(content), require: () => ({ symlinkSync: () => {} }),
    });
    const run = () => vm.runInContext(`${cliFunction('ensureEnv')}\nensureEnv();`, context);
    if (value.includes('\n')) {
      assert.throws(run, /REV4A_JWT_SECRET/);
      assert.equal(writes.length, 0);
    } else {
      run();
      assert.equal(writes.length, 1);
      assert.match(writes[0], /^REV4A_JWT_SECRET=abc$/m);
    }
  }
});

await test('default .env generation preserves existing files and aborts on read errors other than ENOENT', () => {
  for (const error of [null, 'EACCES', 'EIO', 'EISDIR']) {
    const writes = [];
    const context = vm.createContext({
      ENV_SOURCE: ENV_FILE, ENV_LINK: '/mock/link', existsSync: () => true,
      readFileSync: () => {
        if (error) throw Object.assign(new Error(error), { code: error });
        return 'PROVIDER_KEEP=existing\n';
      },
      log: () => {}, seedAgentToken: () => {}, writeFileSync: (...args) => writes.push(args),
      disableLoaderEnvLines: envFile.disableLoaderEnvLines,
    });
    const run = () => vm.runInContext(`${cliFunction('ensureEnv')}\nensureEnv();`, context);
    if (error) assert.throws(run, { code: error });
    else run();
    assert.equal(writes.length, 0);
  }
});

await test('wizard sends the code only on setup/wizard calls and tolerates unavailable sessionStorage', async () => {
  const storage = new Map();
  const calls = [];
  const sessionStorage = {
    getItem: (key) => storage.get(key), setItem: (key, value) => storage.set(key, value),
    removeItem: (key) => storage.delete(key),
  };
  const client = load('app/wizard/storage.ts', {}, { sessionStorage,
    fetch: async (url, options) => { calls.push({ url, options }); return { ok: true, json: async () => ({ done: true }) }; },
  });
  client.rememberSetupCode(CODE);
  assert.equal(await client.isWizardComplete(), true);
  assert.equal(await client.resetWizard(), true);
  assert.equal(await client.markWizardComplete(), true);
  for (const call of calls) assert.equal(call.options.headers['x-rev4a-setup-code'], CODE);
  assert.equal(Object.keys(client.setupCodeHeaders()).length, 0);
  const unavailable = load('app/wizard/storage.ts', {}, { sessionStorage: {
    getItem: () => { throw new Error('Denied'); }, setItem: () => { throw new Error('Denied'); },
  } });
  unavailable.rememberSetupCode(CODE);
  assert.equal(Object.keys(unavailable.setupCodeHeaders()).length, 0);
});

await test('setup UI uses the shared Input, sends the code header and guards repeated submission', async () => {
  const callbacks = [];
  const calls = [];
  const saved = [];
  let stateIndex = 0;
  const Input = () => {};
  const client = load('app/setup/PageClient.tsx', {
    'react/jsx-runtime': require('react/jsx-runtime'),
    react: {
      useState: (initial) => [[initial, '12345678', CODE, initial, initial][stateIndex++], () => {}],
      useCallback: (fn) => { callbacks.push(fn); return fn; }, useEffect: () => {}, useRef: (value) => ({ current: value }),
    },
    'next/navigation': { useRouter: () => ({ push: () => {} }) },
    '../components/ui': { Input, Button: () => {} },
    '../wizard/icons': { ArrowRightIcon: () => {}, CheckCircleIcon: () => {} },
    '../wizard/storage': { rememberSetupCode: (code) => saved.push(code) },
  }, { fetch: async (url, options) => { calls.push({ url, options }); return { ok: true }; } });
  const nodes = [];
  function visit(node) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(visit); return; }
    nodes.push(node);
    visit(node.props?.children);
  }
  visit(client.default());
  assert.ok(nodes.some((node) => node.type === Input && node.props.label === 'Setup code'));
  await Promise.all([callbacks[0](), callbacks[0]()]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/api/setup/password');
  assert.equal(calls[0].options.headers['x-rev4a-setup-code'], CODE);
  assert.deepEqual(JSON.parse(calls[0].options.body), { password: '12345678' }); // secret-ok
  assert.deepEqual(saved, [CODE]);
});

console.log(`\n${passed} setup security checks passed`);
